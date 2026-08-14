/**
 * Bridge Manager — singleton orchestrator for the multi-IM bridge system.
 *
 * Manages adapter lifecycles, routes inbound messages through the
 * conversation engine, and coordinates permission handling.
 *
 * Uses globalThis to survive Next.js HMR in development.
 */

import type {
  ChannelAddress,
  BridgeStatus,
  ChannelChat,
  InboundMessage,
  OutboundRichCard,
  RuntimeNoticeInfo,
} from '../../domain/index.js';
import type { BaseChannelAdapter } from '../../channels/contracts.js';
import type { BridgeSession, BridgeStore, PermissionLinkRecord } from '../../domain/index.js';
import type { FeishuChannelConfig } from '../../channels/types.js';
import { feishuSiteToApiBaseUrl } from '../../channels/feishu/site.js';
import { statSync } from 'node:fs';
import crypto from 'node:crypto';
import { inspect } from 'node:util';
// Side-effect import: triggers self-registration of all adapter factories
import '../../channels/feishu/adapter.js';
import * as router from './channel-router.js';
import * as broker from '../permission/broker.js';
import { getBridgeContext } from './context.js';
import type { BridgeMirrorRecord } from '../../runtime/contracts.js';
import { archiveCodexSession } from '../../runtime/codex/session-index.js';
import { injectPromptIntoActivePty } from '../../runtime/codex/pty-provider.js';
import {
  injectPromptIntoClaudePtySession,
  waitForClaudeSessionJsonlUpdatedAfter,
} from '../../runtime/claude/pty-provider.js';
import {
  archiveClaudeSessionJsonl,
  createClaudeMirrorJsonlSource,
  getClaudeSessionJsonlById,
} from '../../runtime/claude/session-jsonl.js';
import {
  archiveKimiSessionFile,
  createKimiMirrorJsonlSource,
  findKimiSessionFileById,
} from '../../runtime/kimi/session-index.js';
import {
  archiveCursorSessionFile,
  createCursorMirrorJsonlSource,
  findCursorSessionFileById,
} from '../../runtime/cursor/session-index.js';
import {
  archiveZcodeSession,
  createZcodeMirrorSqliteSource,
  findZcodeSessionById,
} from '../../runtime/zcode/session-index.js';
import {
  kimiTmuxSessionName,
} from '../../runtime/kimi/tmux-provider.js';
import { cursorTmuxSessionName } from '../../runtime/cursor/tmux-provider.js';
import { zcodeTmuxSessionName } from '../../runtime/zcode/tmux-provider.js';
import {
  sanitizeInput,
} from '../../shared/security/validators.js';
import { buildFencedCodeBlock } from '../../shared/markdown/fence.js';
import {
  normalizeReasoningEffort,
  normalizeSandboxMode,
} from '../../runtime/options.js';
import { buildDoctorPromptFromLogs } from '../diagnostics/doctor.js';
import {
  resolveCommandAlias,
  isBridgeCommandText,
  toModelPromptText,
  handleBridgeCommand,
  buildGlobalStatusResponse,
} from '../command/index.js';
import {
  toUserVisibleCommandError,
} from '../command/errors.js';
import {
  buildCommandCallbackData,
  parseAgentQuestionCallbackData,
  parseCommandCallbackData,
  EVERY_TASK_ACTION_CALLBACK_PREFIX,
  EVERY_TASK_SELECT_CALLBACK_PREFIX,
  THEN_TASK_ACTION_CALLBACK_PREFIX,
  THEN_TASK_SELECT_CALLBACK_PREFIX,
  type EveryTaskCardAction,
  type ThenTaskCardAction,
  type ThreadCardAction,
  THREAD_SELECT_ACTION_CALLBACK_PREFIX,
  THREAD_SELECT_CALLBACK_PREFIX,
} from '../command/callbacks.js';
import {
  appendMirrorTimeoutNotice,
  buildInteractiveStreamKey,
  buildMirrorStreamKey,
  buildMirrorTitle,
  formatMirrorMessage,
  formatMirrorUserText,
} from '../mirror/formatters.js';
import {
  consumeBufferedMirrorTurns as consumeBufferedMirrorTurnsBase,
  consumeMirrorRecords as consumeMirrorRecordsBase,
  enqueuePendingMirrorDeliveries,
  finalizeMirrorTurn as finalizeMirrorTurnBase,
  flushTimedOutMirrorTurn as flushTimedOutMirrorTurnBase,
  hasPendingMirrorWork as hasPendingMirrorWorkBase,
  removePendingMirrorDeliveries,
  type BridgeMirrorTurnState,
  type FinalizedBridgeMirrorTurn,
} from '../mirror/turns.js';
import {
  abortMirrorSuppression as abortMirrorSuppressionBase,
  beginMirrorSuppression as beginMirrorSuppressionBase,
  filterSuppressedMirrorRecords as filterSuppressedMirrorRecordsBase,
  isMirrorSuppressed as isMirrorSuppressedBase,
  settleMirrorSuppression as settleMirrorSuppressionBase,
  type MirrorSuppressionConfig,
  type MirrorSuppressionState,
  type MirrorSuppressionStore,
} from '../mirror/suppression.js';
import { type BridgeMirrorSubscription } from '../mirror/subscription-state.js';
import { SessionRegistryService } from '../session/registry.js';
import {
  buildAdapterConfigFingerprint,
} from '../../channels/adapter-runtime/sync-plan.js';
import {
  createAdapterRuntime,
  type AdapterImmediateLane,
  type BridgeAdapterRuntimeState,
} from '../../channels/adapter-runtime/runtime.js';
import {
  formatBindingChatLabel,
  listConfiguredChannelInstances,
} from '../../channels/adapter-runtime/channel-runtime.js';
import {
  getBridgeSessionCodexThreadId,
} from '../session/display/session-display-query.js';
import {
  formatDisplayedModel,
  getCodexSessionByThreadIdSafe,
  getSessionCodexProviderOverride,
  resolveDisplayedModel,
  resolveEffectiveClaudeProvider,
  resolveEffectiveCodexProvider,
  resolveEffectiveRuntimeProvider,
  resolveNewWorkingDirectory,
  resolveNewSessionWorkingDirectory,
  resolveRuntimeMetadataConfig,
  sessionCodexRuntimeOverridePatch,
} from '../session/support.js';
import { createConfigService } from '../../configuration/service.js';
import {
  getGlobalDefaultChannelConfig,
  getGlobalRuntimeAgent,
} from '../session/global-config.js';
import {
  getSessionRuntimeTmuxSessionName,
  getSessionCodexThreadId,
  getSessionClaudeCwd,
  getSessionClaudeSessionId,
  getSessionKimiCwd,
  getSessionKimiSessionId,
  getSessionCursorCwd,
  getSessionCursorSessionId,
  getSessionZcodeCwd,
  getSessionZcodeSessionId,
  getSessionActiveRuntime,
  getSessionSystemPrompt,
  getSessionWorkingDirectory,
  clearSessionTmuxBindingUpdate,
  setSessionClaudeIdentityUpdate,
  setSessionCodexTitleUpdate,
  setSessionKimiIdentityUpdate,
  setSessionCursorIdentityUpdate,
  setSessionZcodeIdentityUpdate,
} from '../../domain/session-runtime.js';
import {
  buildCodexTuiSelectionChoiceActions,
  createCodexTuiSelectionPromptMonitor,
  getCodexTuiSelectionPromptUiDefaultChoice,
  markCodexTuiSelectionPromptActionSent,
  observeStableCodexTuiSelectionPrompt,
  parseCodexTuiSelectionPrompt,
  type CodexTuiSelectionPromptMonitor,
} from '../../runtime/codex/tmux-provider.js';
import {
  findNewCodexTuiDiagnostics,
  parseCodexTuiModelMismatchWarning,
  parseCodexTuiReconnectSignal,
  type CodexTuiDiagnostic,
} from '../../runtime/codex/tui-runtime-signals.js';
import {
  cleanupRuntimeTmuxSession,
  tmuxCore,
  waitForCodexResumeTmuxReady,
  waitForRuntimeTmuxReady,
  type TmuxSendAction,
} from '../tmux/runtime.js';
import type { TmuxAutoForwardRecoveryPayload } from '../command/codex-tui-selection.js';
import {
  coordinateRuntimeTmuxSelection,
  sendRuntimeTmuxInput,
  transitionRuntimeTmuxInputState,
} from '../tmux/input-state-machine.js';
import { buildRuntimeStreamTags } from '../../shared/streaming-metadata.js';
import { ThreadDisplayService } from '../session/thread-display-resolver.js';
import {
  runInteractiveMessage,
} from '../turn/interactive/runner.js';
import {
  resolveInteractiveTurnEnvironment as resolveInteractiveTurnEnvironmentBase,
  resolveInteractiveTurnRuntimeSettings,
} from '../turn/interactive/turn-environment.js';
import {
  getEveryTask,
  listEveryTasks,
  pauseEveryTasksForSession,
  updateEveryTask,
  type EveryTask,
} from '../automation/every-tasks.js';
import {
  cancelConditionMonitorTask,
  createConditionMonitorTask,
  getConditionMonitorTask,
  listConditionMonitorTasks,
  updateConditionMonitorTask,
  type ConditionMonitorTask,
} from '../automation/condition-monitors.js';
import { runConditionMonitorTick } from '../automation/condition-monitor-runner.js';
import {
  claimNextPendingThenTaskForSession,
  getThenTask,
  listThenTasks,
  pauseThenTasksForSession,
  updateThenTask,
  type ThenTask,
} from '../automation/then-tasks.js';
import {
  createInteractiveRuntime,
  type BridgeInteractiveRuntimeState,
} from './interactive-runtime.js';
import { createMirrorRuntime, type BridgeMirrorRuntimeState } from '../mirror/runtime.js';
import {
  createMirrorFeedbackController,
  type MirrorStructuredStreamStatusConfig,
} from '../mirror/feedback-controller.js';
import { probeCodexThreadProcess } from '../health/process.js';
import { createSessionHealthRuntime } from '../health/runtime.js';
import { deliverBridgeNotice, deliverResponse, enqueueBridgeNotice } from '../../channels/delivery/feedback.js';
import { deliver, _testOnlyWaitForDeliveryQueuesForTests } from '../../channels/delivery/deliver.js';
import { routeCodexRecords, routeRuntimeRecords } from '../turn/local-codex-terminal-router.js';
import { createTurnCoordinator } from '../turn/turn-coordinator.js';
import type { BridgeTurnTerminalRecord } from '../turn/turn-types.js';
import { consumeSseEvents } from '../../runtime/sse-stream-decoder.js';
import { consumePendingClearConfirmation } from '../command/clear-confirmations.js';
import { consumePendingTakeoverConfirmation } from '../command/takeover-confirmations.js';
import {
  consumePendingAttachmentConfirmation,
  isPendingAttachmentConfirmationReply,
} from '../command/attachment-confirmations.js';
import { consumeStartupNoticeTarget } from './startup-notice-target.js';
import { applyUnifiedTurnStatusNote } from '../turn/unified-turn-state.js';
import { resolveInstalledCodelarkVersion } from '../update/installed-version.js';
import { createDailyVersionChecker } from '../update/version-check.js';
import {
  buildVersionUpdateCompletedCard,
  createDailyVersionUpdateRuntime,
  type DailyVersionUpdateRuntime,
} from '../update/runtime.js';
import type { StartupNoticeOperation } from '../startup-notice-target.js';
import { CODELARK_HOME } from '../../configuration/paths.js';
import type {
  AgentInputRequest,
  AgentSendInstruction,
  CreateConditionMonitorRequest,
  ManualInputRequest,
  PlatformMessageRequest,
} from '../control/contracts.js';
import { deliverManualInput } from '../control/service-discovery.js';
import { claimAgentInputReceipt } from '../control/agent-input-receipts.js';
import {
  formatAgentSourceXml,
  listDiscoveredBridgeSessions,
  sourceMetadataForBinding,
} from '../control/session-catalog.js';

const GLOBAL_KEY = '__bridge_manager__';
const DANGLING_MIRROR_THREAD_RETRY_LIMIT = 3;
const MIRROR_FAILURE_SUSPEND_MS = 60_000;
const MIRROR_FAILURE_SUSPEND_THRESHOLD = 3;
const MIRROR_POLL_INTERVAL_MS = 2_500;
const MIRROR_WATCH_DEBOUNCE_MS = 350;
const MIRROR_EVENT_BATCH_LIMIT = 8;
const MIRROR_RECONCILE_CONCURRENCY = 8;
const MIRROR_SLOW_RECONCILE_SUBSCRIPTION_MS = 2_000;
const MIRROR_ACTIVE_BINDING_WINDOW_MS = 30 * 60_000;
const MIRROR_COLD_RECONCILE_INTERVAL_MS = 60_000;
const MIRROR_SUPPRESSION_WINDOW_MS = 4_000;
const MIRROR_PROMPT_MATCH_GRACE_MS = 120_000;
// When IM drives a Codex thread, Codex task_complete is the canonical
// final source. If the SDK stream finishes first, wait for the terminal JSONL
// record before falling back to the SDK response.
const DESKTOP_TERMINAL_FINALIZATION_TIMEOUT_MS = 30_000;
const MIRROR_STREAM_STATUS_IDLE_START_MS = 0;
const MIRROR_STREAM_STATUS_HEARTBEAT_MS = 5_000;
const MIRROR_TMUX_SELECTION_PROBE_INTERVAL_MS = 5_000;
const MIRROR_TMUX_SELECTION_PROBE_FOLLOWUP_WINDOW_MS = 5_000;
const MIRROR_TMUX_SELECTION_PROBE_FOLLOWUP_INTERVAL_MS = 300;
const CODEX_TUI_IDLE_CHECKPOINT_HOT_MISSING_RETRY_MS = 5_000;
const CODEX_TUI_IDLE_CHECKPOINT_COLD_MISSING_RETRY_MS = 60_000;
const TMUX_AUTO_FORWARD_SELECTION_PROBE_TIMEOUT_MS = 5_000;
const TMUX_AUTO_FORWARD_SELECTION_PROBE_INTERVAL_MS = 300;
const TMUX_PROVIDER_EXIT_PROBE_DELAY_MS = 1_500;
const TMUX_SELECTION_UPDATE_EXIT_PROBE_DELAY_MS = 2_000;
const TMUX_PROVIDER_EXIT_NOTICE_COOLDOWN_MS = 60_000;
const TMUX_SCREEN_STOP_CALLBACK_PREFIX = 'tmux-screen:stop:';
const PTY_SCREEN_STOP_CALLBACK_PREFIX = 'pty-screen:stop:';
const INBOUND_GET_REACTION = 'Get';
// Timeout after the last Codex event before we flush a buffered mirror turn
// without seeing task_complete. This is an internal mirror buffer guard, not an
// IM idle reminder. Active streaming turns never use this fallback timeout.
const MIRROR_TURN_BUFFER_TIMEOUT_MS = 10 * 60_000;
const STARTUP_NOTICE_TITLE = 'Bridge 已启动';
const STARTUP_NOTICE_CARD_TEMPLATE = 'turquoise';
const BACKGROUND_INPUT_LIMIT = 64_000;
const SESSION_CONFIG_BARRIER_COMMANDS = new Set([
  '/clear',
  '/current-config',
  '/provider',
  '/runtime',
  '/cd',
  '/cwd',
  '/model',
  '/mode',
  '/sandbox',
  '/network',
  '/reasoning',
  '/tmux-set',
]);
const SESSION_SERIAL_COMMANDS = new Set([
  '/tmux',
  '/tmux-key',
  '/tmux-switch',
  '/tmux-attach',
  '/tmux-new',
]);

const pendingTmuxProviderExitProbeTimers = new Set<ReturnType<typeof setTimeout>>();
const tmuxProviderExitNoticeLastSentAt = new Map<string, number>();
const tmuxSelectionUpdateNoticeLastSentAt = new Map<string, number>();
const tmuxSelectionPromptMonitors = new Map<string, CodexTuiSelectionPromptMonitor>();
const tmuxSelectionPromptLastProbeAt = new Map<string, number>();
const tmuxSelectionPromptFollowupUntil = new Map<string, number>();
const pendingTmuxSelectionPromptProbePromises = new Set<Promise<boolean>>();
interface CodexTuiScreenCheckpoint {
  screen: string;
  capturedAtMs: number;
  claimedTurnKey?: string;
}

const codexTuiIdleScreenCheckpoints = new Map<string, CodexTuiScreenCheckpoint>();
const codexTuiTurnScreenBaselines = new Map<string, CodexTuiScreenCheckpoint>();
const codexTuiIdleScreenMissingCheckedAt = new Map<string, number>();

interface CodexTuiReconnectMonitor {
  streamKey: string;
  signalKey: string;
  appliedNote: string;
  previousStatusNote: string | null;
}

const codexTuiReconnectMonitors = new Map<string, CodexTuiReconnectMonitor>();
const codexTuiModelMismatchNoticesInFlight = new Map<string, string>();

interface CodexTuiPendingTurnDiagnosticMonitor {
  screen: string;
  diagnostics: CodexTuiDiagnostic[];
}

const codexTuiPendingTurnDiagnosticMonitors = new Map<string, CodexTuiPendingTurnDiagnosticMonitor>();

interface TmuxSelectionPromptTarget {
  channelType: string;
  chatId: string;
  sessionId: string;
  threadId?: string;
}

function tmuxProviderExitProbeDelayMs(): number {
  const raw = process.env.CODELARK_TMUX_PROVIDER_EXIT_PROBE_DELAY_MS;
  if (raw === undefined || raw.trim() === '') return TMUX_PROVIDER_EXIT_PROBE_DELAY_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : TMUX_PROVIDER_EXIT_PROBE_DELAY_MS;
}

function tmuxSelectionUpdateExitProbeDelayMs(): number {
  const raw = process.env.CODELARK_TMUX_SELECTION_UPDATE_EXIT_PROBE_DELAY_MS;
  if (raw === undefined || raw.trim() === '') return TMUX_SELECTION_UPDATE_EXIT_PROBE_DELAY_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : TMUX_SELECTION_UPDATE_EXIT_PROBE_DELAY_MS;
}

function addInboundGetReaction(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  reason: 'command_received' | 'tmux_input_actions_completed',
): void {
  const raw = msg.raw as { manualIngress?: unknown } | undefined;
  const syntheticManualIngress = raw?.manualIngress === true || msg.messageId?.startsWith('manual:');
  if (syntheticManualIngress || !msg.messageId || typeof adapter.addMessageReaction !== 'function') return;
  void adapter.addMessageReaction(msg.messageId, INBOUND_GET_REACTION).catch((error) => {
    console.warn('[bridge-manager] Failed to add inbound Get reaction:', {
      reason,
      error: describeUnknownError(error),
    });
  });
}

function scheduleTmuxProviderExitProbe(params: {
  adapter: BaseChannelAdapter;
  msg: InboundMessage;
  sessionId: string;
  startedAtMs: number;
}): void {
  const timer = setTimeout(() => {
    pendingTmuxProviderExitProbeTimers.delete(timer);
    void probeTmuxProviderExitAfterAutoForward(params).catch((error) => {
      console.warn('[bridge-manager] Tmux provider exit probe failed:', describeUnknownError(error));
    });
  }, tmuxProviderExitProbeDelayMs());
  timer.unref?.();
  pendingTmuxProviderExitProbeTimers.add(timer);
}

async function probeTmuxProviderExitAfterAutoForward(params: {
  adapter: BaseChannelAdapter;
  msg: InboundMessage;
  sessionId: string;
  startedAtMs: number;
}): Promise<void> {
  if (!params.adapter.isRunning()) return;
  const { store } = getBridgeContext();
  const binding = store.getChannelChat(params.msg.address.channelType, params.msg.address.chatId);
  if (!binding || binding.bridgeSessionId !== params.sessionId) return;
  const session = store.getSession(params.sessionId);
  if (!session) return;
  const runtimeProvider = resolveEffectiveRuntimeProvider(session, binding);
  if (runtimeProvider.provider !== 'tmux') return;
  const tmuxSessionName = getSessionRuntimeTmuxSessionName(session);
  if (!tmuxSessionName) return;
  const exists = await tmuxCore.hasSession(tmuxSessionName);
  if (exists.exists) return;

  const latestSession = store.getSession(params.sessionId);
  if (getSessionRuntimeTmuxSessionName(latestSession) !== tmuxSessionName) return;
  const confirmedMissing = await tmuxCore.hasSession(tmuxSessionName);
  if (confirmedMissing.exists) return;
  store.updateSession(params.sessionId, clearSessionTmuxBindingUpdate());

  const noticeKey = `${params.msg.address.channelType}:${params.msg.address.chatId}:${params.sessionId}:${tmuxSessionName}`;
  const nowMs = Date.now();
  const runtimeLabel = runtimeProvider.runtime === 'claude'
    ? 'Claude'
    : runtimeProvider.runtime === 'kimi'
      ? 'Kimi'
      : runtimeProvider.runtime === 'cursor'
        ? 'Cursor'
        : runtimeProvider.runtime === 'zcode'
          ? 'ZCode'
        : 'Codex';
  const elapsedMs = Math.max(0, nowMs - params.startedAtMs);
  SESSION_HEALTH_RUNTIME.recordInteractiveEnd(
    params.sessionId,
    'failed',
    `${runtimeLabel} tmux Provider session ${tmuxSessionName} disappeared ${elapsedMs}ms after auto-forward input; mirror will not produce this turn.`,
  );
  console.warn('[bridge-manager] Tmux provider session disappeared after auto-forward input:', {
    event: 'tmux.provider.post_forward_session_missing',
    runtime: runtimeProvider.runtime,
    session_id: params.sessionId,
    tmux_session: tmuxSessionName,
    elapsed_ms: elapsedMs,
    command: exists.command,
  });
  const lastSentAt = tmuxProviderExitNoticeLastSentAt.get(noticeKey) || 0;
  if (nowMs - lastSentAt < TMUX_PROVIDER_EXIT_NOTICE_COOLDOWN_MS) return;
  tmuxProviderExitNoticeLastSentAt.set(noticeKey, nowMs);
  await deliverBridgeNotice(
    params.adapter,
    params.msg.address,
    `${runtimeLabel} tmux Provider 会话已退出：\`${tmuxSessionName}\`。请发送 \`/p tmux\` 重新启动 TUI。`,
    {
      sessionId: params.sessionId,
      replyToMessageId: params.msg.messageId,
      audit: true,
    },
  );
}

async function notifyTmuxSelectionUpdateExit(params: {
  adapter: BaseChannelAdapter;
  target: TmuxSelectionPromptTarget;
  tmuxSessionName: string;
  choice: string;
  existsCommand: string;
}): Promise<void> {
  const noticeKey = `${params.target.channelType}:${params.target.chatId}:${params.target.sessionId}:${params.tmuxSessionName}:selection-update`;
  const nowMs = Date.now();
  const lastSentAt = tmuxSelectionUpdateNoticeLastSentAt.get(noticeKey) || 0;
  if (nowMs - lastSentAt < TMUX_PROVIDER_EXIT_NOTICE_COOLDOWN_MS) return;
  tmuxSelectionUpdateNoticeLastSentAt.set(noticeKey, nowMs);
  SESSION_HEALTH_RUNTIME.recordInteractiveEnd(
    params.target.sessionId,
    'failed',
    `Codex tmux Provider session ${params.tmuxSessionName} disappeared after TUI selection ${params.choice}.`,
  );
  await deliverBridgeNotice(
    params.adapter,
    { channelType: params.target.channelType, chatId: params.target.chatId },
    `Codex tmux Provider 会话已退出：\`${params.tmuxSessionName}\`。请发送 \`/p tmux\` 重新启动 TUI。`,
    {
      sessionId: params.target.sessionId,
      audit: true,
    },
  );
}

function scheduleTmuxSelectionUpdateExitProbe(params: {
  adapter: BaseChannelAdapter;
  target: TmuxSelectionPromptTarget;
  tmuxSessionName: string;
  choice: string;
}): void {
  const timer = setTimeout(() => {
    void (async () => {
      if (!params.adapter.isRunning()) return;
      const session = getBridgeContext().store.getSession(params.target.sessionId);
      if (!session || getSessionRuntimeTmuxSessionName(session) !== params.tmuxSessionName) return;
      const exists = await tmuxCore.hasSession(params.tmuxSessionName);
      if (exists.exists) return;
      console.warn('[bridge-manager] Codex tmux session disappeared after TUI selection:', {
        event: 'tmux.selection.update_session_missing',
        session_id: params.target.sessionId,
        thread_id: params.target.threadId,
        tmux_session: params.tmuxSessionName,
        choice: params.choice,
        command: exists.command,
      });
      await notifyTmuxSelectionUpdateExit({
        adapter: params.adapter,
        target: params.target,
        tmuxSessionName: params.tmuxSessionName,
        choice: params.choice,
        existsCommand: exists.command,
      });
    })().catch((error) => {
      console.warn('[bridge-manager] Tmux selection update exit probe failed:', describeUnknownError(error));
    });
  }, tmuxSelectionUpdateExitProbeDelayMs());
  timer.unref?.();
}

function shouldProbeMirrorTmuxSelectionPrompt(
  subscription: BridgeMirrorSubscription,
  nowMs: number,
): boolean {
  const followupUntil = tmuxSelectionPromptFollowupUntil.get(subscription.sessionId) || 0;
  const inFollowupWindow = nowMs <= followupUntil;
  if (subscription.activityTier === 'cold' && !subscription.pendingTurn && !inFollowupWindow) return false;
  const lastProbeAt = tmuxSelectionPromptLastProbeAt.get(subscription.sessionId) || 0;
  const intervalMs = inFollowupWindow
    ? MIRROR_TMUX_SELECTION_PROBE_FOLLOWUP_INTERVAL_MS
    : MIRROR_TMUX_SELECTION_PROBE_INTERVAL_MS;
  return nowMs - lastProbeAt >= intervalMs;
}

function requestTmuxSelectionPromptFollowupProbe(
  sessionId: string,
  nowMs = Date.now(),
  options: { resetLastProbe?: boolean; wakeDelayMs?: number } = {},
): void {
  const until = nowMs + MIRROR_TMUX_SELECTION_PROBE_FOLLOWUP_WINDOW_MS;
  const previous = tmuxSelectionPromptFollowupUntil.get(sessionId) || 0;
  if (until > previous) tmuxSelectionPromptFollowupUntil.set(sessionId, until);
  if (options.resetLastProbe !== false) {
    tmuxSelectionPromptLastProbeAt.set(sessionId, 0);
  }
  scheduleMirrorSelectionProbeWake(options.wakeDelayMs ?? 0);
}

function scheduleMirrorSelectionProbeWake(delayMs = 0): void {
  const state = getState();
  if (state.mirrorWakeTimer) {
    clearTimeout(state.mirrorWakeTimer);
  }
  state.mirrorWakeTimer = setTimeout(() => {
    state.mirrorWakeTimer = null;
    if (!state.running) return;
    void reconcileMirrorSubscriptions().catch((err) => {
      console.error('[bridge-manager] Mirror selection probe wake failed:', describeUnknownError(err));
    });
  }, Math.max(0, delayMs));
}

function getTmuxSelectionPromptMonitor(sessionId: string): CodexTuiSelectionPromptMonitor {
  let monitor = tmuxSelectionPromptMonitors.get(sessionId);
  if (!monitor) {
    monitor = createCodexTuiSelectionPromptMonitor();
    tmuxSelectionPromptMonitors.set(sessionId, monitor);
  }
  return monitor;
}

async function executeTmuxSelectionPromptForTarget(
  target: TmuxSelectionPromptTarget,
  prompt: NonNullable<ReturnType<typeof observeStableCodexTuiSelectionPrompt>>,
  targetPane: string,
): Promise<{ choice: string | null; commands: string[] }> {
  const adapter = getState().adapters.get(target.channelType);
  if (!adapter || !adapter.isRunning()) return { choice: null, commands: [] };
  const tmuxSessionName = targetPane.split(':')[0] || targetPane;
  transitionRuntimeTmuxInputState(
    'codex',
    tmuxSessionName,
    'waiting_selection',
    `Codex TUI is waiting at a ${prompt.kind} selection`,
  );
  const permissionRequestId = `codex-selection:${prompt.kind}:mirror:${target.sessionId}:${Date.now()}`;
  const choicePromise = broker.waitForCodexTuiSelectionPermission(permissionRequestId);
  broker.forwardPermissionRequest(
    adapter,
    { channelType: target.channelType, chatId: target.chatId },
    permissionRequestId,
    'Codex TUI Selection Prompt',
    {
      provider: 'tmux',
      reason: prompt.kind === 'update'
        ? 'Codex TUI is waiting at a CLI update selection prompt.'
        : prompt.kind === 'goal'
          ? 'Codex TUI is waiting at a goal replacement selection prompt.'
          : prompt.kind === 'generic'
            ? 'Codex TUI may be waiting at an unrecognized numbered selection prompt.'
            : 'Codex TUI is waiting at an interactive selection prompt.',
      inspect: '/tmux-screen 80',
      promptKind: prompt.kind,
      defaultChoice: getCodexTuiSelectionPromptUiDefaultChoice(prompt)
        || (prompt.kind === 'generic' ? 'not_selection' : prompt.options[0]?.choice),
      prompt: prompt.summary,
      choices: [
        ...prompt.options.map((option) => ({
          choice: option.choice,
          label: option.label,
          selected: option.selected,
        })),
        ...(prompt.kind === 'generic' ? [{ choice: 'not_selection', label: '这不是TUI选择' }] : []),
      ],
    },
    target.sessionId,
    [],
  );
  const choice = await choicePromise;
  if (!choice) {
    console.warn('[bridge-manager] Codex TUI selection prompt timed out:', {
      session_id: target.sessionId,
      thread_id: target.threadId,
      prompt_kind: prompt.kind,
    });
    return { choice: null, commands: [] };
  }
  const actions = buildCodexTuiSelectionChoiceActions(prompt, choice);
  if (choice === 'not_selection' || actions.length === 0) {
    console.log('[bridge-manager] Codex TUI generic selection dismissed from mirror probe:', {
      session_id: target.sessionId,
      thread_id: target.threadId,
      prompt_kind: prompt.kind,
      choice,
    });
    transitionRuntimeTmuxInputState(
      'codex',
      tmuxSessionName,
      'running',
      'the observed Codex screen was dismissed as not being a selection',
    );
    return { choice, commands: [] };
  }
  const result = await tmuxCore.sendActions(targetPane, actions);
  if (prompt.kind === 'update' && choice === 'update_now') {
    scheduleTmuxSelectionUpdateExitProbe({
      adapter,
      target,
      tmuxSessionName,
      choice,
    });
  }
  transitionRuntimeTmuxInputState(
    'codex',
    tmuxSessionName,
    prompt.kind === 'update' && choice === 'update_now' ? 'starting_tmux' : 'running',
    prompt.kind === 'update' && choice === 'update_now'
      ? 'Codex update was selected; wait for the TUI to exit or restart before more input'
      : `Codex ${prompt.kind} selection was resolved`,
  );
  console.log('[bridge-manager] Codex TUI selection prompt resolved from mirror probe:', {
    session_id: target.sessionId,
    thread_id: target.threadId,
    prompt_kind: prompt.kind,
    choice,
    commands: result.commands,
  });
  return { choice, commands: result.commands };
}

async function handleTmuxSelectionPromptForTarget(
  target: TmuxSelectionPromptTarget,
  prompt: NonNullable<ReturnType<typeof observeStableCodexTuiSelectionPrompt>>,
  targetPane: string,
): Promise<void> {
  const tmuxSessionName = targetPane.split(':')[0] || targetPane;
  const coordinated = await coordinateRuntimeTmuxSelection({
    runtime: 'codex',
    sessionName: tmuxSessionName,
    fingerprint: prompt.fingerprint,
    run: () => executeTmuxSelectionPromptForTarget(target, prompt, targetPane),
  });
  if (!coordinated.owner) {
    console.log('[bridge-manager] Codex TUI selection joined the session lifecycle owner:', {
      event: 'tmux.selection.lifecycle_joined',
      session_id: target.sessionId,
      thread_id: target.threadId,
      tmux_session: tmuxSessionName,
      prompt_kind: prompt.kind,
    });
  }
}

async function handleMirrorTmuxSelectionPrompt(
  subscription: BridgeMirrorSubscription,
  prompt: NonNullable<ReturnType<typeof observeStableCodexTuiSelectionPrompt>>,
  targetPane: string,
): Promise<void> {
  await handleTmuxSelectionPromptForTarget({
    channelType: subscription.channelType,
    chatId: subscription.chatId,
    sessionId: subscription.sessionId,
    threadId: subscription.threadId,
  }, prompt, targetPane);
}

function parseMirrorCodexSelectionSessionId(permissionRequestId: string): string | null {
  const parts = permissionRequestId.split(':');
  if (parts.length < 5) return null;
  if (parts[0] !== 'codex-selection' || parts[2] !== 'mirror') return null;
  return parts[3] || null;
}

function sessionSupportsTmuxSelectionPromptProbe(session: BridgeSession): boolean {
  const activeRuntime = getSessionActiveRuntime(session);
  if (activeRuntime === 'kimi' || activeRuntime === 'cursor' || activeRuntime === 'zcode') return false;
  if (activeRuntime === 'claude') return resolveEffectiveClaudeProvider(session) === 'tmux';
  return resolveEffectiveCodexProvider(session) === 'tmux';
}

function sessionSupportsCodexTuiRuntimeSignals(session: BridgeSession): boolean {
  const activeRuntime = getSessionActiveRuntime(session);
  if (activeRuntime === 'kimi' || activeRuntime === 'claude' || activeRuntime === 'cursor' || activeRuntime === 'zcode') return false;
  return resolveEffectiveCodexProvider(session) === 'tmux';
}

function assignCodexTuiTurnScreenBaseline(
  subscription: BridgeMirrorSubscription,
  turnState: BridgeMirrorTurnState,
): void {
  if (codexTuiTurnScreenBaselines.has(turnState.streamKey)) return;
  const checkpoint = codexTuiIdleScreenCheckpoints.get(subscription.sessionId);
  if (!checkpoint) return;
  const turnStartedAtMs = Date.parse(turnState.startedAt);
  if (!Number.isFinite(turnStartedAtMs) || checkpoint.capturedAtMs >= turnStartedAtMs) return;
  const turnKey = turnState.turnId || turnState.startedAt;
  if (checkpoint.claimedTurnKey && checkpoint.claimedTurnKey !== turnKey) return;
  checkpoint.claimedTurnKey = turnKey;
  codexTuiTurnScreenBaselines.set(turnState.streamKey, checkpoint);
}

function assignCodexTuiChainedTurnScreenBaseline(
  subscription: BridgeMirrorSubscription,
  checkpoint: CodexTuiScreenCheckpoint,
  finalizedStreamKey: string,
): void {
  const pendingTurn = subscription.pendingTurn;
  if (!pendingTurn || pendingTurn.streamKey === finalizedStreamKey) return;
  if (codexTuiTurnScreenBaselines.has(pendingTurn.streamKey)) return;
  const turnStartedAtMs = Date.parse(pendingTurn.startedAt);
  if (!Number.isFinite(turnStartedAtMs) || turnStartedAtMs > checkpoint.capturedAtMs) return;

  checkpoint.claimedTurnKey = pendingTurn.turnId || pendingTurn.startedAt;
  codexTuiTurnScreenBaselines.set(pendingTurn.streamKey, checkpoint);
  console.log('[bridge-manager] Codex TUI screen handed to chained turn as diagnostic baseline:', {
    event: 'codex.tui.diagnostic_baseline.handoff',
    session_id: subscription.sessionId,
    thread_id: subscription.threadId,
    finalized_stream_key: finalizedStreamKey,
    pending_stream_key: pendingTurn.streamKey,
    captured_at_ms: checkpoint.capturedAtMs,
    pending_started_at: pendingTurn.startedAt,
  });
}

async function captureCodexTuiIdleScreenCheckpoint(
  subscription: BridgeMirrorSubscription,
  activeTmuxSessionNames?: ReadonlySet<string>,
  nowMs = Date.now(),
): Promise<void> {
  if (subscription.pendingTurn || subscription.pendingDeliveries.length > 0) return;
  const existing = codexTuiIdleScreenCheckpoints.get(subscription.sessionId);
  if (existing && !existing.claimedTurnKey) return;
  const session = getBridgeContext().store.getSession(subscription.sessionId);
  if (!session || !sessionSupportsCodexTuiRuntimeSignals(session)) return;
  const tmuxSessionName = getSessionRuntimeTmuxSessionName(session);
  if (!tmuxSessionName) return;
  if (activeTmuxSessionNames && !activeTmuxSessionNames.has(tmuxSessionName)) {
    codexTuiIdleScreenMissingCheckedAt.set(subscription.sessionId, nowMs);
    return;
  }
  try {
    const capture = await tmuxCore.capturePane(`${tmuxSessionName}:0.0`, 80);
    codexTuiIdleScreenMissingCheckedAt.delete(subscription.sessionId);
    codexTuiIdleScreenCheckpoints.set(subscription.sessionId, {
      screen: capture.screen,
      capturedAtMs: nowMs,
    });
  } catch (error) {
    console.warn('[bridge-manager] Codex TUI idle checkpoint capture failed:', {
      session_id: subscription.sessionId,
      tmux_session: tmuxSessionName,
      error: describeUnknownError(error),
    });
  }
}

function shouldAttemptCodexTuiIdleScreenCheckpoint(
  subscription: BridgeMirrorSubscription,
  nowMs: number,
): boolean {
  if (subscription.pendingTurn || subscription.pendingDeliveries.length > 0) return false;
  const existing = codexTuiIdleScreenCheckpoints.get(subscription.sessionId);
  if (existing && !existing.claimedTurnKey) return false;
  const missingCheckedAt = codexTuiIdleScreenMissingCheckedAt.get(subscription.sessionId) || 0;
  const retryMs = subscription.activityTier === 'cold'
    ? CODEX_TUI_IDLE_CHECKPOINT_COLD_MISSING_RETRY_MS
    : CODEX_TUI_IDLE_CHECKPOINT_HOT_MISSING_RETRY_MS;
  return nowMs - missingCheckedAt >= retryMs;
}

function resolveCodexTuiIdleScreenCheckpointTmuxSessionName(
  subscription: BridgeMirrorSubscription,
  nowMs: number,
): string | null {
  if (!shouldAttemptCodexTuiIdleScreenCheckpoint(subscription, nowMs)) return null;
  const session = getBridgeContext().store.getSession(subscription.sessionId);
  if (!session || !sessionSupportsCodexTuiRuntimeSignals(session)) return null;
  return getSessionRuntimeTmuxSessionName(session) || null;
}

async function ensureCodexTuiIdleScreenCheckpoints(): Promise<void> {
  const nowMs = Date.now();
  const candidates = Array.from(getState().mirrorSubscriptions.values()).flatMap((subscription) => {
    const tmuxSessionName = resolveCodexTuiIdleScreenCheckpointTmuxSessionName(subscription, nowMs);
    return tmuxSessionName ? [{ subscription, tmuxSessionName }] : [];
  });
  if (candidates.length === 0) return;

  let activeTmuxSessionNames: Set<string>;
  try {
    const listed = await tmuxCore.listSessions();
    activeTmuxSessionNames = new Set(listed.sessions.map((session) => session.name));
  } catch (error) {
    for (const { subscription } of candidates) {
      codexTuiIdleScreenMissingCheckedAt.set(subscription.sessionId, nowMs);
    }
    console.warn('[bridge-manager] Unable to list tmux sessions for Codex TUI idle checkpoints:', {
      error: describeUnknownError(error),
    });
    return;
  }

  await Promise.allSettled(
    candidates.map(({ subscription }) =>
      captureCodexTuiIdleScreenCheckpoint(subscription, activeTmuxSessionNames, nowMs),
    ),
  );
}

function observeCodexTuiReconnectStatus(
  subscription: BridgeMirrorSubscription,
  screenText: string,
  nowMs: number,
): void {
  const pendingTurn = subscription.pendingTurn;
  const previous = codexTuiReconnectMonitors.get(subscription.sessionId);
  if (!pendingTurn) {
    codexTuiReconnectMonitors.delete(subscription.sessionId);
    return;
  }

  const reconnect = parseCodexTuiReconnectSignal(screenText);
  if (!reconnect) {
    if (!previous || previous.streamKey !== pendingTurn.streamKey) return;
    if (pendingTurn.statusNote === previous.appliedNote) {
      applyUnifiedTurnStatusNote(pendingTurn, previous.previousStatusNote, nowMs);
      MIRROR_TURN_HOOKS.onStatusProgress?.(subscription, pendingTurn);
    }
    codexTuiReconnectMonitors.delete(subscription.sessionId);
    return;
  }

  const signalKey = `${reconnect.attempt}/${reconnect.maxAttempts}`;
  if (previous?.streamKey === pendingTurn.streamKey && previous.signalKey === signalKey) return;
  const appliedNote = `正在重连 ${signalKey}`;
  const previousStatusNote = previous?.streamKey === pendingTurn.streamKey
    ? previous.previousStatusNote
    : pendingTurn.statusNote;
  applyUnifiedTurnStatusNote(pendingTurn, appliedNote, nowMs);
  codexTuiReconnectMonitors.set(subscription.sessionId, {
    streamKey: pendingTurn.streamKey,
    signalKey,
    appliedNote,
    previousStatusNote,
  });
  MIRROR_TURN_HOOKS.onStatusProgress?.(subscription, pendingTurn);
}

function buildCodexTuiModelMismatchCard(params: {
  bindingId: string;
  recordedModel: string;
  resumingModel: string;
}): OutboundRichCard {
  return {
    title: 'Codex 恢复模型不一致',
    template: 'orange',
    updateKey: `codex-model-mismatch:${params.bindingId}`,
    updateTtlMs: null,
    sections: [
      {
        fields: [
          ['Session 记录模型', `\`${params.recordedModel}\``],
          ['当前恢复模型', `\`${params.resumingModel}\``],
        ],
      },
      {
        markdown: '继续使用可能影响 Codex 表现。建议发送 `/clear` 新建 session。',
      },
    ],
  };
}

function notifyCodexTuiModelMismatchWarning(
  subscription: BridgeMirrorSubscription,
  warning: { recordedModel: string; resumingModel: string },
): void {
  const signalKey = `${subscription.sessionId}\u0000${warning.recordedModel}\u0000${warning.resumingModel}`;
  const { store } = getBridgeContext();
  const session = store.getSession(subscription.sessionId);
  const binding = store.getChannelChat(subscription.channelType, subscription.chatId);
  if (!session || !binding || binding.id !== subscription.bindingId) return;
  if (binding.bridgeSessionId !== subscription.sessionId) return;
  if (binding.codexModelMismatchWarningKey === signalKey) return;
  if (codexTuiModelMismatchNoticesInFlight.get(binding.id) === signalKey) return;
  const adapter = getState().adapters.get(subscription.channelType);
  if (!adapter?.isRunning()) return;

  codexTuiModelMismatchNoticesInFlight.set(binding.id, signalKey);
  const text = [
    'Codex 恢复模型不一致',
    '',
    `Session 记录模型：\`${warning.recordedModel}\``,
    `当前恢复模型：\`${warning.resumingModel}\``,
    '',
    '继续使用可能影响 Codex 表现。建议发送 `/clear` 新建 session。',
  ].join('\n');
  const delivery = enqueueBridgeNotice(
    adapter,
    { channelType: subscription.channelType, chatId: subscription.chatId },
    text,
    {
      sessionId: subscription.sessionId,
      audit: true,
      richCard: buildCodexTuiModelMismatchCard({
        bindingId: binding.id,
        ...warning,
      }),
    },
  );
  void delivery.completion.then((result) => {
    if (codexTuiModelMismatchNoticesInFlight.get(binding.id) === signalKey) {
      codexTuiModelMismatchNoticesInFlight.delete(binding.id);
    }
    if (!result.ok) {
      console.warn('[bridge-manager] Codex model mismatch notice delivery failed:', {
        event: 'codex.tui.model_mismatch.notice_failed',
        session_id: subscription.sessionId,
        thread_id: subscription.threadId,
        error: result.error,
      });
      return;
    }
    const latestSession = store.getSession(subscription.sessionId);
    const latestBinding = store.getChannelChat(subscription.channelType, subscription.chatId);
    if (!latestSession || getSessionCodexThreadId(latestSession) !== subscription.threadId) return;
    if (!latestBinding || latestBinding.id !== binding.id || latestBinding.bridgeSessionId !== subscription.sessionId) return;
    store.updateChannelChat(binding.id, { codexModelMismatchWarningKey: signalKey });
    console.warn('[bridge-manager] Codex resumed with a different model:', {
      event: 'codex.tui.model_mismatch.notified',
      session_id: subscription.sessionId,
      thread_id: subscription.threadId,
      recorded_model: warning.recordedModel,
      resuming_model: warning.resumingModel,
      message_id: result.messageId,
    });
  }).catch((error) => {
    if (codexTuiModelMismatchNoticesInFlight.get(binding.id) === signalKey) {
      codexTuiModelMismatchNoticesInFlight.delete(binding.id);
    }
    console.warn('[bridge-manager] Codex model mismatch notice delivery failed:', {
      event: 'codex.tui.model_mismatch.notice_failed',
      session_id: subscription.sessionId,
      thread_id: subscription.threadId,
      error: describeUnknownError(error),
    });
  });
}

function observeCodexTuiModelMismatchWarning(
  subscription: BridgeMirrorSubscription,
  screenText: string,
): void {
  const warning = parseCodexTuiModelMismatchWarning(screenText);
  if (!warning) return;
  const targets = new Map<string, BridgeMirrorSubscription>();
  for (const candidate of getState().mirrorSubscriptions.values()) {
    if (candidate.sessionId === subscription.sessionId) {
      targets.set(candidate.bindingId, candidate);
    }
  }
  if (targets.size === 0) targets.set(subscription.bindingId, subscription);
  for (const target of targets.values()) {
    notifyCodexTuiModelMismatchWarning(target, warning);
  }
}

function observeCodexTuiPendingTurnDiagnostic(
  subscription: BridgeMirrorSubscription,
  screenText: string,
): void {
  const pendingTurn = subscription.pendingTurn;
  if (!pendingTurn) return;
  const previous = codexTuiPendingTurnDiagnosticMonitors.get(pendingTurn.streamKey);
  const baseline = codexTuiTurnScreenBaselines.get(pendingTurn.streamKey);
  const previousScreen = previous?.screen || baseline?.screen;
  if (!previousScreen) return;
  const newDiagnostics = findNewCodexTuiDiagnostics(previousScreen, screenText);
  const diagnostics = [...(previous?.diagnostics || []), ...newDiagnostics];
  codexTuiPendingTurnDiagnosticMonitors.set(pendingTurn.streamKey, {
    screen: screenText,
    diagnostics,
  });
  for (const diagnostic of newDiagnostics) {
    console.warn('[bridge-manager] Codex TUI diagnostic observed while turn is running:', {
      event: 'codex.tui.diagnostic_observed',
      session_id: subscription.sessionId,
      thread_id: subscription.threadId,
      stream_key: pendingTurn.streamKey,
      impact: diagnostic.impact,
      terminal: diagnostic.terminal,
      error: diagnostic.message,
    });
  }
}

function applyCodexTuiDiagnosticToFinalizedTurn(
  turn: FinalizedBridgeMirrorTurn,
  diagnostic: CodexTuiDiagnostic,
  source: 'running_turn_probe' | 'completed_turn_probe',
): FinalizedBridgeMirrorTurn['status'] {
  if (diagnostic.terminal) {
    turn.errorText ||= diagnostic.message;
    console.warn('[bridge-manager] Terminal Codex TUI diagnostic applied:', {
      event: 'codex.tui.terminal_diagnostic_applied',
      source,
      stream_key: turn.streamKey,
      impact: diagnostic.impact,
      error: diagnostic.message,
    });
    return 'error';
  }

  const notice: RuntimeNoticeInfo = {
    level: 'error',
    title: '操作未完成',
    message: `${diagnostic.message}\n当前任务仍在继续。`,
    source: 'codex_tui',
  };
  turn.runtimeNotices ||= [];
  if (!turn.runtimeNotices.some((existing) => (
    existing.level === notice.level
    && existing.title === notice.title
    && existing.message === notice.message
    && existing.source === notice.source
  ))) {
    turn.runtimeNotices.push(notice);
  }
  console.warn('[bridge-manager] Recoverable Codex TUI diagnostic retained as a body notice:', {
    event: 'codex.tui.recoverable_diagnostic_applied',
    source,
    stream_key: turn.streamKey,
    impact: diagnostic.impact,
    error: diagnostic.message,
  });
  return turn.status;
}

function applyCodexTuiDiagnosticsToFinalizedTurn(
  turn: FinalizedBridgeMirrorTurn,
  diagnostics: CodexTuiDiagnostic[],
  source: 'running_turn_probe' | 'completed_turn_probe',
): FinalizedBridgeMirrorTurn['status'] {
  let status = turn.status;
  for (const diagnostic of diagnostics) {
    const nextStatus = applyCodexTuiDiagnosticToFinalizedTurn(turn, diagnostic, source);
    if (nextStatus === 'error') status = 'error';
  }
  return status;
}

async function resolveCodexTuiFinalizedTurnStatus(
  subscription: BridgeMirrorSubscription,
  turn: FinalizedBridgeMirrorTurn,
  context: { batchSize: number },
): Promise<FinalizedBridgeMirrorTurn['status']> {
  const baseline = codexTuiTurnScreenBaselines.get(turn.streamKey);
  const observedDiagnostics = codexTuiPendingTurnDiagnosticMonitors.get(turn.streamKey)?.diagnostics || [];
  codexTuiPendingTurnDiagnosticMonitors.delete(turn.streamKey);
  codexTuiReconnectMonitors.delete(subscription.sessionId);

  const session = getBridgeContext().store.getSession(subscription.sessionId);
  if (!session || !sessionSupportsCodexTuiRuntimeSignals(session)) {
    codexTuiTurnScreenBaselines.delete(turn.streamKey);
    return turn.status;
  }
  const tmuxSessionName = getSessionRuntimeTmuxSessionName(session);
  if (!tmuxSessionName) {
    codexTuiTurnScreenBaselines.delete(turn.streamKey);
    return turn.status;
  }

  try {
    const capture = await tmuxCore.capturePane(`${tmuxSessionName}:0.0`, 80);
    codexTuiTurnScreenBaselines.delete(turn.streamKey);
    const capturedAtMs = Date.now();
    const checkpoint: CodexTuiScreenCheckpoint = {
      screen: capture.screen,
      capturedAtMs,
    };
    codexTuiIdleScreenCheckpoints.set(subscription.sessionId, checkpoint);
    assignCodexTuiChainedTurnScreenBaseline(subscription, checkpoint, turn.streamKey);
    if (turn.status === 'completed' && observedDiagnostics.length > 0) {
      return applyCodexTuiDiagnosticsToFinalizedTurn(turn, observedDiagnostics, 'running_turn_probe');
    }
    if (turn.status !== 'completed' || !baseline || context.batchSize !== 1) {
      if (turn.status === 'completed' && !baseline) {
        console.log('[bridge-manager] Codex TUI completed-turn error probe skipped without a screen baseline:', {
          event: 'codex.tui.error_probe.skipped',
          reason: 'missing_screen_baseline',
          session_id: subscription.sessionId,
          thread_id: subscription.threadId,
          stream_key: turn.streamKey,
          batch_size: context.batchSize,
        });
      }
      return turn.status;
    }
    const currentFileSize = subscription.filePath
      ? (() => {
          try {
            return statSync(subscription.filePath).size;
          } catch {
            return null;
          }
        })()
      : null;
    if (subscription.fileSize === null || currentFileSize !== subscription.fileSize) {
      return turn.status;
    }
    const diagnostics = findNewCodexTuiDiagnostics(baseline.screen, capture.screen);
    if (diagnostics.length === 0) return turn.status;
    return applyCodexTuiDiagnosticsToFinalizedTurn(turn, diagnostics, 'completed_turn_probe');
  } catch (error) {
    if (turn.status === 'completed' && observedDiagnostics.length > 0) {
      return applyCodexTuiDiagnosticsToFinalizedTurn(turn, observedDiagnostics, 'running_turn_probe');
    }
    console.warn('[bridge-manager] Codex TUI completed-turn error probe failed:', {
      session_id: subscription.sessionId,
      tmux_session: tmuxSessionName,
      error: describeUnknownError(error),
    });
    return turn.status;
  }
}

async function recoverMirrorTmuxSelectionPromptFromCallback(
  claim: broker.CodexSelectionCallbackClaim,
  adapter: BaseChannelAdapter,
): Promise<{ ok: boolean; notice: string }> {
  const sessionId = claim.link.sessionId || parseMirrorCodexSelectionSessionId(claim.permissionRequestId);
  if (!sessionId) {
    return { ok: false, notice: 'Codex TUI Selection 已记录，但无法从回调中恢复目标会话。' };
  }
  const session = getBridgeContext().store.getSession(sessionId);
  if (!session) {
    return { ok: false, notice: `Codex TUI Selection 已记录，但找不到目标会话 ${sessionId}。` };
  }
  if (!sessionSupportsTmuxSelectionPromptProbe(session)) {
    return { ok: false, notice: `Codex TUI Selection 已记录，但目标会话 ${sessionId} 当前不是 tmux runtime。` };
  }
  const tmuxSessionName = getSessionRuntimeTmuxSessionName(session);
  if (!tmuxSessionName) {
    return { ok: false, notice: `Codex TUI Selection 已记录，但目标会话 ${sessionId} 没有 tmux session。` };
  }
  const targetPane = `${tmuxSessionName}:0.0`;
  let capture;
  try {
    capture = await tmuxCore.capturePane(targetPane, 80);
  } catch (error) {
    console.warn('[bridge-manager] Recovering Codex TUI selection callback failed to capture tmux pane:', {
      permission_request_id: claim.permissionRequestId,
      session_id: sessionId,
      tmux_session: tmuxSessionName,
      error: describeUnknownError(error),
    });
    return { ok: false, notice: `Codex TUI Selection 已记录，但读取 tmux pane 失败：${describeUnknownError(error)}。如果 tmux 已退出，请发送 /p tmux 重新启动。` };
  }
  const prompt = parseCodexTuiSelectionPrompt(capture.screen);
  if (!prompt) {
    return {
      ok: false,
      notice: `Codex TUI Selection 已记录，但 ${targetPane} 当前屏幕没有可识别的 TUI 选择提示；请用 /tmux-screen 80 检查。`,
    };
  }
  try {
    const actions = buildCodexTuiSelectionChoiceActions(prompt, claim.choice);
    if (claim.choice === 'not_selection' || actions.length === 0) {
      return { ok: true, notice: 'Codex TUI Selection 已记录为误判，未向 tmux 发送按键。' };
    }
    const coordinated = await coordinateRuntimeTmuxSelection({
      runtime: 'codex',
      sessionName: tmuxSessionName,
      fingerprint: prompt.fingerprint,
      run: async () => {
        const sent = await tmuxCore.sendActions(targetPane, actions);
        return { choice: claim.choice, commands: sent.commands };
      },
    });
    const result = coordinated.result;
    if (coordinated.owner && prompt.kind === 'update' && result.choice === 'update_now') {
      scheduleTmuxSelectionUpdateExitProbe({
        adapter,
        target: {
          channelType: adapter.channelType,
          chatId: claim.link.chatId,
          sessionId,
        },
        tmuxSessionName,
        choice: result.choice,
      });
    }
    console.log('[bridge-manager] Codex TUI selection prompt recovered from callback after waiter loss:', {
      permission_request_id: claim.permissionRequestId,
      session_id: sessionId,
      prompt_kind: prompt.kind,
      choice: result.choice,
      commands: result.commands,
      lifecycle_owner: coordinated.owner,
    });
    return { ok: true, notice: `Codex TUI Selection 已恢复并发送到 tmux：${result.choice || claim.choice}` };
  } catch (error) {
    console.warn('[bridge-manager] Recovering Codex TUI selection callback failed to send tmux actions:', {
      permission_request_id: claim.permissionRequestId,
      session_id: sessionId,
      tmux_session: tmuxSessionName,
      error: describeUnknownError(error),
    });
    return { ok: false, notice: `Codex TUI Selection 已记录，但发送 tmux 按键失败：${describeUnknownError(error)}` };
  }
}

function isTmuxSendAction(value: unknown): value is TmuxSendAction {
  if (!value || typeof value !== 'object') return false;
  const action = value as Record<string, unknown>;
  if (action.type === 'literal') return typeof action.text === 'string';
  if (action.type === 'key') return typeof action.key === 'string' && action.key.length > 0;
  return false;
}

function parseTmuxAutoForwardRecovery(link: PermissionLinkRecord): TmuxAutoForwardRecoveryPayload | null {
  if (!link.suggestions) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(link.suggestions);
  } catch {
    return null;
  }
  const candidates = Array.isArray(parsed) ? parsed : [parsed];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const payload = candidate as Record<string, unknown>;
    if (payload.kind !== 'tmux-provider-auto-forward') continue;
    if (payload.version !== 1) continue;
    if (typeof payload.target !== 'string' || !payload.target.trim()) continue;
    if (!Array.isArray(payload.actions) || !payload.actions.every(isTmuxSendAction)) continue;
    return {
      kind: 'tmux-provider-auto-forward',
      version: 1,
      target: payload.target,
      actions: payload.actions,
    };
  }
  return null;
}

function tmuxSessionNameFromTarget(target: string): string {
  const trimmed = target.trim();
  const colonIndex = trimmed.indexOf(':');
  return colonIndex >= 0 ? trimmed.slice(0, colonIndex) : trimmed;
}

async function recoverTmuxProviderAutoForwardFromSelectionCallback(
  claim: broker.CodexSelectionCallbackClaim,
): Promise<{ ok: boolean; notice: string; attempted: boolean }> {
  const recovery = parseTmuxAutoForwardRecovery(claim.link);
  if (!recovery) return { ok: false, notice: '', attempted: false };
  if (claim.choice === 'not_selection') {
    return { ok: true, notice: 'Codex TUI Selection 已记录为误判，未恢复 auto-forward 消息。', attempted: true };
  }

  try {
    const sessionName = tmuxSessionNameFromTarget(recovery.target);
    let handledSelection = false;
    const ready = await waitForRuntimeTmuxReady({
      runtime: 'codex',
      sessionName,
      target: recovery.target,
      core: tmuxCore,
      onSelectionPrompt: (selectionPrompt) => {
        if (selectionPrompt.runtime !== 'codex') return null;
        handledSelection = true;
        return claim.choice;
      },
    });
    if (!ready.ready) {
      const prompt = ready.selectionPrompt?.runtime === 'codex' ? ready.selectionPrompt : undefined;
      const reason = prompt
        ? `Codex TUI 仍停在 ${prompt.kind} selection prompt`
        : ready.lastError || 'Codex TUI 未在超时时间内进入可输入状态';
      return {
        ok: false,
        attempted: true,
        notice: handledSelection
          ? `Codex TUI Selection 已发送到 tmux，但 ${reason}，未恢复 auto-forward 消息。`
          : `Codex TUI Selection 已记录，但 ${reason}，未恢复 auto-forward 消息。`,
      };
    }
    if (!handledSelection) {
      return {
        ok: false,
        attempted: true,
        notice: `Codex TUI Selection 已记录，但 ${recovery.target} 当前屏幕没有可识别的 TUI 选择提示；未恢复 auto-forward 消息。`,
      };
    }
    await sendRuntimeTmuxInput({
      runtime: 'codex',
      sessionName,
      send: () => tmuxCore.sendActions(recovery.target, recovery.actions, {
        delayMs: 500,
        forcePasteLiterals: true,
      }),
    });
    console.log('[bridge-manager] Recovered tmux provider auto-forward from Codex TUI selection callback:', {
      permission_request_id: claim.permissionRequestId,
      session_id: claim.link.sessionId,
      target: recovery.target,
      action_count: recovery.actions.length,
    });
    return { ok: true, attempted: true, notice: 'Codex TUI Selection 已恢复，并已继续转发原始消息。' };
  } catch (error) {
    console.warn('[bridge-manager] Recovering tmux provider auto-forward failed:', {
      permission_request_id: claim.permissionRequestId,
      session_id: claim.link.sessionId,
      target: recovery.target,
      error: describeUnknownError(error),
    });
    return {
      ok: false,
      attempted: true,
      notice: `Codex TUI Selection 已记录，但恢复 auto-forward 失败：${describeUnknownError(error)}`,
    };
  }
}

async function probeMirrorTmuxSelectionPrompt(subscription: BridgeMirrorSubscription, nowMs = Date.now()): Promise<void> {
  if (!shouldProbeMirrorTmuxSelectionPrompt(subscription, nowMs)) return;
  tmuxSelectionPromptLastProbeAt.set(subscription.sessionId, nowMs);
  const session = getBridgeContext().store.getSession(subscription.sessionId);
  if (!session) return;
  if (!sessionSupportsTmuxSelectionPromptProbe(session)) return;
  const tmuxSessionName = getSessionRuntimeTmuxSessionName(session);
  if (!tmuxSessionName) return;
  const targetPane = `${tmuxSessionName}:0.0`;
  let capture;
  try {
    capture = await tmuxCore.capturePane(targetPane, 80);
  } catch (error) {
    const runtime = getSessionActiveRuntime(session) === 'claude' ? 'claude' : 'codex';
    try {
      const existence = await tmuxCore.hasSession(tmuxSessionName);
      if (!existence.exists) {
        transitionRuntimeTmuxInputState(
          runtime,
          tmuxSessionName,
          'stopped',
          'mirror probe confirmed the provider-owned tmux session is missing',
        );
        tmuxSelectionPromptFollowupUntil.delete(subscription.sessionId);
        tmuxSelectionPromptMonitors.delete(subscription.sessionId);
        const latestSession = getBridgeContext().store.getSession(subscription.sessionId);
        if (getSessionRuntimeTmuxSessionName(latestSession) === tmuxSessionName) {
          getBridgeContext().store.updateSession(subscription.sessionId, clearSessionTmuxBindingUpdate());
          SESSION_HEALTH_RUNTIME.recordInteractiveEnd(
            subscription.sessionId,
            'failed',
            `${runtime} tmux Provider session ${tmuxSessionName} is missing; mirror probing stopped.`,
          );
        }
        await finalizeMissingMirrorTmuxTurn(subscription, runtime, tmuxSessionName, nowMs);
        console.warn('[bridge-manager] Mirror tmux selection probe marked missing lifecycle stopped:', {
          event: 'tmux.mirror_probe.session_missing',
          session_id: subscription.sessionId,
          tmux_session: tmuxSessionName,
          command: existence.command,
        });
        return;
      }
    } catch (existenceError) {
      console.warn('[bridge-manager] Mirror tmux selection probe could not confirm session existence:', {
        session_id: subscription.sessionId,
        tmux_session: tmuxSessionName,
        error: describeUnknownError(existenceError),
      });
    }
    console.warn('[bridge-manager] Mirror tmux selection probe failed:', {
      session_id: subscription.sessionId,
      tmux_session: tmuxSessionName,
      error: describeUnknownError(error),
    });
    return;
  }
  if (sessionSupportsCodexTuiRuntimeSignals(session)) {
    observeCodexTuiModelMismatchWarning(subscription, capture.screen);
    observeCodexTuiReconnectStatus(subscription, capture.screen, nowMs);
    observeCodexTuiPendingTurnDiagnostic(subscription, capture.screen);
  }
  const monitor = getTmuxSelectionPromptMonitor(subscription.sessionId);
  const prompt = observeStableCodexTuiSelectionPrompt(capture.screen, monitor);
  if (!prompt) {
    if (
      subscription.pendingTurn
      && nowMs < (tmuxSelectionPromptFollowupUntil.get(subscription.sessionId) || 0)
    ) {
      scheduleMirrorSelectionProbeWake(MIRROR_TMUX_SELECTION_PROBE_FOLLOWUP_INTERVAL_MS);
    }
    if (!monitor.pending && monitor.firstSeenAtMs >= 0) {
      requestTmuxSelectionPromptFollowupProbe(subscription.sessionId, nowMs, {
        resetLastProbe: false,
        wakeDelayMs: MIRROR_TMUX_SELECTION_PROBE_FOLLOWUP_INTERVAL_MS,
      });
    }
    return;
  }
  monitor.pending = true;
  void handleMirrorTmuxSelectionPrompt(subscription, prompt, targetPane)
    .catch((error) => {
      console.error('[bridge-manager] Mirror tmux selection prompt handling failed:', describeUnknownError(error));
    })
    .finally(() => {
      markCodexTuiSelectionPromptActionSent(monitor);
      requestTmuxSelectionPromptFollowupProbe(subscription.sessionId);
    });
}

async function finalizeMissingMirrorTmuxTurn(
  subscription: BridgeMirrorSubscription,
  runtime: 'codex' | 'claude',
  tmuxSessionName: string,
  nowMs: number,
): Promise<void> {
  const pendingTurn = subscription.pendingTurn;
  if (!pendingTurn) return;

  const runtimeLabel = runtime === 'claude' ? 'Claude Code' : 'Codex';
  const errorText = `${runtimeLabel} tmux 会话 ${tmuxSessionName} 已退出，当前任务无法继续。发送 \`/p tmux\` 可重新启动。`;
  const signature = `tmux-missing:${subscription.sessionId}:${pendingTurn.streamKey}`;
  const timestamp = new Date(nowMs).toISOString();
  const finalized: FinalizedBridgeMirrorTurn = finalizeMirrorTurnBase(subscription, signature, timestamp, 'error') || {
    streamKey: pendingTurn.streamKey,
    userText: pendingTurn.userText?.trim() || null,
    text: pendingTurn.streamedText,
    ...(pendingTurn.contextUsage ? { contextUsage: pendingTurn.contextUsage } : {}),
    ...(pendingTurn.goalStatus ? { goalStatus: pendingTurn.goalStatus } : {}),
    signature,
    timestamp,
    startedAt: pendingTurn.startedAt,
    status: 'error' as const,
  };
  finalized.errorText = errorText;
  subscription.bufferedRecords = [];
  enqueuePendingMirrorDeliveries(subscription, [finalized]);

  const result = await deliverMirrorTurns(subscription, [finalized]);
  if (result.deliveredCount > 0) {
    removePendingMirrorDeliveries(subscription, [finalized]);
  }
  if (result.error) {
    console.warn('[bridge-manager] Failed to finalize missing tmux mirror turn:', {
      session_id: subscription.sessionId,
      tmux_session: tmuxSessionName,
      error: describeUnknownError(result.error),
    });
  }
}

async function probeTmuxSelectionPromptForTarget(
  target: TmuxSelectionPromptTarget,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const session = getBridgeContext().store.getSession(target.sessionId);
  if (!session) return false;
  if (!sessionSupportsTmuxSelectionPromptProbe(session)) return false;
  const tmuxSessionName = getSessionRuntimeTmuxSessionName(session);
  if (!tmuxSessionName) return false;
  const targetPane = `${tmuxSessionName}:0.0`;
  const monitor = getTmuxSelectionPromptMonitor(target.sessionId);
  const timeoutMs = options.timeoutMs ?? TMUX_AUTO_FORWARD_SELECTION_PROBE_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? TMUX_AUTO_FORWARD_SELECTION_PROBE_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    let capture;
    try {
      capture = await tmuxCore.capturePane(targetPane, 80);
    } catch (error) {
      console.warn('[bridge-manager] Tmux selection prompt probe failed:', {
        session_id: target.sessionId,
        tmux_session: tmuxSessionName,
        error: describeUnknownError(error),
      });
      return false;
    }
    const prompt = observeStableCodexTuiSelectionPrompt(capture.screen, monitor);
    if (prompt) {
      monitor.pending = true;
      void handleTmuxSelectionPromptForTarget(target, prompt, targetPane)
        .catch((error) => {
          console.error('[bridge-manager] Tmux selection prompt handling failed:', describeUnknownError(error));
        })
        .finally(() => {
          markCodexTuiSelectionPromptActionSent(monitor);
          requestTmuxSelectionPromptFollowupProbe(target.sessionId);
        });
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

function trackTmuxSelectionPromptProbeForTarget(
  target: TmuxSelectionPromptTarget,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const promise = probeTmuxSelectionPromptForTarget(target, options);
  pendingTmuxSelectionPromptProbePromises.add(promise);
  promise.then(
    () => pendingTmuxSelectionPromptProbePromises.delete(promise),
    () => pendingTmuxSelectionPromptProbePromises.delete(promise),
  );
  return promise;
}

async function waitForPendingTmuxSelectionPromptProbes(): Promise<void> {
  while (pendingTmuxSelectionPromptProbePromises.size > 0) {
    await Promise.allSettled([...pendingTmuxSelectionPromptProbePromises]);
  }
}

function primeClaudeMirrorInitialDelivery(sessionId: string): void {
  const state = getState();
  for (const subscription of state.claudeMirrorSubscriptions.values()) {
    if (subscription.sessionId !== sessionId) continue;
    subscription.cursor = { initialized: true, lastEventCount: 0 };
    subscription.dirty = true;
    subscription.fileOffset = 0;
    subscription.fileSize = null;
    subscription.fileMtimeMs = null;
    subscription.fileIdentity = null;
    subscription.trailingText = '';
    subscription.activeMirrorTurnId = null;
    subscription.activeSpecialCallIds.clear();
    subscription.bufferedRecords = [];
    subscription.pendingTurn = null;
    subscription.pendingDeliveries = [];
  }
}

async function reconcileClaudeTmuxMirrorAfterAutoForward(
  sessionId: string,
  startedAtMs: number,
): Promise<void> {
  const store = getBridgeContext().store;
  let session = store.getSession(sessionId);
  if (!session || getSessionActiveRuntime(session) !== 'claude') return;
  if (resolveEffectiveClaudeProvider(session) !== 'tmux') return;
  const cwd = getSessionClaudeCwd(session) || getSessionWorkingDirectory(session);
  if (!cwd) return;

  let discoveredNewClaudeSession = false;
  if (!getSessionClaudeSessionId(session)) {
    const discovered = await waitForClaudeSessionJsonlUpdatedAfter(cwd, startedAtMs);
    if (!discovered?.sessionId) return;
    store.updateSession(sessionId, setSessionClaudeIdentityUpdate(
      discovered.sessionId,
      discovered.cwd || cwd,
    ));
    discoveredNewClaudeSession = true;
    session = store.getSession(sessionId);
    if (!session || getSessionActiveRuntime(session) !== 'claude') return;
  }

  await reconcileMirrorSubscriptions();
  if (discoveredNewClaudeSession) {
    primeClaudeMirrorInitialDelivery(sessionId);
    await reconcileMirrorSubscriptions();
  }
}

// ── Streaming preview helpers ──────────────────────────────────

function describeUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || `${error.name}: ${error.message}`;
  }
  if (error === null) return 'null';
  if (typeof error === 'undefined') return 'undefined';
  if (typeof error === 'object') {
    const ctor = (error as { constructor?: { name?: string } })?.constructor?.name;
    const rendered = inspect(error, {
      depth: 4,
      breakLength: Infinity,
      compact: true,
    });
    return ctor && ctor !== 'Object' ? `${ctor} ${rendered}` : rendered;
  }
  return String(error);
}

function nowIso(): string {
  return new Date().toISOString();
}

function channelAddressFromBinding(binding: {
  channelType: string;
  channelProvider?: string;
  channelAlias?: string;
  chatId: string;
  chatKind?: ChannelChat['chatKind'];
  chatUserId?: string;
  chatDisplayName?: string;
}): ChannelAddress {
  return {
    channelType: binding.channelType,
    channelProvider: binding.channelProvider,
    channelAlias: binding.channelAlias,
    chatId: binding.chatId,
    chatKind: binding.chatKind,
    userId: binding.chatUserId,
    displayName: binding.chatDisplayName,
  };
}

const AGENT_MESSAGE_CARD_COLLAPSE_THRESHOLD = 800;

interface AgentExchangeEndpoint {
  chatName: string;
  botName: string;
}

function buildAgentExchangeCard(options: {
  direction: 'sent' | 'failed';
  source: AgentExchangeEndpoint;
  target?: AgentExchangeEndpoint;
  unresolvedTarget?: string;
  messageText: string;
  detail?: string;
}): OutboundRichCard {
  const failed = options.direction === 'failed';
  const messageMarkdown = buildFencedCodeBlock(options.messageText, 'text');
  const longMessage = options.messageText.length > AGENT_MESSAGE_CARD_COLLAPSE_THRESHOLD;
  const identitySections: OutboundRichCard['sections'] = failed ? [{
    fields: [
      ['来源群聊', options.source.chatName],
      ['来源 Bot', options.source.botName],
    ],
  }, {
    fields: options.target ? [
      ['目标群聊', options.target.chatName],
      ['目标 Bot', options.target.botName],
    ] : [
      ['目标', options.unresolvedTarget || '未知目标'],
      ...(options.detail ? [['错误', options.detail] as [string, string]] : []),
    ],
  }] : [{ fields: [['目标群聊', options.target?.chatName || options.unresolvedTarget || '未知目标']] }];
  return {
    title: failed ? 'Agent 消息发送失败' : 'Agent 消息已发送',
    template: failed ? 'red' : 'green',
    sections: [...identitySections, ...(longMessage ? [] : [{
      title: '消息内容',
      markdown: messageMarkdown,
    }])],
    ...(longMessage ? {
      panels: [{
        title: '消息内容（点击展开）',
        template: failed ? 'red' : 'green',
        expanded: false,
        sections: [{ markdown: messageMarkdown }],
      }],
    } : {}),
  };
}

export function listActiveBridgeSessions(query?: string) {
  const { store } = getBridgeContext();
  return listDiscoveredBridgeSessions({
    store,
    codelarkHome: CODELARK_HOME,
    getAdapter: (channelType) => getState().adapters.get(channelType),
    query,
  });
}

function enqueueManualInput(request: ManualInputRequest): boolean {
  const { store } = getBridgeContext();
  const binding = store.listChannelChats().find((candidate) => candidate.id === request.targetInternalChatId);
  if (!binding) throw new Error(`目标群聊不存在：${request.targetInternalChatId}`);
  const adapter = getState().adapters.get(binding.channelType);
  if (!adapter?.isRunning()) throw new Error(`目标群聊通道未运行：${binding.channelType}`);
  const targetSession = store.getSession(binding.bridgeSessionId);
  if (!targetSession) throw new Error(`目标 session 不存在：${binding.bridgeSessionId}`);
  const target = sourceMetadataForBinding({
    store,
    codelarkHome: CODELARK_HOME,
    binding,
    botName: adapter.getBotDisplayName(),
  });

  const targetAddress = channelAddressFromBinding({
    ...binding,
    chatDisplayName: target.chatName,
  });
  const idempotencyKey = request.idempotencyKey?.trim();
  if (idempotencyKey && !claimAgentInputReceipt(idempotencyKey)) return false;
  adapter.enqueueManualInboundMessage({
    messageId: idempotencyKey ? `manual:${idempotencyKey}` : `manual:${crypto.randomUUID()}`,
    address: targetAddress,
    text: request.text,
    contextText: formatAgentSourceXml(request.source, target.bridgeSessionId),
    timestamp: Date.now(),
    raw: { manualIngress: true, source: request.source },
  });
  return true;
}

export function receiveManualInput(request: ManualInputRequest): boolean {
  return enqueueManualInput(request);
}

export async function receiveAgentInput(request: AgentInputRequest): Promise<void> {
  await sendAgentMessageFromBinding(request.sourceInternalChatId, {
    target: request.target,
    text: request.text,
    codelarkHome: request.codelarkHome,
    idempotencyKey: request.idempotencyKey,
  });
}

export async function sendPlatformMessage(request: PlatformMessageRequest): Promise<void> {
  const { store } = getBridgeContext();
  const binding = store.listChannelChats().find((candidate) => candidate.id === request.targetInternalChatId);
  if (!binding) throw new Error(`目标群聊不存在：${request.targetInternalChatId}`);
  const adapter = getState().adapters.get(binding.channelType);
  if (!adapter?.isRunning()) throw new Error(`目标群聊通道未运行：${binding.channelType}`);
  const session = store.getSession(binding.bridgeSessionId);
  const address = channelAddressFromBinding({
    ...binding,
    chatDisplayName: session?.name,
  });
  const idempotencyKey = request.idempotencyKey?.trim();
  const result = await deliver(adapter, {
    address,
    text: '',
    platformMessage: idempotencyKey && !request.platformMessage.uuid
      ? { ...request.platformMessage, uuid: idempotencyKey }
      : request.platformMessage,
  }, {
    sessionId: binding.bridgeSessionId,
    dedupKey: idempotencyKey ? `platform-message:${idempotencyKey}` : undefined,
  });
  if (!result.ok) throw new Error(result.error || '平台消息发送失败');
}

export function createConditionMonitor(request: CreateConditionMonitorRequest): ConditionMonitorTask {
  const { store } = getBridgeContext();
  const binding = store.listChannelChats().find((candidate) => candidate.id === request.ownerInternalChatId);
  if (!binding || binding.bridgeSessionId !== request.ownerBridgeSessionId) {
    throw new Error(`Condition monitor 所属会话不存在：${request.ownerBridgeSessionId}`);
  }
  statSync(request.scriptPath);
  const task = createConditionMonitorTask(request);
  startConditionMonitor(task.id);
  return task;
}

export function listConditionMonitors(ownerInternalChatId?: string): ConditionMonitorTask[] {
  return listConditionMonitorTasks({ ownerInternalChatId });
}

export function cancelConditionMonitor(taskId: string): ConditionMonitorTask | null {
  const task = getConditionMonitorTask(taskId);
  if (!task) return null;
  const cancelled = cancelConditionMonitorTask(taskId);
  stopConditionMonitor(taskId);
  return cancelled;
}

export async function sendAgentMessageFromBinding(
  sourceBindingId: string,
  instruction: AgentSendInstruction,
): Promise<void> {
  const { store } = getBridgeContext();
  const sourceBinding = store.listChannelChats().find((candidate) => candidate.id === sourceBindingId);
  if (!sourceBinding) throw new Error(`来源群聊不存在：${sourceBindingId}`);
  const sourceAdapter = getState().adapters.get(sourceBinding.channelType);
  if (!sourceAdapter?.isRunning()) throw new Error(`来源群聊通道未运行：${sourceBinding.channelType}`);
  const source = sourceMetadataForBinding({
    store,
    codelarkHome: CODELARK_HOME,
    binding: sourceBinding,
    botName: sourceAdapter.getBotDisplayName(),
  });
  const sourceAddress = channelAddressFromBinding({
    ...sourceBinding,
    chatDisplayName: source.chatName,
  });
  const legacyTarget = typeof instruction.target === 'string'
    ? instruction.target.trim().toLocaleLowerCase()
    : '';
  if (legacyTarget === 'current' || legacyTarget === 'self') {
    enqueueManualInput({
      targetInternalChatId: sourceBinding.id,
      text: instruction.text,
      source,
      idempotencyKey: instruction.idempotencyKey,
    });
    return;
  }
  try {
    const target = await deliverManualInput({
      target: instruction.target,
      text: instruction.text,
      source,
      codelarkHome: instruction.codelarkHome,
      idempotencyKey: instruction.idempotencyKey,
    });
    if (!target.accepted) return;
    const targetEndpoint = {
      chatName: target.chatName,
      botName: target.agentName,
    };
    const mergedIntoConversation = sourceAdapter.onAgentMessageSent?.(sourceAddress.chatId, {
      targetChatName: targetEndpoint.chatName,
      messageText: instruction.text,
    }) === true;
    if (!mergedIntoConversation) {
      enqueueBridgeNotice(sourceAdapter, sourceAddress, 'Agent 消息已发送', {
        sessionId: sourceBinding.bridgeSessionId,
        richCard: buildAgentExchangeCard({
          direction: 'sent',
          source,
          target: targetEndpoint,
          messageText: instruction.text,
        }),
      });
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    enqueueBridgeNotice(sourceAdapter, sourceAddress, 'Agent 消息发送失败', {
      sessionId: sourceBinding.bridgeSessionId,
      richCard: buildAgentExchangeCard({
        direction: 'failed',
        source,
        unresolvedTarget: typeof instruction.target === 'string'
          ? instruction.target
          : instruction.target.chatName || instruction.target.botName || instruction.target.chatId || instruction.target.query || '目标群聊',
        messageText: instruction.text,
        detail,
      }),
    });
    throw error;
  }
}

interface StartupChannelChatCheckIssue {
  channelType: string;
  channelAlias?: string;
  chatId: string;
  title: string;
  bridgeSessionId: string;
  detail?: string;
}

interface StartupChannelChatCheckResult {
  archivedMissingChats: StartupChannelChatCheckIssue[];
  checkErrors: StartupChannelChatCheckIssue[];
}

type StartupChannelChatCheckAdapter = BaseChannelAdapter & {
  getGroupChatInfo: NonNullable<BaseChannelAdapter['getGroupChatInfo']>;
};

interface StartupChannelChatCheckCandidate {
  binding: ChannelChat;
  adapter: StartupChannelChatCheckAdapter;
  title: string;
}

interface StartupFeishuSetupNotice {
  channelType: string;
  channelAlias?: string;
  appId: string;
  eventUrl: string;
  requiredEvents: string[];
}

interface StartupNoticeTarget {
  address: ChannelAddress;
  binding: ChannelChat | null;
  sessionId?: string;
  operation?: StartupNoticeOperation;
}

const REQUIRED_FEISHU_EVENT_SUBSCRIPTIONS = [
  'im.message.receive_v1',
  'card.action.trigger',
  'drive.notice.comment_add_v1',
  'im.chat.member.bot.deleted_v1',
  'im.chat.disbanded_v1',
] as const;
const STARTUP_CHANNEL_CHAT_CHECK_CONCURRENCY = 8;
const STARTUP_CHANNEL_CHAT_CHECK_NOTICE_BUDGET_MS = 3_000;
const STARTUP_CHANNEL_CHAT_CHECK_TIMEOUT = Symbol('startup-channel-chat-check-timeout');

function formatStartupChannelChatIssue(issue: StartupChannelChatCheckIssue): string {
  const channel = issue.channelAlias || issue.channelType;
  const shortSession = issue.bridgeSessionId.slice(0, 8);
  const detail = issue.detail ? `：${issue.detail}` : '';
  return `- ${issue.title} (${channel}, chat=${issue.chatId}, session=${shortSession})${detail}`;
}

function feishuEventSubscriptionUrl(appId: string, site: FeishuChannelConfig['site'] | undefined): string {
  const base = feishuSiteToApiBaseUrl(site);
  return `${base}/app/${encodeURIComponent(appId)}/event?tab=callback`;
}

function collectStartupFeishuSetupNotices(
  state: BridgeManagerState,
): StartupFeishuSetupNotice[] {
  return listConfiguredChannelInstances()
    .filter((channel) => channel.enabled && channel.provider === 'feishu')
    .filter((channel) => state.adapters.get(channel.id)?.isRunning())
    .flatMap((channel): StartupFeishuSetupNotice[] => {
      const config = (channel.config || {}) as FeishuChannelConfig;
      const appId = config.appId?.trim();
      if (!appId) return [];
      return [{
        channelType: channel.id,
        channelAlias: channel.alias,
        appId,
        eventUrl: feishuEventSubscriptionUrl(appId, config.site),
        requiredEvents: [...REQUIRED_FEISHU_EVENT_SUBSCRIPTIONS],
      }];
    });
}

function formatStartupFeishuSetupNotice(issue: StartupFeishuSetupNotice): string {
  const channel = issue.channelAlias || issue.channelType;
  return [
    `- ${channel} (${issue.channelType})`,
    `  事件/回调：${issue.requiredEvents.join('、')}`,
    `  事件配置：${issue.eventUrl}`,
  ].join('\n');
}

function logStartupFeishuSetupNotices(issues: StartupFeishuSetupNotice[]): void {
  for (const issue of issues) {
    console.warn('[bridge-manager] Feishu startup configuration check: verify event subscriptions and callbacks', {
      channelType: issue.channelType,
      channelAlias: issue.channelAlias,
      appId: issue.appId,
      eventUrl: issue.eventUrl,
      requiredEvents: issue.requiredEvents,
    });
  }
}

function formatArchivedMissingChatsNote(count: number): string {
  if (count <= 0) return '';
  return count === 1
    ? '有一个群聊已不在，因此已对这个对话做了归档。'
    : `有 ${count} 个群聊已不在，因此已对这些对话做了归档。`;
}

function channelChatUpdatedTime(binding: ChannelChat): number {
  const time = Date.parse(binding.updatedAt || binding.createdAt || '');
  return Number.isFinite(time) ? time : 0;
}

function touchInboundChannelChatActivity(msg: InboundMessage): void {
  const { store } = getBridgeContext();
  const binding = store.getChannelChat(msg.address.channelType, msg.address.chatId);
  if (!binding) return;
  store.touchChannelChatActivity(binding.id, nowIso());
  codexTuiIdleScreenMissingCheckedAt.delete(binding.bridgeSessionId);
}


interface BridgeManagerState extends BridgeAdapterRuntimeState, BridgeInteractiveRuntimeState {
  startedAt: string | null;
  reconcileTimer: NodeJS.Timeout | null;
  mirrorPollTimer: NodeJS.Timeout | null;
  mirrorWakeTimer: NodeJS.Timeout | null;
  mirrorSubscriptions: Map<string, BridgeMirrorSubscription>;
  mirrorSyncInFlight: boolean;
  claudeMirrorWakeTimer: NodeJS.Timeout | null;
  claudeMirrorSubscriptions: Map<string, BridgeMirrorSubscription>;
  claudeMirrorSyncInFlight: boolean;
  kimiMirrorWakeTimer: NodeJS.Timeout | null;
  kimiMirrorSubscriptions: Map<string, BridgeMirrorSubscription>;
  kimiMirrorSyncInFlight: boolean;
  cursorMirrorWakeTimer: NodeJS.Timeout | null;
  cursorMirrorSubscriptions: Map<string, BridgeMirrorSubscription>;
  cursorMirrorSyncInFlight: boolean;
  zcodeMirrorWakeTimer: NodeJS.Timeout | null;
  zcodeMirrorSubscriptions: Map<string, BridgeMirrorSubscription>;
  zcodeMirrorSyncInFlight: boolean;
  mirrorSuppressUntil: Map<string, MirrorSuppressionState[]>;
  mirrorIgnoredTurnIds: Map<string, Map<string, number>>;
  threadCardSelections: Map<string, string>;
  everyTaskSelections: Map<string, string>;
  thenTaskSelections: Map<string, string>;
  everyTaskRuntimes: Map<string, EveryTaskRuntimeState>;
  conditionMonitorRuntimes: Map<string, AbortController>;
  thenTaskTimers: Map<string, NodeJS.Timeout>;
  thenSessionQueues: Set<string>;
  autoStartChecked: boolean;
  dailyVersionUpdateRuntime: DailyVersionUpdateRuntime | null;
}

interface EveryTaskRuntimeState {
  abortController: AbortController;
  bridgeSessionId: string;
  activeTrigger: boolean;
}

function getState(): BridgeManagerState {
  const g = globalThis as unknown as Record<string, BridgeManagerState>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      adapters: new Map(),
      adapterMeta: new Map(),
      invalidAdapters: new Map(),
      running: false,
      startedAt: null,
      loopAborts: new Map(),
      reconcileTimer: null,
      mirrorPollTimer: null,
      mirrorWakeTimer: null,
      activeTasks: new Map(),
      mirrorSubscriptions: new Map(),
      mirrorSyncInFlight: false,
      claudeMirrorWakeTimer: null,
      claudeMirrorSubscriptions: new Map(),
      claudeMirrorSyncInFlight: false,
      kimiMirrorWakeTimer: null,
      kimiMirrorSubscriptions: new Map(),
      kimiMirrorSyncInFlight: false,
      cursorMirrorWakeTimer: null,
      cursorMirrorSubscriptions: new Map(),
      cursorMirrorSyncInFlight: false,
      zcodeMirrorWakeTimer: null,
      zcodeMirrorSubscriptions: new Map(),
      zcodeMirrorSyncInFlight: false,
      mirrorSuppressUntil: new Map(),
      mirrorIgnoredTurnIds: new Map(),
      threadCardSelections: new Map(),
      everyTaskSelections: new Map(),
      thenTaskSelections: new Map(),
      everyTaskRuntimes: new Map(),
      conditionMonitorRuntimes: new Map(),
      thenTaskTimers: new Map(),
      thenSessionQueues: new Set(),
      queuedCounts: new Map(),
      sessionLocks: new Map(),
      autoStartChecked: false,
      dailyVersionUpdateRuntime: null,
    };
  }
  // Backfill sessionLocks for states created before this field existed
  if (!g[GLOBAL_KEY].sessionLocks) {
    g[GLOBAL_KEY].sessionLocks = new Map();
  }
  if (!g[GLOBAL_KEY].mirrorSubscriptions) {
    g[GLOBAL_KEY].mirrorSubscriptions = new Map();
  }
  if (!g[GLOBAL_KEY].claudeMirrorSubscriptions) {
    g[GLOBAL_KEY].claudeMirrorSubscriptions = new Map();
  }
  if (!g[GLOBAL_KEY].kimiMirrorSubscriptions) {
    g[GLOBAL_KEY].kimiMirrorSubscriptions = new Map();
  }
  if (!g[GLOBAL_KEY].cursorMirrorSubscriptions) {
    g[GLOBAL_KEY].cursorMirrorSubscriptions = new Map();
  }
  if (!g[GLOBAL_KEY].zcodeMirrorSubscriptions) {
    g[GLOBAL_KEY].zcodeMirrorSubscriptions = new Map();
  }
  if (!g[GLOBAL_KEY].invalidAdapters) {
    g[GLOBAL_KEY].invalidAdapters = new Map();
  }
  if (!g[GLOBAL_KEY].queuedCounts) {
    g[GLOBAL_KEY].queuedCounts = new Map();
  }
  if (!g[GLOBAL_KEY].mirrorSuppressUntil) {
    g[GLOBAL_KEY].mirrorSuppressUntil = new Map();
  }
  if (!g[GLOBAL_KEY].mirrorIgnoredTurnIds) {
    g[GLOBAL_KEY].mirrorIgnoredTurnIds = new Map();
  }
  if (!g[GLOBAL_KEY].threadCardSelections) {
    g[GLOBAL_KEY].threadCardSelections = new Map();
  }
  if (!g[GLOBAL_KEY].everyTaskSelections) {
    g[GLOBAL_KEY].everyTaskSelections = new Map();
  }
  if (!g[GLOBAL_KEY].thenTaskSelections) {
    g[GLOBAL_KEY].thenTaskSelections = new Map();
  }
  if (!g[GLOBAL_KEY].everyTaskRuntimes) {
    g[GLOBAL_KEY].everyTaskRuntimes = new Map();
  }
  if (!g[GLOBAL_KEY].conditionMonitorRuntimes) {
    g[GLOBAL_KEY].conditionMonitorRuntimes = new Map();
  }
  if (!g[GLOBAL_KEY].thenTaskTimers) {
    g[GLOBAL_KEY].thenTaskTimers = new Map();
  }
  if (!g[GLOBAL_KEY].thenSessionQueues) {
    g[GLOBAL_KEY].thenSessionQueues = new Set();
  }
  if (!Object.prototype.hasOwnProperty.call(g[GLOBAL_KEY], 'mirrorSyncInFlight')) {
    g[GLOBAL_KEY].mirrorSyncInFlight = false;
  }
  if (!Object.prototype.hasOwnProperty.call(g[GLOBAL_KEY], 'claudeMirrorSyncInFlight')) {
    g[GLOBAL_KEY].claudeMirrorSyncInFlight = false;
  }
  if (!Object.prototype.hasOwnProperty.call(g[GLOBAL_KEY], 'kimiMirrorWakeTimer')) {
    g[GLOBAL_KEY].kimiMirrorWakeTimer = null;
  }
  if (!Object.prototype.hasOwnProperty.call(g[GLOBAL_KEY], 'kimiMirrorSyncInFlight')) {
    g[GLOBAL_KEY].kimiMirrorSyncInFlight = false;
  }
  if (!Object.prototype.hasOwnProperty.call(g[GLOBAL_KEY], 'cursorMirrorWakeTimer')) {
    g[GLOBAL_KEY].cursorMirrorWakeTimer = null;
  }
  if (!Object.prototype.hasOwnProperty.call(g[GLOBAL_KEY], 'cursorMirrorSyncInFlight')) {
    g[GLOBAL_KEY].cursorMirrorSyncInFlight = false;
  }
  if (!Object.prototype.hasOwnProperty.call(g[GLOBAL_KEY], 'zcodeMirrorWakeTimer')) {
    g[GLOBAL_KEY].zcodeMirrorWakeTimer = null;
  }
  if (!Object.prototype.hasOwnProperty.call(g[GLOBAL_KEY], 'zcodeMirrorSyncInFlight')) {
    g[GLOBAL_KEY].zcodeMirrorSyncInFlight = false;
  }
  return g[GLOBAL_KEY];
}

function getClaudeMirrorState(): BridgeMirrorRuntimeState {
  const state = getState();
  return {
    get running() { return state.running; },
    set running(value) { state.running = value; },
    get adapters() { return state.adapters; },
    set adapters(value) { state.adapters = value; },
    get mirrorSubscriptions() { return state.claudeMirrorSubscriptions; },
    set mirrorSubscriptions(value) { state.claudeMirrorSubscriptions = value; },
    get mirrorWakeTimer() { return state.claudeMirrorWakeTimer; },
    set mirrorWakeTimer(value) { state.claudeMirrorWakeTimer = value; },
    get mirrorSyncInFlight() { return state.claudeMirrorSyncInFlight; },
    set mirrorSyncInFlight(value) { state.claudeMirrorSyncInFlight = value; },
    get activeTasks() { return state.activeTasks; },
    set activeTasks(value) { state.activeTasks = value; },
  };
}

function getKimiMirrorState(): BridgeMirrorRuntimeState {
  const state = getState();
  return {
    get running() { return state.running; },
    set running(value) { state.running = value; },
    get adapters() { return state.adapters; },
    set adapters(value) { state.adapters = value; },
    get mirrorSubscriptions() { return state.kimiMirrorSubscriptions; },
    set mirrorSubscriptions(value) { state.kimiMirrorSubscriptions = value; },
    get mirrorWakeTimer() { return state.kimiMirrorWakeTimer; },
    set mirrorWakeTimer(value) { state.kimiMirrorWakeTimer = value; },
    get mirrorSyncInFlight() { return state.kimiMirrorSyncInFlight; },
    set mirrorSyncInFlight(value) { state.kimiMirrorSyncInFlight = value; },
    get activeTasks() { return state.activeTasks; },
    set activeTasks(value) { state.activeTasks = value; },
  };
}

function getCursorMirrorState(): BridgeMirrorRuntimeState {
  const state = getState();
  return {
    get running() { return state.running; },
    set running(value) { state.running = value; },
    get adapters() { return state.adapters; },
    set adapters(value) { state.adapters = value; },
    get mirrorSubscriptions() { return state.cursorMirrorSubscriptions; },
    set mirrorSubscriptions(value) { state.cursorMirrorSubscriptions = value; },
    get mirrorWakeTimer() { return state.cursorMirrorWakeTimer; },
    set mirrorWakeTimer(value) { state.cursorMirrorWakeTimer = value; },
    get mirrorSyncInFlight() { return state.cursorMirrorSyncInFlight; },
    set mirrorSyncInFlight(value) { state.cursorMirrorSyncInFlight = value; },
    get activeTasks() { return state.activeTasks; },
    set activeTasks(value) { state.activeTasks = value; },
  };
}

function getZcodeMirrorState(): BridgeMirrorRuntimeState {
  const state = getState();
  return {
    get running() { return state.running; },
    set running(value) { state.running = value; },
    get adapters() { return state.adapters; },
    set adapters(value) { state.adapters = value; },
    get mirrorSubscriptions() { return state.zcodeMirrorSubscriptions; },
    set mirrorSubscriptions(value) { state.zcodeMirrorSubscriptions = value; },
    get mirrorWakeTimer() { return state.zcodeMirrorWakeTimer; },
    set mirrorWakeTimer(value) { state.zcodeMirrorWakeTimer = value; },
    get mirrorSyncInFlight() { return state.zcodeMirrorSyncInFlight; },
    set mirrorSyncInFlight(value) { state.zcodeMirrorSyncInFlight = value; },
    get activeTasks() { return state.activeTasks; },
    set activeTasks(value) { state.activeTasks = value; },
  };
}

const INTERACTIVE_RUNTIME = createInteractiveRuntime(getState, {
  getStore: () => getBridgeContext().store,
  nowIso,
});

function formatRuntimeTerminalDetail(terminal: BridgeTurnTerminalRecord): string {
  if (terminal.runtime === 'claude') {
    if (terminal.outcome === 'aborted') {
      return '检测到 Claude Code 会话已停止当前任务。';
    }
    if (terminal.outcome === 'failed') {
      return '检测到 Claude Code 会话当前任务执行失败。';
    }
    return '检测到 Claude Code 会话已完成当前任务。';
  }
  if (terminal.runtime === 'kimi') {
    if (terminal.outcome === 'aborted') {
      return '检测到 Kimi Code 会话已停止当前任务。';
    }
    if (terminal.outcome === 'failed') {
      return '检测到 Kimi Code 会话当前任务执行失败。';
    }
    return '检测到 Kimi Code 会话已完成当前任务。';
  }
  if (terminal.runtime === 'cursor') {
    if (terminal.outcome === 'aborted') {
      return '检测到 Cursor Agent 会话已停止当前任务。';
    }
    if (terminal.outcome === 'failed') {
      return '检测到 Cursor Agent 会话当前任务执行失败。';
    }
    return '检测到 Cursor Agent 会话已完成当前任务。';
  }
  if (terminal.runtime === 'zcode') {
    if (terminal.outcome === 'aborted') {
      return '检测到 ZCode 会话已停止当前任务。';
    }
    if (terminal.outcome === 'failed') {
      return '检测到 ZCode 会话当前任务执行失败。';
    }
    return '检测到 ZCode 会话已完成当前任务。';
  }
  if (terminal.outcome === 'aborted') {
    return '检测到 Codex thread已停止当前任务。';
  }
  if (terminal.outcome === 'failed') {
    return '检测到 Codex thread当前任务执行失败。';
  }
  return '检测到 Codex thread已完成当前任务。';
}

const TURN_COORDINATOR = createTurnCoordinator({
  finalizeTerminalTurn: (turn, terminal) => INTERACTIVE_RUNTIME.finalizeTerminalActiveTask(
    turn.sessionId,
    terminal.outcome,
    formatRuntimeTerminalDetail(terminal),
    terminal.text,
  ),
});

const SESSION_HEALTH_RUNTIME = createSessionHealthRuntime({
  getStore: () => getBridgeContext().store,
  nowIso,
  probeThreadProcess: (threadId) => probeCodexThreadProcess(threadId),
});

const MIRROR_SUPPRESSION_CONFIG: MirrorSuppressionConfig = {
  suppressionWindowMs: MIRROR_SUPPRESSION_WINDOW_MS,
  promptMatchGraceMs: MIRROR_PROMPT_MATCH_GRACE_MS,
};

function getMirrorSuppressionStore(): MirrorSuppressionStore {
  const state = getState();
  return {
    suppressions: state.mirrorSuppressUntil,
    ignoredTurnIds: state.mirrorIgnoredTurnIds,
  };
}

function beginMirrorSuppression(sessionId: string, promptText: string): string {
  return beginMirrorSuppressionBase(getMirrorSuppressionStore(), sessionId, promptText);
}

function abortMirrorSuppression(
  sessionId: string,
  suppressionId?: string | null,
): void {
  abortMirrorSuppressionBase(
    getMirrorSuppressionStore(),
    sessionId,
    MIRROR_SUPPRESSION_CONFIG,
    suppressionId,
  );
}

function settleMirrorSuppression(
  sessionId: string,
  suppressionId?: string | null,
  durationMs = MIRROR_SUPPRESSION_WINDOW_MS,
): void {
  settleMirrorSuppressionBase(
    getMirrorSuppressionStore(),
    sessionId,
    MIRROR_SUPPRESSION_CONFIG,
    suppressionId,
    durationMs,
  );
}

function isMirrorSuppressed(sessionId: string): boolean {
  return isMirrorSuppressedBase(getMirrorSuppressionStore(), sessionId);
}

function filterSuppressedMirrorRecords(
  sessionId: string,
  records: BridgeMirrorRecord[],
): BridgeMirrorRecord[] {
  return filterSuppressedMirrorRecordsBase(
    getMirrorSuppressionStore(),
    sessionId,
    records,
    MIRROR_SUPPRESSION_CONFIG,
  );
}

function syncMirrorSessionState(sessionId: string): void {
  const { store } = getBridgeContext();
  const session = store.getSession(sessionId);
  if (!session) return;

  const state = getState();
  const subscriptions = [
    ...Array.from(state.mirrorSubscriptions.values()),
    ...Array.from(state.claudeMirrorSubscriptions.values()),
    ...Array.from(state.kimiMirrorSubscriptions.values()),
    ...Array.from(state.cursorMirrorSubscriptions.values()),
    ...Array.from(state.zcodeMirrorSubscriptions.values()),
  ]
    .filter((item) => item.sessionId === sessionId);
  const mirrorStatus: BridgeSession['mirror_status'] = subscriptions.length === 0
    ? 'inactive'
    : subscriptions.some((item) => item.status === 'watching')
      ? 'watching'
      : subscriptions.some((item) => item.status === 'stale')
        ? 'stale'
        : 'inactive';

  const deliveredAt = subscriptions
    .map((item) => item.lastDeliveredAt)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1) || session.mirror_last_event_at;

  if (
    session.mirror_status === mirrorStatus
    && session.mirror_last_event_at === deliveredAt
  ) {
    return;
  }

  store.updateSession(sessionId, {
    mirror_status: mirrorStatus,
    mirror_last_event_at: deliveredAt,
  });
}

function syncMirrorSessionStateSafe(sessionId: string, context: string): void {
  try {
    syncMirrorSessionState(sessionId);
  } catch (error) {
    console.error(
      `[bridge-manager] Failed to sync mirror session state for ${sessionId} during ${context}:`,
      describeUnknownError(error),
    );
  }
}

function getMirrorStructuredStreamStatusConfig(): {
  idleStartMs: number;
  heartbeatMs: number;
} {
  const channelConfig = getGlobalDefaultChannelConfig();
  const idleStartSeconds = channelConfig?.streamStatusIdleStartSeconds;
  const heartbeatSeconds = channelConfig?.streamStatusCheckIntervalSeconds;
  return {
    idleStartMs: Math.max(
      0,
      (typeof idleStartSeconds === 'number' && Number.isFinite(idleStartSeconds) && idleStartSeconds >= 0
        ? idleStartSeconds
        : MIRROR_STREAM_STATUS_IDLE_START_MS / 1000) * 1000,
    ),
    heartbeatMs: Math.max(
      1_000,
      (typeof heartbeatSeconds === 'number' && Number.isFinite(heartbeatSeconds) && heartbeatSeconds > 0
        ? heartbeatSeconds
        : MIRROR_STREAM_STATUS_HEARTBEAT_MS / 1000) * 1000,
    ),
  };
}

function getMirrorThreadTitle(threadId: string, sessionId?: string): string | null {
  const { store } = getBridgeContext();
  const session = sessionId ? store.getSession(sessionId) : null;
  const codexSession = getCodexSessionByThreadIdSafe(threadId, 'mirror title');
  if (!session && !codexSession) return null;
  return new ThreadDisplayService(store).thread(threadId, sessionId, { stripInternalPrefix: true }).title;
}

function getMirrorRuntimeTags(_threadId: string, sessionId?: string): string[] {
  const { store } = getBridgeContext();
  const session = sessionId ? store.getSession(sessionId) : null;
  return buildRuntimeStreamTags(resolveRuntimeMetadataConfig(session));
}

function getMirrorAssistantLabel(_threadId: string, sessionId?: string): string {
  const { store } = getBridgeContext();
  const session = sessionId ? store.getSession(sessionId) : null;
  return getSessionActiveRuntime(session) || getGlobalRuntimeAgent();
}

const MIRROR_FEEDBACK = createMirrorFeedbackController({
  getAdapter: (channelType) => getState().adapters.get(channelType) || null,
  getThreadTitle: getMirrorThreadTitle,
  getRuntimeTags: getMirrorRuntimeTags,
  getAssistantLabel: getMirrorAssistantLabel,
  onMirrorTurnStarted: assignCodexTuiTurnScreenBaseline,
  resolveFinalizedTurnStatus: resolveCodexTuiFinalizedTurnStatus,
  getStructuredStreamStatusConfig: getMirrorStructuredStreamStatusConfig,
  nowIso,
  eventBatchLimit: MIRROR_EVENT_BATCH_LIMIT,
  deliverResponse,
  deliverManualInput: sendAgentMessageFromBinding,
});

function refreshMirrorStreamingStatus(
  subscription: BridgeMirrorSubscription,
  nowMs = Date.now(),
  config: MirrorStructuredStreamStatusConfig = getMirrorStructuredStreamStatusConfig(),
): void {
  MIRROR_FEEDBACK.refreshMirrorStreamingStatus(subscription, nowMs, config);
}

function refreshActiveMirrorStreamingStatuses(nowMs = Date.now()): void {
  const state = getState();
  for (const subscription of [
    ...Array.from(state.mirrorSubscriptions.values()),
    ...Array.from(state.claudeMirrorSubscriptions.values()),
    ...Array.from(state.kimiMirrorSubscriptions.values()),
    ...Array.from(state.cursorMirrorSubscriptions.values()),
    ...Array.from(state.zcodeMirrorSubscriptions.values()),
  ]) {
    refreshMirrorStreamingStatus(subscription, nowMs);
  }
}

function stopMirrorStreaming(
  subscription: BridgeMirrorSubscription,
  status: 'completed' | 'interrupted' = 'interrupted',
): void {
  MIRROR_FEEDBACK.stopMirrorStreaming(subscription, status);
}

async function deliverMirrorTurns(
  subscription: BridgeMirrorSubscription,
  turns: FinalizedBridgeMirrorTurn[],
): Promise<{ deliveredCount: number; error?: unknown }> {
  return MIRROR_FEEDBACK.deliverMirrorTurns(subscription, turns);
}

const MIRROR_TURN_HOOKS = MIRROR_FEEDBACK.hooks;

function consumeMirrorRecords(
  subscription: BridgeMirrorSubscription,
  records: BridgeMirrorRecord[],
): FinalizedBridgeMirrorTurn[] {
  return consumeMirrorRecordsBase(subscription, records, MIRROR_TURN_HOOKS);
}

function flushTimedOutMirrorTurn(
  subscription: BridgeMirrorSubscription,
  nowMs = Date.now(),
): FinalizedBridgeMirrorTurn | null {
  if (subscription.pendingTurn?.streamStarted) {
    return null;
  }
  return flushTimedOutMirrorTurnBase(subscription, MIRROR_TURN_BUFFER_TIMEOUT_MS, nowMs);
}

function hasPendingMirrorWork(subscription: BridgeMirrorSubscription): boolean {
  return hasPendingMirrorWorkBase(subscription);
}

function consumeBufferedMirrorTurns(
  subscription: BridgeMirrorSubscription,
  nowMs = Date.now(),
): FinalizedBridgeMirrorTurn[] {
  const timeoutMs = subscription.pendingTurn?.streamStarted
    ? Number.POSITIVE_INFINITY
    : MIRROR_TURN_BUFFER_TIMEOUT_MS;
  return consumeBufferedMirrorTurnsBase(subscription, timeoutMs, nowMs, MIRROR_TURN_HOOKS);
}

const MIRROR_RUNTIME = createMirrorRuntime(getState, {
  watchDebounceMs: MIRROR_WATCH_DEBOUNCE_MS,
  danglingThreadRetryLimit: DANGLING_MIRROR_THREAD_RETRY_LIMIT,
  failureSuspendThreshold: MIRROR_FAILURE_SUSPEND_THRESHOLD,
  failureSuspendMs: MIRROR_FAILURE_SUSPEND_MS,
  reconcileConcurrency: MIRROR_RECONCILE_CONCURRENCY,
  slowReconcileSubscriptionMs: MIRROR_SLOW_RECONCILE_SUBSCRIPTION_MS,
  activeBindingWindowMs: MIRROR_ACTIVE_BINDING_WINDOW_MS,
  coldReconcileIntervalMs: MIRROR_COLD_RECONCILE_INTERVAL_MS,
}, {
  nowIso,
  describeUnknownError,
  listChannelChats: () => getBridgeContext().store.listChannelChats(),
  getSession: (sessionId) => getBridgeContext().store.getSession(sessionId),
  clearSessionCodexThreadId: (sessionId) => {
    getBridgeContext().store.updateSessionCodexThreadId(sessionId, '');
  },
  getCodexSessionByThreadIdSafe,
  hasSessionMirrorSource: (session) => Boolean(
    getSessionActiveRuntime(session) !== 'claude'
    && getSessionActiveRuntime(session) !== 'kimi'
    && getSessionCodexThreadId(session)
    && getSessionCodexProviderOverride(session as BridgeSession | null | undefined) !== 'sdk',
  ),
  syncMirrorSessionStateSafe,
  filterSuppressedMirrorRecords,
  observeSessionHealthRecords: (sessionId, threadId, records) => {
    SESSION_HEALTH_RUNTIME.observeBridgeMirrorRecords(sessionId, threadId, records);
  },
  routeRuntimeRecords: (runtime, sessionId, threadId, records) => runtime === 'claude'
    ? routeRuntimeRecords(sessionId, 'claude', threadId, records, TURN_COORDINATOR)
    : routeCodexRecords(sessionId, threadId, records, TURN_COORDINATOR),
  consumeMirrorRecords,
  flushTimedOutMirrorTurn: (subscription) => flushTimedOutMirrorTurn(subscription),
  hasPendingMirrorWork,
  consumeBufferedMirrorTurns: (subscription) => consumeBufferedMirrorTurns(subscription),
  stopMirrorStreaming,
  deliverMirrorTurns,
});

const CLAUDE_MIRROR_RUNTIME = createMirrorRuntime(getClaudeMirrorState, {
  watchDebounceMs: MIRROR_WATCH_DEBOUNCE_MS,
  danglingThreadRetryLimit: DANGLING_MIRROR_THREAD_RETRY_LIMIT,
  failureSuspendThreshold: MIRROR_FAILURE_SUSPEND_THRESHOLD,
  failureSuspendMs: MIRROR_FAILURE_SUSPEND_MS,
  reconcileConcurrency: MIRROR_RECONCILE_CONCURRENCY,
  slowReconcileSubscriptionMs: MIRROR_SLOW_RECONCILE_SUBSCRIPTION_MS,
  activeBindingWindowMs: MIRROR_ACTIVE_BINDING_WINDOW_MS,
  coldReconcileIntervalMs: MIRROR_COLD_RECONCILE_INTERVAL_MS,
}, {
  mirrorSource: createClaudeMirrorJsonlSource(),
  runtimeLabel: 'Claude',
  nowIso,
  describeUnknownError,
  listChannelChats: () => getBridgeContext().store.listChannelChats(),
  getSession: (sessionId) => getBridgeContext().store.getSession(sessionId),
  clearSessionMirrorThreadId: (sessionId) => {
    getBridgeContext().store.updateSession(sessionId, setSessionClaudeIdentityUpdate(undefined, undefined));
  },
  clearSessionCodexThreadId: () => {},
  getCodexSessionByThreadIdSafe: () => null,
  hasSessionMirrorSource: (session) => Boolean(
    getSessionActiveRuntime(session) === 'claude'
    && getSessionClaudeSessionId(session)
    && (getSessionClaudeCwd(session) || getSessionWorkingDirectory(session)),
  ),
  getSessionMirrorThreadId: (session) => getSessionClaudeSessionId(session),
  getSessionMirrorCwd: (session) => getSessionClaudeCwd(session) || getSessionWorkingDirectory(session),
  getMirrorSourceSummary: (source, threadId, cwd) => source.findByThreadId(threadId, cwd || undefined),
  syncMirrorSessionStateSafe,
  filterSuppressedMirrorRecords,
  observeSessionHealthRecords: (sessionId, threadId, records) => {
    SESSION_HEALTH_RUNTIME.observeBridgeMirrorRecords(sessionId, threadId, records);
  },
  routeRuntimeRecords: (runtime, sessionId, threadId, records) => routeRuntimeRecords(
    sessionId,
    runtime,
    threadId,
    records,
    TURN_COORDINATOR,
  ),
  consumeMirrorRecords,
  flushTimedOutMirrorTurn: (subscription) => flushTimedOutMirrorTurn(subscription),
  hasPendingMirrorWork,
  consumeBufferedMirrorTurns: (subscription) => consumeBufferedMirrorTurns(subscription),
  stopMirrorStreaming,
  deliverMirrorTurns,
});

const KIMI_MIRROR_RUNTIME = createMirrorRuntime(getKimiMirrorState, {
  watchDebounceMs: MIRROR_WATCH_DEBOUNCE_MS,
  danglingThreadRetryLimit: DANGLING_MIRROR_THREAD_RETRY_LIMIT,
  failureSuspendThreshold: MIRROR_FAILURE_SUSPEND_THRESHOLD,
  failureSuspendMs: MIRROR_FAILURE_SUSPEND_MS,
  reconcileConcurrency: MIRROR_RECONCILE_CONCURRENCY,
  slowReconcileSubscriptionMs: MIRROR_SLOW_RECONCILE_SUBSCRIPTION_MS,
  activeBindingWindowMs: MIRROR_ACTIVE_BINDING_WINDOW_MS,
  coldReconcileIntervalMs: MIRROR_COLD_RECONCILE_INTERVAL_MS,
}, {
  mirrorSource: createKimiMirrorJsonlSource(),
  runtimeLabel: 'Kimi',
  nowIso,
  describeUnknownError,
  listChannelChats: () => getBridgeContext().store.listChannelChats(),
  getSession: (sessionId) => getBridgeContext().store.getSession(sessionId),
  clearSessionMirrorThreadId: (sessionId) => {
    getBridgeContext().store.updateSession(sessionId, setSessionKimiIdentityUpdate(undefined, undefined));
  },
  clearSessionCodexThreadId: () => {},
  getCodexSessionByThreadIdSafe: () => null,
  hasSessionMirrorSource: (session) => Boolean(
    getSessionActiveRuntime(session) === 'kimi'
    && getSessionKimiSessionId(session)
    && (getSessionKimiCwd(session) || getSessionWorkingDirectory(session)),
  ),
  getSessionMirrorThreadId: (session) => getSessionKimiSessionId(session),
  getSessionMirrorCwd: (session) => getSessionKimiCwd(session) || getSessionWorkingDirectory(session),
  getMirrorSourceSummary: (source, threadId, cwd) => source.findByThreadId(threadId, cwd || undefined),
  syncMirrorSessionStateSafe,
  filterSuppressedMirrorRecords,
  observeSessionHealthRecords: (sessionId, threadId, records) => {
    SESSION_HEALTH_RUNTIME.observeBridgeMirrorRecords(sessionId, threadId, records);
  },
  routeRuntimeRecords: (runtime, sessionId, threadId, records) => routeRuntimeRecords(
    sessionId,
    runtime,
    threadId,
    records,
    TURN_COORDINATOR,
  ),
  consumeMirrorRecords,
  flushTimedOutMirrorTurn: (subscription) => flushTimedOutMirrorTurn(subscription),
  hasPendingMirrorWork,
  consumeBufferedMirrorTurns: (subscription) => consumeBufferedMirrorTurns(subscription),
  stopMirrorStreaming,
  deliverMirrorTurns,
});

const CURSOR_MIRROR_RUNTIME = createMirrorRuntime(getCursorMirrorState, {
  watchDebounceMs: MIRROR_WATCH_DEBOUNCE_MS,
  danglingThreadRetryLimit: DANGLING_MIRROR_THREAD_RETRY_LIMIT,
  failureSuspendThreshold: MIRROR_FAILURE_SUSPEND_THRESHOLD,
  failureSuspendMs: MIRROR_FAILURE_SUSPEND_MS,
  reconcileConcurrency: MIRROR_RECONCILE_CONCURRENCY,
  slowReconcileSubscriptionMs: MIRROR_SLOW_RECONCILE_SUBSCRIPTION_MS,
  activeBindingWindowMs: MIRROR_ACTIVE_BINDING_WINDOW_MS,
  coldReconcileIntervalMs: MIRROR_COLD_RECONCILE_INTERVAL_MS,
}, {
  mirrorSource: createCursorMirrorJsonlSource(),
  runtimeLabel: 'Cursor',
  nowIso,
  describeUnknownError,
  listChannelChats: () => getBridgeContext().store.listChannelChats(),
  getSession: (sessionId) => getBridgeContext().store.getSession(sessionId),
  clearSessionMirrorThreadId: (sessionId) => {
    getBridgeContext().store.updateSession(sessionId, setSessionCursorIdentityUpdate(undefined, undefined));
  },
  clearSessionCodexThreadId: () => {},
  getCodexSessionByThreadIdSafe: () => null,
  hasSessionMirrorSource: (session) => Boolean(
    getSessionActiveRuntime(session) === 'cursor'
    && getSessionCursorSessionId(session)
    && (getSessionCursorCwd(session) || getSessionWorkingDirectory(session)),
  ),
  getSessionMirrorThreadId: (session) => getSessionCursorSessionId(session),
  getSessionMirrorCwd: (session) => getSessionCursorCwd(session) || getSessionWorkingDirectory(session),
  getMirrorSourceSummary: (source, threadId, cwd) => source.findByThreadId(threadId, cwd || undefined),
  syncMirrorSessionStateSafe,
  filterSuppressedMirrorRecords,
  observeSessionHealthRecords: (sessionId, threadId, records) => {
    SESSION_HEALTH_RUNTIME.observeBridgeMirrorRecords(sessionId, threadId, records);
  },
  routeRuntimeRecords: (runtime, sessionId, threadId, records) => routeRuntimeRecords(
    sessionId,
    runtime,
    threadId,
    records,
    TURN_COORDINATOR,
  ),
  consumeMirrorRecords,
  flushTimedOutMirrorTurn: (subscription) => flushTimedOutMirrorTurn(subscription),
  hasPendingMirrorWork,
  consumeBufferedMirrorTurns: (subscription) => consumeBufferedMirrorTurns(subscription),
  stopMirrorStreaming,
  deliverMirrorTurns,
});

const ZCODE_MIRROR_RUNTIME = createMirrorRuntime(getZcodeMirrorState, {
  watchDebounceMs: MIRROR_WATCH_DEBOUNCE_MS,
  danglingThreadRetryLimit: DANGLING_MIRROR_THREAD_RETRY_LIMIT,
  failureSuspendThreshold: MIRROR_FAILURE_SUSPEND_THRESHOLD,
  failureSuspendMs: MIRROR_FAILURE_SUSPEND_MS,
  reconcileConcurrency: MIRROR_RECONCILE_CONCURRENCY,
  slowReconcileSubscriptionMs: MIRROR_SLOW_RECONCILE_SUBSCRIPTION_MS,
  activeBindingWindowMs: MIRROR_ACTIVE_BINDING_WINDOW_MS,
  coldReconcileIntervalMs: MIRROR_COLD_RECONCILE_INTERVAL_MS,
}, {
  mirrorSource: createZcodeMirrorSqliteSource(),
  runtimeLabel: 'ZCode',
  nowIso,
  describeUnknownError,
  listChannelChats: () => getBridgeContext().store.listChannelChats(),
  getSession: (sessionId) => getBridgeContext().store.getSession(sessionId),
  clearSessionMirrorThreadId: (sessionId) => {
    getBridgeContext().store.updateSession(sessionId, setSessionZcodeIdentityUpdate(undefined, undefined));
  },
  clearSessionCodexThreadId: () => {},
  getCodexSessionByThreadIdSafe: () => null,
  hasSessionMirrorSource: (session) => {
    if (getSessionActiveRuntime(session) !== 'zcode') return false;
    const sessionId = getSessionZcodeSessionId(session);
    const cwd = getSessionZcodeCwd(session) || getSessionWorkingDirectory(session);
    return Boolean(
      sessionId
      && cwd
      && findZcodeSessionById(sessionId, cwd, { includeArchived: true }),
    );
  },
  getSessionMirrorThreadId: (session) => getSessionZcodeSessionId(session),
  getSessionMirrorCwd: (session) => getSessionZcodeCwd(session) || getSessionWorkingDirectory(session),
  getMirrorSourceSummary: (source, threadId, cwd) => source.findByThreadId(threadId, cwd || undefined),
  syncMirrorSessionStateSafe,
  filterSuppressedMirrorRecords,
  observeSessionHealthRecords: (sessionId, threadId, records) => {
    SESSION_HEALTH_RUNTIME.observeBridgeMirrorRecords(sessionId, threadId, records);
  },
  routeRuntimeRecords: (runtime, sessionId, threadId, records) => routeRuntimeRecords(
    sessionId,
    runtime,
    threadId,
    records,
    TURN_COORDINATOR,
  ),
  consumeMirrorRecords,
  flushTimedOutMirrorTurn: (subscription) => flushTimedOutMirrorTurn(subscription),
  hasPendingMirrorWork,
  consumeBufferedMirrorTurns: (subscription) => consumeBufferedMirrorTurns(subscription),
  stopMirrorStreaming,
  deliverMirrorTurns,
});

function resetMirrorSessionForInteractiveRun(sessionId: string): void {
  MIRROR_RUNTIME.resetMirrorSessionForInteractiveRun(sessionId);
  CLAUDE_MIRROR_RUNTIME.resetMirrorSessionForInteractiveRun(sessionId);
  KIMI_MIRROR_RUNTIME.resetMirrorSessionForInteractiveRun(sessionId);
  CURSOR_MIRROR_RUNTIME.resetMirrorSessionForInteractiveRun(sessionId);
  ZCODE_MIRROR_RUNTIME.resetMirrorSessionForInteractiveRun(sessionId);
}

async function reconcileMirrorSubscriptions(): Promise<void> {
  await MIRROR_RUNTIME.reconcileMirrorSubscriptions();
  await CLAUDE_MIRROR_RUNTIME.reconcileMirrorSubscriptions();
  await KIMI_MIRROR_RUNTIME.reconcileMirrorSubscriptions();
  await CURSOR_MIRROR_RUNTIME.reconcileMirrorSubscriptions();
  await ZCODE_MIRROR_RUNTIME.reconcileMirrorSubscriptions();
  await ensureCodexTuiIdleScreenCheckpoints();
  const nowMs = Date.now();
  await Promise.allSettled(
    [
      ...Array.from(getState().mirrorSubscriptions.values()),
      ...Array.from(getState().claudeMirrorSubscriptions.values()),
      ...Array.from(getState().cursorMirrorSubscriptions.values()),
    ].map((subscription) =>
      probeMirrorTmuxSelectionPrompt(subscription, nowMs),
    ),
  );
  refreshActiveMirrorStreamingStatuses();
}

function clearMirrorSubscriptions(): void {
  MIRROR_RUNTIME.clearMirrorSubscriptions();
  CLAUDE_MIRROR_RUNTIME.clearMirrorSubscriptions();
  KIMI_MIRROR_RUNTIME.clearMirrorSubscriptions();
  CURSOR_MIRROR_RUNTIME.clearMirrorSubscriptions();
  ZCODE_MIRROR_RUNTIME.clearMirrorSubscriptions();
}

function shouldRouteTerminalAppendInline(msg: InboundMessage): boolean {
  const rawText = msg.text.trim();
  if (!rawText || msg.channelEvent || msg.callbackData || isBridgeCommandText(rawText)) return false;
  if (isPendingAttachmentConfirmationReply(msg.address, rawText)) return true;
  if (msg.attachments && msg.attachments.length > 0) return false;
  const binding = getBridgeContext().store.getChannelChat(msg.address.channelType, msg.address.chatId);
  if (!binding || !INTERACTIVE_RUNTIME.getActiveTask(binding.bridgeSessionId)) return false;
  const session = getBridgeContext().store.getSession(binding.bridgeSessionId);
  if (!session) return false;
  const runtimeProvider = resolveEffectiveRuntimeProvider(session, binding);
  return runtimeProvider.provider === 'tmux' || runtimeProvider.provider === 'pty';
}

function resolveInboundCommandText(rawText: string): string {
  const trimmed = rawText.trim();
  const commandToken = trimmed.split(/\s+/)[0] || '';
  const rawCommand = commandToken.split('@')[0].toLowerCase();
  const args = trimmed.slice(commandToken.length).trim();
  return resolveCommandAlias(rawCommand, args);
}

function isHighPriorityControlCommandText(rawText: string): boolean {
  const resolvedCommand = resolveInboundCommandText(rawText);
  if (resolvedCommand === '/stop') return true;
  const args = rawText.trim().slice((rawText.trim().split(/\s+/)[0] || '').length).trim();
  return (
    (resolvedCommand === '/tmux-screen' || resolvedCommand === '/pty-screen')
    && args.split(/\s+/)[0]?.toLowerCase() === 'stop'
  );
}

function isHighPriorityControlCallback(callbackData: string): boolean {
  if (
    callbackData.startsWith('perm:')
    || callbackData.startsWith('codex-tui-selection-choice:')
    || callbackData.startsWith('codex-update-choice:')
    || callbackData.startsWith(TMUX_SCREEN_STOP_CALLBACK_PREFIX)
    || callbackData.startsWith(PTY_SCREEN_STOP_CALLBACK_PREFIX)
  ) {
    return true;
  }

  const commandCallback = parseCommandCallbackData(callbackData);
  return Boolean(commandCallback && isHighPriorityControlCommandText(commandCallback.commandText));
}

function isReadOnlyOrLongIoCommandText(rawText: string): boolean {
  const resolvedCommand = resolveInboundCommandText(rawText);
  return resolvedCommand === '/tmux-screen'
    || resolvedCommand === '/pty-screen'
    || resolvedCommand === '/shell'
    || resolvedCommand === '/new';
}

function splitInboundCommandText(rawText: string): { resolvedCommand: string; args: string } {
  const trimmed = rawText.trim();
  const commandToken = trimmed.split(/\s+/)[0] || '';
  const rawCommand = commandToken.split('@')[0].toLowerCase();
  const args = trimmed.slice(commandToken.length).trim();
  return {
    resolvedCommand: resolveCommandAlias(rawCommand, args),
    args,
  };
}

function sessionMutatingCommandLane(rawText: string): { jobKind: string; blocksConversation: boolean } | null {
  const { resolvedCommand, args } = splitInboundCommandText(rawText);
  if (SESSION_CONFIG_BARRIER_COMMANDS.has(resolvedCommand)) {
    return {
      jobKind: `command:${resolvedCommand.slice(1)}`,
      blocksConversation: true,
    };
  }

  if (resolvedCommand === '/thread') {
    return { jobKind: 'command:thread', blocksConversation: true };
  }

  if (resolvedCommand === '/t') {
    const subcommand = args.split(/\s+/).filter(Boolean)[0]?.toLowerCase() || '';
    if (subcommand === 'archive' || subcommand === 'rename' || subcommand === 'unbind') {
      return { jobKind: `command:t:${subcommand}`, blocksConversation: true };
    }
    return null;
  }

  if (SESSION_SERIAL_COMMANDS.has(resolvedCommand)) {
    return {
      jobKind: `command:${resolvedCommand.slice(1)}`,
      blocksConversation: false,
    };
  }

  return null;
}

function sessionMutatingCallbackLane(callbackData: string): { jobKind: string; scopeSessionId: string | null; blocksConversation: boolean } | null {
  const commandCallback = parseCommandCallbackData(callbackData);
  if (commandCallback) {
    const lane = sessionMutatingCommandLane(commandCallback.commandText);
    return lane ? { ...lane, scopeSessionId: commandCallback.scopeSessionId } : null;
  }

  if (callbackData.startsWith(THREAD_SELECT_ACTION_CALLBACK_PREFIX)) {
    const raw = callbackData.slice(THREAD_SELECT_ACTION_CALLBACK_PREFIX.length).trim();
    const parts = raw.split(':').filter(Boolean);
    const action = parts.length === 2 ? parts[1] : parts[0];
    if (action === 'switch' || action === 'archive') {
      return {
        jobKind: `command:t:${action}`,
        scopeSessionId: null,
        blocksConversation: true,
      };
    }
  }

  return null;
}

function adapterImmediateLane(msg: InboundMessage, category: 'channel-event' | 'callback' | 'command' | 'bypass' | 'regular'): AdapterImmediateLane | null {
  if (category === 'channel-event') {
    return {
      laneKey: `control:${msg.address.channelType}:${msg.address.chatId}:${msg.messageId || msg.updateId || 'event'}`,
      laneKind: 'control',
      jobKind: `control:${category}`,
    };
  }
  if (category === 'callback' && msg.callbackData && isHighPriorityControlCallback(msg.callbackData)) {
    return {
      laneKey: `control:${msg.address.channelType}:${msg.address.chatId}:${msg.messageId || msg.callbackMessageId || 'callback'}`,
      laneKind: 'control',
      jobKind: 'control:callback',
    };
  }
  if (category === 'command' && isHighPriorityControlCommandText(msg.text)) {
    return {
      laneKey: `control:${msg.address.channelType}:${msg.address.chatId}:${msg.messageId || 'command'}`,
      laneKind: 'control',
      jobKind: 'control:command',
    };
  }
  const attachmentCommandText = category === 'command'
    ? msg.text
    : category === 'callback' && msg.callbackData
      ? parseCommandCallbackData(msg.callbackData)?.commandText
      : undefined;
  const isThreadAttachment = attachmentCommandText
    ? resolveInboundCommandText(attachmentCommandText) === '/thread'
    : category === 'callback'
      && Boolean(msg.callbackData?.startsWith(THREAD_SELECT_ACTION_CALLBACK_PREFIX))
      && msg.callbackData?.split(':').at(-1) === 'switch';
  if (isThreadAttachment) {
    return {
      laneKey: `job:thread-attach:${msg.address.channelType}:${msg.address.chatId}`,
      laneKind: 'job',
      jobKind: 'command:thread-attach',
      waitForConversationBarrier: false,
      blocksConversation: true,
      serialize: true,
      blocksRouting: true,
    };
  }
  const immediateJobCommandText = category === 'command'
    ? msg.text
    : category === 'callback' && msg.callbackData
      ? parseCommandCallbackData(msg.callbackData)?.commandText
      : undefined;
  if (immediateJobCommandText) {
    const { resolvedCommand, args } = splitInboundCommandText(immediateJobCommandText);
    if (resolvedCommand === '/provider' && args.split(/\s+/)[0]?.toLowerCase() === 'tmux') {
      return {
        laneKey: `job:provider-tmux:${msg.address.channelType}:${msg.address.chatId}`,
        laneKind: 'job',
        jobKind: 'command:provider-tmux',
        waitForConversationBarrier: false,
        blocksConversation: false,
        serialize: true,
        blocksRouting: true,
      };
    }
  }
  if (immediateJobCommandText && isReadOnlyOrLongIoCommandText(immediateJobCommandText)) {
    const resolvedCommand = resolveInboundCommandText(immediateJobCommandText);
    const isScreenMonitor = resolvedCommand === '/tmux-screen' || resolvedCommand === '/pty-screen';
    const blocksConversation = !isScreenMonitor && resolvedCommand !== '/new';
    return {
      laneKey: `job:${resolvedCommand.slice(1)}:${msg.address.channelType}:${msg.address.chatId}:${msg.messageId || 'command'}`,
      laneKind: 'job',
      jobKind: `command:${resolvedCommand.slice(1)}`,
      waitForConversationBarrier: !isScreenMonitor,
      blocksConversation,
    };
  }
  return null;
}

function adapterSessionLane(msg: InboundMessage, category: 'channel-event' | 'callback' | 'command' | 'bypass' | 'regular'): { sessionId: string; jobKind: string; blocksConversation?: boolean } | null {
  if (category === 'regular') {
    const binding = getBridgeContext().store.getChannelChat(msg.address.channelType, msg.address.chatId);
    if (!binding) return null;
    const session = getBridgeContext().store.getSession(binding.bridgeSessionId);
    if (!session) return null;
    const runtimeProvider = resolveEffectiveRuntimeProvider(session, binding);
    if (runtimeProvider.provider !== 'tmux') return null;
    return {
      sessionId: binding.bridgeSessionId,
      jobKind: 'interactive-turn:tmux-provider-auto-forward',
      blocksConversation: true,
    };
  }

  if (category === 'command') {
    const { resolvedCommand, args } = splitInboundCommandText(msg.text);
    if (resolvedCommand === '/provider' && args.split(/\s+/)[0]?.toLowerCase() === 'tmux') return null;
    const lane = sessionMutatingCommandLane(msg.text);
    if (!lane) return null;
    const binding = getBridgeContext().store.getChannelChat(msg.address.channelType, msg.address.chatId);
    if (!binding) return null;
    return { sessionId: binding.bridgeSessionId, jobKind: lane.jobKind, blocksConversation: lane.blocksConversation };
  }

  if (category === 'callback' && msg.callbackData) {
    const callbackCommand = parseCommandCallbackData(msg.callbackData)?.commandText;
    if (callbackCommand) {
      const { resolvedCommand, args } = splitInboundCommandText(callbackCommand);
      if (resolvedCommand === '/provider' && args.split(/\s+/)[0]?.toLowerCase() === 'tmux') return null;
    }
    const lane = sessionMutatingCallbackLane(msg.callbackData);
    if (!lane) return null;
    if (lane.scopeSessionId) {
      return { sessionId: lane.scopeSessionId, jobKind: lane.jobKind, blocksConversation: lane.blocksConversation };
    }
    const binding = getBridgeContext().store.getChannelChat(msg.address.channelType, msg.address.chatId);
    if (!binding) return null;
    return { sessionId: binding.bridgeSessionId, jobKind: lane.jobKind, blocksConversation: lane.blocksConversation };
  }

  return null;
}

const ADAPTER_RUNTIME = createAdapterRuntime(getState, {
  notifyAdapterSetChanged: (channelTypes) => {
    const { lifecycle } = getBridgeContext();
    lifecycle.onBridgeAdaptersChanged?.(channelTypes);
  },
  handleMessage,
  processWithSessionLock: (sessionId, fn, options) => INTERACTIVE_RUNTIME.processWithSessionLock(sessionId, fn, options),
  isCommandMessage: (msg) => isBridgeCommandText(msg.text),
  resolveSessionIdForMessage: (msg) => router.resolve(msg.address).bridgeSessionId,
  shouldBypassSessionLock: shouldRouteTerminalAppendInline,
  getImmediateLane: adapterImmediateLane,
  getSessionLane: adapterSessionLane,
});

/**
 * Start the bridge system.
 * Checks feature flags, registers enabled adapters, starts polling loops.
 */
export async function start(): Promise<void> {
  const state = getState();
  if (state.running) return;

  const { store, lifecycle } = getBridgeContext();

  const bridgeEnabled = store.getSetting('remote_bridge_enabled') === 'true';
  if (!bridgeEnabled) {
    console.log('[bridge-manager] Bridge not enabled (remote_bridge_enabled != true)');
    return;
  }

  INTERACTIVE_RUNTIME.resetPersistedInteractiveRuntimeState();
  await ADAPTER_RUNTIME.syncConfiguredAdapters({ startLoops: false });
  const startedCount = state.adapters.size;

  // Only mark as running if at least one adapter started successfully
  if (startedCount === 0) {
    console.warn('[bridge-manager] No adapters started successfully, bridge not activated');
    state.adapters.clear();
    state.adapterMeta.clear();
    return;
  }

  if (!state.dailyVersionUpdateRuntime) {
    const currentVersion = resolveInstalledCodelarkVersion();
    state.dailyVersionUpdateRuntime = createDailyVersionUpdateRuntime({
      currentVersion,
      checker: createDailyVersionChecker({ currentVersion }),
    });
  }

  // Mark running BEFORE starting consumer loops — runAdapterLoop checks
  // state.running in its while-condition, so it must be true first.
  state.running = true;
  state.startedAt = new Date().toISOString();

  // Notify host that bridge is starting (e.g., suppress competing polling)
  lifecycle.onBridgeStart?.();

  // Now start the consumer loops (state.running is already true)
  for (const [, adapter] of state.adapters) {
    if (adapter.isRunning()) {
      ADAPTER_RUNTIME.runAdapterLoop(adapter);
    }
  }

  state.reconcileTimer = setInterval(() => {
    void ADAPTER_RUNTIME.syncConfiguredAdapters({ startLoops: true }).catch((err) => {
      console.error('[bridge-manager] Adapter reconcile failed:', err);
    });
    try {
      SESSION_HEALTH_RUNTIME.reconcileSessionHealth();
    } catch (err) {
      console.error('[bridge-manager] Session health reconcile failed:', describeUnknownError(err));
    }
    void INTERACTIVE_RUNTIME.reconcileTerminalSessionRuntimeState().catch((err) => {
      console.error('[bridge-manager] Terminal interactive reconcile failed:', describeUnknownError(err));
    });
  }, 5_000);

  state.mirrorPollTimer = setInterval(() => {
    void reconcileMirrorSubscriptions().catch((err) => {
      console.error('[bridge-manager] Mirror reconcile failed:', describeUnknownError(err));
    });
  }, MIRROR_POLL_INTERVAL_MS);
  void reconcileMirrorSubscriptions().catch((err) => {
    console.error('[bridge-manager] Initial mirror reconcile failed:', describeUnknownError(err));
  });
  startPersistedEveryTasks();
  startPersistedThenTasks();
  startPersistedConditionMonitors();

  console.log(`[bridge-manager] Bridge started with ${startedCount} adapter(s)`);
  void runStartupNotificationFlow().catch((err) => {
    console.error('[bridge-manager] Startup notification failed:', describeUnknownError(err));
  });
}

/**
 * Stop the bridge system gracefully.
 */
export async function stop(): Promise<void> {
  const state = getState();
  if (!state.running) return;

  const { lifecycle } = getBridgeContext();

  state.running = false;

  if (state.reconcileTimer) {
    clearInterval(state.reconcileTimer);
    state.reconcileTimer = null;
  }
  if (state.mirrorPollTimer) {
    clearInterval(state.mirrorPollTimer);
    state.mirrorPollTimer = null;
  }
  if (state.mirrorWakeTimer) {
    clearTimeout(state.mirrorWakeTimer);
    state.mirrorWakeTimer = null;
  }
  if (state.claudeMirrorWakeTimer) {
    clearTimeout(state.claudeMirrorWakeTimer);
    state.claudeMirrorWakeTimer = null;
  }

  // Abort all event loops
  for (const [, abort] of state.loopAborts) {
    abort.abort();
  }
  state.loopAborts.clear();

  const activeSessionIds = Array.from(state.activeTasks.keys());
  const queuedSessionIds = Array.from(state.queuedCounts.keys());
  for (const task of state.activeTasks.values()) {
    task.abortController.abort();
  }
  state.activeTasks.clear();
  stopAllEveryTasks();
  stopAllConditionMonitors();
  stopAllThenTasks();
  state.mirrorSuppressUntil.clear();
  state.mirrorIgnoredTurnIds.clear();
  INTERACTIVE_RUNTIME.resetSessionExecutor();
  state.invalidAdapters.clear();
  ADAPTER_RUNTIME.clearWarningCache();
  for (const sessionId of new Set([...activeSessionIds, ...queuedSessionIds])) {
    INTERACTIVE_RUNTIME.syncSessionRuntimeState(sessionId);
  }
  clearMirrorSubscriptions();

  // Stop all adapters
  for (const type of Array.from(state.adapters.keys())) {
    await ADAPTER_RUNTIME.stopAdapterInstance(type);
  }

  state.startedAt = null;

  // Notify host that bridge stopped
  lifecycle.onBridgeStop?.();

  console.log('[bridge-manager] Bridge stopped');
}

/**
 * Lazy auto-start: checks bridge_auto_start setting once and starts if enabled.
 * Called from POST /api/bridge with action 'auto-start' (triggered by Electron on startup).
 */
export function tryAutoStart(): void {
  const state = getState();
  if (state.autoStartChecked) return;
  state.autoStartChecked = true;

  if (state.running) return;

  const { store } = getBridgeContext();
  const autoStart = store.getSetting('bridge_auto_start');
  if (autoStart !== 'true') return;

  start().catch(err => {
    console.error('[bridge-manager] Auto-start failed:', err);
  });
}

/**
 * Get the current bridge status.
 */
export function getStatus(): BridgeStatus {
  const state = getState();
  return {
    running: state.running,
    startedAt: state.startedAt,
    adapters: Array.from(state.adapters.entries()).map(([type, adapter]) => {
      const meta = state.adapterMeta.get(type);
      return {
        channelType: adapter.channelType,
        channelProvider: adapter.provider,
        channelAlias: adapter.alias,
        running: adapter.isRunning(),
        connectedAt: state.startedAt,
        lastMessageAt: meta?.lastMessageAt ?? null,
        error: meta?.lastError ?? null,
      };
    }),
  };
}

async function reconcileStartupChannelChats(): Promise<StartupChannelChatCheckResult> {
  const state = getState();
  const { store } = getBridgeContext();
  const display = new ThreadDisplayService(store);
  const candidates: StartupChannelChatCheckCandidate[] = [];

  for (const binding of store.listChannelChats()) {
    const adapter = state.adapters.get(binding.channelType);
    if (!adapter?.isRunning() || !adapter.getGroupChatInfo) continue;
    if (binding.chatId.startsWith('doc:')) continue;
    if (binding.chatKind === 'p2p') continue;

    const session = store.getSession(binding.bridgeSessionId);
    const title = session ? display.binding(binding).title : binding.bridgeSessionId.slice(0, 8);
    candidates.push({
      binding,
      adapter: adapter as StartupChannelChatCheckAdapter,
      title,
    });
  }

  const checks = await mapWithConcurrency(
    candidates,
    STARTUP_CHANNEL_CHAT_CHECK_CONCURRENCY,
    checkStartupChannelChatCandidate,
  );
  const archivedMissingChats = checks.flatMap((check) => check.archivedMissingChat ? [check.archivedMissingChat] : []);
  const checkErrors = checks.flatMap((check) => check.checkError ? [check.checkError] : []);

  if (archivedMissingChats.length > 0 || checkErrors.length > 0) {
    void reconcileMirrorSubscriptions().catch((err) => {
      console.error('[bridge-manager] Mirror reconcile after startup channel chat check failed:', describeUnknownError(err));
    });
  }

  for (const issue of archivedMissingChats) {
    console.warn(`[bridge-manager] Archived missing channel chat on startup: ${formatStartupChannelChatIssue(issue)}`);
  }
  for (const issue of checkErrors) {
    console.warn(`[bridge-manager] Failed to check channel chat on startup: ${formatStartupChannelChatIssue(issue)}`);
  }

  return { archivedMissingChats, checkErrors };
}

function hasStartupChannelChatCheckIssues(result: StartupChannelChatCheckResult): boolean {
  return result.archivedMissingChats.length > 0 || result.checkErrors.length > 0;
}

async function runStartupNotificationFlow(options: {
  channelChatCheckNoticeBudgetMs?: number;
} = {}): Promise<void> {
  const startedAt = Date.now();
  const budgetMs = options.channelChatCheckNoticeBudgetMs ?? STARTUP_CHANNEL_CHAT_CHECK_NOTICE_BUDGET_MS;
  const checkPromise = reconcileStartupChannelChats();
  let channelChatCheck: StartupChannelChatCheckResult = {
    archivedMissingChats: [],
    checkErrors: [],
  };
  let deferredCheck = false;

  if (budgetMs > 0) {
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<typeof STARTUP_CHANNEL_CHAT_CHECK_TIMEOUT>((resolve) => {
      timeoutHandle = setTimeout(() => resolve(STARTUP_CHANNEL_CHAT_CHECK_TIMEOUT), budgetMs);
    });
    const result = await Promise.race([
      checkPromise,
      timeoutPromise,
    ]).finally(() => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    });
    if (result === STARTUP_CHANNEL_CHAT_CHECK_TIMEOUT) {
      deferredCheck = true;
      console.warn('[bridge-manager] Startup channel chat check deferred past notice budget:', {
        event: 'perf.startup.channel_chat_check',
        status: 'deferred',
        duration_ms: Math.max(0, Date.now() - startedAt),
        budget_ms: budgetMs,
      });
    } else {
      channelChatCheck = result;
    }
  } else {
    channelChatCheck = await checkPromise;
  }

  await deliverStartupNotifications(channelChatCheck);

  if (!deferredCheck) return;
  void checkPromise.then(async (lateResult) => {
    console.warn('[bridge-manager] Startup channel chat check completed after notice:', {
      event: 'perf.startup.channel_chat_check',
      status: 'completed_after_notice',
      duration_ms: Math.max(0, Date.now() - startedAt),
      archived_missing_chats: lateResult.archivedMissingChats.length,
      check_errors: lateResult.checkErrors.length,
    });
    if (hasStartupChannelChatCheckIssues(lateResult)) {
      await deliverStartupNotifications(lateResult);
    }
  }).catch((err) => {
    console.error('[bridge-manager] Deferred startup channel chat check failed:', describeUnknownError(err));
  });
}

async function checkStartupChannelChatCandidate(
  candidate: StartupChannelChatCheckCandidate,
): Promise<{
  archivedMissingChat?: StartupChannelChatCheckIssue;
  checkError?: StartupChannelChatCheckIssue;
}> {
  const { store } = getBridgeContext();
  const { adapter, binding, title } = candidate;
  if (!adapter.isRunning()) return {};

  try {
    const info = await adapter.getGroupChatInfo(binding.chatId);
    if (info) {
      if (!binding.chatKind || binding.chatKind !== info.chatKind) {
        store.updateChannelChat(binding.id, { chatKind: info.chatKind });
      }
      return {};
    }

    const bindingsBeforeArchive = store.listChannelChats()
      .filter((candidateBinding) => candidateBinding.bridgeSessionId === binding.bridgeSessionId);
    const archived = await archiveLifecycleBindingSession(store, binding);
    const detail = formatLifecycleArchiveDetail(archived);
    for (const removed of bindingsBeforeArchive.length > 0 ? bindingsBeforeArchive : [binding]) {
      handleBindingRemovedForAutomationTasks(removed);
    }
    return {
      archivedMissingChat: {
        channelType: binding.channelType,
        channelAlias: binding.channelAlias,
        chatId: binding.chatId,
        title,
        bridgeSessionId: binding.bridgeSessionId,
        detail,
      },
    };
  } catch (error) {
    return {
      checkError: {
        channelType: binding.channelType,
        channelAlias: binding.channelAlias,
        chatId: binding.chatId,
        title,
        bridgeSessionId: binding.bridgeSessionId,
        detail: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];

  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  await Promise.all(Array.from({ length: limit }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }));

  return results;
}

async function deliverStartupNotifications(channelChatCheck: StartupChannelChatCheckResult = {
  archivedMissingChats: [],
  checkErrors: [],
}): Promise<void> {
  const state = getState();
  const { store } = getBridgeContext();
  const target = selectStartupNoticeTarget(state, store);
  if (!target) {
    console.warn('[bridge-manager] Startup notification skipped: no hot-update target or running p2p ChannelChat target');
    return;
  }

  const adapter = state.adapters.get(target.address.channelType);
  if (!adapter?.isRunning()) return;

  if (target.operation?.kind === 'version-update') {
    const operation = target.operation;
    const richCard = buildVersionUpdateCompletedCard(
      target.address.chatId,
      operation.version,
      operation.updateKey,
    );
    try {
      await deliverBridgeNotice(
        adapter,
        target.address,
        `CodeLark v${operation.version} 更新完成，Bridge 已重启并恢复在线。`,
        {
          sessionId: target.binding?.bridgeSessionId || target.sessionId,
          audit: false,
          richCard,
          richCardUpdateMessageId: operation.updateMessageId,
        },
      );
    } catch (err) {
      console.error('[bridge-manager] Failed to deliver version update completion:', {
        channel_type: target.address.channelType,
        chat_id: target.address.chatId,
        version: operation.version,
        error: describeUnknownError(err),
      });
    }
    return;
  }

  const feishuSetupNotices = collectStartupFeishuSetupNotices(state);
  logStartupFeishuSetupNotices(feishuSetupNotices);
  const baseStatusText = buildGlobalStatusResponse(store, target.binding, true);
  const statusText = buildStartupNoticeStatusText(
    baseStatusText,
    channelChatCheck,
    feishuSetupNotices,
  );
  const text = `${STARTUP_NOTICE_TITLE}\n\n${statusText}`;
  const richCard = buildStartupNoticeRichCard(baseStatusText, channelChatCheck, feishuSetupNotices);
  try {
    await deliverBridgeNotice(
      adapter,
      target.address,
      text,
      {
        sessionId: target.binding?.bridgeSessionId || target.sessionId,
        audit: false,
        richCard,
      },
    );
  } catch (err) {
    console.error('[bridge-manager] Failed to send startup notification:', {
      channel_type: target.address.channelType,
      chat_id: target.address.chatId,
      error: describeUnknownError(err),
    });
  }
}

function selectStartupNoticeTarget(
  state: BridgeManagerState,
  store: ReturnType<typeof getBridgeContext>['store'],
): StartupNoticeTarget | null {
  const explicitTarget = consumeStartupNoticeTarget();
  if (explicitTarget && state.adapters.get(explicitTarget.address.channelType)?.isRunning()) {
    return {
      address: explicitTarget.address,
      binding: store.getChannelChat(explicitTarget.address.channelType, explicitTarget.address.chatId),
      sessionId: explicitTarget.sessionId,
      operation: explicitTarget.operation,
    };
  }

  const binding = store.listChannelChats()
    .filter((binding) => binding.chatKind === 'p2p')
    .filter((binding) => state.adapters.get(binding.channelType)?.isRunning())
    .sort((a, b) => channelChatUpdatedTime(b) - channelChatUpdatedTime(a))[0] || null;
  return binding
    ? { address: channelAddressFromBinding(binding), binding, sessionId: binding.bridgeSessionId }
    : null;
}

function buildStartupNoticeStatusText(
  statusText: string,
  channelChatCheck: StartupChannelChatCheckResult,
  feishuSetupNotices: StartupFeishuSetupNotice[] = [],
): string {
  const sections = [statusText];
  if (feishuSetupNotices.length > 0) {
    sections.push([
      '飞书配置检查：请确认以下事件和回调已经添加、发布并通过审批。',
      ...feishuSetupNotices.map(formatStartupFeishuSetupNotice),
    ].join('\n'));
  }
  if (channelChatCheck.archivedMissingChats.length > 0) {
    sections.push([
      `启动检查：${formatArchivedMissingChatsNote(channelChatCheck.archivedMissingChats.length)}`,
      ...channelChatCheck.archivedMissingChats.map(formatStartupChannelChatIssue),
    ].join('\n'));
  }
  if (channelChatCheck.checkErrors.length > 0) {
    sections.push([
      '启动检查：以下群聊暂时无法确认，未修改数据：',
      ...channelChatCheck.checkErrors.map(formatStartupChannelChatIssue),
    ].join('\n'));
  }
  return sections.join('\n\n');
}

function buildStartupNoticeRichCard(
  statusText: string,
  channelChatCheck: StartupChannelChatCheckResult = {
    archivedMissingChats: [],
    checkErrors: [],
  },
  feishuSetupNotices: StartupFeishuSetupNotice[] = [],
): OutboundRichCard {
  const sections: OutboundRichCard['sections'] = [{
    markdown: statusText,
  }];
  if (feishuSetupNotices.length > 0) {
    sections.push({
      title: '飞书配置检查',
      markdown: [
        '请确认以下事件和回调已经添加、发布并通过审批。',
        ...feishuSetupNotices.map(formatStartupFeishuSetupNotice),
      ].join('\n'),
    });
  }
  if (channelChatCheck.archivedMissingChats.length > 0) {
    sections.push({
      title: '启动检查',
      markdown: [
        formatArchivedMissingChatsNote(channelChatCheck.archivedMissingChats.length),
        ...channelChatCheck.archivedMissingChats.map(formatStartupChannelChatIssue),
      ].join('\n'),
    });
  }
  if (channelChatCheck.checkErrors.length > 0) {
    sections.push({
      title: '启动检查异常',
      markdown: [
        '以下群聊暂时无法确认，未修改数据：',
        ...channelChatCheck.checkErrors.map(formatStartupChannelChatIssue),
      ].join('\n'),
    });
  }
  return {
    title: STARTUP_NOTICE_TITLE,
    subtitle: 'Bridge 已连接并开始接收消息。',
    template: STARTUP_NOTICE_CARD_TEMPLATE,
    sections,
  };
}

function formatLifecycleArchiveDetail(result: Awaited<ReturnType<typeof archiveLifecycleBindingSession>>): string {
  switch (result.action) {
    case 'codex_archive':
      return result.codexThreadId
        ? `archived Codex thread ${result.codexThreadId.slice(0, 8)}`
        : 'archived Codex thread';
    case 'claude_archive':
      return result.claudeSessionId
        ? `archived Claude session ${result.claudeSessionId.slice(0, 8)}`
        : 'archived Claude session';
    case 'kimi_archive':
      return result.kimiSessionId
        ? `archived Kimi session ${result.kimiSessionId.slice(0, 8)}`
        : 'archived Kimi session';
    case 'cursor_archive':
      return result.cursorSessionId
        ? `archived Cursor session ${result.cursorSessionId.slice(0, 8)}`
        : 'archived Cursor session';
    case 'zcode_archive':
      return result.zcodeSessionId
        ? `archived ZCode session ${result.zcodeSessionId.slice(0, 8)}`
        : 'archived ZCode session';
    case 'bridge_delete':
      return 'deleted BridgeSession';
    case 'binding_delete':
      return 'deleted stale binding';
    case 'delete_after_archive_failure':
      return `archive skipped: ${result.error instanceof Error ? result.error.message : String(result.error)}`;
  }
}

function startPersistedEveryTasks(): void {
  const tasks = listEveryTasks()
    .filter((task) => task.status === 'running');
  for (const task of tasks) {
    startEveryTask(task.id);
  }
}

function startPersistedThenTasks(): void {
  const tasks = listThenTasks({ statuses: ['pending'] });
  for (const task of tasks) {
    startThenTask(task.id);
  }
}

function startPersistedConditionMonitors(): void {
  for (const task of listConditionMonitorTasks({ statuses: ['running'] })) {
    startConditionMonitor(task.id);
  }
}

function startConditionMonitor(taskId: string): void {
  const state = getState();
  if (state.conditionMonitorRuntimes.has(taskId)) return;
  const task = getConditionMonitorTask(taskId);
  if (!task || task.status !== 'running') return;
  const abortController = new AbortController();
  state.conditionMonitorRuntimes.set(taskId, abortController);
  void runConditionMonitorLoop(taskId, abortController).finally(() => {
    state.conditionMonitorRuntimes.delete(taskId);
  });
}

function stopConditionMonitor(taskId: string): void {
  getState().conditionMonitorRuntimes.get(taskId)?.abort();
}

function stopAllConditionMonitors(): void {
  for (const controller of getState().conditionMonitorRuntimes.values()) controller.abort();
  getState().conditionMonitorRuntimes.clear();
}

function startEveryTask(taskId: string): void {
  const state = getState();
  if (state.everyTaskRuntimes.has(taskId)) return;
  const task = getEveryTask(taskId);
  if (!task || task.status !== 'running') return;

  const abortController = new AbortController();
  state.everyTaskRuntimes.set(taskId, {
    abortController,
    bridgeSessionId: task.bridgeSessionId,
    activeTrigger: false,
  });
  void runEveryTaskLoop(taskId, abortController).finally(() => {
    state.everyTaskRuntimes.delete(taskId);
  });
}

function stopEveryTask(taskId: string): void {
  const runtime = getState().everyTaskRuntimes.get(taskId);
  if (!runtime) return;
  runtime.abortController.abort();
  if (!runtime.activeTrigger) return;
  void INTERACTIVE_RUNTIME.forceStopSession(
    runtime.bridgeSessionId,
    '/every 定时输入已取消，正在中止后台触发。',
  ).catch((error) => {
    console.error('[bridge-manager] Failed to stop /every interactive turn:', describeUnknownError(error));
  });
}

function stopAllEveryTasks(): void {
  for (const taskId of Array.from(getState().everyTaskRuntimes.keys())) {
    stopEveryTask(taskId);
  }
  getState().everyTaskRuntimes.clear();
}

function startThenTask(taskId: string): void {
  const task = getThenTask(taskId);
  if (!task || task.status !== 'pending') return;
  const session = getBridgeContext().store.getSession(task.bridgeSessionId);
  if (!session) {
    updateThenTask(task.id, {
      status: 'failed',
      lastError: `Bridge session 不存在：${task.bridgeSessionId}`,
    });
    void deliverThenTaskNotice(task, `后续输入失败：Bridge session 不存在：${task.bridgeSessionId}`);
    return;
  }

  if (isThenSessionReadyForPrompt(session.id)) {
    void runThenTaskQueueForSession(session.id);
    return;
  }
  ensureThenTaskTimer(task.id, session.id);
}

function stopThenTask(taskId: string): void {
  const task = getThenTask(taskId);
  if (!task) return;
  clearThenTaskTimer(taskId);
  updateThenTask(taskId, {
    status: 'cancelled',
    completedAt: nowIso(),
    lastError: '/then 后续输入已取消。',
  });
  if (task.status !== 'running') return;
  void INTERACTIVE_RUNTIME.forceStopSession(
    task.bridgeSessionId,
    '/then 后续输入已取消，正在中止当前发送。',
  ).catch((error) => {
    console.error('[bridge-manager] Failed to stop /then interactive turn:', describeUnknownError(error));
  });
}

function ensureThenTaskTimer(taskId: string, sessionId: string): void {
  const state = getState();
  if (state.thenTaskTimers.has(taskId)) return;
  const timer = setInterval(() => {
    const task = getThenTask(taskId);
    if (!task || task.status !== 'pending') {
      clearThenTaskTimer(taskId);
      return;
    }
    if (!isThenSessionReadyForPrompt(sessionId)) return;
    clearThenTaskTimer(taskId);
    void runThenTaskQueueForSession(sessionId);
  }, 1_000);
  timer.unref?.();
  state.thenTaskTimers.set(taskId, timer);
}

function clearThenTaskTimer(taskId: string): void {
  const state = getState();
  const timer = state.thenTaskTimers.get(taskId);
  if (timer) clearInterval(timer);
  state.thenTaskTimers.delete(taskId);
}

function stopAllThenTasks(): void {
  for (const taskId of Array.from(getState().thenTaskTimers.keys())) {
    clearThenTaskTimer(taskId);
  }
  getState().thenSessionQueues.clear();
}

function isThenSessionReadyForPrompt(sessionId: string): boolean {
  const session = getBridgeContext().store.getSession(sessionId);
  if (!session) return true;
  if (INTERACTIVE_RUNTIME.getActiveTask(sessionId)) return false;
  if (INTERACTIVE_RUNTIME.getQueuedCount(sessionId) > 0) return false;
  if (session.runtime_status === 'running' || session.runtime_status === 'queued') return false;
  if (session.health_status === 'failed') return false;
  if (session.health_status === 'running_active' || session.health_status === 'waiting_tool') return false;
  return true;
}

function recordInteractiveHealthEndAndScheduleThen(
  sessionId: string,
  outcome: 'completed' | 'failed' | 'aborted',
  detail?: string,
): void {
  SESSION_HEALTH_RUNTIME.recordInteractiveEnd(sessionId, outcome, detail);
  if (outcome !== 'completed' && outcome !== 'aborted') return;
  const timer = setTimeout(() => {
    void runThenTaskQueueForSession(sessionId);
  }, 0);
  timer.unref?.();
}

async function runThenTaskQueueForSession(sessionId: string): Promise<void> {
  const state = getState();
  if (state.thenSessionQueues.has(sessionId)) return;
  state.thenSessionQueues.add(sessionId);
  try {
    while (isThenSessionReadyForPrompt(sessionId)) {
      const task = claimNextPendingThenTaskForSession(sessionId);
      if (!task) return;
      clearThenTaskTimer(task.id);
      await runThenTaskPrompt(task);
    }
  } finally {
    state.thenSessionQueues.delete(sessionId);
  }
}

async function runThenTaskPrompt(task: ThenTask): Promise<void> {
  const session = getBridgeContext().store.getSession(task.bridgeSessionId);
  if (!session) {
    updateThenTask(task.id, {
      status: 'failed',
      lastError: `Bridge session 不存在：${task.bridgeSessionId}`,
    });
    await deliverThenTaskNotice(task, `后续输入失败：Bridge session 不存在：${task.bridgeSessionId}`);
    return;
  }

  const { text: prompt, truncated } = sanitizeInput(task.prompt, BACKGROUND_INPUT_LIMIT);
  if (!prompt) {
    updateThenTask(task.id, { status: 'failed', lastError: 'prompt 为空。' });
    await deliverThenTaskNotice(task, '后续输入失败：prompt 为空。');
    return;
  }
  if (truncated) {
    updateThenTask(task.id, { lastError: 'prompt 过长，已截断后发送。' });
  }

  try {
    const result = await sendAgentMessageToSession({
      source: 'then',
      task,
      session,
      prompt,
      messageId: `then:${task.id}`,
    });
    if (!result.ok) throw new Error(result.error);
    if (getThenTask(task.id)?.status !== 'cancelled') {
      updateThenTask(task.id, {
        status: 'completed',
        completedAt: nowIso(),
        lastError: truncated ? 'prompt 过长，已截断后发送。' : undefined,
      });
    }
  } catch (error) {
    if (getThenTask(task.id)?.status === 'cancelled') return;
    const detail = describeUnknownError(error);
    updateThenTask(task.id, { status: 'failed', lastError: detail });
    await deliverThenTaskNotice(task, `后续输入触发失败：\n\n${detail}`);
  }
}

async function runEveryTaskLoop(taskId: string, abortController: AbortController): Promise<void> {
  while (!abortController.signal.aborted) {
    const task = getEveryTask(taskId);
    if (!task || task.status !== 'running') return;
    await abortableDelay(Math.max(1, task.intervalSeconds) * 1000, abortController.signal);
    if (abortController.signal.aborted) return;

    const freshTask = getEveryTask(taskId);
    if (!freshTask || freshTask.status !== 'running') return;
    const session = getBridgeContext().store.getSession(freshTask.bridgeSessionId);
    if (!session) {
      updateEveryTask(freshTask.id, {
        status: 'failed',
        lastError: `Bridge session 不存在：${freshTask.bridgeSessionId}`,
      });
      await deliverEveryTaskNotice(freshTask, `定时输入失败：Bridge session 不存在：${freshTask.bridgeSessionId}`);
      return;
    }

    const { text: prompt, truncated } = sanitizeInput(freshTask.prompt, BACKGROUND_INPUT_LIMIT);
    if (!prompt) {
      updateEveryTask(freshTask.id, { status: 'failed', lastError: 'prompt 为空。' });
      await deliverEveryTaskNotice(freshTask, '定时输入失败：prompt 为空。');
      return;
    }
    const nextTriggeredCount = freshTask.triggeredCount + 1;
    updateEveryTask(freshTask.id, {
      triggeredCount: nextTriggeredCount,
      lastTriggeredAt: nowIso(),
      lastError: truncated ? 'prompt 过长，已截断后发送。' : undefined,
    });

    const runtime = getState().everyTaskRuntimes.get(taskId);
    if (runtime) runtime.activeTrigger = true;
    try {
      await runEveryTaskPrompt(freshTask, session, prompt, nextTriggeredCount, abortController);
    } catch (error) {
      if (abortController.signal.aborted) return;
      const detail = describeUnknownError(error);
      updateEveryTask(freshTask.id, { status: 'failed', lastError: detail });
      await deliverEveryTaskNotice(freshTask, `定时输入触发失败：\n\n${detail}`);
      return;
    } finally {
      const afterRuntime = getState().everyTaskRuntimes.get(taskId);
      if (afterRuntime) afterRuntime.activeTrigger = false;
    }
  }
}

async function runConditionMonitorLoop(taskId: string, abortController: AbortController): Promise<void> {
  while (!abortController.signal.aborted) {
    const task = getConditionMonitorTask(taskId);
    if (!task || task.status !== 'running') return;
    await abortableDelay(Math.max(1, task.intervalSeconds) * 1000, abortController.signal);
    if (abortController.signal.aborted) return;

    const freshTask = getConditionMonitorTask(taskId);
    if (!freshTask || freshTask.status !== 'running') return;
    updateConditionMonitorTask(taskId, {
      checkedCount: freshTask.checkedCount + 1,
      lastCheckedAt: nowIso(),
    });
    const result = await runConditionMonitorTick(freshTask, { signal: abortController.signal });
    if (abortController.signal.aborted) return;
    if (result.outcome === 'pending') {
      updateConditionMonitorTask(taskId, { lastError: undefined });
      continue;
    }
    if (result.outcome === 'error') {
      updateConditionMonitorTask(taskId, { lastError: result.error });
      continue;
    }
    updateConditionMonitorTask(taskId, {
      status: 'completed',
      completedAt: nowIso(),
      lastError: undefined,
    });
    return;
  }
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function runEveryTaskPrompt(
  task: EveryTask,
  session: BridgeSession,
  prompt: string,
  triggeredCount: number,
  abortController: AbortController,
): Promise<void> {
  const result = await sendAgentMessageToSession({
    source: 'every',
    task,
    session,
    prompt,
    messageId: `every:${task.id}:${triggeredCount}`,
    terminalAbortDetail: '/every 定时输入已中止。',
  });
  if (!result.ok) throw new Error(result.error);

  if (abortController.signal.aborted) {
    await INTERACTIVE_RUNTIME.forceStopSession(
      session.id,
      '/every 定时输入已中止。',
    );
  }
}

type AgentMessageTask = Pick<
  EveryTask | ThenTask,
  | 'id'
  | 'bridgeSessionId'
  | 'channelType'
  | 'channelProvider'
  | 'channelAlias'
  | 'chatId'
  | 'chatUserId'
  | 'chatDisplayName'
  | 'createdAt'
>;

interface SendAgentMessageToSessionResult {
  ok: boolean;
  error?: string;
}

async function sendAgentMessageToSession(options: {
  source: 'every' | 'then';
  task: AgentMessageTask;
  session: BridgeSession;
  prompt: string;
  messageId: string;
  terminalAbortDetail?: string;
}): Promise<SendAgentMessageToSessionResult> {
  const adapter = getState().adapters.get(options.task.channelType);
  if (!adapter?.isRunning()) {
    return { ok: false, error: `通道未运行：${options.task.channelType}` };
  }

  const address = agentMessageTaskAddress(options.task);
  const syntheticBinding = buildAgentMessageTaskBinding(options.source, options.task, options.session);
  const msg: InboundMessage = {
    address,
    text: options.prompt,
    messageId: options.messageId,
    timestamp: Date.now(),
  };
  const effectiveRuntimeProvider = resolveEffectiveRuntimeProvider(options.session, syntheticBinding);
  if (effectiveRuntimeProvider?.provider === 'tmux') {
    await handleCommand(adapter, msg, `/tmux ${options.prompt}`, {
      scopedBinding: syntheticBinding,
      tmuxProviderAutoForward: true,
    });
    return { ok: true };
  }

  const displayService = new ThreadDisplayService(getBridgeContext().store);
  await runInteractiveMessage(adapter, msg, options.prompt, undefined, {
    registerInteractiveTask: (taskState) => INTERACTIVE_RUNTIME.registerInteractiveTask(taskState),
    registerBridgeTurn: (turn) => TURN_COORDINATOR.registerInteractiveTurn(turn),
    resetMirrorSessionForInteractiveRun,
    isCurrentInteractiveTask: (sessionId, taskStateId) => INTERACTIVE_RUNTIME.isCurrentInteractiveTask(sessionId, taskStateId),
    touchInteractiveTask: (sessionId, taskStateId) => INTERACTIVE_RUNTIME.touchInteractiveTask(sessionId, taskStateId),
    recordInteractiveHealthStart: (sessionId, detail) => SESSION_HEALTH_RUNTIME.recordInteractiveStart(sessionId, detail),
    recordInteractiveHealthProgress: (sessionId, type, detail) => SESSION_HEALTH_RUNTIME.recordInteractiveProgress(sessionId, type, detail),
    recordInteractiveHealthTool: (sessionId, toolId, toolName, status) => {
      SESSION_HEALTH_RUNTIME.recordToolState(sessionId, toolId, toolName, status);
    },
    recordInteractiveStreamUiSnapshot: (sessionId, snapshot) => {
      SESSION_HEALTH_RUNTIME.recordStructuredStreamUi(sessionId, snapshot);
    },
    recordInteractiveHealthEnd: recordInteractiveHealthEndAndScheduleThen,
    beginMirrorSuppression,
    abortMirrorSuppression,
    settleMirrorSuppression,
    releaseInteractiveTask: (sessionId, taskStateId) => INTERACTIVE_RUNTIME.releaseInteractiveTask(sessionId, taskStateId),
    releaseBridgeTurn: (sessionId, taskStateId) => TURN_COORDINATOR.releaseSessionTurn(sessionId, taskStateId),
    deliverResponse: (targetAdapter, targetAddress, responseText, sessionId, _replyToMessageId, attachments) => (
      deliverResponse(targetAdapter, targetAddress, responseText, sessionId, undefined, attachments)
    ),
    deliverManualInput: sendAgentMessageFromBinding,
    persistCodexThreadUpdate,
    reconcileMirrorSubscriptions,
    resolveSdkConversationRuntime: () => ({
      store: getBridgeContext().store,
      llm: getBridgeContext().llm,
      consumeSseEvents,
      normalizeSandboxMode,
      normalizeReasoningEffort,
    }),
    resolveInteractiveTurnEnvironment: (_address, targetMessageId) => (
      resolveInteractiveTurnEnvironmentBase(address, targetMessageId, {
        resolveBinding: () => syntheticBinding,
        getBridgeSession: (sessionId) => getBridgeContext().store.getSession(sessionId),
        codexThreadExists: (threadId) => Boolean(getCodexSessionByThreadIdSafe(threadId, `/${options.source} interactive turn classify`)),
      })
    ),
    resolveInteractiveTurnRuntimeSettings: (channelType) => resolveInteractiveTurnRuntimeSettings(
      channelType,
      (key) => getBridgeContext().store.getSetting(key),
    ),
    forwardPermissionRequest: broker.forwardPermissionRequest,
    buildStopCallbackData: (sessionId) => buildCommandCallbackData('/stop', sessionId),
    resolveInteractiveTurnDisplayInfo: () => displayService.binding(syntheticBinding, { stripInternalPrefix: true }),
    listInteractiveTurnBindings: (channelType) => getBridgeContext().store.listChannelChats(channelType),
    codexTerminalFinalizationTimeoutMs: DESKTOP_TERMINAL_FINALIZATION_TIMEOUT_MS,
    nowMs: () => Date.now(),
  });

  return { ok: true };
}

function buildAgentMessageTaskBinding(source: 'every' | 'then', task: AgentMessageTask, session: BridgeSession): ChannelChat {
  const timestamp = nowIso();
  return {
    id: `${source}:${task.id}`,
    channelType: task.channelType,
    channelProvider: task.channelProvider,
    channelAlias: task.channelAlias,
    chatId: task.chatId,
    chatUserId: task.chatUserId,
    bridgeSessionId: session.id,
    createdAt: task.createdAt || timestamp,
    updatedAt: timestamp,
  };
}

function agentMessageTaskAddress(task: AgentMessageTask): ChannelAddress {
  return {
    channelType: task.channelType,
    channelProvider: task.channelProvider,
    channelAlias: task.channelAlias,
    chatId: task.chatId,
    userId: task.chatUserId,
    displayName: task.chatDisplayName,
  };
}

function everyTaskAddress(task: EveryTask): ChannelAddress {
  return agentMessageTaskAddress(task);
}

async function deliverEveryTaskNotice(task: EveryTask, text: string): Promise<void> {
  const adapter = getState().adapters.get(task.channelType);
  if (!adapter?.isRunning()) return;
  await deliverBridgeNotice(adapter, everyTaskAddress(task), text, {
    sessionId: task.bridgeSessionId,
    audit: true,
  });
}

async function deliverThenTaskNotice(task: ThenTask, text: string): Promise<void> {
  const adapter = getState().adapters.get(task.channelType);
  if (!adapter?.isRunning()) return;
  await deliverBridgeNotice(adapter, agentMessageTaskAddress(task), text, {
    sessionId: task.bridgeSessionId,
    audit: true,
  });
}

function handleBindingRemovedForAutomationTasks(binding: ChannelChat): void {
  const everyPaused = pauseEveryTasksForSession(binding.bridgeSessionId);
  for (const task of everyPaused) {
    stopEveryTask(task.id);
  }
  const thenPaused = pauseThenTasksForSession(binding.bridgeSessionId);
  for (const task of thenPaused) {
    clearThenTaskTimer(task.id);
  }
}

/**
 * Register a channel adapter.
 */
export function registerAdapter(adapter: BaseChannelAdapter): void {
  const state = getState();
  state.adapters.set(adapter.channelType, adapter);
  state.adapterMeta.set(adapter.channelType, {
    lastMessageAt: null,
    lastError: null,
    configFingerprint: '',
  });
}

function parseTmuxScreenStopCallback(callbackData: string): string | null | undefined {
  if (!callbackData.startsWith(TMUX_SCREEN_STOP_CALLBACK_PREFIX)) return undefined;
  const encodedSessionId = callbackData.slice(TMUX_SCREEN_STOP_CALLBACK_PREFIX.length);
  if (!encodedSessionId) return null;
  try {
    return decodeURIComponent(encodedSessionId);
  } catch {
    return null;
  }
}

function parsePtyScreenStopCallback(callbackData: string): string | null | undefined {
  if (!callbackData.startsWith(PTY_SCREEN_STOP_CALLBACK_PREFIX)) return undefined;
  const encodedSessionId = callbackData.slice(PTY_SCREEN_STOP_CALLBACK_PREFIX.length);
  if (!encodedSessionId) return null;
  try {
    return decodeURIComponent(encodedSessionId);
  } catch {
    return null;
  }
}

function findBindingForCallbackSession(
  channelType: string,
  chatId: string,
  sessionId: string,
): ChannelChat | null {
  const { store } = getBridgeContext();
  return store.listChannelChats(channelType).find((binding) => (
    binding.chatId === chatId && binding.bridgeSessionId === sessionId
  )) || null;
}

function threadSelectionKey(msg: InboundMessage): string {
  return [
    msg.address.channelType,
    msg.address.chatId,
    msg.address.userId || '',
    msg.callbackMessageId || msg.messageId || '',
  ].join(':');
}

function everyTaskSelectionKey(msg: InboundMessage): string {
  return [
    msg.address.channelType,
    msg.address.chatId,
    msg.address.userId || '',
    msg.callbackMessageId || msg.messageId || '',
  ].join(':');
}

function thenTaskSelectionKey(msg: InboundMessage): string {
  return [
    msg.address.channelType,
    msg.address.chatId,
    msg.address.userId || '',
    msg.callbackMessageId || msg.messageId || '',
  ].join(':');
}

function formatChannelEventReason(reason: NonNullable<InboundMessage['channelEvent']>['reason']): string {
  switch (reason) {
    case 'bot_removed':
      return 'bot removed from chat';
    case 'chat_disbanded':
      return 'chat disbanded';
    default:
      return reason;
  }
}

function createLifecycleSessionRegistry(store: BridgeStore): SessionRegistryService {
  return new SessionRegistryService(store, {
    codexThreads: {
      getThread: () => null,
      archiveThread: (codexThreadId) => Boolean(archiveCodexSession(codexThreadId)),
    },
    claudeThreads: {
      getThread: () => null,
      archiveThread: (claudeSessionId, cwd) => {
        const session = getClaudeSessionJsonlById(claudeSessionId, cwd);
        return session ? archiveClaudeSessionJsonl(session) : false;
      },
    },
    kimiThreads: {
      getThread: () => null,
      archiveThread: (kimiSessionId, cwd) => {
        const session = findKimiSessionFileById(kimiSessionId, cwd);
        return session ? archiveKimiSessionFile(session) : false;
      },
    },
    cursorThreads: {
      getThread: () => null,
      archiveThread: (cursorSessionId, cwd) => {
        const session = findCursorSessionFileById(cursorSessionId, cwd);
        return session ? archiveCursorSessionFile(session) : false;
      },
    },
    zcodeThreads: {
      getThread: () => null,
      archiveThread: (zcodeSessionId, cwd) => {
        const session = findZcodeSessionById(zcodeSessionId, cwd, { includeArchived: true });
        return session ? archiveZcodeSession(session) : false;
      },
    },
  });
}

async function archiveLifecycleBindingSession(
  store: BridgeStore,
  binding: ChannelChat,
): Promise<{
  action: 'codex_archive' | 'claude_archive' | 'kimi_archive' | 'cursor_archive' | 'zcode_archive' | 'bridge_delete' | 'delete_after_archive_failure' | 'binding_delete';
  codexThreadId?: string;
  claudeSessionId?: string;
  claudeCwd?: string;
  kimiSessionId?: string;
  kimiCwd?: string;
  cursorSessionId?: string;
  cursorCwd?: string;
  zcodeSessionId?: string;
  zcodeCwd?: string;
  deletedBridgeSessionIds: string[];
  tmuxSessionNames: string[];
  tmuxCleanupCommands: string[];
  tmuxCleanupErrors: string[];
  error?: unknown;
}> {
  const session = store.getSession(binding.bridgeSessionId);
  if (!session) {
    store.deleteChannelChat(binding.id);
    return {
      action: 'binding_delete',
      deletedBridgeSessionIds: [],
      tmuxSessionNames: [],
      tmuxCleanupCommands: [],
      tmuxCleanupErrors: [],
    };
  }

  const registry = createLifecycleSessionRegistry(store);
  const codexThreadId = getBridgeSessionCodexThreadId(session);
  const activeRuntime = getSessionActiveRuntime(session);
  const claudeSessionId = activeRuntime === 'claude' ? getSessionClaudeSessionId(session) || undefined : undefined;
  const claudeCwd = activeRuntime === 'claude' ? getSessionClaudeCwd(session) || getSessionWorkingDirectory(session) || undefined : undefined;
  const kimiSessionId = activeRuntime === 'kimi' ? getSessionKimiSessionId(session) || undefined : undefined;
  const kimiCwd = activeRuntime === 'kimi' ? getSessionKimiCwd(session) || getSessionWorkingDirectory(session) || undefined : undefined;
  const cursorSessionId = activeRuntime === 'cursor' ? getSessionCursorSessionId(session) || undefined : undefined;
  const cursorCwd = activeRuntime === 'cursor' ? getSessionCursorCwd(session) || getSessionWorkingDirectory(session) || undefined : undefined;
  const zcodeSessionId = activeRuntime === 'zcode' ? getSessionZcodeSessionId(session) || undefined : undefined;
  const zcodeCwd = activeRuntime === 'zcode' ? getSessionZcodeCwd(session) || getSessionWorkingDirectory(session) || undefined : undefined;
  const tmuxCleanup = await cleanupLifecycleTmuxSessions(store, session, {
    codexThreadId,
    claudeSessionId,
    claudeCwd,
    kimiSessionId,
    kimiCwd,
    cursorSessionId,
    cursorCwd,
    zcodeSessionId,
    zcodeCwd,
  });
  try {
    if (codexThreadId) {
      const result = registry.archiveCodexThread(codexThreadId);
      return {
        action: 'codex_archive',
        codexThreadId,
        deletedBridgeSessionIds: result.deletedBridgeSessionIds,
        ...tmuxCleanup,
      };
    }
    if (claudeSessionId && claudeCwd) {
      const result = registry.archiveClaudeThread(claudeSessionId, claudeCwd);
      return {
        action: 'claude_archive',
        claudeSessionId,
        claudeCwd,
        deletedBridgeSessionIds: result.deletedBridgeSessionIds,
        ...tmuxCleanup,
      };
    }
    if (kimiSessionId && kimiCwd) {
      const result = registry.archiveKimiThread(kimiSessionId, kimiCwd);
      return {
        action: 'kimi_archive',
        kimiSessionId,
        kimiCwd,
        deletedBridgeSessionIds: result.deletedBridgeSessionIds,
        ...tmuxCleanup,
      };
    }
    if (cursorSessionId && cursorCwd) {
      const result = registry.archiveCursorThread(cursorSessionId, cursorCwd);
      return {
        action: 'cursor_archive',
        cursorSessionId,
        cursorCwd,
        deletedBridgeSessionIds: result.deletedBridgeSessionIds,
        ...tmuxCleanup,
      };
    }
    if (zcodeSessionId && zcodeCwd) {
      const result = registry.archiveZcodeThread(zcodeSessionId, zcodeCwd);
      return {
        action: 'zcode_archive',
        zcodeSessionId,
        zcodeCwd,
        deletedBridgeSessionIds: result.deletedBridgeSessionIds,
        ...tmuxCleanup,
      };
    }

    const result = registry.deleteBridgeSession(session.id);
    return {
      action: 'bridge_delete',
      deletedBridgeSessionIds: result.deletedBridgeSessionIds,
      ...tmuxCleanup,
    };
  } catch (error) {
    console.error('[bridge-manager] Failed to archive ChannelChat session after channel lifecycle event; deleting BridgeSession fallback:', describeUnknownError(error));
    store.deleteSession(session.id);
    return {
      action: 'delete_after_archive_failure',
      codexThreadId,
      claudeSessionId,
      claudeCwd,
      kimiSessionId,
      kimiCwd,
      cursorSessionId,
      cursorCwd,
      zcodeSessionId,
      zcodeCwd,
      deletedBridgeSessionIds: [session.id],
      ...tmuxCleanup,
      error,
    };
  }
}

async function cleanupLifecycleTmuxSessions(
  store: BridgeStore,
  session: BridgeSession,
  identity: {
    codexThreadId?: string;
    claudeSessionId?: string;
    claudeCwd?: string;
    kimiSessionId?: string;
    kimiCwd?: string;
    cursorSessionId?: string;
    cursorCwd?: string;
    zcodeSessionId?: string;
    zcodeCwd?: string;
  },
): Promise<{
  tmuxSessionNames: string[];
  tmuxCleanupCommands: string[];
  tmuxCleanupErrors: string[];
}> {
  const linkedSessions = store.listSessions()
    .filter((candidate) => {
      if (identity.codexThreadId) {
        return getBridgeSessionCodexThreadId(candidate) === identity.codexThreadId;
      }
      if (identity.claudeSessionId && identity.claudeCwd) {
        return getSessionActiveRuntime(candidate) === 'claude'
          && getSessionClaudeSessionId(candidate) === identity.claudeSessionId
          && getSessionClaudeCwd(candidate) === identity.claudeCwd;
      }
      if (identity.kimiSessionId && identity.kimiCwd) {
        return getSessionActiveRuntime(candidate) === 'kimi'
          && getSessionKimiSessionId(candidate) === identity.kimiSessionId
          && getSessionKimiCwd(candidate) === identity.kimiCwd;
      }
      if (identity.cursorSessionId && identity.cursorCwd) {
        return getSessionActiveRuntime(candidate) === 'cursor'
          && getSessionCursorSessionId(candidate) === identity.cursorSessionId
          && getSessionCursorCwd(candidate) === identity.cursorCwd;
      }
      if (identity.zcodeSessionId && identity.zcodeCwd) {
        return getSessionActiveRuntime(candidate) === 'zcode'
          && getSessionZcodeSessionId(candidate) === identity.zcodeSessionId
          && getSessionZcodeCwd(candidate) === identity.zcodeCwd;
      }
      return candidate.id === session.id;
    });
  const targets = linkedSessions.length > 0 ? linkedSessions : [session];
  const seen = new Set<string>();
  const tmuxSessionNames: string[] = [];
  const tmuxCleanupCommands: string[] = [];
  const tmuxCleanupErrors: string[] = [];

  for (const target of targets) {
    const activeRuntime = getSessionActiveRuntime(target);
    const tmuxSessionName = getSessionRuntimeTmuxSessionName(target)
      || (activeRuntime === 'kimi'
        ? kimiTmuxSessionName(target.id)
        : activeRuntime === 'cursor'
          ? cursorTmuxSessionName(target.id)
          : activeRuntime === 'zcode'
            ? zcodeTmuxSessionName(target.id)
          : undefined);
    if (!tmuxSessionName || seen.has(tmuxSessionName)) continue;
    seen.add(tmuxSessionName);
    tmuxSessionNames.push(tmuxSessionName);
    const cleanup = await cleanupRuntimeTmuxSession({
      runtime: activeRuntime,
      sessionName: tmuxSessionName,
      ignoreMissing: true,
    });
    tmuxCleanupCommands.push(...cleanup.commands);
    if (cleanup.error) {
      tmuxCleanupErrors.push(`${tmuxSessionName}: ${cleanup.error}`);
    }
  }

  return { tmuxSessionNames, tmuxCleanupCommands, tmuxCleanupErrors };
}

async function handleChannelLifecycleEvent(msg: InboundMessage): Promise<void> {
  const event = msg.channelEvent;
  if (!event || event.type !== 'chat_removed') return;

  const { store } = getBridgeContext();
  const binding = store.getChannelChat(msg.address.channelType, msg.address.chatId);
  const reason = formatChannelEventReason(event.reason);
  if (!binding) {
    console.log('[bridge-manager] Channel lifecycle event had no local ChannelChat:', {
      channelType: msg.address.channelType,
      chatId: msg.address.chatId,
      eventType: event.eventType,
      reason,
    });
    return;
  }

  const bindingsBeforeArchive = store.listChannelChats()
    .filter((item) => item.bridgeSessionId === binding.bridgeSessionId);
  const archiveResult = await archiveLifecycleBindingSession(store, binding);
  for (const removedBinding of bindingsBeforeArchive) {
    handleBindingRemovedForAutomationTasks(removedBinding);
  }
  try {
    store.insertAuditLog({
      channelType: msg.address.channelType,
      channelProvider: msg.address.channelProvider || binding.channelProvider,
      channelAlias: msg.address.channelAlias || binding.channelAlias,
      chatId: msg.address.chatId,
      direction: 'inbound',
      messageId: msg.messageId,
      summary: [
        `ChannelChat archived: ${reason}`,
        `event=${event.eventType || event.type}`,
        `session=${binding.bridgeSessionId}`,
        `action=${archiveResult.action}`,
        archiveResult.codexThreadId ? `thread=${archiveResult.codexThreadId}` : '',
        archiveResult.claudeSessionId ? `claude_session=${archiveResult.claudeSessionId}` : '',
        archiveResult.claudeCwd ? `claude_cwd=${archiveResult.claudeCwd}` : '',
        archiveResult.kimiSessionId ? `kimi_session=${archiveResult.kimiSessionId}` : '',
        archiveResult.kimiCwd ? `kimi_cwd=${archiveResult.kimiCwd}` : '',
        archiveResult.cursorSessionId ? `cursor_session=${archiveResult.cursorSessionId}` : '',
        archiveResult.cursorCwd ? `cursor_cwd=${archiveResult.cursorCwd}` : '',
        archiveResult.tmuxSessionNames.length > 0 ? `tmux_sessions=${archiveResult.tmuxSessionNames.join(',')}` : '',
        archiveResult.tmuxCleanupCommands.length > 0 ? `tmux_cleanup=${archiveResult.tmuxCleanupCommands.join(',')}` : '',
        archiveResult.tmuxCleanupErrors.length > 0 ? `tmux_cleanup_errors=${archiveResult.tmuxCleanupErrors.join(',')}` : '',
        `deleted_sessions=${archiveResult.deletedBridgeSessionIds.length}`,
      ].filter(Boolean).join('; '),
    });
  } catch { /* best effort */ }

  void reconcileMirrorSubscriptions().catch((err) => {
    console.error('[bridge-manager] Mirror reconcile after channel lifecycle archive failed:', describeUnknownError(err));
  });
  console.warn('[bridge-manager] Archived local ChannelChat session after channel lifecycle event:', {
    channelType: binding.channelType,
    chatId: binding.chatId,
    bridgeSessionId: binding.bridgeSessionId,
    eventType: event.eventType,
    reason,
    action: archiveResult.action,
    codexThreadId: archiveResult.codexThreadId,
    claudeSessionId: archiveResult.claudeSessionId,
    claudeCwd: archiveResult.claudeCwd,
    kimiSessionId: archiveResult.kimiSessionId,
    kimiCwd: archiveResult.kimiCwd,
    cursorSessionId: archiveResult.cursorSessionId,
    cursorCwd: archiveResult.cursorCwd,
    tmuxSessionNames: archiveResult.tmuxSessionNames,
    tmuxCleanupCommands: archiveResult.tmuxCleanupCommands,
    tmuxCleanupErrors: archiveResult.tmuxCleanupErrors,
    deletedBridgeSessionIds: archiveResult.deletedBridgeSessionIds,
  });
}

function extractCardActionFormValue(raw: unknown): Record<string, unknown> | null {
  const root = raw && typeof raw === 'object' ? raw as Record<string, any> : {};
  const event = root.event && typeof root.event === 'object' ? root.event as Record<string, any> : root;
  const action = event.action && typeof event.action === 'object' ? event.action as Record<string, any> : {};
  const formValue = action.form_value;
  return formValue && typeof formValue === 'object' ? formValue as Record<string, unknown> : null;
}

function normalizeFormString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function quoteCommandArg(value: string): string {
  if (!/[\s"'\\]/.test(value)) return value;
  return `"${value.replace(/(["\\])/g, '\\$1')}"`;
}

function formatAgentQuestionAnswer(agentQuestion: { question: string; answer: string }, raw: unknown): string {
  const formValue = extractCardActionFormValue(raw);
  if (!formValue) return agentQuestion.answer;
  const choice = normalizeFormString(formValue.clk_choice || formValue.choice || formValue.option);
  const input = normalizeFormString(formValue.clk_input || formValue.input || formValue.text);
  return [
    choice ? `选择：${choice}` : '',
    `补充：${input || '（空）'}`,
  ].filter(Boolean).join('\n') || agentQuestion.answer;
}

function appendModelContextText(text: string, ...contextTexts: Array<string | undefined>): string {
  const trimmedContext = contextTexts.map((contextText) => contextText?.trim()).filter(Boolean).join('\n\n');
  if (!trimmedContext) return text;
  const trimmedText = text.trim();
  if (!trimmedText) return trimmedContext;
  return `${trimmedContext}\n\n${trimmedText}`;
}

function parseThreadSelectCallback(callbackData: string): string | null | undefined {
  if (!callbackData.startsWith(THREAD_SELECT_CALLBACK_PREFIX)) return undefined;
  try {
    return decodeURIComponent(callbackData.slice(THREAD_SELECT_CALLBACK_PREFIX.length)).trim() || null;
  } catch {
    return null;
  }
}

function parseEveryTaskSelectCallback(callbackData: string): string | null | undefined {
  if (!callbackData.startsWith(EVERY_TASK_SELECT_CALLBACK_PREFIX)) return undefined;
  try {
    return decodeURIComponent(callbackData.slice(EVERY_TASK_SELECT_CALLBACK_PREFIX.length)).trim() || null;
  } catch {
    return null;
  }
}

function parseEveryTaskActionCallback(callbackData: string): EveryTaskCardAction | null | undefined {
  if (!callbackData.startsWith(EVERY_TASK_ACTION_CALLBACK_PREFIX)) return undefined;
  const raw = callbackData.slice(EVERY_TASK_ACTION_CALLBACK_PREFIX.length).trim();
  return raw === 'no' ? raw : null;
}

function parseThenTaskSelectCallback(callbackData: string): string | null | undefined {
  if (!callbackData.startsWith(THEN_TASK_SELECT_CALLBACK_PREFIX)) return undefined;
  try {
    return decodeURIComponent(callbackData.slice(THEN_TASK_SELECT_CALLBACK_PREFIX.length)).trim() || null;
  } catch {
    return null;
  }
}

function parseThenTaskActionCallback(callbackData: string): ThenTaskCardAction | null | undefined {
  if (!callbackData.startsWith(THEN_TASK_ACTION_CALLBACK_PREFIX)) return undefined;
  const raw = callbackData.slice(THEN_TASK_ACTION_CALLBACK_PREFIX.length).trim();
  return raw === 'no' || raw === 'edit' ? raw : null;
}

function parseThreadSelectActionCallback(callbackData: string): {
  scope: 'global' | 'bound';
  action: ThreadCardAction;
} | null | undefined {
  if (!callbackData.startsWith(THREAD_SELECT_ACTION_CALLBACK_PREFIX)) return undefined;
  const raw = callbackData.slice(THREAD_SELECT_ACTION_CALLBACK_PREFIX.length).trim();
  const parts = raw.split(':').filter(Boolean);
  const scope = parts.length === 2 ? parts[0] : 'global';
  const action = parts.length === 2 ? parts[1] : parts[0];
  if (
    (scope !== 'global' && scope !== 'bound')
    || (action !== 'switch' && action !== 'archive')
  ) {
    return null;
  }
  return { scope, action };
}

function threadCardRefreshScopeForCommand(commandText: string): 'global' | 'bound' | null {
  const trimmed = commandText.trim();
  const commandToken = trimmed.split(/\s+/)[0] || '';
  const rawCommand = commandToken.split('@')[0].toLowerCase();
  const args = trimmed.slice(commandToken.length).trim();
  const resolvedCommand = resolveCommandAlias(rawCommand, args);
  if (resolvedCommand === '/threads' || resolvedCommand === '/thread') return 'global';
  if (resolvedCommand !== '/t') return null;
  const subcommand = args.split(/\s+/).filter(Boolean)[0]?.toLowerCase();
  return subcommand === 'ls' ? 'bound' : null;
}

function buildDoctorPromptMessage(msg: InboundMessage, prompt: string): InboundMessage {
  return {
    ...msg,
    text: prompt,
    callbackData: undefined,
    callbackMessageId: undefined,
    updateId: undefined,
  };
}

/**
 * Handle a single inbound message.
 */
async function handleMessage(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
): Promise<void> {
  const { store } = getBridgeContext();

  // Update lastMessageAt for this adapter
  const adapterState = getState();
  const meta = adapterState.adapterMeta.get(adapter.channelType) || { lastMessageAt: null, lastError: null, configFingerprint: '' };
  meta.lastMessageAt = new Date().toISOString();
  adapterState.adapterMeta.set(adapter.channelType, meta);

  // Acknowledge the update offset after processing completes (or fails).
  // This ensures the adapter only advances its committed offset once the
  // message has been fully handled, preventing message loss on crash.
  const ack = () => {
    if (msg.updateId != null && adapter.acknowledgeUpdate) {
      adapter.acknowledgeUpdate(msg.updateId);
    }
  };

  if (msg.channelEvent) {
    await handleChannelLifecycleEvent(msg);
    ack();
    return;
  }
  touchInboundChannelChatActivity(msg);

  // Handle callback queries (permission buttons and interactive command cards)
  if (msg.callbackData) {
    if (getState().dailyVersionUpdateRuntime?.handleCallback(adapter, msg)) {
      ack();
      return;
    }
    const selectedEveryTaskId = parseEveryTaskSelectCallback(msg.callbackData);
    if (selectedEveryTaskId !== undefined) {
      if (!selectedEveryTaskId) {
        enqueueBridgeNotice(adapter, msg.address, '这个下拉选项无效，请刷新后重试。');
      } else {
        getState().everyTaskSelections.set(everyTaskSelectionKey(msg), selectedEveryTaskId);
        void adapter.answerCallback?.(msg.messageId, '已选择').catch((error) => {
          console.warn('[bridge-manager] Failed to answer every-task selection callback:', describeUnknownError(error));
        });
      }
      ack();
      return;
    }

    const everyTaskAction = parseEveryTaskActionCallback(msg.callbackData);
    if (everyTaskAction !== undefined) {
      if (!everyTaskAction) {
        enqueueBridgeNotice(adapter, msg.address, '这个按钮的操作无效，请刷新后重试。');
        ack();
        return;
      }
      const taskId = getState().everyTaskSelections.get(everyTaskSelectionKey(msg));
      if (!taskId) {
        enqueueBridgeNotice(adapter, msg.address, '请先在下拉列表中选择一个 /every，再点击操作按钮。');
        ack();
        return;
      }
      const commandText = '/every no';
      await handleCommand(
        adapter,
        { ...msg, text: commandText, callbackData: undefined },
        commandText,
        { selectedEveryTaskId: taskId, selectedEveryTaskAction: everyTaskAction },
      );
      ack();
      return;
    }

    const selectedThenTaskId = parseThenTaskSelectCallback(msg.callbackData);
    if (selectedThenTaskId !== undefined) {
      if (!selectedThenTaskId) {
        enqueueBridgeNotice(adapter, msg.address, '这个下拉选项无效，请刷新后重试。');
      } else {
        getState().thenTaskSelections.set(thenTaskSelectionKey(msg), selectedThenTaskId);
        void adapter.answerCallback?.(msg.messageId, '已选择').catch((error) => {
          console.warn('[bridge-manager] Failed to answer then-task selection callback:', describeUnknownError(error));
        });
      }
      ack();
      return;
    }

    const thenTaskAction = parseThenTaskActionCallback(msg.callbackData);
    if (thenTaskAction !== undefined) {
      if (!thenTaskAction) {
        enqueueBridgeNotice(adapter, msg.address, '这个按钮的操作无效，请刷新后重试。');
        ack();
        return;
      }
      const taskId = getState().thenTaskSelections.get(thenTaskSelectionKey(msg));
      if (!taskId) {
        enqueueBridgeNotice(adapter, msg.address, '请先在下拉列表中选择一个 /then，再点击操作按钮。');
        ack();
        return;
      }
      const commandText = thenTaskAction === 'edit' ? '/then edit-form' : '/then no';
      await handleCommand(
        adapter,
        { ...msg, text: commandText, callbackData: undefined },
        commandText,
        { selectedThenTaskId: taskId, selectedThenTaskAction: thenTaskAction },
      );
      ack();
      return;
    }

    const selectedThreadId = parseThreadSelectCallback(msg.callbackData);
    if (selectedThreadId !== undefined) {
      if (!selectedThreadId) {
        enqueueBridgeNotice(adapter, msg.address, '这个下拉选项无效，请刷新后重试。');
      } else {
        getState().threadCardSelections.set(threadSelectionKey(msg), selectedThreadId);
        void adapter.answerCallback?.(msg.messageId, '已选择').catch((error) => {
          console.warn('[bridge-manager] Failed to answer thread selection callback:', describeUnknownError(error));
        });
      }
      ack();
      return;
    }

    const threadAction = parseThreadSelectActionCallback(msg.callbackData);
    if (threadAction !== undefined) {
      if (!threadAction) {
        enqueueBridgeNotice(adapter, msg.address, '这个按钮的操作无效，请刷新后重试。');
        ack();
        return;
      }
      const threadId = getState().threadCardSelections.get(threadSelectionKey(msg));
      if (!threadId) {
        enqueueBridgeNotice(adapter, msg.address, '请先在下拉列表中选择一个线程，再点击接管或归档。');
        ack();
        return;
      }
      const commandText = threadAction.scope === 'global'
        ? threadAction.action === 'archive'
          ? `/t archive ${threadId}`
          : `/t ${threadId}`
        : threadAction.action === 'archive'
          ? `/t archive ${threadId}`
          : `/t ${threadId}`;
      await handleCommand(
        adapter,
        { ...msg, text: commandText, callbackData: undefined },
        commandText,
        { threadCardRefreshScope: threadAction.scope, threadCardSelectedId: threadId },
      );
      ack();
      return;
    }

    const commandCallback = parseCommandCallbackData(msg.callbackData);
    if (commandCallback !== undefined) {
      if (!commandCallback) {
        enqueueBridgeNotice(adapter, msg.address, '这个按钮的命令数据无效，请改用纯文本命令。');
        ack();
        return;
      }
      let commandText = commandCallback.commandText;
      if (commandText === '/new') {
        const formValue = extractCardActionFormValue(msg.raw);
        if (formValue) {
          const newSessionName = normalizeFormString(formValue.clk_input || formValue.input || formValue.text);
          if (!newSessionName) {
            enqueueBridgeNotice(adapter, msg.address, '请输入群聊名称后再创建。');
            ack();
            return;
          }
          const newSessionPath = normalizeFormString(formValue.clk_path || formValue.path || formValue.cwd);
          commandText = [
            '/new',
            quoteCommandArg(newSessionName),
            newSessionPath ? quoteCommandArg(newSessionPath) : '',
          ].filter(Boolean).join(' ');
        }
      }
      const scopedBinding = commandCallback.scopeSessionId
        ? findBindingForCallbackSession(msg.address.channelType, msg.address.chatId, commandCallback.scopeSessionId)
        : null;
      if (commandCallback.scopeSessionId && !scopedBinding) {
        enqueueBridgeNotice(adapter, msg.address, '这个按钮对应的会话已不再绑定到当前聊天，请改用纯文本命令确认当前状态。');
        ack();
        return;
      }
      await handleCommand(
        adapter,
        { ...msg, text: commandText },
        commandText,
        {
          scopedBinding,
          threadCardRefreshScope: threadCardRefreshScopeForCommand(commandText),
          threadCardSelectedId: getState().threadCardSelections.get(threadSelectionKey(msg)) || null,
        },
      );
      ack();
      return;
    }

    const tmuxScreenSessionId = parseTmuxScreenStopCallback(msg.callbackData);
    if (tmuxScreenSessionId !== undefined) {
      const binding = tmuxScreenSessionId
        ? findBindingForCallbackSession(msg.address.channelType, msg.address.chatId, tmuxScreenSessionId)
        : store.getChannelChat(msg.address.channelType, msg.address.chatId);
      if (!binding) {
        enqueueBridgeNotice(adapter, msg.address, '这个停止按钮对应的会话已不再绑定到当前聊天，无法停止 tmux 屏幕定时刷新。');
      } else {
        await handleCommand(
          adapter,
          { ...msg, text: '/tmux-screen stop', callbackData: undefined },
          '/tmux-screen stop',
          { scopedBinding: binding },
        );
      }
      ack();
      return;
    }

    const ptyScreenSessionId = parsePtyScreenStopCallback(msg.callbackData);
    if (ptyScreenSessionId !== undefined) {
      const binding = ptyScreenSessionId
        ? findBindingForCallbackSession(msg.address.channelType, msg.address.chatId, ptyScreenSessionId)
        : store.getChannelChat(msg.address.channelType, msg.address.chatId);
      if (!binding) {
        enqueueBridgeNotice(adapter, msg.address, '这个停止按钮对应的会话已不再绑定到当前聊天，无法停止 pty 屏幕定时刷新。');
      } else {
        await handleCommand(
          adapter,
          { ...msg, text: '/pty-screen stop', callbackData: undefined },
          '/pty-screen stop',
          { scopedBinding: binding },
        );
      }
      ack();
      return;
    }

    const agentQuestion = parseAgentQuestionCallbackData(msg.callbackData);
    if (agentQuestion !== undefined) {
      if (!agentQuestion) {
        enqueueBridgeNotice(adapter, msg.address, '这个问题卡片的数据无效，请直接输入文字回复。');
        ack();
        return;
      }
      await handleMessage(adapter, {
        ...msg,
        messageId: `${msg.messageId}:answer:${Date.now()}`,
        text: [
          '[用户回答了问题卡片]',
          `问题：${agentQuestion.question}`,
          `回答：${formatAgentQuestionAnswer(agentQuestion, msg.raw)}`,
        ].join('\n'),
        callbackData: undefined,
        callbackMessageId: undefined,
        updateId: undefined,
      });
      ack();
      return;
    }

    const codexSelectionClaim = broker.claimCodexSelectionCallback(
      msg.callbackData,
      msg.address.chatId,
      msg.callbackMessageId,
    );
    if (codexSelectionClaim !== undefined) {
      if (codexSelectionClaim?.handledBy === 'orphan') {
        const autoForwardRecovery = await recoverTmuxProviderAutoForwardFromSelectionCallback(codexSelectionClaim);
        if (autoForwardRecovery.attempted) {
          enqueueBridgeNotice(adapter, msg.address, autoForwardRecovery.notice);
        } else if (parseMirrorCodexSelectionSessionId(codexSelectionClaim.permissionRequestId)) {
          const recovery = await recoverMirrorTmuxSelectionPromptFromCallback(codexSelectionClaim, adapter);
          enqueueBridgeNotice(adapter, msg.address, recovery.notice);
        } else {
          enqueueBridgeNotice(adapter, msg.address, 'Permission response recorded.');
        }
      } else if (codexSelectionClaim) {
        const mirrorSessionId = parseMirrorCodexSelectionSessionId(codexSelectionClaim.permissionRequestId);
        if (mirrorSessionId) {
          requestTmuxSelectionPromptFollowupProbe(mirrorSessionId);
        }
        enqueueBridgeNotice(adapter, msg.address, 'Permission response recorded.');
      }
      ack();
      return;
    }

    const handled = broker.handlePermissionCallback(msg.callbackData, msg.address.chatId, msg.callbackMessageId);
    if (handled) {
      enqueueBridgeNotice(adapter, msg.address, 'Permission response recorded.');
    }
    ack();
    return;
  }

  getState().dailyVersionUpdateRuntime?.onFirstUserMessage(adapter, msg);

  const rawText = msg.text.trim();
  const hasAttachments = msg.attachments && msg.attachments.length > 0;
  if (isBridgeCommandText(rawText)) {
    addInboundGetReaction(adapter, msg, 'command_received');
  }

  if (rawText && !hasAttachments) {
    const attachmentConfirmation = consumePendingAttachmentConfirmation(msg.address, rawText);
    if (attachmentConfirmation.reply === 'confirm' && attachmentConfirmation.commandText) {
      await handleCommand(
        adapter,
        { ...msg, text: attachmentConfirmation.commandText, callbackData: undefined },
        attachmentConfirmation.commandText,
      );
      ack();
      return;
    }
    if (attachmentConfirmation.reply === 'cancel') {
      enqueueBridgeNotice(adapter, msg.address, '已取消接管，当前任务和聊天绑定保持不变。', {
        replyToMessageId: msg.messageId,
      });
      ack();
      return;
    }

    const takeoverConfirmation = consumePendingTakeoverConfirmation(msg.address, rawText);
    if (takeoverConfirmation.reply === 'confirm' && takeoverConfirmation.commandText) {
      await handleCommand(
        adapter,
        { ...msg, text: takeoverConfirmation.commandText, callbackData: undefined },
        takeoverConfirmation.commandText,
      );
      ack();
      return;
    }
    if (takeoverConfirmation.reply === 'cancel') {
      enqueueBridgeNotice(adapter, msg.address, '已取消接管，当前聊天绑定保持不变。', {
        replyToMessageId: msg.messageId,
      });
      ack();
      return;
    }

    const clearConfirmation = consumePendingClearConfirmation(msg.address, rawText);
    if (clearConfirmation.reply === 'confirm' && clearConfirmation.commandText) {
      await handleCommand(
        adapter,
        { ...msg, text: clearConfirmation.commandText, callbackData: undefined },
        clearConfirmation.commandText,
      );
      ack();
      return;
    }
    if (clearConfirmation.reply === 'cancel') {
      enqueueBridgeNotice(adapter, msg.address, '已取消 /clear，当前对话保持不变。', {
        replyToMessageId: msg.messageId,
      });
      ack();
      return;
    }
  }

  // Handle attachment-only download failures — surface error to user instead of silently dropping
  if (!rawText && !hasAttachments) {
    const rawData = msg.raw as {
      imageDownloadFailed?: boolean;
      attachmentDownloadFailed?: boolean;
      failedCount?: number;
      failedLabel?: string;
      userVisibleError?: string;
    } | undefined;
    if (rawData?.userVisibleError) {
      enqueueBridgeNotice(adapter, msg.address, rawData.userVisibleError, {
        replyToMessageId: msg.messageId,
      });
    } else if (rawData?.imageDownloadFailed || rawData?.attachmentDownloadFailed) {
      const failureLabel = rawData.failedLabel || (rawData.imageDownloadFailed ? 'image(s)' : 'attachment(s)');
      enqueueBridgeNotice(adapter, msg.address, `Failed to download ${rawData.failedCount ?? 1} ${failureLabel}. Please try sending again.`, {
        replyToMessageId: msg.messageId,
      });
    }
    ack();
    return;
  }

  const modelText = toModelPromptText(rawText);
  if (isBridgeCommandText(rawText)) {
    const commandToken = modelText.trim().split(/\s+/)[0] || '';
    const rawCommand = commandToken.split('@')[0].toLowerCase();
    const args = modelText.trim().slice(commandToken.length).trim();
    if (rawCommand === '/doctor') {
      const spec = buildDoctorPromptFromLogs(args);
      enqueueBridgeNotice(adapter, msg.address, spec.notice, {
        replyToMessageId: msg.messageId,
        audit: true,
      });
      await handleMessage(adapter, buildDoctorPromptMessage(msg, spec.prompt));
      ack();
      return;
    }
  }

  const tmuxProviderBinding = store.getChannelChat(msg.address.channelType, msg.address.chatId);
  const tmuxProviderSession = tmuxProviderBinding ? store.getSession(tmuxProviderBinding.bridgeSessionId) : null;
  const tmuxProviderRuntime = tmuxProviderSession
    ? resolveEffectiveRuntimeProvider(tmuxProviderSession, tmuxProviderBinding)
    : null;
  const tmuxProviderActiveTask = tmuxProviderBinding
    ? INTERACTIVE_RUNTIME.getActiveTask(tmuxProviderBinding.bridgeSessionId)
    : null;
  if (
    tmuxProviderSession
    && tmuxProviderRuntime?.provider === 'tmux'
    && tmuxProviderRuntime.runtime !== 'cursor'
    && tmuxProviderRuntime.runtime !== 'zcode'
  ) {
    const tmuxProviderChat = tmuxProviderBinding;
    if (!tmuxProviderChat) {
      ack();
      return;
    }
    if (tmuxProviderActiveTask) {
      const activeTmuxSessionName = getSessionRuntimeTmuxSessionName(tmuxProviderSession)
        || (tmuxProviderRuntime.runtime === 'kimi'
          ? kimiTmuxSessionName(tmuxProviderSession.id)
          : undefined);
      if (activeTmuxSessionName) {
        transitionRuntimeTmuxInputState(
          tmuxProviderRuntime.runtime,
          activeTmuxSessionName,
          'running',
          'an active interactive task already owns the runtime tmux session',
        );
      }
    }
    if (rawText.trim().toLowerCase() === '//clear') {
      enqueueBridgeNotice(adapter, msg.address, '当前处于 tmux Provider，不能通过 `//clear` 清空上下文。请通过 codelark 手动创建新会话。', {
        replyToMessageId: msg.messageId,
      });
      ack();
      return;
    }
    if (hasAttachments) {
      enqueueBridgeNotice(adapter, msg.address, '当前处于 tmux Provider，图片或文件不会直接转发到 TUI。请引用你刚发送的图片或文件消息，并告诉模型要如何处理。', {
        replyToMessageId: msg.messageId,
      });
      ack();
      return;
    }
    if (isBridgeCommandText(rawText)) {
      try {
        await handleCommand(adapter, msg, rawText);
      } catch (error) {
        const commandToken = rawText.trim().split(/\s+/)[0] || '';
        const rawCommand = commandToken.split('@')[0].toLowerCase();
        const args = rawText.trim().slice(commandToken.length).trim();
        const resolvedCommand = resolveCommandAlias(rawCommand, args);
        console.error(`[bridge-manager] tmux provider command failed: ${resolvedCommand}`, error);
        enqueueBridgeNotice(adapter, msg.address, toUserVisibleCommandError(resolvedCommand, error), {
          replyToMessageId: msg.messageId,
        });
      }
      ack();
      return;
    }
    const tmuxModelText = appendModelContextText(
      modelText,
      msg.contextText,
    );
    const { text, truncated } = sanitizeInput(tmuxModelText);
    if (truncated) {
      console.warn(`[bridge-manager] tmux provider input truncated from ${tmuxModelText.length} to ${text.length} chars for chat ${msg.address.chatId}`);
      store.insertAuditLog({
        channelType: adapter.channelType,
        chatId: msg.address.chatId,
        direction: 'inbound',
        messageId: msg.messageId,
        summary: `[TRUNCATED] tmux provider input truncated from ${tmuxModelText.length} chars`,
      });
    }
    if (text) {
      const tmuxProviderBridgeSessionId = tmuxProviderChat.bridgeSessionId;
      const tmuxProviderForwardStartedAtMs = Date.now();
      try {
        const tmuxProviderCommandStartedAtMs = Date.now();
        await handleCommand(adapter, msg, `/tmux ${text}`, {
          tmuxProviderAutoForward: true,
          onTmuxProviderAutoForwarded: () => {
            // Get means the tmux input actions completed. It does not claim the
            // TUI has created a turn. Adding it is detached from the message lane.
            addInboundGetReaction(adapter, msg, 'tmux_input_actions_completed');
          },
        });
        const tmuxProviderCommandDurationMs = Date.now() - tmuxProviderCommandStartedAtMs;
        console.log('[bridge-manager] tmux provider auto-forward input actions completed:', {
          event: 'tmux.provider.auto_forward.input_actions_completed',
          session_id: tmuxProviderBridgeSessionId,
          message_id: msg.messageId,
          duration_ms: tmuxProviderCommandDurationMs,
          chars: text.length,
        });
        SESSION_HEALTH_RUNTIME.recordInteractiveStart(
          tmuxProviderBridgeSessionId,
          `已向 ${tmuxProviderRuntime.identity} TUI 注入消息，等待 mirror 同步当前 turn。`,
        );
        scheduleTmuxProviderExitProbe({
          adapter,
          msg,
          sessionId: tmuxProviderBridgeSessionId,
          startedAtMs: tmuxProviderForwardStartedAtMs,
        });
        if (tmuxProviderRuntime.runtime === 'claude') {
          void reconcileClaudeTmuxMirrorAfterAutoForward(
            tmuxProviderBridgeSessionId,
            tmuxProviderForwardStartedAtMs,
          ).catch((error) => {
            console.warn('[bridge-manager] Claude tmux provider mirror reconcile after auto-forward failed:', describeUnknownError(error));
          });
        }
        void trackTmuxSelectionPromptProbeForTarget({
          channelType: msg.address.channelType,
          chatId: msg.address.chatId,
          sessionId: tmuxProviderBridgeSessionId,
          threadId: getSessionCodexThreadId(tmuxProviderSession) || undefined,
        }).catch((error) => {
          console.warn('[bridge-manager] Tmux provider auto-forward selection probe failed:', describeUnknownError(error));
        });
        if (tmuxProviderRuntime.runtime === 'codex') {
          requestTmuxSelectionPromptFollowupProbe(tmuxProviderBridgeSessionId, tmuxProviderForwardStartedAtMs);
        }
        store.insertAuditLog({
          channelType: adapter.channelType,
          chatId: msg.address.chatId,
          direction: 'inbound',
          messageId: msg.messageId,
          summary: [
            'terminal append tmux input actions completed',
            `runtime=${tmuxProviderRuntime.runtime}`,
            'provider=tmux',
            `session=${tmuxProviderBinding?.bridgeSessionId || ''}`,
            `chars=${text.length}`,
          ].join(' '),
        });
      } catch (error) {
        console.error('[bridge-manager] tmux provider command forwarding failed: /tmux', error);
        enqueueBridgeNotice(adapter, msg.address, toUserVisibleCommandError('/tmux', error), {
          replyToMessageId: msg.messageId,
        });
      }
    }
    ack();
    return;
  }

  const terminalAppendBinding = store.getChannelChat(msg.address.channelType, msg.address.chatId);
  const terminalAppendSession = terminalAppendBinding ? store.getSession(terminalAppendBinding.bridgeSessionId) : null;
  const terminalAppendActiveRuntime = getSessionActiveRuntime(terminalAppendSession) || 'codex';
  const terminalAppendCodexProvider = terminalAppendSession
    ? resolveEffectiveCodexProvider(terminalAppendSession, terminalAppendBinding)
    : null;
  const terminalAppendClaudeProvider = terminalAppendSession
    ? resolveEffectiveClaudeProvider(terminalAppendSession, terminalAppendBinding)
    : null;
  if (
    terminalAppendBinding
    && terminalAppendSession
    && INTERACTIVE_RUNTIME.getActiveTask(terminalAppendBinding.bridgeSessionId)
    && !hasAttachments
    && !isBridgeCommandText(rawText)
    && rawText.trim()
    && (
      (terminalAppendActiveRuntime === 'codex' && terminalAppendCodexProvider === 'pty')
      || (terminalAppendActiveRuntime === 'claude' && terminalAppendClaudeProvider === 'pty')
    )
  ) {
    const promptText = appendModelContextText(
      modelText,
      msg.contextText,
    );
    const { text, truncated } = sanitizeInput(promptText);
    if (truncated) {
      console.warn(`[bridge-manager] terminal provider append input truncated from ${promptText.length} to ${text.length} chars for chat ${msg.address.chatId}`);
      store.insertAuditLog({
        channelType: adapter.channelType,
        chatId: msg.address.chatId,
        direction: 'inbound',
        messageId: msg.messageId,
        summary: `[TRUNCATED] terminal provider append input truncated from ${promptText.length} chars`,
      });
    }
    const appended = terminalAppendActiveRuntime === 'claude'
      ? await injectPromptIntoClaudePtySession(terminalAppendBinding.bridgeSessionId, text)
      : await injectPromptIntoActivePty(terminalAppendBinding.bridgeSessionId, text);
    store.insertAuditLog({
      channelType: adapter.channelType,
      chatId: msg.address.chatId,
      direction: 'inbound',
      messageId: msg.messageId,
      summary: [
        appended ? 'terminal append input delivered' : 'terminal append input receiver missing',
        `runtime=${terminalAppendActiveRuntime}`,
        `provider=${terminalAppendActiveRuntime === 'claude' ? terminalAppendClaudeProvider : terminalAppendCodexProvider}`,
        `session=${terminalAppendBinding.bridgeSessionId}`,
        `chars=${text.length}`,
      ].join(' '),
    });
    if (!appended) {
      enqueueBridgeNotice(adapter, msg.address, '当前 terminal provider 还没有可接收追加输入的本地会话，请稍后重试。', {
        replyToMessageId: msg.messageId,
      });
    }
    ack();
    return;
  }

  // Check for IM commands (before sanitization — commands are validated individually).
  // A leading double slash escapes one slash so users can send model prompts
  // that intentionally begin with "/" without invoking bridge commands.
  if (isBridgeCommandText(rawText)) {
    const parts = modelText.split(/\s+/);
    const rawCommand = parts[0].split('@')[0].toLowerCase();
    const args = parts.slice(1).join(' ').trim();
    const resolvedCommand = resolveCommandAlias(rawCommand, args);
    try {
      await handleCommand(adapter, msg, modelText);
    } catch (error) {
      console.error(`[bridge-manager] Command failed: ${resolvedCommand}`, error);
      enqueueBridgeNotice(adapter, msg.address, toUserVisibleCommandError(resolvedCommand, error), {
        replyToMessageId: msg.messageId,
      });
    }
    ack();
    return;
  }

  // Sanitize general message text before routing to conversation engine
  const fullModelText = appendModelContextText(
    modelText,
    msg.contextText,
  );
  const { text, truncated } = sanitizeInput(fullModelText);
  if (truncated) {
    console.warn(`[bridge-manager] Input truncated from ${fullModelText.length} to ${text.length} chars for chat ${msg.address.chatId}`);
    store.insertAuditLog({
      channelType: adapter.channelType,
      chatId: msg.address.chatId,
      direction: 'inbound',
      messageId: msg.messageId,
      summary: `[TRUNCATED] Input truncated from ${fullModelText.length} chars`,
    });
  }

  if (!text && !hasAttachments) { ack(); return; }

  try {
    const displayService = new ThreadDisplayService(store);
    await runInteractiveMessage(adapter, msg, text, hasAttachments ? msg.attachments : undefined, {
      registerInteractiveTask: (task) => INTERACTIVE_RUNTIME.registerInteractiveTask(task),
      registerBridgeTurn: (turn) => TURN_COORDINATOR.registerInteractiveTurn(turn),
      resetMirrorSessionForInteractiveRun,
      isCurrentInteractiveTask: (sessionId, taskId) => INTERACTIVE_RUNTIME.isCurrentInteractiveTask(sessionId, taskId),
      touchInteractiveTask: (sessionId, taskId) => INTERACTIVE_RUNTIME.touchInteractiveTask(sessionId, taskId),
      recordInteractiveHealthStart: (sessionId, detail) => SESSION_HEALTH_RUNTIME.recordInteractiveStart(sessionId, detail),
      recordInteractiveHealthProgress: (sessionId, type, detail) => SESSION_HEALTH_RUNTIME.recordInteractiveProgress(sessionId, type, detail),
      recordInteractiveHealthTool: (sessionId, toolId, toolName, status) => {
        SESSION_HEALTH_RUNTIME.recordToolState(sessionId, toolId, toolName, status);
      },
      recordInteractiveStreamUiSnapshot: (sessionId, snapshot) => {
        SESSION_HEALTH_RUNTIME.recordStructuredStreamUi(sessionId, snapshot);
      },
      recordInteractiveHealthEnd: recordInteractiveHealthEndAndScheduleThen,
      beginMirrorSuppression,
      abortMirrorSuppression,
      settleMirrorSuppression,
      releaseInteractiveTask: (sessionId, taskId) => INTERACTIVE_RUNTIME.releaseInteractiveTask(sessionId, taskId),
      releaseBridgeTurn: (sessionId, taskId) => TURN_COORDINATOR.releaseSessionTurn(sessionId, taskId),
      deliverResponse,
      deliverManualInput: sendAgentMessageFromBinding,
      persistCodexThreadUpdate,
      reconcileMirrorSubscriptions,
      resolveSdkConversationRuntime: () => ({
        store,
        llm: getBridgeContext().llm,
        consumeSseEvents,
        normalizeSandboxMode,
        normalizeReasoningEffort,
      }),
      resolveInteractiveTurnEnvironment: (address, messageId) => {
        return resolveInteractiveTurnEnvironmentBase(address, messageId, {
          resolveBinding: (targetAddress) => router.resolve(targetAddress),
          getBridgeSession: (sessionId) => store.getSession(sessionId),
          codexThreadExists: (threadId) => Boolean(getCodexSessionByThreadIdSafe(threadId, 'interactive turn classify')),
        });
      },
      resolveInteractiveTurnRuntimeSettings: (channelType) => resolveInteractiveTurnRuntimeSettings(
        channelType,
        (key) => store.getSetting(key),
      ),
      forwardPermissionRequest: broker.forwardPermissionRequest,
      buildStopCallbackData: (sessionId) => buildCommandCallbackData('/stop', sessionId),
      resolveInteractiveTurnDisplayInfo: (binding) => displayService.binding(binding, { stripInternalPrefix: true }),
      listInteractiveTurnBindings: (channelType) => store.listChannelChats(channelType),
      codexTerminalFinalizationTimeoutMs: DESKTOP_TERMINAL_FINALIZATION_TIMEOUT_MS,
    });
  } finally {
    ack();
  }
}

/**
 * Handle IM slash commands.
 */
async function handleCommand(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  text: string,
  options: {
    scopedBinding?: ChannelChat | null;
    threadCardRefreshScope?: 'global' | 'bound' | null;
    threadCardSelectedId?: string | null;
    selectedEveryTaskId?: string | null;
    selectedEveryTaskAction?: EveryTaskCardAction | null;
    selectedThenTaskId?: string | null;
    selectedThenTaskAction?: ThenTaskCardAction | null;
    tmuxProviderAutoForward?: boolean;
    onTmuxProviderAutoForwarded?: () => Promise<void> | void;
  } = {},
): Promise<void> {
  await handleBridgeCommand(adapter, msg, text, {
    getActiveTask: (sessionId) => INTERACTIVE_RUNTIME.getActiveTask(sessionId),
    forceStopSession: (sessionId, detail) => INTERACTIVE_RUNTIME.forceStopSession(sessionId, detail),
    recordInteractiveHealthEnd: recordInteractiveHealthEndAndScheduleThen,
    cancelRuntimeWaits: (sessionId) => {
      broker.cancelCodexTuiSelectionWaitersForSession(sessionId);
    },
    reconcileMirrorSubscriptions,
    diagnoseSessionHealth: (sessionId) => SESSION_HEALTH_RUNTIME.diagnoseSessionHealth(sessionId),
    diagnoseAllActiveSessions: () => SESSION_HEALTH_RUNTIME.diagnoseAllActiveSessions(),
    scopedBinding: options.scopedBinding,
    threadCardRefreshScope: options.threadCardRefreshScope,
    threadCardSelectedId: options.threadCardSelectedId,
    selectedEveryTaskId: options.selectedEveryTaskId,
    selectedEveryTaskAction: options.selectedEveryTaskAction,
    selectedThenTaskId: options.selectedThenTaskId,
    selectedThenTaskAction: options.selectedThenTaskAction,
    tmuxProviderAutoForward: options.tmuxProviderAutoForward,
    onTmuxProviderAutoForwarded: options.onTmuxProviderAutoForwarded,
    dispatchPostCommandMessage: (targetAdapter, postCommandMessage) => handleMessage(targetAdapter, postCommandMessage),
    startEveryTask,
    stopEveryTask,
    startThenTask,
    stopThenTask,
    onBindingRemoved: handleBindingRemovedForAutomationTasks,
  });
}

// ── Codex Thread Update Logic ────────────────────────────────

/**
 * Compute the codex_thread_id value to persist after a conversation result.
 * Returns the new value to write, or null if no update is needed.
 *
 * Rules:
   * - If result has a Codex thread id AND no error → save the new ID
 * - If result has a transient Codex resume/process-exit error → keep the
 *   current ID so the next turn stays in the same Codex thread.
   * - If result has another error (regardless of Codex thread id) → clear to empty string
 * - Otherwise → no update needed
 */
export function computeCodexThreadUpdate(
  codexThreadId: string | null | undefined,
  hasError: boolean,
  errorMessage?: string | null,
): string | null {
  if (codexThreadId && !hasError) {
    return codexThreadId;
  }
  if (hasError) {
    if (isTransientCodexResumeError(errorMessage)) {
      return null;
    }
    return '';
  }
  return null;
}

function isTransientCodexResumeError(message: string | null | undefined): boolean {
  const normalized = (message || '').toLowerCase();
  return normalized.includes('上一轮执行进程未正常退出')
    || normalized.includes('timeout waiting for child process to exit')
    || normalized.includes('reconnecting...');
}

function persistCodexThreadUpdate(
  sessionId: string,
  codexThreadId: string | null | undefined,
  hasError: boolean,
  errorMessage?: string | null,
): void {
  const update = computeCodexThreadUpdate(codexThreadId, hasError, errorMessage);
  if (update === null) {
    return;
  }
  const { store } = getBridgeContext();
  store.updateSessionCodexThreadId(sessionId, update);
  if (update) {
    const codexSession = getCodexSessionByThreadIdSafe(update, 'persist codex title');
    if (codexSession?.title) {
      store.updateSession(sessionId, setSessionCodexTitleUpdate(codexSession.title), { touch: false });
    }
  }
}

function resetStateForTests(): void {
  const state = getState();
  state.running = false;
  state.startedAt = null;
  state.adapters.clear();
  state.adapterMeta.clear();
  state.invalidAdapters.clear();
  ADAPTER_RUNTIME.clearWarningCache();
  state.loopAborts.clear();
  state.activeTasks.clear();
  stopAllEveryTasks();
  stopAllConditionMonitors();
  stopAllThenTasks();
  for (const timer of pendingTmuxProviderExitProbeTimers.values()) {
    clearTimeout(timer);
  }
  pendingTmuxProviderExitProbeTimers.clear();
  tmuxProviderExitNoticeLastSentAt.clear();
  tmuxSelectionUpdateNoticeLastSentAt.clear();
  tmuxSelectionPromptMonitors.clear();
  tmuxSelectionPromptLastProbeAt.clear();
  tmuxSelectionPromptFollowupUntil.clear();
  pendingTmuxSelectionPromptProbePromises.clear();
  codexTuiIdleScreenCheckpoints.clear();
  codexTuiTurnScreenBaselines.clear();
  codexTuiIdleScreenMissingCheckedAt.clear();
  codexTuiReconnectMonitors.clear();
  codexTuiModelMismatchNoticesInFlight.clear();
  codexTuiPendingTurnDiagnosticMonitors.clear();
  state.everyTaskSelections.clear();
  state.thenTaskSelections.clear();
  state.thenTaskTimers.clear();
  state.thenSessionQueues.clear();
  clearMirrorSubscriptions();
  state.mirrorSuppressUntil.clear();
  state.mirrorIgnoredTurnIds.clear();
  INTERACTIVE_RUNTIME.resetSessionExecutor();
  TURN_COORDINATOR.clear();
  state.mirrorSyncInFlight = false;
  state.claudeMirrorSyncInFlight = false;
  state.kimiMirrorSyncInFlight = false;
  state.cursorMirrorSyncInFlight = false;
  state.zcodeMirrorSyncInFlight = false;
  state.dailyVersionUpdateRuntime = null;
  if (state.reconcileTimer) {
    clearInterval(state.reconcileTimer);
    state.reconcileTimer = null;
  }
  if (state.mirrorPollTimer) {
    clearInterval(state.mirrorPollTimer);
    state.mirrorPollTimer = null;
  }
  if (state.mirrorWakeTimer) {
    clearTimeout(state.mirrorWakeTimer);
    state.mirrorWakeTimer = null;
  }
  if (state.claudeMirrorWakeTimer) {
    clearTimeout(state.claudeMirrorWakeTimer);
    state.claudeMirrorWakeTimer = null;
  }
  if (state.kimiMirrorWakeTimer) {
    clearTimeout(state.kimiMirrorWakeTimer);
    state.kimiMirrorWakeTimer = null;
  }
  if (state.cursorMirrorWakeTimer) {
    clearTimeout(state.cursorMirrorWakeTimer);
    state.cursorMirrorWakeTimer = null;
  }
  if (state.zcodeMirrorWakeTimer) {
    clearTimeout(state.zcodeMirrorWakeTimer);
    state.zcodeMirrorWakeTimer = null;
  }
}

// ── Test-only export ─────────────────────────────────────────
// Exposed so integration tests can exercise handleMessage directly
// without wiring up the full adapter loop.
/** @internal */
export const _testOnly = {
  handleMessage: async (adapter: BaseChannelAdapter, msg: InboundMessage): Promise<void> => {
    await handleMessage(adapter, msg);
    await _testOnlyWaitForDeliveryQueuesForTests(adapter);
  },
  handleMessageWithoutDeliveryWait: handleMessage,
  syncConfiguredAdapters: (options: { startLoops: boolean }) => ADAPTER_RUNTIME.syncConfiguredAdapters(options),
  reconcileMirrorSubscriptions,
  resolveNewWorkingDirectory,
  resolveNewSessionWorkingDirectory,
  resolveCommandAlias,
  adapterSessionLane,
  adapterImmediateLane,
  shouldRouteTerminalAppendInline,
  isBridgeCommandText,
  toModelPromptText,
  appendModelContextText,
  resolveDisplayedModel,
  formatDisplayedModel,
  formatRuntimeTerminalDetail,
  sessionSupportsTmuxSelectionPromptProbe,
  shouldProbeMirrorTmuxSelectionPrompt,
  probeMirrorTmuxSelectionPrompt,
  requestTmuxSelectionPromptFollowupProbe,
  formatBindingChatLabel,
  formatMirrorUserText,
  formatMirrorMessage,
  buildInteractiveStreamKey,
  buildMirrorStreamKey,
  appendMirrorTimeoutNotice,
  buildAdapterConfigFingerprint,
  buildDoctorPromptMessage,
  consumeMirrorRecords,
  consumeBufferedMirrorTurns,
  deliverMirrorTurns,
  flushTimedOutMirrorTurn,
  refreshMirrorStreamingStatus,
  captureCodexTuiIdleScreenCheckpoint,
  ensureCodexTuiIdleScreenCheckpoints,
  assignCodexTuiTurnScreenBaseline,
  observeCodexTuiPendingTurnDiagnostic,
  resolveCodexTuiFinalizedTurnStatus,
  filterSuppressedMirrorRecords,
  isMirrorSuppressed,
  reconcileTerminalSessionRuntimeState: () => INTERACTIVE_RUNTIME.reconcileTerminalSessionRuntimeState(),
  beginMirrorSuppression,
  abortMirrorSuppression,
  settleMirrorSuppression,
  persistCodexThreadUpdate,
  computeCodexThreadUpdate,
  reconcileStartupChannelChats,
  runStartupNotificationFlow,
  deliverStartupNotifications,
  waitForPendingTmuxSelectionPromptProbes,
  startConditionMonitor,
  startPersistedConditionMonitors,
  stopConditionMonitor,
  resetStateForTests,
};
