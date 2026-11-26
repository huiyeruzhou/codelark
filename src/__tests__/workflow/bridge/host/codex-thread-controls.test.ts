import '../../../setup/test-setup.js';
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { WebSocketServer } from 'ws';
import { initBridgeTestContext, RecordingAdapter, inboundMessage, resetBridgeTestState } from '../../../helpers/bridge/test-bridge-utils.js';
import { createConfigService } from '../../../../configuration/service.js';
import * as router from '../../../../bridge/session/channel-router.js';
import { _testOnly } from '../../../../bridge/host/manager.js';
import { handleTmuxBridgeCommand } from '../../../../bridge/command/tmux.js';
import { prepareCodexAppServerSession, closeCodexAppServerSessions } from '../../../../runtime/codex/app-server-registry.js';
import { observeAppServerRequests, hasAppServerQuestion } from '../../../../bridge/permission/app-server.js';
import { createSessionHealthRuntime } from '../../../../bridge/health/runtime.js';

test('an endpoint-only new chat stays idle and can stop then attach an unbound running thread', async (t) => {
  resetBridgeTestState();
  const f = await fixture(t);
  const address = { ...f.address, chatId: 'fresh-rebind-chat' };
  const draft = router.createBinding(address, process.cwd(), undefined, { forceNewDraftSession: true });
  f.store.updateSession(draft.bridgeSessionId, {
    runtime: { codex: { appServerEndpoint: f.handle.endpoint } },
    runtime_status: 'unknown', health_status: 'suspected_detached',
  });
  await _testOnly.reconcileTerminalSessionRuntimeState();
  assert.equal(f.store.getSession(draft.bridgeSessionId)?.runtime_status, 'idle');
  const health = createSessionHealthRuntime({ getStore: () => f.store, nowIso: () => new Date().toISOString() });
  health.reconcileSessionHealth();
  assert.equal((await health.diagnoseSessionHealth(draft.bridgeSessionId))?.healthStatus, 'idle');
  const callsBeforeStop = f.calls.length;
  await _testOnly.handleMessage(f.adapter, inboundMessage(address, '/stop'));
  assert.doesNotMatch(f.adapter.sent.at(-1)!.text, /失败|尚未恢复/);
  assert.equal(f.calls.length, callsBeforeStop, 'stopping a draft must not connect, create, resume, or interrupt');
  await f.send('/t unbind');
  await _testOnly.handleMessage(f.adapter, inboundMessage(address, `/t ${f.binding.bridgeSessionId}`));
  assert.equal(f.store.getChannelChat(address.channelType, address.chatId)?.bridgeSessionId, f.binding.bridgeSessionId);
  assert.doesNotMatch(f.adapter.sent.at(-1)!.text, /确认停止|仍在运行/);
  assert.equal(f.store.getSession(f.binding.bridgeSessionId)?.runtime?.codex?.threadId, f.handle.threadId);
  assert.equal(f.calls.some(call => ['turn/interrupt', 'turn/start', 'turn/steer'].includes(call.method)), false);
});

test('/stop on a never-started Codex chat succeeds without waiting for health reconciliation', async (t) => {
  resetBridgeTestState();
  const f = await fixture(t);
  const address = { ...f.address, chatId: 'fresh-stop-chat' };
  const draft = router.createBinding(address, process.cwd(), undefined, { forceNewDraftSession: true });
  f.store.updateSession(draft.bridgeSessionId, { runtime: { codex: { appServerEndpoint: f.handle.endpoint } } });
  const calls = f.calls.length;
  await _testOnly.handleMessage(f.adapter, inboundMessage(address, '/stop'));
  assert.match(f.adapter.sent.at(-1)!.text, /没有|尚未创建/);
  assert.doesNotMatch(f.adapter.sent.at(-1)!.text, /执行失败/);
  assert.equal(f.calls.length, calls);
  assert.equal(f.store.getSession(draft.bridgeSessionId)?.runtime?.codex?.threadId, undefined);
});

test('an existing Codex thread without a protocol connection remains unknown and requires switch confirmation', async (t) => {
  resetBridgeTestState();
  const f = await fixture(t, false);
  const address = { ...f.address, chatId: 'detached-existing-thread' };
  const draft = router.createBinding(address, process.cwd(), undefined, { forceNewDraftSession: true });
  f.store.updateSession(draft.bridgeSessionId, { runtime: { codex: { appServerEndpoint: f.handle.endpoint, threadId: 'detached-thread' } } });
  await _testOnly.reconcileTerminalSessionRuntimeState();
  assert.equal(f.store.getSession(draft.bridgeSessionId)?.runtime_status, 'unknown');
  const health = createSessionHealthRuntime({ getStore: () => f.store, nowIso: () => new Date().toISOString() });
  health.reconcileSessionHealth();
  assert.equal((await health.diagnoseSessionHealth(draft.bridgeSessionId))?.healthStatus, 'suspected_detached');
  await f.send('/t unbind');
  await _testOnly.handleMessage(f.adapter, inboundMessage(address, `/t ${f.binding.bridgeSessionId}`));
  assert.equal(f.store.getChannelChat(address.channelType, address.chatId)?.bridgeSessionId, draft.bridgeSessionId);
  assert.match(f.adapter.sent.at(-1)!.text, /确认停止/);
});

async function fixture(t: TestContext, active = true, chatId?: string) {
  _testOnly.resetStateForTests();
  const store = initBridgeTestContext();
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  const info = wss.address(); assert(info && typeof info === 'object');
  const thread = { id: 'control-thread', turns: active ? [{ id: 'active-turn', status: 'inProgress', items: [] }] : [] };
  const calls: Array<{ method: string; params: any }> = [];
  wss.on('connection', (socket) => socket.on('message', (data) => {
    const message = JSON.parse(String(data));
    calls.push(message);
    if (message.id === undefined) return;
    if (message.method === 'turn/start') {
      const turn = { id: 'unexpected-turn', status: 'inProgress', items: [] };
      thread.turns.push(turn);
      socket.send(JSON.stringify({ method: 'turn/started', params: { threadId: thread.id, turn } }));
    }
    const result = message.method === 'initialize' ? { codexHome: process.env.CODEX_HOME }
      : message.method === 'thread/loaded/list' ? { data: [thread.id] }
        : message.method === 'turn/steer' ? { turnId: 'active-turn' }
          : message.method === 'turn/start' ? { turn: { id: 'unexpected-turn', status: 'inProgress', items: [] } }
            : message.method === 'thread/unsubscribe' ? { status: 'unsubscribed' }
              : { thread };
    socket.send(JSON.stringify({ id: message.id, result }));
  }));
  t.after(async () => {
    _testOnly.resetStateForTests();
    await closeCodexAppServerSessions();
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });
  const address = { channelType: 'feishu', chatId: chatId || `thread-control-${t.name}` };
  const binding = router.createBinding(address, process.cwd());
  const endpoint = `ws://127.0.0.1:${info.port}`;
  const handle = await prepareCodexAppServerSession({ sessionId: binding.bridgeSessionId, threadId: thread.id, endpoint });
  assert(handle); handle.direct = true;
  store.updateSession(binding.bridgeSessionId, { runtime: { codex: { threadId: thread.id, appServerEndpoint: endpoint } } });
  const adapter = new RecordingAdapter();
  return { store, binding, handle, calls, adapter, address, wss,
    send: (text: string) => _testOnly.handleMessage(adapter, inboundMessage(address, text)),
    inputCalls: () => calls.filter((call) => ['turn/start', 'turn/steer'].includes(call.method)),
  };
}

for (const text of ['<C-c>', ' <Ctrl+C> ', '<Cmd+C>']) test(`thread input interrupts instead of submitting ${text}`, async (t) => {
  const f = await fixture(t);
  const msg = inboundMessage(f.address, text);
  await f.send(text);
  assert.deepEqual(f.calls.filter((call) => call.method === 'turn/interrupt').map((call) => call.params),
    [{ threadId: 'control-thread', turnId: 'active-turn' }]);
  assert.deepEqual(f.inputCalls(), []);
  assert.equal(_testOnly.adapterImmediateLane(msg, 'regular')?.laneKind, 'control');
  assert.equal(_testOnly.shouldBypassSessionLock(msg), true, 'the adapter must select the immediate lane before acquiring the conversation lock');
  assert.match(f.adapter.sent.at(-1)!.text, /已请求中断/);
  assert.equal(f.handle.lifecycle.snapshot(f.handle.threadId).activity, 'active', 'RPC acknowledgement is not turn completion');
});

test('Ctrl+C during a pending question interrupts without answering the question', async (t) => {
  const f = await fixture(t);
  observeAppServerRequests(f.binding.bridgeSessionId, f.handle, f.adapter, f.address, f.store);
  for (const socket of f.wss.clients) socket.send(JSON.stringify({ id: 77, method: 'item/tool/requestUserInput', params: {
    threadId: 'control-thread', turnId: 'active-turn', itemId: 'question',
    questions: [{ id: 'choice', question: 'What should happen next?', options: [] }],
  } }));
  const deadline = Date.now() + 1000;
  while (!hasAppServerQuestion(f.binding.bridgeSessionId) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert(hasAppServerQuestion(f.binding.bridgeSessionId));
  await f.send('<C-c>');
  assert.equal(f.calls.filter((call) => call.method === 'turn/interrupt').length, 1);
  assert.deepEqual(f.inputCalls(), []);
  assert.equal(f.calls.some((call) => (call as any).id === 77 && (call as any).result), false);
});

for (const text of ['/tmux <C-c>', '/tmux-key <Ctrl+C>', '/tmux-keys <Cmd+C>']) test(`explicit ${text} uses the control lane`, async (t) => {
  const f = await fixture(t);
  assert.equal(_testOnly.adapterImmediateLane(inboundMessage(f.address, text), 'command')?.laneKind, 'control');
  await f.send(text);
  assert.equal(f.calls.filter((call) => call.method === 'turn/interrupt').length, 1);
  assert.deepEqual(f.inputCalls(), []);
  assert.match(f.adapter.sent.at(-1)!.text, /已请求中断/);
});

test('idle thread Ctrl+C does not create a turn', async (t) => {
  const f = await fixture(t, false);
  await f.send('<C-c>');
  assert.deepEqual(f.inputCalls(), []);
  assert.equal(f.calls.some((call) => call.method === 'turn/interrupt'), false);
  assert.match(f.adapter.sent.at(-1)!.text, /没有正在运行/);
});

test('the first key message in an unbound Codex chat is also a control', async (t) => {
  const f = await fixture(t);
  const previous = process.env.CODELARK_CODEX_APP_SERVER_URL;
  process.env.CODELARK_CODEX_APP_SERVER_URL = f.handle.endpoint;
  t.after(() => { if (previous === undefined) delete process.env.CODELARK_CODEX_APP_SERVER_URL; else process.env.CODELARK_CODEX_APP_SERVER_URL = previous; });
  const msg = inboundMessage({ ...f.address, chatId: 'unbound-controls' }, '<Enter>');
  assert.equal(_testOnly.shouldBypassSessionLock(msg), true);
  await _testOnly.handleMessage(f.adapter, msg);
  assert.deepEqual(f.inputCalls(), []);
  assert.match(f.adapter.sent.at(-1)!.text, /不支持/);
});

for (const text of ['<Enter>', '<Esc>', '<C-d>', '<C-c><Enter>', '<Unknown>']) test(`thread rejects unsupported control ${text}`, async (t) => {
  const f = await fixture(t);
  await f.send(text);
  assert.deepEqual(f.inputCalls(), []);
  assert.equal(f.calls.some((call) => call.method === 'turn/interrupt'), false);
  assert.match(f.adapter.sent.at(-1)!.text, /不支持/);
});

for (const text of ['解释一下 <C-c>', '`<C-c>`', '```\n<C-c>\n```']) test(`thread preserves ordinary text ${text}`, async (t) => {
  const f = await fixture(t);
  await f.send(text);
  assert.equal(f.inputCalls().length, 1);
  assert.deepEqual(f.inputCalls()[0]!.params.input, [{ type: 'text', text }]);
  assert.equal(f.calls.some((call) => call.method === 'turn/interrupt'), false);
});

test('Ctrl+C obeys the same control authorization as /stop', async (t) => {
  const f = await fixture(t);
  const prepared: string[] = [];
  f.adapter.prepareControlAuthorization = async (_address, text) => { prepared.push(text || ''); };
  f.adapter.isControlAuthorized = () => false;
  await f.send('<C-c>');
  assert.deepEqual(f.inputCalls(), []);
  assert.equal(f.calls.some((call) => call.method === 'turn/interrupt'), false);
  assert.deepEqual(prepared, ['/stop']);
  assert.match(f.adapter.sent.at(-1)!.text, /控制白名单/);
});

for (const command of ['/tmux', '/tmux-key']) for (const autoForward of [false, true]) {
  test(`${command} handles protocol controls with autoForward=${autoForward}`, async (t) => {
    const f = await fixture(t);
    const send = (args: string) => handleTmuxBridgeCommand({ command, args, store: f.store, binding: f.binding,
      session: f.store.getSession(f.binding.bridgeSessionId)!, markdown: true, tmuxProviderAutoForward: autoForward });
    assert.match(await send('<C-c>'), /已请求中断/);
    assert.match(await send('<Enter>'), /不支持/);
    if (command === '/tmux-key') assert.match(await send('text<Enter>'), /不支持/);
    assert.equal(f.calls.filter((call) => call.method === 'turn/interrupt').length, 1);
    assert.deepEqual(f.inputCalls(), []);
  });
}

async function monitorFixture(t: TestContext, active: boolean, thread = true) {
  resetBridgeTestState();
  const f = await fixture(t, active, 'oc_monitorthread');
  createConfigService({ migrate: false, env: {} }).set({ kind: 'home' }, { channels: [{
    id: f.address.channelType, provider: 'feishu', alias: 'Monitor', enabled: true,
    config: { threadReplyChats: thread ? [f.address.chatId] : [] },
  }] });
  f.adapter.send = async (message) => {
    f.adapter.sent.push(message);
    return { ok: true, messageId: `om_monitor_title_${f.adapter.sent.length}` };
  };
  return { ...f, monitor: (id: string, outputReplyToMessageId?: string) => _testOnly.handleMessage(f.adapter, {
    ...inboundMessage(f.address, 'check experiment progress', `manual:${id}`),
    raw: { manualIngress: true }, outputReplyToMessageId,
  }) };
}

for (const active of [false, true]) test(`monitor ${active ? 'steer' : 'start'} retains its generated topic in the Codex protocol reply target`, async (t) => {
  const f = await monitorFixture(t, active);
  await f.monitor('monitor-trigger');
  const title = f.adapter.sent.find((message) => message.startNewThread);
  assert(title);
  assert.equal(title.platformMessage?.msgType, 'text');
  assert.equal(title.replyToMessageId, undefined);
  assert.equal(title.richCard, undefined);
  assert.equal(f.inputCalls().length, 1);
  assert.equal(f.inputCalls()[0].method, active ? 'turn/steer' : 'turn/start');
  assert.deepEqual(f.inputCalls()[0].params.input, [{ type: 'text', text: 'check experiment progress' }]);
  // Mirror cards and permission requests both read this native per-turn origin.
  assert.deepEqual(f.handle.lifecycle.replyTarget('control-thread', active ? 'active-turn' : 'unexpected-turn'), {
    channelType: f.address.channelType, chatId: f.address.chatId,
    messageId: 'om_monitor_title_1', rootMessageId: 'om_monitor_title_1',
  });
});

test('consecutive monitor triggers steer the Codex turn into a fresh topic each time', async (t) => {
  const f = await monitorFixture(t, true);
  await f.monitor('first-trigger');
  assert.equal(f.handle.lifecycle.replyTarget('control-thread', 'active-turn')?.messageId, 'om_monitor_title_1');
  await f.monitor('second-trigger');
  assert.equal(f.adapter.sent.filter((message) => message.startNewThread).length, 2);
  assert.equal(f.inputCalls().length, 2);
  assert.equal(f.handle.lifecycle.replyTarget('control-thread', 'active-turn')?.messageId, 'om_monitor_title_2');
});

test('explicit manual continuation targets survive Codex protocol submission without another title', async (t) => {
  const f = await monitorFixture(t, false);
  await f.monitor('continuation', 'om_explicit_continuation_root');
  assert.equal(f.adapter.sent.filter((message) => message.startNewThread).length, 0);
  assert.equal(f.handle.lifecycle.replyTarget('control-thread', 'unexpected-turn')?.messageId, 'om_explicit_continuation_root');
});

test('monitor with thread mode off does not attach its synthetic execution ID as a Codex reply target', async (t) => {
  const f = await monitorFixture(t, false, false);
  await f.monitor('ordinary-monitor');
  assert.equal(f.inputCalls().length, 1);
  assert.equal(f.adapter.sent.filter((message) => message.startNewThread).length, 0);
  assert.equal(f.handle.lifecycle.replyTarget('control-thread', 'unexpected-turn'), undefined);
});
