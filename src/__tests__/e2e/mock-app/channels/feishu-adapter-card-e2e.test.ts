import '../../../setup/test-setup.js';
import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CodexProvider } from '../../../../runtime/codex/provider.js';
import { FeishuAdapter } from '../../../../channels/feishu/adapter.js';
import { _testOnly, registerAdapter } from '../../../../bridge/host/manager.js';
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

describe('feishu adapter card e2e', () => {
  it('delivers SDK clk-ask forms through real CodexProvider and FeishuAdapter.send', { timeout: 90_000 }, async (t: TestContext) => {
    if (!(await commandAvailable('codex', ['--version']))) {
      t.skip('codex CLI is not available');
      return;
    }

    await withLocalCodexEnvironment(async ({ proxy, workDir }) => {
      const calls: RecordedFeishuMessageCall[] = [];
      const store = initBridgeTestContext({
        dynamicSettings: true,
        settings: makeBridgeSettings({
          bridge_default_model: 'gpt-5',
          bridge_default_mode: 'yolo',
          bridge_channel_instances_json: JSON.stringify([{
            id: 'feishu',
            provider: 'feishu',
            alias: '飞书',
            enabled: true,
            config: {
              appId: 'app-id',
              appSecret: 'app-secret',
              streamingEnabled: false,
              feedbackMarkdownEnabled: true,
            },
          }]),
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
      dynamicSettings: true,
      settings: makeBridgeSettings({
        bridge_channel_instances_json: JSON.stringify([{
          id: 'feishu',
          provider: 'feishu',
          alias: '飞书',
          enabled: true,
          config: {
            appId: 'app-id',
            appSecret: 'app-secret',
            streamingEnabled: false,
            feedbackMarkdownEnabled: true,
          },
        }]),
      }),
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
