import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  getCodexSessionByThreadId,
  listCodexSessions,
  type CodexSessionSummary,
} from '../../runtime/codex/session-index.js';
import { DEFAULT_WORKSPACE_ROOT, normalizeClaudeExecutable, type ClaudeExecutable, type ClaudePermissionMode, type ClaudeProviderChoice } from '../../configuration/index.js';
import {
  resetDraftSession as resetDraftSessionForStore,
} from '../session/internal-sessions.js';
import {
  findSelectableCodexModel,
  isCliOnlyCodexModel,
  listSelectableCodexModels,
} from '../../runtime/codex/models.js';
import {
  normalizeReasoningEffort as normalizeStoredReasoningEffort,
  normalizeSandboxMode,
} from '../../configuration/runtime-options.js';
import { shouldUseCodexPtyTui } from '../../runtime/codex/pty-provider.js';
import { shouldUseCodexTmuxTui } from '../../runtime/codex/tmux-provider.js';
import { getBridgeContext } from '../host/context.js';
import {
  getSessionCodexModel,
  getSessionCodexMode,
  getSessionCodexNetworkAccess,
  getSessionCodexProvider,
  getSessionCodexReasoningEffort,
  getSessionCodexSandboxMode,
  getSessionClaudeModel,
  getSessionClaudePermissionMode,
  getSessionClaudeProvider,
  getSessionClaudeReasoningEffort,
  getSessionWorkingDirectory,
} from '../../domain/session-runtime.js';
import type { ChannelChat } from '../../domain/channel.js';
import type { BridgeSession, BridgeSessionClaudeRuntimeState } from '../../domain/session.js';
import { validateWorkingDirectory } from '../../shared/security/validators.js';

const AVAILABLE_CODEX_MODELS = listSelectableCodexModels();
const AVAILABLE_CODEX_MODEL_MAP = new Map(AVAILABLE_CODEX_MODELS.map((model) => [model.slug, model]));

export function getDisplayedCodexThreads(limit: number): CodexSessionSummary[] | null {
  try {
    return listCodexSessions(limit);
  } catch (error) {
    console.error('[bridge-manager] Failed to list codex sessions:', error);
    return null;
  }
}

export function getCodexSessionByThreadIdSafe(
  threadId: string,
  context: string,
): CodexSessionSummary | null {
  try {
    return getCodexSessionByThreadId(threadId);
  } catch (error) {
    console.error(
      `[bridge-manager] Failed to load Codex thread ${threadId} during ${context}:`,
      error,
    );
    return null;
  }
}

export function getWorkspaceRoot(): string {
  const { store } = getBridgeContext();
  return store.getSetting('bridge_default_workspace_root') || DEFAULT_WORKSPACE_ROOT;
}

export function resolveEffectiveReasoningEffort(session: BridgeSession | null | undefined): string {
  const { store } = getBridgeContext();
  return normalizeStoredReasoningEffort(
    getSessionCodexReasoningEffort(session) || store.getSetting('bridge_codex_reasoning_effort'),
  );
}

export function resolveEffectiveSandboxMode(session?: BridgeSession | null): string {
  const { store } = getBridgeContext();
  return normalizeSandboxMode(getSessionCodexSandboxMode(session) || store.getSetting('bridge_codex_sandbox_mode'));
}

export function resolveEffectiveNetworkAccess(session?: BridgeSession | null): boolean {
  const { store } = getBridgeContext();
  const sessionValue = getSessionCodexNetworkAccess(session);
  if (typeof sessionValue === 'boolean') {
    return sessionValue;
  }
  return (store.getSetting('bridge_codex_network_access') || '').toLowerCase() === 'true';
}

export type SessionRuntimeCodexProvider = 'sdk' | 'tmux' | 'pty';

export const sessionRuntimeConfigBrand: unique symbol = Symbol('SessionRuntimeConfig');

export interface SessionRuntimeConfig {
  /**
   * Brand marker: runtime execution must use config returned by
   * resolveSessionRuntimeConfig(), not ad-hoc raw BridgeSession fields.
   */
  readonly [sessionRuntimeConfigBrand]: true;
  mode: 'normal' | 'yolo';
  model: string;
  codexProvider: SessionRuntimeCodexProvider;
  sandboxMode: string;
  networkAccessEnabled: boolean;
  reasoningEffort: string;
  skipGitRepoCheck: boolean;
}

export interface ClaudeRuntimeConfig {
  runtime: 'claude';
  provider: ClaudeProviderChoice;
  executable: ClaudeExecutable;
  model?: string;
  permissionMode: ClaudePermissionMode;
  reasoningEffort?: BridgeSessionClaudeRuntimeState['reasoningEffort'];
  idleTimeoutMinutes?: number;
}

export function resolveEffectiveClaudeProvider(session?: BridgeSession | null): ClaudeProviderChoice {
  const { store } = getBridgeContext();
  const sessionProvider = getSessionClaudeProvider(session);
  if (sessionProvider === 'sdk' || sessionProvider === 'pty' || sessionProvider === 'tmux') return sessionProvider;
  const configured = store.getSetting('bridge_claude_provider');
  if (configured === 'sdk' || configured === 'pty' || configured === 'tmux') return configured;
  return 'pty';
}

export function resolveEffectiveMode(
  _binding?: ChannelChat | null,
  session?: BridgeSession | null,
): 'normal' | 'yolo' {
  return (getSessionCodexMode(session) || getBridgeContext().store.getSetting('bridge_default_mode')) === 'yolo'
    ? 'yolo'
    : 'normal';
}

export function resolveEffectiveCodexProvider(session?: BridgeSession | null): SessionRuntimeCodexProvider {
  const { store } = getBridgeContext();
  const sessionProvider = getSessionCodexProvider(session);
  if (sessionProvider === 'sdk' || sessionProvider === 'tmux' || sessionProvider === 'pty') return sessionProvider;
  const configured = store.getSetting('bridge_default_provider');
  if (configured === 'sdk' || configured === 'tmux' || configured === 'pty') return configured;
  return shouldUseCodexPtyTui() ? 'pty' : shouldUseCodexTmuxTui() ? 'tmux' : 'sdk';
}

export function resolveEffectiveSkipGitRepoCheck(): boolean {
  return (getBridgeContext().store.getSetting('bridge_codex_skip_git_repo_check') || '').toLowerCase() === 'true';
}

export function resolveSessionRuntimeConfig(
  binding?: ChannelChat | null,
  session?: BridgeSession | null,
): SessionRuntimeConfig {
  const { store } = getBridgeContext();
  const mode = resolveEffectiveMode(binding, session);
  return {
    [sessionRuntimeConfigBrand]: true,
    mode,
    model: getSessionCodexModel(session) || store.getSetting('bridge_default_model') || '',
    codexProvider: resolveEffectiveCodexProvider(session),
    sandboxMode: mode === 'yolo' ? 'danger-full-access' : resolveEffectiveSandboxMode(session),
    networkAccessEnabled: resolveEffectiveNetworkAccess(session),
    reasoningEffort: resolveEffectiveReasoningEffort(session),
    skipGitRepoCheck: resolveEffectiveSkipGitRepoCheck(),
  };
}

function normalizeClaudePermissionMode(value: string | null | undefined): ClaudePermissionMode | undefined {
  if (value === 'acceptEdits' || value === 'bypassPermissions' || value === 'plan' || value === 'default') return value;
  return undefined;
}

function normalizeClaudeReasoningEffort(
  value: string | null | undefined,
): BridgeSessionClaudeRuntimeState['reasoningEffort'] | undefined {
  if (value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max') return value;
  return undefined;
}

function parsePositiveSettingInt(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  return undefined;
}

export function resolveClaudeRuntimeConfig(session?: BridgeSession | null): ClaudeRuntimeConfig {
  const { store } = getBridgeContext();
  return {
    runtime: 'claude',
    provider: resolveEffectiveClaudeProvider(session),
    executable: normalizeClaudeExecutable(store.getSetting('bridge_claude_executable')) || 'claude',
    model: getSessionClaudeModel(session) || store.getSetting('bridge_claude_default_model') || undefined,
    permissionMode: getSessionClaudePermissionMode(session)
      || normalizeClaudePermissionMode(store.getSetting('bridge_claude_permission_mode'))
      || 'default',
    reasoningEffort: getSessionClaudeReasoningEffort(session)
      || normalizeClaudeReasoningEffort(store.getSetting('bridge_claude_reasoning_effort')),
    idleTimeoutMinutes: parsePositiveSettingInt(store.getSetting('bridge_claude_idle_timeout_minutes')),
  };
}

export function resolveDisplayedModel(
  _binding: ChannelChat | null | undefined,
  session: BridgeSession | null | undefined,
  configuredDefaultModel?: string | null,
  codexDefaultModel?: string | null,
): string {
  return getSessionCodexModel(session)
    || configuredDefaultModel
    || codexDefaultModel
    || 'default';
}

export function formatDisplayedModel(model: string): string {
  const metadata = AVAILABLE_CODEX_MODEL_MAP.get(model) || findSelectableCodexModel(model);
  return metadata && isCliOnlyCodexModel(metadata)
    ? `${model}（仅 IM / CLI）`
    : model;
}

export function getAvailableModelChoicesText(): string {
  if (AVAILABLE_CODEX_MODELS.length === 0) {
    return '当前没有可用模型缓存；请检查 `~/.codex/models_cache.json`，然后重启 Bridge。';
  }
  return `可选模型：${AVAILABLE_CODEX_MODELS.map((model) => formatDisplayedModel(model.slug)).join('、')}`;
}

export function getSelectableCodexModel(slug: string) {
  return AVAILABLE_CODEX_MODEL_MAP.get(slug) || findSelectableCodexModel(slug);
}

export function expandHomePath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (trimmed === '~') return os.homedir();
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return trimmed;
}

export function resolveNewWorkingDirectory(rawArgs: string): { ok: true; workDir: string } | { ok: false; message: string } {
  const trimmed = expandHomePath(rawArgs);
  if (!trimmed) {
    return { ok: false, message: '缺少路径参数。' };
  }

  if (path.isAbsolute(trimmed) || path.win32.isAbsolute(trimmed)) {
    const validated = validateWorkingDirectory(trimmed);
    if (!validated) {
      return { ok: false, message: '路径无效。必须是绝对路径，且不能包含目录穿越或特殊字符。' };
    }
    return { ok: true, workDir: validated };
  }

  const workspaceRoot = getWorkspaceRoot();

  if (trimmed.includes('\0') || /[$`;|&><(){}\x00-\x1f]/.test(trimmed)) {
    return { ok: false, message: '项目名无效。' };
  }

  const normalizedRelative = path.normalize(trimmed);
  if (
    !normalizedRelative
    || normalizedRelative === '.'
    || normalizedRelative.split(/[\\/]/).some((segment) => segment === '..')
  ) {
    return { ok: false, message: '项目名无效。不能使用 .. 或空路径。' };
  }

  const resolvedRoot = path.resolve(workspaceRoot);
  const resolvedPath = path.resolve(resolvedRoot, normalizedRelative);
  const relative = path.relative(resolvedRoot, resolvedPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return { ok: false, message: '项目路径越界。新项目必须创建在默认工作空间内。' };
  }

  const validated = validateWorkingDirectory(resolvedPath);
  if (!validated) {
    return { ok: false, message: '解析后的工作目录无效。' };
  }
  return { ok: true, workDir: validated };
}

export function resolveSessionWorkingDirectoryPath(
  rawPath: string,
  currentWorkingDirectory?: string | null,
): { ok: true; workDir: string } | { ok: false; message: string } {
  const trimmed = expandHomePath(rawPath);
  if (!trimmed) {
    return { ok: false, message: '缺少路径参数。' };
  }

  const baseDir = currentWorkingDirectory?.trim() || process.cwd();
  const resolvedPath = (path.isAbsolute(trimmed) || path.win32.isAbsolute(trimmed))
    ? trimmed
    : path.resolve(baseDir, trimmed);
  const validated = validateWorkingDirectory(resolvedPath);
  if (!validated) {
    return { ok: false, message: '路径无效。必须是有效目录路径，且不能包含特殊字符。' };
  }
  return { ok: true, workDir: validated };
}

export function resolveNewSessionWorkingDirectory(
  rawArgs: string,
  binding: ChannelChat | null,
  session: BridgeSession | null | undefined,
): { ok: true; workDir: string } | { ok: false; message: string } {
  const trimmed = rawArgs.trim();
  if (trimmed) {
    return resolveNewWorkingDirectory(trimmed);
  }

  if (!binding || !session) {
    const validatedDefault = validateWorkingDirectory(getWorkspaceRoot());
    if (validatedDefault) return { ok: true, workDir: validatedDefault };
    return { ok: false, message: '全局默认工作目录无效，请先用 `/set defaultWorkspaceRoot <目录>` 设置有效目录。' };
  }

  const validated = validateWorkingDirectory(getSessionWorkingDirectory(session) || '');
  if (!validated) {
    return {
      ok: false,
      message: '当前会话没有有效的工作目录。请改用 `/new proj1` 或 `/new 绝对路径`。',
    };
  }

  return { ok: true, workDir: validated };
}

export function ensureWorkingDirectoryExists(workDir: string): void {
  fs.mkdirSync(workDir, { recursive: true });
}

export function resetDraftSession(address: { channelType: string; chatId: string; userId?: string }): BridgeSession {
  const { store } = getBridgeContext();
  return resetDraftSessionForStore(store, address);
}

export function getHistoryMessageLimit(): number {
  const { store } = getBridgeContext();
  const configured = Number.parseInt(store.getSetting('bridge_history_message_limit') || '', 10);
  if (!Number.isFinite(configured) || configured <= 0) return 8;
  return Math.max(1, Math.min(20, configured));
}

export function getCodexThreadTitle(threadId: string | undefined | null): string | null {
  if (!threadId) return null;
  return getCodexSessionByThreadIdSafe(threadId, 'status lookup')?.title || null;
}
