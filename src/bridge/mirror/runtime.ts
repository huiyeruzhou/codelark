import fs from 'node:fs';

import type {
  BridgeMirrorRecord,
  CodexSessionSummary,
} from '../../runtime/codex/session-index.js';
import { createCodexMirrorJsonlSource } from '../../runtime/codex/session-index/mirror-source.js';
import type { BaseChannelAdapter } from '../../channels/contracts.js';
import {
  enqueuePendingMirrorDeliveries,
  removePendingMirrorDeliveries,
  selectPendingMirrorDeliveries,
  type FinalizedBridgeMirrorTurn,
} from './turns.js';
import type { BridgeMirrorSubscription } from './subscription-state.js';
import {
  clearMirrorSubscriptionFailure,
  createMirrorSubscription,
  recordMirrorSubscriptionFailure,
  updateMirrorSubscription,
} from './subscription-state.js';
import {
  isMirrorSnapshotUnchanged,
  markMirrorSnapshotMissing,
  readMirrorDeliverableRecords,
  refreshMirrorSubscriptionSource,
  statMirrorFile,
} from './reconcile-core.js';
import { buildMirrorDeliveryPlan } from './delivery-plan.js';
import {
  buildMirrorSubscriptionRegistryPlan,
  getMirrorRegistryBindingActivityTier,
} from './subscription-registry.js';
import { runMirrorReconcileBatch, type MirrorReconcileStatus } from './reconcile-batch.js';
import { getSessionCodexThreadId } from '../../domain/session-runtime.js';
import type { MirrorJsonlSource, MirrorJsonlSourceSummary } from '../../runtime/contracts.js';
import type { BridgeTurnRuntime } from '../turn/turn-types.js';

export interface BridgeMirrorRuntimeState {
  running: boolean;
  adapters: Map<string, BaseChannelAdapter>;
  mirrorSubscriptions: Map<string, BridgeMirrorSubscription>;
  mirrorWakeTimer: NodeJS.Timeout | null;
  mirrorSyncInFlight: boolean;
  activeTasks: Map<string, unknown>;
}

export interface MirrorRuntimeBinding {
  id: string;
  channelType: string;
  chatId: string;
  bridgeSessionId: string;
  createdAt?: string;
  updatedAt?: string;
  lastActivityAt?: string;
}

export interface MirrorRuntimeSession {
  runtime?: {
    activeRuntime?: 'codex' | 'claude' | 'kimi' | 'cursor';
    codex?: {
      threadId?: string | null;
    };
    claude?: {
      sessionId?: string | null;
      cwd?: string | null;
    };
    kimi?: {
      sessionId?: string | null;
      cwd?: string | null;
    };
    cursor?: {
      sessionId?: string | null;
      cwd?: string | null;
    };
    general?: {
      workingDirectory?: string;
    };
  };
  mirror_last_event_at?: string | null;
}

export interface CreateMirrorRuntimeOptions {
  watchDebounceMs: number;
  danglingThreadRetryLimit: number;
  failureSuspendThreshold: number;
  failureSuspendMs: number;
  reconcileConcurrency?: number;
  slowReconcileSubscriptionMs?: number;
  activeBindingWindowMs?: number;
  coldReconcileIntervalMs?: number;
}

export interface CreateMirrorRuntimeDeps {
  mirrorSource?: MirrorJsonlSource;
  runtimeLabel?: string;
  nowIso(): string;
  describeUnknownError(error: unknown): string;
  listChannelChats(): MirrorRuntimeBinding[];
  getSession(sessionId: string): MirrorRuntimeSession | null | undefined;
  clearSessionMirrorThreadId?(sessionId: string): void;
  clearSessionCodexThreadId(sessionId: string): void;
  getCodexSessionByThreadIdSafe(threadId: string, context: string): CodexSessionSummary | null;
  getSessionMirrorThreadId?(session: MirrorRuntimeSession): string | null | undefined;
  getSessionMirrorCwd?(session: MirrorRuntimeSession): string | null | undefined;
  getMirrorSourceSummary?(
    source: MirrorJsonlSource,
    threadId: string,
    cwd: string | null | undefined,
    context: string,
  ): MirrorJsonlSourceSummary | null;
  hasSessionMirrorSource?(session: MirrorRuntimeSession | null | undefined): boolean;
  syncMirrorSessionStateSafe(sessionId: string, context: string): void;
  filterSuppressedMirrorRecords(sessionId: string, records: BridgeMirrorRecord[]): BridgeMirrorRecord[];
  observeSessionHealthRecords(sessionId: string, threadId: string, records: BridgeMirrorRecord[]): void;
  routeRuntimeRecords?(
    runtime: BridgeTurnRuntime,
    sessionId: string,
    threadId: string,
    records: BridgeMirrorRecord[],
  ): Promise<{ claimed: BridgeMirrorRecord[]; unclaimed: BridgeMirrorRecord[]; terminalClaimed: boolean }>;
  routeCodexRecords?(
    sessionId: string,
    threadId: string,
    records: BridgeMirrorRecord[],
  ): Promise<{ claimed: BridgeMirrorRecord[]; unclaimed: BridgeMirrorRecord[]; terminalClaimed: boolean }>;
  consumeMirrorRecords(subscription: BridgeMirrorSubscription, records: BridgeMirrorRecord[]): FinalizedBridgeMirrorTurn[];
  flushTimedOutMirrorTurn(subscription: BridgeMirrorSubscription): FinalizedBridgeMirrorTurn | null;
  hasPendingMirrorWork(subscription: BridgeMirrorSubscription): boolean;
  consumeBufferedMirrorTurns(subscription: BridgeMirrorSubscription): FinalizedBridgeMirrorTurn[];
  stopMirrorStreaming(
    subscription: BridgeMirrorSubscription,
    status?: 'completed' | 'interrupted',
  ): void;
  deliverMirrorTurns(
    subscription: BridgeMirrorSubscription,
    turns: FinalizedBridgeMirrorTurn[],
  ): Promise<{ deliveredCount: number; error?: unknown }>;
}

export interface MirrorRuntime {
  resetMirrorSessionForInteractiveRun(sessionId: string): void;
  reconcileMirrorSubscriptions(): Promise<void>;
  clearMirrorSubscriptions(): void;
}

export function createMirrorRuntime(
  getState: () => BridgeMirrorRuntimeState,
  options: CreateMirrorRuntimeOptions,
  deps: CreateMirrorRuntimeDeps,
): MirrorRuntime {
  const mirrorSource = deps.mirrorSource || createCodexMirrorJsonlSource();
  const runtimeLabel = deps.runtimeLabel || 'Codex';
  const runtimeName: BridgeTurnRuntime = mirrorSource.runtime;
  const getSessionMirrorThreadId = deps.getSessionMirrorThreadId
    || ((session: MirrorRuntimeSession) => getSessionCodexThreadId(session));
  const hasSessionMirrorSource = deps.hasSessionMirrorSource
    || ((session: MirrorRuntimeSession | null | undefined) => Boolean(getSessionCodexThreadId(session)));
  const getSessionMirrorCwd = deps.getSessionMirrorCwd
    || ((_session: MirrorRuntimeSession) => undefined);
  const getMirrorSourceSummary = deps.getMirrorSourceSummary
    || ((_source: MirrorJsonlSource, threadId: string, _cwd: string | null | undefined, context: string) => {
      const summary = deps.getCodexSessionByThreadIdSafe(threadId, context);
      return summary
        ? {
          threadId: summary.threadId,
          filePath: summary.filePath,
          cwd: summary.cwd,
          updatedAt: summary.lastEventAt,
        }
        : null;
    });
  const clearSessionMirrorThreadId = deps.clearSessionMirrorThreadId || deps.clearSessionCodexThreadId;

  function logSlowMirrorSubscriptionStage(
    subscription: BridgeMirrorSubscription,
    stage: string,
    elapsedMs: number,
    extra: Record<string, unknown> = {},
  ): void {
    const thresholdMs = Math.max(1, options.slowReconcileSubscriptionMs || 60_000);
    if (elapsedMs < thresholdMs) return;
    console.warn(`[bridge-manager] Slow ${runtimeLabel} mirror subscription reconcile stage:`, {
      event: 'perf.mirror.subscription_stage',
      runtime: runtimeName,
      runtime_label: runtimeLabel,
      stage,
      binding_id: subscription.bindingId,
      bindingId: subscription.bindingId,
      session_id: subscription.sessionId ?? null,
      sessionId: subscription.sessionId ?? null,
      thread_id: subscription.threadId ?? null,
      threadId: subscription.threadId ?? null,
      duration_ms: elapsedMs,
      elapsedMs,
      ...extra,
    });
  }

  async function measureMirrorSubscriptionStage<T>(
    subscription: BridgeMirrorSubscription,
    stage: string,
    work: () => Promise<T>,
    extra: Record<string, unknown> = {},
  ): Promise<T> {
    const startedAt = Date.now();
    try {
      return await work();
    } finally {
      logSlowMirrorSubscriptionStage(subscription, stage, Date.now() - startedAt, extra);
    }
  }

  function closeMirrorWatcher(subscription: BridgeMirrorSubscription): void {
    if (subscription.watcher) {
      try {
        subscription.watcher.close();
      } catch {
        // best effort
      }
    }
    subscription.watcher = null;
    subscription.watcherTarget = null;
  }

  function scheduleMirrorWake(delayMs = options.watchDebounceMs): void {
    const state = getState();
    if (!state.running) return;
    if (state.mirrorWakeTimer) return;

    state.mirrorWakeTimer = setTimeout(() => {
      state.mirrorWakeTimer = null;
      void reconcileMirrorSubscriptions().catch((err) => {
        console.error('[bridge-manager] Mirror wake reconcile failed:', deps.describeUnknownError(err));
      });
    }, delayMs);
  }

  function watchMirrorFile(subscription: BridgeMirrorSubscription, filePath: string | null): void {
    if (!filePath) {
      closeMirrorWatcher(subscription);
      return;
    }
    if (subscription.watcherTarget === filePath && subscription.watcher) {
      return;
    }

    closeMirrorWatcher(subscription);
    try {
      subscription.watcher = fs.watch(filePath, () => {
        subscription.dirty = true;
        scheduleMirrorWake();
      });
      subscription.watcherTarget = filePath;
    } catch {
      subscription.watcher = null;
      subscription.watcherTarget = null;
    }
  }

  function removeMirrorSubscription(bindingId: string): void {
    const state = getState();
    const existing = state.mirrorSubscriptions.get(bindingId);
    if (!existing) return;
    deps.stopMirrorStreaming(existing);
    closeMirrorWatcher(existing);
    state.mirrorSubscriptions.delete(bindingId);
    deps.syncMirrorSessionStateSafe(existing.sessionId, 'mirror subscription removal');
  }

  function clearDanglingMirrorThread(subscription: BridgeMirrorSubscription, reason: string): void {
    const session = deps.getSession(subscription.sessionId);
    const currentThreadId = getSessionCodexThreadId(session) || subscription.threadId;
    console.warn(
      `[bridge-manager] Clearing dangling ${runtimeLabel} thread ${currentThreadId} for session ${subscription.sessionId}: ${reason}`,
    );
    clearSessionMirrorThreadId(subscription.sessionId);
    removeMirrorSubscription(subscription.bindingId);
  }

  function upsertMirrorSubscription(binding: MirrorRuntimeBinding): void {
    const state = getState();
    const session = deps.getSession(binding.bridgeSessionId);
    if (!session) {
      removeMirrorSubscription(binding.id);
      return;
    }

    const threadId = getSessionMirrorThreadId(session)?.trim() || '';
    if (!threadId) {
      removeMirrorSubscription(binding.id);
      return;
    }

    const existing = state.mirrorSubscriptions.get(binding.id);
    const filePath = existing?.threadId === threadId && existing.filePath
      ? existing.filePath
      : getMirrorSourceSummary(
          mirrorSource,
          threadId,
          getSessionMirrorCwd(session),
          'mirror subscription sync',
        )?.filePath || null;
    const activityTier = getMirrorRegistryBindingActivityTier(binding, {
      activeBindingWindowMs: options.activeBindingWindowMs,
      nowMs: Date.now(),
    });

    if (!existing) {
      const created = createMirrorSubscription({
        bindingId: binding.id,
        sessionId: binding.bridgeSessionId,
        channelType: binding.channelType,
        chatId: binding.chatId,
        threadId,
        filePath,
        lastDeliveredAt: session.mirror_last_event_at || null,
        activityTier,
      });
      watchMirrorFile(created, filePath);
      state.mirrorSubscriptions.set(binding.id, created);
      deps.syncMirrorSessionStateSafe(binding.bridgeSessionId, 'mirror subscription create');
      return;
    }

    const { previousSessionId, threadChanged, filePathChanged } = updateMirrorSubscription(existing, {
      sessionId: binding.bridgeSessionId,
      channelType: binding.channelType,
      chatId: binding.chatId,
      threadId,
      filePath,
      lastDeliveredAt: session.mirror_last_event_at || null,
      activityTier,
    });
    if (threadChanged || filePathChanged) {
      deps.stopMirrorStreaming(existing);
    }
    watchMirrorFile(existing, filePath);
    if (previousSessionId !== binding.bridgeSessionId) {
      deps.syncMirrorSessionStateSafe(previousSessionId, 'mirror subscription rebind previous session');
    }
    deps.syncMirrorSessionStateSafe(binding.bridgeSessionId, 'mirror subscription upsert');
  }

  function syncMirrorSubscriptionSet(): void {
    const state = getState();
    const plan = buildMirrorSubscriptionRegistryPlan(
      deps.listChannelChats(),
      state.adapters.keys(),
      state.mirrorSubscriptions.keys(),
      deps.getSession,
      hasSessionMirrorSource,
      {
        activeBindingWindowMs: options.activeBindingWindowMs,
        nowMs: Date.now(),
      },
    );

    for (const binding of plan.upsertBindings) {
      try {
        upsertMirrorSubscription(binding);
      } catch (error) {
        console.error(
          `[bridge-manager] Failed to sync mirror subscription for binding ${binding.id}:`,
          error,
        );
      }
    }

    for (const bindingId of plan.removeBindingIds) {
      removeMirrorSubscription(bindingId);
    }
  }

  async function reconcileMirrorSubscription(
    subscription: BridgeMirrorSubscription,
  ): Promise<MirrorReconcileStatus> {
    const session = deps.getSession(subscription.sessionId);
    if (!session) {
      removeMirrorSubscription(subscription.bindingId);
      return 'processed';
    }

    if (subscription.suspendedUntil && Date.now() < subscription.suspendedUntil) {
      deps.syncMirrorSessionStateSafe(subscription.sessionId, 'mirror suspension');
      return 'suspended';
    }
    if (subscription.suspendedUntil) {
      subscription.suspendedUntil = null;
    }

    let snapshot = subscription.filePath ? statMirrorFile(subscription.filePath) : null;
    if (!snapshot) {
      const sourceSummary = getMirrorSourceSummary(
        mirrorSource,
        subscription.threadId,
        getSessionMirrorCwd(session),
        'mirror reconcile',
      );
      if (!sourceSummary) {
        subscription.missingThreadPolls += 1;
        if (subscription.missingThreadPolls >= options.danglingThreadRetryLimit) {
          clearDanglingMirrorThread(subscription, `${runtimeLabel} thread no longer exists locally`);
          return 'processed';
        }
      } else {
        subscription.missingThreadPolls = 0;
      }
      refreshMirrorSubscriptionSource(subscription, sourceSummary?.filePath || null, deps.nowIso());
      watchMirrorFile(subscription, subscription.filePath);

      if (!subscription.filePath) {
        deps.syncMirrorSessionStateSafe(subscription.sessionId, 'mirror reconcile without file');
        return 'processed';
      }
      snapshot = statMirrorFile(subscription.filePath);
    } else {
      subscription.missingThreadPolls = 0;
      subscription.lastReconciledAt = deps.nowIso();
    }

    if (!snapshot) {
      markMirrorSnapshotMissing(subscription);
      deps.syncMirrorSessionStateSafe(subscription.sessionId, 'mirror reconcile missing snapshot');
      return 'processed';
    }

    const unchanged = isMirrorSnapshotUnchanged(subscription, snapshot);
    if (unchanged && !deps.hasPendingMirrorWork(subscription) && !mirrorSource.readSupplementalDelta) {
      deps.syncMirrorSessionStateSafe(subscription.sessionId, 'mirror reconcile unchanged snapshot');
      return 'processed';
    }

    const readResult = readMirrorDeliverableRecords(subscription, snapshot, mirrorSource);
    const deliverableRecords = readResult.records;
    for (const kind of readResult.unknownKinds) {
      if (subscription.unknownMirrorKindsSeen.has(kind)) continue;
      subscription.unknownMirrorKindsSeen.add(kind);
      console.warn(
        `[bridge-manager] Unhandled ${runtimeLabel} mirror event for thread ${subscription.threadId}: ${kind}`,
      );
    }
    const unsuppressedRecords = deliverableRecords.length > 0
      ? deps.filterSuppressedMirrorRecords(subscription.sessionId, deliverableRecords)
      : deliverableRecords;
    let routeResult: { claimed: BridgeMirrorRecord[]; unclaimed: BridgeMirrorRecord[]; terminalClaimed: boolean };
    if (unsuppressedRecords.length > 0 && deps.routeRuntimeRecords) {
      routeResult = await measureMirrorSubscriptionStage(
        subscription,
        'route_records',
        () => deps.routeRuntimeRecords!(runtimeName, subscription.sessionId, subscription.threadId, unsuppressedRecords),
        { record_count: unsuppressedRecords.length, recordCount: unsuppressedRecords.length },
      );
    } else if (unsuppressedRecords.length > 0 && deps.routeCodexRecords) {
      routeResult = await measureMirrorSubscriptionStage(
        subscription,
        'route_records',
        () => deps.routeCodexRecords!(subscription.sessionId, subscription.threadId, unsuppressedRecords),
        { record_count: unsuppressedRecords.length, recordCount: unsuppressedRecords.length },
      );
    } else {
      routeResult = { claimed: [], unclaimed: unsuppressedRecords, terminalClaimed: false };
    }
    const mirrorRecords = routeResult.terminalClaimed
      ? unsuppressedRecords
      : routeResult.unclaimed;

    if (mirrorRecords.length > 0) {
      deps.observeSessionHealthRecords(subscription.sessionId, subscription.threadId, mirrorRecords);
    }
    const blocked = getState().activeTasks.has(subscription.sessionId);
    const deliveryPlan = buildMirrorDeliveryPlan(subscription, mirrorRecords, {
      blocked,
      filterSuppressedRecords: deps.filterSuppressedMirrorRecords,
      flushTimedOutTurn: (currentSubscription) => deps.flushTimedOutMirrorTurn(currentSubscription),
      consumeBufferedTurns: (currentSubscription) => deps.consumeBufferedMirrorTurns(currentSubscription),
    });

    if (deliveryPlan.finalizedTurns.length > 0) {
      enqueuePendingMirrorDeliveries(subscription, deliveryPlan.finalizedTurns);
    }

    const turnsToAttempt = selectPendingMirrorDeliveries(subscription, blocked);
    if (turnsToAttempt.length > 0) {
      const deliveryResult = await measureMirrorSubscriptionStage(
        subscription,
        'deliver_turns',
        () => deps.deliverMirrorTurns(subscription, turnsToAttempt),
        { turn_count: turnsToAttempt.length, turnCount: turnsToAttempt.length },
      );
      if (deliveryResult.deliveredCount > 0) {
        removePendingMirrorDeliveries(subscription, turnsToAttempt.slice(0, deliveryResult.deliveredCount));
      }
      if (deliveryResult.error) {
        const error = deliveryResult.error;
        console.warn('[bridge-manager] Mirror delivery failed:', error instanceof Error ? error.message : error);
      }
    }

    deps.syncMirrorSessionStateSafe(subscription.sessionId, deliveryPlan.syncReason);
    return 'processed';
  }

  async function handleMirrorSubscriptionReconcileFailure(
    subscription: BridgeMirrorSubscription,
    error: unknown,
  ): Promise<void> {
    try {
      deps.stopMirrorStreaming(subscription, 'interrupted');
      const suspended = recordMirrorSubscriptionFailure(
        subscription,
        options.failureSuspendThreshold,
        options.failureSuspendMs,
      );
      if (suspended) {
        console.warn(
          `[bridge-manager] Mirror subscription for thread ${subscription.threadId} is suspended for ${Math.round(options.failureSuspendMs / 1000)}s after ${subscription.consecutiveFailures} consecutive failures`,
        );
      }
      console.error(
        `[bridge-manager] Mirror reconcile failed for thread ${subscription.threadId}:`,
        deps.describeUnknownError(error),
      );
      deps.syncMirrorSessionStateSafe(subscription.sessionId, 'mirror reconcile failure');
    } catch (recoveryError) {
      console.error(
        `[bridge-manager] Mirror reconcile recovery failed for thread ${subscription.threadId}:`,
        deps.describeUnknownError(recoveryError),
      );
      console.error(
        `[bridge-manager] Original mirror reconcile error for thread ${subscription.threadId}:`,
        deps.describeUnknownError(error),
      );
    }
  }

  function hasColdSubscriptionDue(subscription: BridgeMirrorSubscription, nowMs: number): boolean {
    if (subscription.activityTier !== 'cold') return true;
    if (subscription.dirty || deps.hasPendingMirrorWork(subscription)) return true;
    if (subscription.pendingDeliveries.length > 0) return true;
    return !subscription.nextColdReconcileAt || nowMs >= subscription.nextColdReconcileAt;
  }

  function selectSubscriptionsForReconcile(subscriptions: BridgeMirrorSubscription[]): BridgeMirrorSubscription[] {
    const nowMs = Date.now();
    return subscriptions.filter((subscription) => hasColdSubscriptionDue(subscription, nowMs));
  }

  async function reconcileMirrorSubscriptions(): Promise<void> {
    const state = getState();
    if (!state.running || state.mirrorSyncInFlight) return;
    state.mirrorSyncInFlight = true;

    try {
      await runMirrorReconcileBatch({
        syncSubscriptionSet: syncMirrorSubscriptionSet,
        getSubscriptions: () => selectSubscriptionsForReconcile(Array.from(state.mirrorSubscriptions.values())),
        reconcileSubscription: async (subscription) => {
          const result = await reconcileMirrorSubscription(subscription);
          if (subscription.activityTier === 'cold') {
            const intervalMs = Math.max(1, options.coldReconcileIntervalMs || 60_000);
            subscription.nextColdReconcileAt = Date.now() + intervalMs;
          }
          return result;
        },
        clearFailureState: clearMirrorSubscriptionFailure,
        handleFailure: handleMirrorSubscriptionReconcileFailure,
        logBatchError: (stage, error) => {
          console.error(
            `[bridge-manager] Mirror reconcile failed during ${stage}:`,
            deps.describeUnknownError(error),
          );
        },
        concurrency: options.reconcileConcurrency,
        slowSubscriptionThresholdMs: options.slowReconcileSubscriptionMs,
        logSlowSubscription: (summary) => {
          console.warn(`[bridge-manager] Slow ${runtimeLabel} mirror subscription reconcile:`, {
            event: 'perf.mirror.subscription',
            runtime: runtimeName,
            runtime_label: runtimeLabel,
            status: summary.status,
            binding_id: summary.bindingId,
            bindingId: summary.bindingId,
            session_id: summary.sessionId ?? null,
            sessionId: summary.sessionId ?? null,
            thread_id: summary.threadId ?? null,
            threadId: summary.threadId ?? null,
            duration_ms: summary.elapsedMs,
            elapsedMs: summary.elapsedMs,
          });
        },
        logBatchSummary: (summary) => {
          const hasProblem = summary.failed > 0 || summary.suspended > 0;
          if (summary.total === 0 || (!hasProblem && summary.elapsedMs < 5_000)) return;
          console.log(`[bridge-manager] ${runtimeLabel} mirror reconcile batch summary:`, {
            event: 'perf.mirror.batch',
            runtime: runtimeName,
            runtime_label: runtimeLabel,
            status: hasProblem ? 'attention' : 'slow',
            total: summary.total,
            processed: summary.processed,
            suspended: summary.suspended,
            failed: summary.failed,
            concurrency: summary.concurrency,
            duration_ms: summary.elapsedMs,
            elapsedMs: summary.elapsedMs,
          });
        },
      });
    } finally {
      state.mirrorSyncInFlight = false;
    }
  }

  function clearMirrorSubscriptions(): void {
    const state = getState();
    for (const bindingId of Array.from(state.mirrorSubscriptions.keys())) {
      removeMirrorSubscription(bindingId);
    }
  }

  function resetMirrorSessionForInteractiveRun(sessionId: string): void {
    const state = getState();
    for (const subscription of state.mirrorSubscriptions.values()) {
      if (subscription.sessionId !== sessionId) continue;
      deps.stopMirrorStreaming(subscription, 'interrupted');
      if (subscription.pendingTurn) {
        subscription.pendingTurn.streamStarted = false;
      }
    }
  }

  return {
    resetMirrorSessionForInteractiveRun,
    reconcileMirrorSubscriptions,
    clearMirrorSubscriptions,
  };
}
