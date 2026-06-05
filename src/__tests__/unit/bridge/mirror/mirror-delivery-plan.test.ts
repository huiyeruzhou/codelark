import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildMirrorDeliveryPlan } from '../../../../bridge/mirror/delivery-plan.js';

describe('mirror-delivery-plan', () => {
  it('buffers filtered records and only returns timed-out turns when blocked', () => {
    const subscription = {
      sessionId: 'session-1',
      bufferedRecords: [],
    };

    const plan = buildMirrorDeliveryPlan(subscription, [
      {
        signature: 'assistant-1',
        type: 'message',
        role: 'assistant',
        content: 'hello',
        timestamp: '2026-04-13T12:00:01.000Z',
      },
    ], {
      blocked: true,
      filterSuppressedRecords: (_sessionId, records) => records,
      flushTimedOutTurn: () => ({
        streamKey: 'mirror:session-1:turn-1',
        userText: null,
        text: 'stale answer',
        signature: 'timeout:thread-1:turn-1',
        timestamp: '2026-04-13T12:00:01.000Z',
        status: 'interrupted',
        timedOut: true,
      }),
      consumeBufferedTurns: () => {
        throw new Error('should not consume buffered turns while blocked');
      },
    });

    assert.deepEqual(subscription.bufferedRecords, [
      {
        signature: 'assistant-1',
        type: 'message',
        role: 'assistant',
        content: 'hello',
        timestamp: '2026-04-13T12:00:01.000Z',
      },
    ]);
    assert.deepEqual(plan, {
      syncReason: 'mirror reconcile active task',
      finalizedTurns: [
        {
          streamKey: 'mirror:session-1:turn-1',
          userText: null,
          text: 'stale answer',
          signature: 'timeout:thread-1:turn-1',
          timestamp: '2026-04-13T12:00:01.000Z',
          status: 'interrupted',
          timedOut: true,
        },
      ],
    });
  });

  it('returns a no-finalized reason when nothing is ready to deliver', () => {
    const subscription = {
      sessionId: 'session-1',
      bufferedRecords: [],
    };

    const plan = buildMirrorDeliveryPlan(subscription, [], {
      blocked: false,
      filterSuppressedRecords: (_sessionId, records) => records,
      flushTimedOutTurn: () => null,
      consumeBufferedTurns: () => [],
    });

    assert.deepEqual(plan, {
      syncReason: 'mirror reconcile no finalized turns',
      finalizedTurns: [],
    });
  });

  it('returns timed-out and buffered turns together when delivery can proceed', () => {
    const subscription = {
      sessionId: 'session-1',
      bufferedRecords: [],
    };

    const plan = buildMirrorDeliveryPlan(subscription, [], {
      blocked: false,
      filterSuppressedRecords: (_sessionId, records) => records,
      flushTimedOutTurn: () => ({
        streamKey: 'mirror:session-1:timeout',
        userText: null,
        text: 'timeout',
        signature: 'timeout:thread-1:turn-1',
        timestamp: '2026-04-13T12:00:01.000Z',
        status: 'interrupted',
        timedOut: true,
      }),
      consumeBufferedTurns: () => [
        {
          streamKey: 'mirror:session-1:turn-2',
          userText: 'prompt',
          text: 'answer',
          signature: 'complete',
          timestamp: '2026-04-13T12:00:02.000Z',
          status: 'completed',
        },
      ],
    });

    assert.deepEqual(plan, {
      syncReason: 'mirror reconcile delivered turns',
      finalizedTurns: [
        {
          streamKey: 'mirror:session-1:timeout',
          userText: null,
          text: 'timeout',
          signature: 'timeout:thread-1:turn-1',
          timestamp: '2026-04-13T12:00:01.000Z',
          status: 'interrupted',
          timedOut: true,
        },
        {
          streamKey: 'mirror:session-1:turn-2',
          userText: 'prompt',
          text: 'answer',
          signature: 'complete',
          timestamp: '2026-04-13T12:00:02.000Z',
          status: 'completed',
        },
      ],
    });
  });
});
