import '../../../setup/test-setup.js';
import { afterEach, beforeEach, describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type { StructuredStreamingUiMetadata } from '../../../../channels/contracts.js';
import { _testOnly, registerAdapter } from '../../../../bridge/host/manager.js';
import { resetRuntimeTmuxInputStatesForTests } from '../../../../bridge/tmux/input-state-machine.js';
import { findKimiSessionFileById } from '../../../../runtime/kimi/session-index.js';
import { kimiTmuxSessionName } from '../../../../runtime/kimi/tmux-provider.js';
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
  startLocalResponsesProxy,
  waitForCondition,
} from '../../../helpers/runtime/real-codex-e2e-utils.js';

const execFileAsync = promisify(execFile);

class StreamingRecordingAdapter extends RecordingAdapter {
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

function installedKimiCodeExecutable(): string {
  const hostHome = process.env.CODELARK_TEST_ORIGINAL_HOME || os.homedir();
  return process.env.CODELARK_REAL_KIMI_E2E_EXECUTABLE
    || path.join(hostHome, '.kimi-code', 'bin', process.platform === 'win32' ? 'kimi.exe' : 'kimi');
}

describe('real Kimi Code bridge e2e', () => {
  beforeEach(() => {
    resetBridgeTestState({ cleanKimiHome: true });
    _testOnly.resetStateForTests();
  });

  afterEach(() => {
    _testOnly.resetStateForTests();
  });

  it('cold-starts, steers, then cold-takes over the surviving tmux after a bridge restart', { timeout: 60_000 }, async (t: TestContext) => {
    if (!(await commandAvailable('tmux', ['-V']))) {
      t.skip('tmux is not available');
      return;
    }
    const executable = installedKimiCodeExecutable();
    if (!(await commandAvailable(executable, ['--version']))) {
      t.skip(`real Kimi Code executable is not available at ${executable}`);
      return;
    }

    const previousEnv = new Map<string, string | undefined>();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-real-kimi-bridge-'));
    const kimiHome = path.join(tempDir, 'kimi-home');
    const workDir = path.join(tempDir, 'workspace');
    const responseText = `CODELARK_REAL_BRIDGE_${process.pid}_${Date.now()}`;
    const steerText = `CODELARK_REAL_STEER_${process.pid}_${Date.now()}`;
    const coldTakeoverText = `CODELARK_REAL_COLD_TAKEOVER_${process.pid}_${Date.now()}`;
    const proxy = await startLocalResponsesProxy({ responseText, responseDelayMs: 3_000 });
    const env = {
      KIMI_CODE_HOME: kimiHome,
      CODELARK_KIMI_EXECUTABLE: executable,
      KIMI_CODE_EXECUTABLE: undefined,
      CODELARK_KIMI_TMUX_POLL_INTERVAL_MS: '50',
      CODELARK_KIMI_TMUX_SESSION_FILE_TIMEOUT_MS: '10000',
      CODELARK_KIMI_TMUX_SESSION_ID_TIMEOUT_MS: '10000',
      CODELARK_KIMI_TMUX_INPUT_READY_TIMEOUT_MS: '10000',
      CODELARK_DEBUG: '1',
    } satisfies Record<string, string | undefined>;
    fs.mkdirSync(kimiHome, { recursive: true });
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(path.join(kimiHome, 'config.toml'), [
      'default_model = "codelark-real-kimi-e2e"',
      '',
      '[providers.codelark-local]',
      'type = "openai"',
      `base_url = ${JSON.stringify(proxy.baseUrl)}`,
      'api_key = "codelark-local-mock-key"',
      '',
      '[models.codelark-real-kimi-e2e]',
      'provider = "codelark-local"',
      'model = "codelark-real-kimi-e2e"',
      'max_context_size = 32768',
      '',
    ].join('\n'), 'utf-8');
    for (const [key, value] of Object.entries(env)) {
      previousEnv.set(key, process.env[key]);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }

    const store = initBridgeTestContext({
      dynamicSettings: true,
      settings: makeBridgeSettings(),
    });
    const adapter = new StreamingRecordingAdapter();
    registerAdapter(adapter);
    const bridgeState = (globalThis as unknown as Record<string, any>).__bridge_manager__;
    bridgeState.running = true;
    const address = { channelType: 'feishu', chatId: 'chat-real-kimi-bridge', userId: 'ou-real-kimi' } as const;
    const session = store.createSession('real-kimi-bridge', 'test-model', undefined, workDir);
    const binding = store.upsertChannelChat({
      channelType: address.channelType,
      chatId: address.chatId,
      chatKind: 'group',
      bridgeSessionId: session.id,
    });
    store.updateSession(session.id, {
      runtime: {
        activeRuntime: 'kimi',
        kimi: { provider: 'tmux' },
        general: { workingDirectory: workDir },
      },
    });
    const tmuxSessionName = kimiTmuxSessionName(session.id);

    try {
      await _testOnly.handleMessage(adapter, inboundMessage(address, `Reply exactly: ${responseText}`, 'incoming-real-kimi-first'));
      assert.equal(
        await waitForCondition(
          () => proxy.requests.some((request) => request.url.includes('/chat/completions')),
          15_000,
          50,
        ),
        true,
      );
      const initialized = store.getSession(session.id);
      const kimiSessionId = initialized?.runtime?.kimi?.sessionId;
      assert.match(kimiSessionId || '', /^session_[0-9a-f-]+$/i);
      const sessionFile = findKimiSessionFileById(kimiSessionId!, workDir);
      assert.ok(sessionFile?.filePath);

      await _testOnly.handleMessage(adapter, inboundMessage(address, steerText, 'incoming-real-kimi-steer'));
      assert.equal(
        await waitForCondition(() => {
          const wire = fs.readFileSync(sessionFile.filePath, 'utf-8');
          return wire.includes('"type":"turn.steer"') && wire.includes(steerText);
        }, 5_000, 50),
        true,
      );
      const screen = (await execFileAsync(
        'tmux',
        ['capture-pane', '-p', '-t', `${tmuxSessionName}:0.0`, '-S', '-160'],
      )).stdout;
      assert.match(screen, new RegExp(steerText));

      assert.equal(
        await waitForCondition(async () => {
          await _testOnly.reconcileMirrorSubscriptions();
          return adapter.streamEvents.some((event) => (
            event.kind === 'end'
            && event.status === 'completed'
            && event.text?.includes(responseText)
          ));
        }, 20_000, 100),
        true,
      );
      assert.deepEqual(adapter.reactions, [
        { messageId: 'incoming-real-kimi-first', emojiType: 'Get' },
        { messageId: 'incoming-real-kimi-steer', emojiType: 'Get' },
      ]);
      assert.equal(binding.bridgeSessionId, session.id);
      assert.equal(store.getSession(session.id)?.runtime?.kimi?.sessionId, kimiSessionId);

      const requestCountBeforeColdTakeover = proxy.requests.length;
      resetRuntimeTmuxInputStatesForTests();
      await _testOnly.handleMessage(
        adapter,
        inboundMessage(address, coldTakeoverText, 'incoming-real-kimi-cold-takeover'),
      );
      assert.equal(
        await waitForCondition(() => {
          const wire = fs.readFileSync(sessionFile.filePath, 'utf-8');
          return wire.includes('"type":"turn.prompt"') && wire.includes(coldTakeoverText);
        }, 10_000, 50),
        true,
      );
      assert.equal(
        await waitForCondition(
          () => proxy.requests.length > requestCountBeforeColdTakeover,
          10_000,
          50,
        ),
        true,
      );
      assert.equal(
        await waitForCondition(async () => {
          await _testOnly.reconcileMirrorSubscriptions();
          return adapter.streamEvents.filter((event) => (
            event.kind === 'end'
            && event.status === 'completed'
            && event.text?.includes(responseText)
          )).length >= 2;
        }, 20_000, 100),
        true,
      );
      await execFileAsync('tmux', ['has-session', '-t', tmuxSessionName]);
      assert.equal(store.getSession(session.id)?.runtime?.kimi?.sessionId, kimiSessionId);
      assert.deepEqual(adapter.reactions, [
        { messageId: 'incoming-real-kimi-first', emojiType: 'Get' },
        { messageId: 'incoming-real-kimi-steer', emojiType: 'Get' },
        { messageId: 'incoming-real-kimi-cold-takeover', emojiType: 'Get' },
      ]);
      assert.equal(
        adapter.sent.some((message) => message.text.includes('expected running before send')),
        false,
      );
    } finally {
      bridgeState.running = false;
      await execFileAsync('tmux', ['kill-session', '-t', tmuxSessionName]).catch(() => {});
      await proxy.close().catch(() => undefined);
      for (const [key, value] of previousEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      removeRuntimeTestDirectory(tempDir);
    }
  });
});
