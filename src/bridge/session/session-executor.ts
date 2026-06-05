import { getLogger } from '../../shared/logger.js';

export interface SessionExecutorState {
  queuedCounts: Map<string, number>;
  sessionLocks: Map<string, Promise<void>>;
}

export interface SessionExecutorJobOptions {
  jobKind?: string;
}

export interface CreateSessionExecutorDeps {
  onQueuedCountChanged(sessionId: string): void;
  nowMs?: () => number;
  sessionTurnCooldownMs?: number;
}

export interface SessionExecutor {
  enqueue(sessionId: string, job: () => Promise<void>, options?: SessionExecutorJobOptions): Promise<void>;
  getActive(sessionId: string): boolean;
  getQueuedCount(sessionId: string): number;
  cancel(sessionId: string): void;
  clear(): void;
}

const DEFAULT_SESSION_TURN_COOLDOWN_MS = 1_500;
const SESSION_EXECUTOR_SLOW_WAIT_MS = 1_000;
const SESSION_EXECUTOR_SLOW_RUN_MS = 2_000;
const logger = getLogger('session-executor').child({ component: 'bridge-session-executor' });

export function createSessionExecutor(
  getState: () => SessionExecutorState,
  deps: CreateSessionExecutorDeps,
): SessionExecutor {
  const sessionLockVersions = new Map<string, number>();
  const lastSessionTaskFinishedAt = new Map<string, number>();
  const sessionTurnCooldownMs = Math.max(
    0,
    deps.sessionTurnCooldownMs ?? DEFAULT_SESSION_TURN_COOLDOWN_MS,
  );

  function nowMs(): number {
    return deps.nowMs?.() ?? Date.now();
  }

  function getSessionLockVersion(sessionId: string): number {
    return sessionLockVersions.get(sessionId) || 0;
  }

  function invalidateSessionLockQueue(sessionId: string): void {
    sessionLockVersions.set(sessionId, getSessionLockVersion(sessionId) + 1);
  }

  function getQueuedCount(sessionId: string): number {
    return getState().queuedCounts.get(sessionId) || 0;
  }

  function incrementQueuedCount(sessionId: string): number {
    const state = getState();
    const next = getQueuedCount(sessionId) + 1;
    state.queuedCounts.set(sessionId, next);
    deps.onQueuedCountChanged(sessionId);
    return next;
  }

  function decrementQueuedCount(sessionId: string): number {
    const state = getState();
    const next = Math.max(0, getQueuedCount(sessionId) - 1);
    if (next > 0) {
      state.queuedCounts.set(sessionId, next);
    } else {
      state.queuedCounts.delete(sessionId);
    }
    deps.onQueuedCountChanged(sessionId);
    return next;
  }

  function logExecutorEvent(
    level: 'info' | 'warn' | 'error',
    event: string,
    fields: Record<string, unknown>,
    message: string,
  ): void {
    logger[level]({
      event,
      ...fields,
    }, message);
  }

  function enqueue(sessionId: string, job: () => Promise<void>, options: SessionExecutorJobOptions = {}): Promise<void> {
    const state = getState();
    const scheduledAtMs = nowMs();
    const previous = state.sessionLocks.get(sessionId) || Promise.resolve();
    const hasActiveTail = state.sessionLocks.has(sessionId);
    const queuedBefore = getQueuedCount(sessionId);
    const queuedAfter = hasActiveTail ? incrementQueuedCount(sessionId) : queuedBefore;
    const lockVersion = getSessionLockVersion(sessionId);
    const jobKind = options.jobKind || 'session';

    logExecutorEvent('info', 'session.executor.scheduled', {
      session_id: sessionId,
      job_kind: jobKind,
      queued_before: queuedBefore,
      queued_after: queuedAfter,
      has_active_tail: hasActiveTail,
      scheduled_at_ms: scheduledAtMs,
    }, 'session job scheduled');

    const wrapped = async () => {
      if (getSessionLockVersion(sessionId) !== lockVersion) return;
      const readyAtMs = nowMs();
      const rawWaitMs = readyAtMs - scheduledAtMs;
      const lastFinishedAt = lastSessionTaskFinishedAt.get(sessionId);
      if (lastFinishedAt && sessionTurnCooldownMs > 0) {
        const remainingMs = sessionTurnCooldownMs - (nowMs() - lastFinishedAt);
        if (remainingMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, remainingMs));
        }
      }
      const startedAtMs = nowMs();
      const waitMs = startedAtMs - scheduledAtMs;
      if (hasActiveTail) {
        decrementQueuedCount(sessionId);
      }
      if (getSessionLockVersion(sessionId) !== lockVersion) return;

      const startedFields = {
        session_id: sessionId,
        job_kind: jobKind,
        queued_before: queuedBefore,
        queued_after_start: getQueuedCount(sessionId),
        wait_ms: waitMs,
        raw_wait_ms: rawWaitMs,
        scheduled_at_ms: scheduledAtMs,
        started_at_ms: startedAtMs,
      };
      logExecutorEvent(
        waitMs >= SESSION_EXECUTOR_SLOW_WAIT_MS ? 'warn' : 'info',
        'session.executor.started',
        startedFields,
        waitMs >= SESSION_EXECUTOR_SLOW_WAIT_MS ? 'slow session job wait' : 'session job started',
      );

      let status: 'success' | 'error' = 'success';
      let errorMessage: string | undefined;
      try {
        await job();
      } catch (err) {
        status = 'error';
        errorMessage = err instanceof Error ? err.message : String(err);
        throw err;
      } finally {
        const finishedAtMs = nowMs();
        const runMs = finishedAtMs - startedAtMs;
        lastSessionTaskFinishedAt.set(sessionId, finishedAtMs);
        logExecutorEvent(
          runMs >= SESSION_EXECUTOR_SLOW_RUN_MS || status === 'error' ? 'warn' : 'info',
          'session.executor.finished',
          {
            ...startedFields,
            status,
            run_ms: runMs,
            duration_ms: runMs,
            finished_at_ms: finishedAtMs,
            ...(errorMessage ? { error: errorMessage } : {}),
          },
          runMs >= SESSION_EXECUTOR_SLOW_RUN_MS ? 'slow session job run' : 'session job finished',
        );
      }
    };

    const current = previous.then(wrapped, wrapped);
    state.sessionLocks.set(sessionId, current);
    current.finally(() => {
      if (state.sessionLocks.get(sessionId) === current) {
        state.sessionLocks.delete(sessionId);
      }
    }).catch(() => {});
    return current;
  }

  function cancel(sessionId: string): void {
    const state = getState();
    state.queuedCounts.delete(sessionId);
    state.sessionLocks.delete(sessionId);
    invalidateSessionLockQueue(sessionId);
    deps.onQueuedCountChanged(sessionId);
    logExecutorEvent('info', 'session.executor.cancelled', {
      session_id: sessionId,
    }, 'session queue cancelled');
  }

  function clear(): void {
    const state = getState();
    state.queuedCounts.clear();
    state.sessionLocks.clear();
    sessionLockVersions.clear();
    lastSessionTaskFinishedAt.clear();
  }

  return {
    enqueue,
    getActive: (sessionId) => getState().sessionLocks.has(sessionId),
    getQueuedCount,
    cancel,
    clear,
  };
}
