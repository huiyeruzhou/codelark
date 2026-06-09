import '../../../setup/test-setup.js';
import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { CodexRoutingProvider } from '../../../../runtime/codex/routing-provider.js';
import { capturePtyScreen } from '../../../../runtime/codex/pty-provider.js';
import { getCodexSessionByThreadIdSafe } from '../../../../bridge/session/support.js';
import type { BridgeStore } from '../../../../domain/index.js';
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
  type LocalResponsesProxy,
} from '../../../helpers/runtime/real-codex-e2e-utils.js';

const execFileAsync = promisify(execFile);
const REAL_CODEX_E2E_MODEL_ENV = 'CODELARK_REAL_CODEX_E2E_MODEL';

async function ptyRuntimeAvailable(): Promise<boolean> {
  try {
    const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<unknown>;
    await dynamicImport('@homebridge/node-pty-prebuilt-multiarch');
    return true;
  } catch {
    return false;
  }
}


function createLongPrompt(): string {
  const words = Array.from({ length: 720 }, (_, index) => `ctiword${String(index).padStart(4, '0')}`);
  return `clk-long-prompt-start ${words.join(' ')} clk-long-prompt-end`;
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

async function withRealPtyEnvironment<T>(
  workDirPrefix: string,
  fn: (params: {
    codexHome: string;
    workDir: string;
    proxy: LocalResponsesProxy;
    model: string;
  }) => Promise<T>,
): Promise<T> {
  const previousEnv = {
    CODEX_HOME: process.env.CODEX_HOME,
    CODELARK_CODEX_BASE_URL: process.env.CODELARK_CODEX_BASE_URL,
    CODELARK_CODEX_API_KEY: process.env.CODELARK_CODEX_API_KEY,
    CODEX_API_KEY: process.env.CODEX_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    CODELARK_CODEX_SKIP_GIT_REPO_CHECK: process.env.CODELARK_CODEX_SKIP_GIT_REPO_CHECK,
    CODELARK_CODEX_PTY_PROMPT_DELAY_MS: process.env.CODELARK_CODEX_PTY_PROMPT_DELAY_MS,
  };
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-real-pty-codex-home-'));
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), workDirPrefix));
  const proxy = await startLocalResponsesProxy();
  process.env.CODEX_HOME = codexHome;
  process.env.CODELARK_CODEX_BASE_URL = proxy.baseUrl;
  process.env.CODELARK_CODEX_API_KEY = 'clk-local-proxy-key';
  process.env.CODEX_API_KEY = 'clk-local-proxy-key';
  process.env.OPENAI_API_KEY = 'clk-local-proxy-key';
  process.env.CODELARK_CODEX_SKIP_GIT_REPO_CHECK = 'true';
  process.env.CODELARK_CODEX_PTY_PROMPT_DELAY_MS = process.env.CODELARK_CODEX_PTY_PROMPT_DELAY_MS || '1200';

  resetBridgeTestState({ cleanCodexHome: true });
  seedCodexApiKeyAuth(codexHome, 'clk-local-proxy-key');
  _testOnly.resetStateForTests();

  try {
    return await fn({
      codexHome,
      workDir,
      proxy,
      model: process.env[REAL_CODEX_E2E_MODEL_ENV] || 'gpt-5.4',
    });
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(codexHome, { recursive: true, force: true });
    await proxy.close().catch(() => undefined);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    _testOnly.resetStateForTests();
  }
}

function summarizeCodexModelRequests(
  requests: LocalResponsesProxy['requests'],
  requestedModel: string,
): {
  actualModels: string[];
  exactMatch: boolean;
  hasModelField: boolean;
} {
  const actualModels = Array.from(new Set(requests.flatMap((request) => {
    const body = request.body as { model?: unknown };
    return typeof body?.model === 'string' && body.model.trim() ? [body.model] : [];
  })));
  return {
    actualModels,
    exactMatch: actualModels.includes(requestedModel),
    hasModelField: actualModels.length > 0,
  };
}

describe('real codex pty provider e2e', () => {
  it('shows and accepts the real Codex trust card in a fresh directory before pty prompt injection', { timeout: 120_000 }, async (t: TestContext) => {
    if (!(await ptyRuntimeAvailable())) {
      t.skip('node pty runtime is not available');
      return;
    }
    if (!(await commandAvailable('codex', ['--version']))) {
      t.skip('codex CLI is not available');
      return;
    }

    await withRealPtyEnvironment('clk-real-pty-provider-', async ({ workDir, proxy, model }) => {
      const settings = makeBridgeSettings({
        bridge_default_provider: 'pty',
        bridge_default_model: model,
        bridge_codex_reasoning_effort: 'low',
      });
      const pendingPerms = new PendingPermissions();
      const store = initBridgeTestContext({
        settings,
        llm: new CodexRoutingProvider(pendingPerms, 'pty'),
        permissions: {
          resolvePendingPermission: (id, resolution) => pendingPerms.resolve(id, resolution),
        },
      });
      const adapter = new RecordingAdapter();
      registerAdapter(adapter);
      const bridgeState = (globalThis as unknown as Record<string, any>).__bridge_manager__;
      bridgeState.running = true;
      const address = { channelType: 'feishu', chatId: `chat-real-pty-${process.pid}-${Date.now()}` } as const;
      let generatedThreadId = '';
      let generatedThreadFilePath = '';

      try {
        await _testOnly.handleMessage(adapter, inboundMessage(address, `/clear real-pty-fresh ${workDir}`, 'incoming-real-pty-new'));
        await _testOnly.handleMessage(adapter, inboundMessage(address, '/provider pty', 'incoming-real-pty-provider'));
        const firstTurn = _testOnly.handleMessage(
          adapter,
          inboundMessage(address, 'Reply with exactly: clk real pty smoke', 'incoming-real-pty-first'),
        );
        await approveTrustPermission(adapter, store, address, {
          required: false,
          expectedProvider: 'pty',
          expectedWorkingDirectory: workDir,
          expectedInspectCommand: '/pty-screen 80',
        });
        await firstTurn;

        const binding = store.getChannelChat(address.channelType, address.chatId);
        assert.ok(binding);
        const session = store.getSession(binding.bridgeSessionId);
        generatedThreadId = session?.runtime?.codex?.threadId?.trim() || '';
        assert.match(generatedThreadId, /^[0-9a-f-]{20,}$/i);
        assert.equal(session?.runtime?.codex?.provider, undefined);

        const becameVisible = await waitForCondition(
          () => Boolean(getCodexSessionByThreadIdSafe(generatedThreadId, 'real pty provider e2e')),
          15_000,
          500,
        );
        assert.equal(becameVisible, true, 'real Codex session JSONL should become visible');
        generatedThreadFilePath = getCodexSessionByThreadIdSafe(generatedThreadId, 'real pty provider cleanup lookup')?.filePath || '';

        await _testOnly.handleMessage(adapter, inboundMessage(address, '/pty-screen 80', 'incoming-real-pty-screen'));
        assert.match(adapter.sent.at(-1)?.text || '', /pty 当前屏幕状态/);
        assert.ok(capturePtyScreen(binding.bridgeSessionId, 80));

        const sawModelRequest = await waitForCondition(
          () => proxy.requests.some((request) => request.url.includes('/responses')),
          20_000,
          500,
        );
        assert.equal(sawModelRequest, true, 'local Responses proxy should receive a real Codex model request');
        const responseRequests = proxy.requests.filter((request) => request.url.includes('/responses'));
        const modelSummary = summarizeCodexModelRequests(responseRequests, model);
        assert.equal(modelSummary.hasModelField, true, 'Codex request body should include a model field');
        if (!modelSummary.exactMatch) {
          console.warn([
            '[real-codex-pty-provider.e2e] Codex CLI resolved the requested model to a different request body model.',
            `requestedModel=${model}`,
            `actualModels=${modelSummary.actualModels.join(', ') || '-'}`,
          ].join(' '));
        }
        assert.equal(responseRequests.some((request) => {
          const body = request.body as { reasoning?: { effort?: unknown } };
          return typeof body.reasoning?.effort === 'string' && body.reasoning.effort.length > 0;
        }), true, 'Codex request body should include a reasoning effort');
        assert.equal(responseRequests.some((request) => (
          request.rawBody.includes('Initialize this Codex session and wait for the next instruction.')
          || request.rawBody.includes('Reply with exactly: clk real pty smoke')
        )), true);
      } finally {
        if (generatedThreadId) {
          cleanupCodexThreadArtifacts(generatedThreadId, generatedThreadFilePath);
        }
      }
    });
  });

  it('submits a complete multi-thousand-character prompt through real pty and Codex', { timeout: 120_000 }, async (t: TestContext) => {
    if (!(await ptyRuntimeAvailable())) {
      t.skip('node pty runtime is not available');
      return;
    }
    if (!(await commandAvailable('codex', ['--version']))) {
      t.skip('codex CLI is not available');
      return;
    }

    await withRealPtyEnvironment('clk-real-pty-long-prompt-', async ({ workDir, proxy, model }) => {
      const pendingPerms = new PendingPermissions();
      const store = initBridgeTestContext({
        settings: makeBridgeSettings({
          bridge_default_provider: 'pty',
          bridge_default_model: model,
          bridge_codex_reasoning_effort: 'low',
        }),
        llm: new CodexRoutingProvider(pendingPerms, 'pty'),
        permissions: {
          resolvePendingPermission: (id, resolution) => pendingPerms.resolve(id, resolution),
        },
      });
      const adapter = new RecordingAdapter();
      registerAdapter(adapter);
      (globalThis as unknown as Record<string, any>).__bridge_manager__.running = true;
      const address = { channelType: 'feishu', chatId: `chat-real-pty-long-${process.pid}-${Date.now()}` } as const;
      const longPrompt = createLongPrompt();
      let generatedThreadId = '';
      let generatedThreadFilePath = '';

      try {
        assert.ok(longPrompt.length > 8_000, 'test prompt should be several thousand characters');

        await _testOnly.handleMessage(adapter, inboundMessage(address, `/clear real-pty-long ${workDir}`, 'incoming-real-pty-long-new'));
        await _testOnly.handleMessage(adapter, inboundMessage(address, '/provider pty', 'incoming-real-pty-long-provider'));
        const longTurn = _testOnly.handleMessage(adapter, inboundMessage(address, longPrompt, 'incoming-real-pty-long-prompt'));
        await approveTrustPermission(adapter, store, address, { required: false, timeoutMs: 3_000 });
        await longTurn;

        const binding = store.getChannelChat(address.channelType, address.chatId);
        assert.ok(binding);
        generatedThreadId = store.getSession(binding.bridgeSessionId)?.runtime?.codex?.threadId?.trim() || '';
        assert.match(generatedThreadId, /^[0-9a-f-]{20,}$/i);
        generatedThreadFilePath = getCodexSessionByThreadIdSafe(generatedThreadId, 'real pty long prompt cleanup lookup')?.filePath || '';

        const sawCompletePrompt = await waitForCondition(
          () => proxy.requests.some((request) => request.url.includes('/responses') && request.rawBody.includes(longPrompt)),
          30_000,
          500,
        );
        if (!sawCompletePrompt) {
          const screen = capturePtyScreen(binding.bridgeSessionId, 80)?.screen || '';
          assert.fail([
            'real Codex request should contain the complete long prompt in order',
            `responses requests: ${proxy.requests.filter((request) => request.url.includes('/responses')).length}`,
            `pty screen: ${screen.slice(-2000)}`,
          ].join('\n'));
        }
      } finally {
        if (generatedThreadId) {
          cleanupCodexThreadArtifacts(generatedThreadId, generatedThreadFilePath);
        }
      }
    });
  });
});
