import '../../../setup/test-setup.js';
import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CodexProvider } from '../../../../runtime/codex/provider.js';
import { computeKimiWorkspaceDirName } from '../../../../runtime/kimi/session-index.js';
import {
  FEISHU_GROUP_AUTHORIZED_CALLBACK_DATA,
  FeishuAdapter,
} from '../../../../channels/feishu/adapter.js';
import { _testOnly, registerAdapter } from '../../../../bridge/host/manager.js';
import { createConfigService } from '../../../../configuration/service.js';
import { PendingPermissions } from '../../../../runtime/permission-gateway.js';
import {
  ScriptedToolModelProvider,
  scriptedToolCall,
} from '../../../../testing/scripted-tool-model.js';
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
  kind: 'create' | 'reply' | 'card-create' | 'card-update' | 'element-create' | 'element-content';
  payload: Record<string, any>;
}

function createRecordingFeishuAdapter(
  calls: RecordedFeishuMessageCall[],
  options: { streamingEnabled?: boolean } = {},
): FeishuAdapter {
  const adapter = new FeishuAdapter({
    id: 'feishu',
    provider: 'feishu',
    enabled: true,
    alias: '飞书',
    config: {
      appId: 'app-id',
      appSecret: 'app-secret',
      streamingEnabled: options.streamingEnabled === true,
      feedbackMarkdownEnabled: true,
    },
  });
  (adapter as any).running = true;
  (adapter as any).cardFlushBaseIntervalMs = 1;
  (adapter as any).restClient = {
    cardkit: {
      v1: {
        card: {
          create: async (payload: Record<string, any>) => {
            calls.push({ kind: 'card-create', payload });
            return { data: { card_id: `card-${calls.length}` } };
          },
          settings: async () => ({}),
          update: async (payload: Record<string, any>) => {
            calls.push({ kind: 'card-update', payload });
            return {};
          },
        },
        cardElement: {
          create: async (payload: Record<string, any>) => {
            calls.push({ kind: 'element-create', payload });
            return {};
          },
          content: async (payload: Record<string, any>) => {
            calls.push({ kind: 'element-content', payload });
            return {};
          },
          update: async () => ({}),
        },
      },
    },
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

function recordedStreamingCardMarkdown(calls: RecordedFeishuMessageCall[]): string {
  const markdown: string[] = [];
  for (const call of calls) {
    const raw = call.payload?.data?.card?.data ?? call.payload?.data?.elements;
    if (typeof raw !== 'string') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    markdown.push(...findCardElementsByTag(parsed, 'markdown')
      .map((element) => typeof element.content === 'string' ? element.content : ''));
  }
  return markdown.filter(Boolean).join('\n');
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

function findInteractiveMarkdownPayload(
  calls: RecordedFeishuMessageCall[],
  needle: string,
): { call: RecordedFeishuMessageCall; content: Record<string, any>; markdownText: string } {
  for (const call of calls) {
    if (call.payload?.data?.msg_type !== 'interactive') continue;
    const content = JSON.parse(call.payload.data.content || '{}');
    const markdownElements = findCardElementsByTag(content, 'markdown');
    const markdownText = markdownElements
      .map((element) => typeof element.content === 'string' ? element.content : JSON.stringify(element))
      .join('\n');
    if (markdownText.includes(needle)) return { call, content, markdownText };
  }
  assert.fail(`expected an interactive markdown card containing ${needle}, got ${JSON.stringify(calls)}`);
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
  const submitButton = payload.form.elements.find((element: any) => element.tag === 'button' && element.form_action_type === 'submit');
  assert.equal(submitButton?.form_action_type, 'submit');
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
    resetBridgeTestState({ cleanCodexHome: true });
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    _testOnly.resetStateForTests();
  }
}

function createKimiWireFixture(params: {
  kimiHome: string;
  workDir: string;
  sessionId: string;
}): string {
  const sessionDir = path.join(
    params.kimiHome,
    'sessions',
    computeKimiWorkspaceDirName(params.workDir),
    params.sessionId,
  );
  const agentDir = path.join(sessionDir, 'agents', 'main');
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
    createdAt: '2026-06-03T00:00:00.000Z',
    updatedAt: '2026-06-03T00:00:00.000Z',
    title: 'Kimi Markdown',
  }) + '\n', 'utf-8');
  const wirePath = path.join(agentDir, 'wire.jsonl');
  fs.writeFileSync(wirePath, '', 'utf-8');
  fs.mkdirSync(params.kimiHome, { recursive: true });
  fs.appendFileSync(path.join(params.kimiHome, 'session_index.jsonl'), JSON.stringify({
    sessionId: params.sessionId,
    sessionDir,
    workDir: params.workDir,
  }) + '\n', 'utf-8');
  return wirePath;
}

function appendKimiMarkdownTurn(params: {
  wirePath: string;
  turnId: string;
  userText: string;
  thinkingText: string;
  assistantText: string;
}): void {
  const baseTime = Date.parse('2026-06-03T00:00:01.000Z');
  const lines = [
    {
      type: 'context.append_loop_event',
      time: baseTime,
      event: { type: 'step.begin', turnId: params.turnId, stepUuid: `${params.turnId}-step` },
    },
    {
      type: 'context.append_message',
      time: baseTime + 100,
      message: { role: 'user', content: [{ type: 'text', text: params.userText }] },
    },
    {
      type: 'context.append_loop_event',
      time: baseTime + 200,
      event: {
        type: 'content.part',
        turnId: params.turnId,
        part: { type: 'think', think: params.thinkingText },
      },
    },
    {
      type: 'context.append_loop_event',
      time: baseTime + 300,
      event: {
        type: 'content.part',
        turnId: params.turnId,
        part: { type: 'text', text: params.assistantText },
      },
    },
    {
      type: 'context.append_loop_event',
      time: baseTime + 400,
      event: { type: 'step.end', turnId: params.turnId, stepUuid: `${params.turnId}-step` },
    },
  ];
  fs.appendFileSync(params.wirePath, lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf-8');
}

describe('feishu adapter card e2e', () => {
  it('normalizes card action message ids from Feishu context variants', async () => {
    const calls: RecordedFeishuMessageCall[] = [];
    const adapter = createRecordingFeishuAdapter(calls);
    const inbound: any[] = [];
    (adapter as any).enqueueInboundMessage = (message: any) => {
      inbound.push(message);
    };

    const result = await (adapter as any).handleCardAction({
      action: {
        tag: 'button',
        value: {
          callback_data: 'clk-command::%2Fcurrent',
          chatId: 'chat-current-action',
        },
      },
      context: {
        message_id: 'card-message-from-context',
      },
      operator: { open_id: 'ou-current-user' },
    });

    assert.equal(result?.toast?.type, 'info');
    assert.equal(inbound.length, 1);
    assert.equal(inbound[0].callbackData, 'clk-command::%2Fcurrent');
    assert.equal(inbound[0].callbackMessageId, 'card-message-from-context');
    assert.equal(inbound[0].messageId, 'card-message-from-context');
  });

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
      const firstCardJson = JSON.stringify(firstPassCards[0].content);
      assert.match(firstCardJson, /群聊消息权限确认/);
      assert.match(firstCardJson, /请\*\*复制下方的代码块\*\*并参考图片/);
      assert.doesNotMatch(firstCardJson, /请参考下图/);
      assert.match(firstCardJson, /im:message\.group_msg/);
      assert.match(firstCardJson, /https:\/\/open\.feishu\.cn\/app\/app-id\/auth/);
      assert.match(firstCardJson, /我已授权/);
      assert.ok(
        firstCardJson.indexOf('请**复制下方的代码块**并参考图片') < firstCardJson.indexOf('im:message.group_msg'),
        'copy instruction should appear before the permission JSON block',
      );
      assert.ok(
        firstCardJson.indexOf('im:message.group_msg') < firstCardJson.indexOf('group-auth-image-key'),
        'permission JSON block should appear before the reference image',
      );
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
      createConfigService({ migrate: false, env: {} }).set(
        { kind: 'home' },
        { runtime: { codex: { model: 'gpt-5', provider: 'sdk', yoloMode: 'on' } } },
      );
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

  it('drives shared tool details through the bridge and Feishu card with a scripted model', async () => {
    resetBridgeTestState({ cleanCodexHome: true });
    _testOnly.resetStateForTests();
    createConfigService({ migrate: false, env: {} }).set(
      { kind: 'home' },
      { runtime: { codex: { provider: 'sdk', yoloMode: 'on' } } },
    );
    const calls: RecordedFeishuMessageCall[] = [];
    const patchText = [
      '*** Begin Patch',
      '*** Update File: src/app.ts',
      '@@',
      '-const oldValue = true;',
      '+const newValue = true;',
      '*** End Patch',
    ].join('\n');
    const scriptedModel = new ScriptedToolModelProvider({
      steps: [
        ...scriptedToolCall('read-1', 'Read', { path: 'src/app.ts', line_offset: 1, n_lines: 80 }, 'const oldValue = true;'),
        ...scriptedToolCall('grep-1', 'Grep', { pattern: 'oldValue', path: 'src' }, 'src/app.ts:1:const oldValue = true;'),
        ...scriptedToolCall('patch-1', 'apply_patch', patchText, 'Success. Updated the following files:\nM src/app.ts'),
        ...scriptedToolCall('bash-1', 'exec_command', { cmd: 'npm test' }, 'Script completed\nWall time 0.2 seconds\nOutput:\n73 tests passed'),
        { type: 'text', text: '工具检查完成。' },
        { type: 'result', data: {} },
      ],
    });
    const store = initBridgeTestContext({
      settings: makeBridgeSettings({ bridge_default_provider: 'sdk' }),
      llm: scriptedModel,
    });
    const adapter = createRecordingFeishuAdapter(calls, { streamingEnabled: true });
    registerAdapter(adapter);
    (globalThis as unknown as Record<string, any>).__bridge_manager__.running = true;
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-scripted-tool-card-work-'));
    const address = { channelType: 'feishu', chatId: 'chat-scripted-tool-card-e2e' } as const;

    try {
      await _testOnly.handleMessage(adapter, inboundMessage(address, `/clear scripted-tools ${workDir}`, 'incoming-scripted-clear'));
      await _testOnly.handleMessage(adapter, inboundMessage(address, '检查并修改代码', 'incoming-scripted-prompt'));

      assert.equal(scriptedModel.emittedSteps.length, 10);
      assert.equal(scriptedModel.lastError, null);
      const markdown = recordedStreamingCardMarkdown(calls);
      assert.match(markdown, /读取 `src\/app\.ts`/);
      assert.match(markdown, /搜索 `oldValue`/);
      assert.match(markdown, /修改 `src\/app\.ts`/);
      assert.match(markdown, /```diff\n\*\*\* Begin Patch[\s\S]*\*\*\* End Patch\n```/);
      assert.match(markdown, /运行 `npm test`/);
      assert.doesNotMatch(markdown, /73 tests passed/);
      assert.doesNotMatch(markdown, /Script completed|Wall time|\bSuccess\b|\bCompleted\b|长输出/);

      const finalUpdate = calls.filter((call) => call.kind === 'card-update').at(-1);
      const finalCard = JSON.parse(String(finalUpdate?.payload?.data?.card?.data || '{}'));
      const panels = findCardElementsByTag(finalCard, 'collapsible_panel');
      const toolGroups = panels.filter((panel) => /^stream_tool_\d+$/.test(String(panel.element_id || '')));
      assert.equal(toolGroups.length, 1);
      assert.equal(toolGroups[0]?.header?.title?.content, '工具调用 · 4');
      const toolPanels = panels.filter((panel) => /^st_\d+_t_\d+$/.test(String(panel.element_id || '')));
      assert.equal(toolPanels.length, 4);
      assert.equal(toolPanels.some((panel) => findCardElementsByTag(panel.elements, 'collapsible_panel').length > 0), false);
      assert.ok(store.getChannelChat(address.channelType, address.chatId));
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
      _testOnly.resetStateForTests();
    }
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

  it('renders GPT-5.6 wrapped bash and apply_patch calls in a Feishu mirror card', async () => {
    resetBridgeTestState({ cleanCodexHome: true });
    _testOnly.resetStateForTests();
    const calls: RecordedFeishuMessageCall[] = [];
    const store = initBridgeTestContext({ settings: makeBridgeSettings() });
    const adapter = createRecordingFeishuAdapter(calls, { streamingEnabled: true });
    registerAdapter(adapter);
    (globalThis as unknown as Record<string, any>).__bridge_manager__.running = true;
    const threadId = '019f8f04-848e-7f32-84f2-b6b961ebe63e';
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-gpt56-tool-card-work-'));
    const patchText = [
      '*** Begin Patch',
      '*** Update File: src/app.ts',
      '@@',
      '+const enabled = true;',
      '*** End Patch',
    ].join('\n');
    let sessionPath = '';

    try {
      const session = store.createSession('GPT-5.6 Tool Card', 'gpt-5.6', undefined, workDir);
      store.updateSessionCodexThreadId(session.id, threadId);
      store.upsertChannelChat({
        channelType: 'feishu',
        chatId: 'chat-gpt56-tool-card-e2e',
        chatKind: 'group',
        bridgeSessionId: session.id,
      });
      const fixture = writeCodexSessionJsonlFixture({
        threadId,
        workDir,
        lines: [{
          timestamp: '2026-07-23T00:00:00.000Z',
          type: 'session_meta',
          payload: { id: threadId, cwd: workDir, originator: 'Codex CLI' },
        }],
      });
      sessionPath = fixture.sessionPath;

      await _testOnly.reconcileMirrorSubscriptions();
      fs.appendFileSync(sessionPath, [
        {
          timestamp: '2026-07-23T00:00:01.000Z',
          type: 'event_msg',
          payload: { type: 'task_started', turn_id: 'turn-gpt56-tools' },
        },
        {
          timestamp: '2026-07-23T00:00:02.000Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: 'run bash and patch' },
        },
        {
          timestamp: '2026-07-23T00:00:03.000Z',
          type: 'response_item',
          payload: {
            type: 'custom_tool_call',
            name: 'exec',
            call_id: 'call-gpt56-tools',
            input: [
              `const patch = ${JSON.stringify(patchText)};`,
              'const results = await Promise.all([',
              '  tools.exec_command({ cmd: "npm test", workdir: "/tmp/project" }),',
              '  tools.apply_patch(patch),',
              ']);',
              'text(results.length);',
            ].join('\n'),
          },
        },
        {
          timestamp: '2026-07-23T00:00:04.000Z',
          type: 'event_msg',
          payload: {
            type: 'patch_apply_end',
            call_id: 'exec-generated-patch-call',
            turn_id: 'turn-gpt56-tools',
            stdout: 'Success. Updated the following files:\nA src/app.ts\n',
            success: true,
            status: 'completed',
            changes: { 'src/app.ts': { type: 'add', content: 'const enabled = true;\n' } },
          },
        },
        {
          timestamp: '2026-07-23T00:00:05.000Z',
          type: 'response_item',
          payload: {
            type: 'custom_tool_call_output',
            call_id: 'call-gpt56-tools',
            output: [
              { type: 'input_text', text: 'Script completed\nWall time 0.2 seconds\nOutput:\n' },
              { type: 'input_text', text: '2' },
            ],
          },
        },
        {
          timestamp: '2026-07-23T00:00:06.000Z',
          type: 'event_msg',
          payload: {
            type: 'task_complete',
            turn_id: 'turn-gpt56-tools',
            last_agent_message: 'tools rendered',
          },
        },
      ].map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf-8');

      await _testOnly.reconcileMirrorSubscriptions();

      await new Promise((resolve) => setTimeout(resolve, 50));
      const cardMarkdown = recordedStreamingCardMarkdown(calls);
      assert.match(cardMarkdown, /编排 2 个工具/);
      assert.match(cardMarkdown, /exec_command/);
      assert.match(cardMarkdown, /```bash\nnpm test\n```/);
      assert.match(cardMarkdown, /apply_patch/);
      assert.match(cardMarkdown, /```diff\n\*\*\* Begin Patch/);
      assert.doesNotMatch(cardMarkdown, /暂无详情/);
      assert.doesNotMatch(cardMarkdown, /const r = await tools\.exec_command/);
      assert.doesNotMatch(cardMarkdown, /Script completed|Wall time|\bSuccess\b|\bCompleted\b|\bcompleted\b/);
    } finally {
      cleanupCodexThreadArtifacts(threadId, sessionPath);
      fs.rmSync(workDir, { recursive: true, force: true });
      _testOnly.resetStateForTests();
    }
  });

  it('renders Kimi mirror markdown tables and fenced code through FeishuAdapter.send', async () => {
    const previousKimiHome = process.env.KIMI_CODE_HOME;
    const kimiHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-card-kimi-home-'));
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-card-kimi-work-'));
    process.env.KIMI_CODE_HOME = kimiHome;
    resetBridgeTestState({ cleanKimiHome: true });
    _testOnly.resetStateForTests();

    const calls: RecordedFeishuMessageCall[] = [];
    const store = initBridgeTestContext({
      settings: makeBridgeSettings(),
    });
    const adapter = createRecordingFeishuAdapter(calls);
    registerAdapter(adapter);
    (globalThis as unknown as Record<string, any>).__bridge_manager__.running = true;
    const sessionId = `session_kimi_markdown_${process.pid}`;
    const address = { channelType: 'feishu', chatId: 'chat-kimi-markdown-card-e2e' } as const;

    try {
      const wirePath = createKimiWireFixture({ kimiHome, workDir, sessionId });
      const session = store.createSession('Kimi Markdown', 'test-model', undefined, workDir);
      store.updateSession(session.id, {
        runtime: {
          activeRuntime: 'kimi',
          kimi: { sessionId, cwd: workDir, provider: 'tmux' },
        },
      });
      store.upsertChannelChat({
        channelType: address.channelType,
        chatId: address.chatId,
        chatKind: 'group',
        bridgeSessionId: session.id,
        runtimeBridgeSessionIds: { kimi: session.id },
      });

      await _testOnly.reconcileMirrorSubscriptions();
      appendKimiMarkdownTurn({
        wirePath,
        turnId: 'turn-kimi-markdown',
        userText: '请用 Markdown 表格和 TypeScript 代码块回答。',
        thinkingText: 'Kimi markdown thinking should remain status-only.',
        assistantText: [
          'Kimi markdown rendering result.',
          '',
          '| 项目 | 状态 |',
          '| --- | --- |',
          '| 表格 | 通过 |',
          '',
          '```ts',
          'const kimi = "markdown";',
          '```',
        ].join('\n'),
      });

      await _testOnly.reconcileMirrorSubscriptions();

      const payload = findInteractiveMarkdownPayload(calls, 'Kimi markdown rendering result.');
      assert.equal(payload.call.kind, 'create');
      assert.match(payload.markdownText, /\| 表格 \| 通过 \|/);
      assert.match(payload.markdownText, /```ts\nconst kimi = "markdown";\n```/);
      assert.doesNotMatch(payload.markdownText, /Kimi markdown thinking should remain status-only/);
      assert.doesNotMatch(JSON.stringify(payload.content), /当前思考/);
    } finally {
      resetBridgeTestState({ cleanKimiHome: true });
      _testOnly.resetStateForTests();
      fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      fs.rmSync(kimiHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      if (previousKimiHome === undefined) delete process.env.KIMI_CODE_HOME;
      else process.env.KIMI_CODE_HOME = previousKimiHome;
    }
  });

  it('renders Kimi mirror markdown and extracts clk-ask as a separate question form', async () => {
    const previousKimiHome = process.env.KIMI_CODE_HOME;
    const kimiHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-card-kimi-combined-home-'));
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-card-kimi-combined-work-'));
    process.env.KIMI_CODE_HOME = kimiHome;
    resetBridgeTestState({ cleanKimiHome: true });
    _testOnly.resetStateForTests();

    const calls: RecordedFeishuMessageCall[] = [];
    const store = initBridgeTestContext({
      settings: makeBridgeSettings(),
    });
    const adapter = createRecordingFeishuAdapter(calls);
    registerAdapter(adapter);
    (globalThis as unknown as Record<string, any>).__bridge_manager__.running = true;
    const sessionId = `session_kimi_markdown_ask_${process.pid}`;
    const address = { channelType: 'feishu', chatId: 'chat-kimi-markdown-ask-card-e2e' } as const;

    try {
      const wirePath = createKimiWireFixture({ kimiHome, workDir, sessionId });
      const session = store.createSession('Kimi Markdown Ask', 'test-model', undefined, workDir);
      store.updateSession(session.id, {
        runtime: {
          activeRuntime: 'kimi',
          kimi: { sessionId, cwd: workDir, provider: 'tmux' },
        },
      });
      store.upsertChannelChat({
        channelType: address.channelType,
        chatId: address.chatId,
        chatKind: 'group',
        bridgeSessionId: session.id,
        runtimeBridgeSessionIds: { kimi: session.id },
      });

      await _testOnly.reconcileMirrorSubscriptions();
      appendKimiMarkdownTurn({
        wirePath,
        turnId: 'turn-kimi-markdown-ask',
        userText: '请用 Markdown 总结并让用户确认。',
        thinkingText: 'Kimi combined card thinking should remain status-only.',
        assistantText: [
          'Kimi combined markdown and question result.',
          '',
          '| 项目 | 状态 |',
          '| --- | --- |',
          '| 表格 | 通过 |',
          '',
          '```ts',
          'const kimiAsk = "separate-form";',
          '```',
          '',
          '<clk-ask>{"question":"请选择 Kimi 发布策略","options":["灰度","全量"],"input":{"label":"补充说明","placeholder":"可留空"},"submitText":"确认提交","allowTextReply":true}</clk-ask>',
        ].join('\n'),
      });

      await _testOnly.reconcileMirrorSubscriptions();

      const markdownPayload = findInteractiveMarkdownPayload(calls, 'Kimi combined markdown and question result.');
      assert.equal(markdownPayload.call.kind, 'create');
      assert.match(markdownPayload.markdownText, /\| 表格 \| 通过 \|/);
      assert.match(markdownPayload.markdownText, /```ts\nconst kimiAsk = "separate-form";\n```/);
      assert.doesNotMatch(markdownPayload.markdownText, /<clk-ask>|请选择 Kimi 发布策略/);
      assert.doesNotMatch(markdownPayload.markdownText, /Kimi combined card thinking should remain status-only/);
      assert.doesNotMatch(JSON.stringify(markdownPayload.content), /当前思考/);

      const formPayload = findInteractiveFormPayload(calls);
      assertCodelarkAskFormPayload(formPayload);
      assert.match(JSON.stringify(formPayload.content), /请选择 Kimi 发布策略/);
      assert.match(JSON.stringify(formPayload.content), /确认提交/);
    } finally {
      resetBridgeTestState({ cleanKimiHome: true });
      _testOnly.resetStateForTests();
      fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      fs.rmSync(kimiHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      if (previousKimiHome === undefined) delete process.env.KIMI_CODE_HOME;
      else process.env.KIMI_CODE_HOME = previousKimiHome;
    }
  });
});
