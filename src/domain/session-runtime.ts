import type {
  BridgeSession,
  BridgeSessionUpdate,
  BridgeSessionClaudeRuntimeState,
  BridgeSessionCodexRuntimeState,
  BridgeSessionGeneralState,
  BridgeSessionRuntimeState,
} from './session.js';

export type BridgeSessionRuntimeUpdate = BridgeSessionUpdate;

type SessionRuntimeLike = {
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

export function getSessionCodexModel(session: SessionRuntimeLike | null | undefined): string | undefined {
  if (isClaudeRuntime(session)) return undefined;
  return trimOrUndefined(session?.runtime?.codex?.model);
}

export function getSessionCodexMode(session: SessionRuntimeLike | null | undefined): BridgeSessionCodexRuntimeState['mode'] | undefined {
  if (isClaudeRuntime(session)) return undefined;
  return session?.runtime?.codex?.mode;
}

export function getSessionCodexProvider(session: SessionRuntimeLike | null | undefined): BridgeSessionCodexRuntimeState['provider'] | undefined {
  if (isClaudeRuntime(session)) return undefined;
  const provider = session?.runtime?.codex?.provider;
  return provider === 'sdk' || provider === 'tmux' || provider === 'pty' ? provider : undefined;
}

export function getSessionCodexSandboxMode(session: SessionRuntimeLike | null | undefined): BridgeSessionCodexRuntimeState['sandboxMode'] | undefined {
  if (isClaudeRuntime(session)) return undefined;
  return session?.runtime?.codex?.sandboxMode;
}

export function getSessionCodexNetworkAccess(session: SessionRuntimeLike | null | undefined): boolean | undefined {
  if (isClaudeRuntime(session)) return undefined;
  return typeof session?.runtime?.codex?.networkAccess === 'boolean'
    ? session.runtime.codex.networkAccess
    : undefined;
}

export function getSessionCodexReasoningEffort(session: SessionRuntimeLike | null | undefined): BridgeSessionCodexRuntimeState['reasoningEffort'] | undefined {
  if (isClaudeRuntime(session)) return undefined;
  return session?.runtime?.codex?.reasoningEffort;
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
  return trimOrUndefined(session?.runtime?.claude?.model);
}

export function getSessionClaudeProvider(session: SessionRuntimeLike | null | undefined): BridgeSessionClaudeRuntimeState['provider'] | undefined {
  if (!isClaudeRuntime(session)) return undefined;
  const provider = session?.runtime?.claude?.provider;
  return provider === 'sdk' || provider === 'pty' || provider === 'tmux' ? provider : undefined;
}

export function getSessionClaudePermissionMode(session: SessionRuntimeLike | null | undefined): BridgeSessionClaudeRuntimeState['permissionMode'] | undefined {
  if (!isClaudeRuntime(session)) return undefined;
  return session?.runtime?.claude?.permissionMode;
}

export function getSessionClaudeReasoningEffort(session: SessionRuntimeLike | null | undefined): BridgeSessionClaudeRuntimeState['reasoningEffort'] | undefined {
  if (!isClaudeRuntime(session)) return undefined;
  return session?.runtime?.claude?.reasoningEffort;
}

export function getSessionTmuxSessionName(session: SessionRuntimeLike | null | undefined): string | undefined {
  return trimOrUndefined(session?.runtime?.general?.tmuxSessionName);
}

export function getSessionWorkingDirectory(session: SessionRuntimeLike | null | undefined): string | undefined {
  return trimOrUndefined(session?.runtime?.general?.workingDirectory);
}

export function getSessionSystemPrompt(session: SessionRuntimeLike | null | undefined): string | undefined {
  return trimOrUndefined(session?.runtime?.general?.systemPrompt);
}

export function getSessionTmuxCaptureLines(session: SessionRuntimeLike | null | undefined): number | undefined {
  return session?.runtime?.general?.captureLines;
}

export function getSessionTmuxAutoEnter(session: SessionRuntimeLike | null | undefined): boolean | undefined {
  return typeof session?.runtime?.general?.autoEnter === 'boolean'
    ? session.runtime.general.autoEnter
    : undefined;
}

export function getSessionTmuxEchoInput(session: SessionRuntimeLike | null | undefined): boolean | undefined {
  return typeof session?.runtime?.general?.echoInput === 'boolean'
    ? session.runtime.general.echoInput
    : undefined;
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

export function setSessionCodexModeUpdate(mode: BridgeSessionCodexRuntimeState['mode']): BridgeSessionRuntimeUpdate {
  return { runtime: { codex: { mode } } };
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

export function setSessionCodexModelUpdate(model: string | undefined): BridgeSessionRuntimeUpdate {
  return { runtime: { codex: { model } } };
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

export function setSessionClaudeModelUpdate(model: string | undefined): BridgeSessionRuntimeUpdate {
  return { runtime: { activeRuntime: 'claude', claude: { model } } };
}

export function setSessionClaudeProviderUpdate(provider: BridgeSessionClaudeRuntimeState['provider'] | undefined): BridgeSessionRuntimeUpdate {
  return { runtime: { activeRuntime: 'claude', claude: { provider } } };
}

export function setSessionClaudePermissionModeUpdate(permissionMode: BridgeSessionClaudeRuntimeState['permissionMode']): BridgeSessionRuntimeUpdate {
  return { runtime: { activeRuntime: 'claude', claude: { permissionMode } } };
}

export function setSessionClaudeReasoningEffortUpdate(reasoningEffort: BridgeSessionClaudeRuntimeState['reasoningEffort'] | undefined): BridgeSessionRuntimeUpdate {
  return { runtime: { activeRuntime: 'claude', claude: { reasoningEffort } } };
}

export function setSessionWorkingDirectoryUpdate(workingDirectory: string | undefined): BridgeSessionRuntimeUpdate {
  return { runtime: { general: { workingDirectory } } };
}

export function setSessionSystemPromptUpdate(systemPrompt: string | undefined): BridgeSessionRuntimeUpdate {
  return { runtime: { general: { systemPrompt } } };
}

export function setSessionCodexReasoningEffortUpdate(reasoningEffort: BridgeSessionCodexRuntimeState['reasoningEffort'] | undefined): BridgeSessionRuntimeUpdate {
  return { runtime: { codex: { reasoningEffort } } };
}

export function setSessionCodexProviderUpdate(provider: BridgeSessionCodexRuntimeState['provider']): BridgeSessionRuntimeUpdate {
  return { runtime: { codex: { provider } } };
}

export function setSessionCodexSandboxModeUpdate(sandboxMode: BridgeSessionCodexRuntimeState['sandboxMode']): BridgeSessionRuntimeUpdate {
  return { runtime: { codex: { sandboxMode } } };
}

export function clearSessionCodexSandboxModeUpdate(): BridgeSessionRuntimeUpdate {
  return { runtime: { codex: { sandboxMode: undefined } } };
}

export function setSessionCodexNetworkAccessUpdate(networkAccess: boolean): BridgeSessionRuntimeUpdate {
  return { runtime: { codex: { networkAccess } } };
}

export function clearSessionCodexNetworkAccessUpdate(): BridgeSessionRuntimeUpdate {
  return { runtime: { codex: { networkAccess: undefined } } };
}

export function setSessionCodexTmuxProviderUpdate(options: {
  tmuxSessionName: string;
  autoEnter?: boolean;
  threadId?: string;
}): BridgeSessionRuntimeUpdate {
  return {
    runtime: {
      codex: {
        provider: 'tmux',
        ...(options.threadId ? { threadId: options.threadId } : {}),
      },
      general: {
        tmuxSessionName: options.tmuxSessionName,
        ...(typeof options.autoEnter === 'boolean' ? { autoEnter: options.autoEnter } : {}),
      },
    },
  };
}

export function setSessionTmuxSessionNameUpdate(tmuxSessionName: string): BridgeSessionRuntimeUpdate {
  return { runtime: { general: { tmuxSessionName } } };
}

export function setSessionTmuxCaptureLinesUpdate(captureLines: number): BridgeSessionRuntimeUpdate {
  return { runtime: { general: { captureLines } } };
}

export function setSessionTmuxAutoEnterUpdate(autoEnter: boolean): BridgeSessionRuntimeUpdate {
  return { runtime: { general: { autoEnter } } };
}

export function setSessionTmuxEchoInputUpdate(echoInput: boolean): BridgeSessionRuntimeUpdate {
  return { runtime: { general: { echoInput } } };
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
