import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer, type WebSocket } from 'ws';
import { CodexAppServerLifecycle, type AppServerSubmission } from '../../../../runtime/codex/app-server-lifecycle.js';
import { AppServerRpcError, CodexAppServerClient, isCodexActiveWriterError, isUnsupportedAppServerMethod } from '../../../../runtime/codex/app-server-client.js';
import type { AppServerThread, AppServerTurn } from '../../../../runtime/codex/app-server-events.js';

async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) { if (check()) return; await delay(5); }
  assert(check(), 'condition not reached');
}
async function fixture(t: TestContext) {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  const address = wss.address(); assert(address && typeof address === 'object');
  let socket: WebSocket;
  const received: any[] = [];
  const thread: AppServerThread = { id: 'thread', turns: [] }; // old response with no status enhancement
  let handler: ((m: any, s: WebSocket) => boolean) | undefined;
  const send = (method: string, params: any) => socket.send(JSON.stringify({ method, params: { threadId: thread.id, ...params } }));
  const respond = (m: any, result: any) => socket.send(JSON.stringify({ id: m.id, result }));
  wss.on('connection', (s) => {
    socket = s;
    s.on('message', (data) => {
      const m = JSON.parse(String(data)); received.push(m);
      if (handler?.(m, s)) return;
      if (m.method === 'initialize') respond(m, { codexHome: '/fixture', userAgent: 'old fixture' });
      if (['thread/start', 'thread/resume', 'thread/read'].includes(m.method)) respond(m, { thread });
      if (m.method === 'thread/unsubscribe') respond(m, {});
      if (m.method === 'turn/start') {
        const turn: AppServerTurn = { id: `turn-${thread.turns!.length}`, status: 'inProgress', items: [] };
        thread.turns!.push(turn);
        send('turn/started', { turn });
        const user = { id: 'server-user-id', clientId: m.params.clientUserMessageId, type: 'userMessage', content: m.params.input };
        turn.items!.push(user);
        send('item/completed', { turnId: turn.id, item: user });
        respond(m, { turn });
      }
      if (m.method === 'turn/steer') respond(m, { turnId: m.params.expectedTurnId });
      if (m.method === 'turn/interrupt') respond(m, {});
    });
  });
  let persisted: AppServerSubmission | undefined;
  const runtime = new CodexAppServerLifecycle(`ws://127.0.0.1:${address.port}`, {
    connect: () => CodexAppServerClient.connect(`ws://127.0.0.1:${address.port}`, 200),
    loadSubmission: () => persisted,
    saveSubmission: (_, value) => { persisted = value; },
  });
  t.after(async () => { runtime.close(); for (const client of wss.clients) client.terminate(); await new Promise<void>((resolve) => wss.close(() => resolve())); });
  await runtime.ensureThread();
  return { runtime, thread, received, send, respond, persisted: () => persisted, socket: () => socket, handle: (fn: typeof handler) => { handler = fn; } };
}
const text = [{ type: 'text' as const, text: 'hello' }];

test('connection snapshot is read-only before the first thread and exposes a failed handshake', async () => {
  let calls = 0;
  let rejectConnect!: (error: Error) => void;
  const runtime = new CodexAppServerLifecycle('ws://127.0.0.1:1', {
    connect: () => { calls++; return new Promise((_, reject) => { rejectConnect = reject; }); },
  });
  try {
    assert.deepEqual(runtime.connectionSnapshot(), { connection: 'unknown', updatedAt: undefined });
    assert.equal(calls, 0);
    const pending = runtime.connect();
    assert.equal(runtime.connectionSnapshot().connection, 'connecting');
    assert(runtime.connectionSnapshot().updatedAt);
    const rejection = assert.rejects(pending, /fixture rejected/);
    rejectConnect(new Error('fixture rejected')); await rejection;
    assert.equal(runtime.connectionSnapshot().connection, 'disconnected');
    assert.equal(calls, 1);
    assert.equal(runtime.snapshot('never-started').attached, false);
  } finally { runtime.close(); }
  assert.equal(runtime.connectionSnapshot().connection, 'disconnected');
});

test('old common protocol: start, steer, interrupt acknowledgements and exactly one terminal', async (t) => {
  const f = await fixture(t);
  const first = await f.runtime.submit('thread', text);
  assert.equal(first, 'turn-0');
  assert.equal(f.runtime.snapshot('thread').activity, 'active');
  assert.equal(await f.runtime.submit('thread', text), first);
  assert.equal(f.received.filter((m) => m.method === 'turn/start').length, 1);
  assert.equal(f.received.find((m) => m.method === 'turn/steer').params.expectedTurnId, first);
  assert.equal(await f.runtime.interrupt('thread'), true);
  assert.equal(f.runtime.snapshot('thread').activity, 'active', 'interrupt response cannot finish a turn');
  f.thread.turns![0]!.status = 'interrupted';
  f.send('turn/completed', { turn: f.thread.turns![0] });
  f.send('turn/completed', { turn: f.thread.turns![0] });
  await until(() => f.runtime.snapshot('thread').activity === 'idle');
  assert.equal(f.runtime.recordsAfter('thread').records.filter((r) => r.type === 'task_aborted').length, 1);
});

test('completion before start response never resurrects an active turn or drops old empty-items output', async (t) => {
  const f = await fixture(t);
  f.handle((m) => {
    if (m.method !== 'turn/start') return false;
    const turn: AppServerTurn = { id: 'fast', status: 'inProgress', items: [] };
    f.send('turn/started', { turn });
    f.send('item/completed', { turnId: turn.id, item: { id: 'answer', type: 'agentMessage', text: 'finished' } });
    f.send('turn/completed', { turn: { ...turn, status: 'completed', items: [] } });
    f.respond(m, { turn }); return true;
  });
  assert.equal(await f.runtime.submit('thread', text), 'fast');
  assert.equal(f.runtime.snapshot('thread').activity, 'idle');
  assert(f.runtime.recordsAfter('thread').records.some((r) => r.content === 'finished'));
});

test('paginated Desktop without list_turns can stop an active turn and safely stop again when idle', async (t) => {
  const f = await fixture(t);
  const turnId = await f.runtime.submit('thread', text);
  let active = true;
  f.handle((m, socket) => {
    if (m.method !== 'thread/read') return false;
    if (m.params.includeTurns) socket.send(JSON.stringify({ id: m.id, error: { code: -32601, message: 'list_turns is not supported yet' } }));
    else f.respond(m, { thread: { id: 'thread', status: { type: active ? 'active' : 'idle' } } });
    return true;
  });
  assert.equal(await f.runtime.interrupt('thread'), true);
  assert.equal(f.received.find(m => m.method === 'turn/interrupt').params.turnId, turnId);
  assert.equal(f.runtime.snapshot('thread').activity, 'active');
  active = false;
  f.send('turn/completed', { turn: { id: turnId, status: 'interrupted', items: [] } });
  await until(() => f.runtime.snapshot('thread').activity === 'idle');
  assert.equal(await f.runtime.interrupt('thread'), false);
  assert.equal(f.received.filter(m => m.method === 'turn/interrupt').length, 1);
  assert.equal(f.received.filter(m => m.method === 'thread/read' && m.params.includeTurns === false).length, 2);
});

test('late item and plan events cannot revive a terminal turn', async (t) => {
  const f = await fixture(t);
  const turnId = await f.runtime.submit('thread', text);
  f.send('item/completed', {
    turnId,
    item: { id: 'answer', type: 'agentMessage', text: 'finished' },
  });
  f.send('turn/completed', { turn: { id: turnId, status: 'completed', items: [] } });
  await until(() => f.runtime.snapshot('thread').activity === 'idle');
  const cursor = f.runtime.recordsAfter('thread').cursor;

  f.send('item/started', {
    turnId,
    item: { id: 'late-command', type: 'commandExecution', command: 'npm login' },
  });
  f.send('item/commandExecution/outputDelta', {
    turnId,
    itemId: 'late-command',
    delta: 'Logged in',
  });
  f.send('item/completed', {
    turnId,
    item: { id: 'late-command', type: 'commandExecution', command: 'npm login', aggregatedOutput: 'Logged in', exitCode: 0 },
  });
  f.send('item/agentMessage/delta', { turnId, itemId: 'late-answer', delta: 'ghost reply' });
  f.send('turn/plan/updated', { turnId, explanation: 'ghost plan', plan: [] });
  await delay(20);

  assert.equal(f.runtime.snapshot('thread').activity, 'idle');
  assert.equal(f.runtime.item('thread', turnId, 'late-command'), undefined);
  assert.deepEqual(f.runtime.recordsAfter('thread', cursor).records, []);
});

test('delayed cancellation of an old delivery cannot interrupt a newer Desktop turn', async (t) => {
  const f = await fixture(t);
  const oldTurn = await f.runtime.submit('thread', text);
  f.thread.turns![0]!.status = 'completed';
  f.thread.turns!.push({ id: 'new-desktop-turn', status: 'inProgress', items: [] });
  // The local snapshot is still old; interrupt must refresh before comparing its target.
  assert.equal(f.runtime.snapshot('thread').turnId, oldTurn);
  assert.equal(await f.runtime.interrupt('thread', oldTurn), false);
  assert(!f.received.some((m) => m.method === 'turn/interrupt'));
  assert.equal(f.runtime.snapshot('thread').turnId, 'new-desktop-turn');
  assert.equal(await f.runtime.interrupt('thread', 'new-desktop-turn'), true);
  assert.equal(f.received.find((m) => m.method === 'turn/interrupt').params.turnId, 'new-desktop-turn');
});

test('0.145 concurrent Desktop turn uses clientId to find actual turn, not returned submission ID', async (t) => {
  const f = await fixture(t);
  f.handle((m) => {
    if (m.method !== 'turn/start') return false;
    f.send('turn/started', { turn: { id: 'desktop-turn', status: 'inProgress' } });
    f.send('item/completed', { turnId: 'desktop-turn', item: { id: 'server-item', clientId: m.params.clientUserMessageId, type: 'userMessage', content: m.params.input } });
    f.respond(m, { turn: { id: 'old-submission-id', status: 'inProgress' } }); return true;
  });
  assert.equal(await f.runtime.submit('thread', text), 'desktop-turn');
  assert.equal(f.runtime.snapshot('thread').turnId, 'desktop-turn');
});

test('lost start reply persists uncertainty, reconnects without replay, then correlates accepted input', async (t) => {
  const f = await fixture(t);
  let clientId = '';
  f.handle((m, socket) => {
    if (m.method !== 'turn/start') return false;
    clientId = m.params.clientUserMessageId;
    assert.equal(f.persisted()?.id, clientId, 'journal must precede transport send');
    socket.close(); return true;
  });
  await assert.rejects(f.runtime.submit('thread', text), /disconnected/);
  assert(f.persisted());
  assert.equal(f.runtime.snapshot('thread').activity, 'unknown');
  f.thread.turns = [{ id: 'accepted', status: 'inProgress', items: [{ id: 'server-item', type: 'userMessage', clientId, content: text }] }];
  f.handle(undefined);
  await f.runtime.connect();
  assert.equal(f.persisted(), undefined);
  assert.equal(f.runtime.snapshot('thread').turnId, 'accepted');
  assert.equal(f.received.filter((m) => m.method === 'turn/start').length, 1);
});

test('no correlation evidence keeps unknown submission and prevents fallback/retry even after reconnect', async (t) => {
  const f = await fixture(t);
  f.handle((m, socket) => { if (m.method !== 'turn/start') return false; socket.close(); return true; });
  await assert.rejects(f.runtime.submit('thread', text));
  f.handle(undefined);
  await f.runtime.connect();
  await assert.rejects(f.runtime.submit('thread', text), /提交结果尚未确认/);
  assert.equal(f.received.filter((m) => m.method === 'turn/start').length, 1);
  assert(f.persisted());
});

test('internal RPC error preserves uncertain input', async (t) => {
  const f = await fixture(t);
  f.handle((m, s) => { if (m.method !== 'turn/start') return false; s.send(JSON.stringify({ id: m.id, error: { code: -32603, message: 'internal error after enqueue' } })); return true; });
  await assert.rejects(f.runtime.submit('thread', text));
  assert(f.persisted());
});

test('resolved requests and disconnected callbacks cannot approve a later replay', async (t) => {
  const f = await fixture(t);
  const request = { id: 7, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread', turnId: 'turn-0', command: 'echo test' } };
  f.socket().send(JSON.stringify(request));
  await until(() => f.runtime.snapshot('thread').requests.length === 1);
  const key = f.runtime.snapshot('thread').requests[0]!.key;
  assert(!f.received.some((m) => m.id === 7 && !m.method), 'approval is never automatic');
  f.send('serverRequest/resolved', { requestId: 7 });
  await until(() => f.runtime.snapshot('thread').requests.length === 0);
  assert.equal(f.runtime.reply(key, { decision: 'accept' }), false);
  f.socket().close();
  await until(() => f.runtime.snapshot('thread').connection === 'disconnected');
  await f.runtime.connect();
  f.socket().send(JSON.stringify(request));
  await until(() => f.runtime.snapshot('thread').requests.length === 1);
  assert.notEqual(f.runtime.snapshot('thread').requests[0]!.key, key);
  assert.equal(f.runtime.reply(key, { decision: 'accept' }), false);
  const next = f.runtime.snapshot('thread').requests[0]!.key;
  assert.equal(f.runtime.reply(next, { decision: 'decline' }), true);
  assert.equal(f.runtime.reply(next, { decision: 'accept' }), false);
});

test('initial resume does not redeliver old history; detach never interrupts or kills server', async (t) => {
  const f = await fixture(t);
  f.thread.id = 'resumed';
  f.thread.turns = [{ id: 'old', status: 'completed', items: [{ id: 'old-answer', type: 'agentMessage', text: 'history' }] }];
  await f.runtime.ensureThread({ threadId: 'resumed' });
  assert.deepEqual(f.runtime.recordsAfter('resumed').records, []);
  await f.runtime.detach('resumed');
  assert(!f.received.some((m) => m.method === 'turn/interrupt' || m.method === 'thread/archive'));
});

test('replayed usage of a completed turn cannot create a new output turn on attachment', async (t) => {
  const f = await fixture(t);
  f.thread.id = 'resumed-with-usage';
  f.thread.turns = [{ id: 'old', status: 'completed', items: [] }];
  const usage = { turnId: 'old', tokenUsage: { last: { totalTokens: 12 } } };
  f.handle((message) => {
    if (message.method !== 'thread/resume') return false;
    // Exercise both arrival orders around the response, as WebSocket frames may share a read.
    f.send('thread/tokenUsage/updated', usage);
    f.respond(message, { thread: f.thread });
    f.send('thread/tokenUsage/updated', usage);
    return true;
  });
  await f.runtime.ensureThread({ threadId: f.thread.id });
  await delay(20);
  assert.equal(f.runtime.snapshot(f.thread.id).activity, 'idle');
  assert.deepEqual(f.runtime.recordsAfter(f.thread.id).records, []);

  const turnId = await f.runtime.submit(f.thread.id, text);
  f.send('thread/tokenUsage/updated', { ...usage, turnId });
  await until(() => f.runtime.recordsAfter(f.thread.id).records.some((r) => r.type === 'context_usage'));
  f.send('turn/completed', { turn: { id: turnId, status: 'completed', items: [] } });
  await until(() => f.runtime.snapshot(f.thread.id).activity === 'idle');
  const cursor = f.runtime.recordsAfter(f.thread.id).cursor;
  f.send('thread/tokenUsage/updated', { ...usage, turnId, tokenUsage: { last: { totalTokens: 99 } } });
  await delay(20);
  assert.deepEqual(f.runtime.recordsAfter(f.thread.id, cursor).records, []);
});

test('optional capability classification never treats an active writer or experimental field error as missing method', () => {
  assert(isUnsupportedAppServerMethod(new AppServerRpcError(-32600, 'Invalid request: unknown variant `thread/unsubscribe`, expected one of abc'), 'thread/unsubscribe'));
  assert(!isUnsupportedAppServerMethod(new AppServerRpcError(-32600, 'active writer'), 'thread/unsubscribe'));
  assert(isCodexActiveWriterError(new AppServerRpcError(-32600, 'thread-store conflict: thread busy already has an active writer')));
  assert(isCodexActiveWriterError(new Error('migration stopped', { cause: new AppServerRpcError(-32600, 'active writer') })));
  assert(!isCodexActiveWriterError(new AppServerRpcError(-32600, 'invalid configuration')));
  assert(!isUnsupportedAppServerMethod(new AppServerRpcError(-32600, 'thread/resume.excludeTurns requires experimentalApi capability'), 'thread/resume'));
  assert(!isUnsupportedAppServerMethod(new AppServerRpcError(-32600, 'Invalid request: unknown variant `other`, expected thread/unsubscribe'), 'thread/unsubscribe'));
});

test('a rejected first resume is not retained as a reconnect subscription', async (t) => {
  const f = await fixture(t);
  f.handle((message) => {
    if (message.method !== 'thread/resume' || message.params.threadId !== 'busy') return false;
    f.socket().send(JSON.stringify({
      id: message.id,
      error: { code: -32600, message: 'thread busy already has an active writer' },
    }));
    return true;
  });
  await assert.rejects(f.runtime.ensureThread({ threadId: 'busy' }), /active writer/);
  assert.equal(f.runtime.snapshot('busy').attached, false);
});


test('Bridge restart recovers a tracked turn that completed while disconnected', async (t) => {
  const f = await fixture(t);
  const turnId = await f.runtime.submit('thread', text);
  f.runtime.close();
  f.thread.turns = [
    { id: 'orphaned-old-turn', status: 'inProgress', items: [{ id: 'old-answer', type: 'agentMessage', text: 'must not replay' }] },
    { id: turnId, status: 'completed', items: [{ id: 'recovered-answer', type: 'agentMessage', text: 'finished while Bridge was down' }] },
  ];
  let saved: string | undefined = turnId;
  const recovered = new CodexAppServerLifecycle(f.runtime.endpoint, {
    loadActiveTurn: () => saved, saveActiveTurn: (_, id) => { saved = id; },
  });
  t.after(() => recovered.close());
  await recovered.ensureThread({ threadId: 'thread' });
  assert.equal(saved, undefined);
  assert.equal(recovered.snapshot('thread').activity, 'idle');
  assert(recovered.recordsAfter('thread').records.some((r) => r.content === 'finished while Bridge was down'));
  assert(!recovered.recordsAfter('thread').records.some((r) => r.turnId === 'orphaned-old-turn'));
  assert.equal(recovered.recordsAfter('thread').records.filter((r) => r.type === 'task_complete').length, 1);
});

test('Bridge restart follows only the latest in-progress turn and ignores historical orphans', async (t) => {
  const f = await fixture(t);
  f.runtime.close();
  f.thread.turns = [
    { id: 'orphaned-old-turn', status: 'inProgress', items: [{ id: 'old-answer', type: 'agentMessage', text: 'must not replay' }] },
    { id: 'current-turn', status: 'inProgress', items: [{ id: 'current-answer', type: 'agentMessage', text: 'current progress' }] },
  ];
  let saved: string | undefined = 'orphaned-old-turn';
  const recovered = new CodexAppServerLifecycle(f.runtime.endpoint, {
    loadActiveTurn: () => saved,
    saveActiveTurn: (_, id) => { saved = id; },
  });
  t.after(() => recovered.close());
  await recovered.ensureThread({ threadId: 'thread' });
  assert.equal(recovered.snapshot('thread').turnId, 'current-turn');
  assert.equal(recovered.snapshot('thread').activity, 'active');
  assert(recovered.recordsAfter('thread').records.some((r) => r.content === 'current progress'));
  assert(!recovered.recordsAfter('thread').records.some((r) => r.turnId === 'orphaned-old-turn'));
});

test('definitive validation rejection permits a later corrected input without retrying the original', async (t) => {
  const f = await fixture(t);
  f.handle((m, s) => { if (m.method !== 'turn/start') return false; s.send(JSON.stringify({ id: m.id, error: { code: -32602, message: 'input too large' } })); return true; });
  await assert.rejects(f.runtime.submit('thread', text), /input too large/);
  assert.equal(f.persisted(), undefined);
  f.handle(undefined);
  assert.equal(await f.runtime.submit('thread', [{ type: 'text', text: 'corrected' }]), 'turn-0');
  assert.equal(f.received.filter((m) => m.method === 'turn/start').length, 2);
});


for (const method of ['thread/read', 'thread/resume']) test(`detach rejects a late ${method} reply without reviving the subscription`, async (t) => {
  const f = await fixture(t);
  if (method === 'thread/resume') await f.runtime.detach('thread');
  let request: any;
  f.handle((m) => { if (m.method !== method) return false; request = m; return true; });
  const operation = method === 'thread/read' ? f.runtime.refresh('thread') : f.runtime.ensureThread({ threadId: 'thread' });
  const rejected = assert.rejects(operation, /订阅或连接已结束/);
  await until(() => !!request);
  await f.runtime.detach('thread');
  f.respond(request, { thread: { id: 'thread', turns: [{ id: 'old-turn', status: 'inProgress' }] } });
  await rejected;
  assert.equal(f.runtime.snapshot('thread').attached, false);
  assert.deepEqual(f.runtime.recordsAfter('thread', 5), { records: [], cursor: 5 });
  assert.equal(f.runtime.snapshot('thread').attached, false);
});
