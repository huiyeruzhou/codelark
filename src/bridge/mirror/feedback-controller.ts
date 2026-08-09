import type { BaseChannelAdapter } from '../../channels/contracts.js';
import { deliver, enqueueDelivery } from '../../channels/delivery/deliver.js';
import { supportsOutboundArtifacts } from '../../channels/delivery/artifacts.js';
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
  resolveStructuredStreamingUiMessageId,
} from '../../channels/delivery/stream-feedback.js';
import { buildStreamContextTags, formatStreamTagLabel } from '../../shared/streaming-metadata.js';
import {
  assembleCodexFinalResponse,
  hasFinalResponsePayload,
  stripFinalOnlyBlocksFromStreamingHistory,
} from '../turn/response-assembler.js';
import {
  createStreamingArtifactDeliveryController,
  type StreamingArtifactDeliveryController,
} from '../turn/streaming-artifact-delivery.js';
import {
  deliverFinalResponse,
  type DeliverResponseImpl,
} from '../turn/delivery-pipeline.js';
import type { OutboundManualInput } from '../../domain/index.js';
import {
  formatStreamRuntimeStatus,
  getStreamLastActivityAgeMs,
  getVisibleStreamLastActivityAgeMs,
  shouldShowStreamLastActivityAge,
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
  onMirrorTurnStarted?(subscription: BridgeMirrorSubscription, turnState: BridgeMirrorTurnState): void;
  onMirrorStreamStart?(subscription: BridgeMirrorSubscription, turnState: BridgeMirrorTurnState): void;
  resolveFinalizedTurnStatus?(
    subscription: BridgeMirrorSubscription,
    turn: FinalizedBridgeMirrorTurn,
    context: { batchSize: number },
  ): Promise<FinalizedBridgeMirrorTurn['status']> | FinalizedBridgeMirrorTurn['status'];
  getStructuredStreamStatusConfig?(): MirrorStructuredStreamStatusConfig;
  nowIso(): string;
  eventBatchLimit: number;
  deliverResponse: DeliverResponseImpl;
  deliverManualInput?(sourceBindingId: string, input: OutboundManualInput): Promise<void>;
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

const MIRROR_TERMINAL_ERROR_STATUS_MAX_CHARS = 600;

function compactTerminalErrorStatus(value: string): string {
  const normalized = value.replace(/\s+/gu, ' ').trim();
  const chars = Array.from(normalized);
  if (chars.length <= MIRROR_TERMINAL_ERROR_STATUS_MAX_CHARS) return normalized;
  return `${chars.slice(0, MIRROR_TERMINAL_ERROR_STATUS_MAX_CHARS - 1).join('')}…`;
}

function appendTerminalErrorText(text: string, errorText: string | undefined): string {
  const error = (errorText || '').trim();
  if (!error || text.includes(error)) return text;
  return [text.trim(), `❌ 错误原因：${error}`].filter(Boolean).join('\n\n');
}

export function formatMirrorTerminalErrorStatus(errorText: string | undefined): string {
  const raw = (errorText || '').trim();
  if (!raw) return '❌ 异常';
  try {
    const parsed = JSON.parse(raw) as unknown;
    const root = parsed && typeof parsed === 'object'
      ? ((parsed as { error?: unknown }).error && typeof (parsed as { error?: unknown }).error === 'object'
          ? (parsed as { error: Record<string, unknown> }).error
          : parsed as Record<string, unknown>)
      : null;
    const type = typeof root?.type === 'string' ? root.type.trim() : '';
    const message = typeof root?.message === 'string' ? root.message.trim() : '';
    const parts = [type, message].filter((part, index, values) => part && values.indexOf(part) === index);
    if (parts.length > 0) return compactTerminalErrorStatus(`❌ ${parts.join(' · ')}`);
  } catch {
    // Preserve non-JSON runtime errors below.
  }
  return compactTerminalErrorStatus(`❌ ${raw}`);
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
  const streamOwnerAdapters = new WeakMap<BridgeMirrorTurnState, BaseChannelAdapter>();
  const streamingArtifacts = new Map<string, StreamingArtifactDeliveryController>();

  function getStreamingArtifactController(
    subscription: BridgeMirrorSubscription,
    turnState: BridgeMirrorTurnState,
    adapter: BaseChannelAdapter,
  ): StreamingArtifactDeliveryController | null {
    if (!supportsOutboundArtifacts(adapter.provider)) return null;
    const existing = streamingArtifacts.get(turnState.streamKey);
    if (existing) return existing;
    const address = {
      channelType: subscription.channelType,
      chatId: subscription.chatId,
    };
    const created = createStreamingArtifactDeliveryController({
      deliver: async (attachments) => {
        const replyToMessageId = await resolveStructuredStreamingUiMessageId({
          adapter,
          chatId: subscription.chatId,
          streamKey: turnState.streamKey,
        });
        const queued = enqueueDelivery(adapter, address, () => deliverFinalResponse({
          adapter,
          address,
          sessionId: subscription.sessionId,
          replyToMessageId: replyToMessageId || undefined,
          deliverResponse: deps.deliverResponse,
        }, assembleCodexFinalResponse({ attachments }), { skipText: true }), {
          queueClass: 'interactive',
        });
        return queued.completion;
      },
      onDeliveryError(error, attachments) {
        console.warn('[bridge-manager] Mirror streaming artifact delivery failed:', {
          bindingId: subscription.bindingId,
          sessionId: subscription.sessionId,
          chatId: subscription.chatId,
          streamKey: turnState.streamKey,
          attachmentCount: attachments.length,
          error,
        });
      },
    });
    streamingArtifacts.set(turnState.streamKey, created);
    return created;
  }

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
    if (!adapter) return;
    if (turnState.streamStarted && streamOwnerAdapters.get(turnState) === adapter) return;

    try {
      adapter.onStreamMetadata?.(subscription.chatId, getMirrorStreamMetadata(subscription), turnState.streamKey);
      adapter.onMirrorStreamStart?.(subscription.chatId, turnState.streamKey);
      deps.onMirrorStreamStart?.(subscription, turnState);
      if (!adapter.onMirrorStreamStart) {
        adapter.onStreamText?.(subscription.chatId, '', turnState.streamKey);
      }
      turnState.streamStarted = true;
      streamOwnerAdapters.set(turnState, adapter);
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

    const lastActivityAtMs = Date.parse(turnState.lastActivityAt);
    const streamState = {
      startedAtMs,
      lastActivityAtMs: Number.isFinite(lastActivityAtMs) ? lastActivityAtMs : startedAtMs,
    };
    const statusConfig = deps.getStructuredStreamStatusConfig?.();
    const effectiveLastResponseAgeMs = Object.prototype.hasOwnProperty.call(options, 'lastResponseAgeMs')
      ? options.lastResponseAgeMs
      : statusConfig
        ? getVisibleStreamLastActivityAgeMs(streamState, nowMs, statusConfig)
        : null;
    const statusText = formatStreamRuntimeStatus(
      Math.max(0, nowMs - startedAtMs),
      effectiveLastResponseAgeMs,
      turnState.statusNote,
      turnState.contextUsage,
      turnState.thinkingNote,
      nowMs,
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

    const lastActivityAtMs = Date.parse(pendingTurn.lastActivityAt);
    const streamState = {
      startedAtMs,
      lastActivityAtMs: Number.isFinite(lastActivityAtMs) ? lastActivityAtMs : startedAtMs,
    };
    if (!shouldShowStreamLastActivityAge(streamState, nowMs, config)) return;

    pushMirrorStreamingStatus(subscription, pendingTurn, {
      nowMs,
      lastResponseAgeMs: getStreamLastActivityAgeMs(streamState, nowMs),
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
      stripFinalOnlyBlocksFromStreamingHistory(turnState.historyItems),
    );
    pushMirrorStreamingStatus(subscription, turnState);
    if (/<clk-send>/iu.test(turnState.streamedText)) {
      getStreamingArtifactController(subscription, turnState, adapter)
        ?.observeAnswerText(turnState.streamedText);
    }
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
      stripFinalOnlyBlocksFromStreamingHistory(turnState.historyItems),
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
    const streamedArtifactDelivery = streamingArtifacts.get(pendingTurn.streamKey);
    if (streamedArtifactDelivery) {
      streamingArtifacts.delete(pendingTurn.streamKey);
      void streamedArtifactDelivery.close();
    }
    void finalizeStreamFeedback(
      createStreamTarget(subscription, pendingTurn, adapter),
      status,
      getMirrorStreamingText(subscription, pendingTurn),
    );
  }

  async function deliverMirrorTurn(
    subscription: BridgeMirrorSubscription,
    turn: FinalizedBridgeMirrorTurn,
    context: { batchSize: number },
  ): Promise<void> {
    const streamedArtifactDelivery = streamingArtifacts.get(turn.streamKey);
    await streamedArtifactDelivery?.close();
    const terminalStatus = await deps.resolveFinalizedTurnStatus?.(subscription, turn, context) ?? turn.status;
    turn.status = terminalStatus;
    const adapter = deps.getAdapter(subscription.channelType);
    if (!adapter || !adapter.isRunning()) {
      streamingArtifacts.delete(turn.streamKey);
      return;
    }
    if (terminalStatus === 'error' && typeof adapter.onStreamStatus === 'function') {
      const startedAtMs = Date.parse(turn.startedAt || turn.timestamp);
      const nowMs = Date.now();
      const elapsedMs = Number.isFinite(startedAtMs) ? Math.max(0, nowMs - startedAtMs) : 0;
      adapter.onStreamStatus(
        subscription.chatId,
        formatStreamRuntimeStatus(
          elapsedMs,
          null,
          formatMirrorTerminalErrorStatus(turn.errorText),
          turn.contextUsage,
          null,
          nowMs,
        ),
        turn.streamKey,
      );
    }

    const baseTitle = deps.getThreadTitle(subscription.threadId, subscription.sessionId, subscription.bindingId)?.trim() || '本地会话';
    const plainTextTitle = getMirrorPlainTextTitle(subscription, baseTitle);
    const responseParseMode = getFeedbackParseMode(subscription.channelType);
    const markdown = responseParseMode === 'Markdown';
    const rawFinalResponse = assembleCodexFinalResponse({ text: turn.text });
    const attachments = streamedArtifactDelivery
      ? streamedArtifactDelivery.withoutDelivered(rawFinalResponse.attachments)
      : rawFinalResponse.attachments;
    const questions = rawFinalResponse.questions;
    const platformMessages = rawFinalResponse.platformMessages;
    const manualInputs = rawFinalResponse.manualInputs;
    const cleanTurnText = terminalStatus === 'error'
      ? appendTerminalErrorText(rawFinalResponse.text, turn.errorText)
      : rawFinalResponse.text;
    if (attachments.length > 0 || questions.length > 0 || platformMessages.length > 0 || manualInputs.length > 0) {
      console.log('[bridge-manager] Mirror final artifacts parsed:', {
        bindingId: subscription.bindingId,
        sessionId: subscription.sessionId,
        chatId: subscription.chatId,
        turnSignature: turn.signature,
        attachmentCount: attachments.length,
        questionCount: questions.length,
        platformMessageCount: platformMessages.length,
        manualInputCount: manualInputs.length,
        inputQuestionCount: questions.filter((question) => Boolean(question.input)).length,
      });
    }
    const finalTurnText = terminalStatus === 'completed'
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
        const streamMessageId = await resolveStructuredStreamingUiMessageId({
          adapter,
          chatId: subscription.chatId,
          streamKey: turn.streamKey,
        }) || undefined;
        const streamFinalizeText = streamMessageId && !turn.timedOut ? '' : streamText;
        const finalized = await finalizeStreamFeedback(
          {
            adapter,
            channelType: subscription.channelType,
            chatId: subscription.chatId,
            streamKey: turn.streamKey,
          },
          terminalStatus,
          streamFinalizeText,
        );
        if (finalized) {
          if (attachments.length > 0 || questions.length > 0 || platformMessages.length > 0 || manualInputs.length > 0) {
            console.log('[bridge-manager] Mirror final artifact delivery after stream finalize:', {
              bindingId: subscription.bindingId,
              sessionId: subscription.sessionId,
              chatId: subscription.chatId,
              turnSignature: turn.signature,
              streamMessageId,
              attachmentCount: attachments.length,
              questionCount: questions.length,
              platformMessageCount: platformMessages.length,
              manualInputCount: manualInputs.length,
              inputQuestionCount: questions.filter((question) => Boolean(question.input)).length,
            });
            const artifactResult = await deliverFinalResponse(
              {
                adapter,
                address,
                sessionId: subscription.sessionId,
                replyToMessageId: streamMessageId,
                deliverResponse: deps.deliverResponse,
                deliverManualInput: deps.deliverManualInput
                  ? (input) => deps.deliverManualInput!(subscription.bindingId, input)
                  : undefined,
              },
              assembleCodexFinalResponse({ attachments, questions, platformMessages, manualInputs }),
              { skipText: true },
            );
            if (!artifactResult.ok) {
              console.warn('[bridge-manager] Mirror final artifact delivery failed after stream finalization:', {
                bindingId: subscription.bindingId,
                sessionId: subscription.sessionId,
                chatId: subscription.chatId,
                turnSignature: turn.signature,
                error: artifactResult.error || 'mirror artifact delivery failed',
              });
              subscription.lastDeliveredAt = turn.timestamp || deps.nowIso();
              streamingArtifacts.delete(turn.streamKey);
              return;
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
          streamingArtifacts.delete(turn.streamKey);
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
      platformMessages,
      manualInputs,
    });

    if (!hasFinalResponsePayload(finalResponse)) {
      streamingArtifacts.delete(turn.streamKey);
      return;
    }

    const response = await deliverFinalResponse({
      adapter,
      address,
      sessionId: subscription.sessionId,
      deliverResponse: deps.deliverResponse,
      deliverManualInput: deps.deliverManualInput
        ? (input) => deps.deliverManualInput!(subscription.bindingId, input)
        : undefined,
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
    streamingArtifacts.delete(turn.streamKey);
  }

  async function deliverMirrorTurns(
    subscription: BridgeMirrorSubscription,
    turns: FinalizedBridgeMirrorTurn[],
  ): Promise<{ deliveredCount: number; error?: unknown }> {
    let deliveredCount = 0;
    const batch = turns.slice(0, deps.eventBatchLimit);
    for (const turn of batch) {
      try {
        await deliverMirrorTurn(subscription, turn, { batchSize: batch.length });
        deliveredCount += 1;
      } catch (error) {
        return { deliveredCount, error };
      }
    }
    return { deliveredCount };
  }

  return {
    hooks: {
      onTurnStarted: deps.onMirrorTurnStarted,
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
