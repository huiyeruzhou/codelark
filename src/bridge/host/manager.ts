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
} from '../../domain/index.js';
import type { BaseChannelAdapter } from '../../channels/contracts.js';
import type { BridgeSession, BridgeStore, PermissionLinkRecord } from '../../domain/index.js';
import type { FeishuChannelConfig } from '../../channels/types.js';
import { feishuSiteToApiBaseUrl } from '../../channels/feishu/site.js';
import { inspect } from 'node:util';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
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
  sanitizeInput,
} from '../../shared/security/validators.js';
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
  AUTO_TASK_ACTION_CALLBACK_PREFIX,
  AUTO_TASK_SELECT_CALLBACK_PREFIX,
  type AutoTaskCardAction,
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
  flushTimedOutMirrorTurn as flushTimedOutMirrorTurnBase,
  hasPendingMirrorWork as hasPendingMirrorWorkBase,
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
} from '../session/global-config.js';
import {
  getSessionRuntimeTmuxSessionName,
  getSessionCodexThreadId,
  getSessionClaudeCwd,
  getSessionClaudeSessionId,
  getSessionActiveRuntime,
  getSessionSystemPrompt,
  getSessionWorkingDirectory,
  setSessionClaudeIdentityUpdate,
  setSessionCodexTitleUpdate,
} from '../../domain/session-runtime.js';
import {
  buildCodexTuiSelectionChoiceActions,
  createCodexTuiSelectionPromptMonitor,
  markCodexTuiSelectionPromptActionSent,
  observeStableCodexTuiSelectionPrompt,
  parseCodexTuiSelectionPrompt,
  type CodexTuiSelectionPromptMonitor,
} from '../../runtime/codex/tmux-provider.js';
import { tmuxCore } from '../tmux/runtime.js';
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
  getAutoTask,
  listAutoTasks,
  pauseAutoTasksForSession,
  updateAutoTask,
  type AutoTask,
} from '../automation/auto-tasks.js';
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
import { deliverBridgeNotice, deliverResponse } from '../../channels/delivery/feedback.js';
import { routeCodexRecords, routeRuntimeRecords } from '../turn/local-codex-terminal-router.js';
import { createTurnCoordinator } from '../turn/turn-coordinator.js';
import type { BridgeTurnTerminalRecord } from '../turn/turn-types.js';
import { consumeSseEvents } from '../../runtime/sse-stream-decoder.js';
import { consumePendingClearConfirmation } from '../command/clear-confirmations.js';
import { consumePendingTakeoverConfirmation } from '../command/takeover-confirmations.js';
import { consumeStartupNoticeTarget } from './startup-notice-target.js';

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
const MIRROR_STREAM_STATUS_IDLE_START_MS = 180_000;
const MIRROR_STREAM_STATUS_HEARTBEAT_MS = 10_000;
const MIRROR_TMUX_SELECTION_PROBE_INTERVAL_MS = 5_000;
const MIRROR_TMUX_SELECTION_PROBE_FOLLOWUP_WINDOW_MS = 5_000;
const MIRROR_TMUX_SELECTION_PROBE_FOLLOWUP_INTERVAL_MS = 300;
const TMUX_AUTO_FORWARD_SELECTION_PROBE_TIMEOUT_MS = 5_000;
const TMUX_AUTO_FORWARD_SELECTION_PROBE_INTERVAL_MS = 300;
const TMUX_SCREEN_STOP_CALLBACK_PREFIX = 'tmux-screen:stop:';
const PTY_SCREEN_STOP_CALLBACK_PREFIX = 'pty-screen:stop:';
const TMUX_AUTO_FORWARD_TYPING_REACTION = 'Typing';
// Timeout after the last Codex event before we flush a buffered mirror turn
// without seeing task_complete. This is an internal mirror buffer guard, not an
// IM idle reminder. Active streaming turns never use this fallback timeout.
const MIRROR_TURN_BUFFER_TIMEOUT_MS = 10 * 60_000;
const STARTUP_NOTICE_TITLE = 'Bridge 已启动';
const STARTUP_NOTICE_CARD_TEMPLATE = 'turquoise';
const AUTO_SCRIPT_OUTPUT_LIMIT = 64_000;
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

interface PendingTmuxAutoForwardReaction {
  channelType: string;
  chatId: string;
  sessionId: string;
  messageId: string;
  reactionId: string;
}

const pendingTmuxAutoForwardReactions = new Map<string, PendingTmuxAutoForwardReaction>();
const tmuxSelectionPromptMonitors = new Map<string, CodexTuiSelectionPromptMonitor>();
const tmuxSelectionPromptLastProbeAt = new Map<string, number>();
const tmuxSelectionPromptFollowupUntil = new Map<string, number>();

interface TmuxSelectionPromptTarget {
  channelType: string;
  chatId: string;
  sessionId: string;
  threadId?: string;
}

function tmuxAutoForwardReactionKey(channelType: string, chatId: string, sessionId: string): string {
  return `${channelType}:${chatId}:${sessionId}`;
}

async function clearPendingTmuxAutoForwardReaction(key: string): Promise<void> {
  const pending = pendingTmuxAutoForwardReactions.get(key);
  if (!pending) return;
  pendingTmuxAutoForwardReactions.delete(key);
  const adapter = getState().adapters.get(pending.channelType);
  if (typeof adapter?.removeMessageReaction !== 'function') return;
  try {
    await adapter.removeMessageReaction(pending.messageId, pending.reactionId, TMUX_AUTO_FORWARD_TYPING_REACTION);
  } catch (error) {
    console.warn('[bridge-manager] Failed to remove tmux auto-forward typing reaction:', describeUnknownError(error));
  }
}

function shouldProbeMirrorTmuxSelectionPrompt(
  subscription: BridgeMirrorSubscription,
  nowMs: number,
): boolean {
  const followupUntil = tmuxSelectionPromptFollowupUntil.get(subscription.sessionId) || 0;
  const inFollowupWindow = nowMs <= followupUntil;
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

async function handleTmuxSelectionPromptForTarget(
  target: TmuxSelectionPromptTarget,
  prompt: NonNullable<ReturnType<typeof observeStableCodexTuiSelectionPrompt>>,
  targetPane: string,
): Promise<void> {
  const adapter = getState().adapters.get(target.channelType);
  if (!adapter || !adapter.isRunning()) return;
  const permissionRequestId = `codex-selection:${prompt.kind}:mirror:${target.sessionId}:${Date.now()}`;
  const choicePromise = broker.waitForCodexTuiSelectionPermission(permissionRequestId);
  await broker.forwardPermissionRequest(
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
      defaultChoice: prompt.kind === 'update'
        ? 'skip'
        : prompt.kind === 'goal'
          ? 'cancel'
          : prompt.kind === 'generic'
            ? 'not_selection'
            : 'yes_proceed',
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
    return;
  }
  const actions = buildCodexTuiSelectionChoiceActions(prompt, choice);
  if (choice === 'not_selection' || actions.length === 0) {
    console.log('[bridge-manager] Codex TUI generic selection dismissed from mirror probe:', {
      session_id: target.sessionId,
      thread_id: target.threadId,
      prompt_kind: prompt.kind,
      choice,
    });
    return;
  }
  const result = await tmuxCore.sendActions(targetPane, actions);
  console.log('[bridge-manager] Codex TUI selection prompt resolved from mirror probe:', {
    session_id: target.sessionId,
    thread_id: target.threadId,
    prompt_kind: prompt.kind,
    choice,
    commands: result.commands,
  });
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

async function recoverMirrorTmuxSelectionPromptFromCallback(
  claim: broker.CodexSelectionCallbackClaim,
): Promise<{ ok: boolean; notice: string }> {
  const sessionId = claim.link.sessionId || parseMirrorCodexSelectionSessionId(claim.permissionRequestId);
  if (!sessionId) {
    return { ok: false, notice: 'Codex TUI Selection 已记录，但无法从回调中恢复目标会话。' };
  }
  const session = getBridgeContext().store.getSession(sessionId);
  if (!session) {
    return { ok: false, notice: `Codex TUI Selection 已记录，但找不到目标会话 ${sessionId}。` };
  }
  const activeRuntime = getSessionActiveRuntime(session);
  const isTmuxRuntime = activeRuntime === 'claude'
    ? resolveEffectiveClaudeProvider(session) === 'tmux'
    : resolveEffectiveCodexProvider(session) === 'tmux';
  if (!isTmuxRuntime) {
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
    return { ok: false, notice: `Codex TUI Selection 已记录，但读取 tmux pane 失败：${describeUnknownError(error)}` };
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
    const result = await tmuxCore.sendActions(targetPane, actions);
    console.log('[bridge-manager] Codex TUI selection prompt recovered from callback after waiter loss:', {
      permission_request_id: claim.permissionRequestId,
      session_id: sessionId,
      prompt_kind: prompt.kind,
      choice: claim.choice,
      commands: result.commands,
    });
    return { ok: true, notice: `Codex TUI Selection 已恢复并发送到 tmux：${claim.choice}` };
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

async function probeMirrorTmuxSelectionPrompt(subscription: BridgeMirrorSubscription, nowMs = Date.now()): Promise<void> {
  if (!shouldProbeMirrorTmuxSelectionPrompt(subscription, nowMs)) return;
  tmuxSelectionPromptLastProbeAt.set(subscription.sessionId, nowMs);
  const session = getBridgeContext().store.getSession(subscription.sessionId);
  if (!session) return;
  const activeRuntime = getSessionActiveRuntime(session);
  const isTmuxRuntime = activeRuntime === 'claude'
    ? resolveEffectiveClaudeProvider(session) === 'tmux'
    : resolveEffectiveCodexProvider(session) === 'tmux';
  if (!isTmuxRuntime) return;
  const tmuxSessionName = getSessionRuntimeTmuxSessionName(session);
  if (!tmuxSessionName) return;
  const targetPane = `${tmuxSessionName}:0.0`;
  let capture;
  try {
    capture = await tmuxCore.capturePane(targetPane, 80);
  } catch (error) {
    console.warn('[bridge-manager] Mirror tmux selection probe failed:', {
      session_id: subscription.sessionId,
      tmux_session: tmuxSessionName,
      error: describeUnknownError(error),
    });
    return;
  }
  const monitor = getTmuxSelectionPromptMonitor(subscription.sessionId);
  const prompt = observeStableCodexTuiSelectionPrompt(capture.screen, monitor);
  if (!prompt) {
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

async function probeTmuxSelectionPromptForTarget(
  target: TmuxSelectionPromptTarget,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const session = getBridgeContext().store.getSession(target.sessionId);
  if (!session) return false;
  const activeRuntime = getSessionActiveRuntime(session);
  const isTmuxRuntime = activeRuntime === 'claude'
    ? resolveEffectiveClaudeProvider(session) === 'tmux'
    : resolveEffectiveCodexProvider(session) === 'tmux';
  if (!isTmuxRuntime) return false;
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

function getPendingPermissionLinksForCurrentSession(
  chatId: string,
  sessionId?: string,
): PermissionLinkRecord[] {
  const { store } = getBridgeContext();
  const pending = store.listPendingPermissionLinksByChat(chatId);
  if (!sessionId) return pending;
  return pending.filter((link) => !link.sessionId || link.sessionId === sessionId);
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
}


/**
 * Check if a message looks like a numeric permission shortcut (1/2/3) for
 * Feishu channels WITH at least one pending permission in that chat.
 *
 * This is used by the adapter loop to route these messages to the inline
 * (non-session-locked) path, avoiding deadlock: the session is blocked
 * waiting for the permission to be resolved, so putting "1" behind the
 * session lock would deadlock.
 */
function isNumericPermissionShortcut(channelType: string, rawText: string, chatId: string): boolean {
  if (channelType !== 'feishu') return false;
  const normalized = rawText.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  if (!/^[123]$/.test(normalized)) return false;
  const { store } = getBridgeContext();
  const pending = store.listPendingPermissionLinksByChat(chatId);
  return pending.length > 0; // any pending → route to inline path
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
  mirrorSuppressUntil: Map<string, MirrorSuppressionState[]>;
  mirrorIgnoredTurnIds: Map<string, Map<string, number>>;
  threadCardSelections: Map<string, string>;
  autoTaskSelections: Map<string, string>;
  autoTaskRuntimes: Map<string, AutoTaskRuntimeState>;
  autoStartChecked: boolean;
}

interface AutoTaskRuntimeState {
  abortController: AbortController;
  bridgeSessionId: string;
  activeBridgeSessionId?: string;
  child: ChildProcessWithoutNullStreams | null;
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
      mirrorSuppressUntil: new Map(),
      mirrorIgnoredTurnIds: new Map(),
      threadCardSelections: new Map(),
      autoTaskSelections: new Map(),
      autoTaskRuntimes: new Map(),
      queuedCounts: new Map(),
      sessionLocks: new Map(),
      autoStartChecked: false,
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
  if (!g[GLOBAL_KEY].autoTaskSelections) {
    g[GLOBAL_KEY].autoTaskSelections = new Map();
  }
  if (!g[GLOBAL_KEY].autoTaskRuntimes) {
    g[GLOBAL_KEY].autoTaskRuntimes = new Map();
  }
  if (!Object.prototype.hasOwnProperty.call(g[GLOBAL_KEY], 'mirrorSyncInFlight')) {
    g[GLOBAL_KEY].mirrorSyncInFlight = false;
  }
  if (!Object.prototype.hasOwnProperty.call(g[GLOBAL_KEY], 'claudeMirrorSyncInFlight')) {
    g[GLOBAL_KEY].claudeMirrorSyncInFlight = false;
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

const INTERACTIVE_RUNTIME = createInteractiveRuntime(getState, {
  getStore: () => getBridgeContext().store,
  nowIso,
});

function formatCodexTerminalDetail(terminal: BridgeTurnTerminalRecord): string {
  if (terminal.runtime === 'claude') {
    if (terminal.outcome === 'aborted') {
      return '检测到 Claude Code 会话已停止当前任务。';
    }
    if (terminal.outcome === 'failed') {
      return '检测到 Claude Code 会话当前任务执行失败。';
    }
    return '检测到 Claude Code 会话已完成当前任务。';
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
    formatCodexTerminalDetail(terminal),
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
      (typeof idleStartSeconds === 'number' && Number.isFinite(idleStartSeconds) && idleStartSeconds > 0
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

const MIRROR_FEEDBACK = createMirrorFeedbackController({
  getAdapter: (channelType) => getState().adapters.get(channelType) || null,
  getThreadTitle: getMirrorThreadTitle,
  getRuntimeTags: getMirrorRuntimeTags,
  onMirrorStreamStart: (subscription) => {
    const key = tmuxAutoForwardReactionKey(subscription.channelType, subscription.chatId, subscription.sessionId);
    void clearPendingTmuxAutoForwardReaction(key);
  },
  getStructuredStreamStatusConfig: getMirrorStructuredStreamStatusConfig,
  nowIso,
  eventBatchLimit: MIRROR_EVENT_BATCH_LIMIT,
  deliverResponse,
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

function resetMirrorSessionForInteractiveRun(sessionId: string): void {
  MIRROR_RUNTIME.resetMirrorSessionForInteractiveRun(sessionId);
  CLAUDE_MIRROR_RUNTIME.resetMirrorSessionForInteractiveRun(sessionId);
}

async function reconcileMirrorSubscriptions(): Promise<void> {
  await MIRROR_RUNTIME.reconcileMirrorSubscriptions();
  await CLAUDE_MIRROR_RUNTIME.reconcileMirrorSubscriptions();
  const nowMs = Date.now();
  await Promise.allSettled(
    [
      ...Array.from(getState().mirrorSubscriptions.values()),
      ...Array.from(getState().claudeMirrorSubscriptions.values()),
    ].map((subscription) =>
      probeMirrorTmuxSelectionPrompt(subscription, nowMs),
    ),
  );
  refreshActiveMirrorStreamingStatuses();
}

function clearMirrorSubscriptions(): void {
  MIRROR_RUNTIME.clearMirrorSubscriptions();
  CLAUDE_MIRROR_RUNTIME.clearMirrorSubscriptions();
}

function shouldRouteTerminalAppendInline(msg: InboundMessage): boolean {
  const rawText = msg.text.trim();
  if (!rawText || msg.channelEvent || msg.callbackData || isBridgeCommandText(rawText)) return false;
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
  if (resolvedCommand === '/stop' || resolvedCommand === '/perm') return true;
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
    || resolvedCommand === '/shell';
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

function adapterImmediateLane(msg: InboundMessage, category: 'channel-event' | 'callback' | 'command' | 'permission-shortcut' | 'bypass' | 'regular'): { laneKey: string; laneKind: 'control' | 'job'; jobKind: string } | null {
  if (category === 'channel-event' || category === 'permission-shortcut') {
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
  if (category === 'command' && isReadOnlyOrLongIoCommandText(msg.text)) {
    const resolvedCommand = resolveInboundCommandText(msg.text);
    return {
      laneKey: `job:${resolvedCommand.slice(1)}:${msg.address.channelType}:${msg.address.chatId}:${msg.messageId || 'command'}`,
      laneKind: 'job',
      jobKind: `command:${resolvedCommand.slice(1)}`,
    };
  }
  return null;
}

function adapterSessionLane(msg: InboundMessage, category: 'channel-event' | 'callback' | 'command' | 'permission-shortcut' | 'bypass' | 'regular'): { sessionId: string; jobKind: string; blocksConversation?: boolean } | null {
  if (category === 'command') {
    const lane = sessionMutatingCommandLane(msg.text);
    if (!lane) return null;
    const binding = getBridgeContext().store.getChannelChat(msg.address.channelType, msg.address.chatId);
    if (!binding) return null;
    return { sessionId: binding.bridgeSessionId, jobKind: lane.jobKind, blocksConversation: lane.blocksConversation };
  }

  if (category === 'callback' && msg.callbackData) {
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
  isNumericPermissionShortcut,
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
  startPersistedAutoTasks();

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
  stopAllAutoTasks();
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

    const session = store.getSession(binding.bridgeSessionId);
    const bindingsBeforeArchive = store.listChannelChats()
      .filter((candidateBinding) => candidateBinding.bridgeSessionId === binding.bridgeSessionId);
    const threadId = session ? getBridgeSessionCodexThreadId(session) : null;
    let detail = 'provider chat not found';
    if (threadId) {
      try {
        archiveCodexSession(threadId);
        detail = `archived Codex thread ${threadId.slice(0, 8)}`;
      } catch (error) {
        detail = `Codex archive skipped: ${error instanceof Error ? error.message : String(error)}`;
      }
    }

    if (session) {
      store.deleteSession(session.id);
    } else {
      store.deleteChannelChat(binding.id);
    }
    for (const removed of bindingsBeforeArchive.length > 0 ? bindingsBeforeArchive : [binding]) {
      handleBindingRemovedForAutoTasks(removed);
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

function startPersistedAutoTasks(): void {
  const tasks = listAutoTasks({ includeCompleted: false })
    .filter((task) => task.status === 'running' && shouldStartAutoTask(task));
  for (const task of tasks) {
    startAutoTask(task.id);
  }
}

function isIntervalAutoTask(task: AutoTask): boolean {
  return task.kind === 'interval';
}

function shouldStartAutoTask(task: AutoTask): boolean {
  return isIntervalAutoTask(task) || task.triggeredCount < task.times;
}

function startAutoTask(taskId: string): void {
  const state = getState();
  if (state.autoTaskRuntimes.has(taskId)) return;
  const task = getAutoTask(taskId);
  if (!task || task.status !== 'running' || !shouldStartAutoTask(task)) return;

  const abortController = new AbortController();
  state.autoTaskRuntimes.set(taskId, {
    abortController,
    bridgeSessionId: task.bridgeSessionId,
    child: null,
  });
  void runAutoTaskLoop(taskId, abortController).finally(() => {
    state.autoTaskRuntimes.delete(taskId);
  });
}

function stopAutoTask(taskId: string): void {
  const runtime = getState().autoTaskRuntimes.get(taskId);
  if (!runtime) return;
  runtime.abortController.abort();
  runtime.child?.kill();
  void INTERACTIVE_RUNTIME.forceStopSession(
    runtime.activeBridgeSessionId || runtime.bridgeSessionId,
    '自动化任务已删除，正在中止后台触发。',
  ).catch((error) => {
    console.error('[bridge-manager] Failed to stop auto task interactive turn:', describeUnknownError(error));
  });
}

function stopAllAutoTasks(): void {
  for (const taskId of Array.from(getState().autoTaskRuntimes.keys())) {
    stopAutoTask(taskId);
  }
  getState().autoTaskRuntimes.clear();
}

async function runAutoTaskLoop(taskId: string, abortController: AbortController): Promise<void> {
  while (!abortController.signal.aborted) {
    const task = getAutoTask(taskId);
    if (!task || task.status !== 'running') return;
    if (!isIntervalAutoTask(task) && task.triggeredCount >= task.times) {
      updateAutoTask(task.id, { status: 'completed' });
      return;
    }

    const session = getBridgeContext().store.getSession(task.bridgeSessionId);
    if (!session) {
      updateAutoTask(task.id, {
        status: 'failed',
        lastError: `Bridge session 不存在：${task.bridgeSessionId}`,
      });
      return;
    }
    const runtimeLabel = getSessionActiveRuntime(session) === 'claude' ? 'Claude Code' : 'Codex';

    const rawPrompt = isIntervalAutoTask(task)
      ? await waitForIntervalAutoPrompt(task, abortController)
      : await runScriptAutoPrompt(task, session, abortController);
    if (abortController.signal.aborted) return;
    if (getAutoTask(task.id)?.status === 'failed') return;
    if (!rawPrompt) {
      updateAutoTask(task.id, { status: 'failed', lastError: `脚本没有输出 stdout，无法构造 ${runtimeLabel} prompt。` });
      await deliverAutoTaskNotice(task, isIntervalAutoTask(task) ? '自动化任务 prompt 为空。' : `自动化脚本没有输出 stdout，无法构造 ${runtimeLabel} prompt。`);
      return;
    }

    const { text: prompt, truncated } = sanitizeInput(rawPrompt, AUTO_SCRIPT_OUTPUT_LIMIT);
    const nextTriggeredCount = task.triggeredCount + 1;
    updateAutoTask(task.id, {
      triggeredCount: nextTriggeredCount,
      lastTriggeredAt: nowIso(),
      lastError: truncated ? `脚本 stdout 过长，已截断后发送给 ${runtimeLabel}。` : undefined,
    });

    try {
      await runAutoTaskPrompt(task, session, prompt, nextTriggeredCount, abortController);
    } catch (error) {
      if (abortController.signal.aborted) return;
      const detail = describeUnknownError(error);
      updateAutoTask(task.id, { status: 'failed', lastError: detail });
      await deliverAutoTaskNotice(task, `自动化任务触发 ${runtimeLabel} 失败：\n\n${detail}`);
      return;
    }

    if (abortController.signal.aborted) return;
    if (!isIntervalAutoTask(task) && nextTriggeredCount >= task.times) {
      updateAutoTask(task.id, { status: 'completed' });
      return;
    }
  }
}

async function waitForIntervalAutoPrompt(task: AutoTask, abortController: AbortController): Promise<string> {
  const intervalMs = Math.max(1, task.intervalSeconds || 1) * 1000;
  await abortableDelay(intervalMs, abortController.signal);
  return task.prompt || '';
}

async function runScriptAutoPrompt(
  task: AutoTask,
  session: BridgeSession,
  abortController: AbortController,
): Promise<string> {
  let scriptResult: AutoScriptRunResult;
  try {
    scriptResult = await runAutoScript(task, session, abortController);
  } catch (error) {
    if (abortController.signal.aborted) return '';
    const detail = describeUnknownError(error);
    updateAutoTask(task.id, { status: 'failed', lastError: detail });
    await deliverAutoTaskNotice(task, `自动化脚本执行失败：\n\n${detail}`);
    return '';
  }

  if (abortController.signal.aborted) return '';
  if (scriptResult.exitCode !== 0) {
    const detail = [
      `exit_code: ${scriptResult.exitCode}`,
      scriptResult.stderr.trim() ? `stderr:\n${scriptResult.stderr.trim()}` : null,
    ].filter(Boolean).join('\n\n');
    updateAutoTask(task.id, { status: 'failed', lastError: detail });
    await deliverAutoTaskNotice(task, `自动化脚本执行失败：\n\n${detail}`);
    return '';
  }
  return scriptResult.stdout.trim();
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

interface AutoScriptRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

async function runAutoScript(
  task: AutoTask,
  session: BridgeSession,
  abortController: AbortController,
): Promise<AutoScriptRunResult> {
  return await new Promise((resolve, reject) => {
    const runtime = getState().autoTaskRuntimes.get(task.id);
    if (!task.scriptPath) {
      reject(new Error('脚本路径为空。'));
      return;
    }
    const child = spawn(task.scriptPath, [], {
      cwd: getSessionWorkingDirectory(session) || process.cwd(),
      env: process.env,
      windowsHide: true,
    });
    if (runtime) runtime.child = child;

    let stdout = '';
    let stderr = '';
    const onAbort = () => {
      child.kill();
    };
    const cleanup = () => {
      abortController.signal.removeEventListener('abort', onAbort);
      if (runtime) runtime.child = null;
    };
    const appendLimited = (current: string, chunk: Buffer): string => (
      (current + chunk.toString('utf-8')).slice(-AUTO_SCRIPT_OUTPUT_LIMIT)
    );
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = appendLimited(stdout, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = appendLimited(stderr, chunk);
    });
    child.on('error', (error) => {
      cleanup();
      reject(error);
    });
    child.on('close', (code) => {
      cleanup();
      resolve({ stdout, stderr, exitCode: code });
    });

    abortController.signal.addEventListener('abort', onAbort, { once: true });
    if (abortController.signal.aborted) {
      onAbort();
    }
  });
}

async function runAutoTaskPrompt(
  task: AutoTask,
  session: BridgeSession,
  prompt: string,
  triggeredCount: number,
  abortController: AbortController,
): Promise<void> {
  const adapter = getState().adapters.get(task.channelType);
  if (!adapter?.isRunning()) {
    updateAutoTask(task.id, {
      status: 'failed',
      lastError: `通道未运行：${task.channelType}`,
    });
    return;
  }

  const address = autoTaskAddress(task);
  const runSession = isIntervalAutoTask(task)
    ? createAutoRunSession(task, session, prompt, triggeredCount)
    : session;
  const runtime = getState().autoTaskRuntimes.get(task.id);
  if (runtime) runtime.activeBridgeSessionId = runSession.id;
  const syntheticBinding = buildAutoTaskBinding(task, runSession);
  const messageId = `auto:${task.id}:${triggeredCount}`;
  const msg: InboundMessage = {
    address,
    text: prompt,
    messageId,
    timestamp: Date.now(),
  };
  const displayService = new ThreadDisplayService(getBridgeContext().store);

  await runInteractiveMessage(adapter, msg, prompt, undefined, {
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
    recordInteractiveHealthEnd: (sessionId, outcome, detail) => SESSION_HEALTH_RUNTIME.recordInteractiveEnd(sessionId, outcome, detail),
    beginMirrorSuppression,
    abortMirrorSuppression,
    settleMirrorSuppression,
    releaseInteractiveTask: (sessionId, taskStateId) => INTERACTIVE_RUNTIME.releaseInteractiveTask(sessionId, taskStateId),
    releaseBridgeTurn: (sessionId, taskStateId) => TURN_COORDINATOR.releaseSessionTurn(sessionId, taskStateId),
    deliverResponse: (targetAdapter, targetAddress, responseText, sessionId, _replyToMessageId, attachments) => (
      deliverResponse(targetAdapter, targetAddress, responseText, sessionId, undefined, attachments)
    ),
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
        codexThreadExists: () => false,
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

  if (abortController.signal.aborted) {
    await INTERACTIVE_RUNTIME.forceStopSession(
      runSession.id,
      '自动化任务已中止。',
    );
  }
  if (runtime) runtime.activeBridgeSessionId = undefined;
}

function createAutoRunSession(
  task: AutoTask,
  parentSession: BridgeSession,
  prompt: string,
  triggeredCount: number,
): BridgeSession {
  const store = getBridgeContext().store;
  const name = `Auto: ${(prompt || task.id).replace(/\s+/g, ' ').trim().slice(0, 48)} #${triggeredCount}`;
  const parentRuntimePatch = sessionCodexRuntimeOverridePatch(parentSession);
  const session = store.createSession(
    name,
    '',
    getSessionSystemPrompt(parentSession),
    getSessionWorkingDirectory(parentSession),
    'normal',
    {
      parentSessionId: parentSession.id,
    },
  );
  store.updateSession(session.id, {
    provider_id: parentSession.provider_id,
  }, { touch: false });
  if (parentRuntimePatch.runtime?.codex) {
    createConfigService({ migrate: false }).set(
      { kind: 'session', sessionId: session.id },
      parentRuntimePatch,
    );
  }
  return store.getSession(session.id) || session;
}

function buildAutoTaskBinding(task: AutoTask, session: BridgeSession): ChannelChat {
  const timestamp = nowIso();
  return {
    id: `auto:${task.id}`,
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

function autoTaskAddress(task: AutoTask): ChannelAddress {
  return {
    channelType: task.channelType,
    channelProvider: task.channelProvider,
    channelAlias: task.channelAlias,
    chatId: task.chatId,
    userId: task.chatUserId,
    displayName: task.chatDisplayName,
  };
}

async function deliverAutoTaskNotice(task: AutoTask, text: string): Promise<void> {
  const adapter = getState().adapters.get(task.channelType);
  if (!adapter?.isRunning()) return;
  await deliverBridgeNotice(adapter, autoTaskAddress(task), text, {
    sessionId: task.bridgeSessionId,
    audit: true,
  });
}

function handleBindingRemovedForAutoTasks(binding: ChannelChat): void {
  const paused = pauseAutoTasksForSession(binding.bridgeSessionId);
  for (const task of paused) {
    stopAutoTask(task.id);
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

function autoTaskSelectionKey(msg: InboundMessage): string {
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
  });
}

function archiveLifecycleBindingSession(
  store: BridgeStore,
  binding: ChannelChat,
): {
  action: 'codex_archive' | 'claude_archive' | 'bridge_delete' | 'delete_after_archive_failure' | 'binding_delete';
  codexThreadId?: string;
  claudeSessionId?: string;
  claudeCwd?: string;
  deletedBridgeSessionIds: string[];
  error?: unknown;
} {
  const session = store.getSession(binding.bridgeSessionId);
  if (!session) {
    store.deleteChannelChat(binding.id);
    return { action: 'binding_delete', deletedBridgeSessionIds: [] };
  }

  const registry = createLifecycleSessionRegistry(store);
  const codexThreadId = getBridgeSessionCodexThreadId(session);
  const activeRuntime = getSessionActiveRuntime(session);
  const claudeSessionId = activeRuntime === 'claude' ? getSessionClaudeSessionId(session) || undefined : undefined;
  const claudeCwd = activeRuntime === 'claude' ? getSessionClaudeCwd(session) || getSessionWorkingDirectory(session) || undefined : undefined;
  try {
    if (codexThreadId) {
      const result = registry.archiveCodexThread(codexThreadId);
      return {
        action: 'codex_archive',
        codexThreadId,
        deletedBridgeSessionIds: result.deletedBridgeSessionIds,
      };
    }
    if (claudeSessionId && claudeCwd) {
      const result = registry.archiveClaudeThread(claudeSessionId, claudeCwd);
      return {
        action: 'claude_archive',
        claudeSessionId,
        claudeCwd,
        deletedBridgeSessionIds: result.deletedBridgeSessionIds,
      };
    }

    const result = registry.deleteBridgeSession(session.id);
    return {
      action: 'bridge_delete',
      deletedBridgeSessionIds: result.deletedBridgeSessionIds,
    };
  } catch (error) {
    console.error('[bridge-manager] Failed to archive ChannelChat session after channel lifecycle event; deleting BridgeSession fallback:', describeUnknownError(error));
    store.deleteSession(session.id);
    return {
      action: 'delete_after_archive_failure',
      codexThreadId,
      claudeSessionId,
      claudeCwd,
      deletedBridgeSessionIds: [session.id],
      error,
    };
  }
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
  const archiveResult = archiveLifecycleBindingSession(store, binding);
  for (const removedBinding of bindingsBeforeArchive) {
    handleBindingRemovedForAutoTasks(removedBinding);
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
        `deleted_sessions=${archiveResult.deletedBridgeSessionIds.length}`,
      ].filter(Boolean).join('; '),
    });
  } catch { /* best effort */ }

  await reconcileMirrorSubscriptions().catch((err) => {
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

function buildCloudDocumentChatContextText(binding?: ChannelChat | null): string {
  const cloudDocument = binding?.cloudDocumentChat;
  if (!cloudDocument) return '';
  const docHost = cloudDocument.provider === 'feishu' ? 'https://feishu.cn' : '';
  const docUrl = docHost ? `${docHost}/${cloudDocument.fileType}/${cloudDocument.fileToken}` : '';
  return [
    '<cloud_document_chat>',
    '这个群聊已绑定为飞书云文档聊天入口。回答用户问题时，请结合这个绑定文档的上下文；如果需要读取正文，请优先使用 lark-cli。',
    '文档信息：',
    docUrl ? `- 链接：${docUrl}` : '',
    `- file_type：${cloudDocument.fileType}`,
    `- file_token：${cloudDocument.fileToken}`,
    cloudDocument.commentId ? `- comment_id：${cloudDocument.commentId}` : '',
    '可用命令：',
    `- 读取：lark-cli docs +fetch --api-version v2 --as bot --doc ${cloudDocument.fileToken}`,
    `- 追加：lark-cli docs +update --api-version v2 --as bot --doc ${cloudDocument.fileToken} --mode append --markdown '<内容>'`,
    '</cloud_document_chat>',
  ].filter(Boolean).join('\n');
}

function appendModelContextText(text: string, ...contextTexts: Array<string | undefined>): string {
  const trimmedContext = contextTexts.map((contextText) => contextText?.trim()).filter(Boolean).join('\n\n');
  if (!trimmedContext) return text;
  const trimmedText = text.trim();
  if (!trimmedText) return trimmedContext;
  return `${trimmedText}\n\n${trimmedContext}`;
}

function parseThreadSelectCallback(callbackData: string): string | null | undefined {
  if (!callbackData.startsWith(THREAD_SELECT_CALLBACK_PREFIX)) return undefined;
  try {
    return decodeURIComponent(callbackData.slice(THREAD_SELECT_CALLBACK_PREFIX.length)).trim() || null;
  } catch {
    return null;
  }
}

function parseAutoTaskSelectCallback(callbackData: string): string | null | undefined {
  if (!callbackData.startsWith(AUTO_TASK_SELECT_CALLBACK_PREFIX)) return undefined;
  try {
    return decodeURIComponent(callbackData.slice(AUTO_TASK_SELECT_CALLBACK_PREFIX.length)).trim() || null;
  } catch {
    return null;
  }
}

function parseAutoTaskActionCallback(callbackData: string): AutoTaskCardAction | null | undefined {
  if (!callbackData.startsWith(AUTO_TASK_ACTION_CALLBACK_PREFIX)) return undefined;
  const raw = callbackData.slice(AUTO_TASK_ACTION_CALLBACK_PREFIX.length).trim();
  return raw === 'rm' || raw === 'set1' ? raw : null;
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
    const selectedAutoTaskId = parseAutoTaskSelectCallback(msg.callbackData);
    if (selectedAutoTaskId !== undefined) {
      if (!selectedAutoTaskId) {
        await deliverBridgeNotice(adapter, msg.address, '这个下拉选项无效，请刷新后重试。');
      } else {
        getState().autoTaskSelections.set(autoTaskSelectionKey(msg), selectedAutoTaskId);
        await adapter.answerCallback?.(msg.messageId, '已选择');
      }
      ack();
      return;
    }

    const autoTaskAction = parseAutoTaskActionCallback(msg.callbackData);
    if (autoTaskAction !== undefined) {
      if (!autoTaskAction) {
        await deliverBridgeNotice(adapter, msg.address, '这个按钮的操作无效，请刷新后重试。');
        ack();
        return;
      }
      const taskId = getState().autoTaskSelections.get(autoTaskSelectionKey(msg));
      if (!taskId) {
        await deliverBridgeNotice(adapter, msg.address, '请先在下拉列表中选择一个自动化任务，再点击操作按钮。');
        ack();
        return;
      }
      const commandText = autoTaskAction === 'set1' ? '/auto set' : '/auto rm';
      await handleCommand(
        adapter,
        { ...msg, text: commandText, callbackData: undefined },
        commandText,
        { selectedAutoTaskId: taskId, selectedAutoTaskAction: autoTaskAction },
      );
      ack();
      return;
    }

    const selectedThreadId = parseThreadSelectCallback(msg.callbackData);
    if (selectedThreadId !== undefined) {
      if (!selectedThreadId) {
        await deliverBridgeNotice(adapter, msg.address, '这个下拉选项无效，请刷新后重试。');
      } else {
        getState().threadCardSelections.set(threadSelectionKey(msg), selectedThreadId);
        await adapter.answerCallback?.(msg.messageId, '已选择');
      }
      ack();
      return;
    }

    const threadAction = parseThreadSelectActionCallback(msg.callbackData);
    if (threadAction !== undefined) {
      if (!threadAction) {
        await deliverBridgeNotice(adapter, msg.address, '这个按钮的操作无效，请刷新后重试。');
        ack();
        return;
      }
      const threadId = getState().threadCardSelections.get(threadSelectionKey(msg));
      if (!threadId) {
        await deliverBridgeNotice(adapter, msg.address, '请先在下拉列表中选择一个线程，再点击接管或归档。');
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
        await deliverBridgeNotice(adapter, msg.address, '这个按钮的命令数据无效，请改用纯文本命令。');
        ack();
        return;
      }
      let commandText = commandCallback.commandText;
      if (commandText === '/new') {
        const formValue = extractCardActionFormValue(msg.raw);
        if (formValue) {
          const newSessionName = normalizeFormString(formValue.clk_input || formValue.input || formValue.text);
          if (!newSessionName) {
            await deliverBridgeNotice(adapter, msg.address, '请输入群聊名称后再创建。');
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
        await deliverBridgeNotice(adapter, msg.address, '这个按钮对应的会话已不再绑定到当前聊天，请改用纯文本命令确认当前状态。');
        ack();
        return;
      }
      await handleCommand(
        adapter,
        { ...msg, text: commandText, callbackData: undefined },
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
        await deliverBridgeNotice(adapter, msg.address, '这个停止按钮对应的会话已不再绑定到当前聊天，无法停止 tmux 屏幕定时刷新。');
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
        await deliverBridgeNotice(adapter, msg.address, '这个停止按钮对应的会话已不再绑定到当前聊天，无法停止 pty 屏幕定时刷新。');
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
        await deliverBridgeNotice(adapter, msg.address, '这个问题卡片的数据无效，请直接输入文字回复。');
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
      if (codexSelectionClaim?.handledBy === 'orphan'
        && parseMirrorCodexSelectionSessionId(codexSelectionClaim.permissionRequestId)) {
        const recovery = await recoverMirrorTmuxSelectionPromptFromCallback(codexSelectionClaim);
        await deliverBridgeNotice(adapter, msg.address, recovery.notice);
      } else if (codexSelectionClaim) {
        const mirrorSessionId = parseMirrorCodexSelectionSessionId(codexSelectionClaim.permissionRequestId);
        if (mirrorSessionId) {
          requestTmuxSelectionPromptFollowupProbe(mirrorSessionId);
        }
        await deliverBridgeNotice(adapter, msg.address, 'Permission response recorded.');
      }
      ack();
      return;
    }

    const handled = broker.handlePermissionCallback(msg.callbackData, msg.address.chatId, msg.callbackMessageId);
    if (handled) {
      await deliverBridgeNotice(adapter, msg.address, 'Permission response recorded.');
    }
    ack();
    return;
  }

  const rawText = msg.text.trim();
  const hasAttachments = msg.attachments && msg.attachments.length > 0;

  if (rawText && !hasAttachments) {
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
      await deliverBridgeNotice(adapter, msg.address, '已取消接管，当前聊天绑定保持不变。', {
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
      await deliverBridgeNotice(adapter, msg.address, '已取消 /clear，当前对话保持不变。', {
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
      await deliverBridgeNotice(adapter, msg.address, rawData.userVisibleError, {
        replyToMessageId: msg.messageId,
      });
    } else if (rawData?.imageDownloadFailed || rawData?.attachmentDownloadFailed) {
      const failureLabel = rawData.failedLabel || (rawData.imageDownloadFailed ? 'image(s)' : 'attachment(s)');
      await deliverBridgeNotice(adapter, msg.address, `Failed to download ${rawData.failedCount ?? 1} ${failureLabel}. Please try sending again.`, {
        replyToMessageId: msg.messageId,
      });
    }
    ack();
    return;
  }

  // ── Numeric shortcut for permission replies (Feishu only) ──
  // On mobile, typing `/perm allow <uuid>` is painful.
  // If the user sends "1", "2", or "3" and there is exactly one pending
  // permission for this chat, map it: 1→allow, 2→allow_session, 3→deny.
  //
  // Input normalization: mobile keyboards / IM clients may send fullwidth
  // digits (１２３), digits with zero-width joiners, or other Unicode
  // variants. NFKC normalization folds them all to ASCII 1/2/3.
  if (
          adapter.provider === 'feishu'
  ) {
    // eslint-disable-next-line no-control-regex
    const normalized = rawText.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    if (/^[123]$/.test(normalized)) {
      const currentBinding = store.getChannelChat(msg.address.channelType, msg.address.chatId);
      const pendingLinks = getPendingPermissionLinksForCurrentSession(
        msg.address.chatId,
        currentBinding?.bridgeSessionId,
      );
      if (pendingLinks.length === 1) {
        const actionMap: Record<string, string> = { '1': 'allow', '2': 'allow_session', '3': 'deny' };
        const action = actionMap[normalized];
        const permId = pendingLinks[0].permissionRequestId;
        const callbackData = `perm:${action}:${permId}`;
        const handled = broker.handlePermissionCallback(callbackData, msg.address.chatId);
        const label = normalized === '1' ? 'Allow' : normalized === '2' ? 'Allow Session' : 'Deny';
        if (handled) {
          await deliverBridgeNotice(adapter, msg.address, `${label}: recorded.`, {
            replyToMessageId: msg.messageId,
          });
        } else {
          await deliverBridgeNotice(adapter, msg.address, 'Permission not found or already resolved.', {
            replyToMessageId: msg.messageId,
          });
        }
        ack();
        return;
      }
      if (pendingLinks.length > 1) {
        // Multiple pending permissions — numeric shortcut is ambiguous.
        await deliverBridgeNotice(adapter, msg.address, `当前有 ${pendingLinks.length} 条待处理权限，数字快捷回复会有歧义。请使用完整命令：\n/perm allow|allow_session|deny <id>`, {
          replyToMessageId: msg.messageId,
        });
        ack();
        return;
      }
      // pendingLinks.length === 0: no pending permissions, fall through as normal message
    } else if (rawText !== normalized && /^[123]$/.test(rawText) === false) {
      // Log when normalization changed the text — helps diagnose encoding issues
      const codePoints = [...rawText].map(c => 'U+' + c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0'));
      console.log(`[bridge-manager] Shortcut candidate raw codepoints: ${codePoints.join(' ')} → normalized: "${normalized}"`);
    }
  }

  const modelText = toModelPromptText(rawText);
  if (isBridgeCommandText(rawText)) {
    const commandToken = modelText.trim().split(/\s+/)[0] || '';
    const rawCommand = commandToken.split('@')[0].toLowerCase();
    const args = modelText.trim().slice(commandToken.length).trim();
    if (rawCommand === '/doctor') {
      const spec = buildDoctorPromptFromLogs(args);
      await deliverBridgeNotice(adapter, msg.address, spec.notice, {
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
  if (
    tmuxProviderSession
    && tmuxProviderRuntime?.provider === 'tmux'
  ) {
    const tmuxProviderChat = tmuxProviderBinding;
    if (!tmuxProviderChat) {
      ack();
      return;
    }
    if (rawText.trim().toLowerCase() === '//clear') {
      await deliverBridgeNotice(adapter, msg.address, '当前处于 tmux Provider，不能通过 `//clear` 清空上下文。请通过 codelark 手动创建新会话。', {
        replyToMessageId: msg.messageId,
      });
      ack();
      return;
    }
    if (hasAttachments) {
      await deliverBridgeNotice(adapter, msg.address, '当前处于 tmux Provider，普通附件不会自动转发到 TUI。请先发送 `/provider sdk`，或在 TUI 内自行读取本地文件。', {
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
        await deliverBridgeNotice(adapter, msg.address, toUserVisibleCommandError(resolvedCommand, error), {
          replyToMessageId: msg.messageId,
        });
      }
      ack();
      return;
    }
    const tmuxModelText = appendModelContextText(
      modelText,
      msg.contextText,
      buildCloudDocumentChatContextText(tmuxProviderChat),
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
      const reactionKey = tmuxAutoForwardReactionKey(
        msg.address.channelType,
        msg.address.chatId,
        tmuxProviderBridgeSessionId,
      );
      try {
        await handleCommand(adapter, msg, `/tmux ${text}`, {
          tmuxProviderAutoForward: true,
          onTmuxProviderAutoForwarded: async () => {
            if (!msg.messageId || typeof adapter.addMessageReaction !== 'function') return;
            await clearPendingTmuxAutoForwardReaction(reactionKey);
            const reactionId = await adapter.addMessageReaction(msg.messageId, TMUX_AUTO_FORWARD_TYPING_REACTION);
            if (!reactionId) return;
            pendingTmuxAutoForwardReactions.set(reactionKey, {
              channelType: msg.address.channelType,
              chatId: msg.address.chatId,
              sessionId: tmuxProviderBridgeSessionId,
              messageId: msg.messageId,
              reactionId,
            });
          },
        });
        SESSION_HEALTH_RUNTIME.recordInteractiveStart(
          tmuxProviderBridgeSessionId,
          `已向 ${tmuxProviderRuntime.identity} TUI 注入消息，等待 mirror 同步当前 turn。`,
        );
        if (tmuxProviderRuntime.runtime === 'claude') {
          void reconcileClaudeTmuxMirrorAfterAutoForward(
            tmuxProviderBridgeSessionId,
            tmuxProviderForwardStartedAtMs,
          ).catch((error) => {
            console.warn('[bridge-manager] Claude tmux provider mirror reconcile after auto-forward failed:', describeUnknownError(error));
          });
        }
        void probeTmuxSelectionPromptForTarget({
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
            'terminal append input delivered',
            `runtime=${tmuxProviderRuntime.runtime}`,
            'provider=tmux',
            `session=${tmuxProviderBinding?.bridgeSessionId || ''}`,
            `chars=${text.length}`,
          ].join(' '),
        });
      } catch (error) {
        await clearPendingTmuxAutoForwardReaction(reactionKey);
        console.error('[bridge-manager] tmux provider command forwarding failed: /tmux', error);
        await deliverBridgeNotice(adapter, msg.address, toUserVisibleCommandError('/tmux', error), {
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
      (terminalAppendActiveRuntime !== 'claude' && terminalAppendCodexProvider === 'pty')
      || (terminalAppendActiveRuntime === 'claude' && terminalAppendClaudeProvider === 'pty')
    )
  ) {
    const promptText = appendModelContextText(
      modelText,
      msg.contextText,
      buildCloudDocumentChatContextText(terminalAppendBinding),
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
        `runtime=${terminalAppendActiveRuntime === 'claude' ? 'claude' : 'codex'}`,
        `provider=${terminalAppendActiveRuntime === 'claude' ? terminalAppendClaudeProvider : terminalAppendCodexProvider}`,
        `session=${terminalAppendBinding.bridgeSessionId}`,
        `chars=${text.length}`,
      ].join(' '),
    });
    if (!appended) {
      await deliverBridgeNotice(adapter, msg.address, '当前 terminal provider 还没有可接收追加输入的本地会话，请稍后重试。', {
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
      await deliverBridgeNotice(adapter, msg.address, toUserVisibleCommandError(resolvedCommand, error), {
        replyToMessageId: msg.messageId,
      });
    }
    ack();
    return;
  }

  // Sanitize general message text before routing to conversation engine
  const generalBinding = store.getChannelChat(msg.address.channelType, msg.address.chatId);
  const fullModelText = appendModelContextText(
    modelText,
    msg.contextText,
    buildCloudDocumentChatContextText(generalBinding),
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
      recordInteractiveHealthEnd: (sessionId, outcome, detail) => SESSION_HEALTH_RUNTIME.recordInteractiveEnd(sessionId, outcome, detail),
      beginMirrorSuppression,
      abortMirrorSuppression,
      settleMirrorSuppression,
      releaseInteractiveTask: (sessionId, taskId) => INTERACTIVE_RUNTIME.releaseInteractiveTask(sessionId, taskId),
      releaseBridgeTurn: (sessionId, taskId) => TURN_COORDINATOR.releaseSessionTurn(sessionId, taskId),
      deliverResponse,
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
    selectedAutoTaskId?: string | null;
    selectedAutoTaskAction?: AutoTaskCardAction | null;
    tmuxProviderAutoForward?: boolean;
    onTmuxProviderAutoForwarded?: () => Promise<void> | void;
  } = {},
): Promise<void> {
  await handleBridgeCommand(adapter, msg, text, {
    getActiveTask: (sessionId) => INTERACTIVE_RUNTIME.getActiveTask(sessionId),
    forceStopSession: (sessionId, detail) => INTERACTIVE_RUNTIME.forceStopSession(sessionId, detail),
    recordInteractiveHealthEnd: (sessionId, outcome, detail) => SESSION_HEALTH_RUNTIME.recordInteractiveEnd(sessionId, outcome, detail),
    reconcileMirrorSubscriptions,
    diagnoseSessionHealth: (sessionId) => SESSION_HEALTH_RUNTIME.diagnoseSessionHealth(sessionId),
    diagnoseAllActiveSessions: () => SESSION_HEALTH_RUNTIME.diagnoseAllActiveSessions(),
    scopedBinding: options.scopedBinding,
    threadCardRefreshScope: options.threadCardRefreshScope,
    threadCardSelectedId: options.threadCardSelectedId,
    selectedAutoTaskId: options.selectedAutoTaskId,
    selectedAutoTaskAction: options.selectedAutoTaskAction,
    tmuxProviderAutoForward: options.tmuxProviderAutoForward,
    onTmuxProviderAutoForwarded: options.onTmuxProviderAutoForwarded,
    startAutoTask,
    stopAutoTask,
    onBindingRemoved: handleBindingRemovedForAutoTasks,
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
  stopAllAutoTasks();
  pendingTmuxAutoForwardReactions.clear();
  tmuxSelectionPromptMonitors.clear();
  tmuxSelectionPromptLastProbeAt.clear();
  tmuxSelectionPromptFollowupUntil.clear();
  state.autoTaskSelections.clear();
  clearMirrorSubscriptions();
  state.mirrorSuppressUntil.clear();
  state.mirrorIgnoredTurnIds.clear();
  INTERACTIVE_RUNTIME.resetSessionExecutor();
  TURN_COORDINATOR.clear();
  state.mirrorSyncInFlight = false;
  state.claudeMirrorSyncInFlight = false;
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
}

// ── Test-only export ─────────────────────────────────────────
// Exposed so integration tests can exercise handleMessage directly
// without wiring up the full adapter loop.
/** @internal */
export const _testOnly = {
  handleMessage,
  syncConfiguredAdapters: (options: { startLoops: boolean }) => ADAPTER_RUNTIME.syncConfiguredAdapters(options),
  reconcileMirrorSubscriptions,
  resolveNewWorkingDirectory,
  resolveNewSessionWorkingDirectory,
  resolveCommandAlias,
  adapterSessionLane,
  adapterImmediateLane,
  isBridgeCommandText,
  toModelPromptText,
  buildCloudDocumentChatContextText,
  appendModelContextText,
  resolveDisplayedModel,
  formatDisplayedModel,
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
  resetStateForTests,
};
