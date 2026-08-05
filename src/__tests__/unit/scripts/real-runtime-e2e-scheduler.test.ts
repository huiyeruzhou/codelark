import '../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runRuntimeShardsSerially } from '../../../../scripts/real-runtime-e2e-scheduler.js';

describe('real runtime e2e scheduler', () => {
  it('preserves shard order and never overlaps real TUI processes', async () => {
    const shards = ['codex', 'claude', 'kimi-provider', 'kimi-bridge'];
    const events: string[] = [];
    let active = 0;
    let maxActive = 0;

    const results = await runRuntimeShardsSerially(shards, async (shard) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      events.push(`start:${shard}`);
      await new Promise((resolve) => setTimeout(resolve, 1));
      events.push(`end:${shard}`);
      active -= 1;
      return shard.toUpperCase();
    });

    assert.equal(maxActive, 1);
    assert.deepEqual(results, shards.map((shard) => shard.toUpperCase()));
    assert.deepEqual(events, shards.flatMap((shard) => [`start:${shard}`, `end:${shard}`]));
  });
});
