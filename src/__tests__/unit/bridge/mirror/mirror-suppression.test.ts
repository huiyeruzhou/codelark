import '../../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  beginMirrorSuppression,
  settleMirrorSuppression,
  filterSuppressedMirrorRecords,
  type MirrorSuppressionStore,
  type MirrorSuppressionConfig,
} from '../../../../bridge/mirror/suppression.js';
import type { BridgeMirrorRecord } from '../../../../runtime/contracts.js';

let recordSeq = 0;
function mirrorRecord(
  record: Omit<BridgeMirrorRecord, 'signature' | 'content'> & Partial<Pick<BridgeMirrorRecord, 'signature' | 'content'>>,
): BridgeMirrorRecord {
  recordSeq += 1;
  return {
    signature: `test-record-${recordSeq}`,
    content: '',
    ...record,
  };
}

describe('mirror-suppression terminal record handling', () => {
  it('should not show terminal record multiple times when in ignoredTurnIds', () => {
    // This test verifies the fix for the bug where terminal records (task_complete/task_aborted)
    // had their ignored status cleared on first encounter, causing them to be shown again
    // when the mirror file was re-read.

    // The bug scenario: after SDK abort or timeout, the turnId is marked as ignored.
    // When terminal record arrives, it would clear the ignored status (bug).
    // On next mirror read, the same terminal record would be shown again (duplicate).

    const store: MirrorSuppressionStore = {
      suppressions: new Map(),
      ignoredTurnIds: new Map(),
    };

    const config: MirrorSuppressionConfig = {
      suppressionWindowMs: 5000,
      promptMatchGraceMs: 3000,
    };

    const sessionId = 'session-1';
    const nowMs = Date.now();

    // Simulate: turnId was marked as ignored (e.g., after SDK abort/timeout)
    // This happens via markIgnoredMirrorTurn in abortMirrorSuppression
    store.ignoredTurnIds.set(sessionId, new Map([['turn-1', nowMs + 60000]]));

    const taskComplete = mirrorRecord({
      type: 'task_complete',
      turnId: 'turn-1',
      timestamp: '2026-06-04T09:59:03.000Z',
    });

    // First encounter: filter the terminal record
    const firstFiltered = filterSuppressedMirrorRecords(store, sessionId, [taskComplete], config, nowMs);

    // Should be suppressed (in ignored list)
    assert.equal(firstFiltered.length, 0, 'First pass: should be suppressed');

    // BUG CHECK: Without fix, ignored status would be cleared now
    // With fix, it should still be in ignored list
    const ignoredAfterFirst = store.ignoredTurnIds.get(sessionId);
    assert.ok(ignoredAfterFirst, 'Ignored turns map should still exist');
    assert.equal(
      ignoredAfterFirst.has('turn-1'),
      true,
      'turn-1 should STILL be in ignored list (BUG: was cleared without fix)',
    );

    // Second encounter: re-reading mirror file with same terminal record
    const secondFiltered = filterSuppressedMirrorRecords(store, sessionId, [taskComplete], config, nowMs);

    // Should still be suppressed
    assert.equal(
      secondFiltered.length,
      0,
      'Second pass: should still be suppressed (BUG: would show duplicate without fix)',
    );
  });

  it('should keep ignored status for terminal records across multiple reads', () => {
    const store: MirrorSuppressionStore = {
      suppressions: new Map(),
      ignoredTurnIds: new Map(),
    };

    const config: MirrorSuppressionConfig = {
      suppressionWindowMs: 5000,
      promptMatchGraceMs: 3000,
    };

    const sessionId = 'session-1';

    // Manually mark a turn as ignored (simulating it was already processed)
    store.ignoredTurnIds.set(sessionId, new Map([['turn-1', Date.now() + 60000]]));

    const taskComplete = mirrorRecord({
      type: 'task_complete',
      turnId: 'turn-1',
      timestamp: '2026-06-04T09:59:03.000Z',
    });

    // First encounter with terminal record
    const firstFiltered = filterSuppressedMirrorRecords(store, sessionId, [taskComplete], config);
    assert.equal(firstFiltered.length, 0, 'First encounter: should be suppressed');

    // Verify turn is still in ignored list
    const ignoredTurns = store.ignoredTurnIds.get(sessionId);
    assert.ok(ignoredTurns, 'Ignored turns map should exist');
    assert.equal(ignoredTurns.has('turn-1'), true, 'turn-1 should still be in ignored list');

    // Second encounter with same terminal record (simulating re-read)
    const secondFiltered = filterSuppressedMirrorRecords(store, sessionId, [taskComplete], config);
    assert.equal(
      secondFiltered.length,
      0,
      'Second encounter: should still be suppressed (BUG: would be 1 without fix)',
    );

    // Third encounter - verify it remains suppressed
    const thirdFiltered = filterSuppressedMirrorRecords(store, sessionId, [taskComplete], config);
    assert.equal(thirdFiltered.length, 0, 'Third encounter: should still be suppressed');
  });

  it('should suppress task_aborted records consistently like task_complete', () => {
    const store: MirrorSuppressionStore = {
      suppressions: new Map(),
      ignoredTurnIds: new Map(),
    };

    const config: MirrorSuppressionConfig = {
      suppressionWindowMs: 5000,
      promptMatchGraceMs: 3000,
    };

    const sessionId = 'session-1';

    // Mark turn as ignored
    store.ignoredTurnIds.set(sessionId, new Map([['turn-1', Date.now() + 60000]]));

    const taskAborted = mirrorRecord({
      type: 'task_aborted',
      turnId: 'turn-1',
      timestamp: '2026-06-04T09:59:03.000Z',
    });

    // First pass
    const firstFiltered = filterSuppressedMirrorRecords(store, sessionId, [taskAborted], config);
    assert.equal(firstFiltered.length, 0, 'First pass: task_aborted should be suppressed');

    // Verify still in ignored list
    const ignoredTurns = store.ignoredTurnIds.get(sessionId);
    assert.equal(ignoredTurns?.has('turn-1'), true, 'turn-1 should remain in ignored list');

    // Second pass - simulate re-read
    const secondFiltered = filterSuppressedMirrorRecords(store, sessionId, [taskAborted], config);
    assert.equal(
      secondFiltered.length,
      0,
      'Second pass: task_aborted should still be suppressed (BUG: would show without fix)',
    );
  });
});

describe('mirror-suppression synthetic message handling', () => {
  it('should suppress synthetic error messages that do not match original prompt', () => {
    // This test verifies the fix for synthetic messages (permission errors, tool errors)
    // that have different content than the original prompt but share the same turnId

    const store: MirrorSuppressionStore = {
      suppressions: new Map(),
      ignoredTurnIds: new Map(),
    };

    const config: MirrorSuppressionConfig = {
      suppressionWindowMs: 5000,
      promptMatchGraceMs: 3000,
    };

    const sessionId = 'session-1';
    const originalPrompt = 'read the file /etc/passwd';

    // Start suppression with original prompt
    beginMirrorSuppression(store, sessionId, originalPrompt);

    // Simulate mirror records
    const taskStarted = mirrorRecord({
      type: 'task_started',
      turnId: 'turn-1',
      timestamp: '2026-06-04T10:00:00.000Z',
    });

    // SDK generates a synthetic permission error message instead of echoing the original prompt
    const syntheticUserMessage = mirrorRecord({
      type: 'message',
      role: 'user',
      content: 'This command requires approval',  // Different from originalPrompt!
      turnId: 'turn-1',
      timestamp: '2026-06-04T10:00:01.000Z',
    });

    const assistantMessage = mirrorRecord({
      type: 'message',
      role: 'assistant',
      content: '',
      turnId: 'turn-1',
      timestamp: '2026-06-04T10:00:02.000Z',
    });

    const taskComplete = mirrorRecord({
      type: 'task_complete',
      turnId: 'turn-1',
      timestamp: '2026-06-04T10:00:03.000Z',
    });

    const records = [taskStarted, syntheticUserMessage, assistantMessage, taskComplete];
    const filtered = filterSuppressedMirrorRecords(store, sessionId, records, config);

    // All records should be suppressed even though the user message doesn't match
    assert.equal(
      filtered.length,
      0,
      'Synthetic error messages should be suppressed by turnId match (BUG: would leak without fix)',
    );
  });

  it('should suppress various types of synthetic messages', () => {
    const store: MirrorSuppressionStore = {
      suppressions: new Map(),
      ignoredTurnIds: new Map(),
    };

    const config: MirrorSuppressionConfig = {
      suppressionWindowMs: 5000,
      promptMatchGraceMs: 3000,
    };

    const sessionId = 'session-1';
    const originalPrompt = 'ls /secret/dir';

    beginMirrorSuppression(store, sessionId, originalPrompt);

    const testCases = [
      'This command requires approval',
      '<tool_use_error>Cancelled: parallel tool call Bash(...) errored</tool_use_error>',
      "cd in '/data00/home/user/dir' was blocked. For security, Claude Code may only...",
      "Claude requested permissions to read from /file, but you haven't granted it yet.",
      '<tool_use_error>Directory does not exist: /some/path</tool_use_error>',
      'No files found No files found',  // Duplicate output
    ];

    for (const syntheticContent of testCases) {
      const records: BridgeMirrorRecord[] = [
        mirrorRecord({ type: 'task_started', turnId: 'turn-1', timestamp: '2026-06-04T10:00:00.000Z' }),
        mirrorRecord({
          type: 'message',
          role: 'user',
          content: syntheticContent,
          turnId: 'turn-1',
          timestamp: '2026-06-04T10:00:01.000Z',
        }),
        mirrorRecord({ type: 'task_complete', turnId: 'turn-1', timestamp: '2026-06-04T10:00:02.000Z' }),
      ];

      const filtered = filterSuppressedMirrorRecords(store, sessionId, records, config);
      assert.equal(
        filtered.length,
        0,
        `Synthetic message "${syntheticContent.substring(0, 30)}..." should be suppressed`,
      );

      // Reset suppression for next test case
      store.suppressions.clear();
      beginMirrorSuppression(store, sessionId, originalPrompt);
    }
  });

  it('should still clear suppression for user messages with different turnId', () => {
    // Verify that the fix doesn't break the normal behavior:
    // if we see a user message with a DIFFERENT turnId, suppression should still be cleared

    const store: MirrorSuppressionStore = {
      suppressions: new Map(),
      ignoredTurnIds: new Map(),
    };

    const config: MirrorSuppressionConfig = {
      suppressionWindowMs: 5000,
      promptMatchGraceMs: 3000,
    };

    const sessionId = 'session-1';
    beginMirrorSuppression(store, sessionId, 'first prompt');

    // First turn starts
    const turn1Started = mirrorRecord({
      type: 'task_started',
      turnId: 'turn-1',
      timestamp: '2026-06-04T10:00:00.000Z',
    });

    filterSuppressedMirrorRecords(store, sessionId, [turn1Started], config);

    // User sends a completely different message (turn-2)
    const turn2UserMessage = mirrorRecord({
      type: 'message',
      role: 'user',
      content: 'different prompt',
      turnId: 'turn-2',  // Different turnId
      timestamp: '2026-06-04T10:00:05.000Z',
    });

    const filtered = filterSuppressedMirrorRecords(store, sessionId, [turn2UserMessage], config);

    // Suppression should have been cleared, so this message should NOT be suppressed
    assert.equal(filtered.length, 1, 'Message with different turnId should not be suppressed');
    assert.equal(filtered[0].turnId, 'turn-2');

    // Verify suppression was cleared
    const suppressions = store.suppressions.get(sessionId);
    assert.equal(suppressions?.length || 0, 0, 'Suppression should be cleared for different turnId');
  });
});
