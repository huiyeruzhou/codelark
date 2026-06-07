import crypto from 'node:crypto';
import os from 'node:os';

import {
  isSupportedChannelProvider,
  type ChannelInstance,
  type Config,
} from '../../configuration/index.js';
import type { ConfigPatch, ConfigV2 } from '../../configuration/schema.js';
import { listSelectableCodexModels, readConfiguredCodexModel } from '../../runtime/codex/models.js';

const availableCodexModels = listSelectableCodexModels();
const availableCodexModelSlugs = new Set(availableCodexModels.map((model) => model.slug));

function asString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function asPositiveInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }
  return undefined;
}

function asNonNegativeInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.floor(parsed);
    }
  }
  return undefined;
}

function clampHistoryMessageLimit(value: unknown, fallback: number): number {
  const parsed = asPositiveInt(value);
  const base = parsed ?? fallback;
  return Math.min(Math.max(base, 1), 20);
}

function hasPayloadKey(payload: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(payload, key);
}

function generateAccessToken(): string {
  return crypto.randomBytes(18).toString('base64url');
}

export function channelToPayload(channel: ChannelInstance) {
  return {
    id: channel.id,
    alias: channel.alias,
    provider: channel.provider,
    enabled: channel.enabled,
    createdAt: channel.createdAt,
    updatedAt: channel.updatedAt,
    config: { ...channel.config },
  };
}

export function configToPayload(config: Config) {
  return {
    runtime: config.runtime,
    defaultWorkspaceRoot: config.defaultWorkspaceRoot || '',
    defaultModel: config.defaultModel || '',
    defaultProvider: config.defaultProvider || '',
    codexDefaultModel: readConfiguredCodexModel() || '',
    availableModels: availableCodexModels,
    defaultMode: config.defaultMode,
    historyMessageLimit: config.historyMessageLimit ?? 8,
    streamStatusIdleStartSeconds: config.streamStatusIdleStartSeconds ?? 180,
    streamStatusCheckIntervalSeconds: config.streamStatusCheckIntervalSeconds ?? 10,
    codexSkipGitRepoCheck: config.codexSkipGitRepoCheck === true,
    codexSandboxMode: config.codexSandboxMode || 'workspace-write',
    codexNetworkAccess: config.codexNetworkAccess !== false,
    codexReasoningEffort: config.codexReasoningEffort || 'medium',
    claudeProvider: config.claudeProvider || 'sdk',
    claudeExecutable: config.claudeExecutable || 'claude',
    claudeDefaultModel: config.claudeDefaultModel || '',
    claudePermissionMode: config.claudePermissionMode || 'default',
    claudeIdleTimeoutMinutes: config.claudeIdleTimeoutMinutes ?? 0,
    uiAllowLan: config.uiAllowLan === true,
    uiAccessToken: config.uiAccessToken || '',
    channels: (config.channels || [])
      .filter((channel) => isSupportedChannelProvider(channel.provider))
      .map(channelToPayload),
  };
}

function defaultUiChannel(config: ConfigV2): ConfigV2['channels'][number] | undefined {
  return config.channels.find((channel) => channel.id === 'feishu-default') || config.channels[0];
}

function v2ChannelToPayload(channel: ConfigV2['channels'][number]) {
  return {
    id: channel.id,
    alias: channel.alias,
    provider: channel.provider,
    enabled: channel.enabled,
    config: { ...channel.config },
  };
}

export function configV2ToPayload(config: ConfigV2) {
  const channel = defaultUiChannel(config);
  return {
    runtime: config.runtime.agent,
    defaultWorkspaceRoot: config.bridge.defaultWorkspace === '~' ? os.homedir() : config.bridge.defaultWorkspace,
    defaultModel: config.runtime.codex.model || '',
    defaultProvider: config.runtime.codex.provider || '',
    codexDefaultModel: readConfiguredCodexModel() || '',
    availableModels: availableCodexModels,
    defaultMode: config.runtime.codex.yoloMode === 'on' || config.runtime.codex.yoloMode === 'yolo' ? 'yolo' : 'normal',
    historyMessageLimit: channel?.config.historyMessageLimit,
    streamStatusIdleStartSeconds: channel?.config.streamStatusIdleStartSeconds,
    streamStatusCheckIntervalSeconds: channel?.config.streamStatusCheckIntervalSeconds,
    codexSkipGitRepoCheck: config.runtime.codex.skipGitRepoCheck === true,
    codexSandboxMode: config.runtime.codex.sandboxMode || 'workspace-write',
    codexNetworkAccess: config.runtime.codex.networkAccess !== false,
    codexReasoningEffort: config.runtime.codex.reasoningEffort || 'medium',
    claudeProvider: config.runtime.claude.provider || 'sdk',
    claudeExecutable: config.runtime.claude.executable || 'claude',
    claudeDefaultModel: config.runtime.claude.model || '',
    claudePermissionMode: config.runtime.claude.permissionMode || 'default',
    claudeIdleTimeoutMinutes: config.runtime.claude.idleTimeoutMinutes ?? 0,
    uiAllowLan: config.bridge.uiAllowLan === true,
    uiAccessToken: config.bridge.uiAccessToken || '',
    channels: config.channels.map(v2ChannelToPayload),
  };
}

export function mergeConfigV2HomePatch(current: ConfigV2, payload: Record<string, unknown>): ConfigPatch {
  const rawDefaultModel = typeof payload.defaultModel === 'string'
    ? payload.defaultModel.trim()
    : undefined;
  const rawDefaultProvider = typeof payload.defaultProvider === 'string'
    ? payload.defaultProvider.trim().toLowerCase()
    : undefined;
  const rawRuntime = typeof payload.runtime === 'string'
    ? payload.runtime.trim().toLowerCase()
    : undefined;
  const rawClaudeDefaultModel = typeof payload.claudeDefaultModel === 'string'
    ? payload.claudeDefaultModel.trim()
    : undefined;
  const rawClaudeProvider = typeof payload.claudeProvider === 'string'
    ? payload.claudeProvider.trim().toLowerCase()
    : undefined;
  const rawClaudeExecutable = typeof payload.claudeExecutable === 'string'
    ? payload.claudeExecutable.trim().toLowerCase()
    : undefined;
  const rawClaudePermissionMode = typeof payload.claudePermissionMode === 'string'
    ? payload.claudePermissionMode.trim()
    : undefined;
  const uiAllowLan = hasPayloadKey(payload, 'uiAllowLan')
    ? payload.uiAllowLan === true
    : current.bridge.uiAllowLan;
  const requestedUiAccessToken = asString(payload.uiAccessToken);
  const uiAccessToken = requestedUiAccessToken
    || current.bridge.uiAccessToken
    || (uiAllowLan ? generateAccessToken() : '');
  const claudePermissionMode = rawClaudePermissionMode === 'acceptEdits'
    || rawClaudePermissionMode === 'bypassPermissions'
    || rawClaudePermissionMode === 'plan'
    || rawClaudePermissionMode === 'default'
    ? rawClaudePermissionMode
    : current.runtime.claude.permissionMode;
  const currentChannel = defaultUiChannel(current);
  const historyMessageLimit = currentChannel
    ? clampHistoryMessageLimit(payload.historyMessageLimit, currentChannel.config.historyMessageLimit)
    : undefined;
  const streamStatusIdleStartSeconds = asPositiveInt(payload.streamStatusIdleStartSeconds)
    || currentChannel?.config.streamStatusIdleStartSeconds;
  const streamStatusCheckIntervalSeconds = asPositiveInt(payload.streamStatusCheckIntervalSeconds)
    || currentChannel?.config.streamStatusCheckIntervalSeconds;

  return {
    schemaVersion: 2,
    runtime: {
      agent: rawRuntime === 'claude' || rawRuntime === 'codex'
        ? rawRuntime
        : current.runtime.agent,
      codex: {
        model: rawDefaultModel === undefined
          ? current.runtime.codex.model
          : rawDefaultModel === ''
            ? ''
            : availableCodexModelSlugs.has(rawDefaultModel)
              ? rawDefaultModel
              : current.runtime.codex.model,
        provider: rawDefaultProvider === undefined
          ? current.runtime.codex.provider
          : rawDefaultProvider === 'sdk' || rawDefaultProvider === 'tmux' || rawDefaultProvider === 'pty'
            ? rawDefaultProvider
            : current.runtime.codex.provider,
        yoloMode: hasPayloadKey(payload, 'defaultMode')
          ? payload.defaultMode === 'yolo' ? 'on' : 'off'
          : current.runtime.codex.yoloMode,
        skipGitRepoCheck: hasPayloadKey(payload, 'codexSkipGitRepoCheck')
          ? payload.codexSkipGitRepoCheck === true
          : current.runtime.codex.skipGitRepoCheck,
        sandboxMode: payload.codexSandboxMode === 'read-only'
          || payload.codexSandboxMode === 'workspace-write'
          || payload.codexSandboxMode === 'danger-full-access'
          ? payload.codexSandboxMode
          : current.runtime.codex.sandboxMode,
        networkAccess: hasPayloadKey(payload, 'codexNetworkAccess')
          ? payload.codexNetworkAccess !== false
          : current.runtime.codex.networkAccess,
        reasoningEffort: payload.codexReasoningEffort === 'minimal'
          || payload.codexReasoningEffort === 'low'
          || payload.codexReasoningEffort === 'medium'
          || payload.codexReasoningEffort === 'high'
          || payload.codexReasoningEffort === 'xhigh'
          ? payload.codexReasoningEffort
          : current.runtime.codex.reasoningEffort,
      },
      claude: {
        model: rawClaudeDefaultModel === undefined
          ? current.runtime.claude.model
          : rawClaudeDefaultModel || '',
        provider: rawClaudeProvider === undefined
          ? current.runtime.claude.provider
          : rawClaudeProvider === 'sdk' || rawClaudeProvider === 'pty'
            ? rawClaudeProvider
            : 'sdk',
        executable: rawClaudeExecutable === 'ccr' || rawClaudeExecutable === 'claude'
          ? rawClaudeExecutable
          : current.runtime.claude.executable,
        permissionMode: claudePermissionMode,
        yoloMode: claudePermissionMode === 'bypassPermissions' ? 'on' : 'off',
        reasoningEffort: current.runtime.claude.reasoningEffort,
        idleTimeoutMinutes: asNonNegativeInt(payload.claudeIdleTimeoutMinutes)
          ?? current.runtime.claude.idleTimeoutMinutes
          ?? 0,
      },
    },
    bridge: {
      defaultWorkspace: hasPayloadKey(payload, 'defaultWorkspaceRoot')
        ? asString(payload.defaultWorkspaceRoot) || '~'
        : current.bridge.defaultWorkspace,
      uiAllowLan,
      uiAccessToken,
    },
    channels: current.channels.map((channel) => ({
      ...channel,
      config: {
        ...channel.config,
        ...(historyMessageLimit !== undefined ? { historyMessageLimit } : {}),
        ...(streamStatusIdleStartSeconds !== undefined ? { streamStatusIdleStartSeconds } : {}),
        ...(streamStatusCheckIntervalSeconds !== undefined ? { streamStatusCheckIntervalSeconds } : {}),
      },
    })),
  };
}

export function mergeConfig(current: Config, payload: Record<string, unknown>): Config {
  const rawDefaultModel = typeof payload.defaultModel === 'string'
    ? payload.defaultModel.trim()
    : undefined;
  const rawDefaultProvider = typeof payload.defaultProvider === 'string'
    ? payload.defaultProvider.trim().toLowerCase()
    : undefined;
  const rawRuntime = typeof payload.runtime === 'string'
    ? payload.runtime.trim().toLowerCase()
    : undefined;
  const rawClaudeDefaultModel = typeof payload.claudeDefaultModel === 'string'
    ? payload.claudeDefaultModel.trim()
    : undefined;
  const rawClaudeProvider = typeof payload.claudeProvider === 'string'
    ? payload.claudeProvider.trim().toLowerCase()
    : undefined;
  const rawClaudeExecutable = typeof payload.claudeExecutable === 'string'
    ? payload.claudeExecutable.trim().toLowerCase()
    : undefined;
  const rawClaudePermissionMode = typeof payload.claudePermissionMode === 'string'
    ? payload.claudePermissionMode.trim()
    : undefined;
  const uiAllowLan = payload.uiAllowLan === true;
  const requestedUiAccessToken = asString(payload.uiAccessToken);
  const uiAccessToken = requestedUiAccessToken
    || current.uiAccessToken
    || (uiAllowLan ? generateAccessToken() : undefined);

  return {
    ...current,
    runtime: rawRuntime === 'claude' ? 'claude' : 'codex',
    enabledChannels: current.enabledChannels,
    defaultWorkspaceRoot: asString(payload.defaultWorkspaceRoot),
    defaultModel: rawDefaultModel === undefined
      ? current.defaultModel
      : rawDefaultModel === ''
        ? undefined
        : availableCodexModelSlugs.has(rawDefaultModel)
          ? rawDefaultModel
          : current.defaultModel,
    defaultProvider: rawDefaultProvider === undefined
      ? current.defaultProvider
      : rawDefaultProvider === 'sdk' || rawDefaultProvider === 'tmux' || rawDefaultProvider === 'pty'
        ? rawDefaultProvider
        : undefined,
    defaultMode: payload.defaultMode === 'yolo' ? 'yolo' : 'normal',
    historyMessageLimit: clampHistoryMessageLimit(payload.historyMessageLimit, current.historyMessageLimit || 8),
    streamStatusIdleStartSeconds: asPositiveInt(payload.streamStatusIdleStartSeconds)
      || current.streamStatusIdleStartSeconds
      || 180,
    streamStatusCheckIntervalSeconds: asPositiveInt(payload.streamStatusCheckIntervalSeconds)
      || current.streamStatusCheckIntervalSeconds
      || 10,
    codexSkipGitRepoCheck: payload.codexSkipGitRepoCheck === true,
    codexSandboxMode: payload.codexSandboxMode === 'read-only'
      || payload.codexSandboxMode === 'workspace-write'
      || payload.codexSandboxMode === 'danger-full-access'
      ? payload.codexSandboxMode
      : 'workspace-write',
    codexNetworkAccess: payload.codexNetworkAccess !== false,
    codexReasoningEffort: payload.codexReasoningEffort === 'minimal'
      || payload.codexReasoningEffort === 'low'
      || payload.codexReasoningEffort === 'high'
      || payload.codexReasoningEffort === 'xhigh'
      ? payload.codexReasoningEffort
      : 'medium',
    claudeDefaultModel: rawClaudeDefaultModel === undefined
      ? current.claudeDefaultModel
      : rawClaudeDefaultModel || undefined,
    claudeProvider: rawClaudeProvider === undefined
      ? current.claudeProvider
      : rawClaudeProvider === 'sdk' || rawClaudeProvider === 'pty'
        ? rawClaudeProvider
        : undefined,
    claudeExecutable: rawClaudeExecutable === 'ccr' || rawClaudeExecutable === 'claude'
      ? rawClaudeExecutable
      : current.claudeExecutable,
    claudePermissionMode: rawClaudePermissionMode === 'acceptEdits'
      || rawClaudePermissionMode === 'bypassPermissions'
      || rawClaudePermissionMode === 'plan'
      || rawClaudePermissionMode === 'default'
      ? rawClaudePermissionMode
      : current.claudePermissionMode,
    claudeIdleTimeoutMinutes: asNonNegativeInt(payload.claudeIdleTimeoutMinutes)
      ?? current.claudeIdleTimeoutMinutes
      ?? 0,
    uiAllowLan,
    uiAccessToken,
    channels: current.channels,
  };
}
