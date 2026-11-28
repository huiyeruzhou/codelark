import '../../../setup/test-setup.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { CODELARK_HOME } from '../../../../configuration/paths.js';
import { JsonFileStore } from '../../../../storage/json-store.js';
import { createSessionHealthRuntime } from '../../../../bridge/health/runtime.js';
import { listDiscoveredBridgeSessions } from '../../../../bridge/control/session-catalog.js';
import { consumeSseEvents } from '../../../../runtime/sse-stream-decoder.js';
import { sseEvent } from '../../../../runtime/sse.js';

it('serves session discovery within its 3s budget during 1500 replay updates across a 48-session store', async () => {
  const store = new JsonFileStore(new Map());
  const seed = store.createSession('replay', 'model');
  const sessions = Object.fromEntries(Array.from({ length: 48 }, (_, i) => {
    const id = i === 0 ? seed.id : `fixture-${i}`;
    return [id, { ...seed, id, runtime: { activeRuntime: 'cursor', general: { systemPrompt: 'fixture context '.repeat(120) } } }];
  }));
  fs.writeFileSync(path.join(CODELARK_HOME, 'data/sessions.json'), JSON.stringify(sessions));
  store.upsertChannelChat({ channelType: 'feishu', chatId: 'fixture', bridgeSessionId: seed.id });
  const health = createSessionHealthRuntime({ getStore: () => store, nowIso: () => new Date().toISOString() });
  health.recordInteractiveStart(seed.id);
  let processed = 0;
  const replies: Array<{ ms: number; processed: number }> = [];
  const pending: Promise<void>[] = [];
  const server = http.createServer((_req, response) => {
    const catalog = listDiscoveredBridgeSessions({ store, codelarkHome: CODELARK_HOME,
      getAdapter: () => ({ isRunning: () => true, getBotDisplayName: () => 'fixture' }) as any });
    response.end(JSON.stringify(catalog));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as import('node:net').AddressInfo).port;
  const probe = () => {
    const started = performance.now();
    pending.push(new Promise<void>((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}`, response => {
        response.resume();
        response.on('end', () => { replies.push({ ms: performance.now() - started, processed }); resolve(); });
      }).on('error', reject);
    }));
  };
  try {
    probe();
    const stream = new ReadableStream<string>({ start(controller) {
      for (let i = 0; i < 1500; i++) controller.enqueue(sseEvent('text', String(i)));
      controller.close();
    } });
    await consumeSseEvents(stream, event => {
      assert.equal(Number(event.data), processed, 'replay must retain every event in order');
      health.recordInteractiveProgress(seed.id, 'text');
      health.recordStructuredStreamUi(seed.id, { active: true });
      store.getSession(seed.id);
      processed++;
      if (processed % 300 === 0 && processed < 1500) probe();
    });
    await Promise.all(pending);
    assert.equal(processed, 1500);
    assert.equal(store.listSessions().length, 48);
    assert.equal(replies.length, 5);
    assert.ok(replies[0]!.processed < processed, 'control requests must run before the replay ends');
    assert.ok(replies.every(reply => reply.ms < 3000), `control latencies: ${JSON.stringify(replies)}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
