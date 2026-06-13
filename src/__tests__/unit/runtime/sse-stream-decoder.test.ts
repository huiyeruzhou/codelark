import '../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

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
