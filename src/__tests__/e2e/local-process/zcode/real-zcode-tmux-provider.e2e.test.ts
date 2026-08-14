import '../../../setup/test-setup.js';
import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { resetRuntimeTmuxInputStatesForTests } from '../../../../bridge/tmux/input-state-machine.js';
import { findZcodeSessionById } from '../../../../runtime/zcode/session-index.js';
import {
  restartZcodeTmuxInputSession,
  streamZcodeTmuxTui,
  zcodeTmuxSessionName,
} from '../../../../runtime/zcode/tmux-provider.js';
import { commandAvailable } from '../../../helpers/runtime/real-codex-e2e-utils.js';

const execFileAsync = promisify(execFile);

interface ParsedSse {
  type: string;
  data: unknown;
}

async function readSse(stream: ReadableStream<string>): Promise<ParsedSse[]> {
  let raw = '';
  for await (const chunk of stream) raw += chunk;
  return raw
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice('data: '.length)) as { type: string; data: string })
    .map((event) => {
      try { return { type: event.type, data: JSON.parse(event.data) }; } catch { return event; }
    });
}

function sessionIdFromEvents(events: ParsedSse[]): string | undefined {
  for (const event of events) {
    if (!event.data || typeof event.data !== 'object') continue;
    const sessionId = (event.data as { session_id?: unknown }).session_id;
    if (typeof sessionId === 'string' && sessionId) return sessionId;
  }
  return undefined;
}

function errorText(events: ParsedSse[]): string {
  return events
    .filter((event) => event.type === 'error')
    .map((event) => typeof event.data === 'string' ? event.data : JSON.stringify(event.data))
    .join('\n');
}

function textContent(events: ParsedSse[]): string {
  return events
    .filter((event) => event.type === 'text')
    .map((event) => typeof event.data === 'string' ? event.data : JSON.stringify(event.data))
    .join('\n');
}

describe('real ZCode tmux provider e2e', () => {
  it('binds concurrent TUI sessions, preserves native slash commands, and resumes after tmux restart', { timeout: 120_000 }, async (t: TestContext) => {
    if (process.env.CODELARK_REAL_ZCODE_E2E !== '1') {
      t.skip('set CODELARK_REAL_ZCODE_E2E=1 to run the real ZCode executable gate');
      return;
    }
    if (!(await commandAvailable('tmux', ['-V']))) {
      t.skip('tmux is not available');
      return;
    }
    const executable = process.env.CODELARK_REAL_ZCODE_E2E_EXECUTABLE || 'zcode';
    if (!(await commandAvailable(executable, ['--version']))) {
      t.skip(`real ZCode executable is not available at ${executable}`);
      return;
    }

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-real-zcode-tmux-'));
    const workDir = path.join(root, 'workspace');
    const storageDir = path.join(root, 'storage');
    const dbPath = path.join(root, 'data', 'sessions.sqlite');
    const tmuxTmpdir = path.join(root, 'tmux');
    const bridgeSessionId = `real-zcode-a-${process.pid}-${Date.now()}`;
    const peerBridgeSessionId = `real-zcode-b-${process.pid}-${Date.now()}`;
    const tmuxSessionName = zcodeTmuxSessionName(bridgeSessionId);
    const peerTmuxSessionName = zcodeTmuxSessionName(peerBridgeSessionId);
    fs.mkdirSync(workDir, { recursive: true });
    fs.mkdirSync(storageDir, { recursive: true });
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.mkdirSync(tmuxTmpdir, { recursive: true });

    const keys = [
      'CODELARK_ZCODE_EXECUTABLE',
      'ZCODE_EXECUTABLE',
      'ZCODE_STORAGE_DIR',
      'ZCODE_SESSION_DB_PATH',
      'ZCODE_API_KEY',
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'CODELARK_ZCODE_TMUX_POLL_INTERVAL_MS',
      'CODELARK_ZCODE_TMUX_SESSION_TIMEOUT_MS',
      'CODELARK_ZCODE_TMUX_OUTPUT_IDLE_TIMEOUT_MS',
      'TMUX_TMPDIR',
      'TMUX',
      'TMUX_PANE',
    ] as const;
    const previous = new Map(keys.map((key) => [key, process.env[key]]));
    Object.assign(process.env, {
      CODELARK_ZCODE_EXECUTABLE: executable,
      ZCODE_STORAGE_DIR: storageDir,
      ZCODE_SESSION_DB_PATH: dbPath,
      CODELARK_ZCODE_TMUX_POLL_INTERVAL_MS: '100',
      CODELARK_ZCODE_TMUX_SESSION_TIMEOUT_MS: '30000',
      CODELARK_ZCODE_TMUX_OUTPUT_IDLE_TIMEOUT_MS: '30000',
      TMUX_TMPDIR: tmuxTmpdir,
    });
    delete process.env.ZCODE_EXECUTABLE;
    delete process.env.ZCODE_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.TMUX;
    delete process.env.TMUX_PANE;
    resetRuntimeTmuxInputStatesForTests();

    try {
      const [first, peer] = await Promise.all([
        readSse(streamZcodeTmuxTui({
          sessionId: bridgeSessionId,
          runtime: 'zcode',
          prompt: 'Reply with exactly CODELARK_REAL_ZCODE_NO_LOGIN_A.',
          workingDirectory: workDir,
          zcodeMode: 'build',
        })),
        readSse(streamZcodeTmuxTui({
          sessionId: peerBridgeSessionId,
          runtime: 'zcode',
          prompt: 'Reply with exactly CODELARK_REAL_ZCODE_NO_LOGIN_B.',
          workingDirectory: workDir,
          zcodeMode: 'build',
        })),
      ]);
      const zcodeSessionId = sessionIdFromEvents(first);
      const peerZcodeSessionId = sessionIdFromEvents(peer);
      assert.match(zcodeSessionId || '', /^sess_[A-Za-z0-9._-]+$/);
      assert.match(peerZcodeSessionId || '', /^sess_[A-Za-z0-9._-]+$/);
      assert.notEqual(zcodeSessionId, peerZcodeSessionId, 'concurrent same-cwd launches must retain their own identity');
      assert.match(errorText(first), /missing an API key|not configured/i);
      assert.match(errorText(peer), /missing an API key|not configured/i);
      assert.equal(findZcodeSessionById(zcodeSessionId!, workDir, { dbPath })?.sessionId, zcodeSessionId);
      assert.equal(findZcodeSessionById(peerZcodeSessionId!, workDir, { dbPath })?.sessionId, peerZcodeSessionId);

      const paneTarget = `${tmuxSessionName}:0.0`;
      const firstPanePid = (await execFileAsync(
        'tmux',
        ['display-message', '-p', '-t', paneTarget, '#{pane_pid}'],
        { env: process.env },
      )).stdout.trim();
      assert.match(firstPanePid, /^\d+$/);

      const second = await readSse(streamZcodeTmuxTui({
        sessionId: bridgeSessionId,
        runtime: 'zcode',
        zcodeSessionId,
        prompt: 'Reply with exactly CODELARK_REAL_ZCODE_REUSE.',
        workingDirectory: workDir,
        zcodeMode: 'build',
      }));
      assert.equal(sessionIdFromEvents(second), zcodeSessionId);
      assert.match(errorText(second), /missing an API key|not configured/i);
      const secondPanePid = (await execFileAsync(
        'tmux',
        ['display-message', '-p', '-t', paneTarget, '#{pane_pid}'],
        { env: process.env },
      )).stdout.trim();
      assert.equal(secondPanePid, firstPanePid, 'a reusable ZCode TUI must not be restarted between turns');

      const nativeSlash = await readSse(streamZcodeTmuxTui({
        sessionId: bridgeSessionId,
        runtime: 'zcode',
        zcodeSessionId,
        prompt: '/goal',
        workingDirectory: workDir,
        zcodeMode: 'build',
      }));
      assert.match(textContent(nativeSlash), /No goal is set/i);
      assert.equal(errorText(nativeSlash), '');

      const restarted = await restartZcodeTmuxInputSession({
        sessionId: bridgeSessionId,
        runtime: 'zcode',
        zcodeSessionId,
        prompt: '',
        workingDirectory: workDir,
        zcodeMode: 'build',
      });
      assert.equal(restarted.sessionId, zcodeSessionId);
      const restartedPanePid = (await execFileAsync(
        'tmux',
        ['display-message', '-p', '-t', paneTarget, '#{pane_pid}'],
        { env: process.env },
      )).stdout.trim();
      assert.notEqual(restartedPanePid, firstPanePid, 'a forced tmux restart must replace the TUI process');

      const afterRestart = await readSse(streamZcodeTmuxTui({
        sessionId: bridgeSessionId,
        runtime: 'zcode',
        zcodeSessionId,
        prompt: 'Reply with exactly CODELARK_REAL_ZCODE_AFTER_RESTART.',
        workingDirectory: workDir,
        zcodeMode: 'build',
      }));
      assert.equal(sessionIdFromEvents(afterRestart), zcodeSessionId);
      assert.match(errorText(afterRestart), /missing an API key|not configured/i);
    } finally {
      await execFileAsync('tmux', ['kill-session', '-t', tmuxSessionName], { env: process.env }).catch(() => undefined);
      await execFileAsync('tmux', ['kill-session', '-t', peerTmuxSessionName], { env: process.env }).catch(() => undefined);
      resetRuntimeTmuxInputStatesForTests();
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
