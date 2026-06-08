import '../../../setup/test-setup.js';
import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { CodexRoutingProvider } from '../../../../runtime/codex/routing-provider.js';
import { getCodexSessionByThreadIdSafe } from '../../../../bridge/session/support.js';
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
  seedCodexApiKeyAuth,
  startLocalResponsesProxy,
  waitForCondition,
} from '../../../helpers/runtime/real-codex-e2e-utils.js';

const execFileAsync = promisify(execFile);
const REAL_CODEX_E2E_ENV = 'CODELARK_REAL_CODEX_E2E';
const REAL_CODEX_E2E_MODEL_ENV = 'CODELARK_REAL_CODEX_E2E_MODEL';

function createLongPrompt(): string {
  const words = Array.from({ length: 720 }, (_, index) => `ctiword${String(index).padStart(4, '0')}`);
  return `clk-long-prompt-start ${words.join(' ')} clk-long-prompt-end`;
}

function responseRequestModels(requests: Array<{ body: unknown }>): string[] {
  return [...new Set(requests
    .map((request) => {
      const body = request.body as { model?: unknown };
      return typeof body.model === 'string' ? body.model : '';
    })
    .filter((actualModel) => actualModel.trim().length > 0))];
}

function findTrustPermission(adapter: RecordingAdapter): {
  callbackData: string;
  callbackMessageId: string;
  messageText: string;
  buttonTexts: string[];
  permissionRequestId: string;
} | null {
  for (const [index, message] of adapter.sent.entries()) {
    const button = message.inlineButtons
      ?.flat()
      .find((item) => item.callbackData.startsWith('perm:allow:codex-trust:'));
    if (!button) continue;
    return {
      callbackData: button.callbackData,
      callbackMessageId: `reply-${index + 1}`,
      messageText: message.text,
      buttonTexts: message.inlineButtons?.flat().map((item) => item.text) || [],
      permissionRequestId: button.callbackData.slice('perm:allow:'.length),
    };
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

async function approveTrustPermission(
  adapter: RecordingAdapter,
  store: BridgeStore,
  address: { channelType: string; chatId: string },
  options: {
    required?: boolean;
    timeoutMs?: number;
    expectedProvider?: string;
    expectedWorkingDirectory?: string;
    expectedInspectCommand?: string;
  } = {},
): Promise<boolean> {
  const sawPermission = await waitForCondition(
    () => Boolean(findTrustPermission(adapter)),
    options.timeoutMs ?? 15_000,
    250,
  );
  if (!sawPermission) {
    assert.equal(options.required === true, false, 'Codex trust prompt should be forwarded as an IM permission request');
    return false;
  }
  const permission = findTrustPermission(adapter);
  assert.ok(permission);
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
    () => Boolean(store.getPermissionLink(permission.permissionRequestId)),
    5_000,
    100,
  );
  assert.equal(sawLink, true, 'permission link should be recorded before accepting callback');
  await _testOnly.handleMessage(adapter, {
    ...inboundMessage(address, '', `incoming-trust-allow-${Date.now()}`),
    callbackData: permission.callbackData,
    callbackMessageId: permission.callbackMessageId,
  });
  return true;
}

describe('real codex tmux provider e2e', () => {
  it('keeps a real fresh-directory Codex thread after tmux provider startup and mirror reconcile', { timeout: 120_000 }, async (t: TestContext) => {
    if (process.env[REAL_CODEX_E2E_ENV] !== '1') {
      console.info(`[real-codex-tmux-provider.e2e] set ${REAL_CODEX_E2E_ENV}=1 to run real Codex e2e tests`);
      return;
    }
    if (!(await commandAvailable('tmux', ['-V']))) {
      t.skip('tmux is not available');
      return;
    }
    if (!(await commandAvailable('codex', ['--version']))) {
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
      await _testOnly.handleMessage(adapter, inboundMessage(address, '/provider tmux', 'incoming-real-provider-tmux'));
      await _testOnly.handleMessage(adapter, inboundMessage(address, '/tmux-set enter on', 'incoming-real-enter-on'));
      const firstTurn = _testOnly.handleMessage(
        adapter,
        inboundMessage(address, 'Reply with exactly: clk real tmux smoke', 'incoming-real-first'),
      );
      await approveTrustPermission(adapter, store, address, { required: false, timeoutMs: 3_000 });
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
        await new Promise((resolve) => setTimeout(resolve, 2_500));
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
    } finally {
      if (tmuxSessionName) {
        await execFileAsync('tmux', ['kill-session', '-t', tmuxSessionName]).catch(() => undefined);
      }
      if (generatedThreadId) {
        cleanupCodexThreadArtifacts(generatedThreadId, generatedThreadFilePath);
      }
      fs.rmSync(workDir, { recursive: true, force: true });
      fs.rmSync(codexHome, { recursive: true, force: true });
      await proxy.close().catch(() => undefined);
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      _testOnly.resetStateForTests();
    }
  });

  it('submits a complete multi-thousand-character prompt through real tmux and Codex', { timeout: 120_000 }, async (t: TestContext) => {
    if (process.env[REAL_CODEX_E2E_ENV] !== '1') {
      console.info(`[real-codex-tmux-provider.e2e] set ${REAL_CODEX_E2E_ENV}=1 to run real Codex e2e tests`);
      return;
    }
    if (!(await commandAvailable('tmux', ['-V']))) {
      t.skip('tmux is not available');
      return;
    }
    if (!(await commandAvailable('codex', ['--version']))) {
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
    const longPrompt = createLongPrompt();
    let tmuxSessionName = '';
    let generatedThreadId = '';
    let generatedThreadFilePath = '';

    try {
      assert.ok(longPrompt.length > 8_000, 'test prompt should be several thousand characters');

      await _testOnly.handleMessage(adapter, inboundMessage(address, `/clear real-tmux-long ${workDir}`, 'incoming-real-long-new'));
      await _testOnly.handleMessage(adapter, inboundMessage(address, '/provider tmux', 'incoming-real-long-provider'));
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const longTurn = _testOnly.handleMessage(adapter, inboundMessage(address, longPrompt, 'incoming-real-long-prompt'));
      await approveTrustPermission(adapter, store, address, { required: false, timeoutMs: 3_000 });
      await longTurn;

      const binding = store.getChannelChat(address.channelType, address.chatId);
      assert.ok(binding);
      const session = store.getSession(binding.bridgeSessionId);
      generatedThreadId = session?.runtime?.codex?.threadId?.trim() || '';
      tmuxSessionName = session?.runtime?.general?.tmuxSessionName || '';
      assert.match(generatedThreadId, /^[0-9a-f-]{20,}$/i);
      assert.equal(tmuxSessionName, `codex_${generatedThreadId}`);
      generatedThreadFilePath = getCodexSessionByThreadIdSafe(generatedThreadId, 'real tmux long prompt cleanup lookup')?.filePath || '';

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
      fs.rmSync(workDir, { recursive: true, force: true });
      fs.rmSync(codexHome, { recursive: true, force: true });
      await proxy.close().catch(() => undefined);
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      _testOnly.resetStateForTests();
    }
  });

  it('forwards a Codex goal replacement selection promptly after tmux auto-forwarded goals', { timeout: 120_000 }, async (t: TestContext) => {
    if (process.env[REAL_CODEX_E2E_ENV] !== '1') {
      t.skip(`set ${REAL_CODEX_E2E_ENV}=1 to run real Codex e2e tests`);
      return;
    }
    if (!(await commandAvailable('tmux', ['-V']))) {
      t.skip('tmux is not available');
      return;
    }
    if (!(await commandAvailable('codex', ['--version']))) {
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
      await _testOnly.handleMessage(adapter, inboundMessage(address, '/provider tmux', 'incoming-goal-selection-provider'));

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
      assert.equal(session?.runtime?.codex?.threadId, generatedThreadId);
    } finally {
      if (tmuxSessionName) {
        await execFileAsync('tmux', ['kill-session', '-t', tmuxSessionName]).catch(() => undefined);
      }
      if (generatedThreadId) {
        cleanupCodexThreadArtifacts(generatedThreadId, generatedThreadFilePath);
      }
      fs.rmSync(workDir, { recursive: true, force: true });
      fs.rmSync(codexHome, { recursive: true, force: true });
      await proxy.close().catch(() => undefined);
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      _testOnly.resetStateForTests();
    }
  });

});
