import '../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findLatestProviderStreamTerminalState } from '../../../testing/real-feishu/mirror-terminal.js';

describe('unit::real-feishu-e2e-harness::mirror-terminal', () => {
  it('reports the new stream error instead of accepting an older completed stream', () => {
    const oldStream = 'mirror:session:old';
    const newStream = 'mirror:session:new';
    const state = findLatestProviderStreamTerminalState({
      streamKeys: [oldStream, newStream],
      streamPrefix: 'mirror:',
      excludedStreamKeys: [oldStream],
      logText: [
        `[feishu-adapter] Card finalized: streamKey=${oldStream}, cardId=1, status=completed, elapsed=10ms`,
        `[feishu-adapter] Card finalized: streamKey=${newStream}, cardId=2, status=error, elapsed=20ms`,
      ].join('\n'),
    });

    assert.deepEqual(state, { streamKey: newStream, status: 'error' });
  });

  it('keeps waiting when the new stream has no terminal state', () => {
    const oldStream = 'mirror:session:old';
    const newStream = 'mirror:session:new';
    const state = findLatestProviderStreamTerminalState({
      streamKeys: [oldStream, newStream],
      streamPrefix: 'mirror:',
      excludedStreamKeys: [oldStream],
      logText: [
        `[feishu-adapter] Card finalized: streamKey=${oldStream}, cardId=1, status=completed, elapsed=10ms`,
        `[feishu-adapter] Streaming card created: streamKey=${newStream}, cardId=2`,
      ].join('\n'),
    });

    assert.equal(state, undefined);
  });

  it('reads completed status from structured bridge logs', () => {
    const streamKey = 'mirror:session:current';
    const state = findLatestProviderStreamTerminalState({
      streamKeys: [streamKey],
      streamPrefix: 'mirror:',
      logText: JSON.stringify({
        level: 'INFO',
        msg: `[feishu-adapter] Card finalized: streamKey=${streamKey}, cardId=3, status=completed, elapsed=30ms`,
      }),
    });

    assert.deepEqual(state, { streamKey, status: 'completed' });
  });
});
