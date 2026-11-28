import { it } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { startEventLoopMonitor, type EventLoopStall } from '../../../shared/event-loop-monitor.js';

it('reports a blocked event loop and stops sampling on shutdown', async () => {
  const reports: EventLoopStall[] = [];
  const stop = startEventLoopMonitor({ onStall: report => reports.push(report), intervalMs: 30, thresholdMs: 25 });
  try {
    await delay(25);
    // Timer lateness excludes up to one 30ms interval before its deadline.
    // Keep the measured lower bound above 70ms regardless of callback phase.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120);
    await delay(70);
    assert.ok(reports.some(report => report.max_delay_ms >= 70 && report.event === 'perf.event_loop.stall'), JSON.stringify(reports));
    stop();
    const count = reports.length;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80);
    await delay(50);
    assert.equal(reports.length, count);
  } finally { stop(); }
});
