import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseCursorTranscriptRecords } from '../../../../runtime/cursor/session-index.js';
import { consumeMirrorRecords } from '../../../../bridge/mirror/turns.js';
import { mirrorReadPosition } from '../../../../bridge/mirror/subscription-state.js';

import { createMirrorSubscription } from '../../../../bridge/mirror/subscription-state.js';
import {
  isMirrorSnapshotUnchanged,
  markMirrorSnapshotMissing,
  readMirrorDeliverableRecords,
  refreshMirrorSubscriptionSource,
} from '../../../../bridge/mirror/reconcile-core.js';

describe('mirror-reconcile-core', () => {
  it('delivers CLI revisions and an interrupted continuation once after a newer delivery watermark and restart', () => {
    const row = (role: string, text: string) => JSON.stringify({ role, message: { content: [{ type: 'text', text }] } });
    const lines = [row('user', '<timestamp>Friday, Nov 20, 2026, 5:32 AM (UTC)</timestamp>\n<user_query>继续</user_query>'), row('assistant', '正在检查')];
    const options = { bindingId: 'b', sessionId: 's', channelType: 'feishu-default', chatId: 'chat', threadId: 'native', filePath: '/tmp/native.jsonl', lastDeliveredAt: null };
    let subscription = createMirrorSubscription(options);
    const source = { runtime: 'cursor' as const, readMode: 'snapshot' as const, findByThreadId: () => null,
      readDelta: () => ({ records: parseCursorTranscriptRecords(lines.join('\n')), nextOffset: lines.length, trailingText: '', nextTurnId: null, nextSpecialCallIds: [], unknownKinds: [] }) };
    const read = () => readMirrorDeliverableRecords(subscription, { size: lines.length, mtimeMs: lines.length, identity: 'native' }, source);
    read(); // Attach without replaying existing history.
    subscription = createMirrorSubscription({ ...options, lastDeliveredAt: '2026-11-20T05:58:40.000Z', readPosition: mirrorReadPosition(subscription) });
    lines.push(row('assistant', '检查结果'));
    const revision = read();
    assert.equal(revision.reset, false);
    assert.ok(revision.records.some(r => r.content?.includes('检查结果')));
    consumeMirrorRecords(subscription, revision.records);
    const streamKey = subscription.pendingTurn!.streamKey;
    lines.push(row('user', 'Your previous response was interrupted. Continue from where you left off.'), row('assistant', '最终结果'), JSON.stringify({ type: 'turn_ended', status: 'success' }));
    const completion = read();
    assert.equal(completion.reset, false);
    assert.equal(completion.records.at(-1)?.type, 'task_complete');
    const turns = consumeMirrorRecords(subscription, completion.records);
    assert.equal(turns.length, 1);
    assert.equal(turns[0]?.status, 'completed');
    assert.match(turns[0]!.text, /最终结果/);
    assert.equal(turns[0]?.streamKey, streamKey, 'native automatic continuation must finish the same card');
    assert.equal(subscription.pendingTurn, null);
    assert.deepEqual(read().records, []);
    subscription = createMirrorSubscription({ ...options, lastDeliveredAt: '2026-11-20T06:02:00.000Z', readPosition: mirrorReadPosition(subscription) });
    assert.deepEqual(read().records, [], 'restart must not replay the answer');
  });
  it('refreshes the mirror source path and resets read state only when the file changes', () => {
    const subscription = createMirrorSubscription({
      bindingId: 'binding-1',
      sessionId: 'session-1',
      channelType: 'feishu-default',
      chatId: 'chat-1',
      threadId: 'thread-1',
      filePath: 'D:\\codex\\old.jsonl',
      lastDeliveredAt: null,
    });

    subscription.dirty = false;
    subscription.fileOffset = 42;
    subscription.fileSize = 84;
    subscription.fileMtimeMs = 1000;
    subscription.fileIdentity = 'dev:ino';
    subscription.trailingText = 'partial';
    subscription.activeMirrorTurnId = 'turn-1';
    subscription.activeSpecialCallIds.add('plan-1');
    subscription.bufferedRecords.push({
      signature: 'sig-1',
      type: 'message',
      role: 'assistant',
      content: 'hello',
      timestamp: '2026-04-13T12:00:01.000Z',
    });

    const changed = refreshMirrorSubscriptionSource(
      subscription,
      'D:\\codex\\new.jsonl',
      '2026-04-13T13:00:00.000Z',
    );

    assert.equal(changed, true);
    assert.equal(subscription.filePath, 'D:\\codex\\new.jsonl');
    assert.equal(subscription.status, 'watching');
    assert.equal(subscription.lastReconciledAt, '2026-04-13T13:00:00.000Z');
    assert.equal(subscription.dirty, true);
    assert.equal(subscription.fileOffset, 0);
    assert.equal(subscription.fileSize, null);
    assert.equal(subscription.fileMtimeMs, null);
    assert.equal(subscription.fileIdentity, null);
    assert.equal(subscription.trailingText, '');
    assert.equal(subscription.activeMirrorTurnId, null);
    assert.deepEqual(subscription.activeSpecialCallIds, new Set());
    assert.deepEqual(subscription.bufferedRecords, []);
  });

  it('marks a missing snapshot as stale and clears incremental read state', () => {
    const subscription = createMirrorSubscription({
      bindingId: 'binding-1',
      sessionId: 'session-1',
      channelType: 'feishu-default',
      chatId: 'chat-1',
      threadId: 'thread-1',
      filePath: 'D:\\codex\\old.jsonl',
      lastDeliveredAt: null,
    });

    subscription.dirty = false;
    subscription.fileOffset = 42;
    subscription.fileSize = 84;
    subscription.fileMtimeMs = 1000;
    subscription.fileIdentity = 'dev:ino';
    subscription.trailingText = 'partial';
    subscription.activeMirrorTurnId = 'turn-1';
    subscription.activeSpecialCallIds.add('plan-1');
    subscription.bufferedRecords.push({
      signature: 'sig-1',
      type: 'message',
      role: 'assistant',
      content: 'hello',
      timestamp: '2026-04-13T12:00:01.000Z',
    });

    markMirrorSnapshotMissing(subscription);

    assert.equal(subscription.status, 'stale');
    assert.equal(subscription.dirty, true);
    assert.equal(subscription.fileOffset, 0);
    assert.equal(subscription.fileSize, null);
    assert.equal(subscription.fileMtimeMs, null);
    assert.equal(subscription.fileIdentity, null);
    assert.equal(subscription.trailingText, '');
    assert.equal(subscription.activeMirrorTurnId, null);
    assert.deepEqual(subscription.activeSpecialCallIds, new Set());
    assert.deepEqual(subscription.bufferedRecords, []);
  });

  it('detects unchanged snapshots from the tracked mirror file identity and size', () => {
    const subscription = createMirrorSubscription({
      bindingId: 'binding-1',
      sessionId: 'session-1',
      channelType: 'feishu-default',
      chatId: 'chat-1',
      threadId: 'thread-1',
      filePath: 'D:\\codex\\session.jsonl',
      lastDeliveredAt: null,
    });

    subscription.dirty = false;
    subscription.fileSize = 84;
    subscription.fileMtimeMs = 1000;
    subscription.fileIdentity = 'dev:ino';

    assert.equal(
      isMirrorSnapshotUnchanged(subscription, {
        size: 84,
        mtimeMs: 1000,
        identity: 'dev:ino',
      }),
      true,
    );
    assert.equal(
      isMirrorSnapshotUnchanged(subscription, {
        size: 85,
        mtimeMs: 1000,
        identity: 'dev:ino',
      }),
      false,
    );
  });

  it('recovers records written after the last delivered event on first reconcile', () => {
    const subscription = createMirrorSubscription({
      bindingId: 'binding-1',
      sessionId: 'session-1',
      channelType: 'feishu-default',
      chatId: 'chat-1',
      threadId: 'thread-1',
      filePath: '/tmp/session.jsonl',
      lastDeliveredAt: '2026-07-27T08:17:30.464Z',
    });
    const source = {
      runtime: 'codex' as const,
      findByThreadId: () => null,
      readDelta: () => ({
        records: [
          {
            signature: 'old-complete',
            type: 'task_complete' as const,
            content: 'old answer',
            timestamp: '2026-07-27T08:17:30.464Z',
          },
          {
            signature: 'new-user',
            type: 'message' as const,
            role: 'user' as const,
            content: 'new prompt',
            timestamp: '2026-07-27T08:55:58.275Z',
          },
          {
            signature: 'new-complete',
            type: 'task_complete' as const,
            content: 'new answer',
            timestamp: '2026-07-27T08:57:24.000Z',
          },
        ],
        nextOffset: 300,
        trailingText: '',
        nextTurnId: null,
        nextSpecialCallIds: [],
        unknownKinds: [],
      }),
    };

    const result = readMirrorDeliverableRecords(subscription, {
      size: 300,
      mtimeMs: 1,
      identity: '1:1',
    }, source);

    assert.deepEqual(result.records.map((record) => record.signature), ['new-user', 'new-complete']);
    assert.equal(subscription.cursor.lastEventSignature, 'new-complete');
  });

  it('does not replay existing records for a newly attached mirror without a delivery watermark', () => {
    const subscription = createMirrorSubscription({
      bindingId: 'binding-1',
      sessionId: 'session-1',
      channelType: 'feishu-default',
      chatId: 'chat-1',
      threadId: 'thread-1',
      filePath: '/tmp/session.jsonl',
      lastDeliveredAt: null,
    });
    const source = {
      runtime: 'codex' as const,
      findByThreadId: () => null,
      readDelta: () => ({
        records: [
          {
            signature: 'existing-complete',
            type: 'task_complete' as const,
            content: 'existing answer',
            timestamp: '2026-07-27T08:17:30.464Z',
          },
        ],
        nextOffset: 100,
        trailingText: '',
        nextTurnId: null,
        nextSpecialCallIds: [],
        unknownKinds: [],
      }),
    };

    const result = readMirrorDeliverableRecords(subscription, {
      size: 100,
      mtimeMs: 1,
      identity: '1:1',
    }, source);

    assert.deepEqual(result.records, []);
    assert.equal(subscription.cursor.lastEventSignature, 'existing-complete');
  });

  it('uses the persisted delivery watermark when a Cursor snapshot rewrites old turn signatures', () => {
    const deliveredAt = '2026-07-27T08:17:30.464Z';
    const oldTurnId = 'cursor:old-turn';
    const subscription = createMirrorSubscription({
      bindingId: 'cursor-binding',
      sessionId: 'cursor-session',
      channelType: 'feishu-default',
      chatId: 'cursor-chat',
      threadId: 'cursor-thread',
      filePath: '/tmp/cursor-session.jsonl',
      lastDeliveredAt: deliveredAt,
      readPosition: {
        threadId: 'cursor-thread',
        lastEventSignature: 'cursor:old-assistant-before-rewrite',
        lastEventTimestamp: deliveredAt,
        lastEventType: 'message',
        lastEventRole: 'assistant',
        lastEventTurnId: oldTurnId,
        lastEventCount: 3,
      },
    });
    const source = {
      runtime: 'cursor' as const,
      findByThreadId: () => null,
      readDelta: () => ({
        records: [
          {
            signature: 'cursor:old-user-rewritten',
            type: 'message' as const,
            role: 'user' as const,
            content: 'old prompt',
            timestamp: deliveredAt,
            turnId: oldTurnId,
          },
          {
            signature: 'cursor:old-assistant-rewritten',
            type: 'message' as const,
            role: 'assistant' as const,
            content: 'old answer',
            timestamp: deliveredAt,
            turnId: oldTurnId,
          },
          {
            signature: 'cursor:new-user',
            type: 'message' as const,
            role: 'user' as const,
            content: 'new prompt',
            timestamp: '2026-07-27T08:55:58.275Z',
            turnId: 'cursor:new-turn',
          },
          {
            signature: 'cursor:new-complete',
            type: 'task_complete' as const,
            content: 'new answer',
            timestamp: '2026-07-27T08:57:24.000Z',
            turnId: 'cursor:new-turn',
          },
        ],
        nextOffset: 400,
        trailingText: '',
        nextTurnId: null,
        nextSpecialCallIds: [],
        unknownKinds: [],
      }),
    };

    const result = readMirrorDeliverableRecords(subscription, {
      size: 400,
      mtimeMs: 2,
      identity: 'cursor:rewritten',
    }, source);

    assert.deepEqual(result.records.map((record) => record.signature), [
      'cursor:new-user',
      'cursor:new-complete',
    ]);
    assert.equal(subscription.cursor.lastEventSignature, 'cursor:new-complete');
  });
});
