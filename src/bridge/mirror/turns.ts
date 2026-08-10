import type { ContextUsageInfo } from '../../shared/progress/context-usage.js';
import type { RuntimeNoticeInfo, TaskProgressInfo, ToolCallInfo } from '../../domain/index.js';
import { buildMirrorStreamKey, formatMirrorUserText } from './formatters.js';
import { toolCallEventFromMirrorRecord } from '../../shared/progress/tool-events.js';
import type { BridgeMirrorRecord } from '../../runtime/contracts.js';
import {
  applyUnifiedTurnContextUsage,
  applyUnifiedTurnGoalStatus,
  applyUnifiedTurnHistoryModelText,
  applyUnifiedTurnHistoryModelTextSnapshot,
  applyUnifiedTurnHistorySystemText,
  applyUnifiedTurnHistoryMarkdown,
  applyUnifiedTurnHistoryUserText,
  applyUnifiedTurnThinkingSummary,
  applyUnifiedTurnStatusNote,
  applyUnifiedTurnThinkingNote,
  applyUnifiedTurnTasks,
  applyUnifiedTurnToolEvent,
  createUnifiedTurnProgressState,
  recordUnifiedTurnActivity,
  recordUnifiedTurnContentResponse,
  type UnifiedTurnProgressState,
} from '../turn/unified-turn-state.js';

function nowIso(): string {
  return new Date().toISOString();
}

const MIRROR_DUPLICATE_TEXT_WINDOW_MS = 2_000;
const CONTEXT_COMPACTED_NOTICE_MARKER = '上下文已压缩';
const EMPTY_GOAL_LOOP_WARNING_THRESHOLD = 3;

export interface BridgeMirrorTurnState extends UnifiedTurnProgressState {
  turnId: string | null;
  streamKey: string;
  startedAt: string;
  lastActivityAt: string;
  lastContentResponseAt?: string | null;
  /** @deprecated use lastContentResponseAt. Kept for persisted/test compatibility. */
  lastResponseAt?: string | null;
  lastStatusText: string | null;
  lastStatusAt: number;
  statusNote: string | null;
  userText: string | null;
  lastAssistantText: string | null;
  lastAssistantTextAt?: string | null;
  lastAssistantReplacementKey?: string | null;
  lastCommentaryText: string | null;
  lastCommentaryTextAt?: string | null;
  streamedText: string;
  streamStarted: boolean;
}

export interface FinalizedBridgeMirrorTurn {
  streamKey: string;
  userText: string | null;
  text: string;
  contextUsage?: ContextUsageInfo | null;
  goalStatus?: { status: string; objective: string } | null;
  signature: string;
  timestamp: string;
  startedAt?: string;
  status: 'completed' | 'interrupted' | 'error';
  errorText?: string;
  runtimeNotices?: RuntimeNoticeInfo[];
  timedOut?: boolean;
}

export interface MirrorTurnStateHolder {
  sessionId: string;
  threadId: string;
  pendingTurn: BridgeMirrorTurnState | null;
}

export interface EmptyGoalLoopGuardStateHolder extends MirrorTurnStateHolder {
  consecutiveEmptyGoalTurns: number;
  emptyGoalLoopWarningSent: boolean;
}

export interface BufferedMirrorTurnStateHolder extends MirrorTurnStateHolder {
  bufferedRecords: BridgeMirrorRecord[];
}

export interface PendingMirrorDeliveryStateHolder {
  pendingDeliveries: FinalizedBridgeMirrorTurn[];
}

export interface MirrorTurnHooks<TSubscription extends MirrorTurnStateHolder = MirrorTurnStateHolder> {
  onTurnStarted?: (subscription: TSubscription, turnState: BridgeMirrorTurnState) => void;
  onStreamText?: (subscription: TSubscription, turnState: BridgeMirrorTurnState) => void;
  onStatusProgress?: (subscription: TSubscription, turnState: BridgeMirrorTurnState) => void;
  onTaskProgress?: (subscription: TSubscription, turnState: BridgeMirrorTurnState) => void;
  onToolProgress?: (subscription: TSubscription, turnState: BridgeMirrorTurnState) => void;
}

export function createMirrorTurnState(
  sessionId: string,
  timestamp: string,
  turnId?: string,
): BridgeMirrorTurnState {
  const safeTimestamp = timestamp || nowIso();
  const startedAtMs = Date.parse(safeTimestamp);
  return {
    ...createUnifiedTurnProgressState(Number.isFinite(startedAtMs) ? startedAtMs : Date.now()),
    turnId: turnId || null,
    streamKey: buildMirrorStreamKey(sessionId, turnId || null, safeTimestamp),
    startedAt: safeTimestamp,
    lastActivityAt: safeTimestamp,
    lastContentResponseAt: null,
    lastResponseAt: null,
    lastStatusText: null,
    lastStatusAt: 0,
    statusNote: null,
    userText: null,
    lastAssistantText: null,
    lastCommentaryText: null,
    streamedText: '',
    streamStarted: false,
  };
}

export function appendMirrorUserText(
  turnState: BridgeMirrorTurnState,
  chunk: string,
): void {
  const normalized = formatMirrorUserText(chunk);
  if (!normalized) return;
  if (!turnState.userText) {
    turnState.userText = normalized;
    return;
  }
  if (turnState.userText === normalized) {
    return;
  }
  turnState.userText = `${turnState.userText}\n\n${normalized}`;
}

export function appendMirrorStreamText(
  turnState: BridgeMirrorTurnState,
  chunk: string,
): void {
  const normalized = chunk.trim();
  if (!normalized) return;
  turnState.streamedText = turnState.streamedText
    ? `${turnState.streamedText}\n\n${normalized}`
    : normalized;
}

export function ensureMirrorTurnState<TSubscription extends MirrorTurnStateHolder>(
  subscription: TSubscription,
  record: BridgeMirrorRecord,
): BridgeMirrorTurnState {
  if (!subscription.pendingTurn) {
    subscription.pendingTurn = createMirrorTurnState(subscription.sessionId, record.timestamp, record.turnId);
    return subscription.pendingTurn;
  }

  if (!subscription.pendingTurn.turnId && record.turnId) {
    subscription.pendingTurn.turnId = record.turnId;
  }
  if (record.timestamp) {
    subscription.pendingTurn.lastActivityAt = record.timestamp;
  }
  return subscription.pendingTurn;
}

function markMirrorActivity(
  turnState: BridgeMirrorTurnState,
  timestamp: string,
): void {
  const activityAt = timestamp || nowIso();
  turnState.lastActivityAt = activityAt;
  const activityMs = Date.parse(activityAt);
  recordUnifiedTurnActivity(turnState, Number.isFinite(activityMs) ? activityMs : Date.now());
}

function markMirrorContentResponse(
  turnState: BridgeMirrorTurnState,
  timestamp: string,
): void {
  const responseAt = timestamp || nowIso();
  markMirrorActivity(turnState, responseAt);
  turnState.lastContentResponseAt = responseAt;
  turnState.lastResponseAt = responseAt;
  const responseMs = Date.parse(responseAt);
  recordUnifiedTurnContentResponse(turnState, Number.isFinite(responseMs) ? responseMs : Date.now());
}

function mirrorTimestampMs(timestamp: string): number {
  const parsed = Date.parse(timestamp || '');
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function isNearDuplicateMirrorText(
  previousText: string | null,
  nextText: string,
  previousTimestamp: string | null,
  nextTimestamp: string,
): boolean {
  if (previousText !== nextText) return false;
  if (!previousTimestamp || !nextTimestamp) return true;
  const previousMs = Date.parse(previousTimestamp);
  const nextMs = Date.parse(nextTimestamp);
  if (!Number.isFinite(previousMs) || !Number.isFinite(nextMs)) return true;
  return Math.abs(nextMs - previousMs) <= MIRROR_DUPLICATE_TEXT_WINDOW_MS;
}

function buildFinalMirrorText(
  turnState: BridgeMirrorTurnState,
  preferredText?: string,
): string {
  const preferred = (preferredText || '').trim();
  const streamed = (turnState.streamedText || '').trim();
  const fallback = turnState.lastAssistantText?.trim() || turnState.lastCommentaryText?.trim() || '';
  if (!streamed || !streamed.includes(CONTEXT_COMPACTED_NOTICE_MARKER)) {
    return preferred || fallback;
  }
  if (!preferred || streamed === preferred || streamed.endsWith(preferred)) {
    return streamed;
  }
  return `${streamed}\n\n${preferred}`;
}

function isActiveGoalStatus(status: string | null | undefined): boolean {
  const normalized = (status || '').replace(/[_-]+/g, ' ').trim().toLowerCase();
  return normalized === 'active' || normalized === 'in progress' || normalized === 'running';
}

function isEmptyActiveGoalTurn(
  turnState: BridgeMirrorTurnState,
  preferredText?: string,
): boolean {
  const toolCallCount = turnState.toolCalls?.size ?? 0;
  const taskItemCount = turnState.taskItems?.length ?? 0;
  return !(preferredText || '').trim()
    && !(turnState.streamedText || '').trim()
    && !(turnState.userText || '').trim()
    && toolCallCount === 0
    && taskItemCount === 0
    && isActiveGoalStatus(turnState.goalStatus?.status);
}

function hasVisibleTurnProgress(turnState: BridgeMirrorTurnState): boolean {
  const toolCallCount = turnState.toolCalls?.size ?? 0;
  const taskItemCount = turnState.taskItems?.length ?? 0;
  return Boolean(
    (turnState.streamedText || '').trim()
    || (turnState.userText || '').trim()
    || toolCallCount > 0
    || taskItemCount > 0,
  );
}

function hasEmptyGoalLoopGuard(
  subscription: MirrorTurnStateHolder,
): subscription is EmptyGoalLoopGuardStateHolder {
  const guard = subscription as Partial<EmptyGoalLoopGuardStateHolder>;
  return typeof guard.consecutiveEmptyGoalTurns === 'number'
    && typeof guard.emptyGoalLoopWarningSent === 'boolean';
}

function resetEmptyGoalLoopCount(subscription: MirrorTurnStateHolder): void {
  if (!hasEmptyGoalLoopGuard(subscription)) return;
  subscription.consecutiveEmptyGoalTurns = 0;
}

function buildEmptyGoalLoopWarningTurn(
  subscription: EmptyGoalLoopGuardStateHolder,
  turnState: BridgeMirrorTurnState,
  signature: string,
  timestamp: string,
): FinalizedBridgeMirrorTurn {
  const objective = (turnState.goalStatus?.objective || '').replace(/\s+/g, ' ').trim();
  const compactObjective = objective.length > 160 ? `${objective.slice(0, 157)}...` : objective;
  const text = [
    '## Goal 自动重启告警',
    '',
    '| 项目 | 内容 |',
    '| --- | --- |',
    `| 状态 | 已连续 ${subscription.consecutiveEmptyGoalTurns} 轮只收到 active goal 状态，未收到 assistant 输出、工具调用或任务进展 |`,
    `| Session | ${subscription.sessionId} |`,
    `| Thread | ${subscription.threadId} |`,
    `| 最近 turn | ${turnState.turnId || 'unknown'} |`,
    compactObjective ? `| Goal | ${compactObjective.replace(/\|/g, '\\|')} |` : null,
    '',
    '当前任务可能因为环境、API 或底层 goal runner 状态异常陷入无限重启。已停止为这些空 goal turn 创建镜像流式卡片；请检查底层 JSONL、API 可用性和 goal runner 状态。',
  ].filter((line): line is string => line !== null).join('\n');

  return {
    streamKey: buildMirrorStreamKey(subscription.sessionId, `goal-loop-warning:${turnState.turnId || timestamp}`, timestamp || nowIso()),
    userText: null,
    text,
    ...(turnState.goalStatus ? { goalStatus: turnState.goalStatus } : {}),
    signature: `goal-loop-warning:${signature}`,
    timestamp: timestamp || turnState.lastActivityAt || nowIso(),
    status: 'interrupted',
  };
}

function recordEmptyGoalTurnIfNeeded<TSubscription extends MirrorTurnStateHolder>(
  subscription: TSubscription,
  turnState: BridgeMirrorTurnState,
  signature: string,
  timestamp: string,
  preferredText?: string,
): FinalizedBridgeMirrorTurn | null {
  if (!hasEmptyGoalLoopGuard(subscription)) return null;

  if (!isEmptyActiveGoalTurn(turnState, preferredText)) {
    resetEmptyGoalLoopCount(subscription);
    return null;
  }

  subscription.consecutiveEmptyGoalTurns += 1;
  if (
    subscription.consecutiveEmptyGoalTurns < EMPTY_GOAL_LOOP_WARNING_THRESHOLD
    || subscription.emptyGoalLoopWarningSent
  ) {
    return null;
  }

  subscription.emptyGoalLoopWarningSent = true;
  return buildEmptyGoalLoopWarningTurn(
    subscription,
    turnState,
    signature,
    timestamp,
  );
}

export function finalizeMirrorTurn<TSubscription extends MirrorTurnStateHolder>(
  subscription: TSubscription,
  signature: string,
  timestamp: string,
  status: 'completed' | 'interrupted' | 'error',
  preferredText?: string,
): FinalizedBridgeMirrorTurn | null {
  const pendingTurn = subscription.pendingTurn;
  subscription.pendingTurn = null;
  if (!pendingTurn) return null;

  const emptyGoalWarning = recordEmptyGoalTurnIfNeeded(subscription, pendingTurn, signature, timestamp, preferredText);
  if (emptyGoalWarning) return emptyGoalWarning;
  if (isEmptyActiveGoalTurn(pendingTurn, preferredText)) return null;

  const text = buildFinalMirrorText(pendingTurn, preferredText);
  const userText = pendingTurn.userText?.trim() || null;
  if (
    !text
    && !userText
    && (pendingTurn.toolCalls?.size ?? 0) === 0
    && (pendingTurn.taskItems?.length ?? 0) === 0
  ) {
    return null;
  }
  resetEmptyGoalLoopCount(subscription);

  return {
    streamKey: pendingTurn.streamKey,
    userText,
    text,
    ...(pendingTurn.contextUsage ? { contextUsage: pendingTurn.contextUsage } : {}),
    ...(pendingTurn.goalStatus ? { goalStatus: pendingTurn.goalStatus } : {}),
    signature,
    timestamp: timestamp || pendingTurn.lastActivityAt || nowIso(),
    startedAt: pendingTurn.startedAt,
    status,
    ...(signature.startsWith('timeout:') ? { timedOut: true } : {}),
  };
}

export function consumeMirrorRecords<TSubscription extends MirrorTurnStateHolder>(
  subscription: TSubscription,
  records: BridgeMirrorRecord[],
  hooks: MirrorTurnHooks<TSubscription> = {},
): FinalizedBridgeMirrorTurn[] {
  const finalized: FinalizedBridgeMirrorTurn[] = [];

  for (const record of records) {
    if (record.type === 'task_started') {
      const pendingTurn = subscription.pendingTurn;
      const sameTurn = pendingTurn && (
        !pendingTurn.turnId
        || !record.turnId
        || pendingTurn.turnId === record.turnId
      );
      if (!sameTurn) {
        const superseded = finalizeMirrorTurn(subscription, `superseded:${record.signature}`, record.timestamp, 'interrupted');
        if (superseded) finalized.push(superseded);
      }
      if (!subscription.pendingTurn) {
        subscription.pendingTurn = createMirrorTurnState(subscription.sessionId, record.timestamp, record.turnId);
      } else {
        if (!subscription.pendingTurn.turnId && record.turnId) {
          subscription.pendingTurn.turnId = record.turnId;
        }
        if (record.timestamp) {
          subscription.pendingTurn.lastActivityAt = record.timestamp;
        }
      }
      if (subscription.pendingTurn) {
        hooks.onTurnStarted?.(subscription, subscription.pendingTurn);
      }
      continue;
    }

    if (record.type === 'task_complete') {
      ensureMirrorTurnState(subscription, record);
      const completed = finalizeMirrorTurn(
        subscription,
        record.signature,
        record.timestamp,
        record.isError ? 'error' : 'completed',
        record.content || record.errorText,
      );
      if (completed && record.errorText) completed.errorText = record.errorText;
      if (completed) finalized.push(completed);
      continue;
    }

    if (record.type === 'task_aborted') {
      ensureMirrorTurnState(subscription, record);
      const interrupted = finalizeMirrorTurn(subscription, record.signature, record.timestamp, 'interrupted');
      if (interrupted) finalized.push(interrupted);
      continue;
    }

    if (record.type === 'message' && record.role === 'user') {
      const pendingTurn = ensureMirrorTurnState(subscription, record);
      const text = record.content.trim();
      if (text) {
        appendMirrorUserText(pendingTurn, text);
        applyUnifiedTurnHistoryUserText(pendingTurn, (record.userPrompt || text).trim());
        hooks.onStreamText?.(subscription, pendingTurn);
      }
      continue;
    }

    if (record.type === 'context_usage') {
      const pendingTurn = ensureMirrorTurnState(subscription, record);
      applyUnifiedTurnContextUsage(pendingTurn, record.contextUsage || null, mirrorTimestampMs(record.timestamp));
      pendingTurn.lastActivityAt = record.timestamp || nowIso();
      hooks.onStatusProgress?.(subscription, pendingTurn);
      continue;
    }

    if (record.type === 'goal_status') {
      const pendingTurn = ensureMirrorTurnState(subscription, record);
      applyUnifiedTurnGoalStatus(pendingTurn, {
        status: record.goalStatus || 'active',
        objective: record.goalObjective || record.content || '',
      }, mirrorTimestampMs(record.timestamp));
      pendingTurn.lastActivityAt = record.timestamp || nowIso();
      if (hasVisibleTurnProgress(pendingTurn)) {
        hooks.onStreamText?.(subscription, pendingTurn);
      }
      continue;
    }

    if (record.type === 'message') {
      const pendingTurn = ensureMirrorTurnState(subscription, record);
      if (record.role === 'assistant') {
        const text = record.content.trim();
        if (text) {
          if (isNearDuplicateMirrorText(
            pendingTurn.lastAssistantText,
            text,
            pendingTurn.lastAssistantTextAt ?? null,
            record.timestamp,
          )) continue;
          pendingTurn.lastAssistantText = text;
          pendingTurn.lastAssistantTextAt = record.timestamp || nowIso();
          if (record.replacementKey) {
            if (
              !pendingTurn.lastAssistantReplacementKey
              || pendingTurn.lastAssistantReplacementKey === record.replacementKey
            ) {
              pendingTurn.streamedText = text;
            } else {
              appendMirrorStreamText(pendingTurn, text);
            }
            pendingTurn.lastAssistantReplacementKey = record.replacementKey;
            applyUnifiedTurnHistoryModelTextSnapshot(pendingTurn, text);
          } else {
            appendMirrorStreamText(pendingTurn, text);
            applyUnifiedTurnHistoryModelText(pendingTurn, text);
          }
          markMirrorContentResponse(pendingTurn, record.timestamp);
          hooks.onStreamText?.(subscription, pendingTurn);
        }
      } else if (record.role === 'commentary') {
        const text = record.content.trim();
        if (text) {
          if (isNearDuplicateMirrorText(
            pendingTurn.lastCommentaryText,
            text,
            pendingTurn.lastCommentaryTextAt ?? null,
            record.timestamp,
          )) continue;
          pendingTurn.lastCommentaryText = text;
          pendingTurn.lastCommentaryTextAt = record.timestamp || nowIso();
          appendMirrorStreamText(pendingTurn, text);
          applyUnifiedTurnHistoryModelText(pendingTurn, text);
          markMirrorContentResponse(pendingTurn, record.timestamp);
          hooks.onStreamText?.(subscription, pendingTurn);
        }
      } else if (record.role === 'system') {
        const text = record.content.trim();
        if (text) {
          applyUnifiedTurnHistorySystemText(pendingTurn, text);
          pendingTurn.lastActivityAt = record.timestamp || nowIso();
          hooks.onStreamText?.(subscription, pendingTurn);
        }
      }
      continue;
    }

    if (record.type === 'reasoning') {
      const pendingTurn = ensureMirrorTurnState(subscription, record);
      const text = record.content.trim();
      if (!text) continue;
      if (record.reasoningKind === 'summary') {
        applyUnifiedTurnThinkingSummary(pendingTurn, text);
        pendingTurn.lastActivityAt = record.timestamp || nowIso();
        hooks.onStreamText?.(subscription, pendingTurn);
        continue;
      }
      if (record.reasoningKind === 'history') {
        applyUnifiedTurnHistoryMarkdown(pendingTurn, 'thinking', text);
        pendingTurn.lastActivityAt = record.timestamp || nowIso();
        hooks.onStreamText?.(subscription, pendingTurn);
        continue;
      }
      if (record.reasoningKind === 'thinking') {
        applyUnifiedTurnThinkingNote(pendingTurn, text, mirrorTimestampMs(record.timestamp));
        applyUnifiedTurnStatusNote(pendingTurn, record.reasoningLabel || '思考', mirrorTimestampMs(record.timestamp));
        pendingTurn.lastActivityAt = record.timestamp || nowIso();
        hooks.onStatusProgress?.(subscription, pendingTurn);
        continue;
      }
      applyUnifiedTurnStatusNote(pendingTurn, text, mirrorTimestampMs(record.timestamp));
      pendingTurn.lastActivityAt = record.timestamp || nowIso();
      hooks.onStatusProgress?.(subscription, pendingTurn);
      continue;
    }

    if (record.type === 'plan_update') {
      const pendingTurn = ensureMirrorTurnState(subscription, record);
      applyUnifiedTurnTasks(pendingTurn, record.tasks || [], mirrorTimestampMs(record.timestamp));
      pendingTurn.lastActivityAt = record.timestamp || nowIso();
      hooks.onTaskProgress?.(subscription, pendingTurn);
      continue;
    }

    if (record.type === 'tool_started') {
      const pendingTurn = ensureMirrorTurnState(subscription, record);
      const event = toolCallEventFromMirrorRecord(record);
      if (event) {
        applyUnifiedTurnToolEvent(pendingTurn, event, {
          timestampMs: mirrorTimestampMs(record.timestamp),
        });
      }
      pendingTurn.lastActivityAt = record.timestamp || nowIso();
      hooks.onToolProgress?.(subscription, pendingTurn);
      continue;
    }

    if (record.type === 'tool_finished') {
      const pendingTurn = ensureMirrorTurnState(subscription, record);
      const event = toolCallEventFromMirrorRecord(record);
      if (event) {
        applyUnifiedTurnToolEvent(pendingTurn, event, {
          timestampMs: mirrorTimestampMs(record.timestamp),
        });
      }
      pendingTurn.lastActivityAt = record.timestamp || nowIso();
      hooks.onToolProgress?.(subscription, pendingTurn);
      continue;
    }
  }

  return finalized;
}

export function flushTimedOutMirrorTurn<TSubscription extends MirrorTurnStateHolder>(
  subscription: TSubscription,
  idleTimeoutMs: number,
  nowMs = Date.now(),
): FinalizedBridgeMirrorTurn | null {
  const pendingTurn = subscription.pendingTurn;
  if (!pendingTurn?.lastActivityAt) return null;
  const lastActivityMs = Date.parse(pendingTurn.lastActivityAt);
  if (!Number.isFinite(lastActivityMs)) return null;
  if (nowMs - lastActivityMs < idleTimeoutMs) {
    return null;
  }

  return finalizeMirrorTurn(
    subscription,
    `timeout:${subscription.threadId}:${pendingTurn.turnId || pendingTurn.lastActivityAt}`,
    pendingTurn.lastActivityAt,
    'interrupted',
  );
}

export function enqueuePendingMirrorDeliveries<TSubscription extends PendingMirrorDeliveryStateHolder>(
  subscription: TSubscription,
  turns: FinalizedBridgeMirrorTurn[],
): void {
  if (turns.length === 0) return;
  const existingSignatures = new Set(subscription.pendingDeliveries.map((turn) => turn.signature));
  for (const turn of turns) {
    if (existingSignatures.has(turn.signature)) continue;
    subscription.pendingDeliveries.push(turn);
    existingSignatures.add(turn.signature);
  }
}

export function removePendingMirrorDeliveries<TSubscription extends PendingMirrorDeliveryStateHolder>(
  subscription: TSubscription,
  turns: FinalizedBridgeMirrorTurn[],
): void {
  if (turns.length === 0 || subscription.pendingDeliveries.length === 0) return;
  const deliveredSignatures = new Set(turns.map((turn) => turn.signature));
  subscription.pendingDeliveries = subscription.pendingDeliveries.filter(
    (turn) => !deliveredSignatures.has(turn.signature),
  );
}

export function selectPendingMirrorDeliveries<TSubscription extends PendingMirrorDeliveryStateHolder>(
  subscription: TSubscription,
  blocked: boolean,
): FinalizedBridgeMirrorTurn[] {
  if (!blocked) {
    return subscription.pendingDeliveries.slice();
  }
  return subscription.pendingDeliveries.filter((turn) => turn.timedOut);
}

export function hasPendingMirrorWork(
  subscription: BufferedMirrorTurnStateHolder & PendingMirrorDeliveryStateHolder,
): boolean {
  return subscription.bufferedRecords.length > 0
    || subscription.pendingTurn !== null
    || subscription.pendingDeliveries.length > 0;
}

export function consumeBufferedMirrorTurns<TSubscription extends BufferedMirrorTurnStateHolder>(
  subscription: TSubscription,
  idleTimeoutMs: number,
  nowMs = Date.now(),
  hooks: MirrorTurnHooks<TSubscription> = {},
): FinalizedBridgeMirrorTurn[] {
  const bufferedRecords = subscription.bufferedRecords;
  subscription.bufferedRecords = [];

  const finalizedTurns = bufferedRecords.length > 0
    ? consumeMirrorRecords(subscription, bufferedRecords, hooks)
    : [];

  const timedOutTurn = flushTimedOutMirrorTurn(subscription, idleTimeoutMs, nowMs);
  if (timedOutTurn) {
    finalizedTurns.push(timedOutTurn);
  }

  return finalizedTurns;
}
