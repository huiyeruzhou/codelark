import '../../../setup/test-setup.js';
import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CodexProvider } from '../../../../runtime/codex/provider.js';
import {
  FEISHU_GROUP_AUTHORIZED_CALLBACK_DATA,
  FeishuAdapter,
} from '../../../../channels/feishu/adapter.js';
import { _testOnly, registerAdapter } from '../../../../bridge/host/manager.js';
import { createConfigService } from '../../../../configuration/service.js';
import { PendingPermissions } from '../../../../runtime/permission-gateway.js';
import {
  initBridgeTestContext,
  inboundMessage,
  makeBridgeSettings,
  resetBridgeTestState,
  writeCodexSessionJsonlFixture,
} from '../../../helpers/bridge/test-bridge-utils.js';
import {
  cleanupCodexThreadArtifacts,
  commandAvailable,
  seedCodexApiKeyAuth,
  startLocalResponsesProxy,
  type LocalResponsesProxy,
} from '../../../helpers/runtime/real-codex-e2e-utils.js';

const CODELARK_ASK_FORM_TEXT = [
  '需要确认发布策略。',
  '<clk-ask>{"question":"请选择发布策略","options":["灰度","全量"],"input":{"label":"补充说明","placeholder":"可留空"},"submitText":"提交","allowTextReply":true}</clk-ask>',
].join('\n');

interface RecordedFeishuMessageCall {
  kind: 'create' | 'reply';
  payload: Record<string, any>;
}

function createRecordingFeishuAdapter(calls: RecordedFeishuMessageCall[]): FeishuAdapter {
  const adapter = new FeishuAdapter({
    id: 'feishu',
    provider: 'feishu',
    enabled: true,
    alias: '飞书',
    config: {
      appId: 'app-id',
      appSecret: 'app-secret',
      streamingEnabled: false,
      feedbackMarkdownEnabled: true,
    },
  });
  (adapter as any).running = true;
  (adapter as any).restClient = {
    im: {
      message: {
        create: async (payload: Record<string, any>) => {
          calls.push({ kind: 'create', payload });
          return { data: { message_id: `msg-create-${calls.length}` } };
        },
        reply: async (payload: Record<string, any>) => {
          calls.push({ kind: 'reply', payload });
          return { data: { message_id: `msg-reply-${calls.length}` } };
        },
      },
    },
  };
  return adapter;
}

function findInteractiveFormPayload(calls: RecordedFeishuMessageCall[]): Record<string, any> {
  for (const call of calls) {
    if (call.payload?.data?.msg_type !== 'interactive') continue;
    const content = JSON.parse(call.payload.data.content || '{}');
    const form = content.body?.elements?.find((element: any) => element.tag === 'form');
    if (form) return { call, content, form };
  }
  assert.fail(`expected an interactive CardKit form, got ${JSON.stringify(calls)}`);
}

function findGroupAuthorizationCardPayloads(calls: RecordedFeishuMessageCall[]): Array<Record<string, any>> {
  return calls.flatMap((call) => {
    if (call.payload?.data?.msg_type !== 'interactive') return [];
    const content = JSON.parse(call.payload.data.content || '{}');
    return JSON.stringify(content).includes(FEISHU_GROUP_AUTHORIZED_CALLBACK_DATA)
      ? [{ call, content }]
      : [];
  });
}

function findCardElementsByTag(root: unknown, tag: string): Array<Record<string, any>> {
  if (!root || typeof root !== 'object') return [];
  const value = root as Record<string, any>;
  const matches = value.tag === tag ? [value] : [];
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) {
      for (const item of child) matches.push(...findCardElementsByTag(item, tag));
    } else if (child && typeof child === 'object') {
      matches.push(...findCardElementsByTag(child, tag));
    }
  }
  return matches;
}

function assertCodelarkAskFormPayload(payload: Record<string, any>): void {
  assert.equal(payload.form.name, 'clk_form');
  assert.equal(payload.form.elements.some((element: any) => element.tag === 'select_static' && element.name === 'clk_choice'), true);
  assert.equal(payload.form.elements.some((element: any) => element.tag === 'input' && element.name === 'clk_input'), true);
  const submitColumn = payload.form.elements.find((element: any) => JSON.stringify(element).includes('form_action_type'));
  assert.equal(submitColumn?.columns?.[0]?.elements?.[0]?.form_action_type, 'submit');
  assert.match(JSON.stringify(payload.content), /clk-agent-question:/);
}

async function withLocalCodexEnvironment<T>(fn: (params: {
  proxy: LocalResponsesProxy;
  workDir: string;
}) => Promise<T>): Promise<T> {
  const previousEnv = {
    CODEX_HOME: process.env.CODEX_HOME,
    CODELARK_CODEX_BASE_URL: process.env.CODELARK_CODEX_BASE_URL,
    CODELARK_CODEX_API_KEY: process.env.CODELARK_CODEX_API_KEY,
    CODEX_API_KEY: process.env.CODEX_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    CODELARK_CODEX_SKIP_GIT_REPO_CHECK: process.env.CODELARK_CODEX_SKIP_GIT_REPO_CHECK,
    CODELARK_CODEX_TERMINAL_DRAIN_TIMEOUT_MS: process.env.CODELARK_CODEX_TERMINAL_DRAIN_TIMEOUT_MS,
  };
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-card-codex-home-'));
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-card-work-'));
  const proxy = await startLocalResponsesProxy({ responseText: CODELARK_ASK_FORM_TEXT });
  process.env.CODEX_HOME = codexHome;
  process.env.CODELARK_CODEX_BASE_URL = proxy.baseUrl;
  process.env.CODELARK_CODEX_API_KEY = 'clk-local-proxy-key';
  process.env.CODEX_API_KEY = 'clk-local-proxy-key';
  process.env.OPENAI_API_KEY = 'clk-local-proxy-key';
  process.env.CODELARK_CODEX_SKIP_GIT_REPO_CHECK = 'true';
  process.env.CODELARK_CODEX_TERMINAL_DRAIN_TIMEOUT_MS = '50';
  seedCodexApiKeyAuth(codexHome, 'clk-local-proxy-key');
  resetBridgeTestState({ cleanCodexHome: true });
  _testOnly.resetStateForTests();

  try {
    return await fn({ proxy, workDir });
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    fs.rmSync(codexHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    await proxy.close().catch(() => undefined);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    _testOnly.resetStateForTests();
  }
}

describe('feishu adapter card e2e', () => {
  it('prompts for group message authorization after /new until the callback persists authorization', async () => {
    resetBridgeTestState({ cleanCodexHome: true });
    _testOnly.resetStateForTests();
    const calls: RecordedFeishuMessageCall[] = [];
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const createdGroups: Array<{ chatId: string; name: string }> = [];
    const store = initBridgeTestContext({
      settings: makeBridgeSettings(),
    });
    const adapter = createRecordingFeishuAdapter(calls);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      fetchCalls.push({ url, init });
      if (url.includes('/tenant_access_token/internal')) {
        return Response.json({ code: 0, tenant_access_token: 'tenant-token', expire: 7200 });
      }
      if (url.includes('/open-apis/im/v1/images')) {
        return Response.json({ code: 0, data: { image_key: 'group-auth-image-key' } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;
    (adapter as any).createGroupChat = async (options: { name: string }) => {
      const group = {
        chatId: `chat-auth-group-${createdGroups.length + 1}`,
        chatKind: 'group' as const,
        name: `[TestBot]${options.name}`,
      };
      createdGroups.push(group);
      return group;
    };
    registerAdapter(adapter);
    (globalThis as unknown as Record<string, any>).__bridge_manager__.running = true;
    const sourceAddress = { channelType: 'feishu', chatId: 'chat-auth-source', userId: 'ou-auth-user' } as const;
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-group-auth-work-'));

    try {
      await _testOnly.handleMessage(adapter, inboundMessage(sourceAddress, `/new auth-one ${workDir}`, 'incoming-auth-new-1'));
      await _testOnly.handleMessage(adapter, inboundMessage(sourceAddress, `/new auth-two ${workDir}`, 'incoming-auth-new-2'));

      assert.equal(createdGroups.length, 2);
      const firstPassCards = findGroupAuthorizationCardPayloads(calls);
      assert.equal(firstPassCards.length, 2);
      assert.match(JSON.stringify(firstPassCards[0].content), /群聊消息权限确认/);
      assert.match(JSON.stringify(firstPassCards[0].content), /im:message\.group_msg/);
      assert.match(JSON.stringify(firstPassCards[0].content), /https:\/\/open\.feishu\.cn\/app\/app-id\/auth/);
      assert.match(JSON.stringify(firstPassCards[0].content), /我已授权/);
      const imageElements = findCardElementsByTag(firstPassCards[0].content, 'img');
      assert.equal(imageElements.length, 1);
      assert.equal(imageElements[0].img_key, 'group-auth-image-key');
      assert.equal(imageElements[0].mode, 'fit_horizontal');
      assert.equal(imageElements[0].alt?.content, '飞书群聊消息权限授权参考图');
      const imageUploads = fetchCalls.filter((call) => call.url.includes('/open-apis/im/v1/images'));
      assert.equal(imageUploads.length, 1);
      assert.equal(imageUploads[0].init?.method, 'POST');
      assert.ok(imageUploads[0].init?.body instanceof FormData);
      const form = imageUploads[0].init.body as FormData;
      assert.equal(form.get('image_type'), 'message');
      assert.ok(form.get('image') instanceof File);
      assert.equal((form.get('image') as File).name, 'codelark-group-authorization.png');

      const callbackResult = await (adapter as any).handleCardAction({
        action: { value: { callback_data: FEISHU_GROUP_AUTHORIZED_CALLBACK_DATA } },
        context: {
          open_chat_id: createdGroups[0]!.chatId,
          open_message_id: 'auth-card-message-1',
        },
        operator: { open_id: 'ou-auth-user' },
      });
      assert.equal(callbackResult?.toast?.type, 'success');
      assert.equal((adapter as any).channelConfig.groupAuthorized, true);
      assert.equal(
        createConfigService({ migrate: false }).snapshot().config.channels
          .find((channel) => channel.id === 'feishu')?.config.groupAuthorized,
        true,
      );

      await _testOnly.handleMessage(adapter, inboundMessage(sourceAddress, `/new auth-three ${workDir}`, 'incoming-auth-new-3'));

      assert.equal(createdGroups.length, 3);
      assert.equal(findGroupAuthorizationCardPayloads(calls).length, 2);
      const thirdBinding = store.getChannelChat('feishu', createdGroups[2]!.chatId);
      assert.ok(thirdBinding);
    } finally {
      globalThis.fetch = originalFetch;
      fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      _testOnly.resetStateForTests();
    }
  });

  it('delivers SDK clk-ask forms through real CodexProvider and FeishuAdapter.send', { timeout: 90_000 }, async (t: TestContext) => {
    if (!(await commandAvailable('codex', ['--version']))) {
      t.skip('codex CLI is not available');
      return;
    }

    await withLocalCodexEnvironment(async ({ proxy, workDir }) => {
      const calls: RecordedFeishuMessageCall[] = [];
      const store = initBridgeTestContext({
        settings: makeBridgeSettings({
          bridge_default_model: 'gpt-5',
          bridge_default_provider: 'sdk',
          bridge_default_mode: 'yolo',
        }),
        llm: new CodexProvider(new PendingPermissions()),
      });
      const adapter = createRecordingFeishuAdapter(calls);
      registerAdapter(adapter);
      (globalThis as unknown as Record<string, any>).__bridge_manager__.running = true;
      const address = { channelType: 'feishu', chatId: `chat-sdk-card-${process.pid}-${Date.now()}` } as const;

      await _testOnly.handleMessage(adapter, inboundMessage(address, `/clear sdk-card ${workDir}`, 'incoming-sdk-card-clear'));
      await _testOnly.handleMessage(adapter, inboundMessage(address, '请用 clk-ask 表单确认发布策略', 'incoming-sdk-card-prompt'));

      assert.equal(proxy.requests.some((request) => request.url.includes('/responses')), true);
      const session = store.getSession(store.getChannelChat(address.channelType, address.chatId)!.bridgeSessionId);
      assert.ok(session?.runtime?.codex?.threadId);
      const payload = findInteractiveFormPayload(calls);
      assertCodelarkAskFormPayload(payload);
    });
  });

  it('delivers mirror clk-ask forms through FeishuAdapter.send', async () => {
    resetBridgeTestState({ cleanCodexHome: true });
    _testOnly.resetStateForTests();
    const calls: RecordedFeishuMessageCall[] = [];
    const store = initBridgeTestContext({
      settings: makeBridgeSettings(),
    });
    const adapter = createRecordingFeishuAdapter(calls);
    registerAdapter(adapter);
    (globalThis as unknown as Record<string, any>).__bridge_manager__.running = true;
    const threadId = '019e82c2-d31c-7810-ab30-a9c2629018cf';
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-mirror-card-work-'));
    let sessionPath = '';

    try {
      const session = store.createSession('Mirror Card', 'test-model', undefined, workDir);
      store.updateSessionCodexThreadId(session.id, threadId);
      const address = { channelType: 'feishu', chatId: 'chat-mirror-card-e2e' } as const;
      store.upsertChannelChat({
        channelType: address.channelType,
        chatId: address.chatId,
        chatKind: 'group',
        bridgeSessionId: session.id,
      });
      const fixture = writeCodexSessionJsonlFixture({
        threadId,
        workDir,
        lines: [{
          timestamp: '2026-06-02T00:00:00.000Z',
          type: 'session_meta',
          payload: {
            id: threadId,
            timestamp: '2026-06-02T00:00:00.000Z',
            cwd: workDir,
            originator: 'Codex CLI',
          },
        }],
      });
      sessionPath = fixture.sessionPath;

      await _testOnly.reconcileMirrorSubscriptions();
      fs.appendFileSync(sessionPath, [{
          timestamp: '2026-06-02T00:00:01.000Z',
          type: 'event_msg',
          payload: { type: 'task_started', turn_id: 'turn-card-1' },
        }, {
          timestamp: '2026-06-02T00:00:02.000Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: 'mirror user prompt' },
        }, {
          timestamp: '2026-06-02T00:00:03.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: CODELARK_ASK_FORM_TEXT }],
          },
        }, {
          timestamp: '2026-06-02T00:00:04.000Z',
          type: 'event_msg',
          payload: {
            type: 'task_complete',
            turn_id: 'turn-card-1',
            last_agent_message: CODELARK_ASK_FORM_TEXT,
          },
        }].map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf-8');

      await _testOnly.reconcileMirrorSubscriptions();

      const payload = findInteractiveFormPayload(calls);
      assertCodelarkAskFormPayload(payload);
    } finally {
      cleanupCodexThreadArtifacts(threadId, sessionPath);
      fs.rmSync(workDir, { recursive: true, force: true });
      _testOnly.resetStateForTests();
    }
  });
});
