import type { BridgeSession } from '../../../domain/index.js';
import type { RuntimeAgent } from '../../../domain/session.js';
import type { SessionHealthDiagnosis } from '../../health/runtime.js';
import {
  buildCommandFields,
  buildIndexedCommandList,
  formatCommandDateTime,
  formatRuntimeStatus,
} from './index.js';

export function formatHealthStatusLabel(healthStatus: string | undefined | null): string {
  switch (healthStatus) {
    case 'running_active':
      return '正常运行';
    case 'waiting_tool':
      return '等待工具';
    case 'slow_observed':
      return '长时运行，待观察';
    case 'suspected_stall':
      return '疑似卡住';
    case 'suspected_stream_ui_stall':
      return '流式 UI 疑似卡住';
    case 'suspected_detached':
      return '疑似脱挂';
    case 'completed':
      return '已完成';
    case 'failed':
      return '已失败';
    case 'aborted':
      return '已停止';
    default:
      return '空闲';
  }
}

export function formatCommandTimestamp(value: string | null | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) return '-';
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) return trimmed;
  const localized = formatCommandDateTime(trimmed);

  const diffMs = Math.max(0, Date.now() - parsed);
  const diffMinutes = Math.floor(diffMs / 60_000);
  if (diffMinutes < 1) return `${localized}（刚刚）`;
  if (diffMinutes < 60) return `${localized}（${diffMinutes} 分钟前）`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${localized}（${diffHours} 小时前）`;
  const diffDays = Math.floor(diffHours / 24);
  return `${localized}（${diffDays} 天前）`;
}

function formatHealthRuntimeLabel(runtime: RuntimeAgent | null | undefined): string | null {
  if (runtime === 'claude') return 'Claude Code';
  if (runtime === 'kimi') return 'Kimi Code';
  if (runtime === 'codex') return 'Codex';
  return null;
}

function healthRuntimeIdentityFieldName(runtime: RuntimeAgent | null | undefined): string | null {
  if (runtime === 'claude') return 'claude_session_id';
  if (runtime === 'kimi') return 'kimi_session_id';
  if (runtime === 'codex') return 'codex_thread_id';
  return null;
}

export function formatHealthProcessProbe(diagnosis: SessionHealthDiagnosis): string {
  if (!diagnosis.processProbe) {
    return diagnosis.codexThreadId ? '未检查' : '不适用';
  }

  switch (diagnosis.processProbe.status) {
    case 'alive':
      return diagnosis.processProbe.pid
        ? `存活（PID ${diagnosis.processProbe.pid}）`
        : '存活';
    case 'not_found':
      return '未找到';
    case 'unsupported':
      return '当前平台暂不支持';
    case 'error':
      return diagnosis.processProbe.error
        ? `检查失败：${diagnosis.processProbe.error}`
        : '检查失败';
    default:
      return '未知';
  }
}

export function buildHealthCommandResponse(
  title: string,
  diagnosis: SessionHealthDiagnosis,
  markdown = false,
): string {
  const currentStage = diagnosis.activeToolName
    ? `工具 · ${diagnosis.activeToolName}`
    : diagnosis.lastProgressType || '-';
  const runtimeIdentityField = healthRuntimeIdentityFieldName(diagnosis.activeRuntime);

  return buildCommandFields(
    title,
    [
      ['Session', diagnosis.sessionId],
      ['runtime', formatHealthRuntimeLabel(diagnosis.activeRuntime)],
      ...(runtimeIdentityField ? [[runtimeIdentityField, diagnosis.runtimeIdentityValue || '-'] as [string, string]] : []),
      ['runtime_cwd', diagnosis.runtimeIdentityCwd || null],
      ['运行状态', formatRuntimeStatus({ runtime_status: diagnosis.runtimeStatus, queued_count: 0 } as BridgeSession)],
      ['健康状态', formatHealthStatusLabel(diagnosis.healthStatus)],
      ['当前阶段', currentStage],
      ['最后进展', formatCommandTimestamp(diagnosis.lastProgressAt)],
      ['流式 UI 刷新', formatCommandTimestamp(diagnosis.lastStreamUiUpdateAt)],
      ['工具开始', formatCommandTimestamp(diagnosis.activeToolStartedAt)],
      ['最近工具完成', formatCommandTimestamp(diagnosis.lastToolFinishedAt)],
      ['流式 UI 错误', diagnosis.lastStreamUiErrorAt
        ? `${formatCommandTimestamp(diagnosis.lastStreamUiErrorAt)}${diagnosis.lastStreamUiError ? ` · ${diagnosis.lastStreamUiError}` : ''}`
        : '-'],
      ['本地进程', formatHealthProcessProbe(diagnosis)],
    ],
    [diagnosis.healthReason],
    markdown,
  );
}

export function buildHealthListResponse(
  diagnoses: SessionHealthDiagnosis[],
  markdown = false,
): string {
  return buildIndexedCommandList(
    '运行中会话健康检查',
    diagnoses.map((diagnosis) => ({
      heading: diagnosis.sessionId,
      details: [
        ...(diagnosis.activeRuntime ? [`runtime：${formatHealthRuntimeLabel(diagnosis.activeRuntime) || diagnosis.activeRuntime}`] : []),
        ...(diagnosis.runtimeIdentityValue
          ? [`${healthRuntimeIdentityFieldName(diagnosis.activeRuntime) || 'runtime_identity'}：${diagnosis.runtimeIdentityValue}`]
          : []),
        `健康状态：${formatHealthStatusLabel(diagnosis.healthStatus)}`,
        `当前阶段：${diagnosis.activeToolName ? `工具 · ${diagnosis.activeToolName}` : (diagnosis.lastProgressType || '-')}`,
        `最后进展：${formatCommandTimestamp(diagnosis.lastProgressAt)}`,
        `本地进程：${formatHealthProcessProbe(diagnosis)}`,
        `原因：${diagnosis.healthReason}`,
      ],
    })),
    ['发送 `// <session-id>` 可查看某个会话的详细健康信息。'],
    markdown,
  );
}
