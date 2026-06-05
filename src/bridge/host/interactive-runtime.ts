import type { BridgeSession, BridgeStore } from '../../domain/index.js';
import type { InteractiveTaskState } from '../turn/interactive/runner.js';
import {
  createSessionExecutor,
  type SessionExecutor,
} from '../session/session-executor.js';

export interface BridgeInteractiveRuntimeState {
  activeTasks: Map<string, InteractiveTaskState>;
  queuedCounts: Map<string, number>;
  sessionLocks: Map<string, Promise<void>>;
}

export interface CreateInteractiveRuntimeDeps {
  getStore(): Pick<BridgeStore, 'getSession' | 'listSessions' | 'updateSession'>;
  nowIso(): string;
  sessionTurnCooldownMs?: number;
}

export interface InteractiveRuntime {
  getActiveTask(sessionId: string): InteractiveTaskState | undefined;
  getQueuedCount(sessionId: string): number;
  registerInteractiveTask(task: InteractiveTaskState): void;
  isCurrentInteractiveTask(sessionId: string, taskId: string): boolean;
  touchInteractiveTask(sessionId: string, taskId: string): void;
  releaseInteractiveTask(sessionId: string, taskId: string): void;
  syncSessionRuntimeState(sessionId: string): void;
  finalizeTerminalActiveTask(
    sessionId: string,
    outcome: 'completed' | 'failed' | 'aborted',
    detail?: string,
    finalText?: string,
  ): Promise<boolean>;
  forceStopSession(sessionId: string, detail?: string): Promise<boolean>;
  reconcileTerminalSessionRuntimeState(): Promise<void>;
  resetPersistedInteractiveRuntimeState(): void;
  resetSessionExecutor(): void;
  processWithSessionLock(sessionId: string, fn: () => Promise<void>, options?: { jobKind?: string }): Promise<void>;
}

const TERMINAL_SESSION_HEALTH_STATUSES = new Set<NonNullable<BridgeSession['health_status']>>([
  'completed',
  'failed',
  'aborted',
]);
const DEFAULT_SESSION_TURN_COOLDOWN_MS = 1_500;

function isTerminalSessionHealthStatus(status: BridgeSession['health_status'] | undefined): boolean {
  return Boolean(status && TERMINAL_SESSION_HEALTH_STATUSES.has(status));
}

export function createInteractiveRuntime(
  getState: () => BridgeInteractiveRuntimeState,
  deps: CreateInteractiveRuntimeDeps,
): InteractiveRuntime {
  const sessionTurnCooldownMs = Math.max(
    0,
    deps.sessionTurnCooldownMs ?? DEFAULT_SESSION_TURN_COOLDOWN_MS,
  );
  let sessionExecutor: SessionExecutor | null = null;

  function getSessionExecutor(): SessionExecutor {
    if (!sessionExecutor) {
      sessionExecutor = createSessionExecutor(getState, {
        onQueuedCountChanged: syncSessionRuntimeState,
        sessionTurnCooldownMs,
      });
    }
    return sessionExecutor;
  }

  function getQueuedCount(sessionId: string): number {
    return getSessionExecutor().getQueuedCount(sessionId);
  }

  function getActiveTask(sessionId: string): InteractiveTaskState | undefined {
    return getState().activeTasks.get(sessionId);
  }

  function syncSessionRuntimeState(sessionId: string): void {
    const store = deps.getStore();
    const session = store.getSession(sessionId);
    if (!session) return;

    const queuedCount = getQueuedCount(sessionId);
    const isRunning = getState().activeTasks.has(sessionId);
    const runtimeStatus: BridgeSession['runtime_status'] = queuedCount > 0
      ? 'queued'
      : isRunning
        ? 'running'
        : 'idle';

    if (
      session.queued_count === queuedCount
      && session.runtime_status === runtimeStatus
    ) {
      return;
    }

    store.updateSession(sessionId, {
      queued_count: queuedCount,
      runtime_status: runtimeStatus,
      last_runtime_update_at: deps.nowIso(),
    });
  }

  function registerInteractiveTask(task: InteractiveTaskState): void {
    getState().activeTasks.set(task.sessionId, task);
    syncSessionRuntimeState(task.sessionId);
  }

  function isCurrentInteractiveTask(sessionId: string, taskId: string): boolean {
    return getState().activeTasks.get(sessionId)?.id === taskId;
  }

  function touchInteractiveTask(sessionId: string, taskId: string): void {
    const task = getState().activeTasks.get(sessionId);
    if (task?.id !== taskId) return;
    task.lastActivityAt = Date.now();
  }

  function releaseInteractiveTask(sessionId: string, taskId: string): void {
    const state = getState();
    const current = state.activeTasks.get(sessionId);
    if (current?.id !== taskId) return;
    state.activeTasks.delete(sessionId);
    syncSessionRuntimeState(sessionId);
  }

  async function finalizeTerminalActiveTask(
    sessionId: string,
    outcome: 'completed' | 'failed' | 'aborted',
    detail?: string,
    finalText?: string,
  ): Promise<boolean> {
    const task = getState().activeTasks.get(sessionId);
    if (!task?.finalizeFromExternalTerminal) return false;
    return task.finalizeFromExternalTerminal(outcome, detail, finalText);
  }

  async function forceStopSession(sessionId: string, detail?: string): Promise<boolean> {
    const state = getState();
    const task = state.activeTasks.get(sessionId);
    let handled = false;
    if (task?.forceStop) {
      handled = await task.forceStop(detail);
    } else if (task) {
      task.abortController.abort();
      handled = true;
    }

    state.activeTasks.delete(sessionId);
    getSessionExecutor().cancel(sessionId);
    return handled;
  }

  async function reconcileTerminalSessionRuntimeState(): Promise<void> {
    const store = deps.getStore();
    for (const session of store.listSessions()) {
      if (!isTerminalSessionHealthStatus(session.health_status)) continue;

      if (getState().activeTasks.has(session.id)) continue;

      const queuedCount = getQueuedCount(session.id);
      const persistedQueuedCount = session.queued_count && session.queued_count > 0
        ? session.queued_count
        : 0;
      if (queuedCount > 0) continue;
      if (persistedQueuedCount === 0 && session.runtime_status !== 'running' && session.runtime_status !== 'queued') {
        continue;
      }
      store.updateSession(session.id, {
        queued_count: 0,
        runtime_status: 'idle',
        last_runtime_update_at: deps.nowIso(),
      });
    }
  }

  function resetPersistedInteractiveRuntimeState(): void {
    const store = deps.getStore();
    for (const session of store.listSessions()) {
      const queuedCount = session.queued_count && session.queued_count > 0
        ? session.queued_count
        : 0;
      if (queuedCount === 0 && session.runtime_status !== 'running' && session.runtime_status !== 'queued') {
        continue;
      }
      store.updateSession(session.id, {
        queued_count: 0,
        runtime_status: 'idle',
        last_runtime_update_at: deps.nowIso(),
      });
    }
  }

  function resetSessionExecutor(): void {
    getSessionExecutor().clear();
  }

  function processWithSessionLock(sessionId: string, fn: () => Promise<void>, options: { jobKind?: string } = {}): Promise<void> {
    return getSessionExecutor().enqueue(sessionId, fn, { jobKind: options.jobKind || 'interactive-turn' });
  }

  return {
    getActiveTask,
    getQueuedCount,
    registerInteractiveTask,
    isCurrentInteractiveTask,
    touchInteractiveTask,
    releaseInteractiveTask,
    syncSessionRuntimeState,
    finalizeTerminalActiveTask,
    forceStopSession,
    reconcileTerminalSessionRuntimeState,
    resetPersistedInteractiveRuntimeState,
    resetSessionExecutor,
    processWithSessionLock,
  };
}
