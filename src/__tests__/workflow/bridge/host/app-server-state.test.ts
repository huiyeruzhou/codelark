import '../../../setup/test-setup.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createInteractiveRuntime } from '../../../../bridge/host/interactive-runtime.js';
import { createSessionHealthRuntime } from '../../../../bridge/health/runtime.js';
import type { CodexAppServerLifecycle } from '../../../../runtime/codex/app-server-lifecycle.js';
import { initBridgeTestContext } from '../../../helpers/bridge/test-bridge-utils.js';

it('cancels queued input without aborting the active task or allowing the new queue to overtake it', async () => {
  const store = initBridgeTestContext();
  const session = store.createSession('protocol', 'test', undefined, '/tmp/project', 'code');
  const abortController = new AbortController();
  const state = { activeTasks: new Map(), queuedCounts: new Map(), sessionLocks: new Map() };
  const runtime = createInteractiveRuntime(() => state, { getStore: () => store, nowIso: () => new Date().toISOString(), sessionTurnCooldownMs: 0 });
  runtime.registerInteractiveTask({ id: 'task', sessionId: session.id, abortController } as never);
  const calls: string[] = [];
  let release!: () => void;
  const active = runtime.processWithSessionLock(session.id, async () => { calls.push('active'); await new Promise<void>((resolve) => { release = resolve; }); calls.push('terminal'); });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const cancelled = runtime.processWithSessionLock(session.id, async () => { calls.push('cancelled'); });
  runtime.cancelQueuedSessionMessages(session.id);
  assert.equal(abortController.signal.aborted, false);
  assert.equal(runtime.getActiveTask(session.id)?.id, 'task');
  const next = runtime.processWithSessionLock(session.id, async () => { calls.push('next'); });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['active']);
  release(); await Promise.all([active, cancelled, next]);
  assert.deepEqual(calls, ['active', 'terminal', 'next']);
  assert.equal(runtime.getQueuedCount(session.id), 0);
});

it('does not reset a live external thread to idle after Bridge restart or stale terminal health', async () => {
  const store = initBridgeTestContext();
  const session = store.createSession('protocol-restore', 'test', undefined, '/tmp/project', 'code');
  store.updateSession(session.id, { runtime_status: 'running', queued_count: 2, health_status: 'completed' });
  let active = true;
  const state = { activeTasks: new Map(), queuedCounts: new Map(), sessionLocks: new Map() };
  const runtime = createInteractiveRuntime(() => state, { getStore: () => store, nowIso: () => new Date().toISOString(), isExternalThreadActive: () => active });
  runtime.resetPersistedInteractiveRuntimeState();
  await runtime.reconcileTerminalSessionRuntimeState();
  assert.equal(store.getSession(session.id)?.runtime_status, 'running');
  assert.equal(store.getSession(session.id)?.queued_count, 0);
  active = false; runtime.syncSessionRuntimeState(session.id);
  assert.equal(store.getSession(session.id)?.runtime_status, 'idle');
});

it('uses protocol activity and connection for health even when no local process exists or output is old', async () => {
  const store = initBridgeTestContext();
  const session = store.createSession('protocol-health', 'test', undefined, '/tmp/project', 'code');
  store.updateSession(session.id, { runtime: { codex: { threadId: 'thread', appServerEndpoint: 'ws://127.0.0.1:12345' } }, runtime_status: 'running', health_status: 'running_active', last_progress_at: '2020-01-01T00:00:00.000Z' });
  let snapshot: ReturnType<CodexAppServerLifecycle['snapshot']> = { threadId: 'thread', activity: 'active', connection: 'ready', requests: [] };
  const health = createSessionHealthRuntime({ getStore: () => store, nowIso: () => new Date().toISOString(),
    getProtocolSnapshot: () => snapshot, probeThreadProcess: async () => assert.fail('protocol threads must not probe local writer processes') });
  health.reconcileSessionHealth();
  assert.equal(store.getSession(session.id)?.health_status, 'running_active');
  snapshot = { ...snapshot, connection: 'disconnected' };
  assert.equal((await health.diagnoseSessionHealth(session.id))?.healthStatus, 'suspected_detached');
  snapshot = { ...snapshot, connection: 'ready', activity: 'waiting' };
  assert.equal((await health.diagnoseSessionHealth(session.id))?.healthStatus, 'waiting_tool');
  snapshot = { ...snapshot, activity: 'idle' };
  assert.equal((await health.diagnoseSessionHealth(session.id))?.healthStatus, 'idle');
});
