import type { BridgeStore } from '../../domain/audit.js';
import type { BridgeSession } from '../../domain/session.js';
import type { BridgeMirrorRecord } from '../../runtime/contracts.js';
import type { StructuredStreamingUiSnapshot } from '../../channels/contracts.js';
import type { CodexAppServerLifecycle } from '../../runtime/codex/app-server-lifecycle.js';
import type { ThreadProcessProbeResult } from './process.js';
import {
  applyStreamUiDiagnosis,
  applyProcessProbeDiagnosis,
  getActiveToolStartedAt,
  buildEndStatus,
  buildProgressReason,
  computeBaseDiagnosis,
  HEALTH_PROGRESS_PERSIST_THROTTLE_MS,
  parseActiveToolsJson,
  serializeActiveTools,
  shouldTrackSession,
  summarizeActiveTools,
} from './reducer.js';
import { getSessionActiveRuntime, getSessionCodexThreadId, getSessionClaudeSessionId, getSessionKimiSessionId, getSessionCursorSessionId, getSessionZcodeSessionId } from '../../domain/session-runtime.js';
import type {
  SessionEndOutcome,
  SessionHealthDiagnosis,
  SessionProgressType,
  SessionToolStatus,
} from './reducer.js';

export type {
  SessionEndOutcome,
  SessionHealthDiagnosis,
  SessionProgressType,
  SessionToolStatus,
} from './reducer.js';

export interface CreateSessionHealthRuntimeDeps {
  getStore(): Pick<BridgeStore, 'getSession' | 'listSessions' | 'updateSession'>;
  nowIso(): string;
  getProtocolSnapshot?(sessionId: string): ReturnType<CodexAppServerLifecycle['snapshot']> | undefined;
  probeThreadProcess?(threadId: string): Promise<ThreadProcessProbeResult>;
}

export interface SessionHealthRuntime {
  recordInteractiveStart(sessionId: string, detail?: string): void;
  recordInteractiveProgress(sessionId: string, type: SessionProgressType, detail?: string): void;
  recordToolState(sessionId: string, toolId: string, toolName: string, status: SessionToolStatus): void;
  recordStructuredStreamUi(sessionId: string, snapshot: StructuredStreamingUiSnapshot): void;
  recordInteractiveEnd(sessionId: string, outcome: SessionEndOutcome, detail?: string): void;
  observeBridgeMirrorRecords(sessionId: string, threadId: string, records: BridgeMirrorRecord[]): void;
  reconcileSessionHealth(): void;
  diagnoseSessionHealth(sessionId: string): Promise<SessionHealthDiagnosis | null>;
  diagnoseAllActiveSessions(): Promise<SessionHealthDiagnosis[]>;
}

export function createSessionHealthRuntime(
  deps: CreateSessionHealthRuntimeDeps,
): SessionHealthRuntime {
  const lastProgressPersistAt = new Map<string, number>();

  function isTerminalHealthStatus(status: BridgeSession['health_status'] | undefined): boolean {
    return status === 'completed' || status === 'failed' || status === 'aborted';
  }

  function shouldIgnoreNonStartProgress(session: BridgeSession): boolean {
    return isTerminalHealthStatus(session.health_status);
  }

  function summarizePlanUpdate(tasks: BridgeMirrorRecord['tasks']): string {
    if (!Array.isArray(tasks) || tasks.length === 0) {
      return '检测到本地会话更新了任务计划。';
    }
    let inProgress = 0;
    let pending = 0;
    let completed = 0;
    for (const task of tasks) {
      if (task?.status === 'completed') completed += 1;
      else if (task?.status === 'in_progress') inProgress += 1;
      else pending += 1;
    }
    return `检测到本地会话更新了任务计划（执行中 ${inProgress} 项，等待中 ${pending} 项，已完成 ${completed} 项）。`;
  }

  function updateSessionHealth(
    sessionId: string,
    updates: Partial<BridgeSession>,
    options?: { force?: boolean; touch?: boolean },
  ): void {
    const store = deps.getStore();
    const session = store.getSession(sessionId);
    if (!session) return;

    const next: Partial<BridgeSession> = {};
    const typedNext = next as Record<keyof BridgeSession, BridgeSession[keyof BridgeSession] | undefined>;
    let changed = options?.force === true;

    for (const [key, value] of Object.entries(updates) as Array<[keyof BridgeSession, BridgeSession[keyof BridgeSession]]>) {
      if (session[key] !== value) {
        typedNext[key] = value;
        changed = true;
      }
    }

    if (!changed) return;
    store.updateSession(sessionId, next, { touch: options?.touch });
  }

  function maybePersistProgress(
    sessionId: string,
    updates: Partial<BridgeSession>,
    progressType: SessionProgressType,
  ): void {
    const nowMs = Date.now();
    const store = deps.getStore();
    const session = store.getSession(sessionId);
    if (!session) return;

    const force = session.last_progress_type !== progressType
      || session.health_status !== updates.health_status
      || session.health_reason !== updates.health_reason
      || session.active_tools_json !== updates.active_tools_json
      || session.active_tool_name !== updates.active_tool_name
      || session.active_tool_started_at !== updates.active_tool_started_at;

    if (!force) {
      const lastPersistedAt = lastProgressPersistAt.get(sessionId) || 0;
      if (nowMs - lastPersistedAt < HEALTH_PROGRESS_PERSIST_THROTTLE_MS) {
        return;
      }
    }

    lastProgressPersistAt.set(sessionId, nowMs);
    updateSessionHealth(sessionId, updates);
  }

  function recordInteractiveStart(sessionId: string, detail?: string): void {
    const nowIso = deps.nowIso();
    lastProgressPersistAt.set(sessionId, Date.now());
    updateSessionHealth(sessionId, {
      health_status: 'running_active',
      health_reason: detail?.trim() || buildProgressReason('task_started'),
      last_progress_at: nowIso,
      last_progress_type: 'task_started',
      active_tools_json: undefined,
      active_tool_name: undefined,
      active_tool_started_at: undefined,
      last_tool_finished_at: undefined,
      last_stream_ui_attempt_at: undefined,
      last_stream_ui_update_at: undefined,
      stream_ui_flush_started_at: undefined,
      last_stream_ui_error_at: undefined,
      last_stream_ui_error: undefined,
      stream_ui_consecutive_failures: undefined,
    });
  }

  function recordInteractiveProgress(sessionId: string, type: SessionProgressType, detail?: string): void {
    const nowIso = deps.nowIso();
    const session = deps.getStore().getSession(sessionId);
    if (!session || shouldIgnoreNonStartProgress(session)) return;
    maybePersistProgress(sessionId, {
      health_status: type === 'permission_wait' ? 'waiting_tool' : 'running_active',
      health_reason: buildProgressReason(type, detail),
      last_progress_at: nowIso,
      last_progress_type: type,
    }, type);
  }

  function recordToolState(sessionId: string, toolId: string, toolName: string, status: SessionToolStatus): void {
    const nowIso = deps.nowIso();
    const store = deps.getStore();
    const session = store.getSession(sessionId);
    if (!session) return;
    if (shouldIgnoreNonStartProgress(session)) return;

    const activeTools = new Map(
      parseActiveToolsJson(session.active_tools_json).map((tool) => [tool.id, tool]),
    );

    if (status === 'running') {
      activeTools.set(toolId, {
        id: toolId,
        name: toolName || activeTools.get(toolId)?.name || 'tool',
        startedAt: activeTools.get(toolId)?.startedAt || nowIso,
      });
      const nextTools = Array.from(activeTools.values());
      const activeToolName = summarizeActiveTools(nextTools);
      updateSessionHealth(sessionId, {
        health_status: 'waiting_tool',
        health_reason: activeToolName ? `当前正在等待工具 ${activeToolName}。` : buildProgressReason('tool_running'),
        last_progress_at: nowIso,
        last_progress_type: 'tool_running',
        active_tools_json: serializeActiveTools(nextTools),
        active_tool_name: activeToolName || undefined,
        active_tool_started_at: getActiveToolStartedAt(nextTools) || undefined,
      });
      lastProgressPersistAt.set(sessionId, Date.now());
      return;
    }

    activeTools.delete(toolId);
    const progressType = status === 'error' ? 'tool_error' : 'tool_complete';
    const nextTools = Array.from(activeTools.values());
    const activeToolName = summarizeActiveTools(nextTools);
    updateSessionHealth(sessionId, {
      health_status: activeToolName ? 'waiting_tool' : 'running_active',
      health_reason: activeToolName
        ? `工具 ${toolName || 'tool'} ${status === 'error' ? '返回错误' : '执行完成'}，当前仍在等待工具 ${activeToolName}。`
        : toolName
          ? `工具 ${toolName} ${status === 'error' ? '返回错误' : '执行完成'}。`
          : buildProgressReason(progressType),
      last_progress_at: nowIso,
      last_progress_type: progressType,
      active_tools_json: serializeActiveTools(nextTools),
      active_tool_name: activeToolName || undefined,
      active_tool_started_at: getActiveToolStartedAt(nextTools) || undefined,
      last_tool_finished_at: nowIso,
    });
    lastProgressPersistAt.set(sessionId, Date.now());
  }

  function recordInteractiveEnd(sessionId: string, outcome: SessionEndOutcome, detail?: string): void {
    const nowIso = deps.nowIso();
    updateSessionHealth(sessionId, {
      health_status: buildEndStatus(outcome),
      health_reason: detail?.trim() || buildProgressReason(
        outcome === 'completed'
          ? 'task_completed'
          : outcome === 'aborted'
            ? 'task_aborted'
            : 'task_failed',
      ),
      last_progress_at: nowIso,
      last_progress_type: outcome === 'completed'
        ? 'task_completed'
        : outcome === 'aborted'
          ? 'task_aborted'
          : 'task_failed',
      active_tools_json: undefined,
      active_tool_name: undefined,
      active_tool_started_at: undefined,
      stream_ui_flush_started_at: undefined,
      last_stream_ui_attempt_at: undefined,
      last_stream_ui_update_at: undefined,
      last_stream_ui_error_at: undefined,
      last_stream_ui_error: undefined,
      stream_ui_consecutive_failures: undefined,
    }, { force: true });
    lastProgressPersistAt.set(sessionId, Date.now());
  }

  function toIso(value: number | null | undefined): string | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
    return new Date(value).toISOString();
  }

  function recordStructuredStreamUi(sessionId: string, snapshot: StructuredStreamingUiSnapshot): void {
    const updates: Partial<BridgeSession> = {
      stream_ui_flush_started_at: snapshot.active && snapshot.flushInFlight
        ? toIso(snapshot.flushInFlightSince ?? snapshot.lastAttemptAt)
        : undefined,
    };

    if (snapshot.active) {
      updates.last_stream_ui_attempt_at = toIso(snapshot.lastAttemptAt);
      updates.last_stream_ui_update_at = toIso(snapshot.lastUpdateAt);
      updates.last_stream_ui_error_at = toIso(snapshot.lastErrorAt);
      updates.last_stream_ui_error = snapshot.lastError?.trim() || undefined;
      updates.stream_ui_consecutive_failures = snapshot.consecutiveFailures && snapshot.consecutiveFailures > 0
        ? snapshot.consecutiveFailures
        : undefined;
    } else {
      updates.last_stream_ui_attempt_at = undefined;
      updates.last_stream_ui_update_at = undefined;
      updates.last_stream_ui_error_at = undefined;
      updates.last_stream_ui_error = undefined;
      updates.stream_ui_consecutive_failures = undefined;
    }

    updateSessionHealth(sessionId, updates);
  }

  const mirrorTurns = new Map<string, { threadId: string; turnId?: string; startedAt: string; ended: boolean }>();

  function observeBridgeMirrorRecords(sessionId: string, threadId: string, records: BridgeMirrorRecord[]): void {
    const session = deps.getStore().getSession(sessionId);
    if (!session) return;
    const runtime = getSessionActiveRuntime(session) || 'codex';
    const currentThread = runtime === 'claude' ? getSessionClaudeSessionId(session)
      : runtime === 'kimi' ? getSessionKimiSessionId(session)
      : runtime === 'cursor' ? getSessionCursorSessionId(session)
      : runtime === 'zcode' ? getSessionZcodeSessionId(session) : getSessionCodexThreadId(session);
    if (currentThread && currentThread !== threadId) return;
    if (mirrorTurns.get(sessionId)?.threadId !== threadId) mirrorTurns.delete(sessionId);
    for (const record of records) {
      const current = mirrorTurns.get(sessionId);
      if (record.type === 'task_started') {
        if (current && record.turnId && record.turnId === current.turnId) continue;
        if (current?.startedAt && record.timestamp && record.timestamp < current.startedAt) continue;
        mirrorTurns.set(sessionId, { threadId, turnId: record.turnId || undefined, startedAt: record.timestamp, ended: false });
        recordInteractiveStart(sessionId, '检测到本地会话开始执行。');
        continue;
      }
      if (current?.turnId && record.turnId && current.turnId !== record.turnId) continue;
      if (current?.ended) continue;
      if (record.type === 'task_complete' || record.type === 'task_aborted') {
        mirrorTurns.set(sessionId, { threadId, turnId: record.turnId || current?.turnId,
          startedAt: current?.startedAt || record.timestamp, ended: true });
      }
      if (record.type === 'task_complete') {
        recordInteractiveEnd(
          sessionId,
          record.isError ? 'failed' : 'completed',
          record.isError
            ? record.errorText || record.content || '检测到本地会话执行失败。'
            : '检测到本地会话已完成当前任务。',
        );
        continue;
      }
      if (record.type === 'task_aborted') {
        recordInteractiveEnd(
          sessionId,
          record.isError ? 'failed' : 'aborted',
          record.isError
            ? record.errorText || record.content || '检测到本地会话执行失败。'
            : '检测到本地会话已停止当前任务。',
        );
        continue;
      }
      if (record.type === 'tool_started') {
        recordToolState(sessionId, record.toolId || record.signature, record.toolName || 'tool', 'running');
        continue;
      }
      if (record.type === 'tool_finished') {
        recordToolState(
          sessionId,
          record.toolId || record.signature,
          record.toolName || '',
          record.isError ? 'error' : 'complete',
        );
        continue;
      }
      if (record.type === 'reasoning') {
        recordInteractiveProgress(
          sessionId,
          'reasoning',
          '检测到本地会话新的思考/状态说明。',
        );
        continue;
      }
      if (record.type === 'plan_update') {
        recordInteractiveProgress(
          sessionId,
          'plan_update',
          summarizePlanUpdate(record.tasks),
        );
        continue;
      }
      if (record.type === 'message') {
        recordInteractiveProgress(
          sessionId,
          record.role === 'commentary' ? 'commentary' : 'message',
          record.role === 'commentary'
            ? '检测到本地会话新的执行进展说明。'
            : '检测到本地会话新的消息输出。',
        );
      }
    }
  }

  function reconcileSessionHealth(): void {
    const nowMs = Date.now();
    const store = deps.getStore();
    for (const session of store.listSessions()) {
      if (!shouldTrackSession(session)) continue;
      const diagnosis = protocolDiagnosis(session) || applyStreamUiDiagnosis(
        { ...computeBaseDiagnosis(session, nowMs), processProbe: null },
        nowMs,
      );
      updateSessionHealth(session.id, {
        health_status: diagnosis.healthStatus,
        health_reason: diagnosis.healthReason,
      }, { touch: false });
    }
  }

  async function loadProcessProbe(session: BridgeSession): Promise<ThreadProcessProbeResult | null> {
    if (session.runtime?.codex?.appServerEndpoint) return null;
    const threadId = getSessionCodexThreadId(session);
    if (!threadId || !deps.probeThreadProcess) return null;
    return deps.probeThreadProcess(threadId);
  }

  async function diagnoseSessionHealth(sessionId: string): Promise<SessionHealthDiagnosis | null> {
    const store = deps.getStore();
    const session = store.getSession(sessionId);
    if (!session) return null;
    const protocol = protocolDiagnosis(session);
    if (protocol) return protocol;

    const base = computeBaseDiagnosis(session, Date.now());
    const processProbe = await loadProcessProbe(session);
    return applyStreamUiDiagnosis(
      applyProcessProbeDiagnosis(base, processProbe),
      Date.now(),
    );
  }

  function protocolDiagnosis(session: BridgeSession): SessionHealthDiagnosis | null {
    if (!session.runtime?.codex?.appServerEndpoint) return null;
    const snapshot = deps.getProtocolSnapshot?.(session.id);
    const unknown = !snapshot || snapshot.connection !== 'ready' || snapshot.activity === 'unknown';
    const waiting = snapshot?.activity === 'waiting';
    const active = snapshot?.activity === 'active';
    return {
      ...computeBaseDiagnosis(session, Date.now()),
      processProbe: null,
      healthStatus: unknown ? 'suspected_detached' : waiting ? 'waiting_tool' : active ? 'running_active'
        : isTerminalHealthStatus(session.health_status) ? session.health_status! : 'idle',
      healthReason: unknown ? 'Codex 协议连接或轮次状态待确认，尚未确认任务结束。'
        : waiting ? 'Codex 正在等待请求答复。' : active ? 'Codex 协议报告当前轮次正在执行。'
        : isTerminalHealthStatus(session.health_status) ? session.health_reason || 'Codex 已确认轮次结束。' : 'Codex 协议报告当前线程空闲。',
    };
  }

  async function diagnoseAllActiveSessions(): Promise<SessionHealthDiagnosis[]> {
    const store = deps.getStore();
    const activeSessions = store.listSessions().filter((session) => shouldTrackSession(session));
    const diagnoses = await Promise.all(activeSessions.map((session) => diagnoseSessionHealth(session.id)));
    return diagnoses.filter((item): item is SessionHealthDiagnosis => Boolean(item));
  }

  return {
    recordInteractiveStart,
    recordInteractiveProgress,
    recordToolState,
    recordStructuredStreamUi,
    recordInteractiveEnd,
    observeBridgeMirrorRecords,
    reconcileSessionHealth,
    diagnoseSessionHealth,
    diagnoseAllActiveSessions,
  };
}
