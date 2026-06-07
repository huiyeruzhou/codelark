import type {
  BridgeSession,
  BridgeSessionUpdate,
  BridgeSessionClaudeRuntimeState,
  BridgeSessionCodexRuntimeState,
  BridgeSessionGeneralState,
  BridgeSessionRuntimeState,
} from './session.js';
import { createConfigService } from '../configuration/service.js';
import type { ConfigPath } from '../configuration/fields-types.js';

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
  return provider === 'sdk' || provider === 'tmux' || provider === 'pty' ? provider : undefined;
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
  return provider === 'sdk' || provider === 'pty' ? provider : undefined;
}

export function getSessionClaudePermissionMode(session: SessionRuntimeLike | null | undefined): BridgeSessionClaudeRuntimeState['permissionMode'] | undefined {
  if (!isClaudeRuntime(session)) return undefined;
  const permissionMode = getSessionTomlOverride<string>(session, 'runtime.claude.permissionMode');
  return permissionMode === 'default'
    || permissionMode === 'acceptEdits'
    || permissionMode === 'bypassPermissions'
    || permissionMode === 'plan'
    ? permissionMode
    : undefined;
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
  return trimOrUndefined(getSessionTomlOverride<string>(session, 'session.tmuxSessionName'));
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
