import { buildCommandCallbackData } from './callbacks.js';
import { buildStopActions } from '../../channels/delivery/stream-feedback.js';
import { buildCommandFields } from './presentation.js';
import type { RuntimeSettingsCommandDeps } from './runtime-bootstrap.js';
import type { BridgeSession, BridgeStore, ChannelChat, OutboundRichCard } from '../../domain/index.js';
import type { RuntimeAgent } from '../../domain/session.js';
import {
  getSessionActiveRuntime,
  getSessionRuntimeTmuxSessionName,
  getSessionSystemPrompt,
  getSessionWorkingDirectory,
} from '../../domain/session-runtime.js';
import {
  getCodexSessionByThreadIdSafe,
  scopedConfigForRuntime,
  resolveClaudeRuntimeConfig,
  resolveEffectiveClaudeProvider,
  resolveEffectiveCodexProvider,
  resolveEffectiveRuntimeProvider,
  resolveEffectiveMode,
  resolveEffectiveRuntimeMode,
  hasSessionClaudeProviderOverride,
  hasSessionCodexProviderOverride,
  hasSessionKimiProviderOverride,
  hasSessionCursorProviderOverride,
  hasSessionZcodeProviderOverride,
  hasSessionDoubaoProviderOverride,
} from '../session/support.js';
import { createConfigService } from '../../configuration/service.js';
import { projectSessionConfiguration } from '../session/command-use-cases/inherit-session-configuration.js';
import { getCodexThreadId } from '../turn/turn-classifier.js';
import { sessionLooksRunning } from './session-args.js';
import { readCodexBackendStatus, type CodexBackendStatus } from '../session/display/codex-backend-status.js';

export type RuntimeName = RuntimeAgent;
export type SupportedRuntimeName = RuntimeName;

export function formatSessionMode(binding: ChannelChat | null | undefined, session?: BridgeSession | null): string {
  return resolveEffectiveMode(binding, session);
}

export function formatSessionRuntimeMode(binding: ChannelChat | null | undefined, session?: BridgeSession | null): string {
  return resolveEffectiveRuntimeMode(binding, session);
}

export function sessionRuntimeName(session: BridgeSession | null | undefined): SupportedRuntimeName {
  const runtime = getSessionActiveRuntime(session);
  return runtime === 'claude' || runtime === 'kimi' || runtime === 'cursor' || runtime === 'zcode' || runtime === 'doubao' ? runtime : 'codex';
}

export function mappedRuntimeSessionId(
  store: BridgeStore,
  binding: ChannelChat,
  runtime: SupportedRuntimeName,
): string | undefined {
  const mapped = binding.runtimeBridgeSessionIds?.[runtime];
  if (mapped) {
    const mappedSession = store.getSession(mapped);
    if (mappedSession && sessionRuntimeName(mappedSession) === runtime) return mapped;
  }
  const activeSession = store.getSession(binding.bridgeSessionId);
  if (activeSession && sessionRuntimeName(activeSession) === runtime) return activeSession.id;
  return undefined;
}

export function createRuntimeSessionForChat(options: {
  store: BridgeStore;
  runtime: SupportedRuntimeName;
  baseSession: BridgeSession;
  chatId: string;
  binding?: ChannelChat | null;
}): BridgeSession {
  const workDir = getSessionWorkingDirectory(options.baseSession) || process.cwd();
  const systemPrompt = getSessionSystemPrompt(options.baseSession);
  const rawBaseName = options.baseSession.name?.trim() || `Bridge: ${options.chatId}`;
  const baseName = rawBaseName.replace(/\s+\((?:Claude Code|Kimi Code|Cursor Agent|ZCode|Doubao|Codex)\)$/u, '');
  const suffix = options.runtime === 'claude' ? 'Claude Code' : options.runtime === 'kimi' ? 'Kimi Code' : options.runtime === 'cursor' ? 'Cursor Agent' : options.runtime === 'zcode' ? 'ZCode' : options.runtime === 'doubao' ? 'Doubao' : 'Codex';
  const { config } = scopedConfigForRuntime(options.binding, options.baseSession);
  const patch = projectSessionConfiguration(config, workDir, options.runtime);
  const created = options.store.createSession(
    `${baseName} (${suffix})`,
    options.runtime === 'codex' ? config.runtime.codex.model : '',
    systemPrompt,
    workDir,
    options.runtime === 'codex' ? resolveEffectiveMode(options.binding, options.baseSession) : undefined,
    { activeRuntime: options.runtime },
  );
  createConfigService({ migrate: false }).set({ kind: 'session', sessionId: created.id }, patch);
  return options.store.getSession(created.id) || created;
}

export function formatSessionCodexProvider(session?: BridgeSession | null, binding?: ChannelChat | null): string {
  const effective = resolveEffectiveCodexProvider(session, binding);
  return hasSessionCodexProviderOverride(session)
    ? effective
    : `${effective} (全局默认)`;
}

// Configuration previews must not change which session's execution state is shown.
export function readSessionCodexBackendStatus(session?: BridgeSession | null): CodexBackendStatus | undefined {
  if (!session || (getSessionActiveRuntime(session) || 'codex') !== 'codex') return undefined;
  return readCodexBackendStatus(session);
}

export function formatCodexBackendStatusFields(status: CodexBackendStatus | undefined): Array<[string, string]> {
  if (!status) return [];
  const fields: Array<[string, string]> = [['当前后端', status.backendLabel]];
  if (status.backend === 'app-server') {
    fields.push(['连接状态', status.connectionLabel], ['执行状态', status.activityLabel]);
  }
  fields.push(['终端用途', status.terminalLabel]);
  return fields;
}

export function formatSessionClaudeProvider(session?: BridgeSession | null, binding?: ChannelChat | null): string {
  const effective = resolveEffectiveClaudeProvider(session, binding);
  return hasSessionClaudeProviderOverride(session)
    ? effective
    : `${effective} (全局默认)`;
}

export function formatSessionRuntimeProvider(session?: BridgeSession | null, binding?: ChannelChat | null): string {
  const effective = resolveEffectiveRuntimeProvider(session, binding);
  const hasOverride = effective.runtime === 'claude'
    ? hasSessionClaudeProviderOverride(session)
    : effective.runtime === 'cursor'
      ? hasSessionCursorProviderOverride(session)
      : effective.runtime === 'zcode'
        ? hasSessionZcodeProviderOverride(session)
      : effective.runtime === 'doubao'
        ? hasSessionDoubaoProviderOverride(session)
      : effective.runtime === 'kimi'
      ? hasSessionKimiProviderOverride(session)
    : hasSessionCodexProviderOverride(session);
  return hasOverride ? effective.provider : `${effective.provider} (全局默认)`;
}

export function isTuiProviderSession(session?: BridgeSession | null, binding?: ChannelChat | null): boolean {
  const { runtime, provider } = resolveEffectiveRuntimeProvider(session, binding);
  if (runtime === 'codex') {
    return hasSessionCodexProviderOverride(session) || Boolean(getSessionRuntimeTmuxSessionName(session));
  }
  return provider === 'tmux' || provider === 'pty';
}

export function buildTuiProviderRuntimeOptionBlockedResponse(commandLabel: string, provider: string, markdown: boolean): string {
  const restartNote = provider === 'tmux'
    ? '当前是 tmux Provider；发送 `/p tmux`，确认“结束并重启”后应用新设置。'
    : `请先 \`/stop\`，再发送 \`/provider ${provider}\` 重启 ${provider} Provider，让新设置从下一轮生效。`;
  return buildCommandFields(
    `当前是 ${provider} Provider`,
    [['命令', commandLabel]],
    [
      'session-level Codex runtime 设置无法影响已经启动的 Codex TUI 终端。',
      '也可以直接在 Codex TUI 里使用内置 slash 命令调整当前运行中的终端会话。',
      restartNote,
    ],
    markdown,
  );
}

export function sessionHasActiveRuntimeTurn(
  deps: RuntimeSettingsCommandDeps | undefined,
  session: BridgeSession | null | undefined,
): boolean {
  if (!session) return false;
  return Boolean(deps?.getActiveTask?.(session.id)) || sessionLooksRunning(session);
}

export function buildRuntimeSwitchWhileRunningResponse(params: {
  sessionId: string;
  richCard?: (card: OutboundRichCard) => void;
  commandLabel: string;
  runtime: SupportedRuntimeName;
  provider?: string;
  markdown: boolean;
}): string {
  const notes = [
    '当前会话仍在运行或排队，不能在对话进行中切换 runtime/provider。',
    '点击“停止”按钮或发送 `/stop`，等待当前对话结束后重试切换。',
  ];
  if (params.provider === 'tmux') {
    notes.push('tmux Provider 需要发送 `/p tmux` 重启 Codex TUI，才能确保和底层 JSONL 会话一致。');
  }
  const fields: Array<[string, string]> = [
    ['命令', params.commandLabel], ['当前 Runtime', params.runtime],
    ...(params.provider ? [['Provider', params.provider] as [string, string]] : []),
  ];
  params.richCard?.({
    title: '请先停止当前对话', template: 'orange',
    sections: [{ fields }, { markdown: notes.join('\n\n') }],
    actions: buildStopActions(buildCommandCallbackData('/stop', params.sessionId)),
  });
  return buildCommandFields('请先停止当前对话', fields, notes, params.markdown);
}

export async function reconcileMirrorSubscriptionsBestEffort(
  deps: RuntimeSettingsCommandDeps,
  context: string,
): Promise<void> {
  if (!deps.reconcileMirrorSubscriptions) return;
  try {
    await deps.reconcileMirrorSubscriptions();
  } catch (error) {
    console.error(`[runtime-settings-command] Mirror reconcile failed during ${context}:`, error);
  }
}

export function scheduleMirrorSubscriptionsBestEffort(
  deps: RuntimeSettingsCommandDeps,
  context: string,
): void {
  if (!deps.reconcileMirrorSubscriptions) return;
  const immediate = setImmediate(() => {
    void reconcileMirrorSubscriptionsBestEffort(deps, context);
  });
  immediate.unref?.();
}

export function resolveLocalCodexThreadId(
  session: BridgeSession | null,
  binding: ChannelChat,
  context: string,
): string | undefined {
  const threadId = getCodexThreadId(session, binding);
  if (!threadId) return undefined;
  return getCodexSessionByThreadIdSafe(threadId, context) ? threadId : undefined;
}
