import '../../setup/test-setup.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runRuntimeE2eShards } from '../../../../scripts/real-runtime-e2e-scheduler.js';

describe('real runtime E2E scheduler', () => {
  it('serializes shards on macOS so real TUIs do not contend for one tmux server', async () => {
    let active = 0;
    let maxActive = 0;
    const completed: string[] = [];

    const results = await runRuntimeE2eShards(['codex', 'claude', 'kimi'], async (shard) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      completed.push(shard);
      active -= 1;
      return `${shard}-done`;
    }, 'darwin');

    assert.equal(maxActive, 1);
    assert.deepEqual(completed, ['codex', 'claude', 'kimi']);
    assert.deepEqual(results, ['codex-done', 'claude-done', 'kimi-done']);
  });

  it('keeps shards parallel on non-macOS platforms', async () => {
    let active = 0;
    let maxActive = 0;

    await runRuntimeE2eShards(['codex', 'claude', 'kimi'], async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
    }, 'linux');

    assert.equal(maxActive, 3);
  });
});
