import '../../../setup/test-setup.js';
import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type { StructuredStreamingUiMetadata } from '../../../../channels/contracts.js';
import { _testOnly, registerAdapter } from '../../../../bridge/host/manager.js';
import { resetRuntimeTmuxInputStatesForTests } from '../../../../bridge/tmux/input-state-machine.js';
import {
  findCursorSessionFileById,
  parseCursorTranscriptRecords,
} from '../../../../runtime/cursor/session-index.js';
import { cursorTmuxSessionName } from '../../../../runtime/cursor/tmux-provider.js';
import { DEFAULT_CURSOR_MODEL } from '../../../../runtime/cursor/constants.js';
import { CodexRoutingProvider } from '../../../../runtime/codex/routing-provider.js';
import { resolveCursorRuntimeConfig } from '../../../../bridge/session/support.js';
import {
  inboundMessage,
  initBridgeTestContext,
  makeBridgeSettings,
  RecordingAdapter,
  resetBridgeTestState,
} from '../../../helpers/bridge/test-bridge-utils.js';
import {
  commandAvailable,
  removeRuntimeTestDirectory,
  waitForCondition,
} from '../../../helpers/runtime/real-codex-e2e-utils.js';

const execFileAsync = promisify(execFile);
const COLD_START_DELAY_MS = 35_000;

class CursorStreamingRecordingAdapter extends RecordingAdapter {
  readonly streamEvents: Array<{
    kind: 'mirror_start' | 'metadata' | 'status' | 'text' | 'end';
    streamKey?: string;
    text?: string;
    status?: string;
  }> = [];
  readonly reactions: Array<{ messageId: string; emojiType: string }> = [];
  private readonly activeStreams = new Set<string>();

  onMirrorStreamStart(_chatId: string, streamKey?: string): void {
    if (streamKey) this.activeStreams.add(streamKey);
    this.streamEvents.push({ kind: 'mirror_start', streamKey });
  }

  onStreamMetadata(_chatId: string, _metadata: StructuredStreamingUiMetadata, streamKey?: string): void {
    this.streamEvents.push({ kind: 'metadata', streamKey });
  }

  onStreamStatus(_chatId: string, text: string, streamKey?: string): void {
    if (streamKey) this.activeStreams.add(streamKey);
    this.streamEvents.push({ kind: 'status', streamKey, text });
  }

  onStreamText(_chatId: string, text: string, streamKey?: string): void {
    if (streamKey) this.activeStreams.add(streamKey);
    this.streamEvents.push({ kind: 'text', streamKey, text });
  }

  async onStreamEnd(
    _chatId: string,
    status: 'completed' | 'interrupted' | 'error',
    text: string,
    streamKey?: string,
  ): Promise<boolean> {
    this.streamEvents.push({ kind: 'end', streamKey, status, text });
    if (streamKey) this.activeStreams.delete(streamKey);
    return true;
  }

  supportsStructuredStreamingUi(): boolean { return true; }

  hasActiveStreamingUi(_chatId: string, streamKey?: string): boolean {
    return Boolean(streamKey && this.activeStreams.has(streamKey));
  }

  async addMessageReaction(messageId: string, emojiType: string): Promise<string> {
    this.reactions.push({ messageId, emojiType });
    return `reaction-${this.reactions.length}`;
  }
}

function installedCursorExecutable(): string {
  const hostHome = process.env.CODELARK_TEST_ORIGINAL_HOME || os.homedir();
  return process.env.CODELARK_REAL_CURSOR_E2E_EXECUTABLE
    || path.join(hostHome, '.local', 'bin', process.platform === 'win32' ? 'agent.exe' : 'agent');
}

function posixShellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function delayedCursorExecutable(tempDir: string, executable: string): {
  executable: string;
  markerPath?: string;
} {
  if (process.platform === 'win32') return { executable };
  const markerPath = path.join(tempDir, 'cursor-cold-start-delay-consumed');
  const wrapperPath = path.join(tempDir, 'cursor-agent-delayed');
  fs.writeFileSync(wrapperPath, [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    `marker=${posixShellQuote(markerPath)}`,
    'if [[ ! -e "$marker" ]]; then',
    '  : > "$marker"',
    `  sleep ${COLD_START_DELAY_MS / 1_000}`,
    'fi',
    `exec ${posixShellQuote(executable)} "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });
  return { executable: wrapperPath, markerPath };
}

async function cursorIsAuthenticated(executable: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    const result = await execFileAsync(executable, ['status', '--format', 'json'], { env });
    const status = JSON.parse(result.stdout) as { isAuthenticated?: unknown };
    return status.isAuthenticated === true;
  } catch {
    return false;
  }
}

async function panePid(tmuxSessionName: string): Promise<string> {
  return (await execFileAsync(
    'tmux',
    ['display-message', '-p', '-t', `${tmuxSessionName}:0.0`, '#{pane_pid}'],
  )).stdout.trim();
}

function terminalEvents(adapter: CursorStreamingRecordingAdapter) {
  return adapter.streamEvents.filter((event) => event.kind === 'end');
}

describe('real Cursor Agent bridge e2e', () => {
  it('cold-starts one Cursor chat, cold-takes over its tmux, and resumes it after tmux loss', { timeout: 300_000 }, async (t: TestContext) => {
    if (process.env.CODELARK_REAL_CURSOR_E2E !== '1') {
      t.skip('set CODELARK_REAL_CURSOR_E2E=1 to use the authenticated real Cursor backend');
      return;
    }
    if (!(await commandAvailable('tmux', ['-V']))) {
      t.skip('tmux is not available');
      return;
    }
    const executable = installedCursorExecutable();
    if (!(await commandAvailable(executable, ['--version']))) {
      t.skip(`real Cursor Agent executable is not available at ${executable}`);
      return;
    }

    const hostHome = process.env.CODELARK_TEST_ORIGINAL_HOME || os.homedir();
    const hostConfigPath = path.join(hostHome, '.cursor', 'cli-config.json');
    if (!fs.existsSync(hostConfigPath)) {
      t.skip(`Cursor login config is not available at ${hostConfigPath}`);
      return;
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-real-cursor-bridge-'));
    const configDir = path.join(tempDir, 'cursor-config');
    const dataDir = path.join(tempDir, 'cursor-data');
    const workDir = path.join(tempDir, 'workspace');
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(workDir, { recursive: true });
    fs.copyFileSync(hostConfigPath, path.join(configDir, 'cli-config.json'));
    const delayedExecutable = delayedCursorExecutable(tempDir, executable);

    const previousEnv = new Map<string, string | undefined>();
    const env = {
      HOME: hostHome,
      USERPROFILE: hostHome,
      CURSOR_CONFIG_DIR: configDir,
      CURSOR_DATA_DIR: dataDir,
      CURSOR_AGENT_EXECUTABLE: delayedExecutable.executable,
      CODELARK_CURSOR_MODEL: process.env.CODELARK_REAL_CURSOR_E2E_MODEL,
      CODELARK_CURSOR_EXECUTABLE: undefined,
      CODELARK_CURSOR_TMUX_POLL_INTERVAL_MS: '100',
      CODELARK_CURSOR_TMUX_INPUT_READY_TIMEOUT_MS: undefined,
      CODELARK_CURSOR_TMUX_SESSION_FILE_TIMEOUT_MS: '60000',
      CODELARK_CURSOR_TMUX_OUTPUT_IDLE_TIMEOUT_MS: '120000',
      CODELARK_DEBUG: '1',
    } satisfies Record<string, string | undefined>;
    for (const [key, value] of Object.entries(env)) {
      previousEnv.set(key, process.env[key]);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }

    resetBridgeTestState();
    _testOnly.resetStateForTests();
    let tmuxSessionName = '';
    const firstMarker = `CODELARK_REAL_CURSOR_FIRST_${process.pid}_${Date.now()}`;
    const takeoverMarker = `CODELARK_REAL_CURSOR_TAKEOVER_${process.pid}_${Date.now()}`;
    const resumedMarker = `CODELARK_REAL_CURSOR_RESUMED_${process.pid}_${Date.now()}`;
    let testPassed = false;

    try {
      assert.equal(
        await cursorIsAuthenticated(executable, { ...process.env }),
        true,
        'the opt-in gate requires an authenticated Cursor CLI without exposing tokens',
      );
      const version = (await execFileAsync(executable, ['--version'], { env: { ...process.env } })).stdout.trim();
      assert.match(version, /^\d{4}\.\d{2}\.\d{2}-[0-9a-f]+$/i);

      const store = initBridgeTestContext({
        dynamicSettings: true,
        settings: makeBridgeSettings(),
        llm: new CodexRoutingProvider(),
      });
      const adapter = new CursorStreamingRecordingAdapter();
      registerAdapter(adapter);
      const bridgeState = (globalThis as unknown as Record<string, any>).__bridge_manager__;
      bridgeState.running = true;
      const address = { channelType: 'feishu', chatId: 'chat-real-cursor-bridge', userId: 'ou-real-cursor' } as const;
      const session = store.createSession('real-cursor-bridge', 'auto', undefined, workDir, 'normal', {
        activeRuntime: 'cursor',
      });
      tmuxSessionName = cursorTmuxSessionName(session.id);
      store.updateSession(session.id, {
        runtime: {
          activeRuntime: 'cursor',
          cursor: { provider: 'tmux', force: true },
          general: { workingDirectory: workDir },
        },
      });
      store.upsertChannelChat({
        channelType: address.channelType,
        chatId: address.chatId,
        chatKind: 'group',
        bridgeSessionId: session.id,
      });
      assert.equal(
        store.getSession(session.id)?.runtime?.cursor?.model,
        undefined,
        'the real gate must exercise the product default rather than a session override',
      );
      assert.equal(
        resolveCursorRuntimeConfig(store.getSession(session.id), store.getChannelChat(address.channelType, address.chatId)).model,
        process.env.CODELARK_REAL_CURSOR_E2E_MODEL || DEFAULT_CURSOR_MODEL,
      );

      const firstTerminalCount = terminalEvents(adapter).length;
      const firstTurnStartedAt = Date.now();
      await _testOnly.handleMessage(
        adapter,
        inboundMessage(address, `Reply with exactly this marker and no other text: ${firstMarker}`, 'incoming-real-cursor-first'),
      );
      assert.equal(
        await waitForCondition(() => terminalEvents(adapter).length > firstTerminalCount, 120_000, 250),
        true,
        `the first real Cursor turn must reach a streaming terminal; events=${JSON.stringify(adapter.streamEvents)}`,
      );
      const firstTerminal = terminalEvents(adapter)[firstTerminalCount]!;
      assert.equal(firstTerminal.status, 'completed', `first Cursor terminal: ${JSON.stringify(firstTerminal)}`);
      assert.match(firstTerminal.text || '', new RegExp(firstMarker));
      if (delayedExecutable.markerPath) {
        assert.equal(fs.existsSync(delayedExecutable.markerPath), true);
        assert.ok(
          Date.now() - firstTurnStartedAt >= COLD_START_DELAY_MS,
          'the real executable story must cross the former 30s readiness limit',
        );
        assert.ok(
          adapter.streamEvents.some((event) => (
            event.kind === 'status'
            && /Cursor Agent 正在准备工作区；首次打开时通常会建立索引，已等待/.test(event.text || '')
          )),
          'the user must receive progress while the real Cursor executable is still cold-starting',
        );
      }
      const initialized = store.getSession(session.id);
      const cursorSessionId = initialized?.runtime?.cursor?.sessionId;
      assert.match(cursorSessionId || '', /^[0-9a-f-]{36}$/i);
      const sessionFile = findCursorSessionFileById(cursorSessionId!, workDir);
      assert.ok(sessionFile?.filePath);
      assert.equal(fs.readFileSync(sessionFile.filePath, 'utf-8').includes(firstMarker), true);
      const firstPanePid = await panePid(tmuxSessionName);

      resetRuntimeTmuxInputStatesForTests();
      const takeoverTerminalCount = terminalEvents(adapter).length;
      await _testOnly.handleMessage(
        adapter,
        inboundMessage(address, `Reply with exactly this marker and no other text: ${takeoverMarker}`, 'incoming-real-cursor-takeover'),
      );
      assert.equal(
        await waitForCondition(() => terminalEvents(adapter).length > takeoverTerminalCount, 120_000, 250),
        true,
        `a bridge cold takeover must finish the next turn; events=${JSON.stringify(adapter.streamEvents)}`,
      );
      const takeoverTerminal = terminalEvents(adapter)[takeoverTerminalCount]!;
      assert.equal(takeoverTerminal.status, 'completed', `takeover Cursor terminal: ${JSON.stringify(takeoverTerminal)}`);
      assert.match(takeoverTerminal.text || '', new RegExp(takeoverMarker));
      assert.equal(await panePid(tmuxSessionName), firstPanePid, 'cold takeover must not restart the live Cursor TUI');
      assert.equal(store.getSession(session.id)?.runtime?.cursor?.sessionId, cursorSessionId);
      assert.equal(takeoverTerminal.text?.includes(firstMarker), false);

      await execFileAsync('tmux', ['kill-session', '-t', tmuxSessionName]);
      const resumedTerminalCount = terminalEvents(adapter).length;
      await _testOnly.handleMessage(
        adapter,
        inboundMessage(address, `Reply with exactly this marker and no other text: ${resumedMarker}`, 'incoming-real-cursor-resumed'),
      );
      assert.equal(
        await waitForCondition(() => terminalEvents(adapter).length > resumedTerminalCount, 120_000, 250),
        true,
        `a missing tmux must finish the resumed turn; events=${JSON.stringify(adapter.streamEvents)}`,
      );
      const resumedTerminal = terminalEvents(adapter)[resumedTerminalCount]!;
      assert.equal(resumedTerminal.status, 'completed', `resumed Cursor terminal: ${JSON.stringify(resumedTerminal)}`);
      assert.match(resumedTerminal.text || '', new RegExp(resumedMarker));
      assert.notEqual(await panePid(tmuxSessionName), firstPanePid);
      assert.equal(store.getSession(session.id)?.runtime?.cursor?.sessionId, cursorSessionId);
      assert.equal(resumedTerminal.text?.includes(takeoverMarker), false);

      const transcript = fs.readFileSync(sessionFile.filePath, 'utf-8');
      assert.equal(transcript.includes(firstMarker), true);
      assert.equal(transcript.includes(takeoverMarker), true);
      assert.equal(transcript.includes(resumedMarker), true);
      const transcriptRows = transcript.trim().split('\n').map((line) => JSON.parse(line) as {
        type?: string;
        status?: string;
        role?: string;
        message?: { content?: Array<{ type?: string; text?: string }> };
      });
      assert.equal(transcriptRows.filter((row) => row.role === 'user').length, 3);
      assert.equal(
        transcriptRows.filter((row) => row.type === 'turn_ended' && row.status === 'success').length,
        1,
        'the final Cursor transcript snapshot keeps one successful EOF terminal',
      );
      const publicAssistantTexts = parseCursorTranscriptRecords(transcript)
        .filter((record) => record.type === 'message' && record.role === 'assistant')
        .map((record) => record.content.trim());
      for (const marker of [firstMarker, takeoverMarker, resumedMarker]) {
        assert.ok(transcriptRows.some((row) => row.message?.content?.some(
          (block) => block.type === 'text' && block.text?.trim() === marker,
        )));
        assert.equal(publicAssistantTexts.filter((text) => text === marker).length, 1);
      }
      for (const terminal of terminalEvents(adapter)) {
        assert.doesNotMatch(terminal.text || '', /<\|eos\|>/);
      }
      assert.deepEqual(adapter.reactions, []);
      testPassed = true;
    } finally {
      const bridgeState = (globalThis as unknown as Record<string, any>).__bridge_manager__;
      if (bridgeState) bridgeState.running = false;
      if (tmuxSessionName) {
        await execFileAsync('tmux', ['kill-session', '-t', tmuxSessionName]).catch(() => {});
      }
      _testOnly.resetStateForTests();
      for (const [key, value] of previousEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      if (!testPassed && process.env.CODELARK_REAL_CURSOR_E2E_KEEP_ARTIFACTS === '1') {
        process.stderr.write(`[real-cursor-e2e] preserved failure artifacts: ${tempDir}\n`);
      } else {
        removeRuntimeTestDirectory(tempDir);
      }
    }
  });
});
