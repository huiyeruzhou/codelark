import '../../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  advanceBridgeMirrorCursor,
  filterDuplicateAssistantEvents,
  reconcileBridgeMirrorCursor,
} from '../../../../bridge/mirror/cursor.js';
import type { BridgeMirrorRecord } from '../../../../runtime/contracts.js';

function makeEvent(
  signature: string,
  role: NonNullable<BridgeMirrorRecord['role']>,
  content: string,
  timestamp = '2026-03-25T00:00:00.000Z',
  type: BridgeMirrorRecord['type'] = 'message',
): BridgeMirrorRecord {
  return {
    signature,
    type,
    role,
    content,
    timestamp,
  };
}

describe('reconcileBridgeMirrorCursor', () => {
  it('initializes without replaying history', () => {
    const events = [
      makeEvent('a', 'user', 'hello'),
      makeEvent('b', 'assistant', 'world'),
    ];

    const delta = reconcileBridgeMirrorCursor(null, events);

    assert.equal(delta.deliverableRecords.length, 0);
    assert.equal(delta.nextCursor.initialized, true);
    assert.equal(delta.nextCursor.lastEventSignature, 'b');
    assert.equal(delta.nextCursor.lastEventType, 'message');
    assert.equal(delta.reset, false);
  });

  it('returns new events after the last seen signature', () => {
    const events = [
      makeEvent('a', 'user', 'hello'),
      makeEvent('b', 'assistant', 'world'),
      makeEvent('c', 'commentary', 'thinking'),
    ];

    const delta = reconcileBridgeMirrorCursor({
      initialized: true,
      lastEventSignature: 'b',
      lastEventTimestamp: '2026-03-25T00:00:00.000Z',
      lastEventType: 'message',
      lastEventCount: 2,
    }, events);

    assert.deepEqual(delta.deliverableRecords.map((event) => event.signature), ['c']);
    assert.equal(delta.reset, false);
  });

  it('delivers all events when the previous cursor was an initialized empty stream', () => {
    const events = [
      makeEvent('a', 'user', 'hello'),
      makeEvent('b', 'assistant', 'world'),
    ];

    const delta = reconcileBridgeMirrorCursor({
      initialized: true,
      lastEventCount: 0,
    }, events);

    assert.deepEqual(delta.deliverableRecords.map((event) => event.signature), ['a', 'b']);
    assert.equal(delta.reset, false);
  });

  it('recovers newer events by timestamp when the previous signature disappeared after compaction', () => {
    const events = [
      makeEvent('x', 'user', 'older', '2026-03-25T00:00:00.000Z'),
      makeEvent('y', 'assistant', 'rewrite final', '2026-03-25T00:00:05.000Z'),
    ];

    const delta = reconcileBridgeMirrorCursor({
      initialized: true,
      lastEventSignature: 'b',
      lastEventTimestamp: '2026-03-25T00:00:02.000Z',
      lastEventType: 'message',
      lastEventCount: 2,
    }, events);

    assert.deepEqual(delta.deliverableRecords.map((event) => event.signature), ['y']);
    assert.equal(delta.reset, true);
    assert.equal(delta.nextCursor.lastEventSignature, 'y');
  });

  it('still avoids replay when reset happens but there are no newer timestamps', () => {
    const events = [
      makeEvent('x', 'user', 'older', '2026-03-25T00:00:00.000Z'),
      makeEvent('y', 'assistant', 'still old', '2026-03-25T00:00:01.000Z'),
    ];

    const delta = reconcileBridgeMirrorCursor({
      initialized: true,
      lastEventSignature: 'b',
      lastEventTimestamp: '2026-03-25T00:00:02.000Z',
      lastEventType: 'message',
      lastEventCount: 2,
    }, events);

    assert.equal(delta.deliverableRecords.length, 0);
    assert.equal(delta.reset, true);
  });

  it('advances the cursor with appended events without rescanning history', () => {
    const nextCursor = advanceBridgeMirrorCursor({
      initialized: true,
      lastEventSignature: 'b',
      lastEventTimestamp: '2026-03-25T00:00:02.000Z',
      lastEventType: 'message',
      lastEventRole: 'assistant',
      lastEventContent: 'world',
      lastEventCount: 2,
    }, [
      makeEvent('c', 'assistant', 'new answer', '2026-03-25T00:00:03.000Z'),
      makeEvent('d', 'commentary', 'follow-up', '2026-03-25T00:00:04.000Z'),
    ]);

    assert.equal(nextCursor.initialized, true);
    assert.equal(nextCursor.lastEventSignature, 'd');
    assert.equal(nextCursor.lastEventTimestamp, '2026-03-25T00:00:04.000Z');
    assert.equal(nextCursor.lastEventRole, 'commentary');
    assert.equal(nextCursor.lastEventContent, 'follow-up');
    assert.equal(nextCursor.lastEventCount, 4);
  });

  it('filters duplicate leading assistant events across incremental batches', () => {
    const filtered = filterDuplicateAssistantEvents({
      initialized: true,
      lastEventSignature: 'b',
      lastEventTimestamp: '2026-03-25T00:00:02.000Z',
      lastEventType: 'message',
      lastEventRole: 'assistant',
      lastEventContent: '888',
      lastEventCount: 2,
    }, [
      makeEvent('c', 'assistant', '888', '2026-03-25T00:00:03.000Z'),
      makeEvent('d', 'assistant', 'new answer', '2026-03-25T00:00:04.000Z'),
    ]);

    assert.deepEqual(filtered.map((event) => event.signature), ['d']);
  });

  it('filters duplicate recovered assistant events after a reset/full rescan', () => {
    const delta = reconcileBridgeMirrorCursor({
      initialized: true,
      lastEventSignature: 'b',
      lastEventTimestamp: '2026-03-25T00:00:02.000Z',
      lastEventType: 'message',
      lastEventRole: 'assistant',
      lastEventContent: '888',
      lastEventCount: 2,
    }, [
      makeEvent('x', 'user', 'older', '2026-03-25T00:00:00.000Z'),
      makeEvent('y', 'assistant', '888', '2026-03-25T00:00:03.000Z'),
    ]);

    const filtered = filterDuplicateAssistantEvents({
      initialized: true,
      lastEventSignature: 'b',
      lastEventTimestamp: '2026-03-25T00:00:02.000Z',
      lastEventType: 'message',
      lastEventRole: 'assistant',
      lastEventContent: '888',
      lastEventCount: 2,
    }, delta.deliverableRecords);

    assert.equal(delta.reset, true);
    assert.deepEqual(filtered, []);
  });
});
