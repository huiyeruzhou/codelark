import '../../../setup/test-setup.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { parseCodexMirrorRecordText } from '../../../../runtime/codex/session-index/event-mirror-parser.js';

function event(type: string, turnId?: string): string {
  return JSON.stringify({ type: 'event_msg', timestamp: '2026-10-08T00:00:00.000Z',
    payload: { type, ...(turnId ? { turn_id: turnId } : {}) } }) + '\n';
}

it('a late explicit A abort keeps its identity after B has started', () => {
  const result = parseCodexMirrorRecordText(event('task_started', 'A') + event('task_started', 'B') + event('turn_aborted', 'A'));
  assert.deepEqual(result.records.map(({ type, turnId }) => ({ type, turnId })), [
    { type: 'task_started', turnId: 'A' },
    { type: 'task_started', turnId: 'B' },
    { type: 'task_aborted', turnId: 'A' },
  ]);
  assert.equal(result.nextTurnId, 'B');
});

it('an old-format abort without a turn ID retains the current-turn fallback', () => {
  const result = parseCodexMirrorRecordText(event('task_started', 'B') + event('turn_aborted'));
  assert.equal(result.records.at(-1)?.turnId, 'B');
  assert.equal(result.nextTurnId, null);
});

it('a delayed explicit abort can be identified even when this read has no active turn', () => {
  const result = parseCodexMirrorRecordText(event('turn_aborted', 'A'));
  assert.equal(result.records[0]?.turnId, 'A');
  assert.equal(result.nextTurnId, null);
});
