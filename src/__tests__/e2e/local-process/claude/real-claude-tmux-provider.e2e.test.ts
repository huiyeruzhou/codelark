import '../../../setup/test-setup.js';
import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { streamClaudeTmuxTui } from '../../../../runtime/claude/tmux-provider.js';
import { claudeTmuxSessionName } from '../../../../bridge/tmux/runtime.js';
import { listClaudeSessionJsonlFiles } from '../../../../runtime/claude/session-jsonl.js';
import {
  commandAvailable,
  removeRuntimeTestDirectory,
  startLocalResponsesProxy,
} from '../../../helpers/runtime/real-codex-e2e-utils.js';

const execFileAsync = promisify(execFile);

async function readStream(stream: ReadableStream<string>): Promise<string> {
  let output = '';
  for await (const chunk of stream) output += chunk;
  return output;
}

function findClaudeSessionId(output: string): string | undefined {
  for (const line of output.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const event = JSON.parse(line.slice('data: '.length)) as { data?: string };
    if (!event.data) continue;
    try {
      const data = JSON.parse(event.data) as { session_id?: string };
      if (data.session_id) return data.session_id;
    } catch {
      // Text events are not JSON objects.
    }
  }
  return undefined;
}

function writeClaudeOnboardingState(homeDir: string): void {
  fs.writeFileSync(path.join(homeDir, '.claude.json'), `${JSON.stringify({
    numStartups: 1,
    installMethod: 'npm',
    theme: 'light',
    hasCompletedOnboarding: true,
    lastOnboardingVersion: '2.0.0',
    hasIdeOnboardingBeenShown: { vscode: true },
  }, null, 2)}\n`, { mode: 0o600 });
}

describe('real Claude Code tmux provider e2e', () => {
  it('runs and resumes the real Claude executable through tmux against a fake Anthropic backend', { timeout: 180_000 }, async (t: TestContext) => {
    const claudeExecutable = process.env.CODELARK_REAL_CLAUDE_E2E_EXECUTABLE || 'claude';
    if (!(await commandAvailable('tmux', ['-V']))) {
      t.skip('tmux is not available');
      return;
    }
    if (!(await commandAvailable(claudeExecutable, ['--version']))) {
      t.skip('claude executable is not available');
      return;
    }

    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-real-claude-tmux-home-'));
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-real-claude-tmux-work-'));
    const tmuxTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-real-claude-tmux-socket-'));
    const expected = `CODELARK_REAL_CLAUDE_TMUX_${process.pid}_${Date.now()}`;
    const proxy = await startLocalResponsesProxy({ responseText: expected });
    const sessionId = `real-claude-tmux-${process.pid}-${Date.now()}`;
    const freshTmuxSessionName = claudeTmuxSessionName(sessionId);
    let resumedTmuxSessionName = '';
    const previousEnv = new Map<string, string | undefined>();
    const env = {
      HOME: homeDir,
      USERPROFILE: homeDir,
      CODELARK_CLAUDE_HOME: homeDir,
      TMUX_TMPDIR: tmuxTmpDir,
      ANTHROPIC_BASE_URL: proxy.baseUrl.replace(/\/v1$/u, ''),
      ANTHROPIC_AUTH_TOKEN: 'codelark-local-mock-token',
      ANTHROPIC_API_KEY: '',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CODELARK_CLAUDE_TMUX_PROMPT_DELAY_MS: '0',
      CODELARK_CLAUDE_TMUX_POLL_INTERVAL_MS: '100',
      CODELARK_CLAUDE_TMUX_SESSION_FILE_TIMEOUT_MS: '30000',
    } satisfies Record<string, string>;
    writeClaudeOnboardingState(homeDir);
    for (const key of ['TMUX', 'TMUX_PANE']) {
      previousEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    for (const [key, value] of Object.entries(env)) {
      previousEnv.set(key, process.env[key]);
      process.env[key] = value;
    }

    try {
      const output = await readStream(streamClaudeTmuxTui({
        prompt: `Reply with exactly: ${expected}`,
        sessionId,
        runtime: 'claude',
        claudeExecutable: 'claude',
        workingDirectory: workDir,
      }));
      assert.match(output, new RegExp(expected));
      const claudeSessionId = findClaudeSessionId(output);
      assert.ok(claudeSessionId, 'real Claude turn should publish its persisted session identity');
      assert.equal(listClaudeSessionJsonlFiles(workDir, homeDir).length, 1);

      await execFileAsync('tmux', ['kill-session', '-t', freshTmuxSessionName]);
      resumedTmuxSessionName = claudeTmuxSessionName(claudeSessionId);
      const resumedOutput = await readStream(streamClaudeTmuxTui({
        prompt: `Resume this session and reply with exactly: ${expected}`,
        sessionId,
        claudeSessionId,
        runtime: 'claude',
        claudeExecutable: 'claude',
        workingDirectory: workDir,
      }));
      assert.match(resumedOutput, new RegExp(expected));
      assert.equal(findClaudeSessionId(resumedOutput), claudeSessionId);
      assert.equal(listClaudeSessionJsonlFiles(workDir, homeDir).length, 1);
      assert.ok(proxy.requests.some((request) => /\/messages(?:\?|$)/u.test(request.url)));
    } finally {
      await execFileAsync('tmux', ['kill-session', '-t', freshTmuxSessionName]).catch(() => undefined);
      if (resumedTmuxSessionName) {
        await execFileAsync('tmux', ['kill-session', '-t', resumedTmuxSessionName]).catch(() => undefined);
      }
      await proxy.close().catch(() => undefined);
      for (const [key, value] of previousEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      removeRuntimeTestDirectory(homeDir);
      removeRuntimeTestDirectory(workDir);
      removeRuntimeTestDirectory(tmuxTmpDir);
    }
  });
});
