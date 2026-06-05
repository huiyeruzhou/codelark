import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createMirrorSubscription } from '../../../../bridge/mirror/subscription-state.js';
import {
  isMirrorSnapshotUnchanged,
  markMirrorSnapshotMissing,
  refreshMirrorSubscriptionSource,
} from '../../../../bridge/mirror/reconcile-core.js';

describe('mirror-reconcile-core', () => {
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
});
