import '../../../setup/test-setup.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  readDetachedLogTail,
  startDetachedLogMonitor,
  type DetachedLogSnapshot,
} from '../../../../bridge/background/detached-log-monitor.js';

describe('detached log monitor', () => {
  it('reads only the configured number of final log lines', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-detached-log-tail-'));
    const logPath = path.join(dir, 'worker.log');
    try {
      fs.writeFileSync(logPath, 'one\ntwo\nthree\nfour\n', 'utf-8');
      assert.deepEqual(readDetachedLogTail(logPath, 2), {
        text: 'three\nfour',
        exists: true,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('turns a running task into one timeout terminal and stops refreshing', async () => {
    const snapshots: DetachedLogSnapshot[] = [];
    let now = 0;
    const monitor = startDetachedLogMonitor({
      logPath: '/missing/worker.log',
      workerPid: null,
      refreshIntervalMs: 60_000,
      maxDurationMs: 60_000,
      tailLines: 100,
      workerLabel: 'test worker',
      detectState: () => 'running',
      now: () => now,
      onSnapshot(snapshot) { snapshots.push(snapshot); },
    });

    await monitor.refresh();
    now = 60_001;
    await monitor.refresh();
    await monitor.refresh();

    assert.equal(snapshots.length, 2);
    assert.equal(snapshots[0]?.state, 'running');
    assert.equal(snapshots[1]?.state, 'error');
    assert.match(snapshots[1]?.stateDetail || '', /超过 1 分钟/);
  });
});
