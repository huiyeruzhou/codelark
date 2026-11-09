import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { WebSocketServer, type WebSocket } from 'ws';
import { CodexAppServerClient, appServerWebSocketUrl, appServerCliUrl, type AppServerMessage } from '../../../../runtime/codex/app-server-client.js';

test('Unix URLs use a local Desktop authority and preserve existing CLI/socket identities', () => {
  for (const input of ['unix:///tmp/codex.sock', 'ws+unix:///tmp/codex.sock:/', 'ws+unix://localhost/tmp/codex.sock:/']) {
    const desktop = appServerWebSocketUrl(input);
    assert.equal(new URL(desktop).hostname, 'localhost');
    assert.equal(desktop, 'ws+unix://localhost/tmp/codex.sock:/');
    assert.equal(appServerCliUrl(input), 'unix:///tmp/codex.sock');
  }
  assert.equal(appServerWebSocketUrl('ws://127.0.0.1:9876'), 'ws://127.0.0.1:9876');
  for (const url of ['ws+unix://example.invalid/tmp/c.sock:/', 'ws+unix://user@localhost/tmp/c.sock:/']) {
    assert.throws(() => appServerCliUrl(url), /不是本机地址/);
  }
});

async function server(t: TestContext, options: { respondToInitialize?: boolean } = {}) {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  t.after(async () => {
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });
  const address = wss.address();
  assert(address && typeof address === 'object');
  const received: AppServerMessage[] = [];
  let initialized!: () => void;
  const initialization = new Promise<void>((resolve) => { initialized = resolve; });
  let socket: WebSocket;
  wss.on('connection', (connection, request) => {
    assert.equal(request.headers['sec-websocket-extensions'], undefined, 'old Codex Unix transport requires no compression negotiation');
    socket = connection;
    connection.on('message', (data) => {
      const message = JSON.parse(String(data));
      received.push(message);
      if (message.method === 'initialize') {
        initialized();
        if (options.respondToInitialize !== false) connection.send(JSON.stringify({ id: message.id, result: { userAgent: 'fixture' } }));
      }
      if (message.method === 'reject') connection.send(JSON.stringify({ id: message.id, error: { code: -32600, message: 'active writer' } }));
      if (message.method === 'echo') connection.send(JSON.stringify({ id: message.id, result: message.params }));
    });
  });
  return { url: `ws://127.0.0.1:${address.port}`, received, initialization, socket: () => socket! };
}

test('initializes, correlates concurrent replies, and exposes lifecycle and approval events without answering them', async (t) => {
  const s = await server(t);
  const client = await CodexAppServerClient.connect(s.url);
  t.after(() => client.close());
  assert.deepEqual(await Promise.all([client.request('echo', { a: 1 }), client.request('echo', { b: 2 })]), [{ a: 1 }, { b: 2 }]);
  assert.equal(s.received[0]?.method, 'initialize');
  assert.equal(s.received[1]?.method, 'initialized');
  const status = { method: 'thread/status/changed', params: { threadId: 'thread', status: { type: 'active', activeFlags: [] } } };
  const approval = { id: 700, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread' } };
  const events: AppServerMessage[] = [];
  const done = new Promise<void>((resolve) => client.onMessage((message) => { events.push(message); if (events.length === 2) resolve(); }));
  s.socket().send(JSON.stringify(status));
  s.socket().send(JSON.stringify(approval));
  await done;
  assert.deepEqual(events, [status, approval]);
  assert(!s.received.some((message) => message.id === 700));
});

test('propagates protocol errors, times out stalled requests, and rejects pending work on disconnect', async (t) => {
  const s = await server(t);
  const client = await CodexAppServerClient.connect(s.url, 150);
  t.after(() => client.close());
  await assert.rejects(client.request('reject'), /-32600.*active writer/);
  await assert.rejects(client.request('stall'), /timed out: stall/);
  const pending = client.request('stall');
  s.socket().close();
  await assert.rejects(pending, /disconnected/);
  await assert.rejects(client.request('echo'), /not connected/);
});

test('normal restore requests can outlive connection setup while lost submissions remain bounded and are not resent', async (t) => {
  const s = await server(t);
  const client = await CodexAppServerClient.connect(s.url);
  t.after(() => client.close());
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const received = (method: string) => new Promise<AppServerMessage>((resolve) => {
    const listener = (data: unknown) => {
      const message = JSON.parse(String(data)) as AppServerMessage;
      if (message.method !== method) return;
      s.socket().off('message', listener);
      resolve(message);
    };
    s.socket().on('message', listener);
  });
  const restoreSent = received('thread/resume');
  const restore = client.request('thread/resume', { threadId: 'slow-restore' });
  let settled = false;
  void restore.then(() => { settled = true; }, () => { settled = true; });
  const request = await restoreSent;
  // macOS GUI evidence includes a 13.179 s cold restore after a healthy handshake.
  t.mock.timers.tick(13_500);
  await Promise.resolve();
  assert.equal(settled, false, 'a healthy connection must allow normal thread restoration to finish');
  s.socket().send(JSON.stringify({ id: request.id, result: { thread: { id: 'slow-restore' } } }));
  assert.deepEqual(await restore, { thread: { id: 'slow-restore' } });

  const submissionSent = received('turn/start');
  const submission = client.request('turn/start', { threadId: 'slow-restore' });
  const timedOut = assert.rejects(submission, /timed out: turn\/start/);
  await submissionSent;
  t.mock.timers.tick(30_000);
  await timedOut;
  assert.equal(s.received.filter((message) => message.method === 'turn/start').length, 1);
  assert.deepEqual(await client.request('echo', { stillConnected: true }), { stillConnected: true });
});

test('initialization retains its short setup budget independently of normal requests', async (t) => {
  const s = await server(t, { respondToInitialize: false });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const connection = CodexAppServerClient.connect(s.url, { connectTimeoutMs: 500, requestTimeoutMs: 30_000 });
  const timedOut = assert.rejects(connection, /timed out: initialize/);
  await s.initialization;
  t.mock.timers.tick(500);
  await timedOut;
  assert(!s.received.some((message) => message.method === 'initialized'));
});
