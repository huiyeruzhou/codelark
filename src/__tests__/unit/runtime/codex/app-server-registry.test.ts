import '../../../setup/test-setup.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { WebSocketServer } from 'ws';
import { prepareCodexAppServerSession, getCodexAppServerSession, closeCodexAppServerSessions, releaseCodexAppServerSession } from '../../../../runtime/codex/app-server-registry.js';
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
  wss.on('connection', (socket) => socket.on('message', (data) => {
    const m = JSON.parse(String(data)); received.push(m);
    const response = (result: unknown) => socket.send(JSON.stringify({ id: m.id, result }));
    if (m.method === 'initialize') response({ codexHome: process.env.CODEX_HOME });
    if (m.method === 'thread/loaded/list') response({ data: [...threads.keys()] });
    if (m.method === 'thread/start') { const thread = { id: `thread-${threads.size}`, turns: [] }; threads.set(thread.id, thread); if (holdThreadStart) releaseStart = () => response({ thread }); else response({ thread }); }
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
    closeCodexAppServerSessions(); delete process.env.CODELARK_CODEX_APP_SERVER_URL;
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });
  return { endpoint, received, holdStart: () => { holdThreadStart = true; }, releaseStart: () => releaseStart?.(), loseReply: () => { loseReplyAfterCompletion = true; }, finish: (status = 'completed') => { finishImmediately = true; terminalStatus = status; }, disconnect: () => { disconnectOnStart = true; } };
}
async function collect(stream: ReadableStream<string>) {
  const chunks: string[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks.map((chunk) => JSON.parse(chunk.replace(/^data: /, '').trim()));
}

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

test('unchanged Linux legacy installation uses the existing provider', { skip: process.platform !== 'linux' }, async () => {
  let called = 0;
  const legacy: LLMProvider = { streamChat() { called++; return new ReadableStream({ start(controller) { controller.enqueue('data: {"type":"done","data":"legacy"}\n'); controller.close(); } }); } };
  const events = await collect(streamCodexAppServer({ sessionId: 'legacy-no-endpoint', prompt: 'hello' }, legacy));
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
