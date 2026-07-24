import {
  formatContextUsageCompact,
  type ContextUsageInfo,
} from '../../shared/progress/context-usage.js';
import {
  createUnifiedTurnProgressState,
  recordUnifiedTurnActivity,
  recordUnifiedTurnContentResponse,
  applyUnifiedTurnStatusNote,
  applyUnifiedTurnThinkingNote,
  type UnifiedTurnProgressState,
} from './unified-turn-state.js';

export interface StreamState extends UnifiedTurnProgressState {
  lastStatusText: string | null;
  lastStatusAtMs: number;
}

export interface StreamStatusTimingConfig {
  idleStartMs: number;
  heartbeatMs: number;
}

const MAX_STREAM_THINKING_NOTE_CHARS = 600;

function truncateStatusNote(text: string, maxChars: number): string {
  const chars = Array.from(text.trim());
  if (chars.length <= maxChars) return chars.join('');
  return `${chars.slice(0, maxChars).join('')}...`;
}

export function createStreamState(startedAtMs: number): StreamState {
  return {
    ...createUnifiedTurnProgressState(startedAtMs),
    lastStatusText: null,
    lastStatusAtMs: 0,
  };
}

export function recordStreamActivity(state: StreamState, nowMs: number): void {
  recordUnifiedTurnActivity(state, nowMs);
}

export function recordStreamContentResponse(state: StreamState, nowMs: number): void {
  recordUnifiedTurnContentResponse(state, nowMs);
}

export function updateStreamStatusNote(
  state: StreamState,
  note: string | null | undefined,
  nowMs: number,
): void {
  applyUnifiedTurnStatusNote(state, note, nowMs);
}

export function updateStreamThinkingNote(
  state: StreamState,
  note: string | null | undefined,
  nowMs: number,
): void {
  applyUnifiedTurnThinkingNote(state, note, nowMs);
}

export function formatRuntimeDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}小时`);
  if (minutes > 0) parts.push(`${minutes}分`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}秒`);
  return parts.join('');
}

export function formatStreamRuntimeStatus(
  elapsedMs: number,
  lastContentResponseAgeMs?: number | null,
  statusNote?: string | null,
  contextUsage?: ContextUsageInfo | null,
  thinkingNote?: string | null,
): string {
  const parts = [`已运行 ${formatRuntimeDuration(elapsedMs)}`];
  if (typeof lastContentResponseAgeMs === 'number' && lastContentResponseAgeMs >= 0) {
    parts.push(`上次响应距今 ${formatRuntimeDuration(lastContentResponseAgeMs)}`);
  }
  const contextText = formatContextUsageCompact(contextUsage);
  if (contextText) parts.push(contextText);
  const runtimeText = parts.join('，');
  const note = (statusNote || '').trim();
  const thinking = (thinkingNote || '').trim();
  const lines: string[] = [];
  if (note) lines.push(`当前步骤：${note}`);
  if (thinking) lines.push(`当前思考：${truncateStatusNote(thinking, MAX_STREAM_THINKING_NOTE_CHARS)}`);
  lines.push(runtimeText);
  return lines.join('\n');
}

export function getStreamLastContentResponseAgeMs(
  state: Pick<StreamState, 'startedAtMs' | 'lastContentResponseAtMs'>,
  nowMs: number,
  options: { fallbackToStart?: boolean } = {},
): number | null {
  const fallbackToStart = options.fallbackToStart !== false;
  const base = state.lastContentResponseAtMs ?? (fallbackToStart ? state.startedAtMs : null);
  if (base == null || !Number.isFinite(base) || !Number.isFinite(nowMs)) return null;
  return Math.max(0, nowMs - base);
}

export function shouldShowStreamLastContentResponseAge(
  state: Pick<StreamState, 'startedAtMs' | 'lastContentResponseAtMs'>,
  nowMs: number,
  config: StreamStatusTimingConfig,
): boolean {
  if (!Number.isFinite(nowMs)) return false;
  const elapsedMs = nowMs - state.startedAtMs;
  if (elapsedMs < Math.max(0, config.idleStartMs)) return false;
  return getStreamLastContentResponseAgeMs(state, nowMs) != null;
}

export function getVisibleStreamLastContentResponseAgeMs(
  state: Pick<StreamState, 'startedAtMs' | 'lastContentResponseAtMs'>,
  nowMs: number,
  config: StreamStatusTimingConfig,
): number | null {
  if (!shouldShowStreamLastContentResponseAge(state, nowMs, config)) return null;
  return getStreamLastContentResponseAgeMs(state, nowMs);
}

export function buildStreamRuntimeStatus(
  state: Pick<StreamState, 'startedAtMs' | 'lastContentResponseAtMs' | 'statusNote'> & Partial<Pick<StreamState, 'thinkingNote'>>,
  nowMs: number,
  options: {
    includeLastContentResponseAge?: boolean;
  } = {},
): string {
  return formatStreamRuntimeStatus(
    Math.max(0, nowMs - state.startedAtMs),
    options.includeLastContentResponseAge
      ? getStreamLastContentResponseAgeMs(state, nowMs)
      : null,
    state.statusNote,
    'contextUsage' in state ? (state.contextUsage as ContextUsageInfo | null) : null,
    state.thinkingNote,
  );
}
