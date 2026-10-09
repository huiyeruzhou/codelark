import '../../../setup/test-setup.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { initBridgeTestContext, RecordingAdapter } from '../../../helpers/bridge/test-bridge-utils.js';
import { _testOnly as manager } from '../../../../bridge/host/manager.js';
import { buildCommandCallbackData } from '../../../../bridge/command/callbacks.js';
import { sseEvent } from '../../../../runtime/sse.js';

it('Desktop follow-up bypasses an unfinished observer and Stop button reaches the same native thread', async (t) => {
  manager.resetStateForTests();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-desk-control-'));
  fs.chmodSync(root, 0o700);
  const previous = process.env.CURSOR_DESKTOP_BRIDGE_DIR;
  process.env.CURSOR_DESKTOP_BRIDGE_DIR = root;
  const requests: Record<string, unknown>[] = [];
  const threadId = '11111111-1111-4111-8111-111111111111';
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (body.type === 'listThreads') {
        res.end(JSON.stringify({ threads: [{ id: threadId, title: 'test', source: 'local', status: 'running', lastUpdatedAt: Date.now(), windowId: 1 }] }));
      } else {
        requests.push(body);
        res.end(JSON.stringify({ status: body.type === 'stopThread' ? 'interrupt-requested' : 'steered', threadId, windowId: 1, threadTitle: 'test' }));
      }
    });
  });
  await new Promise<void>(resolve => server.listen(path.join(root, 'bridge.sock'), resolve));
  fs.writeFileSync(path.join(root, 'instance.json'), JSON.stringify({ protocolVersion: 3, pid: process.pid,
    socketPath: path.join(root, 'bridge.sock'), token: 'a'.repeat(64), appName: 'Cursor', appVersion: 'test', userDataDir: root, createdAt: Date.now() }), { mode: 0o600 });
  let controller: ReadableStreamDefaultController<string> | undefined;
  let streams = 0;
  const store = initBridgeTestContext({ llm: { streamChat: () => {
    streams++;
    return new ReadableStream({ start(c) { controller = c; c.enqueue(sseEvent('status', { session_id: threadId })); } });
  } } });
  const session = store.createSession('Desktop control', 'model');
  store.updateSession(session.id, { runtime: { activeRuntime: 'cursor', cursor: { provider: 'tmux', transport: 'desktop', sessionId: threadId } } });
  const address = { channelType: 'feishu', chatId: 'cursor-desktop-control' };
  store.upsertChannelChat({ ...address, bridgeSessionId: session.id });
  const adapter = new RecordingAdapter();
  const msg = (text: string, messageId: string) => ({ address, text, messageId, timestamp: Date.now() });
  let first: Promise<void> | undefined;
  t.after(async () => {
    controller?.enqueue(sseEvent('result', { session_id: threadId, outcome: 'aborted' }));
    controller?.close();
    await first;
    await new Promise<void>(resolve => server.close(() => resolve()));
    manager.resetStateForTests();
    if (previous === undefined) delete process.env.CURSOR_DESKTOP_BRIDGE_DIR;
    else process.env.CURSOR_DESKTOP_BRIDGE_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  first = manager.handleMessage(adapter, msg('start', 'first'));
  for (let i = 0; !controller && i < 200; i++) await delay(5);
  assert.ok(controller, 'first turn must have an active observer');
  const followup = msg('change direction', 'followup');
  assert.equal(manager.shouldBypassSessionLock(followup), true);
  await manager.handleMessage(adapter, followup);
  assert.equal(streams, 1, 'follow-up must not open a second stream');
  assert.deepEqual(requests, [{ type: 'sendMessage', threadId, text: 'change direction', delivery: 'steer' }]);
  await manager.handleMessage(adapter, { ...msg('', 'stop-button'), callbackData: buildCommandCallbackData('/stop', session.id), callbackMessageId: 'card' });
  assert.deepEqual(requests[1], { type: 'stopThread', threadId });
  assert.ok(adapter.sent.some(message => /已向 Cursor Desktop 请求中断/.test(message.text)));
  assert.equal(manager.shouldBypassSessionLock(followup), true, 'Stop acknowledgement must not prematurely remove the observer');
});
