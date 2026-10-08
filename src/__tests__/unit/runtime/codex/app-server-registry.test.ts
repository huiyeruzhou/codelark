import '../../../setup/test-setup.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { WebSocketServer } from 'ws';
import { prepareCodexAppServerSession, getCodexAppServerSession, closeCodexAppServerSessions, releaseCodexAppServerSession, getCodexAppServerServiceStatuses } from '../../../../runtime/codex/app-server-registry.js';
import { streamCodexAppServer } from '../../../../runtime/codex/app-server-provider.js';
import type { LLMProvider } from '../../../../runtime/contracts.js';

async function fixture(t: TestContext) {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  const a = wss.address(); assert(a && typeof a === 'object');
  const endpoint = `ws://127.0.0.1:${a.port}`;
  const received: any[] = [];
  const threads = new Map<string, any>();
  let finishImmediately = false;
  let terminalStatus = 'completed';
  let disconnectOnStart = false;
  let loseReplyAfterCompletion = false;
  let releaseStart: (() => void) | undefined;
  let holdThreadStart = false;
  let rejectThreadStart = false;
  wss.on('connection', (socket) => socket.on('message', (data) => {
    const m = JSON.parse(String(data)); received.push(m);
    const response = (result: unknown) => socket.send(JSON.stringify({ id: m.id, result }));
    if (m.method === 'initialize') response({ codexHome: process.env.CODEX_HOME });
    if (m.method === 'thread/loaded/list') response({ data: [...threads.keys()] });
    if (m.method === 'thread/start') {
      if (rejectThreadStart) { socket.send(JSON.stringify({ id: m.id, error: { code: -32000, message: 'secret-fixture-auth-text' } })); return; }
      const thread = { id: `thread-${threads.size}`, turns: [] }; threads.set(thread.id, thread); if (holdThreadStart) releaseStart = () => response({ thread }); else response({ thread });
    }
    if (m.method === 'thread/read' || m.method === 'thread/resume') response({ thread: threads.get(m.params.threadId) });
    if (m.method === 'thread/unsubscribe') response({ status: 'unsubscribed' });
    if (m.method === 'turn/start') {
      if (disconnectOnStart) { socket.close(); return; }
      const threadId = m.params.threadId;
      const turn = { id: threads.get(threadId).turns.length ? `actual-turn-${threads.get(threadId).turns.length}` : 'actual-turn', status: 'inProgress', items: [] };
      threads.get(threadId).turns.push(turn);
      const send = (method: string, params: any) => socket.send(JSON.stringify({ method, params: { threadId, ...params } }));
      send('turn/started', { turn });
      send('item/completed', { turnId: turn.id, item: { id: 'user', type: 'userMessage', clientId: m.params.clientUserMessageId, content: m.params.input } });
      if (finishImmediately) {
        send('item/completed', { turnId: turn.id, item: { type: 'agentMessage', id: 'one', text: 'First' } });
        send('item/agentMessage/delta', { turnId: turn.id, itemId: 'two', delta: 'Sec' });
        send('item/agentMessage/delta', { turnId: turn.id, itemId: 'two', delta: 'ond' });
        send('item/completed', { turnId: turn.id, item: { type: 'agentMessage', id: 'two', text: 'Second' } });
        turn.status = terminalStatus;
        send('turn/completed', { turn: { ...turn, items: [] } });
      }
      if (loseReplyAfterCompletion) { socket.close(); return; }
      response({ turn });
    }
  }));
  t.after(async () => {
    await closeCodexAppServerSessions(); delete process.env.CODELARK_CODEX_APP_SERVER_URL;
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });
  return { endpoint, received, rejectStart: () => { rejectThreadStart = true; }, drop: () => { for (const socket of wss.clients) socket.terminate(); }, holdStart: () => { holdThreadStart = true; }, releaseStart: () => releaseStart?.(), loseReply: () => { loseReplyAfterCompletion = true; }, finish: (status = 'completed') => { finishImmediately = true; terminalStatus = status; }, disconnect: () => { disconnectOnStart = true; } };
}

test('service reads do not start the default backend or promote a saved address into process evidence', async () => {
  await closeCodexAppServerSessions();
  assert.deepEqual(getCodexAppServerServiceStatuses().map((s) => [s.state, s.connection, s.sessionIds]), [['not-started', 'unknown', []]]);
  const statuses = getCodexAppServerServiceStatuses([
    { sessionId: 'saved', endpoint: 'ws://127.0.0.1:9000' },
    { sessionId: 'credentials', endpoint: 'ws://user:secret@localhost:9000/?token=secret' },
    { sessionId: 'remote', endpoint: 'ws://example.invalid:9000' },
  ]);
  assert.equal(statuses.length, 3);
  assert(statuses.every((s) => s.state === 'unknown' && s.connection === 'unknown' && s.pid === undefined));
  assert.equal(statuses[0].endpoint, 'ws://127.0.0.1:9000');
  assert.equal(statuses[1].endpoint, undefined); assert.equal(statuses[2].endpoint, undefined);
  assert(!JSON.stringify(statuses).includes('secret'));
});

test('service connection exists before thread creation, is shared, and observes disconnect without claiming an external PID', async (t) => {
  const f = await fixture(t); f.holdStart();
  const preparing = prepareCodexAppServerSession({ sessionId: 'service-before-thread', endpoint: f.endpoint });
  t.after(() => f.releaseStart());
  for (let i = 0; i < 200 && !f.received.some((m) => m.method === 'thread/start'); i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(getCodexAppServerSession('service-before-thread'), undefined);
  const status = () => getCodexAppServerServiceStatuses().find((s) => s.endpoint === f.endpoint)!;
  const count = f.received.length;
  assert.equal(status().connection, 'ready'); assert.equal(status().state, 'unknown');
  assert.equal(status().owner, 'external'); assert.equal(status().pid, undefined);
  assert.deepEqual(status().sessionIds, ['service-before-thread']);
  for (let i = 0; i < 10; i++) getCodexAppServerServiceStatuses();
  assert.equal(f.received.length, count, 'reads must not issue RPCs');
  status().sessionIds.push('mutated-copy');
  assert.deepEqual(status().sessionIds, ['service-before-thread']);
  f.releaseStart(); const first = await preparing; assert(first);
  await prepareCodexAppServerSession({ sessionId: 'service-second', endpoint: f.endpoint, threadId: first.threadId });
  assert.deepEqual(status().sessionIds, ['service-before-thread', 'service-second']);
  f.drop();
  for (let i = 0; i < 100 && status().connection === 'ready'; i++) await new Promise((r) => setTimeout(r, 2));
  assert.equal(status().connection, 'disconnected'); assert.equal(status().state, 'unknown');
  await releaseCodexAppServerSession('service-second');
  assert.deepEqual(status().sessionIds, ['service-before-thread']);
  assert.deepEqual(getCodexAppServerServiceStatuses([{ sessionId: 'service-before-thread', endpoint: 'ws://localhost:9001' }])
    .find((s) => s.endpoint === f.endpoint)?.sessionIds, [], 'old endpoint cannot retain a new binding');
});

test('failed thread preparation remains visible without exposing server error text', async (t) => {
  const f = await fixture(t); f.rejectStart();
  await assert.rejects(prepareCodexAppServerSession({ sessionId: 'service-failed-thread', endpoint: f.endpoint }), /secret-fixture/);
  assert.equal(getCodexAppServerSession('service-failed-thread'), undefined);
  const status = getCodexAppServerServiceStatuses().find((s) => s.endpoint === f.endpoint)!;
  assert.equal(status.connection, 'ready'); assert.equal(status.state, 'unknown');
  assert.match(status.error!, /会话准备失败/); assert(!JSON.stringify(status).includes('secret-fixture'));
  assert.deepEqual(status.sessionIds, ['service-failed-thread']);
});
async function collect(stream: ReadableStream<string>) {
  const chunks: string[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks.map((chunk) => JSON.parse(chunk.replace(/^data: /, '').trim()));
}

test('passive restoration does not allocate an empty thread but restores durable bindings', async (t) => {
  const f = await fixture(t);
  const sessionId = 'registry-passive';
  assert.equal(await prepareCodexAppServerSession({ sessionId, endpoint: f.endpoint, createIfMissing: false }), undefined);
  assert.equal(f.received.length, 0, '仅继承地址的会话不能因后台观察而连接或创建线程');
  const first = await prepareCodexAppServerSession({ sessionId, endpoint: f.endpoint }); assert(first);
  assert.equal('createIfMissing' in f.received.find((m) => m.method === 'thread/start').params, false);
  await closeCodexAppServerSessions();
  const restored = await prepareCodexAppServerSession({ sessionId, createIfMissing: false }); assert(restored);
  assert.equal(restored.threadId, first.threadId, 'store 尚未写回 threadId 时也要恢复 registry 持久绑定');
  assert.equal(f.received.filter((m) => m.method === 'thread/start').length, 1);
});

test('passive observation cannot suppress a concurrent first real input', async (t) => {
  const f = await fixture(t);
  const options = { sessionId: 'registry-passive-concurrent', endpoint: f.endpoint };
  const observation = prepareCodexAppServerSession({ ...options, createIfMissing: false });
  const input = prepareCodexAppServerSession(options);
  const laterObservation = prepareCodexAppServerSession({ ...options, createIfMissing: false });
  assert.equal(await observation, undefined);
  const [active, observing] = await Promise.all([input, laterObservation]);
  assert(active, '第一条输入必须创建线程，不能复用后台观察的空结果');
  assert.equal(observing?.threadId, active.threadId);
  assert.equal(f.received.filter((m) => m.method === 'thread/start').length, 1);
});

test('fixed backend survives a Bridge client restart and session config has only its own instance home', async (t) => {
  const f = await fixture(t);
  const sessionId = 'registry-restart';
  const first = await prepareCodexAppServerSession({ sessionId, endpoint: f.endpoint }); assert(first);
  assert.equal(f.received.find((m) => m.method === 'thread/start').params.config['shell_environment_policy.set.CODELARK_HOME'], process.env.CODELARK_HOME);
  closeCodexAppServerSessions();
  const second = await prepareCodexAppServerSession({ sessionId }); assert(second);
  assert.equal(second.endpoint, first.endpoint); assert.equal(second.threadId, first.threadId);
  assert.equal(f.received.filter((m) => m.method === 'thread/start').length, 1);
  await assert.rejects(prepareCodexAppServerSession({ sessionId: 'other', endpoint: 'ws://example.invalid:1234' }), /不是本机/);
  closeCodexAppServerSessions();
  await assert.rejects(prepareCodexAppServerSession({ sessionId, endpoint: 'ws://localhost:9' }), /绑定另一/);
  // Windows stat.mode does not expose NTFS ACLs; Node reports 0666 for writable files.
  // The restart and instance-isolation assertions above still run on Windows.
  if (process.platform !== 'win32') {
    for (const entry of fs.readdirSync(path.join(process.env.CODELARK_HOME!, 'codex-app-server'))) {
      assert.equal(fs.statSync(path.join(process.env.CODELARK_HOME!, 'codex-app-server', entry)).mode & 0o777, 0o600);
    }
  }
});

test('direct provider submits through protocol without a terminal, preserves all answer items and claims one native turn', async (t) => {
  const f = await fixture(t); f.finish();
  process.env.CODELARK_CODEX_APP_SERVER_URL = f.endpoint;
  const legacy: LLMProvider = { streamChat() { throw new Error('legacy must not run'); } };
  const events = await collect(streamCodexAppServer({ sessionId: 'direct', prompt: 'hello', runtime: 'codex' }, legacy));
  assert(!events.some((e) => e.type === 'error'), JSON.stringify(events));
  assert.equal(events.filter((e) => e.type === 'result').length, 1);
  assert.equal(events.filter((e) => e.type === 'text_snapshot').at(-1).data, 'First\n\nSecond');
  assert.equal(getCodexAppServerSession('direct')?.direct, false);
  assert(getCodexAppServerSession('direct')?.directTurnIds.has('actual-turn'));
  assert.equal(f.received.filter((m) => m.method === 'turn/start').length, 1);
  await releaseCodexAppServerSession('direct');
});

test('a lost submission cannot fall back to SDK, PTY or TUI', async (t) => {
  const f = await fixture(t); f.disconnect();
  process.env.CODELARK_CODEX_APP_SERVER_URL = f.endpoint;
  let legacyCalls = 0;
  const events = await collect(streamCodexAppServer({ sessionId: 'uncertain-provider', prompt: 'hello' }, { streamChat() { legacyCalls++; throw new Error('incorrect fallback'); } }));
  assert.equal(legacyCalls, 0);
  assert(events.some((e) => e.type === 'error'));
  assert(getCodexAppServerSession('uncertain-provider')?.lifecycle.snapshot('thread-0').submission);
});

test('an existing legacy thread keeps its provider after app-server becomes the default', async () => {
  let called = 0;
  const legacy: LLMProvider = { streamChat() { called++; return new ReadableStream({ start(controller) { controller.enqueue('data: {"type":"done","data":"legacy"}\n'); controller.close(); } }); } };
  const events = await collect(streamCodexAppServer({ sessionId: 'legacy-no-endpoint', codexThreadId: 'existing-legacy-thread', prompt: 'hello' }, legacy));
  assert.equal(called, 1); assert.equal(events[0].data, 'legacy');
});

test('rebinding a Bridge session detaches the old thread and preserves other subscribers to the new thread', async (t) => {
  const f = await fixture(t);
  const first = await prepareCodexAppServerSession({ sessionId: 'replace-old', endpoint: f.endpoint }); assert(first);
  const other = await prepareCodexAppServerSession({ sessionId: 'replace-other', endpoint: f.endpoint }); assert(other);
  const replacement = await prepareCodexAppServerSession({ sessionId: 'replace-old', endpoint: f.endpoint, threadId: other.threadId }); assert(replacement);
  assert.equal(first.lifecycle.snapshot(first.threadId).attached, false);
  assert.equal(replacement.threadId, other.threadId);
  const unsubscribes = () => f.received.filter((m) => m.method === 'thread/unsubscribe').length;
  assert.equal(unsubscribes(), 1);
  await releaseCodexAppServerSession('replace-old');
  assert.equal(unsubscribes(), 1, 'another Bridge binding still owns this subscription');
  await releaseCodexAppServerSession('replace-other');
  assert.equal(unsubscribes(), 2);
});


test('completed answer survives lost start reply while mirror already advanced its direct cursor', async (t) => {
  const f = await fixture(t); f.finish(); f.loseReply();
  process.env.CODELARK_CODEX_APP_SERVER_URL = f.endpoint;
  const handle = await prepareCodexAppServerSession({ sessionId: 'lost-completed' }); assert(handle);
  let mirrorCursor = 0;
  const stop = handle.lifecycle.onChange(() => {
    if (handle.direct) mirrorCursor = handle.lifecycle.recordsAfter(handle.threadId, mirrorCursor).cursor;
  });
  t.after(stop);
  const events = await collect(streamCodexAppServer({ sessionId: 'lost-completed', prompt: 'hello' }, { streamChat() { throw new Error('no fallback'); } }));
  assert(!events.some((e) => e.type === 'error'), JSON.stringify(events));
  assert.equal(events.filter((e) => e.type === 'text_snapshot').at(-1).data, 'First\n\nSecond');
  assert.equal(events.filter((e) => e.type === 'result').length, 1);
  assert(mirrorCursor > 0);
  assert(handle.directTurnIds.has('actual-turn'));
  assert.equal(f.received.filter((m) => m.method === 'turn/start').length, 1);
});

test('release cancels an in-flight prepare and does not restore its durable binding', async (t) => {
  const f = await fixture(t); f.holdStart();
  const pending = prepareCodexAppServerSession({ sessionId: 'cancel-prepare', endpoint: f.endpoint });
  const rejected = assert.rejects(pending, /绑定已结束/);
  for (let i = 0; i < 200 && !f.received.some((m) => m.method === 'thread/start'); i++) await new Promise((r) => setTimeout(r, 5));
  assert(f.received.some((m) => m.method === 'thread/start'));
  await releaseCodexAppServerSession('cancel-prepare');
  f.releaseStart(); await rejected;
  assert.equal(getCodexAppServerSession('cancel-prepare'), undefined);
  assert(f.received.some((m) => m.method === 'thread/unsubscribe'));
});

test('cached direct session applies tightened permissions to the next turn', async (t) => {
  const f = await fixture(t); f.finish();
  process.env.CODELARK_CODEX_APP_SERVER_URL = f.endpoint;
  const legacy: LLMProvider = { streamChat() { throw new Error('no fallback'); } };
  await collect(streamCodexAppServer({ sessionId: 'permissions', prompt: 'first', codexMode: 'yolo' }, legacy));
  const events = await collect(streamCodexAppServer({ sessionId: 'permissions', prompt: 'second', sandboxMode: 'read-only', permissionMode: 'default' }, legacy));
  assert(!events.some((e) => e.type === 'error'), JSON.stringify(events));
  const turns = f.received.filter((m) => m.method === 'turn/start');
  assert.equal(turns.length, 2);
  assert.deepEqual(turns[0].params.sandboxPolicy, { type: 'dangerFullAccess' });
  assert.equal(turns[0].params.approvalPolicy, 'never');
  assert.deepEqual(turns[1].params.sandboxPolicy, { type: 'readOnly' });
  assert.equal(turns[1].params.approvalPolicy, 'on-request');
});

test('a native interruption is an explicit result outcome, not an execution error', async (t) => {
  const f = await fixture(t); f.finish('interrupted');
  process.env.CODELARK_CODEX_APP_SERVER_URL = f.endpoint;
  const events = await collect(streamCodexAppServer({ sessionId: 'direct-interrupt', prompt: 'hello' }, { streamChat() { throw new Error('no fallback'); } }));
  assert.equal(events.some((event) => event.type === 'error'), false);
  assert.equal(JSON.parse(events.find((event) => event.type === 'result').data).outcome, 'aborted');
});
