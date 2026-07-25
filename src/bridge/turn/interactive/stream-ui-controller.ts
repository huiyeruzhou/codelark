import type {
  BaseChannelAdapter,
  StructuredStreamingUiActionButton,
  StructuredStreamingUiMetadata,
  StructuredStreamingUiSnapshot,
} from '../../../channels/contracts.js';
import {
  finalizeStreamFeedback,
  pushStreamFeedbackActions,
  pushStreamFeedbackHistory,
  pushStreamFeedbackMetadata,
  pushStreamFeedbackStatus,
  pushStreamFeedbackTasks,
  pushStreamFeedbackText,
  pushStreamFeedbackTools,
  type StreamFeedbackTarget,
} from '../../../channels/delivery/stream-feedback.js';
import type { StreamingHistoryItem, TaskProgressInfo, ToolCallInfo } from '../../../domain/index.js';
import { appendContextUsageCompactText } from '../../../shared/progress/context-usage.js';
import {
  buildStreamRuntimeStatus,
  formatStreamRuntimeStatus,
  getVisibleStreamLastActivityAgeMs,
  type StreamState,
  type StreamStatusTimingConfig,
} from '../stream-state.js';

export type InteractiveStreamUiTerminalStatus = 'completed' | 'interrupted' | 'error';

export interface InteractiveStreamUiTaskState {
  structuredStreamUiActive: boolean;
  streamFinalized: boolean;
}

export interface InteractiveStreamFeedbackTarget {
  adapter: BaseChannelAdapter;
  channelType: string;
  chatId: string;
  streamKey?: string;
  ensureStarted?(): void;
}

export interface InteractiveStreamFeedback {
  readonly target: InteractiveStreamFeedbackTarget;
  pushText(text: string): void;
  pushHistory(items: StreamingHistoryItem[]): void;
  pushTools(tools: ToolCallInfo[]): void;
  pushTasks(tasks: TaskProgressInfo[]): void;
  pushStatus(text: string): boolean;
  pushMetadata(metadata: StructuredStreamingUiMetadata): boolean;
  pushActions(actions: StructuredStreamingUiActionButton[][]): boolean;
  finalize(status: 'completed' | 'interrupted' | 'error', text: string): Promise<boolean>;
}

export interface CreateInteractiveStreamUiControllerParams {
  adapter: BaseChannelAdapter;
  channelType: string;
  chatId: string;
  streamKey: string;
  sessionId: string;
  streamState: StreamState;
  taskState: InteractiveStreamUiTaskState;
  statusTiming: StreamStatusTimingConfig;
  stopCallbackData?: string;
  nowMs(): number;
  setIntervalFn(callback: () => void, intervalMs: number): unknown;
  clearIntervalFn(handle: unknown): void;
  ensureStarted(): void;
  isCurrentTask(): boolean;
  isAborted(): boolean;
  endPreview(): void;
  normalizeFinalText(text: string): string;
  recordSnapshot?(sessionId: string, snapshot: StructuredStreamingUiSnapshot): void;
}

export interface InteractiveStreamUiController {
  readonly target: InteractiveStreamFeedbackTarget;
  readonly feedback: InteractiveStreamFeedback;
  readonly hasStreamingCards: boolean;
  readonly supportsStructuredStreamUi: boolean;
  pushMetadata(metadata: StructuredStreamingUiMetadata): void;
  pushRunningStatus(lastActivityAgeMs?: number | null): void;
  syncSnapshot(): void;
  startStatusHeartbeat(): void;
  stopStatusUpdates(): void;
  recordInactiveOnce(): void;
  finalizeOnce(status: InteractiveStreamUiTerminalStatus, responseText: string): Promise<boolean>;
  shouldSkipTextDelivery(): boolean;
}

function buildStopActions(
  callbackData: string,
  terminal?: InteractiveStreamUiTerminalStatus,
): StructuredStreamingUiActionButton[][] {
  if (terminal === 'completed') return [];
  return [[{
    text: terminal === 'interrupted' ? '已停止' : terminal ? '已结束' : '停止',
    callbackData,
    type: terminal ? 'default' : 'danger',
    disabled: Boolean(terminal),
  }]];
}

function createInteractiveStreamFeedback(
  target: InteractiveStreamFeedbackTarget,
): InteractiveStreamFeedback {
  const sharedTarget: StreamFeedbackTarget = target;
  return {
    target,
    pushText(text) {
      pushStreamFeedbackText(sharedTarget, text);
    },
    pushHistory(items) {
      pushStreamFeedbackHistory(sharedTarget, items);
    },
    pushTools(tools) {
      pushStreamFeedbackTools(sharedTarget, tools);
    },
    pushTasks(tasks) {
      pushStreamFeedbackTasks(sharedTarget, tasks);
    },
    pushStatus(text) {
      return pushStreamFeedbackStatus(sharedTarget, text);
    },
    pushMetadata(metadata) {
      return pushStreamFeedbackMetadata(sharedTarget, metadata);
    },
    pushActions(actions) {
      return pushStreamFeedbackActions(sharedTarget, actions);
    },
    finalize(status, text) {
      return finalizeStreamFeedback(sharedTarget, status, text);
    },
  };
}

export function createInteractiveStreamUiController(
  params: CreateInteractiveStreamUiControllerParams,
): InteractiveStreamUiController {
  const target: InteractiveStreamFeedbackTarget = {
    adapter: params.adapter,
    channelType: params.channelType,
    chatId: params.chatId,
    streamKey: params.streamKey,
    ensureStarted: params.ensureStarted,
  };
  const baseFeedback = createInteractiveStreamFeedback(target);
  let hasStructuredContent = false;
  const feedback: InteractiveStreamFeedback = {
    ...baseFeedback,
    pushText(text) {
      hasStructuredContent = hasStructuredContent || Boolean(text.trim());
      baseFeedback.pushText(text);
    },
    pushHistory(items) {
      hasStructuredContent = hasStructuredContent || items.length > 0;
      baseFeedback.pushHistory(items);
    },
    pushTools(tools) {
      hasStructuredContent = hasStructuredContent || tools.length > 0;
      baseFeedback.pushTools(tools);
    },
    pushTasks(tasks) {
      hasStructuredContent = hasStructuredContent || tasks.length > 0;
      baseFeedback.pushTasks(tasks);
    },
  };
  const hasStreamingCards = typeof params.adapter.onStreamText === 'function';
  const supportsPersistentStreamStatus = hasStreamingCards
    && params.adapter.provider === 'feishu'
    && typeof params.adapter.onStreamStatus === 'function';
  const supportsStructuredStreamUi = supportsPersistentStreamStatus
    && (params.adapter.supportsStructuredStreamingUi?.(params.chatId) ?? true);

  let streamStatusHeartbeat: unknown = null;
  let streamStatusUpdatesClosed = false;
  let structuredStreamInactiveRecorded = false;
  let streamUiFinalizeAttempted = false;

  const clearStatusHeartbeat = () => {
    if (streamStatusHeartbeat == null) return;
    params.clearIntervalFn(streamStatusHeartbeat);
    streamStatusHeartbeat = null;
  };

  const syncState = () => {
    if (!supportsStructuredStreamUi || params.taskState.structuredStreamUiActive) return;
    if (params.adapter.hasActiveStreamingUi?.(params.chatId, params.streamKey)) {
      params.taskState.structuredStreamUiActive = true;
    }
  };

  const syncSnapshot = () => {
    if (!supportsStructuredStreamUi) return;
    syncState();
    const snapshot = params.adapter.getStructuredStreamingUiSnapshot?.(params.chatId, params.streamKey);
    if (!snapshot) return;
    params.recordSnapshot?.(params.sessionId, snapshot);
  };

  const getVisibleLastActivityAgeMs = (nowMs: number) => getVisibleStreamLastActivityAgeMs(
    params.streamState,
    nowMs,
    params.statusTiming,
  );

  const pushRunningStatus = (lastActivityAgeMs?: number | null) => {
    if (!supportsStructuredStreamUi || streamStatusUpdatesClosed) return;
    const nowMs = params.nowMs();
    const effectiveLastActivityAgeMs = lastActivityAgeMs === undefined
      ? getVisibleLastActivityAgeMs(nowMs)
      : lastActivityAgeMs;
    feedback.pushStatus(
      effectiveLastActivityAgeMs == null
        ? buildStreamRuntimeStatus(params.streamState, nowMs)
        : formatStreamRuntimeStatus(
            Math.max(0, nowMs - params.streamState.startedAtMs),
            effectiveLastActivityAgeMs,
            params.streamState.statusNote,
            params.streamState.contextUsage,
            params.streamState.thinkingNote,
            nowMs,
          ),
    );
    syncSnapshot();
  };

  const stopStatusUpdates = () => {
    streamStatusUpdatesClosed = true;
    clearStatusHeartbeat();
  };

  return {
    target,
    feedback,
    hasStreamingCards,
    supportsStructuredStreamUi,
    pushMetadata(metadata) {
      if (hasStreamingCards) {
        feedback.pushMetadata(metadata);
      }
    },
    pushRunningStatus,
    syncSnapshot,
    startStatusHeartbeat() {
      if (!supportsStructuredStreamUi) return;
      if (params.stopCallbackData) {
        feedback.pushActions(buildStopActions(params.stopCallbackData));
      }
      pushRunningStatus();
      streamStatusHeartbeat = params.setIntervalFn(() => {
        if (streamStatusUpdatesClosed) {
          clearStatusHeartbeat();
          return;
        }
        if (!params.isCurrentTask() || params.isAborted()) {
          clearStatusHeartbeat();
          return;
        }
        pushRunningStatus();
      }, params.statusTiming.heartbeatMs);
    },
    stopStatusUpdates,
    recordInactiveOnce() {
      if (structuredStreamInactiveRecorded) return;
      structuredStreamInactiveRecorded = true;
      params.taskState.structuredStreamUiActive = false;
      params.recordSnapshot?.(params.sessionId, { active: false });
    },
    async finalizeOnce(status, responseText) {
      stopStatusUpdates();
      this.recordInactiveOnce();
      params.endPreview();
      if (supportsStructuredStreamUi && params.stopCallbackData) {
        feedback.pushActions(buildStopActions(params.stopCallbackData, status));
      }
      if (hasStreamingCards && !streamUiFinalizeAttempted) {
        streamUiFinalizeAttempted = true;
        const finalText = status === 'completed' || status === 'error'
          ? appendContextUsageCompactText(responseText, params.streamState.contextUsage)
          : responseText;
        params.taskState.streamFinalized = await feedback.finalize(
          status,
          params.normalizeFinalText(finalText),
        );
      }
      return params.taskState.streamFinalized;
    },
    shouldSkipTextDelivery() {
      if (!hasStreamingCards) return false;
      if (!hasStructuredContent) return false;
      if (params.taskState.structuredStreamUiActive) return true;
      if (params.adapter.hasActiveStreamingUi?.(params.chatId, params.streamKey)) return true;
      return false;
    },
  };
}
