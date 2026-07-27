import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  clearMirrorSubscriptionFailure,
  createMirrorSubscription,
  recordMirrorSubscriptionFailure,
  updateMirrorSubscription,
} from '../../../../bridge/mirror/subscription-state.js';
import { createInitialStreamingHistoryItems } from '../../../../bridge/turn/unified-turn-state.js';

describe('mirror-subscription-state', () => {
  it('creates mirror subscriptions with the expected defaults', () => {
    const subscription = createMirrorSubscription({
      bindingId: 'binding-1',
      sessionId: 'session-1',
      channelType: 'feishu-default',
      chatId: 'chat-1',
      threadId: 'thread-1',
      filePath: 'D:\\codex\\session.jsonl',
      lastDeliveredAt: '2026-04-13T12:00:00.000Z',
    });

    assert.deepEqual(subscription, {
      bindingId: 'binding-1',
      sessionId: 'session-1',
      channelType: 'feishu-default',
      chatId: 'chat-1',
      threadId: 'thread-1',
      filePath: 'D:\\codex\\session.jsonl',
      cursor: { initialized: false, lastEventCount: 0 },
      dirty: true,
      status: 'watching',
      activityTier: 'hot',
      nextColdReconcileAt: null,
      watcher: null,
      watcherTarget: null,
      lastDeliveredAt: '2026-04-13T12:00:00.000Z',
      lastReconciledAt: null,
      fileOffset: 0,
      fileSize: null,
      fileMtimeMs: null,
      fileIdentity: null,
      trailingText: '',
      activeMirrorTurnId: null,
      activeSpecialCallIds: new Set(),
      supplementalOffset: 0,
      supplementalTrailingText: '',
      bufferedRecords: [],
      pendingTurn: null,
      pendingDeliveries: [],
      consecutiveEmptyGoalTurns: 0,
      emptyGoalLoopWarningSent: false,
      unknownMirrorKindsSeen: new Set(),
      missingThreadPolls: 0,
      consecutiveFailures: 0,
      suspendedUntil: null,
    });
  });

  it('resets the correct state when a binding switches to a different Codex thread', () => {
    const subscription = createMirrorSubscription({
      bindingId: 'binding-1',
      sessionId: 'session-old',
      channelType: 'feishu-default',
      chatId: 'chat-old',
      threadId: 'thread-old',
      filePath: 'D:\\codex\\old.jsonl',
      lastDeliveredAt: '2026-04-13T12:00:00.000Z',
    });

    subscription.cursor = {
      initialized: true,
      lastEventSignature: 'sig-1',
      lastEventTimestamp: '2026-04-13T12:00:01.000Z',
      lastEventCount: 12,
    };
    subscription.dirty = false;
    subscription.pendingTurn = {
      startedAtMs: Date.parse('2026-04-13T12:00:00.000Z'),
      lastActivityAtMs: Date.parse('2026-04-13T12:00:01.000Z'),
      lastContentResponseAtMs: null,
      turnId: 'turn-old',
      streamKey: 'mirror:session-old:turn-old',
      startedAt: '2026-04-13T12:00:00.000Z',
      lastActivityAt: '2026-04-13T12:00:01.000Z',
      lastStatusText: null,
      lastStatusAt: 0,
      statusNote: null,
      thinkingNote: null,
      userText: 'hello',
      lastAssistantText: 'world',
      lastCommentaryText: null,
      streamedText: 'world',
      streamStarted: true,
      taskItems: [],
      toolCalls: new Map(),
      historyItems: createInitialStreamingHistoryItems(),
      historyTextSnapshot: '',
      contextUsage: null,
    };
    subscription.fileOffset = 99;
    subscription.fileSize = 100;
    subscription.fileMtimeMs = 123;
    subscription.fileIdentity = 'dev:ino';
    subscription.trailingText = 'partial';
    subscription.activeMirrorTurnId = 'turn-old';
    subscription.activeSpecialCallIds.add('plan-old');
    subscription.supplementalOffset = 42;
    subscription.supplementalTrailingText = 'partial-error';
    subscription.bufferedRecords.push({
      signature: 'sig-1',
      type: 'message',
      role: 'assistant',
      content: 'hello',
      timestamp: '2026-04-13T12:00:01.000Z',
    });
    subscription.pendingDeliveries.push({
      streamKey: 'mirror:session-old:turn-old',
      userText: 'hello',
      text: 'world',
      signature: 'complete-old',
      timestamp: '2026-04-13T12:00:02.000Z',
      status: 'completed',
    });
    subscription.missingThreadPolls = 2;
    subscription.consecutiveFailures = 2;
    subscription.suspendedUntil = 9999;

    const result = updateMirrorSubscription(subscription, {
      sessionId: 'session-new',
      channelType: 'feishu-main',
      chatId: 'chat-new',
      threadId: 'thread-new',
      filePath: 'D:\\codex\\new.jsonl',
      lastDeliveredAt: '2026-04-13T13:00:00.000Z',
    });

    assert.deepEqual(result, {
      previousSessionId: 'session-old',
      threadChanged: true,
      filePathChanged: true,
    });
    assert.equal(subscription.sessionId, 'session-new');
    assert.equal(subscription.channelType, 'feishu-main');
    assert.equal(subscription.chatId, 'chat-new');
    assert.equal(subscription.threadId, 'thread-new');
    assert.equal(subscription.filePath, 'D:\\codex\\new.jsonl');
    assert.deepEqual(subscription.cursor, { initialized: false, lastEventCount: 0 });
    assert.equal(subscription.lastDeliveredAt, '2026-04-13T13:00:00.000Z');
    assert.equal(subscription.dirty, true);
    assert.equal(subscription.pendingTurn, null);
    assert.equal(subscription.fileOffset, 0);
    assert.equal(subscription.fileSize, null);
    assert.equal(subscription.fileMtimeMs, null);
    assert.equal(subscription.fileIdentity, null);
    assert.equal(subscription.trailingText, '');
    assert.equal(subscription.activeMirrorTurnId, null);
    assert.deepEqual(subscription.activeSpecialCallIds, new Set());
    assert.equal(subscription.supplementalOffset, 0);
    assert.equal(subscription.supplementalTrailingText, '');
    assert.deepEqual(subscription.bufferedRecords, []);
    assert.deepEqual(subscription.pendingDeliveries, []);
    assert.deepEqual(subscription.unknownMirrorKindsSeen, new Set());
    assert.equal(subscription.missingThreadPolls, 0);
    assert.equal(subscription.consecutiveFailures, 0);
    assert.equal(subscription.suspendedUntil, null);
  });

  it('preserves cursor and missing-thread polls when only the file path changes', () => {
    const subscription = createMirrorSubscription({
      bindingId: 'binding-1',
      sessionId: 'session-1',
      channelType: 'feishu-default',
      chatId: 'chat-1',
      threadId: 'thread-1',
      filePath: 'D:\\codex\\old.jsonl',
      lastDeliveredAt: '2026-04-13T12:00:00.000Z',
    });

    subscription.cursor = {
      initialized: true,
      lastEventSignature: 'sig-1',
      lastEventTimestamp: '2026-04-13T12:00:01.000Z',
      lastEventCount: 12,
    };
    subscription.lastDeliveredAt = '2026-04-13T12:30:00.000Z';
    subscription.pendingTurn = {
      startedAtMs: Date.parse('2026-04-13T12:00:00.000Z'),
      lastActivityAtMs: Date.parse('2026-04-13T12:00:01.000Z'),
      lastContentResponseAtMs: null,
      turnId: 'turn-old',
      streamKey: 'mirror:session-1:turn-old',
      startedAt: '2026-04-13T12:00:00.000Z',
      lastActivityAt: '2026-04-13T12:00:01.000Z',
      lastStatusText: null,
      lastStatusAt: 0,
      statusNote: null,
      thinkingNote: null,
      userText: 'hello',
      lastAssistantText: null,
      lastCommentaryText: null,
      streamedText: '',
      streamStarted: false,
      taskItems: [],
      toolCalls: new Map(),
      historyItems: createInitialStreamingHistoryItems(),
      historyTextSnapshot: '',
      contextUsage: null,
    };
    subscription.fileOffset = 99;
    subscription.fileSize = 100;
    subscription.fileMtimeMs = 123;
    subscription.fileIdentity = 'dev:ino';
    subscription.trailingText = 'partial';
    subscription.activeMirrorTurnId = 'turn-old';
    subscription.activeSpecialCallIds.add('plan-old');
    subscription.supplementalOffset = 42;
    subscription.supplementalTrailingText = 'partial-error';
    subscription.bufferedRecords.push({
      signature: 'sig-1',
      type: 'message',
      role: 'assistant',
      content: 'hello',
      timestamp: '2026-04-13T12:00:01.000Z',
    });
    subscription.pendingDeliveries.push({
      streamKey: 'mirror:session-1:turn-old',
      userText: 'hello',
      text: 'world',
      signature: 'complete-old',
      timestamp: '2026-04-13T12:00:02.000Z',
      status: 'completed',
    });
    subscription.missingThreadPolls = 2;
    subscription.consecutiveFailures = 2;
    subscription.suspendedUntil = 9999;
    subscription.emptyGoalLoopWarningSent = true;

    const result = updateMirrorSubscription(subscription, {
      sessionId: 'session-1',
      channelType: 'feishu-default',
      chatId: 'chat-1',
      threadId: 'thread-1',
      filePath: 'D:\\codex\\new.jsonl',
      lastDeliveredAt: '2026-04-13T13:00:00.000Z',
    });

    assert.deepEqual(result, {
      previousSessionId: 'session-1',
      threadChanged: false,
      filePathChanged: true,
    });
    assert.deepEqual(subscription.cursor, {
      initialized: true,
      lastEventSignature: 'sig-1',
      lastEventTimestamp: '2026-04-13T12:00:01.000Z',
      lastEventCount: 12,
    });
    assert.equal(subscription.lastDeliveredAt, '2026-04-13T12:30:00.000Z');
    assert.equal(subscription.pendingTurn, null);
    assert.equal(subscription.fileOffset, 0);
    assert.equal(subscription.fileSize, null);
    assert.equal(subscription.fileMtimeMs, null);
    assert.equal(subscription.fileIdentity, null);
    assert.equal(subscription.trailingText, '');
    assert.equal(subscription.activeMirrorTurnId, null);
    assert.deepEqual(subscription.activeSpecialCallIds, new Set());
    assert.equal(subscription.supplementalOffset, 0);
    assert.equal(subscription.supplementalTrailingText, '');
    assert.deepEqual(subscription.bufferedRecords, []);
    assert.deepEqual(subscription.pendingDeliveries, [
      {
        streamKey: 'mirror:session-1:turn-old',
        userText: 'hello',
        text: 'world',
        signature: 'complete-old',
        timestamp: '2026-04-13T12:00:02.000Z',
        status: 'completed',
      },
    ]);
    assert.equal(subscription.missingThreadPolls, 2);
    assert.equal(subscription.emptyGoalLoopWarningSent, true);
    assert.equal(subscription.consecutiveFailures, 0);
    assert.equal(subscription.suspendedUntil, null);
  });

  it('tracks reconcile failures and suspends after the threshold', () => {
    const subscription = createMirrorSubscription({
      bindingId: 'binding-1',
      sessionId: 'session-1',
      channelType: 'feishu-default',
      chatId: 'chat-1',
      threadId: 'thread-1',
      filePath: 'D:\\codex\\session.jsonl',
      lastDeliveredAt: null,
    });

    subscription.pendingTurn = {
      startedAtMs: Date.parse('2026-04-13T12:00:00.000Z'),
      lastActivityAtMs: Date.parse('2026-04-13T12:00:01.000Z'),
      lastContentResponseAtMs: null,
      turnId: 'turn-1',
      streamKey: 'mirror:session-1:turn-1',
      startedAt: '2026-04-13T12:00:00.000Z',
      lastActivityAt: '2026-04-13T12:00:01.000Z',
      lastStatusText: null,
      lastStatusAt: 0,
      statusNote: null,
      thinkingNote: null,
      userText: 'hello',
      lastAssistantText: null,
      lastCommentaryText: null,
      streamedText: '',
      streamStarted: false,
      taskItems: [],
      toolCalls: new Map(),
      historyItems: createInitialStreamingHistoryItems(),
      historyTextSnapshot: '',
      contextUsage: null,
    };
    subscription.bufferedRecords.push({
      signature: 'sig-1',
      type: 'message',
      role: 'assistant',
      content: 'hello',
      timestamp: '2026-04-13T12:00:01.000Z',
    });
    subscription.pendingDeliveries.push({
      streamKey: 'mirror:session-1:turn-queued',
      userText: 'hello',
      text: 'world',
      signature: 'complete-queued',
      timestamp: '2026-04-13T12:00:02.000Z',
      status: 'completed',
    });
    subscription.emptyGoalLoopWarningSent = true;

    const firstSuspended = recordMirrorSubscriptionFailure(subscription, 3, 60_000, 1_000);
    const secondSuspended = recordMirrorSubscriptionFailure(subscription, 3, 60_000, 2_000);
    const thirdSuspended = recordMirrorSubscriptionFailure(subscription, 3, 60_000, 3_000);

    assert.equal(firstSuspended, false);
    assert.equal(secondSuspended, false);
    assert.equal(thirdSuspended, true);
    assert.equal(subscription.pendingTurn, null);
    assert.deepEqual(subscription.bufferedRecords, []);
    assert.deepEqual(subscription.pendingDeliveries, [
      {
        streamKey: 'mirror:session-1:turn-queued',
        userText: 'hello',
        text: 'world',
        signature: 'complete-queued',
        timestamp: '2026-04-13T12:00:02.000Z',
        status: 'completed',
      },
    ]);
    assert.equal(subscription.status, 'stale');
    assert.equal(subscription.dirty, false);
    assert.equal(subscription.emptyGoalLoopWarningSent, true);
    assert.equal(subscription.consecutiveFailures, 3);
    assert.equal(subscription.suspendedUntil, 63_000);

    clearMirrorSubscriptionFailure(subscription);
    assert.equal(subscription.consecutiveFailures, 0);
    assert.equal(subscription.suspendedUntil, null);
  });
});
