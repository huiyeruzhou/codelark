/**
 * Codex TUI screen diagnostics for mirrored tmux turns.
 *
 * Codex's interactive TUI reports some failures (reconnect attempts, tool errors,
 * resume-model mismatches) only on screen, never in the session JSONL. This module
 * captures pane snapshots around a mirrored turn and turns new on-screen
 * diagnostics into status notes, body notices or a terminal error.
 *
 * All per-session/per-turn state lives inside the controller instance. Everything
 * it needs from the bridge host is injected, so the module never imports the
 * manager and can be reset or replaced as one unit.
 */
import { statSync } from 'node:fs';

import type { BridgeSession, BridgeStore, OutboundRichCard, RuntimeNoticeInfo } from '../../domain/index.js';
import type { BaseChannelAdapter } from '../../channels/contracts.js';
import { getSessionCodexThreadId, getSessionRuntimeTmuxSessionName } from '../../domain/session-runtime.js';
import {
  findNewCodexTuiDiagnostics,
  getCodexTuiResumeModelWarning,
  parseCodexTuiModelMismatchWarning,
  parseCodexTuiReconnectSignal,
  type CodexTuiDiagnostic,
} from '../../runtime/codex/tui-runtime-signals.js';
import type { TmuxCore } from '../../runtime/tmux/core.js';
import type { BridgeMirrorSubscription } from '../mirror/subscription-state.js';
import type { BridgeMirrorTurnState, FinalizedBridgeMirrorTurn } from '../mirror/turns.js';
import { applyUnifiedTurnStatusNote } from '../turn/unified-turn-state.js';

const IDLE_CHECKPOINT_HOT_MISSING_RETRY_MS = 5_000;
const IDLE_CHECKPOINT_COLD_MISSING_RETRY_MS = 60_000;
const CAPTURE_LINES = 80;

interface ScreenCheckpoint {
  screen: string;
  capturedAtMs: number;
  claimedTurnKey?: string;
}

interface ReconnectMonitor {
  streamKey: string;
  signalKey: string;
  appliedNote: string;
  previousStatusNote: string | null;
}

interface PendingTurnDiagnosticMonitor {
  screen: string;
  diagnostics: CodexTuiDiagnostic[];
}

type ModelMismatchWarning = { recordedModel: string; resumingModel: string };

type NoticeDelivery = {
  completion: Promise<{ ok: boolean; error?: string; messageId?: string }>;
};

export interface CodexTuiDiagnosticsDeps {
  getStore(): BridgeStore;
  getTmuxCore(): TmuxCore;
  /** Whether this session's Codex runs in a tmux TUI whose screen is meaningful. */
  supportsRuntimeSignals(session: BridgeSession): boolean;
  listMirrorSubscriptions(): Iterable<BridgeMirrorSubscription>;
  getRunningAdapter(channelType: string): BaseChannelAdapter | null;
  enqueueNotice(
    adapter: BaseChannelAdapter,
    address: { channelType: string; chatId: string },
    text: string,
    options: { sessionId: string; audit: boolean; richCard: OutboundRichCard },
  ): NoticeDelivery;
  /** Called after a reconnect status note was applied or restored on the pending turn. */
  onStatusProgress(subscription: BridgeMirrorSubscription, turn: BridgeMirrorTurnState): void;
  describeError(error: unknown): string;
}

export interface CodexTuiDiagnostics {
  /** Mirror hook: give a newly started turn the idle screen captured before it. */
  assignTurnScreenBaseline(subscription: BridgeMirrorSubscription, turnState: BridgeMirrorTurnState): void;
  /** Periodic: capture an idle screen for every subscription that may start a turn soon. */
  ensureIdleScreenCheckpoints(): Promise<void>;
  /** Capture one subscription's idle screen (optionally only if its tmux session is listed as alive). */
  captureIdleScreenCheckpoint(
    subscription: BridgeMirrorSubscription,
    activeTmuxSessionNames?: ReadonlySet<string>,
    nowMs?: number,
  ): Promise<void>;
  /** Called while a turn is running, with the latest pane text. */
  observeRunningScreen(subscription: BridgeMirrorSubscription, screenText: string, nowMs: number): void;
  observeReconnectStatus(subscription: BridgeMirrorSubscription, screenText: string, nowMs: number): void;
  observePendingTurnDiagnostic(subscription: BridgeMirrorSubscription, screenText: string): void;
  observeModelMismatchWarning(subscription: BridgeMirrorSubscription, screenText: string): void;
  /** Mirror hook: decide the final status of a finished turn from on-screen evidence. */
  resolveFinalizedTurnStatus(
    subscription: BridgeMirrorSubscription,
    turn: FinalizedBridgeMirrorTurn,
    context: { batchSize: number },
  ): Promise<FinalizedBridgeMirrorTurn['status']>;
  /** Inbound user activity makes a cold session hot again; retry its idle capture promptly. */
  markSessionActive(sessionId: string): void;
  reset(): void;
}

function applyDiagnosticToFinalizedTurn(
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

function applyDiagnosticsToFinalizedTurn(
  turn: FinalizedBridgeMirrorTurn,
  diagnostics: CodexTuiDiagnostic[],
  source: 'running_turn_probe' | 'completed_turn_probe',
): FinalizedBridgeMirrorTurn['status'] {
  let status = turn.status;
  for (const diagnostic of diagnostics) {
    if (applyDiagnosticToFinalizedTurn(turn, diagnostic, source) === 'error') status = 'error';
  }
  return status;
}

export function buildCodexTuiModelMismatchCard(params: {
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

export function createCodexTuiDiagnostics(deps: CodexTuiDiagnosticsDeps): CodexTuiDiagnostics {
  /** Idle screen per session, captured while no turn is pending. */
  const idleScreenCheckpoints = new Map<string, ScreenCheckpoint>();
  /** Screen each running turn is compared against, keyed by stream key. */
  const turnScreenBaselines = new Map<string, ScreenCheckpoint>();
  /** Last time a session's tmux pane was found missing, to back off retries. */
  const idleScreenMissingCheckedAt = new Map<string, number>();
  const reconnectMonitors = new Map<string, ReconnectMonitor>();
  const modelMismatchNoticesInFlight = new Map<string, string>();
  const pendingTurnDiagnosticMonitors = new Map<string, PendingTurnDiagnosticMonitor>();

  const tmuxTarget = (session: BridgeSession): string | null => {
    if (!deps.supportsRuntimeSignals(session)) return null;
    return getSessionRuntimeTmuxSessionName(session) || null;
  };

  function shouldAttemptIdleScreenCheckpoint(subscription: BridgeMirrorSubscription, nowMs: number): boolean {
    if (subscription.pendingTurn || subscription.pendingDeliveries.length > 0) return false;
    const existing = idleScreenCheckpoints.get(subscription.sessionId);
    if (existing && !existing.claimedTurnKey) return false;
    const missingCheckedAt = idleScreenMissingCheckedAt.get(subscription.sessionId) || 0;
    const retryMs = subscription.activityTier === 'cold'
      ? IDLE_CHECKPOINT_COLD_MISSING_RETRY_MS
      : IDLE_CHECKPOINT_HOT_MISSING_RETRY_MS;
    return nowMs - missingCheckedAt >= retryMs;
  }

  async function captureIdleScreenCheckpoint(
    subscription: BridgeMirrorSubscription,
    activeTmuxSessionNames: ReadonlySet<string> | undefined,
    nowMs: number,
  ): Promise<void> {
    if (subscription.pendingTurn || subscription.pendingDeliveries.length > 0) return;
    const existing = idleScreenCheckpoints.get(subscription.sessionId);
    if (existing && !existing.claimedTurnKey) return;
    const session = deps.getStore().getSession(subscription.sessionId);
    const tmuxSessionName = session && tmuxTarget(session);
    if (!tmuxSessionName) return;
    if (activeTmuxSessionNames && !activeTmuxSessionNames.has(tmuxSessionName)) {
      idleScreenMissingCheckedAt.set(subscription.sessionId, nowMs);
      return;
    }
    try {
      const capture = await deps.getTmuxCore().capturePane(`${tmuxSessionName}:0.0`, CAPTURE_LINES);
      idleScreenMissingCheckedAt.delete(subscription.sessionId);
      idleScreenCheckpoints.set(subscription.sessionId, { screen: capture.screen, capturedAtMs: nowMs });
    } catch (error) {
      console.warn('[bridge-manager] Codex TUI idle checkpoint capture failed:', {
        session_id: subscription.sessionId,
        tmux_session: tmuxSessionName,
        error: deps.describeError(error),
      });
    }
  }

  function assignChainedTurnScreenBaseline(
    subscription: BridgeMirrorSubscription,
    checkpoint: ScreenCheckpoint,
    finalizedStreamKey: string,
  ): void {
    const pendingTurn = subscription.pendingTurn;
    if (!pendingTurn || pendingTurn.streamKey === finalizedStreamKey) return;
    if (turnScreenBaselines.has(pendingTurn.streamKey)) return;
    const turnStartedAtMs = Date.parse(pendingTurn.startedAt);
    if (!Number.isFinite(turnStartedAtMs) || turnStartedAtMs > checkpoint.capturedAtMs) return;

    checkpoint.claimedTurnKey = pendingTurn.turnId || pendingTurn.startedAt;
    turnScreenBaselines.set(pendingTurn.streamKey, checkpoint);
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

  function notifyModelMismatchWarning(subscription: BridgeMirrorSubscription, warning: ModelMismatchWarning): void {
    const signalKey = `${subscription.sessionId}\u0000${warning.recordedModel}\u0000${warning.resumingModel}`;
    const store = deps.getStore();
    const session = store.getSession(subscription.sessionId);
    const binding = store.getChannelChat(subscription.channelType, subscription.chatId);
    if (!session || !binding || binding.id !== subscription.bindingId) return;
    if (binding.bridgeSessionId !== subscription.sessionId) return;
    if (binding.codexModelMismatchWarningKey === signalKey) return;
    if (modelMismatchNoticesInFlight.get(binding.id) === signalKey) return;
    const adapter = deps.getRunningAdapter(subscription.channelType);
    if (!adapter) return;

    modelMismatchNoticesInFlight.set(binding.id, signalKey);
    const text = [
      'Codex 恢复模型不一致',
      '',
      `Session 记录模型：\`${warning.recordedModel}\``,
      `当前恢复模型：\`${warning.resumingModel}\``,
      '',
      '继续使用可能影响 Codex 表现。建议发送 `/clear` 新建 session。',
    ].join('\n');
    const delivery = deps.enqueueNotice(
      adapter,
      { channelType: subscription.channelType, chatId: subscription.chatId },
      text,
      {
        sessionId: subscription.sessionId,
        audit: true,
        richCard: buildCodexTuiModelMismatchCard({ bindingId: binding.id, ...warning }),
      },
    );
    const releaseInFlight = () => {
      if (modelMismatchNoticesInFlight.get(binding.id) === signalKey) modelMismatchNoticesInFlight.delete(binding.id);
    };
    const logFailure = (error: unknown) => {
      console.warn('[bridge-manager] Codex model mismatch notice delivery failed:', {
        event: 'codex.tui.model_mismatch.notice_failed',
        session_id: subscription.sessionId,
        thread_id: subscription.threadId,
        error,
      });
    };
    void delivery.completion.then((result) => {
      releaseInFlight();
      if (!result.ok) { logFailure(result.error); return; }
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
      releaseInFlight();
      logFailure(deps.describeError(error));
    });
  }

  const api: CodexTuiDiagnostics = {
    assignTurnScreenBaseline(subscription, turnState) {
      if (turnScreenBaselines.has(turnState.streamKey)) return;
      const checkpoint = idleScreenCheckpoints.get(subscription.sessionId);
      if (!checkpoint) return;
      const turnStartedAtMs = Date.parse(turnState.startedAt);
      if (!Number.isFinite(turnStartedAtMs) || checkpoint.capturedAtMs >= turnStartedAtMs) return;
      const turnKey = turnState.turnId || turnState.startedAt;
      if (checkpoint.claimedTurnKey && checkpoint.claimedTurnKey !== turnKey) return;
      checkpoint.claimedTurnKey = turnKey;
      turnScreenBaselines.set(turnState.streamKey, checkpoint);
    },

    async ensureIdleScreenCheckpoints() {
      const nowMs = Date.now();
      const candidates = Array.from(deps.listMirrorSubscriptions()).flatMap((subscription) => {
        if (!shouldAttemptIdleScreenCheckpoint(subscription, nowMs)) return [];
        const session = deps.getStore().getSession(subscription.sessionId);
        return session && tmuxTarget(session) ? [subscription] : [];
      });
      if (candidates.length === 0) return;

      let activeTmuxSessionNames: Set<string>;
      try {
        const listed = await deps.getTmuxCore().listSessions();
        activeTmuxSessionNames = new Set(listed.sessions.map((session) => session.name));
      } catch (error) {
        for (const subscription of candidates) idleScreenMissingCheckedAt.set(subscription.sessionId, nowMs);
        console.warn('[bridge-manager] Unable to list tmux sessions for Codex TUI idle checkpoints:', {
          error: deps.describeError(error),
        });
        return;
      }
      await Promise.allSettled(
        candidates.map((subscription) => captureIdleScreenCheckpoint(subscription, activeTmuxSessionNames, nowMs)),
      );
    },

    captureIdleScreenCheckpoint(subscription, activeTmuxSessionNames, nowMs = Date.now()) {
      return captureIdleScreenCheckpoint(subscription, activeTmuxSessionNames, nowMs);
    },

    observeRunningScreen(subscription, screenText, nowMs) {
      api.observeModelMismatchWarning(subscription, screenText);
      api.observeReconnectStatus(subscription, screenText, nowMs);
      api.observePendingTurnDiagnostic(subscription, screenText);
    },

    observeReconnectStatus(subscription, screenText, nowMs) {
      const pendingTurn = subscription.pendingTurn;
      const previous = reconnectMonitors.get(subscription.sessionId);
      if (!pendingTurn) {
        reconnectMonitors.delete(subscription.sessionId);
        return;
      }
      const reconnect = parseCodexTuiReconnectSignal(screenText);
      if (!reconnect) {
        if (!previous || previous.streamKey !== pendingTurn.streamKey) return;
        if (pendingTurn.statusNote === previous.appliedNote) {
          applyUnifiedTurnStatusNote(pendingTurn, previous.previousStatusNote, nowMs);
          deps.onStatusProgress(subscription, pendingTurn);
        }
        reconnectMonitors.delete(subscription.sessionId);
        return;
      }
      const signalKey = `${reconnect.attempt}/${reconnect.maxAttempts}`;
      if (previous?.streamKey === pendingTurn.streamKey && previous.signalKey === signalKey) return;
      const appliedNote = `正在重连 ${signalKey}`;
      const previousStatusNote = previous?.streamKey === pendingTurn.streamKey
        ? previous.previousStatusNote
        : pendingTurn.statusNote;
      applyUnifiedTurnStatusNote(pendingTurn, appliedNote, nowMs);
      reconnectMonitors.set(subscription.sessionId, {
        streamKey: pendingTurn.streamKey,
        signalKey,
        appliedNote,
        previousStatusNote,
      });
      deps.onStatusProgress(subscription, pendingTurn);
    },

    observePendingTurnDiagnostic(subscription, screenText) {
      const pendingTurn = subscription.pendingTurn;
      if (!pendingTurn) return;
      const previous = pendingTurnDiagnosticMonitors.get(pendingTurn.streamKey);
      const previousScreen = previous?.screen || turnScreenBaselines.get(pendingTurn.streamKey)?.screen;
      if (!previousScreen) return;
      const newDiagnostics = findNewCodexTuiDiagnostics(previousScreen, screenText);
      pendingTurnDiagnosticMonitors.set(pendingTurn.streamKey, {
        screen: screenText,
        diagnostics: [...(previous?.diagnostics || []), ...newDiagnostics],
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
    },

    observeModelMismatchWarning(subscription, screenText) {
      const session = deps.getStore().getSession(subscription.sessionId);
      const terminal = session && getSessionRuntimeTmuxSessionName(session);
      const warning = (terminal ? getCodexTuiResumeModelWarning(terminal) : undefined)
        || parseCodexTuiModelMismatchWarning(screenText);
      if (!warning) return;
      const targets = new Map<string, BridgeMirrorSubscription>();
      for (const candidate of deps.listMirrorSubscriptions()) {
        if (candidate.sessionId === subscription.sessionId) targets.set(candidate.bindingId, candidate);
      }
      if (targets.size === 0) targets.set(subscription.bindingId, subscription);
      for (const target of targets.values()) notifyModelMismatchWarning(target, warning);
    },

    async resolveFinalizedTurnStatus(subscription, turn, context) {
      const baseline = turnScreenBaselines.get(turn.streamKey);
      const observedDiagnostics = pendingTurnDiagnosticMonitors.get(turn.streamKey)?.diagnostics || [];
      pendingTurnDiagnosticMonitors.delete(turn.streamKey);
      reconnectMonitors.delete(subscription.sessionId);

      const session = deps.getStore().getSession(subscription.sessionId);
      const tmuxSessionName = session && tmuxTarget(session);
      if (!tmuxSessionName) {
        turnScreenBaselines.delete(turn.streamKey);
        return turn.status;
      }

      try {
        const capture = await deps.getTmuxCore().capturePane(`${tmuxSessionName}:0.0`, CAPTURE_LINES);
        turnScreenBaselines.delete(turn.streamKey);
        const checkpoint: ScreenCheckpoint = { screen: capture.screen, capturedAtMs: Date.now() };
        idleScreenCheckpoints.set(subscription.sessionId, checkpoint);
        assignChainedTurnScreenBaseline(subscription, checkpoint, turn.streamKey);
        if (turn.status === 'completed' && observedDiagnostics.length > 0) {
          return applyDiagnosticsToFinalizedTurn(turn, observedDiagnostics, 'running_turn_probe');
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
        // Only trust a completed-turn screen diff when no newer JSONL output arrived meanwhile.
        let currentFileSize: number | null = null;
        if (subscription.filePath) {
          try { currentFileSize = statSync(subscription.filePath).size; } catch { currentFileSize = null; }
        }
        if (subscription.fileSize === null || currentFileSize !== subscription.fileSize) return turn.status;
        const diagnostics = findNewCodexTuiDiagnostics(baseline.screen, capture.screen);
        if (diagnostics.length === 0) return turn.status;
        return applyDiagnosticsToFinalizedTurn(turn, diagnostics, 'completed_turn_probe');
      } catch (error) {
        if (turn.status === 'completed' && observedDiagnostics.length > 0) {
          return applyDiagnosticsToFinalizedTurn(turn, observedDiagnostics, 'running_turn_probe');
        }
        console.warn('[bridge-manager] Codex TUI completed-turn error probe failed:', {
          session_id: subscription.sessionId,
          tmux_session: tmuxSessionName,
          error: deps.describeError(error),
        });
        return turn.status;
      }
    },

    markSessionActive(sessionId) {
      idleScreenMissingCheckedAt.delete(sessionId);
    },

    reset() {
      idleScreenCheckpoints.clear();
      turnScreenBaselines.clear();
      idleScreenMissingCheckedAt.clear();
      reconnectMonitors.clear();
      modelMismatchNoticesInFlight.clear();
      pendingTurnDiagnosticMonitors.clear();
    },
  };
  return api;
}
