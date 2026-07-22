import type {
  InboundMessage,
  OutboundAttachment,
  StreamingPreviewState,
} from '../../../domain/index.js';
import type { BaseChannelAdapter, StructuredStreamingUiSnapshot } from '../../../channels/contracts.js';
import * as engine from './sdk-conversation-engine.js';
import {
  assembleCodexFinalResponse,
  stripFinalOnlyBlocksForStreaming,
} from '../response-assembler.js';
import type { ActiveBridgeTurn } from '../turn-types.js';
import {
  deliverFinalResponse,
} from '../delivery-pipeline.js';
import { createInteractiveStreamUiController } from './stream-ui-controller.js';
import { createExternalTerminalFinalizationController } from './terminal-finalization-controller.js';
import { createInteractiveSdkStreamEventsController } from './sdk-stream-events-controller.js';
import {
  buildExternalTerminalFinalResponsePlan,
  buildProcessFinalResponsePlan,
} from './final-response-plan.js';
import {
  createStreamState,
  formatStreamRuntimeStatus,
} from '../stream-state.js';
import { applyUnifiedTurnHistoryUserText } from '../unified-turn-state.js';
import {
  buildInteractiveStreamCardMetadata,
  buildFallbackInteractiveTurnDisplayInfo,
  buildStaleTaskCompletionNotice,
  type InteractiveStreamConfig,
  type ListInteractiveTurnBindings,
  type ResolveInteractiveTurnEnvironment,
  type ResolveInteractiveTurnRuntimeSettings,
  type ResolveInteractiveTurnDisplayInfo,
} from './turn-environment.js';
import { getBridgeSessionDisplayTitle } from '../../session/display/session-display-query.js';
import {
  getSessionActiveRuntime,
  getSessionKimiSessionId,
  getSessionCodexThreadId,
  getSessionClaudeSessionId,
  getSessionWorkingDirectory,
} from '../../../domain/session-runtime.js';
import {
  resolveEffectiveClaudeProvider,
  resolveEffectiveCodexProvider,
  resolveKimiRuntimeConfig,
  resolveRuntimeMetadataConfig,
} from '../../session/support.js';
import { maskSecrets } from '../../../shared/logger.js';
import { sanitizeInput } from '../../../shared/security/validators.js';

/** Generate a non-zero random 31-bit integer for use as draft_id. */
function generateDraftId(): number {
  return (Math.floor(Math.random() * 0x7FFFFFFE) + 1);
}

const DEFAULT_ATTACHMENT_PROMPT = '简单地描述文件';
const MIRROR_TERMINAL_AFTER_SDK_TIMEOUT_MS = 10_000;

function formatStreamingErrorForCard(
  message: string,
  context: {
    bridgeSessionId: string;
    codexThreadId?: string | null;
    workingDirectory?: string | null;
  },
): string {
  const masked = maskSecrets((message || '').trim());
  const extraLines: string[] = [];
  if (context.bridgeSessionId && !masked.includes('bridge_session_id')) {
    extraLines.push(`bridge_session_id: ${context.bridgeSessionId}`);
  }
  if (context.codexThreadId && !masked.includes('codex_thread_id')) {
    extraLines.push(`codex_thread_id: ${context.codexThreadId}`);
  }
  if (context.workingDirectory && !masked.includes('cwd:')) {
    extraLines.push(`cwd: ${context.workingDirectory}`);
  }
  const combined = [
    masked,
    extraLines.length > 0 ? `\n\n${extraLines.join('\n')}` : '',
  ].join('').trim();
  const { text, truncated } = sanitizeInput(combined || 'Unknown error', 3500);
  const suffix = truncated ? '\n\n（内容过长已截断）' : '';
  return `**Error**\n\n\`\`\`text\n${text.trim()}\n\`\`\`${suffix}`;
}

function logInteractiveTaskError(params: {
  kind: 'sdk' | 'external_terminal';
  message: string;
  bridgeSessionId: string;
  channelType: string;
  chatId: string;
  codexThreadId?: string | null;
  workingDirectory?: string | null;
}): void {
  const masked = maskSecrets((params.message || '').trim());
  const { text, truncated } = sanitizeInput(masked || 'Unknown error', 2000);
  console.error('[interactive-turn/runner] Task error:', {
    kind: params.kind,
    bridge_session_id: params.bridgeSessionId,
    channel_type: params.channelType,
    chat_id: params.chatId,
    codex_thread_id: params.codexThreadId || null,
    cwd: params.workingDirectory || null,
    error: text,
    truncated,
  });
}

function flushPreview(
  adapter: BaseChannelAdapter,
  state: StreamingPreviewState,
  config: InteractiveStreamConfig,
): void {
  if (state.degraded || !adapter.sendPreview) return;

  const text = state.pendingText.length > config.maxChars
    ? state.pendingText.slice(0, config.maxChars) + '...'
    : state.pendingText;

  state.lastSentText = text;
  state.lastSentAt = Date.now();

  adapter.sendPreview(state.chatId, text, state.draftId).then((result) => {
    if (result === 'degrade') state.degraded = true;
  }).catch(() => {});
}

export function formatInteractiveRuntimeStatus(
  elapsedMs: number,
  lastResponseAgeMs?: number | null,
  statusNote?: string | null,
): string {
  return formatStreamRuntimeStatus(elapsedMs, lastResponseAgeMs, statusNote);
}

export interface InteractiveTaskState {
  id: string;
  abortController: AbortController;
  adapter: BaseChannelAdapter;
  address: InboundMessage['address'];
  requestMessageId: string;
  streamKey: string;
  sessionId: string;
  hasStreamingCards: boolean;
  structuredStreamUiActive: boolean;
  lastActivityAt: number;
  lastResponseAt?: number | null;
  lastContentResponseAt?: number | null;
  streamFinalized: boolean;
  uiEnded: boolean;
  mirrorSuppressionId: string | null;
  finalizeFromExternalTerminal?(
    outcome: 'completed' | 'failed' | 'aborted',
    detail?: string,
    finalText?: string,
  ): Promise<boolean>;
  forceStop?(detail?: string): Promise<boolean>;
}

export type ForwardPermissionRequest = (
  adapter: BaseChannelAdapter,
  address: InboundMessage['address'],
  permissionRequestId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  sessionId?: string,
  suggestions?: unknown[],
  replyToMessageId?: string,
) => Promise<void>;

export type BuildStopCallbackData = (sessionId: string) => string;

export interface RunInteractiveMessageDeps {
  registerInteractiveTask(task: InteractiveTaskState): void;
  registerBridgeTurn?(turn: ActiveBridgeTurn): void;
  resetMirrorSessionForInteractiveRun(sessionId: string): void;
  isCurrentInteractiveTask(sessionId: string, taskId: string): boolean;
  touchInteractiveTask(sessionId: string, taskId: string): void;
  recordInteractiveHealthStart(sessionId: string, detail?: string): void;
  recordInteractiveHealthProgress(sessionId: string, type: 'text' | 'permission_wait', detail?: string): void;
  recordInteractiveHealthTool(sessionId: string, toolId: string, toolName: string, status: 'running' | 'complete' | 'error'): void;
  recordInteractiveStreamUiSnapshot?(sessionId: string, snapshot: StructuredStreamingUiSnapshot): void;
  recordInteractiveHealthEnd(sessionId: string, outcome: 'completed' | 'failed' | 'aborted', detail?: string): void;
  beginMirrorSuppression(sessionId: string, promptText: string): string;
  abortMirrorSuppression(sessionId: string, suppressionId?: string | null): void;
  settleMirrorSuppression(sessionId: string, suppressionId?: string | null, durationMs?: number): void;
  releaseInteractiveTask(sessionId: string, taskId: string): void;
  releaseBridgeTurn?(sessionId: string, taskId: string): void;
  deliverResponse(
    adapter: BaseChannelAdapter,
    address: InboundMessage['address'],
    responseText: string,
    sessionId: string,
    replyToMessageId?: string,
    attachments?: OutboundAttachment[],
  ): Promise<unknown>;
  persistCodexThreadUpdate(
    sessionId: string,
    codexThreadId: string | null | undefined,
    hasError: boolean,
    errorMessage?: string | null,
  ): void;
  reconcileMirrorSubscriptions?(): Promise<void>;
  processMessageImpl?: typeof engine.processMessage;
  resolveSdkConversationRuntime?: () => engine.SdkConversationRuntime;
  resolveInteractiveTurnEnvironment: ResolveInteractiveTurnEnvironment;
  resolveInteractiveTurnRuntimeSettings: ResolveInteractiveTurnRuntimeSettings;
  forwardPermissionRequest?: ForwardPermissionRequest;
  buildStopCallbackData?: BuildStopCallbackData;
  resolveInteractiveTurnDisplayInfo?: ResolveInteractiveTurnDisplayInfo;
  listInteractiveTurnBindings?: ListInteractiveTurnBindings;
  nowMs?(): number;
  setIntervalFn?(callback: () => void, intervalMs: number): unknown;
  clearIntervalFn?(handle: unknown): void;
  streamStatusIdleDetectionStartMs?: number;
  streamStatusHeartbeatMs?: number;
  codexTerminalFinalizationTimeoutMs?: number;
}

export async function runInteractiveMessage(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  text: string,
  attachments: InboundMessage['attachments'] | undefined,
  deps: RunInteractiveMessageDeps,
): Promise<void> {
  const turnEnvironment = deps.resolveInteractiveTurnEnvironment(msg.address, msg.messageId);
  const {
    binding,
    initialSession,
    classification: turnClassification,
    codexThreadId,
    streamKey,
  } = turnEnvironment;
  const nowMs = deps.nowMs ?? (() => Date.now());
  const setIntervalFn = deps.setIntervalFn ?? ((callback: () => void, intervalMs: number) => setInterval(callback, intervalMs));
  const clearIntervalFn = deps.clearIntervalFn ?? ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>));
  const processMessageImpl = deps.processMessageImpl ?? engine.processMessage;
  const resolveDisplayInfo = deps.resolveInteractiveTurnDisplayInfo ?? ((targetBinding) => {
    if (targetBinding.id === binding.id && initialSession) {
      const displayRuntime = getSessionActiveRuntime(initialSession) || 'codex';
      const metadata = resolveRuntimeMetadataConfig(initialSession, displayRuntime, binding);
      const threadId = displayRuntime === 'kimi'
        ? getSessionKimiSessionId(initialSession) || ''
        : displayRuntime === 'claude'
          ? getSessionClaudeSessionId(initialSession) || ''
          : getSessionCodexThreadId(initialSession) || '';
      const executionProvider = displayRuntime === 'kimi'
        ? resolveKimiRuntimeConfig(initialSession, binding).provider
        : displayRuntime === 'claude'
          ? resolveEffectiveClaudeProvider(initialSession, binding)
          : resolveEffectiveCodexProvider(initialSession, binding);
      return {
        title: getBridgeSessionDisplayTitle(initialSession),
        bridgeSessionId: initialSession.id,
        threadId,
        runtime: displayRuntime,
        executionProvider,
        creatorKind: 'bridge',
        reasoningEffort: metadata.reasoningEffort,
        model: metadata.model,
      };
    }
    return buildFallbackInteractiveTurnDisplayInfo(targetBinding);
  });
  const runtimeSettings = deps.resolveInteractiveTurnRuntimeSettings(adapter.provider);
  const activeRuntime = getSessionActiveRuntime(initialSession) || 'codex';
  const isClaudeMirrorTurn = activeRuntime === 'claude' && resolveEffectiveClaudeProvider(initialSession, binding) !== 'sdk';
  const codexProvider = resolveEffectiveCodexProvider(initialSession, binding);
  const isCodexMirrorTurn = activeRuntime === 'codex' && (codexProvider === 'pty' || codexProvider === 'tmux');
  const isKimiMirrorTurn = activeRuntime === 'kimi';
  const isRuntimeMirrorTurn = isClaudeMirrorTurn || isCodexMirrorTurn || isKimiMirrorTurn;
  const initialCodexThreadId = getSessionCodexThreadId(initialSession) || codexThreadId || '';
  let observedCodexThreadId = codexThreadId || '';
  const useInteractiveStreamUi = !isRuntimeMirrorTurn;
  const useStatusStreamUi = useInteractiveStreamUi || isRuntimeMirrorTurn;
  const useMessageLifecycle = useInteractiveStreamUi;
  const streamStatusIdleDetectionStartMs = Math.max(
    0,
    deps.streamStatusIdleDetectionStartMs ?? runtimeSettings.statusTiming.idleStartMs,
  );
  const streamStatusHeartbeatMs = Math.max(
    1_000,
    deps.streamStatusHeartbeatMs ?? runtimeSettings.statusTiming.heartbeatMs,
  );

  let messageStartCalled = false;
  const ensureMessageStarted = () => {
    if (!useMessageLifecycle) return;
    if (messageStartCalled) return;
    adapter.onMessageStart?.(msg.address.chatId, streamKey);
    messageStartCalled = true;
  };
  ensureMessageStarted();

  const taskAbort = new AbortController();
  const taskId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const taskStartedAt = nowMs();
  const streamState = createStreamState(taskStartedAt);
  const externalTerminal = createExternalTerminalFinalizationController({
    abortSignal: taskAbort.signal,
    hasCodexThread: () => Boolean(observedCodexThreadId),
    isCurrentTask: () => deps.isCurrentInteractiveTask(binding.bridgeSessionId, taskId),
    isAborted: () => taskAbort.signal.aborted,
    abortTask: () => taskAbort.abort(),
    finalizationTimeoutMs: deps.codexTerminalFinalizationTimeoutMs,
  });
  deps.resetMirrorSessionForInteractiveRun(binding.bridgeSessionId);
  const taskState: InteractiveTaskState = {
    id: taskId,
    abortController: taskAbort,
    adapter,
    address: msg.address,
    requestMessageId: msg.messageId,
    streamKey,
    sessionId: binding.bridgeSessionId,
    hasStreamingCards: false,
    structuredStreamUiActive: false,
    lastActivityAt: taskStartedAt,
    lastResponseAt: null,
    lastContentResponseAt: null,
    streamFinalized: false,
    uiEnded: false,
    mirrorSuppressionId: null,
    finalizeFromExternalTerminal: async (outcome, detail, finalText) => {
      return externalTerminal.finalize(outcome, detail, finalText);
    },
  };
  deps.registerInteractiveTask(taskState);
  deps.registerBridgeTurn?.({
    id: taskId,
    sessionId: binding.bridgeSessionId,
    kind: turnClassification.kind,
    origin: 'im',
    progressSource: isCodexMirrorTurn ? 'codex_jsonl' : isClaudeMirrorTurn ? 'claude_jsonl' : isKimiMirrorTurn ? 'kimi_jsonl' : 'sdk_stream',
    finalSource: isCodexMirrorTurn || turnClassification.kind === 'im_codex_reuse'
      ? 'codex_task_complete'
      : isClaudeMirrorTurn
        ? 'claude_task_complete'
        : isKimiMirrorTurn
          ? 'kimi_task_complete'
          : 'sdk_result',
    runtime: activeRuntime,
    codexThreadId: turnClassification.codexThreadId,
    runtimeThreadId: activeRuntime === 'claude'
      ? getSessionClaudeSessionId(initialSession)
      : activeRuntime === 'kimi'
        ? getSessionKimiSessionId(initialSession)
        : turnClassification.codexThreadId,
    requestMessageId: msg.messageId,
    streamKey,
    startedAt: taskStartedAt,
  });
  deps.recordInteractiveHealthStart(binding.bridgeSessionId);

  let previewState: StreamingPreviewState | null = null;
  const caps = adapter.getPreviewCapabilities?.(msg.address.chatId) ?? null;
  if (caps?.supported) {
    previewState = {
      draftId: generateDraftId(),
      chatId: msg.address.chatId,
      lastSentText: '',
      lastSentAt: 0,
      degraded: false,
      throttleTimer: null,
      pendingText: '',
    };
  }

  const streamCfg = previewState ? runtimeSettings.stream : null;
  const previewOnPartialText = (previewState && streamCfg) ? (fullText: string) => {
    const ps = previewState!;
    const cfg = streamCfg!;
    if (ps.degraded) return;
    const sanitizedText = stripFinalOnlyBlocksForStreaming(fullText);

    ps.pendingText = sanitizedText.length > cfg.maxChars
      ? sanitizedText.slice(0, cfg.maxChars) + '...'
      : sanitizedText;

    const delta = ps.pendingText.length - ps.lastSentText.length;
    const elapsed = Date.now() - ps.lastSentAt;

    if (delta < cfg.minDeltaChars && ps.lastSentAt > 0) {
      if (!ps.throttleTimer) {
        ps.throttleTimer = setTimeout(() => {
          ps.throttleTimer = null;
          if (!ps.degraded) flushPreview(adapter, ps, cfg);
        }, cfg.intervalMs);
      }
      return;
    }

    if (elapsed < cfg.intervalMs && ps.lastSentAt > 0) {
      if (!ps.throttleTimer) {
        ps.throttleTimer = setTimeout(() => {
          ps.throttleTimer = null;
          if (!ps.degraded) flushPreview(adapter, ps, cfg);
        }, cfg.intervalMs - elapsed);
      }
      return;
    }

    if (ps.throttleTimer) {
      clearTimeout(ps.throttleTimer);
      ps.throttleTimer = null;
    }
    flushPreview(adapter, ps, cfg);
  } : undefined;

  const buildCardMetadata = () => {
    const metadata = buildInteractiveStreamCardMetadata(binding, resolveDisplayInfo);
    const sessionTitle = initialSession ? getBridgeSessionDisplayTitle(initialSession).trim() : '';
    return sessionTitle ? { ...metadata, title: sessionTitle } : metadata;
  };
  const cardMetadata = buildCardMetadata();

  let previewEnded = false;
  const endPreviewOnce = () => {
    if (previewEnded) return;
    previewEnded = true;
    if (!previewState) return;
    if (previewState.throttleTimer) {
      clearTimeout(previewState.throttleTimer);
      previewState.throttleTimer = null;
    }
    adapter.endPreview?.(msg.address.chatId, previewState.draftId);
  };

  const streamUi = createInteractiveStreamUiController({
    adapter,
    channelType: adapter.channelType,
    chatId: msg.address.chatId,
    streamKey,
    sessionId: binding.bridgeSessionId,
    streamState,
    taskState,
    statusTiming: {
      idleStartMs: streamStatusIdleDetectionStartMs,
      heartbeatMs: streamStatusHeartbeatMs,
    },
    stopCallbackData: deps.buildStopCallbackData?.(binding.bridgeSessionId),
    nowMs,
    setIntervalFn,
    clearIntervalFn,
    ensureStarted: ensureMessageStarted,
    isCurrentTask: () => deps.isCurrentInteractiveTask(binding.bridgeSessionId, taskId),
    isAborted: () => taskAbort.signal.aborted,
    endPreview: endPreviewOnce,
    normalizeFinalText: (finalText) => assembleCodexFinalResponse({ text: finalText }).text,
    recordSnapshot: deps.recordInteractiveStreamUiSnapshot,
  });
  taskState.hasStreamingCards = useInteractiveStreamUi && streamUi.hasStreamingCards;
  if (useInteractiveStreamUi) {
    streamUi.pushMetadata(cardMetadata);
  }
  const sdkStreamEvents = createInteractiveSdkStreamEventsController({
    sessionId: binding.bridgeSessionId,
    taskId,
    streamState,
    taskState,
    streamUi,
    streamFeedback: streamUi.feedback,
    nowMs,
    isCurrentTask: deps.isCurrentInteractiveTask,
    touchTask: deps.touchInteractiveTask,
    recordHealthProgress: deps.recordInteractiveHealthProgress,
    recordHealthTool: deps.recordInteractiveHealthTool,
    previewOnPartialText,
  });

  const finalizeStreamUiOnce = async (
    status: 'completed' | 'interrupted' | 'error',
    responseText: string,
  ): Promise<boolean> => {
    return streamUi.finalizeOnce(status, responseText);
  };

  const endMessageUiOnce = () => {
    if (taskState.uiEnded) return;
    if (messageStartCalled) {
      adapter.onMessageEnd?.(msg.address.chatId, streamKey);
    }
    taskState.uiEnded = true;
  };

  if (useInteractiveStreamUi) {
    streamUi.startStatusHeartbeat();
  }

  let finalOutcome: 'completed' | 'failed' | 'aborted' = 'failed';
  let finalOutcomeDetail: string | undefined;
  let shouldRecordHealthEnd = true;
  let forceStopStarted = false;
  let runtimeMirrorActivated = false;
  let preparedPromptText: string | null = null;

  const ensureMirrorSuppression = (promptText: string | null | undefined): void => {
    if (isRuntimeMirrorTurn || taskState.mirrorSuppressionId) return;
    const normalizedPrompt = (promptText || '').trim();
    if (!normalizedPrompt) return;
    taskState.mirrorSuppressionId = deps.beginMirrorSuppression(binding.bridgeSessionId, promptText || '');
  };

  taskState.forceStop = async (detail = '任务已收到停止请求。') => {
    if (forceStopStarted) return true;
    forceStopStarted = true;
    finalOutcome = 'aborted';
    finalOutcomeDetail = detail;
    taskAbort.abort();
    streamUi.stopStatusUpdates();
    try {
      await finalizeStreamUiOnce('interrupted', detail);
    } catch {
      // Force stop must release the session even if remote UI cleanup fails.
    }
    endMessageUiOnce();
    return true;
  };

  try {
    const promptText = text || (attachments && attachments.length > 0 ? DEFAULT_ATTACHMENT_PROMPT : '');
    if (useInteractiveStreamUi && promptText.trim()) {
      applyUnifiedTurnHistoryUserText(streamState, promptText);
      streamUi.feedback.pushHistory(streamState.historyItems);
    }

    const processPromise = processMessageImpl(
      binding,
      promptText,
      async (perm) => {
        if (!deps.forwardPermissionRequest) {
          throw new Error('Interactive turn permission forwarding port is not configured');
        }
        await deps.forwardPermissionRequest(
          adapter,
          msg.address,
          perm.permissionRequestId,
          perm.toolName,
          perm.toolInput,
          binding.bridgeSessionId,
          perm.suggestions,
          msg.messageId,
        );
        sdkStreamEvents.onPermissionWait(perm.toolName);
      },
      taskAbort.signal,
      attachments && attachments.length > 0 ? attachments : undefined,
      useInteractiveStreamUi ? sdkStreamEvents.onPartialText : undefined,
      useInteractiveStreamUi ? sdkStreamEvents.onToolEvent : undefined,
      useInteractiveStreamUi ? sdkStreamEvents.onTaskEvent : undefined,
      useStatusStreamUi ? sdkStreamEvents.onStatusNote : undefined,
      (preparedPrompt) => {
        preparedPromptText = preparedPrompt;
        if (isCodexMirrorTurn || turnClassification.kind === 'im_codex_reuse') {
          externalTerminal.expectCodexTerminalFinal();
        }
        if (initialCodexThreadId) {
          ensureMirrorSuppression(preparedPrompt);
        }
      },
      {
        expandToolCalls: true,
        streamPreview: {
          includeToolSnippets: useInteractiveStreamUi && !streamUi.hasStreamingCards,
        },
        onThinkingNote: useStatusStreamUi ? sdkStreamEvents.onThinkingNote : undefined,
        onContextUsage: useInteractiveStreamUi ? sdkStreamEvents.onContextUsage : undefined,
        onRuntimeIdentity: async (identity) => {
          if (identity.runtime === 'claude' || identity.runtime === 'kimi') {
            ensureMirrorSuppression(preparedPromptText);
            runtimeMirrorActivated = true;
            await deps.reconcileMirrorSubscriptions?.();
            return;
          }
          if (identity.runtime === 'codex' && isCodexMirrorTurn) {
            if (identity.runtime === 'codex') observedCodexThreadId = identity.sessionId;
            runtimeMirrorActivated = true;
            await deps.reconcileMirrorSubscriptions?.();
            return;
          }
          if (identity.runtime === 'codex') observedCodexThreadId = identity.sessionId;
          ensureMirrorSuppression(preparedPromptText);
        },
      },
      deps.resolveSdkConversationRuntime?.(),
    );
    const raced = await externalTerminal.raceProcess(processPromise);

    if (raced.kind === 'external') {
      processPromise.catch(() => {});
      finalOutcome = raced.terminal.outcome;
      finalOutcomeDetail = raced.terminal.detail;
      const streamEndStatus = raced.terminal.outcome === 'completed'
        ? 'completed'
        : raced.terminal.outcome === 'aborted'
          ? 'interrupted'
          : 'error';
      if (streamEndStatus === 'error' && !taskAbort.signal.aborted) {
        logInteractiveTaskError({
          kind: 'external_terminal',
          message: raced.terminal.detail || 'External terminal failed',
          bridgeSessionId: binding.bridgeSessionId,
          channelType: msg.address.channelType,
          chatId: msg.address.chatId,
          codexThreadId: getSessionCodexThreadId(initialSession) || null,
          workingDirectory: getSessionWorkingDirectory(initialSession) || null,
        });
      }
      const staleTaskNotice = buildStaleTaskCompletionNotice(msg.address, binding, {
        listChannelChats: deps.listInteractiveTurnBindings,
        resolveDisplayInfo,
      });
      const finalResponsePlan = buildExternalTerminalFinalResponsePlan({
        terminal: raced.terminal,
        staleTaskNotice,
        aborted: taskAbort.signal.aborted,
        formatErrorCard: (message) => formatStreamingErrorForCard(message, {
          bridgeSessionId: binding.bridgeSessionId,
          codexThreadId: getSessionCodexThreadId(initialSession) || null,
          workingDirectory: getSessionWorkingDirectory(initialSession) || null,
        }),
      });
      const mirrorWillDeliverFinal = isRuntimeMirrorTurn && runtimeMirrorActivated;
      const skipTextDeliveryForExistingCard = !isRuntimeMirrorTurn && streamUi.shouldSkipTextDelivery();
      if (!mirrorWillDeliverFinal) {
        sdkStreamEvents.pushFinalCardText(finalResponsePlan.cardText);
      }
      const cardFinalized = await finalizeStreamUiOnce(
        finalResponsePlan.streamEndStatus,
        mirrorWillDeliverFinal ? '' : finalResponsePlan.cardText,
      );
      if (!mirrorWillDeliverFinal && finalResponsePlan.deliveryResponse) {
        await deliverFinalResponse({
          adapter,
          address: msg.address,
          sessionId: binding.bridgeSessionId,
          replyToMessageId: msg.messageId,
          deliverResponse: deps.deliverResponse,
        }, finalResponsePlan.deliveryResponse, {
          skipText: skipTextDeliveryForExistingCard || (
            finalResponsePlan.skipTextWhenCardFinalized && cardFinalized
          ),
        });
      }
      return;
    }

    const result = raced.result;
    if (result.codexThreadId) {
      ensureMirrorSuppression(preparedPromptText);
    }
    externalTerminal.markProcessSettled();
    if (useInteractiveStreamUi && streamUi.hasStreamingCards && result.codexThreadId) {
      streamUi.pushMetadata(buildCardMetadata());
    }

    if (!deps.isCurrentInteractiveTask(binding.bridgeSessionId, taskId)) {
      shouldRecordHealthEnd = false;
      return;
    }

    const terminalAfterProcess = isRuntimeMirrorTurn
      ? null
      : await externalTerminal.waitAfterProcess();
    if (!taskAbort.signal.aborted && result.hasError) {
      logInteractiveTaskError({
        kind: 'sdk',
        message: result.errorMessage,
        bridgeSessionId: binding.bridgeSessionId,
        channelType: msg.address.channelType,
        chatId: msg.address.chatId,
        codexThreadId: result.codexThreadId || getSessionCodexThreadId(initialSession) || null,
        workingDirectory: getSessionWorkingDirectory(initialSession) || null,
      });
    }
    let cardFinalized = false;
    const staleTaskNotice = buildStaleTaskCompletionNotice(msg.address, binding, {
      listChannelChats: deps.listInteractiveTurnBindings,
      resolveDisplayInfo,
    });
    const finalResponsePlan = buildProcessFinalResponsePlan({
      result,
      terminal: terminalAfterProcess,
      staleTaskNotice,
      aborted: taskAbort.signal.aborted,
      formatErrorCard: (message) => formatStreamingErrorForCard(message, {
        bridgeSessionId: binding.bridgeSessionId,
        codexThreadId: result.codexThreadId || getSessionCodexThreadId(initialSession) || null,
        workingDirectory: getSessionWorkingDirectory(initialSession) || null,
      }),
    });
    const skipTextDeliveryForExistingCard = !isRuntimeMirrorTurn && streamUi.shouldSkipTextDelivery();
    if (useInteractiveStreamUi && streamUi.hasStreamingCards) {
      sdkStreamEvents.pushFinalCardText(finalResponsePlan.cardText);
      cardFinalized = await finalizeStreamUiOnce(
        finalResponsePlan.streamEndStatus,
        finalResponsePlan.cardText,
      );
    }

    if ((!isRuntimeMirrorTurn || !runtimeMirrorActivated) && finalResponsePlan.deliveryResponse) {
      await deliverFinalResponse({
        adapter,
        address: msg.address,
        sessionId: binding.bridgeSessionId,
        replyToMessageId: msg.messageId,
        deliverResponse: deps.deliverResponse,
      }, finalResponsePlan.deliveryResponse, {
        skipText: skipTextDeliveryForExistingCard || (
          finalResponsePlan.skipTextWhenCardFinalized && cardFinalized
        ),
      });
    }

    try {
      deps.persistCodexThreadUpdate(
        binding.bridgeSessionId,
        result.codexThreadId,
        result.hasError,
        result.errorMessage,
      );
    } catch {
      // best effort
    }
    finalOutcome = terminalAfterProcess?.outcome || (result.hasError ? 'failed' : 'completed');
    finalOutcomeDetail = terminalAfterProcess?.detail || (result.hasError
      ? (result.errorMessage?.trim() || undefined)
      : undefined);
  } finally {
    if (useInteractiveStreamUi || (isRuntimeMirrorTurn && streamUi.shouldSkipTextDelivery())) {
      await finalizeStreamUiOnce(
        taskAbort.signal.aborted
          ? 'interrupted'
          : finalOutcome === 'completed'
            ? 'completed'
            : 'error',
        '',
      );
    }

    if (taskState.mirrorSuppressionId) {
      if (finalOutcome === 'aborted') {
        deps.abortMirrorSuppression(binding.bridgeSessionId, taskState.mirrorSuppressionId);
      } else {
        deps.settleMirrorSuppression(
          binding.bridgeSessionId,
          taskState.mirrorSuppressionId,
          MIRROR_TERMINAL_AFTER_SDK_TIMEOUT_MS,
        );
      }
      taskState.mirrorSuppressionId = null;
    }
    if (shouldRecordHealthEnd) {
      if (taskAbort.signal.aborted && !externalTerminal.current) {
        finalOutcome = 'aborted';
        finalOutcomeDetail = finalOutcomeDetail || '任务已收到停止请求。';
      }
      deps.recordInteractiveHealthEnd(binding.bridgeSessionId, finalOutcome, finalOutcomeDetail);
    }
    deps.releaseInteractiveTask(binding.bridgeSessionId, taskId);
    deps.releaseBridgeTurn?.(binding.bridgeSessionId, taskId);
    if (isRuntimeMirrorTurn && runtimeMirrorActivated) {
      await deps.reconcileMirrorSubscriptions?.();
    }
    endMessageUiOnce();
    externalTerminal.settleCompletion(taskState.streamFinalized || !streamUi.hasStreamingCards);
  }
}
