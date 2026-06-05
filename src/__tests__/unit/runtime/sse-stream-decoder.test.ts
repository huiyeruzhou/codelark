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
  it('reassembles an SSE event that is split across chunks', async () => {
    const events: Array<{ type: string; data: string }> = [];

    await consumeSseEvents(makeChunkedStream([
      'data: {"type":"text","data":"hel',
      'lo"}\n',
    ]), async (event) => {
      events.push(event);
    });

    assert.deepEqual(events, [
      { type: 'text', data: 'hello' },
    ]);
  });

  it('flushes the trailing SSE event even when the stream ends without a newline', async () => {
    const events: Array<{ type: string; data: string }> = [];

    await consumeSseEvents(makeChunkedStream([
      'data: {"type":"result","data":"{\\"session_id\\":\\"thread-1\\"}"}',
    ]), async (event) => {
      events.push(event);
    });

    assert.deepEqual(events, [
      { type: 'result', data: '{"session_id":"thread-1"}' },
    ]);
  });

  it('supports CRLF-delimited chunks and ignores non-data lines', async () => {
    const events: Array<{ type: string; data: string }> = [];

    await consumeSseEvents(makeChunkedStream([
      'event: message\r\n',
      'data: {"type":"error","data":"boom"}\r\n',
    ]), async (event) => {
      events.push(event);
    });

    assert.deepEqual(events, [
      { type: 'error', data: 'boom' },
    ]);
  });
});
