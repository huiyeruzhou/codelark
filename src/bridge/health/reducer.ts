import type { BridgeSession, BridgeSessionHealthStatus, RuntimeAgent } from '../../domain/session.js';
import type { ThreadProcessProbeResult } from './process.js';
import {
  getSessionActiveRuntime,
  getSessionClaudeCwd,
  getSessionClaudeSessionId,
  getSessionCodexThreadId,
  getSessionCursorCwd,
  getSessionCursorSessionId,
  getSessionKimiCwd,
  getSessionKimiSessionId,
  getSessionWorkingDirectory,
} from '../../domain/session-runtime.js';

// Diagnostic-only recent-progress window. Stream UI stall detection must not
// depend on this label threshold; otherwise long tasks can form a time cliff.
export const HEALTH_RECENT_PROGRESS_MS = 10 * 60 * 1000;
export const HEALTH_SLOW_OBSERVED_MS = 30 * 60 * 1000;
export const HEALTH_PROGRESS_PERSIST_THROTTLE_MS = 15 * 1000;
export const HEALTH_STREAM_UI_STALL_MS = 60 * 1000;

const RUNNING_HEALTH_STATUSES = new Set<BridgeSessionHealthStatus>([
  'running_active',
  'waiting_tool',
  'slow_observed',
  'suspected_stall',
  'suspected_stream_ui_stall',
  'suspected_detached',
]);

export type SessionProgressType =
  | 'task_started'
  | 'message'
  | 'commentary'
  | 'reasoning'
  | 'plan_update'
  | 'text'
  | 'permission_wait'
  | 'tool_running'
  | 'tool_complete'
  | 'tool_error'
  | 'task_completed'
  | 'task_failed'
  | 'task_aborted';

export type SessionEndOutcome = 'completed' | 'failed' | 'aborted';

export type SessionToolStatus = 'running' | 'complete' | 'error';

export interface ActiveSessionTool {
  id: string;
  name: string;
  startedAt: string;
}

export interface SessionHealthDiagnosis {
  sessionId: string;
  checkedAt: string | null;
  activeRuntime?: RuntimeAgent;
  runtimeIdentityValue?: string | null;
  runtimeIdentityCwd?: string | null;
  runtimeStatus: BridgeSession['runtime_status'];
  healthStatus: BridgeSessionHealthStatus;
  healthReason: string;
  lastProgressAt: string | null;
  lastProgressType: string | null;
  activeToolName: string | null;
  activeToolStartedAt: string | null;
  lastToolFinishedAt: string | null;
  lastStreamUiAttemptAt: string | null;
  lastStreamUiUpdateAt: string | null;
  streamUiFlushStartedAt: string | null;
  lastStreamUiErrorAt: string | null;
  lastStreamUiError: string | null;
  streamUiConsecutiveFailures: number;
  codexThreadId: string | null;
  processProbe: ThreadProcessProbeResult | null;
}

function parseIsoMs(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function trimOrNull(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeActiveSessionTool(raw: unknown): ActiveSessionTool | null {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof (raw as { id?: unknown }).id === 'string'
    ? (raw as { id: string }).id.trim()
    : '';
  if (!id) return null;
  const name = typeof (raw as { name?: unknown }).name === 'string'
    ? (raw as { name: string }).name.trim()
    : '';
  const startedAt = typeof (raw as { startedAt?: unknown }).startedAt === 'string'
    ? (raw as { startedAt: string }).startedAt.trim()
    : '';
  return {
    id,
    name: name || 'tool',
    startedAt,
  };
}

export function parseActiveToolsJson(value: string | undefined): ActiveSessionTool[] {
  const trimmed = value?.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => normalizeActiveSessionTool(item))
      .filter((item): item is ActiveSessionTool => Boolean(item));
  } catch {
    return [];
  }
}

export function serializeActiveTools(tools: Iterable<ActiveSessionTool>): string | undefined {
  const normalized = Array.from(tools)
    .map((tool) => ({
      id: tool.id.trim(),
      name: tool.name.trim() || 'tool',
      startedAt: tool.startedAt.trim(),
    }))
    .filter((tool) => tool.id);
  if (normalized.length === 0) return undefined;
  normalized.sort((a, b) => {
    if (a.startedAt && b.startedAt && a.startedAt !== b.startedAt) {
      return a.startedAt.localeCompare(b.startedAt);
    }
    return a.id.localeCompare(b.id);
  });
  return JSON.stringify(normalized);
}

export function summarizeActiveTools(tools: ActiveSessionTool[]): string | null {
  if (tools.length === 0) return null;
  const firstName = tools[0].name || 'tool';
  return tools.length === 1 ? firstName : `${firstName} 等 ${tools.length} 个工具`;
}

export function getActiveToolStartedAt(tools: ActiveSessionTool[]): string | null {
  const startedAtValues = tools
    .map((tool) => tool.startedAt.trim())
    .filter(Boolean)
    .sort();
  return startedAtValues[0] || null;
}

export function buildProgressReason(type: SessionProgressType, detail?: string): string {
  if (detail?.trim()) return detail.trim();

  switch (type) {
    case 'task_started':
      return '任务已启动。';
    case 'message':
      return '最近收到了新的本地会话消息。';
    case 'commentary':
      return '最近收到了新的执行进展说明。';
    case 'reasoning':
      return '最近收到了新的思考/状态说明。';
    case 'plan_update':
      return '最近更新了任务计划。';
    case 'text':
      return '最近收到了新的正文输出。';
    case 'permission_wait':
      return '当前正在等待权限确认。';
    case 'tool_running':
      return '当前正在等待工具执行。';
    case 'tool_complete':
      return '最近一个工具执行已完成。';
    case 'tool_error':
      return '最近一个工具执行返回错误。';
    case 'task_completed':
      return '任务已完成。';
    case 'task_failed':
      return '任务执行失败。';
    case 'task_aborted':
      return '任务已停止。';
    default:
      return '已记录新的任务进展。';
  }
}

export function buildEndStatus(outcome: SessionEndOutcome): BridgeSessionHealthStatus {
  switch (outcome) {
    case 'completed':
      return 'completed';
    case 'aborted':
      return 'aborted';
    default:
      return 'failed';
  }
}

export function isRunningRuntimeStatus(status: BridgeSession['runtime_status']): boolean {
  return status === 'running' || status === 'queued';
}

export function isRunningHealthStatus(status: BridgeSession['health_status']): boolean {
  return Boolean(status && RUNNING_HEALTH_STATUSES.has(status));
}

export function shouldTrackSession(session: BridgeSession): boolean {
  return isRunningRuntimeStatus(session.runtime_status)
    || isRunningHealthStatus(session.health_status);
}

export function computeBaseDiagnosis(
  session: BridgeSession,
  nowMs: number,
): Omit<SessionHealthDiagnosis, 'processProbe'> {
  const runtimeStatus = session.runtime_status || 'idle';
  const lastProgressAt = trimOrNull(session.last_progress_at);
  const lastProgressType = trimOrNull(session.last_progress_type);
  const activeTools = parseActiveToolsJson(session.active_tools_json);
  const activeToolName = summarizeActiveTools(activeTools) || trimOrNull(session.active_tool_name);
  const activeToolStartedAt = getActiveToolStartedAt(activeTools) || trimOrNull(session.active_tool_started_at);
  const lastToolFinishedAt = trimOrNull(session.last_tool_finished_at);
  const lastStreamUiAttemptAt = trimOrNull(session.last_stream_ui_attempt_at);
  const lastStreamUiUpdateAt = trimOrNull(session.last_stream_ui_update_at);
  const streamUiFlushStartedAt = trimOrNull(session.stream_ui_flush_started_at);
  const lastStreamUiErrorAt = trimOrNull(session.last_stream_ui_error_at);
  const lastStreamUiError = trimOrNull(session.last_stream_ui_error);
  const streamUiConsecutiveFailures = typeof session.stream_ui_consecutive_failures === 'number'
    && Number.isFinite(session.stream_ui_consecutive_failures)
    && session.stream_ui_consecutive_failures > 0
    ? session.stream_ui_consecutive_failures
    : 0;
  const activeRuntime = getSessionActiveRuntime(session) || 'codex';
  const codexThreadId = trimOrNull(getSessionCodexThreadId(session));
  const runtimeIdentityValue = activeRuntime === 'kimi'
    ? trimOrNull(getSessionKimiSessionId(session))
    : activeRuntime === 'claude'
      ? trimOrNull(getSessionClaudeSessionId(session))
      : activeRuntime === 'cursor'
        ? trimOrNull(getSessionCursorSessionId(session))
      : codexThreadId;
  const runtimeIdentityCwd = activeRuntime === 'kimi'
    ? trimOrNull(getSessionKimiCwd(session)) || trimOrNull(getSessionWorkingDirectory(session))
    : activeRuntime === 'claude'
      ? trimOrNull(getSessionClaudeCwd(session)) || trimOrNull(getSessionWorkingDirectory(session))
      : activeRuntime === 'cursor'
        ? trimOrNull(getSessionCursorCwd(session)) || trimOrNull(getSessionWorkingDirectory(session))
      : null;
  const lastProgressMs = parseIsoMs(lastProgressAt || undefined);
  const previousStatus = session.health_status || 'idle';

  if (!isRunningRuntimeStatus(runtimeStatus) && isRunningHealthStatus(previousStatus)) {
    return {
      sessionId: session.id,
      checkedAt: null,
      activeRuntime,
      runtimeIdentityValue,
      runtimeIdentityCwd,
      runtimeStatus,
      healthStatus: 'idle',
      healthReason: '当前没有运行中的任务。',
      lastProgressAt,
      lastProgressType,
      activeToolName,
      activeToolStartedAt,
      lastToolFinishedAt,
      lastStreamUiAttemptAt,
      lastStreamUiUpdateAt,
      streamUiFlushStartedAt,
      lastStreamUiErrorAt,
      lastStreamUiError,
      streamUiConsecutiveFailures,
      codexThreadId,
    };
  }

  if (!lastProgressMs) {
    const fallbackStatus = isRunningRuntimeStatus(runtimeStatus) ? 'running_active' : previousStatus;
    return {
      sessionId: session.id,
      checkedAt: null,
      activeRuntime,
      runtimeIdentityValue,
      runtimeIdentityCwd,
      runtimeStatus,
      healthStatus: fallbackStatus,
      healthReason: session.health_reason?.trim() || (
        fallbackStatus === 'idle'
          ? '当前没有记录到运行中的任务。'
          : '任务正在运行，但还没有记录到详细进展。'
      ),
      lastProgressAt,
      lastProgressType,
      activeToolName,
      activeToolStartedAt,
      lastToolFinishedAt,
      lastStreamUiAttemptAt,
      lastStreamUiUpdateAt,
      streamUiFlushStartedAt,
      lastStreamUiErrorAt,
      lastStreamUiError,
      streamUiConsecutiveFailures,
      codexThreadId,
    };
  }

  const idleMs = Math.max(0, nowMs - lastProgressMs);
  let healthStatus: BridgeSessionHealthStatus;
  let healthReason: string;

  if (previousStatus === 'completed' || previousStatus === 'failed' || previousStatus === 'aborted') {
    healthStatus = previousStatus;
    healthReason = session.health_reason?.trim() || buildProgressReason(
      previousStatus === 'completed'
        ? 'task_completed'
        : previousStatus === 'aborted'
          ? 'task_aborted'
          : 'task_failed',
    );
  } else if (idleMs <= HEALTH_RECENT_PROGRESS_MS) {
    healthStatus = activeToolName ? 'waiting_tool' : 'running_active';
    healthReason = activeToolName
      ? `当前正在等待工具 ${activeToolName}。`
      : '近期仍有新进展。';
  } else if (idleMs <= HEALTH_SLOW_OBSERVED_MS) {
    healthStatus = activeToolName ? 'waiting_tool' : 'slow_observed';
    healthReason = activeToolName
      ? `工具 ${activeToolName} 已运行较久，但仍在观察窗口内。`
      : '近期没有新的执行进展，先标记为待观察。';
  } else {
    healthStatus = 'suspected_stall';
    healthReason = activeToolName
      ? `工具 ${activeToolName} 已长时间没有新进展，疑似卡住。`
      : '已经超过 30 分钟没有新的执行进展，疑似卡住。';
  }

  return {
    sessionId: session.id,
    checkedAt: null,
    activeRuntime,
    runtimeIdentityValue,
    runtimeIdentityCwd,
    runtimeStatus,
    healthStatus,
    healthReason,
    lastProgressAt,
    lastProgressType,
    activeToolName,
    activeToolStartedAt,
    lastToolFinishedAt,
    lastStreamUiAttemptAt,
    lastStreamUiUpdateAt,
    streamUiFlushStartedAt,
    lastStreamUiErrorAt,
    lastStreamUiError,
    streamUiConsecutiveFailures,
    codexThreadId,
  };
}

export function applyProcessProbeDiagnosis(
  diagnosis: Omit<SessionHealthDiagnosis, 'processProbe'>,
  processProbe: ThreadProcessProbeResult | null,
): SessionHealthDiagnosis {
  if (!processProbe) {
    return {
      ...diagnosis,
      processProbe: null,
    };
  }

  if (processProbe.status === 'alive') {
    const healthStatus = diagnosis.activeToolName ? 'waiting_tool' : 'slow_observed';
    const healthReason = diagnosis.activeToolName
      ? '检测到本机线程进程仍在运行，当前更像是长时工具执行。'
      : '检测到本机线程进程仍在运行，当前更像是长时任务。';
    return {
      ...diagnosis,
      healthStatus,
      healthReason,
      processProbe,
    };
  }

  if (processProbe.status === 'not_found' && diagnosis.activeToolName) {
    return {
      ...diagnosis,
      healthStatus: 'suspected_detached',
      healthReason: `工具 ${diagnosis.activeToolName} 已启动，但本机没有找到对应的线程进程。`,
      processProbe,
    };
  }

  if (processProbe.status === 'error') {
    return {
      ...diagnosis,
      healthReason: `${diagnosis.healthReason} 进程探测失败：${processProbe.error || '未知错误'}。`,
      processProbe,
    };
  }

  return {
    ...diagnosis,
    processProbe,
  };
}

export function applyStreamUiDiagnosis(
  diagnosis: SessionHealthDiagnosis,
  nowMs: number,
): SessionHealthDiagnosis {
  if (!isRunningRuntimeStatus(diagnosis.runtimeStatus)) {
    return diagnosis;
  }

  const lastProgressMs = parseIsoMs(diagnosis.lastProgressAt || undefined);
  const lastStreamUiUpdateMs = parseIsoMs(diagnosis.lastStreamUiUpdateAt || undefined);
  const lastStreamUiAttemptMs = parseIsoMs(diagnosis.lastStreamUiAttemptAt || undefined);
  const streamUiFlushStartedMs = parseIsoMs(diagnosis.streamUiFlushStartedAt || undefined);
  const lastStreamUiErrorText = diagnosis.lastStreamUiError?.trim();

  if (streamUiFlushStartedMs && nowMs - streamUiFlushStartedMs >= HEALTH_STREAM_UI_STALL_MS) {
    const details = ['任务仍在继续，但流式 UI 刷新请求已长时间未完成，疑似卡住。'];
    if (diagnosis.streamUiConsecutiveFailures > 0) {
      details.push(`最近连续失败 ${diagnosis.streamUiConsecutiveFailures} 次。`);
    }
    if (lastStreamUiErrorText) {
      details.push(`最近错误：${lastStreamUiErrorText}`);
    }
    return {
      ...diagnosis,
      healthStatus: 'suspected_stream_ui_stall',
      healthReason: details.join(' '),
    };
  }

  if (
    lastStreamUiAttemptMs
    && (
      !lastStreamUiUpdateMs
      || lastStreamUiAttemptMs - lastStreamUiUpdateMs >= HEALTH_STREAM_UI_STALL_MS
    )
  ) {
    const details = ['任务仍在继续，但流式 UI 有刷新尝试未成功跟进，疑似停更。'];
    if (diagnosis.streamUiConsecutiveFailures > 0) {
      details.push(`最近连续失败 ${diagnosis.streamUiConsecutiveFailures} 次。`);
    }
    if (lastStreamUiErrorText) {
      details.push(`最近错误：${lastStreamUiErrorText}`);
    }
    return {
      ...diagnosis,
      healthStatus: 'suspected_stream_ui_stall',
      healthReason: details.join(' '),
    };
  }

  if (lastProgressMs && lastStreamUiUpdateMs && lastProgressMs - lastStreamUiUpdateMs >= HEALTH_STREAM_UI_STALL_MS) {
    const details = ['任务仍在继续，但流式 UI 已长时间没有跟上最新执行进展，疑似停更。'];
    if (lastStreamUiErrorText) {
      details.push(`最近错误：${lastStreamUiErrorText}`);
    }
    return {
      ...diagnosis,
      healthStatus: 'suspected_stream_ui_stall',
      healthReason: details.join(' '),
    };
  }

  if (lastProgressMs && !lastStreamUiUpdateMs && lastStreamUiAttemptMs && lastProgressMs - lastStreamUiAttemptMs >= HEALTH_STREAM_UI_STALL_MS) {
    const details = ['任务仍在继续，但流式 UI 只有发送尝试、没有成功刷新记录，疑似停更。'];
    if (lastStreamUiErrorText) {
      details.push(`最近错误：${lastStreamUiErrorText}`);
    }
    return {
      ...diagnosis,
      healthStatus: 'suspected_stream_ui_stall',
      healthReason: details.join(' '),
    };
  }

  const lastStreamUiActivityMs = Math.max(
    lastStreamUiAttemptMs || 0,
    lastStreamUiUpdateMs || 0,
    streamUiFlushStartedMs || 0,
  );
  if (
    lastStreamUiActivityMs > 0
    && nowMs - lastStreamUiActivityMs >= HEALTH_STREAM_UI_STALL_MS
  ) {
    return {
      ...diagnosis,
      healthStatus: 'suspected_stream_ui_stall',
      healthReason: '任务仍在继续，但流式 UI 状态刷新已停止，疑似停更。',
    };
  }

  return diagnosis;
}
