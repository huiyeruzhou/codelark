import '../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

import { consumeSseEvents } from '../../../runtime/sse-stream-decoder.js';

function makeChunkedStream(chunks: string[]): ReadableStream<string> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

describe('sse-stream-decoder', () => {
  it('keeps control HTTP responsive while draining a buffered replay, without losing or reordering events', async () => {
    const server = http.createServer((_req, response) => response.end('ready'));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as import('node:net').AddressInfo).port;
    const received: number[] = [];
    let countWhenControlReplied = -1;
    const control = new Promise<void>((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}`, response => {
        response.resume();
        response.on('end', () => { countWhenControlReplied = received.length; resolve(); });
      }).on('error', reject);
    });
    try {
      const chunks = Array.from({ length: 20 }, (_, i) => `data: ${JSON.stringify({ type: 'text', data: String(i) })}\n`);
      const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
      await consumeSseEvents(makeChunkedStream(chunks), event => {
        // Represent a synchronous event handler (for example a file update).
        Atomics.wait(waitBuffer, 0, 0, 12);
        received.push(Number(event.data));
      });
      await control;
      assert.deepEqual(received, Array.from({ length: 20 }, (_, i) => i));
      assert.ok(countWhenControlReplied >= 0 && countWhenControlReplied < received.length,
        'a queued control request must not wait for the entire replay');
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('reassembles split, trailing, and CRLF-delimited SSE data events', async () => {
    const cases = [
      {
        chunks: ['data: {"type":"text","data":"hel', 'lo"}\n'],
        expected: [{ type: 'text', data: 'hello' }],
      },
      {
        chunks: ['data: {"type":"result","data":"{\\"session_id\\":\\"thread-1\\"}"}'],
        expected: [{ type: 'result', data: '{"session_id":"thread-1"}' }],
      },
      {
        chunks: ['event: message\r\n', 'data: {"type":"error","data":"boom"}\r\n'],
        expected: [{ type: 'error', data: 'boom' }],
      },
    ];

    for (const item of cases) {
      const events: Array<{ type: string; data: string }> = [];
      await consumeSseEvents(makeChunkedStream(item.chunks), async (event) => {
        events.push(event);
      });
      assert.deepEqual(events, item.expected);
    }
  });
});
