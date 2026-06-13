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
  it('keeps ignored terminal turns suppressed across repeated mirror reads', () => {
    const config: MirrorSuppressionConfig = {
      suppressionWindowMs: 5000,
      promptMatchGraceMs: 3000,
    };
    const sessionId = 'session-1';

    for (const type of ['task_complete', 'task_aborted'] as const) {
      const store: MirrorSuppressionStore = {
        suppressions: new Map(),
        ignoredTurnIds: new Map(),
      };
      store.ignoredTurnIds.set(sessionId, new Map([['turn-1', Date.now() + 60000]]));

      const terminalRecord = mirrorRecord({
        type,
        turnId: 'turn-1',
        timestamp: '2026-06-04T09:59:03.000Z',
      });

      for (const pass of [1, 2, 3]) {
        const filtered = filterSuppressedMirrorRecords(store, sessionId, [terminalRecord], config);
        assert.equal(filtered.length, 0, `${type} pass ${pass} should stay suppressed`);
        assert.equal(
          store.ignoredTurnIds.get(sessionId)?.has('turn-1'),
          true,
          `${type} should keep turn-1 in the ignored list`,
        );
      }
    }
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
