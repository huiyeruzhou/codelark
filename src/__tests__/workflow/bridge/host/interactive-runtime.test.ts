import '../../../setup/test-setup.js';
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { CODELARK_HOME } from '../../../../configuration/index.js';
import { JsonFileStore } from '../../../../storage/json-store.js';
import { initBridgeContext } from '../../../../bridge/host/context.js';
import { createInteractiveRuntime } from '../../../../bridge/host/interactive-runtime.js';

const DATA_DIR = path.join(CODELARK_HOME, 'data');

function makeSettings(): Map<string, string> {
  return new Map([
    ['remote_bridge_enabled', 'true'],
    ['bridge_default_model', 'test-model'],
    ['bridge_default_mode', 'code'],
  ]);
}

function initTestBridgeContext(store: JsonFileStore): void {
  initBridgeContext({
    store,
    llm: {
      streamChat() {
        return new ReadableStream({
          start(controller) {
            controller.close();
          },
        });
      },
    },
    permissions: {
      resolvePendingPermission: () => false,
    },
    lifecycle: {},
  });
}

describe('interactive-runtime', () => {
  beforeEach(() => {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it('tracks queued session state around the per-session lock boundary', async () => {
    const store = new JsonFileStore(makeSettings());
    initTestBridgeContext(store);
    const session = store.createSession('Runtime Queue', 'test-model', undefined, 'D:\\workspace\\runtime-queue', 'code');
    const state = {
      activeTasks: new Map(),
      queuedCounts: new Map(),
      sessionLocks: new Map(),
    };
    const runtime = createInteractiveRuntime(() => state, {
      getStore: () => store,
      nowIso: () => '2026-04-13T00:00:00.000Z',
      sessionTurnCooldownMs: 0,
    });

    runtime.registerInteractiveTask({
      id: 'task-1',
      abortController: new AbortController(),
      adapter: { channelType: 'feishu' } as never,
      address: { channelType: 'feishu', chatId: 'chat-1' },
      requestMessageId: 'msg-1',
      streamKey: 'stream-1',
      sessionId: session.id,
      hasStreamingCards: false,
      structuredStreamUiActive: false,
      lastActivityAt: Date.now(),
      streamFinalized: false,
      uiEnded: false,
      mirrorSuppressionId: null,
    });

    let releaseFirstLock: (() => void) | undefined;
    const first = runtime.processWithSessionLock(session.id, async () => {
      await new Promise<void>((resolve) => {
        releaseFirstLock = resolve;
      });
    });
    const second = runtime.processWithSessionLock(session.id, async () => {});

    await new Promise((resolve) => setTimeout(resolve, 0));
    const queued = store.getSession(session.id);
    assert.equal(queued?.runtime_status, 'queued');
    assert.equal(queued?.queued_count, 1);

    assert.ok(releaseFirstLock);
    releaseFirstLock();
    await Promise.all([first, second]);

    const running = store.getSession(session.id);
    assert.equal(running?.runtime_status, 'running');
    assert.equal(running?.queued_count || 0, 0);

    runtime.releaseInteractiveTask(session.id, 'task-1');

    const idle = store.getSession(session.id);
    assert.equal(idle?.runtime_status, 'idle');
    assert.equal(idle?.queued_count || 0, 0);
  });

  it('heals stale terminal runtime state back to idle when no active task remains', async () => {
    const store = new JsonFileStore(makeSettings());
    initTestBridgeContext(store);
    const session = store.createSession('Runtime Heal', 'test-model', undefined, 'D:\\workspace\\runtime-heal', 'code');
    const state = {
      activeTasks: new Map(),
      queuedCounts: new Map(),
      sessionLocks: new Map(),
    };
    const runtime = createInteractiveRuntime(() => state, {
      getStore: () => store,
      nowIso: () => '2026-04-20T16:00:00.000Z',
      sessionTurnCooldownMs: 0,
    });

    store.updateSession(session.id, {
      runtime_status: 'running',
      queued_count: 2,
      health_status: 'completed',
      health_reason: '任务已完成。',
      last_runtime_update_at: '2026-04-20T15:00:00.000Z',
    });

    await runtime.reconcileTerminalSessionRuntimeState();

    const healed = store.getSession(session.id);
    assert.equal(healed?.runtime_status, 'idle');
    assert.equal(healed?.queued_count || 0, 0);
    assert.equal(healed?.last_runtime_update_at, '2026-04-20T16:00:00.000Z');
  });

  it('does not finalize an active task from terminal health alone', async () => {
    const store = new JsonFileStore(makeSettings());
    initTestBridgeContext(store);
    const session = store.createSession('Runtime Heal Active', 'test-model', undefined, 'D:\\workspace\\runtime-heal-active', 'code');
    const state = {
      activeTasks: new Map(),
      queuedCounts: new Map(),
      sessionLocks: new Map(),
    };
    const runtime = createInteractiveRuntime(() => state, {
      getStore: () => store,
      nowIso: () => '2026-04-20T16:05:00.000Z',
      sessionTurnCooldownMs: 0,
    });
    let finalized: Array<{ outcome: string; detail?: string }> = [];

    runtime.registerInteractiveTask({
      id: 'task-heal-active',
      abortController: new AbortController(),
      adapter: { channelType: 'feishu', provider: 'feishu' } as never,
      address: { channelType: 'feishu', chatId: 'chat-heal-active' },
      requestMessageId: 'msg-heal-active',
      streamKey: 'stream-heal-active',
      sessionId: session.id,
      hasStreamingCards: false,
      structuredStreamUiActive: false,
      lastActivityAt: Date.now(),
      streamFinalized: false,
      uiEnded: false,
      mirrorSuppressionId: null,
      finalizeFromExternalTerminal: async (outcome, detail) => {
        finalized.push({ outcome, detail });
        runtime.releaseInteractiveTask(session.id, 'task-heal-active');
        return true;
      },
    });

    store.updateSession(session.id, {
      health_status: 'completed',
      health_reason: '检测到Codex thread已完成当前任务。',
      last_runtime_update_at: '2026-04-20T15:05:00.000Z',
    });

    await runtime.reconcileTerminalSessionRuntimeState();

    const running = store.getSession(session.id);
    assert.deepEqual(finalized, []);
    assert.equal(running?.runtime_status, 'running');
    assert.equal(state.activeTasks.has(session.id), true);
  });

  it('force-stops a session task and clears runtime bookkeeping', async () => {
    const store = new JsonFileStore(makeSettings());
    initTestBridgeContext(store);
    const session = store.createSession('Runtime Force Stop', 'test-model', undefined, 'D:\\workspace\\runtime-force-stop', 'code');
    const state = {
      activeTasks: new Map(),
      queuedCounts: new Map(),
      sessionLocks: new Map(),
    };
    const runtime = createInteractiveRuntime(() => state, {
      getStore: () => store,
      nowIso: () => '2026-04-20T16:10:00.000Z',
      sessionTurnCooldownMs: 0,
    });
    const abortController = new AbortController();
    let forceStopDetail: string | undefined;

    runtime.registerInteractiveTask({
      id: 'task-force-stop',
      abortController,
      adapter: { channelType: 'feishu', provider: 'feishu' } as never,
      address: { channelType: 'feishu', chatId: 'chat-force-stop' },
      requestMessageId: 'msg-force-stop',
      streamKey: 'stream-force-stop',
      sessionId: session.id,
      hasStreamingCards: false,
      structuredStreamUiActive: false,
      lastActivityAt: Date.now(),
      streamFinalized: false,
      uiEnded: false,
      mirrorSuppressionId: null,
      forceStop: async (detail) => {
        forceStopDetail = detail;
        abortController.abort();
        return true;
      },
    });
    state.queuedCounts.set(session.id, 2);
    state.sessionLocks.set(session.id, Promise.resolve());
    store.updateSession(session.id, {
      runtime_status: 'queued',
      queued_count: 2,
    });

    const handled = await runtime.forceStopSession(session.id, '用户执行 /stop，已停止当前任务。');

    const refreshed = store.getSession(session.id);
    assert.equal(handled, true);
    assert.equal(forceStopDetail, '用户执行 /stop，已停止当前任务。');
    assert.equal(abortController.signal.aborted, true);
    assert.equal(state.activeTasks.has(session.id), false);
    assert.equal(state.queuedCounts.has(session.id), false);
    assert.equal(state.sessionLocks.has(session.id), false);
    assert.equal(refreshed?.runtime_status, 'idle');
    assert.equal(refreshed?.queued_count || 0, 0);
  });

  it('skips stale queued work after a force stop invalidates the session lock', async () => {
    const store = new JsonFileStore(makeSettings());
    initTestBridgeContext(store);
    const session = store.createSession('Runtime Force Stop Queue', 'test-model', undefined, 'D:\\workspace\\runtime-force-stop-queue', 'code');
    const state = {
      activeTasks: new Map(),
      queuedCounts: new Map(),
      sessionLocks: new Map(),
    };
    const runtime = createInteractiveRuntime(() => state, {
      getStore: () => store,
      nowIso: () => '2026-04-20T16:11:00.000Z',
      sessionTurnCooldownMs: 0,
    });
    let releaseFirstLock: (() => void) | undefined;
    let staleQueuedRan = false;

    const first = runtime.processWithSessionLock(session.id, async () => {
      await new Promise<void>((resolve) => {
        releaseFirstLock = resolve;
      });
    });
    const staleQueued = runtime.processWithSessionLock(session.id, async () => {
      staleQueuedRan = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    await runtime.forceStopSession(session.id, 'force stop');
    assert.ok(releaseFirstLock);
    releaseFirstLock();
    await Promise.all([first, staleQueued]);

    assert.equal(staleQueuedRan, false);
    assert.equal(state.sessionLocks.has(session.id), false);
    assert.equal(state.queuedCounts.has(session.id), false);
  });

  it('waits briefly before starting the next task in the same session', async () => {
    const store = new JsonFileStore(makeSettings());
    initTestBridgeContext(store);
    const session = store.createSession('Runtime Cooldown', 'test-model', undefined, 'D:\\workspace\\runtime-cooldown', 'code');
    const state = {
      activeTasks: new Map(),
      queuedCounts: new Map(),
      sessionLocks: new Map(),
    };
    const runtime = createInteractiveRuntime(() => state, {
      getStore: () => store,
      nowIso: () => '2026-04-20T16:12:00.000Z',
      sessionTurnCooldownMs: 25,
    });
    const events: string[] = [];

    await runtime.processWithSessionLock(session.id, async () => {
      events.push('first');
    });

    const startedAt = Date.now();
    const second = runtime.processWithSessionLock(session.id, async () => {
      events.push('second');
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(events, ['first']);

    await second;
    assert.deepEqual(events, ['first', 'second']);
    assert.ok(Date.now() - startedAt >= 20);
  });
});
