import type {
  BridgeSession,
  BridgeSessionUpdate,
  BridgeSessionClaudeRuntimeState,
  BridgeSessionCodexRuntimeState,
  BridgeSessionGeneralState,
  BridgeSessionRuntimeState,
} from './session.js';
export {
  getSessionClaudeModel,
  getSessionClaudePermissionMode,
  getSessionClaudeProvider,
  getSessionClaudeReasoningEffort,
  getSessionCodexMode,
  getSessionCodexModel,
  getSessionCodexNetworkAccess,
  getSessionCodexProvider,
  getSessionCodexReasoningEffort,
  getSessionCodexSandboxMode,
  getSessionTmuxAutoEnter,
  getSessionTmuxCaptureLines,
  getSessionTmuxEchoInput,
  getSessionTmuxSessionName,
  getSessionWorkingDirectory,
} from '../configuration/session-values.js';

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

export function getSessionClaudeSessionId(session: SessionRuntimeLike | null | undefined): string | undefined {
  if (!isClaudeRuntime(session)) return undefined;
  return trimOrUndefined(session?.runtime?.claude?.sessionId);
}

export function getSessionClaudeCwd(session: SessionRuntimeLike | null | undefined): string | undefined {
  if (!isClaudeRuntime(session)) return undefined;
  return trimOrUndefined(session?.runtime?.claude?.cwd);
}

export function getSessionRuntimeTmuxSessionName(session: SessionRuntimeLike | null | undefined): string | undefined {
  return trimOrUndefined(session?.runtime?.general?.tmuxSessionName);
}

export function getSessionSystemPrompt(session: SessionRuntimeLike | null | undefined): string | undefined {
  return trimOrUndefined(session?.runtime?.general?.systemPrompt);
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
