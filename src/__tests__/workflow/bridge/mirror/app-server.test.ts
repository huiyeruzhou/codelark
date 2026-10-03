import '../../../setup/test-setup.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMirrorRuntime } from '../../../../bridge/mirror/runtime.js';
import { consumeMirrorRecords, hasPendingMirrorWork } from '../../../../bridge/mirror/turns.js';
import type { BridgeMirrorRecord } from '../../../../runtime/contracts.js';
import type { CodexAppServerLifecycle } from '../../../../runtime/codex/app-server-lifecycle.js';

const runtimes: ReturnType<typeof createMirrorRuntime>[] = [];
afterEach(() => { runtimes.splice(0).forEach((runtime) => runtime.clearMirrorSubscriptions()); });

function setup() {
  const timestamp = '2026-10-03T00:00:00.000Z';
  const records: BridgeMirrorRecord[] = [];
  const cursors: number[] = [];
  const routed: BridgeMirrorRecord[] = [];
  let listeners = 0;
  let disconnected = false;
  const handle = {
    threadId: 'thread-1', endpoint: 'ws://127.0.0.1:12345', direct: false, directTurnIds: new Set<string>(),
    lifecycle: {
      recordsAfter: (_thread: string, cursor = 0) => { cursors.push(cursor); return { records: records.slice(cursor), cursor: records.length }; },
      onChange: () => { listeners++; return () => { listeners--; }; },
      snapshot: () => ({ connection: disconnected ? 'disconnected' : 'ready', activity: 'active', requests: [], threadId: 'thread-1' }),
    } as unknown as CodexAppServerLifecycle,
  };
  let available = true;
  const bindings = [{ id: 'binding-1', channelType: 'feishu', chatId: 'chat-1', bridgeSessionId: 'session-1', active: true }];
  const session = { id: 'session-1', runtime: { codex: { threadId: 'thread-1', appServerEndpoint: handle.endpoint } } };
  const state = { running: true, adapters: new Map([['feishu', { channelType: 'feishu', provider: 'feishu', isRunning: () => false }]]), mirrorSubscriptions: new Map(), mirrorWakeTimer: null, mirrorSyncInFlight: false, activeTasks: new Map() };
  const deliveries: string[][] = [];
  let failOnce = false;
  const runtime = createMirrorRuntime(() => state as never, {
    watchDebounceMs: 0, danglingThreadRetryLimit: 1, failureSuspendThreshold: 3, failureSuspendMs: 60_000,
  }, {
    nowIso: () => timestamp, describeUnknownError: String,
    listChannelChats: () => bindings, getSession: () => session,
    getProtocolSession: () => available ? handle : undefined,
    clearSessionCodexThreadId: () => assert.fail('protocol threads must not be cleared by local file checks'),
    getCodexSessionByThreadIdSafe: () => assert.fail('protocol threads must not scan local rollout files'),
    syncMirrorSessionStateSafe: () => {}, filterSuppressedMirrorRecords: () => assert.fail('protocol records use direct turn ownership'),
    observeSessionHealthRecords: () => {},
    routeCodexRecords: async (_session, _thread, input) => { routed.push(...input); return { claimed: [], unclaimed: input, terminalClaimed: false }; },
    consumeMirrorRecords, hasPendingMirrorWork,
    flushTimedOutMirrorTurn: () => assert.fail('protocol terminal must not be synthesized by timeout'),
    consumeBufferedMirrorTurns: () => assert.fail('legacy timeout consumer must not run'),
    stopMirrorStreaming: () => {},
    deliverMirrorTurns: async (_sub, turns) => {
      deliveries.push(turns.map((turn) => turn.signature));
      if (failOnce) { failOnce = false; return { deliveredCount: 0, error: new Error('test delivery failure') }; }
      return { deliveredCount: turns.length };
    },
  });
  runtimes.push(runtime);
  const append = (turnId: string, type: BridgeMirrorRecord['type'], content = '') => records.push({ type, turnId, content, timestamp, signature: `${turnId}:${records.length}`, ...(type === 'message' ? { role: 'assistant' as const } : {}) });
  return { runtime, handle, records, cursors, deliveries, routed, state, append, bindings,
    failNext: () => { failOnce = true; }, disconnect: () => { disconnected = true; },
    loseHandle: () => { available = false; }, listeners: () => listeners,
  };
}

it('delivers only actual protocol terminals through the existing coordinator and retries pending output', async () => {
  const s = setup();
  await s.runtime.reconcileMirrorSubscriptions();
  s.append('turn-1', 'task_started'); s.append('turn-1', 'message', '回复内容');
  await s.runtime.reconcileMirrorSubscriptions();
  await s.runtime.reconcileMirrorSubscriptions();
  assert.equal(s.deliveries.length, 0);
  s.failNext(); s.append('turn-1', 'task_complete', '回复内容');
  await s.runtime.reconcileMirrorSubscriptions();
  await s.runtime.reconcileMirrorSubscriptions();
  await s.runtime.reconcileMirrorSubscriptions();
  assert.equal(s.deliveries.length, 2);
  assert.deepEqual(s.deliveries[0], s.deliveries[1]);
  assert.equal(s.routed.filter((record) => record.type === 'task_complete').length, 1);
  assert.equal(s.listeners(), 1);
  s.runtime.clearMirrorSubscriptions(); assert.equal(s.listeners(), 0);
});

it('advances the protocol cursor while direct streaming and suppresses late records of owned direct turns', async () => {
  const s = setup();
  s.handle.direct = true;
  s.append('direct-1', 'task_started'); s.append('direct-1', 'message', 'direct reply');
  await s.runtime.reconcileMirrorSubscriptions();
  s.handle.direct = false; s.handle.directTurnIds.add('direct-1');
  s.append('direct-1', 'task_complete', 'direct reply');
  s.append('mirror-1', 'task_started'); s.append('mirror-1', 'message', 'Desktop reply'); s.append('mirror-1', 'task_complete', 'Desktop reply');
  await s.runtime.reconcileMirrorSubscriptions();
  assert.deepEqual(s.cursors, [0, 2]);
  assert.equal(s.routed.length, 3);
  assert.ok(s.routed.every((record) => record.turnId === 'mirror-1'));
  assert.equal(s.deliveries.length, 1);
});

it('keeps a disconnected or missing protocol handle attached without local-file terminal guesses', async () => {
  const s = setup();
  s.append('turn-1', 'task_started'); s.append('turn-1', 'message', 'still running');
  await s.runtime.reconcileMirrorSubscriptions();
  s.disconnect(); await s.runtime.reconcileMirrorSubscriptions();
  assert.equal(s.state.mirrorSubscriptions.get('binding-1').status, 'stale');
  s.loseHandle(); await s.runtime.reconcileMirrorSubscriptions();
  assert.equal(s.state.mirrorSubscriptions.get('binding-1').status, 'stale');
  assert.equal(s.deliveries.length, 0);
  assert.equal(s.listeners(), 0);
});
