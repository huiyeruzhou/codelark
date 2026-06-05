import '../../../setup/test-setup.js';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CODELARK_HOME } from '../../../../configuration/index.js';
import { createSessionExecutor } from '../../../../bridge/session/session-executor.js';

async function waitForCondition(fn: () => boolean, timeoutMs = 200): Promise<void> {
  const attempts = Math.max(1, Math.ceil(timeoutMs / 5));
  for (let index = 0; index < attempts; index += 1) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(fn(), true);
}

describe('SessionExecutor', () => {
  it('serializes one session and emits queue timing fields', async () => {
    const logPath = path.join(CODELARK_HOME, 'logs', 'bridge.log');
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, '');

    const state = {
      queuedCounts: new Map<string, number>(),
      sessionLocks: new Map<string, Promise<void>>(),
    };
    const queueChanges: Array<{ sessionId: string; queued: number }> = [];
    let now = 0;
    let releaseFirst!: () => void;
    const firstDone = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const executor = createSessionExecutor(() => state, {
      nowMs: () => now,
      sessionTurnCooldownMs: 0,
      onQueuedCountChanged: (sessionId) => {
        queueChanges.push({ sessionId, queued: state.queuedCounts.get(sessionId) || 0 });
      },
    });

    const events: string[] = [];
    const first = executor.enqueue('session-a', async () => {
      events.push('first:start');
      await firstDone;
      events.push('first:end');
    }, { jobKind: 'prompt' });
    const second = executor.enqueue('session-a', async () => {
      events.push('second');
    }, { jobKind: 'provider-switch' });

    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(executor.getActive('session-a'), true);
    assert.equal(executor.getQueuedCount('session-a'), 1);
    assert.deepEqual(events, ['first:start']);

    now = 1_250;
    releaseFirst();
    await Promise.all([first, second]);

    assert.equal(executor.getActive('session-a'), false);
    assert.equal(executor.getQueuedCount('session-a'), 0);
    assert.deepEqual(events, ['first:start', 'first:end', 'second']);
    assert.deepEqual(queueChanges, [
      { sessionId: 'session-a', queued: 1 },
      { sessionId: 'session-a', queued: 0 },
    ]);

    await waitForCondition(() => {
      const logText = fs.readFileSync(logPath, 'utf-8');
      return logText.includes('"event":"session.executor.scheduled"')
        && logText.includes('"event":"session.executor.started"')
        && logText.includes('"event":"session.executor.finished"');
    });

    const entries = fs.readFileSync(logPath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const queuedSchedule = entries.find((entry) => (
      entry.event === 'session.executor.scheduled'
      && entry.job_kind === 'provider-switch'
    ));
    const queuedStart = entries.find((entry) => (
      entry.event === 'session.executor.started'
      && entry.job_kind === 'provider-switch'
    ));
    const queuedFinish = entries.find((entry) => (
      entry.event === 'session.executor.finished'
      && entry.job_kind === 'provider-switch'
    ));

    assert.equal(queuedSchedule?.session_id, 'session-a');
    assert.equal(queuedSchedule?.queued_before, 0);
    assert.equal(queuedSchedule?.queued_after, 1);
    assert.equal(queuedSchedule?.has_active_tail, true);
    assert.equal(queuedStart?.level, 'WARN');
    assert.equal(queuedStart?.wait_ms, 1_250);
    assert.equal(queuedStart?.queued_after_start, 0);
    assert.equal(queuedFinish?.status, 'success');
    assert.equal(queuedFinish?.run_ms, 0);
  });
});
