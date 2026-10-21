import '../../../setup/test-setup.js';
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { WebSocketServer } from 'ws';
import { initBridgeTestContext, RecordingAdapter, inboundMessage } from '../../../helpers/bridge/test-bridge-utils.js';
import * as router from '../../../../bridge/session/channel-router.js';
import { _testOnly } from '../../../../bridge/host/manager.js';
import { handleTmuxBridgeCommand } from '../../../../bridge/command/tmux.js';
import { prepareCodexAppServerSession, closeCodexAppServerSessions } from '../../../../runtime/codex/app-server-registry.js';
import { observeAppServerRequests, hasAppServerQuestion } from '../../../../bridge/permission/app-server.js';

async function fixture(t: TestContext, active = true) {
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
  const address = { channelType: 'feishu', chatId: `thread-control-${t.name}` };
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
