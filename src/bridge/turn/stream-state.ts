import {
  formatContextUsageCompactParts,
  type ContextUsageInfo,
} from '../../shared/progress/context-usage.js';
import {
  formatFooterClockTime,
  formatFooterDuration,
  joinFooterParts,
} from '../../shared/progress/footer.js';
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
  return formatFooterDuration(ms);
}

export function formatStreamRuntimeStatus(
  elapsedMs: number,
  lastActivityAgeMs?: number | null,
  statusNote?: string | null,
  contextUsage?: ContextUsageInfo | null,
  thinkingNote?: string | null,
  currentTimeMs?: number,
): string {
  const parts: string[] = [];
  if (typeof currentTimeMs === 'number' && Number.isFinite(currentTimeMs)) {
    parts.push(formatFooterClockTime(currentTimeMs));
  }
  parts.push(`已运行 ${formatRuntimeDuration(elapsedMs)}`);
  if (typeof lastActivityAgeMs === 'number' && lastActivityAgeMs >= 0) {
    parts.push(`上次响应 ${formatRuntimeDuration(lastActivityAgeMs)}`);
  }
  const context = formatContextUsageCompactParts(contextUsage);
  if (context.context) parts.push(context.context);
  if (context.lastIo) parts.push(context.lastIo);
  const runtimeText = joinFooterParts(parts);
  const note = (statusNote || '').trim();
  const thinking = (thinkingNote || '').trim();
  const lines: string[] = [];
  if (note) lines.push(`当前步骤：${note}`);
  if (thinking) lines.push(`当前思考：${truncateStatusNote(thinking, MAX_STREAM_THINKING_NOTE_CHARS)}`);
  lines.push(runtimeText);
  return lines.join('\n');
}

export function getStreamLastActivityAgeMs(
  state: Pick<StreamState, 'startedAtMs' | 'lastActivityAtMs'>,
  nowMs: number,
  options: { fallbackToStart?: boolean } = {},
): number | null {
  const fallbackToStart = options.fallbackToStart !== false;
  const base = state.lastActivityAtMs ?? (fallbackToStart ? state.startedAtMs : null);
  if (base == null || !Number.isFinite(base) || !Number.isFinite(nowMs)) return null;
  return Math.max(0, nowMs - base);
}

export function shouldShowStreamLastActivityAge(
  state: Pick<StreamState, 'startedAtMs' | 'lastActivityAtMs'>,
  nowMs: number,
  config: StreamStatusTimingConfig,
): boolean {
  if (!Number.isFinite(nowMs)) return false;
  const elapsedMs = nowMs - state.startedAtMs;
  if (elapsedMs < Math.max(0, config.idleStartMs)) return false;
  return getStreamLastActivityAgeMs(state, nowMs) != null;
}

export function getVisibleStreamLastActivityAgeMs(
  state: Pick<StreamState, 'startedAtMs' | 'lastActivityAtMs'>,
  nowMs: number,
  config: StreamStatusTimingConfig,
): number | null {
  if (!shouldShowStreamLastActivityAge(state, nowMs, config)) return null;
  return getStreamLastActivityAgeMs(state, nowMs);
}

export function buildStreamRuntimeStatus(
  state: Pick<StreamState, 'startedAtMs' | 'lastActivityAtMs' | 'statusNote'> & Partial<Pick<StreamState, 'thinkingNote'>>,
  nowMs: number,
  options: {
    includeLastActivityAge?: boolean;
  } = {},
): string {
  return formatStreamRuntimeStatus(
    Math.max(0, nowMs - state.startedAtMs),
    options.includeLastActivityAge
      ? getStreamLastActivityAgeMs(state, nowMs)
      : null,
    state.statusNote,
    'contextUsage' in state ? (state.contextUsage as ContextUsageInfo | null) : null,
    state.thinkingNote,
    nowMs,
  );
}
