import '../../../setup/test-setup.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createMirrorRuntime } from '../../../../bridge/mirror/runtime.js';
import {
  consumeBufferedMirrorTurns,
  consumeMirrorRecords,
  flushTimedOutMirrorTurn,
  hasPendingMirrorWork,
} from '../../../../bridge/mirror/turns.js';
import { createKimiMirrorJsonlSource } from '../../../../runtime/kimi/session-index.js';

const MIRROR_TEST_BUFFER_TIMEOUT_MS = 10 * 60_000;

describe('mirror-runtime pending deliveries', () => {
  let runtime: ReturnType<typeof createMirrorRuntime> | null = null;

  afterEach(() => {
    runtime?.clearMirrorSubscriptions();
    runtime = null;
  });

  it('retries queued finalized turns even when the mirror file has no new bytes', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-mirror-runtime-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    fs.writeFileSync(filePath, '', 'utf-8');

    const bindings = [{
      id: 'binding-1',
      channelType: 'feishu-default',
      chatId: 'chat-1',
      bridgeSessionId: 'session-1',
      active: true,
    }];
    const session = {
      id: 'session-1',
      runtime: { codex: { threadId: 'thread-1' } },
      mirror_last_event_at: null,
    };
    const store = {
      listChannelChats: () => bindings,
      getSession: (sessionId: string) => (sessionId === session.id ? session : null),
      updateSessionCodexThreadId: () => {},
    };
    const state = {
      running: true,
      adapters: new Map([
        ['feishu-default', { channelType: 'feishu-default', provider: 'feishu', isRunning: () => false }],
      ]),
      mirrorSubscriptions: new Map(),
      mirrorWakeTimer: null,
      mirrorSyncInFlight: false,
      activeTasks: new Map(),
    };
    const deliveryCalls: string[][] = [];
    let failedOnce = false;

    runtime = createMirrorRuntime(() => state as never, {
      watchDebounceMs: 0,
      danglingThreadRetryLimit: 3,
      failureSuspendThreshold: 3,
      failureSuspendMs: 60_000,
    }, {
      nowIso: () => '2026-04-21T10:00:00.000Z',
      describeUnknownError: (error) => (error instanceof Error ? error.message : String(error)),
      listChannelChats: () => bindings,
      getSession: store.getSession,
      clearSessionCodexThreadId: store.updateSessionCodexThreadId,
      getCodexSessionByThreadIdSafe: (threadId) => (
        threadId === 'thread-1'
          ? {
              id: threadId,
              filePath,
            } as never
          : null
      ),
      syncMirrorSessionStateSafe: () => {},
      filterSuppressedMirrorRecords: (_sessionId, records) => records,
      observeSessionHealthRecords: () => {},
      consumeMirrorRecords: (subscription, records) => consumeMirrorRecords(subscription, records),
      flushTimedOutMirrorTurn: (subscription) => flushTimedOutMirrorTurn(subscription, MIRROR_TEST_BUFFER_TIMEOUT_MS, Date.now()),
      hasPendingMirrorWork: (subscription) => hasPendingMirrorWork(subscription),
      consumeBufferedMirrorTurns: (subscription) => consumeBufferedMirrorTurns(subscription, MIRROR_TEST_BUFFER_TIMEOUT_MS, Date.now()),
      stopMirrorStreaming: () => {},
      deliverMirrorTurns: async (_subscription, turns) => {
        deliveryCalls.push(turns.map((turn) => turn.signature));
        if (!failedOnce) {
          failedOnce = true;
          return { deliveredCount: 0, error: new Error('send failed') };
        }
        return { deliveredCount: turns.length };
      },
    });

    await runtime.reconcileMirrorSubscriptions();

    fs.appendFileSync(filePath, [
      JSON.stringify({
        timestamp: '2026-04-21T10:00:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_started',
          turn_id: 'turn-1',
        },
      }),
      JSON.stringify({
        timestamp: '2026-04-21T10:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'final answer' }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-04-21T10:00:03.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: 'turn-1',
          last_agent_message: 'final answer',
        },
      }),
    ].join('\n') + '\n', 'utf-8');

    await runtime.reconcileMirrorSubscriptions();

    const subscriptionAfterFailure = state.mirrorSubscriptions.get('binding-1');
    assert.ok(subscriptionAfterFailure);
    assert.equal(subscriptionAfterFailure?.pendingDeliveries.length, 1);
    assert.equal(deliveryCalls.length, 1);

    await runtime.reconcileMirrorSubscriptions();

    const subscriptionAfterRetry = state.mirrorSubscriptions.get('binding-1');
    assert.ok(subscriptionAfterRetry);
    assert.equal(subscriptionAfterRetry?.pendingDeliveries.length, 0);
    assert.equal(deliveryCalls.length, 2);
    assert.deepEqual(deliveryCalls[1], deliveryCalls[0]);

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('delivers a finalized turn once on the normal success path', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-mirror-runtime-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    fs.writeFileSync(filePath, '', 'utf-8');

    const bindings = [{
      id: 'binding-1',
      channelType: 'feishu-default',
      chatId: 'chat-1',
      bridgeSessionId: 'session-1',
      active: true,
    }];
    const session = {
      id: 'session-1',
      runtime: { codex: { threadId: 'thread-1' } },
      mirror_last_event_at: null,
    };
    const store = {
      listChannelChats: () => bindings,
      getSession: (sessionId: string) => (sessionId === session.id ? session : null),
      updateSessionCodexThreadId: () => {},
    };
    const state = {
      running: true,
      adapters: new Map([
        ['feishu-default', { channelType: 'feishu-default', provider: 'feishu', isRunning: () => false }],
      ]),
      mirrorSubscriptions: new Map(),
      mirrorWakeTimer: null,
      mirrorSyncInFlight: false,
      activeTasks: new Map(),
    };
    const deliveryCalls: string[][] = [];

    runtime = createMirrorRuntime(() => state as never, {
      watchDebounceMs: 0,
      danglingThreadRetryLimit: 3,
      failureSuspendThreshold: 3,
      failureSuspendMs: 60_000,
    }, {
      nowIso: () => '2026-04-21T10:00:00.000Z',
      describeUnknownError: (error) => (error instanceof Error ? error.message : String(error)),
      listChannelChats: () => bindings,
      getSession: store.getSession,
      clearSessionCodexThreadId: store.updateSessionCodexThreadId,
      getCodexSessionByThreadIdSafe: (threadId) => (
        threadId === 'thread-1'
          ? {
              id: threadId,
              filePath,
            } as never
          : null
      ),
      syncMirrorSessionStateSafe: () => {},
      filterSuppressedMirrorRecords: (_sessionId, records) => records,
      observeSessionHealthRecords: () => {},
      consumeMirrorRecords: (subscription, records) => consumeMirrorRecords(subscription, records),
      flushTimedOutMirrorTurn: (subscription) => flushTimedOutMirrorTurn(subscription, MIRROR_TEST_BUFFER_TIMEOUT_MS, Date.now()),
      hasPendingMirrorWork: (subscription) => hasPendingMirrorWork(subscription),
      consumeBufferedMirrorTurns: (subscription) => consumeBufferedMirrorTurns(subscription, MIRROR_TEST_BUFFER_TIMEOUT_MS, Date.now()),
      stopMirrorStreaming: () => {},
      deliverMirrorTurns: async (_subscription, turns) => {
        deliveryCalls.push(turns.map((turn) => turn.signature));
        return { deliveredCount: turns.length };
      },
    });

    await runtime.reconcileMirrorSubscriptions();

    fs.appendFileSync(filePath, [
      JSON.stringify({
        timestamp: '2026-04-21T10:00:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_started',
          turn_id: 'turn-1',
        },
      }),
      JSON.stringify({
        timestamp: '2026-04-21T10:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'final answer' }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-04-21T10:00:03.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: 'turn-1',
          last_agent_message: 'final answer',
        },
      }),
    ].join('\n') + '\n', 'utf-8');

    await runtime.reconcileMirrorSubscriptions();

    const subscriptionAfterSuccess = state.mirrorSubscriptions.get('binding-1');
    assert.ok(subscriptionAfterSuccess);
    assert.equal(subscriptionAfterSuccess?.pendingDeliveries.length, 0);
    assert.equal(deliveryCalls.length, 1);
    assert.equal(deliveryCalls[0]?.length, 1);

    await runtime.reconcileMirrorSubscriptions();

    const subscriptionAfterReplay = state.mirrorSubscriptions.get('binding-1');
    assert.ok(subscriptionAfterReplay);
    assert.equal(subscriptionAfterReplay?.pendingDeliveries.length, 0);
    assert.equal(deliveryCalls.length, 1);

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('delivers surviving mirror records after suppression filtering without treating suppression as a global block', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-mirror-runtime-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    fs.writeFileSync(filePath, '', 'utf-8');

    const bindings = [{
      id: 'binding-1',
      channelType: 'feishu-default',
      chatId: 'chat-1',
      bridgeSessionId: 'session-1',
      active: true,
    }];
    const session = {
      id: 'session-1',
      runtime: { codex: { threadId: 'thread-1' } },
      mirror_last_event_at: null,
    };
    const store = {
      listChannelChats: () => bindings,
      getSession: (sessionId: string) => (sessionId === session.id ? session : null),
      updateSessionCodexThreadId: () => {},
    };
    const state = {
      running: true,
      adapters: new Map([
        ['feishu-default', { channelType: 'feishu-default', provider: 'feishu', isRunning: () => false }],
      ]),
      mirrorSubscriptions: new Map(),
      mirrorWakeTimer: null,
      mirrorSyncInFlight: false,
      activeTasks: new Map(),
    };
    const deliveryCalls: string[][] = [];
    const filteredSignatures: string[] = [];

    runtime = createMirrorRuntime(() => state as never, {
      watchDebounceMs: 0,
      danglingThreadRetryLimit: 3,
      failureSuspendThreshold: 3,
      failureSuspendMs: 60_000,
    }, {
      nowIso: () => '2026-04-21T10:00:00.000Z',
      describeUnknownError: (error) => (error instanceof Error ? error.message : String(error)),
      listChannelChats: () => bindings,
      getSession: store.getSession,
      clearSessionCodexThreadId: store.updateSessionCodexThreadId,
      getCodexSessionByThreadIdSafe: (threadId) => (
        threadId === 'thread-1'
          ? {
              id: threadId,
              filePath,
            } as never
          : null
      ),
      syncMirrorSessionStateSafe: () => {},
      filterSuppressedMirrorRecords: (_sessionId, records) => {
        filteredSignatures.push(...records.map((record) => record.signature));
        return records.filter((record) => record.turnId !== 'echo-turn');
      },
      observeSessionHealthRecords: () => {},
      consumeMirrorRecords: (subscription, records) => consumeMirrorRecords(subscription, records),
      flushTimedOutMirrorTurn: (subscription) => flushTimedOutMirrorTurn(subscription, MIRROR_TEST_BUFFER_TIMEOUT_MS, Date.now()),
      hasPendingMirrorWork: (subscription) => hasPendingMirrorWork(subscription),
      consumeBufferedMirrorTurns: (subscription) => consumeBufferedMirrorTurns(subscription, MIRROR_TEST_BUFFER_TIMEOUT_MS, Date.now()),
      stopMirrorStreaming: () => {},
      deliverMirrorTurns: async (_subscription, turns) => {
        deliveryCalls.push(turns.map((turn) => turn.signature));
        return { deliveredCount: turns.length };
      },
    });

    await runtime.reconcileMirrorSubscriptions();

    fs.appendFileSync(filePath, [
      JSON.stringify({
        timestamp: '2026-04-21T10:00:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_started',
          turn_id: 'echo-turn',
        },
      }),
      JSON.stringify({
        timestamp: '2026-04-21T10:00:02.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: 'echo-turn',
          last_agent_message: 'echo answer',
        },
      }),
      JSON.stringify({
        timestamp: '2026-04-21T10:00:03.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_started',
          turn_id: 'codex-turn',
        },
      }),
      JSON.stringify({
        timestamp: '2026-04-21T10:00:04.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: 'codex-turn',
          last_agent_message: 'codex answer',
        },
      }),
    ].join('\n') + '\n', 'utf-8');

    await runtime.reconcileMirrorSubscriptions();

    assert.equal(filteredSignatures.length > 0, true);
    assert.equal(deliveryCalls.length, 1);
    assert.equal(deliveryCalls[0]?.length, 1);

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('logs each unknown Codex mirror event kind at most once per subscription', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-mirror-runtime-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    fs.writeFileSync(filePath, '', 'utf-8');

    const bindings = [{
      id: 'binding-1',
      channelType: 'feishu-default',
      chatId: 'chat-1',
      bridgeSessionId: 'session-1',
      active: true,
    }];
    const session = {
      id: 'session-1',
      runtime: { codex: { threadId: 'thread-1' } },
      mirror_last_event_at: null,
    };
    const store = {
      listChannelChats: () => bindings,
      getSession: (sessionId: string) => (sessionId === session.id ? session : null),
      updateSessionCodexThreadId: () => {},
    };
    const state = {
      running: true,
      adapters: new Map([
        ['feishu-default', { channelType: 'feishu-default', provider: 'feishu', isRunning: () => false }],
      ]),
      mirrorSubscriptions: new Map(),
      mirrorWakeTimer: null,
      mirrorSyncInFlight: false,
      activeTasks: new Map(),
    };

    runtime = createMirrorRuntime(() => state as never, {
      watchDebounceMs: 0,
      danglingThreadRetryLimit: 3,
      failureSuspendThreshold: 3,
      failureSuspendMs: 60_000,
    }, {
      nowIso: () => '2026-04-21T10:00:00.000Z',
      describeUnknownError: (error) => (error instanceof Error ? error.message : String(error)),
      listChannelChats: () => bindings,
      getSession: store.getSession,
      clearSessionCodexThreadId: store.updateSessionCodexThreadId,
      getCodexSessionByThreadIdSafe: (threadId) => (
        threadId === 'thread-1'
          ? {
              id: threadId,
              filePath,
            } as never
          : null
      ),
      syncMirrorSessionStateSafe: () => {},
      filterSuppressedMirrorRecords: (_sessionId, records) => records,
      observeSessionHealthRecords: () => {},
      consumeMirrorRecords: (subscription, records) => consumeMirrorRecords(subscription, records),
      flushTimedOutMirrorTurn: (subscription) => flushTimedOutMirrorTurn(subscription, MIRROR_TEST_BUFFER_TIMEOUT_MS, Date.now()),
      hasPendingMirrorWork: (subscription) => hasPendingMirrorWork(subscription),
      consumeBufferedMirrorTurns: (subscription) => consumeBufferedMirrorTurns(subscription, MIRROR_TEST_BUFFER_TIMEOUT_MS, Date.now()),
      stopMirrorStreaming: () => {},
      deliverMirrorTurns: async () => ({ deliveredCount: 0 }),
    });

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(' '));
    };

    try {
      await runtime.reconcileMirrorSubscriptions();

      fs.appendFileSync(filePath, [
        JSON.stringify({
          timestamp: '2026-04-21T10:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'approval_request',
          },
        }),
      ].join('\n') + '\n', 'utf-8');

      await runtime.reconcileMirrorSubscriptions();

      fs.appendFileSync(filePath, [
        JSON.stringify({
          timestamp: '2026-04-21T10:00:02.000Z',
          type: 'response_item',
          payload: {
            type: 'approval_request',
          },
        }),
        JSON.stringify({
          timestamp: '2026-04-21T10:00:03.000Z',
          type: 'event_msg',
          payload: {
            type: 'approval_request_started',
          },
        }),
      ].join('\n') + '\n', 'utf-8');

      await runtime.reconcileMirrorSubscriptions();
    } finally {
      console.warn = originalWarn;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }

    const approvalRequestWarnings = warnings.filter((line) => line.includes('response_item:approval_request'));
    const approvalStartedWarnings = warnings.filter((line) => line.includes('event_msg:approval_request_started'));
    assert.equal(approvalRequestWarnings.length, 1);
    assert.equal(approvalStartedWarnings.length, 1);
  });

  it('keeps cold subscriptions registered while skipping reconcile work until their cold interval elapses', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-mirror-runtime-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    fs.writeFileSync(filePath, '', 'utf-8');
    let discoveredFilePath = filePath;

    let nowMs = Date.parse('2026-06-05T04:00:00.000Z');
    const originalDateNow = Date.now;
    Date.now = () => nowMs;

    const bindings = [{
      id: 'cold-binding',
      channelType: 'feishu-default',
      chatId: 'chat-cold',
      bridgeSessionId: 'session-1',
      createdAt: '2026-06-05T02:00:00.000Z',
      updatedAt: '2026-06-05T02:00:00.000Z',
      lastActivityAt: '2026-06-05T02:00:00.000Z',
    }];
    const session = {
      id: 'session-1',
      runtime: { codex: { threadId: 'thread-1' } },
      mirror_last_event_at: null,
    };
    const state = {
      running: true,
      adapters: new Map([
        ['feishu-default', { channelType: 'feishu-default', provider: 'feishu', isRunning: () => false }],
      ]),
      mirrorSubscriptions: new Map(),
      mirrorWakeTimer: null,
      mirrorSyncInFlight: false,
      activeTasks: new Map(),
    };
    const summaryLookups: Array<{ threadId: string; context: string }> = [];

    runtime = createMirrorRuntime(() => state as never, {
      watchDebounceMs: 0,
      danglingThreadRetryLimit: 3,
      failureSuspendThreshold: 3,
      failureSuspendMs: 60_000,
      activeBindingWindowMs: 30 * 60_000,
      coldReconcileIntervalMs: 60_000,
    }, {
      nowIso: () => new Date(nowMs).toISOString(),
      describeUnknownError: (error) => (error instanceof Error ? error.message : String(error)),
      listChannelChats: () => bindings,
      getSession: (sessionId) => (sessionId === session.id ? session : null),
      clearSessionCodexThreadId: () => {},
      getCodexSessionByThreadIdSafe: () => null,
      getMirrorSourceSummary: (_source, threadId, _cwd, context) => {
        summaryLookups.push({ threadId, context });
        return { threadId, filePath: discoveredFilePath };
      },
      syncMirrorSessionStateSafe: () => {},
      filterSuppressedMirrorRecords: (_sessionId, records) => records,
      observeSessionHealthRecords: () => {},
      consumeMirrorRecords: (subscription, records) => consumeMirrorRecords(subscription, records),
      flushTimedOutMirrorTurn: (subscription) => flushTimedOutMirrorTurn(subscription, MIRROR_TEST_BUFFER_TIMEOUT_MS, nowMs),
      hasPendingMirrorWork: (subscription) => hasPendingMirrorWork(subscription),
      consumeBufferedMirrorTurns: (subscription) => consumeBufferedMirrorTurns(subscription, MIRROR_TEST_BUFFER_TIMEOUT_MS, nowMs),
      stopMirrorStreaming: () => {},
      deliverMirrorTurns: async () => ({ deliveredCount: 0 }),
    });

    try {
      await runtime.reconcileMirrorSubscriptions();
      assert.equal(state.mirrorSubscriptions.get('cold-binding')?.activityTier, 'cold');
      assert.deepEqual(summaryLookups, [{ threadId: 'thread-1', context: 'mirror subscription sync' }]);

      await runtime.reconcileMirrorSubscriptions();
      assert.equal(summaryLookups.length, 1);

      nowMs += 60_001;
      await runtime.reconcileMirrorSubscriptions();
      assert.equal(summaryLookups.length, 1, 'stable bound paths must be stat-ed without rediscovery');

      const replacementPath = path.join(tempRoot, 'replacement-rollout.jsonl');
      fs.writeFileSync(replacementPath, '', 'utf-8');
      discoveredFilePath = replacementPath;
      const subscription = state.mirrorSubscriptions.get('cold-binding');
      assert.ok(subscription);
      subscription.filePath = path.join(tempRoot, 'missing-rollout.jsonl');
      nowMs += 60_001;
      await runtime.reconcileMirrorSubscriptions();
      assert.equal(subscription.filePath, replacementPath);
      assert.deepEqual(summaryLookups.at(-1), { threadId: 'thread-1', context: 'mirror reconcile' });
    } finally {
      Date.now = originalDateNow;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('falls back to the Codex clear hook for dangling Codex mirror identities', async () => {
    const bindings = [{
      id: 'binding-1',
      channelType: 'feishu-default',
      chatId: 'chat-1',
      bridgeSessionId: 'session-1',
      active: true,
    }];
    const session = {
      id: 'session-1',
      runtime: { codex: { threadId: 'missing-thread' } },
      mirror_last_event_at: null,
    };
    const state = {
      running: true,
      adapters: new Map([
        ['feishu-default', { channelType: 'feishu-default', provider: 'feishu', isRunning: () => false }],
      ]),
      mirrorSubscriptions: new Map(),
      mirrorWakeTimer: null,
      mirrorSyncInFlight: false,
      activeTasks: new Map(),
    };
    const clearedSessionIds: string[] = [];

    runtime = createMirrorRuntime(() => state as never, {
      watchDebounceMs: 0,
      danglingThreadRetryLimit: 1,
      failureSuspendThreshold: 3,
      failureSuspendMs: 60_000,
    }, {
      nowIso: () => '2026-04-21T10:00:00.000Z',
      describeUnknownError: (error) => (error instanceof Error ? error.message : String(error)),
      listChannelChats: () => bindings,
      getSession: (sessionId) => (sessionId === session.id ? session : null),
      clearSessionCodexThreadId: (sessionId) => clearedSessionIds.push(sessionId),
      getCodexSessionByThreadIdSafe: () => null,
      syncMirrorSessionStateSafe: () => {},
      filterSuppressedMirrorRecords: (_sessionId, records) => records,
      observeSessionHealthRecords: () => {},
      consumeMirrorRecords: (subscription, records) => consumeMirrorRecords(subscription, records),
      flushTimedOutMirrorTurn: (subscription) => flushTimedOutMirrorTurn(subscription, MIRROR_TEST_BUFFER_TIMEOUT_MS, Date.now()),
      hasPendingMirrorWork: (subscription) => hasPendingMirrorWork(subscription),
      consumeBufferedMirrorTurns: (subscription) => consumeBufferedMirrorTurns(subscription, MIRROR_TEST_BUFFER_TIMEOUT_MS, Date.now()),
      stopMirrorStreaming: () => {},
      deliverMirrorTurns: async () => ({ deliveredCount: 0 }),
    });

    await runtime.reconcileMirrorSubscriptions();

    assert.deepEqual(clearedSessionIds, ['session-1']);
    assert.equal(state.mirrorSubscriptions.size, 0);
  });

  it('delivers a Kimi runtime-log error when the primary wire file is unchanged', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-kimi-mirror-error-'));
    const wirePath = path.join(tempRoot, 'agents', 'main', 'wire.jsonl');
    const logPath = path.join(tempRoot, 'logs', 'kimi-code.log');
    fs.mkdirSync(path.dirname(wirePath), { recursive: true });
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(wirePath, `${JSON.stringify({
      type: 'context.append_loop_event',
      time: Date.parse('2026-07-27T08:14:36.428Z'),
      event: { type: 'step.begin', turnId: 'turn-402', stepUuid: 'step-402' },
    })}\n`, 'utf8');

    const bindings = [{
      id: 'binding-1',
      channelType: 'feishu-default',
      chatId: 'chat-1',
      bridgeSessionId: 'session-1',
      active: true,
    }];
    const session = {
      runtime: { activeRuntime: 'kimi' as const, kimi: { sessionId: 'kimi-thread', cwd: tempRoot } },
      mirror_last_event_at: null,
    };
    const state = {
      running: true,
      adapters: new Map([
        ['feishu-default', { channelType: 'feishu-default', provider: 'feishu', isRunning: () => false }],
      ]),
      mirrorSubscriptions: new Map(),
      mirrorWakeTimer: null,
      mirrorSyncInFlight: false,
      activeTasks: new Map(),
    };
    const delivered: Array<{ status: string; errorText?: string }> = [];
    const mirrorSource = createKimiMirrorJsonlSource();

    runtime = createMirrorRuntime(() => state as never, {
      watchDebounceMs: 0,
      danglingThreadRetryLimit: 3,
      failureSuspendThreshold: 3,
      failureSuspendMs: 60_000,
    }, {
      mirrorSource,
      runtimeLabel: 'Kimi',
      nowIso: () => '2026-07-27T08:14:37.000Z',
      describeUnknownError: (error) => (error instanceof Error ? error.message : String(error)),
      listChannelChats: () => bindings,
      getSession: () => session,
      clearSessionMirrorThreadId: () => {},
      clearSessionCodexThreadId: () => {},
      getCodexSessionByThreadIdSafe: () => null,
      hasSessionMirrorSource: () => true,
      getSessionMirrorThreadId: () => 'kimi-thread',
      getSessionMirrorCwd: () => tempRoot,
      getMirrorSourceSummary: () => ({ threadId: 'kimi-thread', filePath: wirePath, cwd: tempRoot }),
      syncMirrorSessionStateSafe: () => {},
      filterSuppressedMirrorRecords: (_sessionId, records) => records,
      observeSessionHealthRecords: () => {},
      consumeMirrorRecords: (subscription, records) => consumeMirrorRecords(subscription, records),
      flushTimedOutMirrorTurn: (subscription) => flushTimedOutMirrorTurn(subscription, MIRROR_TEST_BUFFER_TIMEOUT_MS, Date.now()),
      hasPendingMirrorWork: (subscription) => hasPendingMirrorWork(subscription),
      consumeBufferedMirrorTurns: (subscription) => consumeBufferedMirrorTurns(subscription, MIRROR_TEST_BUFFER_TIMEOUT_MS, Date.now()),
      stopMirrorStreaming: () => {},
      deliverMirrorTurns: async (_subscription, turns) => {
        delivered.push(...turns.map((turn) => ({ status: turn.status, errorText: turn.errorText })));
        return { deliveredCount: turns.length };
      },
    });

    try {
      await runtime.reconcileMirrorSubscriptions();
      assert.deepEqual(delivered, []);
      fs.writeFileSync(logPath, [
        '2026-07-27T08:14:36.747Z WARN  llm request failed  turnStep=0.1 attempt=1/10 model=k3 errorName=APIStatusError errorMessage="402 membership inactive" statusCode=402',
        '2026-07-27T08:14:36.751Z ERROR turn failed  turnId=0',
        '  APIStatusError: 402 We\'re unable to verify your membership benefits at this time.',
        '    at KimiChatProvider.generate (main.cjs:1:1)',
        '',
      ].join('\n'), 'utf8');

      await runtime.reconcileMirrorSubscriptions();
      assert.deepEqual(delivered, [{
        status: 'error',
        errorText: 'APIStatusError: 402 We\'re unable to verify your membership benefits at this time.',
      }]);
      assert.equal(state.mirrorSubscriptions.get('binding-1')?.pendingTurn, null);

      await runtime.reconcileMirrorSubscriptions();
      assert.equal(delivered.length, 1);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('uses the runtime-neutral clear hook for dangling Claude mirror identities', async () => {
    const bindings = [{
      id: 'binding-1',
      channelType: 'feishu-default',
      chatId: 'chat-1',
      bridgeSessionId: 'session-1',
      active: true,
    }];
    const session = {
      id: 'session-1',
      runtime: {
        activeRuntime: 'claude' as const,
        claude: {
          sessionId: 'missing-claude-session',
          cwd: '/tmp/clk-claude',
        } as { sessionId?: string; cwd?: string },
      },
      mirror_last_event_at: null,
    };
    const state = {
      running: true,
      adapters: new Map([
        ['feishu-default', { channelType: 'feishu-default', provider: 'feishu', isRunning: () => false }],
      ]),
      mirrorSubscriptions: new Map(),
      mirrorWakeTimer: null,
      mirrorSyncInFlight: false,
      activeTasks: new Map(),
    };
    const clearCalls: string[] = [];

    runtime = createMirrorRuntime(() => state as never, {
      watchDebounceMs: 0,
      danglingThreadRetryLimit: 1,
      failureSuspendThreshold: 3,
      failureSuspendMs: 60_000,
    }, {
      mirrorSource: {
        runtime: 'claude',
        findByThreadId: () => null,
        readDelta: () => ({
          records: [],
          nextOffset: 0,
          trailingText: '',
          nextTurnId: null,
          nextSpecialCallIds: [],
          unknownKinds: [],
        }),
      },
      runtimeLabel: 'Claude',
      nowIso: () => '2026-04-21T10:00:00.000Z',
      describeUnknownError: (error) => (error instanceof Error ? error.message : String(error)),
      listChannelChats: () => bindings,
      getSession: (sessionId) => (sessionId === session.id ? session : null),
      clearSessionMirrorThreadId: (sessionId) => {
        clearCalls.push(sessionId);
        session.runtime.claude = {};
      },
      clearSessionCodexThreadId: () => {
        throw new Error('Codex clear hook should not run for Claude mirror');
      },
      getCodexSessionByThreadIdSafe: () => null,
      hasSessionMirrorSource: (candidate) => Boolean(candidate?.runtime?.claude?.sessionId),
      getSessionMirrorThreadId: (candidate) => candidate.runtime?.claude?.sessionId,
      getSessionMirrorCwd: (candidate) => candidate.runtime?.claude?.cwd,
      getMirrorSourceSummary: (source, threadId, cwd) => source.findByThreadId(threadId, cwd || undefined),
      syncMirrorSessionStateSafe: () => {},
      filterSuppressedMirrorRecords: (_sessionId, records) => records,
      observeSessionHealthRecords: () => {},
      consumeMirrorRecords: (subscription, records) => consumeMirrorRecords(subscription, records),
      flushTimedOutMirrorTurn: (subscription) => flushTimedOutMirrorTurn(subscription, MIRROR_TEST_BUFFER_TIMEOUT_MS, Date.now()),
      hasPendingMirrorWork: (subscription) => hasPendingMirrorWork(subscription),
      consumeBufferedMirrorTurns: (subscription) => consumeBufferedMirrorTurns(subscription, MIRROR_TEST_BUFFER_TIMEOUT_MS, Date.now()),
      stopMirrorStreaming: () => {},
      deliverMirrorTurns: async () => ({ deliveredCount: 0 }),
    });

    await runtime.reconcileMirrorSubscriptions();
    await runtime.reconcileMirrorSubscriptions();

    assert.deepEqual(clearCalls, ['session-1']);
    assert.equal(session.runtime.claude.sessionId, undefined);
    assert.equal(state.mirrorSubscriptions.size, 0);
  });

  it('uses the runtime-neutral clear hook for dangling Kimi mirror identities', async () => {
    const bindings = [{
      id: 'binding-1',
      channelType: 'feishu-default',
      chatId: 'chat-1',
      bridgeSessionId: 'session-1',
      active: true,
    }];
    const session = {
      id: 'session-1',
      runtime: {
        activeRuntime: 'kimi' as const,
        kimi: {
          sessionId: 'missing-kimi-session',
          cwd: '/tmp/clk-kimi',
        } as { sessionId?: string; cwd?: string },
      },
      mirror_last_event_at: null,
    };
    const state = {
      running: true,
      adapters: new Map([
        ['feishu-default', { channelType: 'feishu-default', provider: 'feishu', isRunning: () => false }],
      ]),
      mirrorSubscriptions: new Map(),
      mirrorWakeTimer: null,
      mirrorSyncInFlight: false,
      activeTasks: new Map(),
    };
    const clearCalls: string[] = [];

    runtime = createMirrorRuntime(() => state as never, {
      watchDebounceMs: 0,
      danglingThreadRetryLimit: 1,
      failureSuspendThreshold: 3,
      failureSuspendMs: 60_000,
    }, {
      mirrorSource: {
        runtime: 'kimi',
        findByThreadId: () => null,
        readDelta: () => ({
          records: [],
          nextOffset: 0,
          trailingText: '',
          nextTurnId: null,
          nextSpecialCallIds: [],
          unknownKinds: [],
        }),
      },
      runtimeLabel: 'Kimi',
      nowIso: () => '2026-04-21T10:00:00.000Z',
      describeUnknownError: (error) => (error instanceof Error ? error.message : String(error)),
      listChannelChats: () => bindings,
      getSession: (sessionId) => (sessionId === session.id ? session : null),
      clearSessionMirrorThreadId: (sessionId) => {
        clearCalls.push(sessionId);
        session.runtime.kimi = {};
      },
      clearSessionCodexThreadId: () => {
        throw new Error('Codex clear hook should not run for Kimi mirror');
      },
      getCodexSessionByThreadIdSafe: () => null,
      hasSessionMirrorSource: (candidate) => Boolean(candidate?.runtime?.kimi?.sessionId),
      getSessionMirrorThreadId: (candidate) => candidate.runtime?.kimi?.sessionId,
      getSessionMirrorCwd: (candidate) => candidate.runtime?.kimi?.cwd,
      getMirrorSourceSummary: (source, threadId, cwd) => source.findByThreadId(threadId, cwd || undefined),
      syncMirrorSessionStateSafe: () => {},
      filterSuppressedMirrorRecords: (_sessionId, records) => records,
      observeSessionHealthRecords: () => {},
      consumeMirrorRecords: (subscription, records) => consumeMirrorRecords(subscription, records),
      flushTimedOutMirrorTurn: (subscription) => flushTimedOutMirrorTurn(subscription, MIRROR_TEST_BUFFER_TIMEOUT_MS, Date.now()),
      hasPendingMirrorWork: (subscription) => hasPendingMirrorWork(subscription),
      consumeBufferedMirrorTurns: (subscription) => consumeBufferedMirrorTurns(subscription, MIRROR_TEST_BUFFER_TIMEOUT_MS, Date.now()),
      stopMirrorStreaming: () => {},
      deliverMirrorTurns: async () => ({ deliveredCount: 0 }),
    });

    await runtime.reconcileMirrorSubscriptions();
    await runtime.reconcileMirrorSubscriptions();

    assert.deepEqual(clearCalls, ['session-1']);
    assert.equal(session.runtime.kimi.sessionId, undefined);
    assert.equal(state.mirrorSubscriptions.size, 0);
  });

  it('logs slow mirror reconcile stages around downstream routing and delivery waits', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-mirror-runtime-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    fs.writeFileSync(filePath, '', 'utf-8');

    const bindings = [{
      id: 'binding-1',
      channelType: 'feishu-default',
      chatId: 'chat-1',
      bridgeSessionId: 'session-1',
      active: true,
    }];
    const session = {
      id: 'session-1',
      runtime: { codex: { threadId: 'thread-1' } },
      mirror_last_event_at: null,
    };
    const state = {
      running: true,
      adapters: new Map([
        ['feishu-default', { channelType: 'feishu-default', provider: 'feishu', isRunning: () => false }],
      ]),
      mirrorSubscriptions: new Map(),
      mirrorWakeTimer: null,
      mirrorSyncInFlight: false,
      activeTasks: new Map(),
    };
    const warnCalls: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnCalls.push(args);
    };

    runtime = createMirrorRuntime(() => state as never, {
      watchDebounceMs: 0,
      danglingThreadRetryLimit: 3,
      failureSuspendThreshold: 3,
      failureSuspendMs: 60_000,
      slowReconcileSubscriptionMs: 1,
    }, {
      nowIso: () => '2026-04-21T10:00:00.000Z',
      describeUnknownError: (error) => (error instanceof Error ? error.message : String(error)),
      listChannelChats: () => bindings,
      getSession: (sessionId) => (sessionId === session.id ? session : null),
      clearSessionCodexThreadId: () => {},
      getCodexSessionByThreadIdSafe: (threadId) => (
        threadId === 'thread-1'
          ? {
              id: threadId,
              filePath,
            } as never
          : null
      ),
      syncMirrorSessionStateSafe: () => {},
      filterSuppressedMirrorRecords: (_sessionId, records) => records,
      observeSessionHealthRecords: () => {},
      routeCodexRecords: async (_sessionId, _threadId, records) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { claimed: [], unclaimed: records, terminalClaimed: false };
      },
      consumeMirrorRecords: (subscription, records) => consumeMirrorRecords(subscription, records),
      flushTimedOutMirrorTurn: (subscription) => flushTimedOutMirrorTurn(subscription, MIRROR_TEST_BUFFER_TIMEOUT_MS, Date.now()),
      hasPendingMirrorWork: (subscription) => hasPendingMirrorWork(subscription),
      consumeBufferedMirrorTurns: (subscription) => consumeBufferedMirrorTurns(subscription, MIRROR_TEST_BUFFER_TIMEOUT_MS, Date.now()),
      stopMirrorStreaming: () => {},
      deliverMirrorTurns: async (_subscription, turns) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { deliveredCount: turns.length };
      },
    });

    try {
      await runtime.reconcileMirrorSubscriptions();
      fs.appendFileSync(filePath, [
        JSON.stringify({
          timestamp: '2026-04-21T10:00:01.000Z',
          type: 'event_msg',
          payload: {
            type: 'task_started',
            turn_id: 'turn-1',
          },
        }),
        JSON.stringify({
          timestamp: '2026-04-21T10:00:02.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'final answer' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-04-21T10:00:03.000Z',
          type: 'event_msg',
          payload: {
            type: 'task_complete',
            turn_id: 'turn-1',
            last_agent_message: 'final answer',
          },
        }),
      ].join('\n') + '\n', 'utf-8');
      await runtime.reconcileMirrorSubscriptions();
    } finally {
      console.warn = originalWarn;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }

    const stageSummaries = warnCalls
      .map((entry) => entry[1])
      .filter((entry): entry is Record<string, unknown> => (
        Boolean(entry)
        && typeof entry === 'object'
        && (entry as Record<string, unknown>).event === 'perf.mirror.subscription_stage'
      ));
    assert.ok(stageSummaries.some((entry) => entry.stage === 'route_records'));
    assert.ok(stageSummaries.some((entry) => entry.stage === 'deliver_turns'));
  });
});
