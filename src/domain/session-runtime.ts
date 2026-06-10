import type {
  BridgeSession,
  BridgeSessionUpdate,
  BridgeSessionClaudeRuntimeState,
  BridgeSessionCodexRuntimeState,
  BridgeSessionGeneralState,
  BridgeSessionRuntimeState,
  RuntimeProviderChoice,
  RuntimeProviderIdentity,
} from './session.js';
import { createConfigService } from '../configuration/service.js';
import type { ConfigPath } from '../configuration/fields.js';

export type BridgeSessionRuntimeUpdate = BridgeSessionUpdate;

type SessionRuntimeLike = {
  id?: string;
  runtime?: {
    activeRuntime?: BridgeSessionRuntimeState['activeRuntime'];
    codex?: Omit<Partial<BridgeSessionCodexRuntimeState>, 'threadId' | 'title' | 'model'> & {
      threadId?: string | null;
      title?: string | null;
      model?: string | null;
    };
    claude?: Omit<Partial<BridgeSessionClaudeRuntimeState>, 'sessionId' | 'cwd' | 'model'> & {
      sessionId?: string | null;
      cwd?: string | null;
      model?: string | null;
    };
    general?: Partial<BridgeSessionGeneralState>;
  };
};

function isClaudeRuntime(session: SessionRuntimeLike | null | undefined): boolean {
  return session?.runtime?.activeRuntime === 'claude';
}

function trimOrUndefined(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

export function isRuntimeProviderChoice(value: unknown): value is RuntimeProviderChoice {
  return value === 'sdk' || value === 'pty' || value === 'tmux';
}

function getSessionTomlOverride<T>(session: SessionRuntimeLike | null | undefined, path: ConfigPath): T | undefined {
  if (!session?.id) return undefined;
  const resolved = createConfigService({ migrate: false }).resolve(path, {
    kind: 'session',
    sessionId: session.id,
  });
  return resolved.source === 'session' ? resolved.value as T : undefined;
}

export function getSessionCodexThreadId(session: SessionRuntimeLike | null | undefined): string | undefined {
  if (isClaudeRuntime(session)) return undefined;
  return trimOrUndefined(session?.runtime?.codex?.threadId);
}

export function getSessionActiveRuntime(session: SessionRuntimeLike | null | undefined): BridgeSessionRuntimeState['activeRuntime'] {
  const activeRuntime = session?.runtime?.activeRuntime;
  return activeRuntime === 'claude' ? 'claude' : activeRuntime === 'codex' ? 'codex' : undefined;
}

export function getSessionCodexTitle(session: SessionRuntimeLike | null | undefined): string | undefined {
  if (isClaudeRuntime(session)) return undefined;
  return trimOrUndefined(session?.runtime?.codex?.title);
}

export function getSessionCodexModel(session: SessionRuntimeLike | null | undefined): string | undefined {
  if (isClaudeRuntime(session)) return undefined;
  return trimOrUndefined(getSessionTomlOverride<string>(session, 'runtime.codex.model'));
}

export function getSessionCodexMode(session: SessionRuntimeLike | null | undefined): BridgeSessionCodexRuntimeState['mode'] | undefined {
  if (isClaudeRuntime(session)) return undefined;
  const mode = getSessionTomlOverride<'off' | 'on' | 'yolo'>(session, 'runtime.codex.yoloMode');
  if (mode === 'on' || mode === 'yolo') return 'yolo';
  if (mode === 'off') return 'normal';
  return undefined;
}

export function getSessionCodexProvider(session: SessionRuntimeLike | null | undefined): BridgeSessionCodexRuntimeState['provider'] | undefined {
  if (isClaudeRuntime(session)) return undefined;
  const provider = getSessionTomlOverride<string>(session, 'runtime.codex.provider');
  return isRuntimeProviderChoice(provider) ? provider : undefined;
}

export function getSessionCodexSandboxMode(session: SessionRuntimeLike | null | undefined): BridgeSessionCodexRuntimeState['sandboxMode'] | undefined {
  if (isClaudeRuntime(session)) return undefined;
  const sandboxMode = getSessionTomlOverride<string>(session, 'runtime.codex.sandboxMode');
  return sandboxMode === 'read-only' || sandboxMode === 'workspace-write' || sandboxMode === 'danger-full-access'
    ? sandboxMode
    : undefined;
}

export function getSessionCodexNetworkAccess(session: SessionRuntimeLike | null | undefined): boolean | undefined {
  if (isClaudeRuntime(session)) return undefined;
  const networkAccess = getSessionTomlOverride<boolean>(session, 'runtime.codex.networkAccess');
  return typeof networkAccess === 'boolean' ? networkAccess : undefined;
}

export function getSessionCodexReasoningEffort(session: SessionRuntimeLike | null | undefined): BridgeSessionCodexRuntimeState['reasoningEffort'] | undefined {
  if (isClaudeRuntime(session)) return undefined;
  const reasoningEffort = getSessionTomlOverride<string>(session, 'runtime.codex.reasoningEffort');
  return reasoningEffort === 'minimal'
    || reasoningEffort === 'low'
    || reasoningEffort === 'medium'
    || reasoningEffort === 'high'
    || reasoningEffort === 'xhigh'
    ? reasoningEffort
    : undefined;
}

export function getSessionClaudeSessionId(session: SessionRuntimeLike | null | undefined): string | undefined {
  if (!isClaudeRuntime(session)) return undefined;
  return trimOrUndefined(session?.runtime?.claude?.sessionId);
}

export function getSessionClaudeCwd(session: SessionRuntimeLike | null | undefined): string | undefined {
  if (!isClaudeRuntime(session)) return undefined;
  return trimOrUndefined(session?.runtime?.claude?.cwd);
}

export function getSessionClaudeModel(session: SessionRuntimeLike | null | undefined): string | undefined {
  if (!isClaudeRuntime(session)) return undefined;
  return trimOrUndefined(getSessionTomlOverride<string>(session, 'runtime.claude.model'));
}

export function getSessionClaudeProvider(session: SessionRuntimeLike | null | undefined): BridgeSessionClaudeRuntimeState['provider'] | undefined {
  if (!isClaudeRuntime(session)) return undefined;
  const provider = getSessionTomlOverride<string>(session, 'runtime.claude.provider');
  return isRuntimeProviderChoice(provider) ? provider : undefined;
}

export function getSessionRuntimeProvider(session: SessionRuntimeLike | null | undefined): RuntimeProviderChoice | undefined {
  return isClaudeRuntime(session) ? getSessionClaudeProvider(session) : getSessionCodexProvider(session);
}

export function getSessionRuntimeProviderIdentity(session: SessionRuntimeLike | null | undefined): RuntimeProviderIdentity | undefined {
  const provider = getSessionRuntimeProvider(session)
    || (isClaudeRuntime(session) ? session?.runtime?.claude?.provider : session?.runtime?.codex?.provider);
  if (!isRuntimeProviderChoice(provider)) return undefined;
  if (!provider) return undefined;
  return `${isClaudeRuntime(session) ? 'claude' : 'codex'}:${provider}`;
}

export function buildRuntimeProviderIdentity(
  runtime: 'codex' | 'claude',
  provider: RuntimeProviderChoice,
): RuntimeProviderIdentity {
  return `${runtime}:${provider}`;
}

export function getSessionClaudeReasoningEffort(session: SessionRuntimeLike | null | undefined): BridgeSessionClaudeRuntimeState['reasoningEffort'] | undefined {
  if (!isClaudeRuntime(session)) return undefined;
  const reasoningEffort = getSessionTomlOverride<string>(session, 'runtime.claude.reasoningEffort');
  return reasoningEffort === 'low'
    || reasoningEffort === 'medium'
    || reasoningEffort === 'high'
    || reasoningEffort === 'xhigh'
    || reasoningEffort === 'max'
    ? reasoningEffort
    : undefined;
}

export function getSessionTmuxSessionName(session: SessionRuntimeLike | null | undefined): string | undefined {
  return getSessionRuntimeTmuxSessionName(session);
}

export function getSessionRuntimeTmuxSessionName(session: SessionRuntimeLike | null | undefined): string | undefined {
  return trimOrUndefined(session?.runtime?.general?.tmuxSessionName);
}

export function getSessionWorkingDirectory(session: SessionRuntimeLike | null | undefined): string | undefined {
  return trimOrUndefined(getSessionTomlOverride<string>(session, 'session.workspace'));
}

export function getSessionSystemPrompt(session: SessionRuntimeLike | null | undefined): string | undefined {
  return trimOrUndefined(session?.runtime?.general?.systemPrompt);
}

export function getSessionTmuxCaptureLines(session: SessionRuntimeLike | null | undefined): number | undefined {
  return getSessionTomlOverride<number>(session, 'session.tmuxCaptureLines');
}

export function getSessionTmuxAutoEnter(session: SessionRuntimeLike | null | undefined): boolean | undefined {
  const tomlValue = getSessionTomlOverride<boolean>(session, 'session.tmuxAutoEnter');
  if (typeof tomlValue === 'boolean') return tomlValue;
  return undefined;
}

export function getSessionTmuxEchoInput(session: SessionRuntimeLike | null | undefined): boolean | undefined {
  const tomlValue = getSessionTomlOverride<boolean>(session, 'session.tmuxEchoInput');
  if (typeof tomlValue === 'boolean') return tomlValue;
  return undefined;
}

export function materializeBridgeSessionRuntime(rawSession: BridgeSession): BridgeSession {
  const activeRuntime = rawSession.runtime?.activeRuntime === 'claude' ? 'claude' : 'codex';
  const codex = {
    ...rawSession.runtime?.codex,
  };
  const general = {
    ...rawSession.runtime?.general,
  };

  const materialized = {
    ...rawSession,
    runtime: activeRuntime === 'claude'
      ? {
          activeRuntime: 'claude',
          ...(rawSession.runtime?.claude ? { claude: rawSession.runtime.claude } : {}),
          ...(Object.keys(general).length > 0 ? { general } : {}),
        } satisfies BridgeSessionRuntimeState
      : {
          ...(rawSession.runtime?.activeRuntime === 'codex' ? { activeRuntime: 'codex' as const } : {}),
          ...(Object.keys(codex).length > 0 ? { codex } : {}),
          ...(Object.keys(general).length > 0 ? { general } : {}),
        } satisfies BridgeSessionRuntimeState,
  };
  return materialized;
}

export function setSessionActiveRuntimeUpdate(activeRuntime: BridgeSessionRuntimeState['activeRuntime']): BridgeSessionRuntimeUpdate {
  return { runtime: { activeRuntime } };
}

export function setSessionCodexThreadIdUpdate(threadId: string | undefined): BridgeSessionRuntimeUpdate {
  return { runtime: { codex: { threadId } } };
}

export function setSessionCodexTitleUpdate(title: string | undefined): BridgeSessionRuntimeUpdate {
  return { runtime: { codex: { title } } };
}

export function setSessionClaudeSessionIdUpdate(sessionId: string | undefined): BridgeSessionRuntimeUpdate {
  return { runtime: { activeRuntime: 'claude', claude: { sessionId } } };
}

export function setSessionClaudeIdentityUpdate(
  sessionId: string | undefined,
  cwd: string | undefined,
): BridgeSessionRuntimeUpdate {
  return { runtime: { activeRuntime: 'claude', claude: { sessionId, cwd } } };
}

export function setSessionSystemPromptUpdate(systemPrompt: string | undefined): BridgeSessionRuntimeUpdate {
  return { runtime: { general: { systemPrompt } } };
}

export function setSessionCodexTmuxProviderUpdate(options: {
  tmuxSessionName: string;
  autoEnter?: boolean;
  threadId?: string;
}): BridgeSessionRuntimeUpdate {
  return {
    runtime: {
      codex: {
        ...(options.threadId ? { threadId: options.threadId } : {}),
      },
      general: {
        tmuxSessionName: options.tmuxSessionName,
      },
    },
  };
}

export function setSessionClaudeTmuxProviderUpdate(options: {
  tmuxSessionName: string;
  autoEnter?: boolean;
  sessionId?: string;
  cwd?: string;
}): BridgeSessionRuntimeUpdate {
  return {
    runtime: {
      activeRuntime: 'claude',
      claude: {
        provider: 'tmux',
        ...(options.sessionId ? { sessionId: options.sessionId } : {}),
        ...(options.cwd ? { cwd: options.cwd } : {}),
      },
      general: {
        tmuxSessionName: options.tmuxSessionName,
        ...(typeof options.autoEnter === 'boolean' ? { autoEnter: options.autoEnter } : {}),
      },
    },
  };
}

export function mergeSessionRuntimeUpdates(...updates: BridgeSessionRuntimeUpdate[]): BridgeSessionRuntimeUpdate {
  return updates.reduce<BridgeSessionRuntimeUpdate>((acc, update) => ({
    ...acc,
    ...update,
    runtime: update.runtime
      ? {
        ...acc.runtime,
        ...update.runtime,
        codex: update.runtime.codex
          ? { ...acc.runtime?.codex, ...update.runtime.codex }
          : acc.runtime?.codex,
        claude: update.runtime.claude
          ? { ...acc.runtime?.claude, ...update.runtime.claude }
          : acc.runtime?.claude,
        general: update.runtime.general
          ? { ...acc.runtime?.general, ...update.runtime.general }
          : acc.runtime?.general,
      }
      : acc.runtime,
  }), {});
}
