import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { WebSocketServer, type WebSocket } from 'ws';
import { CodexAppServerClient, type AppServerMessage } from '../../../../runtime/codex/app-server-client.js';

async function server(t: TestContext) {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  t.after(async () => {
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });
  const address = wss.address();
  assert(address && typeof address === 'object');
  const received: AppServerMessage[] = [];
  let socket: WebSocket;
  wss.on('connection', (connection, request) => {
    assert.equal(request.headers['sec-websocket-extensions'], undefined, 'old Codex Unix transport requires no compression negotiation');
    socket = connection;
    connection.on('message', (data) => {
      const message = JSON.parse(String(data));
      received.push(message);
      if (message.method === 'initialize') connection.send(JSON.stringify({ id: message.id, result: { userAgent: 'fixture' } }));
      if (message.method === 'reject') connection.send(JSON.stringify({ id: message.id, error: { code: -32600, message: 'active writer' } }));
      if (message.method === 'echo') connection.send(JSON.stringify({ id: message.id, result: message.params }));
    });
  });
  return { url: `ws://127.0.0.1:${address.port}`, received, socket: () => socket! };
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
