import '../../../setup/test-setup.js';
import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { CodexRoutingProvider } from '../../../../runtime/codex/routing-provider.js';
import {
  extractCodexTuiErrorMessages,
  parseCodexTuiModelMismatchWarning,
} from '../../../../runtime/codex/tui-runtime-signals.js';
import { getCodexSessionByThreadIdSafe } from '../../../../bridge/session/support.js';
import { tmuxCore } from '../../../../bridge/tmux/core.js';
import type { BridgeStore } from '../../../../domain/index.js';
import type { OutboundMessage } from '../../../../domain/index.js';
import { _testOnly, registerAdapter } from '../../../../bridge/host/manager.js';
import { PendingPermissions } from '../../../../runtime/permission-gateway.js';
import {
  initBridgeTestContext,
  inboundMessage,
  makeBridgeSettings,
  RecordingAdapter,
  resetBridgeTestState,
} from '../../../helpers/bridge/test-bridge-utils.js';
import {
  cleanupCodexThreadArtifacts,
  commandAvailable,
  removeRuntimeTestDirectory,
  seedCodexApiKeyAuth,
  startLocalResponsesProxy,
  waitForCondition,
} from '../../../helpers/runtime/real-codex-e2e-utils.js';

const execFileAsync = promisify(execFile);
const REAL_CODEX_E2E_MODEL_ENV = 'CODELARK_REAL_CODEX_E2E_MODEL';

function installedCodexExecutable(): string {
  return process.env.CODELARK_REAL_CODEX_E2E_EXECUTABLE
    || process.env.CODELARK_CODEX_CLI_PATH
    || 'codex';
}

function createLongPrompt(): string {
  const words = Array.from({ length: 720 }, (_, index) => `ctiword${String(index).padStart(4, '0')}`);
  return `clk-long-prompt-start ${words.join(' ')} clk-long-prompt-end`;
}

function createMediumMultilinePrompt(): string {
  return [
    'clk-medium-cjk-start 我想和你讨论《庄子逍遥游》中宋人卖章甫的故事。',
    '',
    '请结合无用之用、真知视野与小大之辩，说明它为什么出现在尧见四子之前。'.repeat(7),
    'clk-medium-cjk-end',
  ].join('\n');
}

function hasCompletedTurnForMarker(filePath: string, marker: string): boolean {
  if (!filePath || !fs.existsSync(filePath)) return false;
  const lines = fs.readFileSync(filePath, 'utf-8').split(/\r?\n/u).filter(Boolean);
  const userMessageIndex = lines.findIndex((line) => line.includes('"type":"user_message"') && line.includes(marker));
  return userMessageIndex >= 0 && lines.slice(userMessageIndex + 1).some((line) => line.includes('"type":"task_complete"'));
}

function requestBodyContainsText(value: unknown, expected: string): boolean {
  if (typeof value === 'string') return value.includes(expected);
  if (Array.isArray(value)) return value.some((item) => requestBodyContainsText(item, expected));
  if (!value || typeof value !== 'object') return false;
  return Object.values(value).some((item) => requestBodyContainsText(item, expected));
}

function responseRequestModels(requests: Array<{ body: unknown }>): string[] {
  return [...new Set(requests
    .map((request) => {
      const body = request.body as { model?: unknown };
      return typeof body.model === 'string' ? body.model : '';
    })
    .filter((actualModel) => actualModel.trim().length > 0))];
}

function readThreadGoalObjectives(filePath: string): string[] {
  if (!filePath || !fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf-8')
    .split(/\r?\n/u)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as {
          type?: unknown;
          payload?: { type?: unknown; goal?: { objective?: unknown } };
        };
        const objective = parsed.type === 'event_msg'
          && parsed.payload?.type === 'thread_goal_updated'
          && typeof parsed.payload.goal?.objective === 'string'
          ? parsed.payload.goal.objective.trim()
          : '';
        return objective ? [objective] : [];
      } catch {
        return [];
      }
    });
}

function rewriteRecordedTurnContextModel(filePath: string, model: string): number {
  let rewritten = 0;
  const lines = fs.readFileSync(filePath, 'utf-8')
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => {
      try {
        const parsed = JSON.parse(line) as {
          type?: unknown;
          payload?: { model?: unknown };
        };
        if (parsed.type === 'turn_context' && typeof parsed.payload?.model === 'string') {
          parsed.payload.model = model;
          rewritten += 1;
        }
        return JSON.stringify(parsed);
      } catch {
        return line;
      }
    });
  if (rewritten === 0) return 0;
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf-8');
  return rewritten;
}

function findStartupPermission(adapter: RecordingAdapter, handledCallbackData?: Set<string>): {
  kind: 'trust' | 'selection';
  callbackData: string;
  callbackMessageId: string;
  messageText: string;
  buttonTexts: string[];
  permissionRequestId?: string;
} | null {
  for (let index = adapter.sent.length - 1; index >= 0; index -= 1) {
    const message = adapter.sent[index];
    if (!message) continue;
    const button = message.inlineButtons
      ?.flat()
      .find((item) => (
        item.callbackData.startsWith('perm:allow:codex-trust:')
        && !handledCallbackData?.has(item.callbackData)
      ));
    if (button) {
      return {
        kind: 'trust',
        callbackData: button.callbackData,
        callbackMessageId: `reply-${index + 1}`,
        messageText: message.text,
        buttonTexts: message.inlineButtons?.flat().map((item) => item.text) || [],
        permissionRequestId: button.callbackData.slice('perm:allow:'.length),
      };
    }
    const selectionCallbackData = message.richCard?.selects
      ?.map((select) => select.selectedCallbackData || select.options[0]?.callbackData)
      .find((callbackData): callbackData is string => (
        Boolean(callbackData) && !handledCallbackData?.has(callbackData!)
      ));
    if (selectionCallbackData) {
      return {
        kind: 'selection',
        callbackData: selectionCallbackData,
        callbackMessageId: `reply-${index + 1}`,
        messageText: message.text,
        buttonTexts: message.richCard?.selects
          ?.flatMap((select) => select.options.map((option) => option.text)) || [],
      };
    }
  }
  return null;
}

function findCodexTuiSelectionMessage(adapter: RecordingAdapter): { message: OutboundMessage; messageId: string } | null {
  for (const [index, message] of adapter.sent.entries()) {
    if (
      /Codex TUI Selection/.test(message.text)
      || message.richCard?.title === 'Codex TUI Selection'
    ) {
      return { message, messageId: `reply-${index + 1}` };
    }
  }
  return null;
}

class RecordingStreamingAdapter extends RecordingAdapter {
  readonly statuses: string[] = [];
  readonly streamEnds: Array<{ status: 'completed' | 'interrupted' | 'error'; text: string }> = [];
  readonly deliveryEvents: Array<{ kind: 'send' | 'end'; attachmentPaths?: string[] }> = [];
  private activeStreamKey: string | null = null;
  private streamMessageReady = false;

  async send(message: OutboundMessage) {
    this.deliveryEvents.push({
      kind: 'send',
      attachmentPaths: (message.attachments || []).map((attachment) => attachment.path),
    });
    return await super.send(message);
  }

  supportsStructuredStreamingUi(): boolean {
    return true;
  }

  hasActiveStreamingUi(_chatId: string, streamKey?: string): boolean {
    return Boolean(this.activeStreamKey && (!streamKey || streamKey === this.activeStreamKey));
  }

  getStructuredStreamingUiMessageId(_chatId: string, streamKey?: string): string | null {
    return this.streamMessageReady && this.hasActiveStreamingUi(_chatId, streamKey)
      ? 'real-codex-stream-card'
      : null;
  }

  async waitForStructuredStreamingUiMessageId(_chatId: string, streamKey?: string): Promise<string | null> {
    await Promise.resolve();
    this.streamMessageReady = true;
    return this.getStructuredStreamingUiMessageId(_chatId, streamKey);
  }

  onMirrorStreamStart(_chatId: string, streamKey?: string): void {
    this.activeStreamKey = streamKey || null;
    this.streamMessageReady = false;
  }

  onStreamText(_chatId: string, _text: string, streamKey?: string): void {
    this.activeStreamKey = streamKey || this.activeStreamKey;
  }

  onStreamStatus(_chatId: string, statusText: string, streamKey?: string): void {
    this.activeStreamKey = streamKey || this.activeStreamKey;
    this.statuses.push(statusText);
  }

  onStreamEnd(
    _chatId: string,
    status: 'completed' | 'interrupted' | 'error',
    text: string,
    _streamKey?: string,
  ): Promise<boolean> {
    this.deliveryEvents.push({ kind: 'end' });
    this.streamEnds.push({ status, text });
    this.activeStreamKey = null;
    this.streamMessageReady = false;
    return Promise.resolve(true);
  }
}

async function approveStartupPermission(
  adapter: RecordingAdapter,
  store: BridgeStore,
  address: { channelType: string; chatId: string },
  options: {
    required?: boolean;
    timeoutMs?: number;
    expectedProvider?: string;
    expectedWorkingDirectory?: string;
    expectedInspectCommand?: string;
    turnSettled?: () => boolean;
    handledCallbackData?: Set<string>;
  } = {},
): Promise<boolean> {
  const sawPermission = await waitForCondition(
    () => Boolean(findStartupPermission(adapter, options.handledCallbackData)) || options.turnSettled?.() === true,
    options.timeoutMs ?? 15_000,
    250,
  );
  const permission = findStartupPermission(adapter, options.handledCallbackData);
  if (!sawPermission || !permission) {
    if (options.turnSettled?.() === true) return false;
    assert.equal(options.required === true, false, 'Codex trust prompt should be forwarded as an IM permission request');
    return false;
  }
  if (permission.kind === 'trust') {
    assert.match(permission.messageText, /Codex Trust Confirmation/);
    assert.deepEqual(permission.buttonTexts, ['Trust and continue', 'Deny']);
    assert.doesNotMatch(permission.messageText, /Allow Session/i);
    if (options.expectedProvider) {
      assert.match(permission.messageText, new RegExp(`Provider: ${options.expectedProvider}`));
    }
    if (options.expectedWorkingDirectory) {
      assert.match(permission.messageText, new RegExp(`Directory: ${options.expectedWorkingDirectory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    }
    if (options.expectedInspectCommand) {
      assert.match(permission.messageText, new RegExp(`Inspect current screen: ${options.expectedInspectCommand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    }
    const sawLink = await waitForCondition(
      () => Boolean(permission.permissionRequestId && store.getPermissionLink(permission.permissionRequestId)),
      5_000,
      100,
    );
    assert.equal(sawLink, true, 'permission link should be recorded before accepting callback');
  } else {
    assert.match(permission.messageText, /Codex TUI Selection/);
    assert.equal(permission.buttonTexts.length > 0, true);
  }
  options.handledCallbackData?.add(permission.callbackData);
  await _testOnly.handleMessage(adapter, {
    ...inboundMessage(address, '', `incoming-trust-allow-${Date.now()}`),
    callbackData: permission.callbackData,
    callbackMessageId: permission.callbackMessageId,
  });
  return true;
}

async function startTmuxProvider(
  adapter: RecordingAdapter,
  store: BridgeStore,
  address: { channelType: string; chatId: string },
  messageId: string,
): Promise<void> {
  const startup = _testOnly.handleMessage(
    adapter,
    inboundMessage(address, '/provider tmux', messageId),
  );
  let startupSettled = false;
  void startup.then(
    () => { startupSettled = true; },
    () => { startupSettled = true; },
  );
  const handledCallbackData = new Set<string>();
  while (!startupSettled) {
    const approved = await approveStartupPermission(adapter, store, address, {
      required: true,
      timeoutMs: 30_000,
      turnSettled: () => startupSettled,
      handledCallbackData,
    });
    if (!approved) break;
  }
  await startup;
}

describe('real codex tmux provider e2e', () => {
  it('keeps a real Codex thread and warns once when resuming it with a different model', { timeout: 120_000 }, async (t: TestContext) => {
    if (!(await commandAvailable('tmux', ['-V']))) {
      t.skip('tmux is not available');
      return;
    }
    if (!(await commandAvailable(installedCodexExecutable(), ['--version']))) {
      t.skip('codex CLI is not available');
      return;
    }

    const previousEnv = {
      CODEX_HOME: process.env.CODEX_HOME,
      CODELARK_CODEX_BASE_URL: process.env.CODELARK_CODEX_BASE_URL,
      CODELARK_CODEX_API_KEY: process.env.CODELARK_CODEX_API_KEY,
      CODEX_API_KEY: process.env.CODEX_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      CODELARK_CODEX_SKIP_GIT_REPO_CHECK: process.env.CODELARK_CODEX_SKIP_GIT_REPO_CHECK,
    };
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-real-codex-home-'));
    const proxy = await startLocalResponsesProxy();
    process.env.CODEX_HOME = codexHome;
    process.env.CODELARK_CODEX_BASE_URL = proxy.baseUrl;
    process.env.CODELARK_CODEX_API_KEY = 'clk-local-proxy-key';
    process.env.CODEX_API_KEY = 'clk-local-proxy-key';
    process.env.OPENAI_API_KEY = 'clk-local-proxy-key';
    process.env.CODELARK_CODEX_SKIP_GIT_REPO_CHECK = 'true';

    resetBridgeTestState({ cleanCodexHome: true });
    seedCodexApiKeyAuth(codexHome, 'clk-local-proxy-key');
    fs.writeFileSync(
      path.join(codexHome, 'config.toml'),
      'check_for_update_on_startup = false\n',
      'utf-8',
    );
    _testOnly.resetStateForTests();

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-real-tmux-provider-'));
    const model = process.env[REAL_CODEX_E2E_MODEL_ENV] || 'gpt-5.4';
    const settings = makeBridgeSettings({
      bridge_default_provider: 'tmux',
      bridge_default_model: model,
      bridge_codex_reasoning_effort: 'low',
    });
    const pendingPerms = new PendingPermissions();
    const store = initBridgeTestContext({
      settings,
      llm: new CodexRoutingProvider(pendingPerms, 'tmux'),
      permissions: {
        resolvePendingPermission: (id, resolution) => pendingPerms.resolve(id, resolution),
      },
    });
    const adapter = new RecordingAdapter();
    registerAdapter(adapter);
    const bridgeState = (globalThis as unknown as Record<string, any>).__bridge_manager__;
    bridgeState.running = true;
    const address = { channelType: 'feishu', chatId: `chat-real-tmux-${process.pid}-${Date.now()}` } as const;
    let tmuxSessionName = '';
    let generatedThreadId = '';
    let generatedThreadFilePath = '';

    try {
      await _testOnly.handleMessage(adapter, inboundMessage(address, `/clear real-tmux-fresh ${workDir}`, 'incoming-real-new'));
      await startTmuxProvider(adapter, store, address, 'incoming-real-provider-tmux');
      const firstTurn = _testOnly.handleMessage(
        adapter,
        inboundMessage(address, 'Reply with exactly: clk real tmux smoke', 'incoming-real-first'),
      );
      await firstTurn;

      const binding = store.getChannelChat(address.channelType, address.chatId);
      assert.ok(binding);
      const session = store.getSession(binding.bridgeSessionId);
      const threadId = session?.runtime?.codex?.threadId?.trim() || '';
      generatedThreadId = threadId;
      tmuxSessionName = session?.runtime?.general?.tmuxSessionName || '';
      assert.match(threadId, /^[0-9a-f-]{20,}$/i);
      assert.equal(tmuxSessionName, `codex_${threadId}`);

      await execFileAsync('tmux', ['has-session', '-t', tmuxSessionName]);

      const becameVisible = await waitForCondition(
        () => Boolean(getCodexSessionByThreadIdSafe(threadId, 'real tmux provider e2e')),
        15_000,
        500,
      );
      assert.equal(becameVisible, true, 'real Codex session JSONL should become visible');
      generatedThreadFilePath = getCodexSessionByThreadIdSafe(threadId, 'real tmux provider cleanup lookup')?.filePath || '';

      for (let i = 0; i < 3; i += 1) {
        await _testOnly.reconcileMirrorSubscriptions();
        assert.equal(store.getSession(binding.bridgeSessionId)?.runtime?.codex?.threadId, threadId);
      }

      assert.equal(store.getSession(binding.bridgeSessionId)?.runtime?.codex?.threadId, threadId);
      assert.equal(bridgeState.mirrorSubscriptions.get(binding.id)?.threadId, threadId);

      const sawModelRequest = await waitForCondition(
        () => proxy.requests.some((request) => request.url.includes('/responses')),
        20_000,
        500,
      );
      assert.equal(sawModelRequest, true, 'local Responses proxy should receive a real Codex model request');
      const responseRequests = proxy.requests.filter((request) => (
        request.url.includes('/responses')
      ));
      const actualModels = responseRequestModels(responseRequests);
      assert.equal(actualModels.length > 0, true, 'Codex request body should include a model field');
      if (!actualModels.includes(model)) {
        console.warn([
          '[real-codex-tmux-provider.e2e] Codex CLI resolved the requested model to a different request body model.',
          `requestedModel=${model}`,
          `actualModels=${actualModels.join(', ') || '-'}`,
        ].join(' '));
      }
      assert.equal(responseRequests.some((request) => {
        const body = request.body as { reasoning?: { effort?: unknown } };
        return typeof body.reasoning?.effort === 'string' && body.reasoning.effort.length > 0;
      }), true, 'Codex request body should include a reasoning effort');

      const resumingModel = actualModels[0];
      assert.ok(resumingModel);
      const recordedModel = resumingModel === 'gpt-5.5-2026-04-24'
        ? 'gpt-5.4'
        : 'gpt-5.5-2026-04-24';
      assert.equal(
        await waitForCondition(
          () => hasCompletedTurnForMarker(generatedThreadFilePath, 'clk real tmux smoke'),
          30_000,
          100,
        ),
        true,
        'the first real Codex turn should finish before its recorded model is rewritten',
      );
      assert.equal(
        await waitForCondition(
          () => rewriteRecordedTurnContextModel(generatedThreadFilePath, recordedModel) > 0,
          10_000,
          100,
        ),
        true,
        'the isolated rollout should contain a real turn_context to emulate an older Codex model record',
      );
      await execFileAsync('tmux', ['kill-session', '-t', tmuxSessionName]);
      assert.equal(
        await waitForCondition(
          () => !store.getSession(binding.bridgeSessionId)?.runtime?.general?.tmuxSessionName,
          10_000,
          100,
        ),
        true,
        'the missing-session probe should settle before this test explicitly restarts the provider',
      );
      await _testOnly.handleMessage(
        adapter,
        inboundMessage(address, `/model ${resumingModel}`, 'incoming-real-model-switch'),
      );
      await _testOnly.handleMessage(
        adapter,
        inboundMessage(address, '/provider tmux', 'incoming-real-provider-restart'),
      );

      let observedWarning: ReturnType<typeof parseCodexTuiModelMismatchWarning> = null;
      const expectedWarningKey = `${binding.bridgeSessionId}\u0000${recordedModel}\u0000${resumingModel}`;
      const sawMismatchNotice = await waitForCondition(async () => {
        const capture = await execFileAsync(
          'tmux',
          ['capture-pane', '-p', '-t', `${tmuxSessionName}:0.0`, '-S', '-80'],
        ).catch(() => ({ stdout: '', stderr: '' }));
        observedWarning = parseCodexTuiModelMismatchWarning(capture.stdout);
        await _testOnly.reconcileMirrorSubscriptions();
        return adapter.sent.some((message) => message.richCard?.title === 'Codex 恢复模型不一致')
          && store.getChannelChat(address.channelType, address.chatId)?.codexModelMismatchWarningKey === expectedWarningKey;
      }, 15_000, 100);
      assert.equal(sawMismatchNotice, true, 'real Codex resume warning should reach the bridge notice path');
      const parsedWarning = observedWarning as {
        recordedModel: string;
        resumingModel: string;
      } | null;
      assert.ok(parsedWarning);
      assert.equal(parsedWarning.recordedModel, recordedModel);
      assert.equal(parsedWarning.resumingModel, resumingModel);
      const mismatchNotices = adapter.sent.filter((message) => message.richCard?.title === 'Codex 恢复模型不一致');
      assert.equal(mismatchNotices.length, 1);
      assert.match(mismatchNotices[0].text, /\/clear/);
      assert.equal(store.getSession(binding.bridgeSessionId)?.runtime?.codex?.threadId, threadId);
      assert.equal(
        store.getChannelChat(address.channelType, address.chatId)?.codexModelMismatchWarningKey,
        expectedWarningKey,
      );
      await _testOnly.reconcileMirrorSubscriptions();
      await _testOnly.reconcileMirrorSubscriptions();
      assert.equal(
        adapter.sent.filter((message) => message.richCard?.title === 'Codex 恢复模型不一致').length,
        1,
      );
    } finally {
      if (tmuxSessionName) {
        await execFileAsync('tmux', ['kill-session', '-t', tmuxSessionName]).catch(() => undefined);
      }
      if (generatedThreadId) {
        cleanupCodexThreadArtifacts(generatedThreadId, generatedThreadFilePath);
      }
      removeRuntimeTestDirectory(workDir);
      removeRuntimeTestDirectory(codexHome);
      await proxy.close().catch(() => undefined);
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      _testOnly.resetStateForTests();
    }
  });

  it('sends an answer artifact before the real Codex turn completes and does not duplicate it at finalization', { timeout: 120_000 }, async (t: TestContext) => {
    if (!(await commandAvailable('tmux', ['-V']))) {
      t.skip('tmux is not available');
      return;
    }
    if (!(await commandAvailable(installedCodexExecutable(), ['--version']))) {
      t.skip('codex CLI is not available');
      return;
    }

    const previousEnv = {
      CODEX_HOME: process.env.CODEX_HOME,
      CODELARK_CODEX_BASE_URL: process.env.CODELARK_CODEX_BASE_URL,
      CODELARK_CODEX_API_KEY: process.env.CODELARK_CODEX_API_KEY,
      CODEX_API_KEY: process.env.CODEX_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      CODELARK_CODEX_SKIP_GIT_REPO_CHECK: process.env.CODELARK_CODEX_SKIP_GIT_REPO_CHECK,
    };
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-real-codex-home-artifact-'));
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-real-codex-artifact-'));
    const artifactPath = path.join(workDir, 'answer-artifact.txt');
    fs.writeFileSync(artifactPath, 'answer artifact from real Codex + mock model\n', 'utf8');
    const sendBlock = `<clk-send>${JSON.stringify({ type: 'file', path: artifactPath })}</clk-send>`;
    const proxy = await startLocalResponsesProxy({
      responseText: `CODEX_STREAM_ARTIFACT_READY\n${sendBlock}`,
      responsesFinishDelayMs: 20_000,
    });
    process.env.CODEX_HOME = codexHome;
    process.env.CODELARK_CODEX_BASE_URL = proxy.baseUrl;
    process.env.CODELARK_CODEX_API_KEY = 'clk-local-proxy-key';
    process.env.CODEX_API_KEY = 'clk-local-proxy-key';
    process.env.OPENAI_API_KEY = 'clk-local-proxy-key';
    process.env.CODELARK_CODEX_SKIP_GIT_REPO_CHECK = 'true';
    resetBridgeTestState({ cleanCodexHome: true });
    seedCodexApiKeyAuth(codexHome, 'clk-local-proxy-key');
    fs.writeFileSync(path.join(codexHome, 'config.toml'), [
      'model_provider = "mock"',
      '',
      '[model_providers.mock]',
      'name = "mock"',
      `base_url = "${proxy.baseUrl}"`,
      'env_key = "OPENAI_API_KEY"',
      'wire_api = "responses"',
      'request_max_retries = 0',
      'stream_max_retries = 0',
      'requires_openai_auth = false',
      'supports_websockets = false',
      '',
    ].join('\n'));
    _testOnly.resetStateForTests();

    const model = process.env[REAL_CODEX_E2E_MODEL_ENV] || 'gpt-5.4';
    const pendingPerms = new PendingPermissions();
    const store = initBridgeTestContext({
      settings: makeBridgeSettings({
        bridge_default_provider: 'tmux',
        bridge_default_model: model,
        bridge_codex_reasoning_effort: 'low',
      }),
      llm: new CodexRoutingProvider(pendingPerms, 'tmux'),
      permissions: {
        resolvePendingPermission: (id, resolution) => pendingPerms.resolve(id, resolution),
      },
    });
    const adapter = new RecordingStreamingAdapter();
    registerAdapter(adapter);
    const bridgeState = (globalThis as unknown as Record<string, any>).__bridge_manager__;
    bridgeState.running = true;
    const address = { channelType: 'feishu', chatId: `chat-real-artifact-${process.pid}-${Date.now()}` } as const;
    let tmuxSessionName = '';
    let generatedThreadId = '';
    let generatedThreadFilePath = '';

    try {
      await _testOnly.handleMessage(adapter, inboundMessage(address, `/clear real-codex-artifact ${workDir}`, 'incoming-artifact-new'));
      await startTmuxProvider(adapter, store, address, 'incoming-artifact-provider');
      const turnPromise = _testOnly.handleMessage(
        adapter,
        inboundMessage(address, 'Create and send the requested artifact.', 'incoming-artifact-turn'),
      );

      assert.equal(await waitForCondition(
        () => proxy.requests.some((request) => request.url.includes('/responses')),
        15_000,
        50,
      ), true, 'real Codex executable should call the mock Responses server');

      const binding = store.getChannelChat(address.channelType, address.chatId);
      assert.ok(binding);
      const session = store.getSession(binding.bridgeSessionId);
      generatedThreadId = session?.runtime?.codex?.threadId?.trim() || '';
      tmuxSessionName = session?.runtime?.general?.tmuxSessionName || '';
      generatedThreadFilePath = getCodexSessionByThreadIdSafe(
        generatedThreadId,
        'real Codex streaming artifact cleanup lookup',
      )?.filePath || '';

      const deliveredBeforeCompletion = await waitForCondition(async () => {
        await _testOnly.reconcileMirrorSubscriptions();
        const sent = adapter.sent.flatMap((message) => message.attachments || [])
          .some((attachment) => attachment.path === artifactPath);
        return sent && adapter.streamEnds.length === 0;
      }, 15_000, 50);
      assert.equal(deliveredBeforeCompletion, true, 'answer artifact should arrive while the mock response remains open');

      await turnPromise;
      assert.equal(await waitForCondition(async () => {
        await _testOnly.reconcileMirrorSubscriptions();
        return adapter.streamEnds.some((entry) => entry.status === 'completed');
      }, 30_000, 50), true);

      const attachmentPaths = adapter.sent
        .flatMap((message) => message.attachments || [])
        .map((attachment) => attachment.path);
      assert.deepEqual(attachmentPaths, [artifactPath]);
      const artifactMessage = adapter.sent.find((message) => (
        message.attachments || []
      ).some((attachment) => attachment.path === artifactPath));
      assert.equal(artifactMessage?.replyToMessageId, 'real-codex-stream-card');
      const sendIndex = adapter.deliveryEvents.findIndex((event) => (
        event.kind === 'send' && event.attachmentPaths?.includes(artifactPath)
      ));
      const endIndex = adapter.deliveryEvents.findIndex((event) => event.kind === 'end');
      assert.ok(sendIndex >= 0 && endIndex > sendIndex);
    } finally {
      await _testOnly.waitForPendingTmuxSelectionPromptProbes();
      bridgeState.running = false;
      if (tmuxSessionName) {
        await execFileAsync('tmux', ['kill-session', '-t', tmuxSessionName]).catch(() => undefined);
      }
      if (generatedThreadId) {
        cleanupCodexThreadArtifacts(generatedThreadId, generatedThreadFilePath);
      }
      removeRuntimeTestDirectory(workDir);
      removeRuntimeTestDirectory(codexHome);
      await proxy.close().catch(() => undefined);
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      _testOnly.resetStateForTests();
    }
  });

  it('keeps a real direct-TUI HTTP 429 after it scrolls out before mirror finalization', { timeout: 120_000 }, async (t: TestContext) => {
    if (!(await commandAvailable('tmux', ['-V']))) {
      t.skip('tmux is not available');
      return;
    }
    if (!(await commandAvailable(installedCodexExecutable(), ['--version']))) {
      t.skip('codex CLI is not available');
      return;
    }

    const previousEnv = {
      CODEX_HOME: process.env.CODEX_HOME,
      CODELARK_CODEX_BASE_URL: process.env.CODELARK_CODEX_BASE_URL,
      CODELARK_CODEX_API_KEY: process.env.CODELARK_CODEX_API_KEY,
      CODEX_API_KEY: process.env.CODEX_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      CODELARK_CODEX_SKIP_GIT_REPO_CHECK: process.env.CODELARK_CODEX_SKIP_GIT_REPO_CHECK,
    };
    const fatalMarker = 'CODELARK_DIRECT_TUI_FATAL';
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-real-codex-home-error-'));
    const proxy = await startLocalResponsesProxy({
      errorWhenBodyIncludes: fatalMarker,
      errorStatus: 429,
      responseDelayMs: 1_500,
      errorBody: {
        error: { type: 'rate_limit_error', message: 'CODELARK_MOCK_FATAL' },
      },
    });
    process.env.CODEX_HOME = codexHome;
    process.env.CODELARK_CODEX_BASE_URL = proxy.baseUrl;
    process.env.CODELARK_CODEX_API_KEY = 'clk-local-proxy-key';
    process.env.CODEX_API_KEY = 'clk-local-proxy-key';
    process.env.OPENAI_API_KEY = 'clk-local-proxy-key';
    process.env.CODELARK_CODEX_SKIP_GIT_REPO_CHECK = 'true';

    resetBridgeTestState({ cleanCodexHome: true });
    seedCodexApiKeyAuth(codexHome, 'clk-local-proxy-key');
    fs.writeFileSync(path.join(codexHome, 'config.toml'), [
      'model_provider = "mock"',
      '',
      '[model_providers.mock]',
      'name = "mock"',
      `base_url = "${proxy.baseUrl}"`,
      'env_key = "OPENAI_API_KEY"',
      'wire_api = "responses"',
      'request_max_retries = 0',
      'stream_max_retries = 0',
      'requires_openai_auth = false',
      'supports_websockets = false',
      '',
    ].join('\n'));
    _testOnly.resetStateForTests();

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-real-tmux-error-'));
    const settings = makeBridgeSettings({
      bridge_default_provider: 'tmux',
      bridge_default_model: process.env[REAL_CODEX_E2E_MODEL_ENV] || 'gpt-5.4',
      bridge_codex_reasoning_effort: 'low',
    });
    const pendingPerms = new PendingPermissions();
    const store = initBridgeTestContext({
      settings,
      llm: new CodexRoutingProvider(pendingPerms, 'tmux'),
      permissions: {
        resolvePendingPermission: (id, resolution) => pendingPerms.resolve(id, resolution),
      },
    });
    const adapter = new RecordingStreamingAdapter();
    registerAdapter(adapter);
    const bridgeState = (globalThis as unknown as Record<string, any>).__bridge_manager__;
    bridgeState.running = true;
    const address = { channelType: 'feishu', chatId: `chat-real-tmux-error-${process.pid}-${Date.now()}` } as const;
    let tmuxSessionName = '';
    let generatedThreadId = '';
    let generatedThreadFilePath = '';

    try {
      await _testOnly.handleMessage(adapter, inboundMessage(address, `/clear real-tmux-error ${workDir}`, 'incoming-error-new'));
      await startTmuxProvider(adapter, store, address, 'incoming-error-provider');
      const binding = store.getChannelChat(address.channelType, address.chatId);
      assert.ok(binding);
      const session = store.getSession(binding.bridgeSessionId);
      generatedThreadId = session?.runtime?.codex?.threadId?.trim() || '';
      tmuxSessionName = session?.runtime?.general?.tmuxSessionName || '';
      assert.match(generatedThreadId, /^[0-9a-f-]{20,}$/i);
      assert.equal(tmuxSessionName, `codex_${generatedThreadId}`);
      generatedThreadFilePath = getCodexSessionByThreadIdSafe(generatedThreadId, 'real tmux error cleanup lookup')?.filePath || '';

      await _testOnly.reconcileMirrorSubscriptions();
      await execFileAsync('tmux', ['resize-window', '-t', tmuxSessionName, '-x', '60', '-y', '42']);
      await tmuxCore.sendActions(`${tmuxSessionName}:0.0`, [
        { type: 'literal', text: fatalMarker },
        { type: 'key', key: 'Enter' },
      ], { delayMs: 250, forcePasteLiterals: true });
      await new Promise((resolve) => setTimeout(resolve, 250));
      const afterSubmit = await execFileAsync('tmux', ['capture-pane', '-p', '-t', `${tmuxSessionName}:0.0`, '-S', '-80']);
      if (afterSubmit.stdout.includes(`› ${fatalMarker}`)) {
        await execFileAsync('tmux', ['send-keys', '-t', `${tmuxSessionName}:0.0`, 'Enter']);
      }

      const sawRequest = await waitForCondition(
        () => proxy.requests.some((request) => request.rawBody.includes(fatalMarker)),
        10_000,
        50,
      );
      assert.equal(sawRequest, true, 'real Codex should submit the fatal marker to the fake proxy');
      await _testOnly.reconcileMirrorSubscriptions();
      const subscription = bridgeState.mirrorSubscriptions.get(binding.id);
      assert.ok(subscription?.pendingTurn, 'mirror should own the real running turn before the delayed 429 arrives');
      bridgeState.running = false;

      const sawSquare = await waitForCondition(async () => {
        const capture = await execFileAsync('tmux', ['capture-pane', '-p', '-t', `${tmuxSessionName}:0.0`, '-S', '-80'])
          .catch(() => ({ stdout: '', stderr: '' }));
        return extractCodexTuiErrorMessages(capture.stdout)
          .some((message) => message.includes('429 Too Many Requests'));
      }, 15_000, 100);
      assert.equal(sawSquare, true, 'real Codex TUI should render the HTTP 429 as a square error cell');

      const errorCapture = await execFileAsync('tmux', ['capture-pane', '-p', '-t', `${tmuxSessionName}:0.0`, '-S', '-80']);
      _testOnly.observeCodexTuiPendingTurnError(subscription, errorCapture.stdout);

      const screenFiller = Array.from({ length: 1_200 }, (_, index) => `clkfill${index}`).join(' ');
      await execFileAsync('tmux', ['resize-window', '-t', tmuxSessionName, '-x', '60', '-y', '6']);
      await execFileAsync('tmux', ['send-keys', '-t', `${tmuxSessionName}:0.0`, '-l', screenFiller]);
      await execFileAsync('tmux', ['clear-history', '-t', `${tmuxSessionName}:0.0`]);
      const errorScrolledOut = await waitForCondition(async () => {
        const capture = await execFileAsync('tmux', ['capture-pane', '-p', '-t', `${tmuxSessionName}:0.0`, '-S', '-80'])
          .catch(() => ({ stdout: '', stderr: '' }));
        return !extractCodexTuiErrorMessages(capture.stdout)
          .some((message) => message.includes('429 Too Many Requests'));
      }, 5_000, 100);
      assert.equal(errorScrolledOut, true, 'later terminal content should push the real 429 out of the final 80-line capture');

      bridgeState.running = true;
      const deliveredError = await waitForCondition(async () => {
        await _testOnly.reconcileMirrorSubscriptions();
        return adapter.streamEnds.some((entry) => entry.status === 'error');
      }, 15_000, 100);
      assert.equal(deliveredError, true, 'mirror should finalize the direct TUI turn from the remembered running-turn error');
      assert.equal(adapter.streamEnds.filter((entry) => entry.status === 'error').length, 1);
      assert.match(adapter.statuses.at(-1) || '', /429 Too Many Requests/);
      assert.doesNotMatch(adapter.statuses.at(-1) || '', /处理中/);

      const rollout = fs.readFileSync(generatedThreadFilePath, 'utf-8')
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { type?: string; payload?: { type?: string; error?: unknown; last_agent_message?: unknown } });
      const fatalComplete = rollout.findLast((entry) => entry.type === 'event_msg' && entry.payload?.type === 'task_complete');
      assert.ok(fatalComplete);
      assert.equal(fatalComplete.payload?.last_agent_message, null);
      if (fatalComplete.payload?.error !== undefined) {
        const structuredError = JSON.stringify(fatalComplete.payload.error);
        assert.equal(
          /rate_limit_error.*CODELARK_MOCK_FATAL/u.test(structuredError)
            || /response_too_many_failed_attempts.*http_status_code["']?:?429/u.test(structuredError),
          true,
          'Codex should preserve either the model rate-limit error or its structured retry-exhausted 429 wrapper',
        );
      }
      assert.equal(proxy.requests.filter((request) => request.rawBody.includes(fatalMarker)).length, 1);
    } finally {
      if (tmuxSessionName) {
        await execFileAsync('tmux', ['kill-session', '-t', tmuxSessionName]).catch(() => undefined);
      }
      if (generatedThreadId) {
        cleanupCodexThreadArtifacts(generatedThreadId, generatedThreadFilePath);
      }
      removeRuntimeTestDirectory(workDir);
      removeRuntimeTestDirectory(codexHome);
      await proxy.close().catch(() => undefined);
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      _testOnly.resetStateForTests();
    }
  });

  it('submits complete medium multiline CJK and multi-thousand-character prompts through real tmux and Codex', { timeout: 120_000 }, async (t: TestContext) => {
    if (!(await commandAvailable('tmux', ['-V']))) {
      t.skip('tmux is not available');
      return;
    }
    if (!(await commandAvailable(installedCodexExecutable(), ['--version']))) {
      t.skip('codex CLI is not available');
      return;
    }

    const previousEnv = {
      CODEX_HOME: process.env.CODEX_HOME,
      CODELARK_CODEX_BASE_URL: process.env.CODELARK_CODEX_BASE_URL,
      CODELARK_CODEX_API_KEY: process.env.CODELARK_CODEX_API_KEY,
      CODEX_API_KEY: process.env.CODEX_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      CODELARK_CODEX_SKIP_GIT_REPO_CHECK: process.env.CODELARK_CODEX_SKIP_GIT_REPO_CHECK,
    };
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-real-codex-home-long-'));
    const proxy = await startLocalResponsesProxy();
    process.env.CODEX_HOME = codexHome;
    process.env.CODELARK_CODEX_BASE_URL = proxy.baseUrl;
    process.env.CODELARK_CODEX_API_KEY = 'clk-local-proxy-key';
    process.env.CODEX_API_KEY = 'clk-local-proxy-key';
    process.env.OPENAI_API_KEY = 'clk-local-proxy-key';
    process.env.CODELARK_CODEX_SKIP_GIT_REPO_CHECK = 'true';

    resetBridgeTestState({ cleanCodexHome: true });
    seedCodexApiKeyAuth(codexHome, 'clk-local-proxy-key');
    _testOnly.resetStateForTests();

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-real-tmux-long-prompt-'));
    const model = process.env[REAL_CODEX_E2E_MODEL_ENV] || 'gpt-5.4';
    const settings = makeBridgeSettings({
      bridge_default_provider: 'tmux',
      bridge_default_model: model,
      bridge_codex_reasoning_effort: 'low',
    });
    const pendingPerms = new PendingPermissions();
    const store = initBridgeTestContext({
      settings,
      llm: new CodexRoutingProvider(pendingPerms, 'tmux'),
      permissions: {
        resolvePendingPermission: (id, resolution) => pendingPerms.resolve(id, resolution),
      },
    });
    const adapter = new RecordingAdapter();
    registerAdapter(adapter);
    (globalThis as unknown as Record<string, any>).__bridge_manager__.running = true;
    const address = { channelType: 'feishu', chatId: `chat-real-tmux-long-${process.pid}-${Date.now()}` } as const;
    const mediumPrompt = createMediumMultilinePrompt();
    const longPrompt = createLongPrompt();
    let tmuxSessionName = '';
    let generatedThreadId = '';
    let generatedThreadFilePath = '';

    try {
      assert.ok(Array.from(mediumPrompt).length > 256, 'medium prompt should exercise paste-burst-sensitive input');
      assert.ok(Array.from(mediumPrompt).length < 512, 'medium prompt should remain below the automatic large-paste threshold');
      assert.ok(longPrompt.length > 8_000, 'test prompt should be several thousand characters');

      await _testOnly.handleMessage(adapter, inboundMessage(address, `/clear real-tmux-long ${workDir}`, 'incoming-real-long-new'));
      await startTmuxProvider(adapter, store, address, 'incoming-real-long-provider');
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const mediumTurn = _testOnly.handleMessage(adapter, inboundMessage(address, mediumPrompt, 'incoming-real-medium-prompt'));
      await mediumTurn;

      const binding = store.getChannelChat(address.channelType, address.chatId);
      assert.ok(binding);
      const session = store.getSession(binding.bridgeSessionId);
      generatedThreadId = session?.runtime?.codex?.threadId?.trim() || '';
      tmuxSessionName = session?.runtime?.general?.tmuxSessionName || '';
      assert.match(generatedThreadId, /^[0-9a-f-]{20,}$/i);
      assert.equal(tmuxSessionName, `codex_${generatedThreadId}`);
      generatedThreadFilePath = getCodexSessionByThreadIdSafe(generatedThreadId, 'real tmux long prompt cleanup lookup')?.filePath || '';

      const sawCompleteMediumPrompt = await waitForCondition(
        () => proxy.requests.some((request) => (
          request.url.includes('/responses') && requestBodyContainsText(request.body, mediumPrompt)
        )),
        30_000,
        250,
      );
      if (!sawCompleteMediumPrompt) {
        const capture = tmuxSessionName
          ? await execFileAsync('tmux', ['capture-pane', '-t', tmuxSessionName, '-p', '-S', '-80']).catch((error) => ({ stdout: String(error), stderr: '' }))
          : { stdout: '', stderr: '' };
        const responseBodies = proxy.requests
          .filter((request) => request.url.includes('/responses'))
          .map((request) => request.rawBody.slice(-2_000));
        assert.fail([
          'real Codex request should contain the complete medium multiline CJK prompt',
          `responses requests: ${responseBodies.length}`,
          `response bodies: ${responseBodies.join('\n---\n')}`,
          `screen: ${capture.stdout.slice(-2_000)}`,
        ].join('\n'));
      }
      const mediumTurnCompleted = await waitForCondition(
        () => hasCompletedTurnForMarker(generatedThreadFilePath, 'clk-medium-cjk-start'),
        30_000,
        250,
      );
      assert.equal(mediumTurnCompleted, true, 'medium multiline CJK turn should complete before the long prompt is sent');

      await _testOnly.handleMessage(adapter, inboundMessage(address, longPrompt, 'incoming-real-long-prompt'));

      const sawCompletePrompt = await waitForCondition(
        () => proxy.requests.some((request) => request.url.includes('/responses') && request.rawBody.includes(longPrompt)),
        30_000,
        500,
      );
      if (!sawCompletePrompt) {
        const capture = tmuxSessionName
          ? await execFileAsync('tmux', ['capture-pane', '-t', tmuxSessionName, '-p', '-S', '-80']).catch((error) => ({ stdout: String(error), stderr: '' }))
          : { stdout: '', stderr: '' };
        assert.fail([
          'real Codex request should contain the complete long prompt in order',
          `responses requests: ${proxy.requests.filter((request) => request.url.includes('/responses')).length}`,
          `screen: ${capture.stdout.slice(-2000)}`,
        ].join('\n'));
      }
    } finally {
      if (tmuxSessionName) {
        await execFileAsync('tmux', ['kill-session', '-t', tmuxSessionName]).catch(() => undefined);
      }
      if (generatedThreadId) {
        cleanupCodexThreadArtifacts(generatedThreadId, generatedThreadFilePath);
      }
      removeRuntimeTestDirectory(workDir);
      removeRuntimeTestDirectory(codexHome);
      await proxy.close().catch(() => undefined);
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      _testOnly.resetStateForTests();
    }
  });

  it('forwards a Codex goal replacement selection promptly after tmux auto-forwarded goals', { timeout: 120_000 }, async (t: TestContext) => {
    if (!(await commandAvailable('tmux', ['-V']))) {
      t.skip('tmux is not available');
      return;
    }
    if (!(await commandAvailable(installedCodexExecutable(), ['--version']))) {
      t.skip('codex CLI is not available');
      return;
    }

    const previousEnv = {
      CODEX_HOME: process.env.CODEX_HOME,
      CODELARK_CODEX_BASE_URL: process.env.CODELARK_CODEX_BASE_URL,
      CODELARK_CODEX_API_KEY: process.env.CODELARK_CODEX_API_KEY,
      CODEX_API_KEY: process.env.CODEX_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      CODELARK_CODEX_SKIP_GIT_REPO_CHECK: process.env.CODELARK_CODEX_SKIP_GIT_REPO_CHECK,
    };
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-real-codex-home-goal-selection-'));
    const proxy = await startLocalResponsesProxy({
      responseText: 'clk delayed goal response',
      responseDelayMs: 2_500,
    });
    process.env.CODEX_HOME = codexHome;
    process.env.CODELARK_CODEX_BASE_URL = proxy.baseUrl;
    process.env.CODELARK_CODEX_API_KEY = 'clk-local-proxy-key';
    process.env.CODEX_API_KEY = 'clk-local-proxy-key';
    process.env.OPENAI_API_KEY = 'clk-local-proxy-key';
    process.env.CODELARK_CODEX_SKIP_GIT_REPO_CHECK = 'true';

    resetBridgeTestState({ cleanCodexHome: true });
    seedCodexApiKeyAuth(codexHome, 'clk-local-proxy-key');
    _testOnly.resetStateForTests();

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-real-tmux-goal-selection-'));
    const model = process.env[REAL_CODEX_E2E_MODEL_ENV] || 'gpt-5.4';
    const settings = makeBridgeSettings({
      bridge_default_provider: 'tmux',
      bridge_default_model: model,
      bridge_codex_reasoning_effort: 'low',
    });
    const pendingPerms = new PendingPermissions();
    const store = initBridgeTestContext({
      settings,
      llm: new CodexRoutingProvider(pendingPerms, 'tmux'),
      permissions: {
        resolvePendingPermission: (id, resolution) => pendingPerms.resolve(id, resolution),
      },
    });
    const adapter = new RecordingAdapter();
    registerAdapter(adapter);
    (globalThis as unknown as Record<string, any>).__bridge_manager__.running = true;
    const address = { channelType: 'feishu', chatId: `chat-real-tmux-goal-selection-${process.pid}-${Date.now()}` } as const;
    let tmuxSessionName = '';
    let generatedThreadId = '';
    let generatedThreadFilePath = '';

    try {
      await _testOnly.handleMessage(adapter, inboundMessage(address, `/clear real-tmux-goal-selection ${workDir}`, 'incoming-goal-selection-new'));
      await startTmuxProvider(adapter, store, address, 'incoming-goal-selection-provider');

      const binding = store.getChannelChat(address.channelType, address.chatId);
      assert.ok(binding);
      let session = store.getSession(binding.bridgeSessionId);
      generatedThreadId = session?.runtime?.codex?.threadId?.trim() || '';
      tmuxSessionName = session?.runtime?.general?.tmuxSessionName || '';
      assert.match(generatedThreadId, /^[0-9a-f-]{20,}$/i);
      assert.equal(tmuxSessionName, `codex_${generatedThreadId}`);

      await execFileAsync('tmux', ['has-session', '-t', tmuxSessionName]);

      const requestsBeforeFirstGoal = proxy.requests.length;
      await _testOnly.handleMessage(adapter, inboundMessage(address, '//goal goala', 'incoming-goal-selection-a'));
      const sawFirstGoalRequest = await waitForCondition(
        () => proxy.requests.length > requestsBeforeFirstGoal
          && proxy.requests.some((request) => request.url.includes('/responses')),
        20_000,
        250,
      );
      if (!sawFirstGoalRequest) {
        const capture = await execFileAsync('tmux', ['capture-pane', '-t', tmuxSessionName, '-p', '-S', '-80'])
          .catch((error) => ({ stdout: String(error), stderr: '' }));
        assert.fail([
          'local Responses proxy should receive the first //goal prompt before the replacement prompt is sent',
          `responses requests: ${proxy.requests.filter((request) => request.url.includes('/responses')).length}`,
          `screen: ${capture.stdout.slice(-2000)}`,
        ].join('\n'));
      }
      const sawActiveGoalScreen = await waitForCondition(
        async () => {
          const capture = await execFileAsync('tmux', ['capture-pane', '-t', tmuxSessionName, '-p', '-S', '-80'])
            .catch(() => ({ stdout: '', stderr: '' }));
          return /Pursuing goal|Goal Active|goala/i.test(capture.stdout);
        },
        8_000,
        250,
      );
      assert.equal(sawActiveGoalScreen, true, 'tmux screen should show the first goal is active before sending the replacement goal');

      await _testOnly.handleMessage(adapter, inboundMessage(address, '//goal b', 'incoming-goal-selection-b'));
      const sawSelection = await waitForCondition(
        () => Boolean(findCodexTuiSelectionMessage(adapter)),
        12_000,
        250,
      );
      if (!sawSelection) {
        const capture = await execFileAsync('tmux', ['capture-pane', '-t', tmuxSessionName, '-p', '-S', '-100'])
          .catch((error) => ({ stdout: String(error), stderr: '' }));
        assert.fail([
          'Codex TUI Selection should be forwarded promptly after the second //goal prompt',
          `responses requests: ${proxy.requests.filter((request) => request.url.includes('/responses')).length}`,
          `screen: ${capture.stdout.slice(-3000)}`,
        ].join('\n'));
      }

      const selection = findCodexTuiSelectionMessage(adapter);
      assert.ok(selection);
      assert.match(selection.message.text, /Codex TUI Selection/);
      assert.equal(selection.message.richCard?.title, 'Codex TUI Selection');
      const selectOptions = selection.message.richCard?.selects?.flatMap((select) => select.options.map((option) => option.text)) || [];
      assert.equal(selectOptions.some((text) => /Replace current goal/i.test(text)), true);
      assert.equal(selectOptions.some((text) => /^Cancel\b/i.test(text)), true);
      const cancelCallbackData = selection.message.richCard?.selects
        ?.flatMap((select) => select.options)
        .find((option) => /^Cancel\b/i.test(option.text))
        ?.callbackData;
      assert.ok(cancelCallbackData, 'selection card should include a Cancel callback');
      await _testOnly.handleMessage(adapter, {
        ...inboundMessage(address, '', 'incoming-goal-selection-cancel'),
        callbackData: cancelCallbackData,
        callbackMessageId: selection.messageId,
      });
      await new Promise((resolve) => setTimeout(resolve, 5_500));

      session = store.getSession(binding.bridgeSessionId);
      generatedThreadFilePath = generatedThreadId
        ? getCodexSessionByThreadIdSafe(generatedThreadId, 'real tmux goal selection cleanup lookup')?.filePath || ''
        : '';
      const goalObjectives = readThreadGoalObjectives(generatedThreadFilePath);
      assert.ok(goalObjectives.includes('goala'), 'the real Codex session should preserve the original active goal');
      assert.equal(
        goalObjectives.includes('b'),
        false,
        'Cancel must be executed exactly once; a duplicate Down+Enter would wrap to Replace and activate goal b',
      );
      assert.equal(session?.runtime?.codex?.threadId, generatedThreadId);
    } finally {
      if (tmuxSessionName) {
        await execFileAsync('tmux', ['kill-session', '-t', tmuxSessionName]).catch(() => undefined);
      }
      if (generatedThreadId) {
        cleanupCodexThreadArtifacts(generatedThreadId, generatedThreadFilePath);
      }
      removeRuntimeTestDirectory(workDir);
      removeRuntimeTestDirectory(codexHome);
      await proxy.close().catch(() => undefined);
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      _testOnly.resetStateForTests();
    }
  });

});
