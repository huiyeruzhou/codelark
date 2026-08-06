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
import { claudeTmuxSessionName } from '../../../../bridge/tmux/runtime.js';
import { streamClaudeTmuxTui } from '../../../../runtime/claude/tmux-provider.js';
import { listClaudeSessionJsonlSummaries } from '../../../../runtime/claude/session-jsonl.js';
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
  finalizeRuntimeTestDirectory,
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

async function readTextStream(stream: ReadableStream<string>): Promise<string> {
  let output = '';
  for await (const chunk of stream) output += chunk;
  return output;
}

describe('real Kimi Code bridge e2e', () => {
  beforeEach(() => {
    resetBridgeTestState({ cleanKimiHome: true });
    _testOnly.resetStateForTests();
  });

  afterEach(() => {
    _testOnly.resetStateForTests();
  });

  it('cold-starts Kimi, survives a bridge restart, and /t round-trips through a real Claude session', { timeout: 120_000 }, async (t: TestContext) => {
    if (!(await commandAvailable('tmux', ['-V']))) {
      t.skip('tmux is not available');
      return;
    }
    const executable = installedKimiCodeExecutable();
    if (!(await commandAvailable(executable, ['--version']))) {
      t.skip(`real Kimi Code executable is not available at ${executable}`);
      return;
    }
    if (!(await commandAvailable('claude', ['--version']))) {
      t.skip('real Claude executable is not available');
      return;
    }

    const previousEnv = new Map<string, string | undefined>();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-real-kimi-bridge-'));
    const kimiHome = path.join(tempDir, 'kimi-home');
    const claudeHome = path.join(tempDir, 'claude-home');
    const workDir = path.join(tempDir, 'workspace');
    const responseText = `CODELARK_REAL_BRIDGE_${process.pid}_${Date.now()}`;
    const steerText = `CODELARK_REAL_STEER_${process.pid}_${Date.now()}`;
    const coldTakeoverText = `CODELARK_REAL_COLD_TAKEOVER_${process.pid}_${Date.now()}`;
    const claudeSeedText = `CODELARK_REAL_CLAUDE_SEED_${process.pid}_${Date.now()}`;
    const claudeAttachedText = `CODELARK_REAL_CLAUDE_ATTACHED_${process.pid}_${Date.now()}`;
    const kimiReturnText = `CODELARK_REAL_KIMI_RETURN_${process.pid}_${Date.now()}`;
    const proxy = await startLocalResponsesProxy({ responseText, responseDelayMs: 3_000 });
    const env = {
      KIMI_CODE_HOME: kimiHome,
      HOME: claudeHome,
      USERPROFILE: claudeHome,
      CODELARK_CLAUDE_HOME: claudeHome,
      ANTHROPIC_BASE_URL: proxy.baseUrl.replace(/\/v1$/u, ''),
      ANTHROPIC_AUTH_TOKEN: 'codelark-local-mock-token',
      ANTHROPIC_API_KEY: '',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CODELARK_CLAUDE_TMUX_PROMPT_DELAY_MS: '0',
      CODELARK_CLAUDE_TMUX_POLL_INTERVAL_MS: '100',
      CODELARK_CLAUDE_TMUX_SESSION_FILE_TIMEOUT_MS: '30000',
      CODELARK_KIMI_EXECUTABLE: executable,
      KIMI_CODE_EXECUTABLE: undefined,
      KIMI_MODEL_NAME: 'codelark-real-kimi-e2e',
      KIMI_MODEL_API_KEY: 'codelark-local-mock-key',
      KIMI_MODEL_PROVIDER_TYPE: 'openai',
      KIMI_MODEL_BASE_URL: proxy.baseUrl,
      KIMI_MODEL_MAX_CONTEXT_SIZE: '32768',
      KIMI_MODEL_CAPABILITIES: '',
      KIMI_DISABLE_TELEMETRY: '1',
      CODELARK_KIMI_TMUX_POLL_INTERVAL_MS: '50',
      CODELARK_KIMI_TMUX_SESSION_FILE_TIMEOUT_MS: '30000',
      CODELARK_KIMI_TMUX_SESSION_ID_TIMEOUT_MS: '30000',
      CODELARK_KIMI_TMUX_INPUT_READY_TIMEOUT_MS: '30000',
      CODELARK_DEBUG: '1',
    } satisfies Record<string, string | undefined>;
    fs.mkdirSync(kimiHome, { recursive: true });
    fs.mkdirSync(claudeHome, { recursive: true });
    fs.mkdirSync(workDir, { recursive: true });
    writeClaudeOnboardingState(claudeHome);
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
    const session = store.createSession('real-kimi-bridge', 'test-model', undefined, workDir, 'normal', {
      activeRuntime: 'kimi',
    });
    store.updateSession(session.id, {
      runtime: {
        activeRuntime: 'kimi',
        kimi: { provider: 'tmux' },
        general: { workingDirectory: workDir },
      },
    });
    const binding = store.upsertChannelChat({
      channelType: address.channelType,
      chatId: address.chatId,
      chatKind: 'group',
      bridgeSessionId: session.id,
    });
    const tmuxSessionName = kimiTmuxSessionName(session.id);
    const claudeSeedBridgeSessionId = `claude-seed-${process.pid}-${Date.now()}`;
    const claudeSeedTmuxSessionName = claudeTmuxSessionName(claudeSeedBridgeSessionId);
    let attachedClaudeTmuxSessionName: string | undefined;
    let completed = false;

    try {
      const claudeSeedOutput = await readTextStream(streamClaudeTmuxTui({
        prompt: `Reply exactly: ${claudeSeedText}`,
        sessionId: claudeSeedBridgeSessionId,
        runtime: 'claude',
        claudeExecutable: 'claude',
        workingDirectory: workDir,
      }));
      assert.match(claudeSeedOutput, new RegExp(responseText));
      const canonicalWorkDir = fs.realpathSync.native(workDir);
      const claudeSession = listClaudeSessionJsonlSummaries(claudeHome, 10)
        .find((candidate) => fs.realpathSync.native(candidate.cwd) === canonicalWorkDir);
      assert.match(claudeSession?.sessionId || '', /^[0-9a-f-]{36}$/i);
      await execFileAsync('tmux', ['kill-session', '-t', claudeSeedTmuxSessionName]);

      await _testOnly.handleMessage(adapter, inboundMessage(address, `Reply exactly: ${responseText}`, 'incoming-real-kimi-first'));
      assert.equal(
        await waitForCondition(
          () => /^session_[A-Za-z0-9-]+$/u.test(store.getSession(session.id)?.runtime?.kimi?.sessionId || ''),
          45_000,
          50,
        ),
        true,
      );
      const initialized = store.getSession(session.id);
      const kimiSessionId = initialized?.runtime?.kimi?.sessionId;
      assert.match(kimiSessionId || '', /^session_[A-Za-z0-9-]+$/u);
      const sessionFile = findKimiSessionFileById(kimiSessionId!, workDir);
      assert.ok(sessionFile?.filePath);
      const firstKimiRequestObserved = await waitForCondition(
        () => proxy.requests.some((request) => request.rawBody.includes(responseText)),
        45_000,
        50,
      );
      if (!firstKimiRequestObserved) {
        const diagnosticScreen = (await execFileAsync(
          'tmux',
          ['capture-pane', '-p', '-t', `${tmuxSessionName}:0.0`, '-S', '-160'],
        )).stdout;
        const wireTail = fs.readFileSync(sessionFile.filePath, 'utf-8')
          .split(/\r?\n/u)
          .slice(-20)
          .join('\n');
        assert.fail(JSON.stringify({
          expectedBaseUrl: proxy.baseUrl,
          expectedPrompt: responseText,
          observedRequests: proxy.requests.map((request) => ({
            url: request.url,
            containsExpectedPrompt: request.rawBody.includes(responseText),
          })),
          wireTail,
          diagnosticScreen,
        }));
      }

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
          () => proxy.requests.some((request) => request.rawBody.includes(coldTakeoverText)),
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

      await _testOnly.handleMessage(
        adapter,
        inboundMessage(address, `/t ${claudeSession!.sessionId}`, 'incoming-real-attach-claude'),
      );
      if (store.getChannelChat(address.channelType, address.chatId)?.bridgeSessionId === session.id) {
        const confirmationCard = adapter.sent.at(-1)?.richCard;
        assert.equal(confirmationCard?.title, '确认停止并切换会话');
        const confirmCallbackData = confirmationCard?.actions?.[0]?.[0]?.callbackData;
        assert.ok(confirmCallbackData);
        await _testOnly.handleMessage(adapter, {
          ...inboundMessage(address, '', 'incoming-real-attach-claude-confirm'),
          callbackData: confirmCallbackData,
          callbackMessageId: 'message-real-attach-confirmation-card',
        });
        await new Promise((resolve) => setTimeout(resolve, 250));
        const stoppedKimiScreen = (await execFileAsync(
          'tmux',
          ['capture-pane', '-p', '-t', `${tmuxSessionName}:0.0`, '-S', '-80'],
        )).stdout;
        assert.match(stoppedKimiScreen, /Interrupted by user/);
        assert.match(stoppedKimiScreen, /Press Ctrl\+C again to exit/);
      }
      const claudeBinding = store.getChannelChat(address.channelType, address.chatId);
      assert.ok(claudeBinding);
      assert.notEqual(claudeBinding.bridgeSessionId, session.id);
      assert.equal(claudeBinding.runtimeBridgeSessionIds?.kimi, session.id);
      assert.equal(claudeBinding.runtimeBridgeSessionIds?.claude, claudeBinding.bridgeSessionId);
      assert.equal(store.getSession(claudeBinding.bridgeSessionId)?.runtime?.activeRuntime, 'claude');
      assert.equal(store.getSession(claudeBinding.bridgeSessionId)?.runtime?.claude?.sessionId, claudeSession!.sessionId);
      attachedClaudeTmuxSessionName = claudeTmuxSessionName(claudeSession!.sessionId);

      const claudeRequestCount = proxy.requests.filter((request) => /\/messages(?:\?|$)/u.test(request.url)).length;
      await _testOnly.handleMessage(
        adapter,
        inboundMessage(address, claudeAttachedText, 'incoming-real-claude-after-attach'),
      );
      assert.equal(
        await waitForCondition(
          () => proxy.requests
            .filter((request) => /\/messages(?:\?|$)/u.test(request.url))
            .slice(claudeRequestCount)
            .some((request) => JSON.stringify(request.body).includes(claudeAttachedText)),
          30_000,
          100,
        ),
        true,
      );
      assert.equal(
        store.getSession(claudeBinding.bridgeSessionId)?.runtime?.claude?.sessionId,
        claudeSession!.sessionId,
      );

      await _testOnly.handleMessage(
        adapter,
        inboundMessage(address, `/t ${session.id}`, 'incoming-real-attach-kimi-back'),
      );
      if (store.getChannelChat(address.channelType, address.chatId)?.bridgeSessionId === claudeBinding.bridgeSessionId) {
        const confirmationCard = adapter.sent.at(-1)?.richCard;
        assert.equal(confirmationCard?.title, '确认停止并切换会话');
        const confirmCallbackData = confirmationCard?.actions?.[0]?.[0]?.callbackData;
        assert.ok(confirmCallbackData);
        await _testOnly.handleMessage(adapter, {
          ...inboundMessage(address, '', 'incoming-real-attach-kimi-back-confirm'),
          callbackData: confirmCallbackData,
          callbackMessageId: 'message-real-attach-kimi-back-card',
        });
      }
      const restoredKimiBinding = store.getChannelChat(address.channelType, address.chatId);
      assert.equal(restoredKimiBinding?.bridgeSessionId, session.id);
      assert.equal(restoredKimiBinding?.runtimeBridgeSessionIds?.claude, claudeBinding.bridgeSessionId);
      assert.equal(restoredKimiBinding?.runtimeBridgeSessionIds?.kimi, session.id);
      await _testOnly.handleMessage(
        adapter,
        inboundMessage(address, kimiReturnText, 'incoming-real-kimi-after-return'),
      );
      assert.equal(
        await waitForCondition(() => (
          proxy.requests.some((request) => request.rawBody.includes(kimiReturnText))
          && fs.readFileSync(sessionFile.filePath, 'utf-8').includes(kimiReturnText)
        ), 45_000, 100),
        true,
      );
      assert.equal(store.getSession(session.id)?.runtime?.kimi?.sessionId, kimiSessionId);
      completed = true;
    } finally {
      bridgeState.running = false;
      await execFileAsync('tmux', ['kill-session', '-t', tmuxSessionName]).catch(() => {});
      await execFileAsync('tmux', ['kill-session', '-t', claudeSeedTmuxSessionName]).catch(() => {});
      if (attachedClaudeTmuxSessionName) {
        await execFileAsync('tmux', ['kill-session', '-t', attachedClaudeTmuxSessionName]).catch(() => {});
      }
      await proxy.close().catch(() => undefined);
      for (const [key, value] of previousEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      finalizeRuntimeTestDirectory(tempDir, completed);
    }
  });
});
