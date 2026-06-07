import type { ConfigPath } from './fields-types.js';
import { getSessionConfigOverride } from './source-values.js';
import type { ConfigService, ConfigServiceOptions } from './service.js';
import type { ConfigPatch } from './schema.js';
import type {
  ClaudePermissionMode,
  ClaudeProviderChoice,
  CodexProviderChoice,
  CodexReasoningEffort,
  CodexSandboxMode,
} from './runtime-types.js';

type SessionConfigLike = {
  id?: string;
  runtime?: {
    activeRuntime?: 'codex' | 'claude';
  };
};

type ConfigSource = ConfigService | ConfigServiceOptions;

function isClaudeRuntime(session: SessionConfigLike | null | undefined): boolean {
  return session?.runtime?.activeRuntime === 'claude';
}

function trimOrUndefined(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function getSessionTomlOverride<T>(session: SessionConfigLike | null | undefined, path: ConfigPath): T | undefined {
  try {
    return getSessionConfigOverride<T>(session?.id, path);
  } catch {
    return undefined;
  }
}

function hasKeys(value: object): boolean {
  return Object.keys(value).length > 0;
}

export function getSessionExplicitConfigOverride<T>(
  session: SessionConfigLike | string | null | undefined,
  path: ConfigPath,
  serviceOrOptions: ConfigSource = {},
): T | undefined {
  const sessionId = typeof session === 'string' ? session : session?.id;
  try {
    return getSessionConfigOverride<T>(sessionId, path, serviceOrOptions);
  } catch {
    return undefined;
  }
}

export function getSessionCodexProviderOverride(session: SessionConfigLike | null | undefined): CodexProviderChoice | undefined {
  const provider = getSessionExplicitConfigOverride<string>(session, 'runtime.codex.provider');
  return provider === 'sdk' || provider === 'tmux' || provider === 'pty' ? provider : undefined;
}

export function getSessionClaudeProviderOverride(session: SessionConfigLike | null | undefined): ClaudeProviderChoice | undefined {
  const provider = getSessionExplicitConfigOverride<string>(session, 'runtime.claude.provider');
  return provider === 'sdk' || provider === 'pty' ? provider : undefined;
}

export function hasSessionCodexSandboxOverride(session: SessionConfigLike | null | undefined): boolean {
  return getSessionExplicitConfigOverride<CodexSandboxMode>(session, 'runtime.codex.sandboxMode') !== undefined;
}

export function hasSessionCodexNetworkAccessOverride(session: SessionConfigLike | null | undefined): boolean {
  return getSessionExplicitConfigOverride<boolean>(session, 'runtime.codex.networkAccess') !== undefined;
}

export function sessionCodexRuntimeOverridePatch(
  session: SessionConfigLike | null | undefined,
  serviceOrOptions: ConfigSource = {},
): ConfigPatch {
  const getOverride = <T>(path: ConfigPath): T | undefined => getSessionExplicitConfigOverride<T>(session, path, serviceOrOptions);
  const codex: NonNullable<NonNullable<ConfigPatch['runtime']>['codex']> = {};
  const model = getOverride<string>('runtime.codex.model');
  if (model !== undefined) codex.model = model;
  const yoloMode = getOverride<'off' | 'on' | 'yolo'>('runtime.codex.yoloMode');
  if (yoloMode !== undefined) codex.yoloMode = yoloMode;
  const provider = getOverride<CodexProviderChoice>('runtime.codex.provider');
  if (provider === 'sdk' || provider === 'tmux' || provider === 'pty') codex.provider = provider;
  const sandboxMode = getOverride<CodexSandboxMode>('runtime.codex.sandboxMode');
  if (sandboxMode !== undefined) codex.sandboxMode = sandboxMode;
  const networkAccess = getOverride<boolean>('runtime.codex.networkAccess');
  if (networkAccess !== undefined) codex.networkAccess = networkAccess;
  const reasoningEffort = getOverride<CodexReasoningEffort>('runtime.codex.reasoningEffort');
  if (reasoningEffort !== undefined) codex.reasoningEffort = reasoningEffort;
  return hasKeys(codex) ? { runtime: { codex } } : {};
}

export function getSessionCodexModel(session: SessionConfigLike | null | undefined): string | undefined {
  if (isClaudeRuntime(session)) return undefined;
  return trimOrUndefined(getSessionTomlOverride<string>(session, 'runtime.codex.model'));
}

export function getSessionCodexMode(session: SessionConfigLike | null | undefined): 'normal' | 'yolo' | undefined {
  if (isClaudeRuntime(session)) return undefined;
  const mode = getSessionTomlOverride<'off' | 'on' | 'yolo'>(session, 'runtime.codex.yoloMode');
  if (mode === 'on' || mode === 'yolo') return 'yolo';
  if (mode === 'off') return 'normal';
  return undefined;
}

export function getSessionCodexProvider(session: SessionConfigLike | null | undefined): CodexProviderChoice | undefined {
  if (isClaudeRuntime(session)) return undefined;
  const provider = getSessionTomlOverride<string>(session, 'runtime.codex.provider');
  return provider === 'sdk' || provider === 'tmux' || provider === 'pty' ? provider : undefined;
}

export function getSessionCodexSandboxMode(session: SessionConfigLike | null | undefined): CodexSandboxMode | undefined {
  if (isClaudeRuntime(session)) return undefined;
  const sandboxMode = getSessionTomlOverride<string>(session, 'runtime.codex.sandboxMode');
  return sandboxMode === 'read-only' || sandboxMode === 'workspace-write' || sandboxMode === 'danger-full-access'
    ? sandboxMode
    : undefined;
}

export function getSessionCodexNetworkAccess(session: SessionConfigLike | null | undefined): boolean | undefined {
  if (isClaudeRuntime(session)) return undefined;
  const networkAccess = getSessionTomlOverride<boolean>(session, 'runtime.codex.networkAccess');
  return typeof networkAccess === 'boolean' ? networkAccess : undefined;
}

export function getSessionCodexReasoningEffort(session: SessionConfigLike | null | undefined): CodexReasoningEffort | undefined {
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

export function getSessionClaudeModel(session: SessionConfigLike | null | undefined): string | undefined {
  if (!isClaudeRuntime(session)) return undefined;
  return trimOrUndefined(getSessionTomlOverride<string>(session, 'runtime.claude.model'));
}

export function getSessionClaudeProvider(session: SessionConfigLike | null | undefined): ClaudeProviderChoice | undefined {
  if (!isClaudeRuntime(session)) return undefined;
  const provider = getSessionTomlOverride<string>(session, 'runtime.claude.provider');
  return provider === 'sdk' || provider === 'pty' ? provider : undefined;
}

export function getSessionClaudePermissionMode(session: SessionConfigLike | null | undefined): ClaudePermissionMode | undefined {
  if (!isClaudeRuntime(session)) return undefined;
  const permissionMode = getSessionTomlOverride<string>(session, 'runtime.claude.permissionMode');
  return permissionMode === 'default'
    || permissionMode === 'acceptEdits'
    || permissionMode === 'bypassPermissions'
    || permissionMode === 'plan'
    ? permissionMode
    : undefined;
}

export function getSessionClaudeReasoningEffort(session: SessionConfigLike | null | undefined): 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined {
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

export function getSessionTmuxSessionName(session: SessionConfigLike | null | undefined): string | undefined {
  return trimOrUndefined(getSessionTomlOverride<string>(session, 'session.tmuxSessionName'));
}

export function getSessionWorkingDirectory(session: SessionConfigLike | null | undefined): string | undefined {
  return trimOrUndefined(getSessionTomlOverride<string>(session, 'session.workspace'));
}

export function getSessionTmuxCaptureLines(session: SessionConfigLike | null | undefined): number | undefined {
  return getSessionTomlOverride<number>(session, 'session.tmuxCaptureLines');
}

export function getSessionTmuxAutoEnter(session: SessionConfigLike | null | undefined): boolean | undefined {
  const tomlValue = getSessionTomlOverride<boolean>(session, 'session.tmuxAutoEnter');
  if (typeof tomlValue === 'boolean') return tomlValue;
  return undefined;
}

export function getSessionTmuxEchoInput(session: SessionConfigLike | null | undefined): boolean | undefined {
  const tomlValue = getSessionTomlOverride<boolean>(session, 'session.tmuxEchoInput');
  if (typeof tomlValue === 'boolean') return tomlValue;
  return undefined;
}
