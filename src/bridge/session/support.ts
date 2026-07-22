import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  getCodexSessionByThreadId,
  listCodexSessions,
  type CodexSessionSummary,
} from '../../runtime/codex/session-index.js';
import { normalizeClaudeExecutable, type ClaudeExecutable, type ClaudePermissionMode, type ClaudeProviderChoice } from '../../runtime/options.js';
import { createConfigService, type ConfigScope, type EffectiveConfig } from '../../configuration/service.js';
import type { ConfigPatch } from '../../configuration/schema.js';
import type { ConfigV2 } from '../../configuration/schema.js';
import type { ConfigPath } from '../../configuration/fields.js';
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
} from '../../runtime/options.js';
import { shouldUseCodexPtyTui } from '../../runtime/codex/pty-provider.js';
import { shouldUseCodexTmuxTui } from '../../runtime/codex/tmux-provider.js';
import { getBridgeContext } from '../host/context.js';
import {
  buildRuntimeProviderIdentity,
  getSessionActiveRuntime,
  getSessionWorkingDirectory,
} from '../../domain/session-runtime.js';
import type { ChannelChat } from '../../domain/channel.js';
import type {
  BridgeSession,
  BridgeSessionClaudeRuntimeState,
  BridgeSessionCodexRuntimeState,
  KimiProviderChoice,
  RuntimeAgent,
  RuntimeProviderChoice,
  RuntimeProviderIdentity,
} from '../../domain/session.js';
import { validateWorkingDirectory } from '../../shared/security/validators.js';
import {
  getGlobalStringConfig,
  getGlobalWorkspaceRoot,
} from './global-config.js';
import { getConfiguredChannelInstance } from '../../channels/adapter-runtime/channel-runtime.js';

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
  return getGlobalWorkspaceRoot();
}

function getSessionTomlOverride<T>(session: BridgeSession | null | undefined, path: ConfigPath): T | undefined {
  if (!session?.id) return undefined;
  const resolved = createConfigService({ migrate: false }).resolve(path, {
    kind: 'session',
    sessionId: session.id,
  });
  return resolved.source === 'session' ? resolved.value as T : undefined;
}

function scopedConfigForRuntime(
  binding?: ChannelChat | null,
  session?: BridgeSession | null,
): { effective: EffectiveConfig; config: ConfigV2; scope?: ConfigScope } {
  const channelId = binding?.channelType && (binding.channelProvider === undefined || binding.channelProvider === 'feishu')
    ? getConfiguredChannelInstance(binding.channelType)?.id || binding.channelType
    : undefined;
  const scope: ConfigScope | undefined = session?.id
    ? {
        kind: 'session',
        sessionId: session.id,
        ...(channelId ? { channelId, provider: 'feishu' as const } : {}),
      }
    : channelId
      ? { kind: 'channel', channelId, provider: 'feishu' as const }
      : undefined;
  const effective = createConfigService({ migrate: false }).snapshot(scope);
  return { effective, config: effective.config, scope };
}

function hasKeys(value: object): boolean {
  return Object.keys(value).length > 0;
}

export function resolveEffectiveReasoningEffort(
  session: BridgeSession | null | undefined,
  binding?: ChannelChat | null,
): string {
  return normalizeStoredReasoningEffort(scopedConfigForRuntime(binding, session).config.runtime.codex.reasoningEffort);
}

export function resolveEffectiveSandboxMode(
  session?: BridgeSession | null,
  binding?: ChannelChat | null,
): string {
  return normalizeSandboxMode(scopedConfigForRuntime(binding, session).config.runtime.codex.sandboxMode);
}

export function resolveEffectiveNetworkAccess(
  session?: BridgeSession | null,
  binding?: ChannelChat | null,
): boolean {
  return scopedConfigForRuntime(binding, session).config.runtime.codex.networkAccess === true;
}

export function hasSessionCodexSandboxOverride(session?: BridgeSession | null): boolean {
  return getSessionTomlOverride<BridgeSessionCodexRuntimeState['sandboxMode']>(session, 'runtime.codex.sandboxMode') !== undefined;
}

export function hasSessionCodexNetworkAccessOverride(session?: BridgeSession | null): boolean {
  return getSessionTomlOverride<boolean>(session, 'runtime.codex.networkAccess') !== undefined;
}

export type SessionRuntimeProvider = RuntimeProviderChoice;
export type SessionRuntimeCodexProvider = SessionRuntimeProvider;

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

export interface KimiRuntimeConfig {
  runtime: 'kimi';
  provider: KimiProviderChoice;
  model?: string;
}

export interface RuntimeMetadataConfig {
  runtime: RuntimeAgent;
  reasoningEffort: string;
  model: string;
}

export function resolveEffectiveClaudeProvider(
  session?: BridgeSession | null,
  binding?: ChannelChat | null,
): ClaudeProviderChoice {
  const configured = scopedConfigForRuntime(binding, session).config.runtime.claude.provider;
  if (configured === 'sdk' || configured === 'pty' || configured === 'tmux') return configured;
  return 'tmux';
}

export function getSessionClaudeProviderOverride(session?: BridgeSession | null): ClaudeProviderChoice | undefined {
  const tomlProvider = getSessionTomlOverride<ClaudeProviderChoice>(session, 'runtime.claude.provider');
  return tomlProvider === 'sdk' || tomlProvider === 'pty' || tomlProvider === 'tmux' ? tomlProvider : undefined;
}

export function hasSessionClaudeProviderOverride(session?: BridgeSession | null): boolean {
  return getSessionClaudeProviderOverride(session) !== undefined;
}

export function getSessionKimiProviderOverride(session?: BridgeSession | null): KimiProviderChoice | undefined {
  const tomlProvider = getSessionTomlOverride<KimiProviderChoice>(session, 'runtime.kimi.provider');
  return tomlProvider === 'tmux' ? tomlProvider : undefined;
}

export function hasSessionKimiProviderOverride(session?: BridgeSession | null): boolean {
  return getSessionKimiProviderOverride(session) !== undefined;
}

export function resolveEffectiveMode(
  binding?: ChannelChat | null,
  session?: BridgeSession | null,
): 'normal' | 'yolo' {
  const mode = scopedConfigForRuntime(binding, session).config.runtime.codex.yoloMode;
  return mode === 'on' || mode === 'yolo' ? 'yolo' : 'normal';
}

export function resolveEffectiveRuntimeMode(
  binding?: ChannelChat | null,
  session?: BridgeSession | null,
): 'normal' | 'yolo' {
  const activeRuntime = getSessionActiveRuntime(session);
  if (activeRuntime === 'claude') {
    return resolveClaudeRuntimeConfig(session, binding).permissionMode === 'bypassPermissions' ? 'yolo' : 'normal';
  }
  if (activeRuntime === 'kimi') {
    return 'normal';
  }
  return resolveEffectiveMode(binding, session);
}

export function resolveEffectiveCodexProvider(
  session?: BridgeSession | null,
  binding?: ChannelChat | null,
): SessionRuntimeCodexProvider {
  const configured = scopedConfigForRuntime(binding, session).config.runtime.codex.provider;
  if (configured === 'sdk' || configured === 'tmux' || configured === 'pty') return configured;
  return shouldUseCodexPtyTui() ? 'pty' : shouldUseCodexTmuxTui() ? 'tmux' : 'sdk';
}

export function getSessionCodexProviderOverride(session?: BridgeSession | null): SessionRuntimeCodexProvider | undefined {
  const tomlProvider = getSessionTomlOverride<SessionRuntimeCodexProvider>(session, 'runtime.codex.provider');
  return tomlProvider === 'sdk' || tomlProvider === 'tmux' || tomlProvider === 'pty' ? tomlProvider : undefined;
}

export function hasSessionCodexProviderOverride(session?: BridgeSession | null): boolean {
  return getSessionCodexProviderOverride(session) !== undefined;
}

export interface EffectiveRuntimeProvider {
  runtime: RuntimeAgent;
  provider: RuntimeProviderChoice | KimiProviderChoice;
  identity: RuntimeProviderIdentity;
}

export function resolveEffectiveRuntimeProvider(
  session?: BridgeSession | null,
  binding?: ChannelChat | null,
): EffectiveRuntimeProvider {
  const configuredRuntime = scopedConfigForRuntime(binding, session).config.runtime.agent;
  const runtime = getSessionActiveRuntime(session) || configuredRuntime;
  const provider = runtime === 'kimi'
    ? resolveKimiRuntimeConfig(session, binding).provider
    : runtime === 'claude'
      ? resolveEffectiveClaudeProvider(session, binding)
      : resolveEffectiveCodexProvider(session, binding);
  return {
    runtime,
    provider,
    identity: buildRuntimeProviderIdentity(runtime, provider),
  };
}

export function resolveEffectiveSkipGitRepoCheck(): boolean {
  return scopedConfigForRuntime().config.runtime.codex.skipGitRepoCheck === true;
}

export function resolveSessionRuntimeConfig(
  binding?: ChannelChat | null,
  session?: BridgeSession | null,
): SessionRuntimeConfig {
  const { config } = scopedConfigForRuntime(binding, session);
  const yoloMode = config.runtime.codex.yoloMode;
  const mode: 'normal' | 'yolo' = yoloMode === 'on' || yoloMode === 'yolo' ? 'yolo' : 'normal';
  const configuredProvider = config.runtime.codex.provider;
  const codexProvider = configuredProvider === 'sdk' || configuredProvider === 'tmux' || configuredProvider === 'pty'
    ? configuredProvider
    : shouldUseCodexPtyTui() ? 'pty' : shouldUseCodexTmuxTui() ? 'tmux' : 'sdk';
  return {
    [sessionRuntimeConfigBrand]: true,
    mode,
    model: config.runtime.codex.model || '',
    codexProvider,
    sandboxMode: mode === 'yolo' ? 'danger-full-access' : normalizeSandboxMode(config.runtime.codex.sandboxMode),
    networkAccessEnabled: config.runtime.codex.networkAccess === true,
    reasoningEffort: normalizeStoredReasoningEffort(config.runtime.codex.reasoningEffort),
    skipGitRepoCheck: config.runtime.codex.skipGitRepoCheck === true,
  };
}

function parsePositiveSettingInt(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  return undefined;
}

function normalizeClaudeReasoningEffort(value: string | null | undefined): BridgeSessionClaudeRuntimeState['reasoningEffort'] | undefined {
  return value === 'low'
    || value === 'medium'
    || value === 'high'
    || value === 'xhigh'
    || value === 'max'
    ? value
    : undefined;
}

export function resolveClaudeRuntimeConfig(session?: BridgeSession | null, binding?: ChannelChat | null): ClaudeRuntimeConfig {
  const { config } = scopedConfigForRuntime(binding, session);
  const yoloPermissionMode = config.runtime.claude.yoloMode === 'on'
    ? 'bypassPermissions'
    : config.runtime.claude.yoloMode === 'yolo'
      ? 'bypassPermissions'
      : 'default';
  const configuredProvider = config.runtime.claude.provider;
  return {
    runtime: 'claude',
    provider: configuredProvider === 'sdk' || configuredProvider === 'pty' || configuredProvider === 'tmux'
      ? configuredProvider
      : 'tmux',
    executable: normalizeClaudeExecutable(config.runtime.claude.executable) || 'claude',
    model: config.runtime.claude.model || undefined,
    permissionMode: yoloPermissionMode,
    reasoningEffort: normalizeClaudeReasoningEffort(config.runtime.claude.reasoningEffort),
    idleTimeoutMinutes: parsePositiveSettingInt(String(config.runtime.claude.idleTimeoutMinutes ?? '')),
  };
}

export function resolveKimiRuntimeConfig(session?: BridgeSession | null, binding?: ChannelChat | null): KimiRuntimeConfig {
  const { config } = scopedConfigForRuntime(binding, session);
  return {
    runtime: 'kimi',
    provider: 'tmux',
    model: config.runtime.kimi.model || undefined,
  };
}

export function resolveRuntimeMetadataConfig(
  session: BridgeSession | null | undefined,
  runtime: RuntimeAgent = session?.runtime?.activeRuntime === 'claude'
    ? 'claude'
    : session?.runtime?.activeRuntime === 'kimi'
      ? 'kimi'
      : 'codex',
  binding?: ChannelChat | null,
): RuntimeMetadataConfig {
  if (runtime === 'claude') {
    const claudeConfig = resolveClaudeRuntimeConfig(session, binding);
    return {
      runtime: 'claude',
      reasoningEffort: claudeConfig.reasoningEffort || 'default',
      model: claudeConfig.model || 'default',
    };
  }
  if (runtime === 'kimi') {
    const kimiConfig = resolveKimiRuntimeConfig(session, binding);
    return {
      runtime: 'kimi',
      reasoningEffort: 'default',
      model: kimiConfig.model || 'default',
    };
  }
  return {
    runtime: 'codex',
    reasoningEffort: normalizeStoredReasoningEffort(resolveEffectiveReasoningEffort(session, binding)),
    model: resolveDisplayedModel(binding, session),
  };
}

export function sessionCodexRuntimeOverridePatch(session: BridgeSession | null | undefined): ConfigPatch {
  const codex: NonNullable<NonNullable<ConfigPatch['runtime']>['codex']> = {};
  const model = getSessionTomlOverride<string>(session, 'runtime.codex.model');
  if (model !== undefined) codex.model = model;
  const yoloMode = getSessionTomlOverride<'off' | 'on' | 'yolo'>(session, 'runtime.codex.yoloMode');
  if (yoloMode !== undefined) codex.yoloMode = yoloMode;
  const provider = getSessionCodexProviderOverride(session);
  if (provider !== undefined) codex.provider = provider;
  const sandboxMode = getSessionTomlOverride<BridgeSessionCodexRuntimeState['sandboxMode']>(session, 'runtime.codex.sandboxMode');
  if (sandboxMode !== undefined) codex.sandboxMode = sandboxMode;
  const networkAccess = getSessionTomlOverride<boolean>(session, 'runtime.codex.networkAccess');
  if (networkAccess !== undefined) codex.networkAccess = networkAccess;
  const reasoningEffort = getSessionTomlOverride<BridgeSessionCodexRuntimeState['reasoningEffort']>(session, 'runtime.codex.reasoningEffort');
  if (reasoningEffort !== undefined) codex.reasoningEffort = reasoningEffort;
  return hasKeys(codex) ? { runtime: { codex } } : {};
}

export function resolveDisplayedModel(
  binding: ChannelChat | null | undefined,
  session: BridgeSession | null | undefined,
  configuredDefaultModel?: string | null,
  codexDefaultModel?: string | null,
): string {
  const { effective, config } = scopedConfigForRuntime(binding, session);
  const scopedModel = config.runtime.codex.model;
  const modelSource = effective.provenance.get('runtime.codex.model')?.source;
  if (scopedModel && (modelSource === 'session' || modelSource === 'channel' || modelSource === 'request')) {
    return scopedModel;
  }
  return configuredDefaultModel
    || codexDefaultModel
    || scopedModel
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
  const configured = scopedConfigForRuntime().config.channels[0]?.config.historyMessageLimit;
  if (configured === undefined || !Number.isFinite(configured) || configured <= 0) return 8;
  return Math.max(1, Math.min(20, configured));
}

export function getCodexThreadTitle(threadId: string | undefined | null): string | null {
  if (!threadId) return null;
  return getCodexSessionByThreadIdSafe(threadId, 'status lookup')?.title || null;
}
