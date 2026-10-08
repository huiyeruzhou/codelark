import '../../../setup/test-setup.js';
import { beforeEach, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initBridgeTestContext, resetBridgeTestState, RecordingAdapter, inboundMessage } from '../../../helpers/bridge/test-bridge-utils.js';
import { handleBridgeCommand } from '../../../../bridge/command/index.js';
import { createConfigService } from '../../../../configuration/service.js';
import { parseCommandCallbackData } from '../../../../bridge/command/callbacks.js';
import { _testOnlyWaitForDeliveryQueuesForTests } from '../../../../channels/delivery/deliver.js';
import { CodexAppServerLifecycle, type AppServerThreadState } from '../../../../runtime/codex/app-server-lifecycle.js';
import { closeCodexAppServerSessions, getCodexAppServerSession, prepareCodexAppServerSession } from '../../../../runtime/codex/app-server-registry.js';
import { readCodexBackendStatus } from '../../../../bridge/session/display/codex-backend-status.js';
import { codexTmuxSessionName } from '../../../../bridge/tmux/runtime.js';
import { buildGlobalStatusResponse } from '../../../../bridge/command/status.js';
import { buildRichCardContent } from '../../../../channels/feishu/markdown.js';
import type { BridgeSession, OutboundRichCard } from '../../../../domain/index.js';

beforeEach(() => resetBridgeTestState());

function fixture(t: TestContext, runtime?: BridgeSession['runtime']) {
  const store = initBridgeTestContext();
  const session = store.createSession('Backend status', 'gpt-5.4', '', os.tmpdir());
  store.updateSession(session.id, { runtime, runtime_status: 'running', health_status: 'running_active' });
  const address = { channelType: 'feishu', chatId: `status-${session.id}` };
  store.upsertChannelChat({ ...address, bridgeSessionId: session.id });
  const adapter = new RecordingAdapter();
  const current = () => store.getSession(session.id)!;
  const service = createConfigService({ migrate: false, env: {} });
  const command = async (text: string) => {
    const beforeRuntime = structuredClone(current().runtime);
    const beforeConfig = service.snapshot({ kind: 'session', sessionId: session.id }).config;
    await handleBridgeCommand(adapter, inboundMessage(address, text, `status-${adapter.sent.length}`), text, {
      getActiveTask: () => undefined,
      diagnoseSessionHealth: async () => assert.fail('display must not probe health'),
      diagnoseAllActiveSessions: async () => assert.fail('display must not probe health'),
    });
    await _testOnlyWaitForDeliveryQueuesForTests(adapter);
    assert.equal(store.getChannelChat(address.channelType, address.chatId)?.bridgeSessionId, session.id);
    assert.deepEqual(current().runtime, beforeRuntime, 'status commands must not change runtime identity or configuration');
    assert.deepEqual(service.snapshot({ kind: 'session', sessionId: session.id }).config, beforeConfig);
    return adapter.sent.at(-1)!;
  };
  t.after(() => closeCodexAppServerSessions());
  return { store, session, current, command };
}

function backendFields(card: OutboundRichCard | undefined) {
  return card?.sections.flatMap((section) => section.fields || [])
    .filter(([label]) => ['当前后端', '连接状态', '执行状态', '终端用途'].includes(label));
}

// Traverse the actual Feishu payload, excluding folded panels: a DTO field is
// insufficient evidence because the renderer limits each section to 3 fields.
function visibleMarkdown(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(visibleMarkdown);
  if (!value || typeof value !== 'object') return [];
  const node = value as Record<string, unknown>;
  if (node.tag === 'collapsible_panel') return [];
  return node.tag === 'markdown' && typeof node.content === 'string'
    ? [node.content] : Object.values(node).flatMap(visibleMarkdown);
}

async function assertCommandsAgree(f: ReturnType<typeof fixture>) {
  const status = readCodexBackendStatus(f.current());
  const expected = status.backend === 'app-server'
    ? [['当前后端', status.backendLabel], ['连接状态', status.connectionLabel],
      ['执行状态', status.activityLabel], ['终端用途', status.terminalLabel]]
    : [['当前后端', status.backendLabel], ['终端用途', status.terminalLabel]];
  for (const text of ['/', '/current runtime kimi', '/current-runtime codex', '/current-runtime kimi', '/current-runtime common', '/p', '/status']) {
    const response = await f.command(text);
    // /current-runtime has a short acknowledgement; its diagnostics live in the card.
    if (!text.startsWith('/current-runtime')) {
      for (const [label, value] of expected) {
        assert(response.text.includes(label!), `${text}: missing ${label}`);
        assert(response.text.includes(value!), `${text}: missing shared label ${value}`);
      }
    }
    if (text === '/' || text.startsWith('/current')) {
      assert.deepEqual(backendFields(response.richCard), expected);
      assert(response.richCard);
      const rendered = JSON.parse(buildRichCardContent(response.richCard, 'status-chat'));
      const visible = visibleMarkdown(rendered.body.elements).join('\n');
      assert.doesNotMatch(visible, /已压缩/, 'current card must not lose status fields during rendering');
      for (const [label, value] of response.richCard.sections.flatMap((s) => s.fields || [])) {
        assert(visible.includes(`**${label}**\n${value}`), `${text}: rendered card hides ${label}`);
      }
      const form = rendered.body.elements.find((element: { tag: string }) => element.tag === 'form');
      assert(form, 'rendered current card must preserve editable configuration');
      const formJson = JSON.stringify(form);
      assert(formJson.includes(response.richCard.form!.submitCallbackData));
      assert(formJson.includes(response.richCard.form!.controlBar!.actions![0]!.callbackData));
      for (const control of [...(response.richCard.form!.selects || []), ...(response.richCard.form!.extraInputs || [])]) {
        const name = control.formName || control.elementId;
        assert(form.elements.some((element: { tag: string; name?: string; disabled?: boolean }) =>
          ['input', 'select_static'].includes(element.tag) && element.name === name && !element.disabled),
        `${text}: rendered card hides configuration control ${name}`);
      }
      if (status.backend === 'app-server') {
        assert.equal(response.richCard?.sections.flatMap((s) => s.fields || []).some(([label]) => label === '运行状态'), false);
      }
      assert.equal(response.richCard?.tags?.[0], 'codex', 'configuration preview must preserve the actual agent');
      if (status.threadId) assert(response.richCard?.subtitle?.includes(status.threadId));
      assert.equal(response.richCard?.form?.selects?.flatMap((s) => s.options).some((o) => o.callbackData === 'app-server'), false);
    }
  }
}

it('shows a new session as unstarted and never prepares a backend just to display its default', async (t) => {
  const f = fixture(t);
  const original = process.env.CODELARK_CODEX_APP_SERVER;
  delete process.env.CODELARK_CODEX_APP_SERVER;
  t.after(() => { if (original === undefined) delete process.env.CODELARK_CODEX_APP_SERVER; else process.env.CODELARK_CODEX_APP_SERVER = original; });
  t.mock.method(CodexAppServerLifecycle.prototype, 'ensureThread', async () => assert.fail('read commands must not prepare threads'));
  assert.equal(readCodexBackendStatus(f.current()).backend, 'unstarted');
  assert.notEqual(readCodexBackendStatus(f.current()).connection, 'ready');
  await assertCommandsAgree(f);
  assert.equal(getCodexAppServerSession(f.session.id), undefined);
  assert.match((await f.command('/p')).text, /尚未启动/);
});

it('does not claim a persisted endpoint is connected, even when legacy health says running', async (t) => {
  const f = fixture(t, { codex: { threadId: 'persisted-thread', appServerEndpoint: 'ws://127.0.0.1:12345', provider: 'tmux' },
    general: { tmuxSessionName: `${codexTmuxSessionName('persisted-thread')}-view` } });
  const status = readCodexBackendStatus(f.current());
  assert.equal(status.backend, 'app-server');
  assert.notEqual(status.connection, 'ready');
  assert.equal(status.activity, 'unknown');
  await assertCommandsAgree(f);
  const details = (await f.command('/p')).text;
  assert.match(details, /查看入口/);
  assert.doesNotMatch(details, /发送.*sdk\|pty\|tmux.*切换/);
});

it('all IM entrypoints follow protocol activity and disconnection without preparing or resuming', async (t) => {
  const f = fixture(t, { codex: { threadId: 'protocol-thread', appServerEndpoint: 'ws://127.0.0.1:12345', provider: 'tmux' },
    general: { tmuxSessionName: `${codexTmuxSessionName('protocol-thread')}-view` } });
  // Only the protocol producer is mocked. Registry, shared projection, command dispatch
  // and rich-card presentation run normally; no socket, Codex process or Feishu account is used.
  const prepare = t.mock.method(CodexAppServerLifecycle.prototype, 'ensureThread', async () => 'protocol-thread');
  let snapshot: AppServerThreadState = { threadId: 'protocol-thread', attached: true, connection: 'ready', activity: 'idle', requests: [] };
  t.mock.method(CodexAppServerLifecycle.prototype, 'snapshot', () => snapshot);
  await prepareCodexAppServerSession({ sessionId: f.session.id, threadId: 'protocol-thread', endpoint: 'ws://127.0.0.1:12345' });
  for (const state of [
    { connection: 'connecting', activity: 'unknown' },
    { connection: 'ready', activity: 'active' },
    { connection: 'ready', activity: 'waiting' },
    { connection: 'ready', activity: 'idle' },
    { connection: 'disconnected', activity: 'unknown' },
  ] as const) {
    snapshot = { ...snapshot, ...state };
    const status = readCodexBackendStatus(f.current());
    assert.equal(status.connection, state.connection);
    assert.equal(status.activity, state.activity);
    assert.equal(status.terminal, 'view');
    await assertCommandsAgree(f);
  }
  assert.equal(prepare.mock.callCount(), 1, 'display must never prepare/resume the registered thread');
});

it('keeps legacy tmux visibly distinct from an app-server view', async (t) => {
  const f = fixture(t, { codex: { threadId: 'legacy-thread', provider: 'tmux' }, general: { tmuxSessionName: codexTmuxSessionName('legacy-thread') } });
  assert.equal(readCodexBackendStatus(f.current()).backend, 'legacy');
  assert.equal(readCodexBackendStatus(f.current()).terminal, 'execution');
  await assertCommandsAgree(f);
  assert.match((await f.command('/p')).text, /当前会话还在使用旧版执行方式；启动或恢复时会按有效配置选择后端/);
  for (const [runtimeStatus, expected] of [['running', '运行中'], ['queued', '排队中（3）'], ['idle', '空闲']] as const) {
    f.store.updateSession(f.session.id, { runtime_status: runtimeStatus, queued_count: 3 });
    for (const command of ['/', '/current-runtime kimi']) {
      const response = await f.command(command);
      const fields = response.richCard?.sections.flatMap((s) => s.fields || []);
      assert(fields?.find(([label]) => label === '运行状态')?.[1]?.includes(expected), 'legacy running/queued/idle must remain visible');
      assert.equal(fields?.some(([label]) => label === '连接状态' || label === '执行状态'), false);
      if (command === '/') assert(response.text.includes(expected));
    }
  }
});

it('shows a connected app-server independently of a tmux terminal or the sdk configuration', async (t) => {
  const f = fixture(t, { codex: { threadId: 'direct-thread', appServerEndpoint: 'ws://127.0.0.1:12345', provider: 'sdk' } });
  t.mock.method(CodexAppServerLifecycle.prototype, 'ensureThread', async () => 'direct-thread');
  t.mock.method(CodexAppServerLifecycle.prototype, 'snapshot', () => ({
    threadId: 'direct-thread', attached: true, connection: 'ready', activity: 'idle', requests: [],
  } as AppServerThreadState));
  await prepareCodexAppServerSession({ sessionId: f.session.id, threadId: 'direct-thread', endpoint: 'ws://127.0.0.1:12345' });
  const status = readCodexBackendStatus(f.current());
  assert.equal(status.backend, 'app-server');
  assert.equal(status.connection, 'ready');
  assert.equal(status.activity, 'idle');
  assert.equal(status.terminal, 'none');
  await assertCommandsAgree(f);
});

it('keeps the active Kimi identity when previewing Codex configuration', async (t) => {
  const f = fixture(t, { activeRuntime: 'kimi', kimi: { sessionId: 'actual-kimi-session' } });
  const response = await f.command('/current-runtime codex');
  assert.equal(response.richCard?.tags?.[0], 'kimi');
  assert.match(response.richCard?.subtitle || '', /actual-kimi-session/);
  assert.deepEqual(backendFields(response.richCard), []);
  assert.equal(parseCommandCallbackData(response.richCard?.form?.submitCallbackData || '')?.commandText, '/current-config codex');
  assert.equal(parseCommandCallbackData(response.richCard?.form?.controlBar?.actions?.[0]?.callbackData || '')?.commandText, '/current runtime codex');
  assert.doesNotMatch((await f.command('/status')).text, /当前后端/);
});

it('links to the independent app-server panel only when a UI address is recorded', async (t) => {
  const f = fixture(t);
  const statusFile = path.join(process.env.CODELARK_HOME!, 'runtime', 'ui-server.json');
  const previous = fs.existsSync(statusFile) ? fs.readFileSync(statusFile) : undefined;
  fs.mkdirSync(path.dirname(statusFile), { recursive: true });
  t.after(() => { if (previous) fs.writeFileSync(statusFile, previous); else fs.rmSync(statusFile, { force: true }); });
  fs.rmSync(statusFile, { force: true });
  assert.doesNotMatch((await f.command('/status')).text, /#app-server|app-server 面板/);
  fs.writeFileSync(statusFile, JSON.stringify({ running: false, port: 14781 }));
  assert.match((await f.command('/status')).text, /http:\/\/127\.0\.0\.1:14781#app-server/);
  const markdown = buildGlobalStatusResponse(f.store, null, true);
  assert(markdown.includes('[打开 app-server 面板](http://127.0.0.1:14781#app-server)'));
  assert.doesNotMatch(markdown, /当前后端/, 'the service panel must also be available without a current session');
});
