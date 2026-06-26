import type { BaseChannelAdapter } from '../../channels/contracts.js';
import { deliver } from '../../channels/delivery/deliver.js';
import {
  getChannelProviderKey,
  getFeedbackParseMode,
  renderFeedbackText,
} from '../../channels/adapter-runtime/channel-runtime.js';
import {
  appendMirrorTimeoutNotice,
  buildMirrorTitle,
  formatMirrorMessage,
} from './formatters.js';
import type {
  BridgeMirrorTurnState,
  FinalizedBridgeMirrorTurn,
  MirrorTurnHooks,
} from './turns.js';
import type { BridgeMirrorSubscription } from './subscription-state.js';
import { appendContextUsageCompactText } from '../../shared/progress/context-usage.js';
import {
  stripOutboundArtifactBlocksForStreaming,
} from '../../channels/delivery/artifacts.js';
import {
  finalizeStreamFeedback,
  pushStreamFeedbackHistory,
  pushStreamFeedbackStatus,
  pushStreamFeedbackTasks,
  pushStreamFeedbackText,
  pushStreamFeedbackTools,
} from '../../channels/delivery/stream-feedback.js';
import { buildStreamContextTags, formatStreamTagLabel } from '../../shared/streaming-metadata.js';
import {
  assembleCodexFinalResponse,
} from '../turn/response-assembler.js';
import {
  deliverFinalResponse,
  type DeliverResponseImpl,
} from '../turn/delivery-pipeline.js';
import {
  formatStreamRuntimeStatus,
  getStreamLastContentResponseAgeMs,
  getVisibleStreamLastContentResponseAgeMs,
  shouldShowStreamLastContentResponseAge,
} from '../turn/stream-state.js';

export interface MirrorStructuredStreamStatusConfig {
  idleStartMs: number;
  heartbeatMs: number;
}

export interface MirrorFeedbackControllerDeps {
  getAdapter(channelType: string): BaseChannelAdapter | null | undefined;
  getThreadTitle(threadId: string, sessionId?: string, bindingId?: string): string | null | undefined;
  getRuntimeTags?(threadId: string, sessionId?: string, bindingId?: string): string[];
  getAssistantLabel?(threadId: string, sessionId?: string, bindingId?: string): string;
  onMirrorStreamStart?(subscription: BridgeMirrorSubscription, turnState: BridgeMirrorTurnState): void;
  getStructuredStreamStatusConfig?(): MirrorStructuredStreamStatusConfig;
  nowIso(): string;
  eventBatchLimit: number;
  deliverResponse: DeliverResponseImpl;
}

export interface MirrorFeedbackController {
  hooks: MirrorTurnHooks<BridgeMirrorSubscription>;
  refreshMirrorStreamingStatus(
    subscription: BridgeMirrorSubscription,
    nowMs?: number,
    config?: MirrorStructuredStreamStatusConfig,
  ): void;
  stopMirrorStreaming(
    subscription: BridgeMirrorSubscription,
    status?: 'completed' | 'interrupted',
  ): void;
  deliverMirrorTurns(
    subscription: BridgeMirrorSubscription,
    turns: FinalizedBridgeMirrorTurn[],
  ): Promise<{ deliveredCount: number; error?: unknown }>;
}

function createMirrorStreamFeedbackTarget(
  subscription: BridgeMirrorSubscription,
  turnState: BridgeMirrorTurnState,
  adapter: BaseChannelAdapter,
  startMirrorStreaming: (subscription: BridgeMirrorSubscription, turnState: BridgeMirrorTurnState) => void,
) {
  return {
    adapter,
    channelType: subscription.channelType,
    chatId: subscription.chatId,
    streamKey: turnState.streamKey,
    ensureStarted: () => {
      startMirrorStreaming(subscription, turnState);
    },
  };
}

export function createMirrorFeedbackController(
  deps: MirrorFeedbackControllerDeps,
): MirrorFeedbackController {
  function getMirrorStreamingAdapter(subscription: BridgeMirrorSubscription): BaseChannelAdapter | null {
    const adapter = deps.getAdapter(subscription.channelType);
    if (!adapter || !adapter.isRunning()) return null;
    if (getChannelProviderKey(subscription.channelType) !== 'feishu') return null;
    if (typeof adapter.onStreamText !== 'function' || typeof adapter.onStreamEnd !== 'function') {
      return null;
    }
    return adapter;
  }

  function getMirrorStreamingText(
    subscription: BridgeMirrorSubscription,
    turnState: BridgeMirrorTurnState,
  ): string {
    const baseTitle = deps.getThreadTitle(subscription.threadId, subscription.sessionId, subscription.bindingId)?.trim() || '本地会话';
    const markdown = getFeedbackParseMode(subscription.channelType) === 'Markdown';
    const rendered = formatMirrorMessage(
      baseTitle,
      turnState.userText,
      stripOutboundArtifactBlocksForStreaming(turnState.streamedText),
      markdown,
      true,
      false,
      turnState.goalStatus,
      deps.getAssistantLabel?.(subscription.threadId, subscription.sessionId, subscription.bindingId),
    );
    return rendered || buildMirrorTitle(baseTitle, markdown);
  }

  function getMirrorStreamMetadata(subscription: BridgeMirrorSubscription) {
    return {
      title: deps.getThreadTitle(subscription.threadId, subscription.sessionId, subscription.bindingId)?.trim() || '本地会话',
      tags: [
        ...(deps.getRuntimeTags?.(subscription.threadId, subscription.sessionId, subscription.bindingId) || []),
        ...buildStreamContextTags({
          bindingId: subscription.bindingId,
          fallbackId: subscription.sessionId,
          bridgeSessionId: subscription.sessionId,
          threadId: subscription.threadId,
          creatorKind: 'desktop',
          source: 'mirror',
        }),
      ],
    };
  }

  function getMirrorPlainTextTitle(subscription: BridgeMirrorSubscription, baseTitle: string): string {
    const tags = [
      ...(deps.getRuntimeTags?.(subscription.threadId, subscription.sessionId, subscription.bindingId) || []),
      ...buildStreamContextTags({
        bindingId: subscription.bindingId,
        fallbackId: subscription.sessionId,
        bridgeSessionId: subscription.sessionId,
        threadId: subscription.threadId,
        creatorKind: 'desktop',
        source: 'mirror',
      }),
    ];
    return tags.length > 0 ? `${baseTitle}  ${tags.map(formatStreamTagLabel).join(' ')}` : baseTitle;
  }

  function startMirrorStreaming(
    subscription: BridgeMirrorSubscription,
    turnState: BridgeMirrorTurnState,
  ): void {
    const adapter = getMirrorStreamingAdapter(subscription);
    if (!adapter || turnState.streamStarted) return;

    try {
      adapter.onStreamMetadata?.(subscription.chatId, getMirrorStreamMetadata(subscription), turnState.streamKey);
      adapter.onMirrorStreamStart?.(subscription.chatId, turnState.streamKey);
      deps.onMirrorStreamStart?.(subscription, turnState);
      if (!adapter.onMirrorStreamStart) {
        adapter.onStreamText?.(subscription.chatId, '', turnState.streamKey);
      }
      turnState.streamStarted = true;
    } catch {
      // Non-critical best effort only.
    }
  }

  function createStreamTarget(
    subscription: BridgeMirrorSubscription,
    turnState: BridgeMirrorTurnState,
    adapter: BaseChannelAdapter,
  ) {
    return createMirrorStreamFeedbackTarget(subscription, turnState, adapter, startMirrorStreaming);
  }

  function pushMirrorStreamingStatus(
    subscription: BridgeMirrorSubscription,
    turnState: BridgeMirrorTurnState,
    options: {
      nowMs?: number;
      lastResponseAgeMs?: number | null;
      minIntervalMs?: number;
    } = {},
  ): void {
    const adapter = getMirrorStreamingAdapter(subscription);
    if (!adapter || typeof adapter.onStreamStatus !== 'function') return;
    if (!(adapter.supportsStructuredStreamingUi?.(subscription.chatId) ?? true)) return;

    const startedAtMs = Date.parse(turnState.startedAt);
    if (!Number.isFinite(startedAtMs)) return;

    const nowMs = options.nowMs ?? Date.now();
    const minIntervalMs = Math.max(0, options.minIntervalMs ?? 0);
    if (minIntervalMs > 0 && turnState.lastStatusAt > 0 && nowMs - turnState.lastStatusAt < minIntervalMs) {
      return;
    }

    const lastContentResponseAtMs = turnState.lastContentResponseAt
      ? Date.parse(turnState.lastContentResponseAt)
      : turnState.lastResponseAt
        ? Date.parse(turnState.lastResponseAt)
        : null;
    const streamState = {
      startedAtMs,
      lastContentResponseAtMs: Number.isFinite(lastContentResponseAtMs) ? lastContentResponseAtMs : null,
    };
    const statusConfig = deps.getStructuredStreamStatusConfig?.();
    const effectiveLastResponseAgeMs = Object.prototype.hasOwnProperty.call(options, 'lastResponseAgeMs')
      ? options.lastResponseAgeMs
      : statusConfig
        ? getVisibleStreamLastContentResponseAgeMs(streamState, nowMs, statusConfig)
        : null;
    const statusText = formatStreamRuntimeStatus(
      Math.max(0, nowMs - startedAtMs),
      effectiveLastResponseAgeMs,
      turnState.statusNote,
      turnState.contextUsage,
      turnState.thinkingNote,
    );
    if (turnState.lastStatusText === statusText) return;

    const pushed = pushStreamFeedbackStatus(
      createStreamTarget(subscription, turnState, adapter),
      statusText,
    );
    if (!pushed) return;
    turnState.lastStatusText = statusText;
    turnState.lastStatusAt = nowMs;
  }

  function refreshMirrorStreamingStatus(
    subscription: BridgeMirrorSubscription,
    nowMs = Date.now(),
    config: MirrorStructuredStreamStatusConfig,
  ): void {
    const pendingTurn = subscription.pendingTurn;
    if (!pendingTurn?.streamStarted) return;

    const startedAtMs = Date.parse(pendingTurn.startedAt);
    if (!Number.isFinite(startedAtMs)) return;

    const lastContentResponseAtMs = pendingTurn.lastContentResponseAt
      ? Date.parse(pendingTurn.lastContentResponseAt)
      : pendingTurn.lastResponseAt
        ? Date.parse(pendingTurn.lastResponseAt)
        : null;
    const streamState = {
      startedAtMs,
      lastContentResponseAtMs: Number.isFinite(lastContentResponseAtMs) ? lastContentResponseAtMs : null,
    };
    if (!shouldShowStreamLastContentResponseAge(streamState, nowMs, config)) return;

    pushMirrorStreamingStatus(subscription, pendingTurn, {
      nowMs,
      lastResponseAgeMs: getStreamLastContentResponseAgeMs(streamState, nowMs),
      minIntervalMs: config.heartbeatMs,
    });
  }

  function updateMirrorStreaming(
    subscription: BridgeMirrorSubscription,
    turnState: BridgeMirrorTurnState,
  ): void {
    const adapter = getMirrorStreamingAdapter(subscription);
    if (!adapter) return;
    pushStreamFeedbackText(
      createStreamTarget(subscription, turnState, adapter),
      getMirrorStreamingText(subscription, turnState),
    );
    pushStreamFeedbackHistory(
      createStreamTarget(subscription, turnState, adapter),
      turnState.historyItems,
    );
    pushMirrorStreamingStatus(subscription, turnState);
  }

  function updateMirrorToolProgress(
    subscription: BridgeMirrorSubscription,
    turnState: BridgeMirrorTurnState,
  ): void {
    const adapter = getMirrorStreamingAdapter(subscription);
    if (!adapter) return;
    pushStreamFeedbackTools(
      createStreamTarget(subscription, turnState, adapter),
      Array.from(turnState.toolCalls.values()),
    );
    pushStreamFeedbackHistory(
      createStreamTarget(subscription, turnState, adapter),
      turnState.historyItems,
    );
    pushMirrorStreamingStatus(subscription, turnState);
  }

  function updateMirrorTaskProgress(
    subscription: BridgeMirrorSubscription,
    turnState: BridgeMirrorTurnState,
  ): void {
    const adapter = getMirrorStreamingAdapter(subscription);
    if (!adapter) return;
    pushStreamFeedbackTasks(
      createStreamTarget(subscription, turnState, adapter),
      turnState.taskItems,
    );
    pushMirrorStreamingStatus(subscription, turnState);
  }

  function updateMirrorStatusProgress(
    subscription: BridgeMirrorSubscription,
    turnState: BridgeMirrorTurnState,
  ): void {
    const adapter = getMirrorStreamingAdapter(subscription);
    if (!adapter) return;
    pushMirrorStreamingStatus(subscription, turnState);
  }

  function stopMirrorStreaming(
    subscription: BridgeMirrorSubscription,
    status: 'completed' | 'interrupted' = 'interrupted',
  ): void {
    const adapter = getMirrorStreamingAdapter(subscription);
    const pendingTurn = subscription.pendingTurn;
    if (!adapter || !pendingTurn?.streamStarted) return;
    void finalizeStreamFeedback(
      createStreamTarget(subscription, pendingTurn, adapter),
      status,
      getMirrorStreamingText(subscription, pendingTurn),
    );
  }

  async function deliverMirrorTurn(
    subscription: BridgeMirrorSubscription,
    turn: FinalizedBridgeMirrorTurn,
  ): Promise<void> {
    const adapter = deps.getAdapter(subscription.channelType);
    if (!adapter || !adapter.isRunning()) return;

    const baseTitle = deps.getThreadTitle(subscription.threadId, subscription.sessionId, subscription.bindingId)?.trim() || '本地会话';
    const plainTextTitle = getMirrorPlainTextTitle(subscription, baseTitle);
    const responseParseMode = getFeedbackParseMode(subscription.channelType);
    const markdown = responseParseMode === 'Markdown';
    const rawFinalResponse = assembleCodexFinalResponse({ text: turn.text });
    const attachments = rawFinalResponse.attachments;
    const questions = rawFinalResponse.questions;
    const cleanTurnText = rawFinalResponse.text;
    if (attachments.length > 0 || questions.length > 0) {
      console.log('[bridge-manager] Mirror final artifacts parsed:', {
        bindingId: subscription.bindingId,
        sessionId: subscription.sessionId,
        chatId: subscription.chatId,
        turnSignature: turn.signature,
        attachmentCount: attachments.length,
        questionCount: questions.length,
        inputQuestionCount: questions.filter((question) => Boolean(question.input)).length,
      });
    }
    const finalTurnText = turn.status === 'completed'
      ? appendContextUsageCompactText(cleanTurnText, turn.contextUsage)
      : cleanTurnText;
    const renderedStreamTextBase = formatMirrorMessage(
      baseTitle,
      turn.userText,
      finalTurnText,
      markdown,
      true,
      false,
      turn.goalStatus,
      deps.getAssistantLabel?.(subscription.threadId, subscription.sessionId, subscription.bindingId),
    );
    const renderedTextBaseWithGoal = formatMirrorMessage(
      plainTextTitle,
      turn.userText,
      finalTurnText,
      markdown,
      false,
      true,
      turn.goalStatus,
      deps.getAssistantLabel?.(subscription.threadId, subscription.sessionId, subscription.bindingId),
    );
    const renderedText = turn.timedOut
      ? appendMirrorTimeoutNotice(renderedTextBaseWithGoal || buildMirrorTitle(plainTextTitle, markdown), markdown)
      : renderedTextBaseWithGoal;
    const renderedStreamText = turn.timedOut
      ? appendMirrorTimeoutNotice(renderedStreamTextBase || buildMirrorTitle(baseTitle, markdown), markdown)
      : renderedStreamTextBase;
    const text = renderedText ? renderFeedbackText(renderedText, responseParseMode) : '';
    const streamText = renderedStreamText || buildMirrorTitle(baseTitle, markdown);
    const address = {
      channelType: subscription.channelType,
      chatId: subscription.chatId,
    };

    if (getChannelProviderKey(subscription.channelType) === 'feishu' && typeof adapter.onStreamEnd === 'function') {
      try {
        const streamMessageId = typeof adapter.getStructuredStreamingUiMessageId === 'function'
          ? adapter.getStructuredStreamingUiMessageId(subscription.chatId, turn.streamKey) || undefined
          : undefined;
        const streamFinalizeText = streamMessageId && !turn.timedOut ? '' : streamText;
        const finalized = await finalizeStreamFeedback(
          {
            adapter,
            channelType: subscription.channelType,
            chatId: subscription.chatId,
            streamKey: turn.streamKey,
          },
          turn.status,
          streamFinalizeText,
        );
        if (finalized) {
          if (attachments.length > 0 || questions.length > 0) {
            console.log('[bridge-manager] Mirror final artifact delivery after stream finalize:', {
              bindingId: subscription.bindingId,
              sessionId: subscription.sessionId,
              chatId: subscription.chatId,
              turnSignature: turn.signature,
              streamMessageId,
              attachmentCount: attachments.length,
              questionCount: questions.length,
              inputQuestionCount: questions.filter((question) => Boolean(question.input)).length,
            });
            const artifactResult = await deliverFinalResponse(
              {
                adapter,
                address,
                sessionId: subscription.sessionId,
                replyToMessageId: streamMessageId,
                deliverResponse: deps.deliverResponse,
              },
              assembleCodexFinalResponse({ attachments, questions }),
              { skipText: true },
            );
            if (!artifactResult.ok) {
              throw new Error(artifactResult.error || 'mirror artifact delivery failed');
            }
            console.log('[bridge-manager] Mirror final artifact delivery completed:', {
              bindingId: subscription.bindingId,
              sessionId: subscription.sessionId,
              chatId: subscription.chatId,
              turnSignature: turn.signature,
              messageId: artifactResult.messageId,
            });
          }
          subscription.lastDeliveredAt = turn.timestamp || deps.nowIso();
          return;
        }
      } catch (error) {
        console.warn('[bridge-manager] Mirror stream finalize failed:', error instanceof Error ? error.message : error);
      }
    }

    const finalResponse = assembleCodexFinalResponse({
      text,
      attachments,
      questions,
    });

    if (!finalResponse.text && finalResponse.attachments.length === 0 && finalResponse.questions.length === 0) return;

    const response = await deliverFinalResponse({
      adapter,
      address,
      sessionId: subscription.sessionId,
      deliverResponse: deps.deliverResponse,
      deliverText: async (messageText) => deliver(adapter, {
        address,
        text: messageText,
        parseMode: responseParseMode,
      }, {
        sessionId: subscription.sessionId,
        dedupKey: `mirror:${subscription.bindingId}:${turn.signature}`,
      }),
    }, finalResponse);

    if (!response.ok) {
      throw new Error(response.error || 'mirror delivery failed');
    }

    subscription.lastDeliveredAt = turn.timestamp || deps.nowIso();
  }

  async function deliverMirrorTurns(
    subscription: BridgeMirrorSubscription,
    turns: FinalizedBridgeMirrorTurn[],
  ): Promise<{ deliveredCount: number; error?: unknown }> {
    let deliveredCount = 0;
    for (const turn of turns.slice(0, deps.eventBatchLimit)) {
      try {
        await deliverMirrorTurn(subscription, turn);
        deliveredCount += 1;
      } catch (error) {
        return { deliveredCount, error };
      }
    }
    return { deliveredCount };
  }

  return {
    hooks: {
      onStreamText: updateMirrorStreaming,
      onStatusProgress: updateMirrorStatusProgress,
      onTaskProgress: updateMirrorTaskProgress,
      onToolProgress: updateMirrorToolProgress,
    },
    refreshMirrorStreamingStatus,
    stopMirrorStreaming,
    deliverMirrorTurns,
  };
}
