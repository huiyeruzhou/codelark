import crypto from 'node:crypto';
import os from 'node:os';
import { z } from 'zod';

import { createConfigService } from '../../configuration/service.js';
import {
  claudeExecutableSchema,
  claudePermissionModeSchema,
  claudeProviderSchema,
  codexProviderSchema,
  reasoningEffortSchema,
  runtimeAgentSchema,
  sandboxModeSchema,
  type ConfigPatch,
  type ConfigV2,
} from '../../configuration/schema.js';
import { listSelectableCodexModels, readConfiguredCodexModel } from '../../runtime/codex/models.js';

const availableCodexModels = listSelectableCodexModels();
const availableCodexModelSlugs = new Set(availableCodexModels.map((model) => model.slug));

function hasPayloadKey(payload: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(payload, key);
}

function generateAccessToken(): string {
  return crypto.randomBytes(18).toString('base64url');
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

function optionalString() {
  return z.preprocess(
    (value) => typeof value === 'string' ? value.trim() : value,
    z.string(),
  ).optional();
}

function optionalEnum<T extends z.ZodEnum>(schema: T) {
  return z.preprocess(
    (value) => typeof value === 'string' ? value.trim().toLowerCase() : value,
    schema,
  ).optional();
}

function optionalPositiveInteger() {
  return z.preprocess(
    (value) => typeof value === 'string' ? Number(value.trim()) : value,
    z.number().int().positive(),
  ).optional();
}

function optionalNonNegativeInteger() {
  return z.preprocess(
    (value) => typeof value === 'string' ? Number(value.trim()) : value,
    z.number().int().nonnegative(),
  ).optional();
}

const uiConfigPayloadSchema = z.object({
  runtime: optionalEnum(runtimeAgentSchema),
  defaultWorkspaceRoot: optionalString(),
  defaultModel: optionalString().refine(
    (value) => value === undefined || value === '' || availableCodexModelSlugs.has(value),
    { message: 'Unknown Codex model.' },
  ),
  defaultProvider: z.preprocess(
    (value) => typeof value === 'string' ? value.trim().toLowerCase() : value,
    z.union([codexProviderSchema, z.literal('')]),
  ).optional(),
  defaultMode: z.enum(['normal', 'yolo']).optional(),
  historyMessageLimit: optionalPositiveInteger().refine(
    (value) => value === undefined || value <= 20,
    { message: 'History message limit must be between 1 and 20.' },
  ),
  streamStatusIdleStartSeconds: optionalPositiveInteger(),
  streamStatusCheckIntervalSeconds: optionalPositiveInteger(),
  codexSkipGitRepoCheck: z.boolean().optional(),
  codexSandboxMode: optionalEnum(sandboxModeSchema),
  codexNetworkAccess: z.boolean().optional(),
  codexReasoningEffort: optionalEnum(reasoningEffortSchema),
  claudeProvider: optionalEnum(claudeProviderSchema),
  claudeExecutable: optionalEnum(claudeExecutableSchema),
  claudeDefaultModel: optionalString(),
  claudePermissionMode: z.preprocess(
    (value) => typeof value === 'string' ? value.trim() : value,
    claudePermissionModeSchema,
  ).optional(),
  claudeIdleTimeoutMinutes: optionalNonNegativeInteger(),
  uiAllowLan: z.boolean().optional(),
  uiAccessToken: optionalString(),
}).strict();

type UiConfigPayload = z.infer<typeof uiConfigPayloadSchema>;

export function parseUiConfigPayload(payload: Record<string, unknown>): UiConfigPayload {
  return uiConfigPayloadSchema.parse(payload);
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
    claudeProvider: config.runtime.claude.provider || 'tmux',
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
  const parsed = parseUiConfigPayload(payload);
  const uiAllowLan = hasPayloadKey(payload, 'uiAllowLan')
    ? parsed.uiAllowLan === true
    : current.bridge.uiAllowLan;
  const requestedUiAccessToken = parsed.uiAccessToken || undefined;
  const uiAccessToken = requestedUiAccessToken
    || current.bridge.uiAccessToken
    || (uiAllowLan ? generateAccessToken() : '');
  const claudePermissionMode = parsed.claudePermissionMode ?? current.runtime.claude.permissionMode;
  const currentChannel = defaultUiChannel(current);
  const historyMessageLimit = currentChannel
    ? parsed.historyMessageLimit ?? currentChannel.config.historyMessageLimit
    : undefined;
  const streamStatusIdleStartSeconds = parsed.streamStatusIdleStartSeconds
    ?? currentChannel?.config.streamStatusIdleStartSeconds;
  const streamStatusCheckIntervalSeconds = parsed.streamStatusCheckIntervalSeconds
    ?? currentChannel?.config.streamStatusCheckIntervalSeconds;

  return {
    schemaVersion: 2,
    runtime: {
      agent: parsed.runtime ?? current.runtime.agent,
      codex: {
        model: parsed.defaultModel === undefined
          ? current.runtime.codex.model
          : parsed.defaultModel === ''
            ? ''
            : parsed.defaultModel,
        provider: parsed.defaultProvider === undefined
          ? current.runtime.codex.provider
          : parsed.defaultProvider,
        yoloMode: hasPayloadKey(payload, 'defaultMode')
          ? parsed.defaultMode === 'yolo' ? 'on' : 'off'
          : current.runtime.codex.yoloMode,
        skipGitRepoCheck: hasPayloadKey(payload, 'codexSkipGitRepoCheck')
          ? parsed.codexSkipGitRepoCheck === true
          : current.runtime.codex.skipGitRepoCheck,
        sandboxMode: parsed.codexSandboxMode ?? current.runtime.codex.sandboxMode,
        networkAccess: hasPayloadKey(payload, 'codexNetworkAccess')
          ? parsed.codexNetworkAccess !== false
          : current.runtime.codex.networkAccess,
        reasoningEffort: parsed.codexReasoningEffort ?? current.runtime.codex.reasoningEffort,
      },
      claude: {
        model: parsed.claudeDefaultModel === undefined
          ? current.runtime.claude.model
          : parsed.claudeDefaultModel || '',
        provider: parsed.claudeProvider === undefined
          ? current.runtime.claude.provider
          : parsed.claudeProvider,
        executable: parsed.claudeExecutable ?? current.runtime.claude.executable,
        permissionMode: claudePermissionMode,
        yoloMode: claudePermissionMode === 'bypassPermissions' ? 'on' : 'off',
        reasoningEffort: current.runtime.claude.reasoningEffort,
        idleTimeoutMinutes: parsed.claudeIdleTimeoutMinutes
          ?? current.runtime.claude.idleTimeoutMinutes
          ?? 0,
      },
    },
    bridge: {
      defaultWorkspace: hasPayloadKey(payload, 'defaultWorkspaceRoot')
        ? parsed.defaultWorkspaceRoot || '~'
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

export function checkUiConfigPayload(payload: Record<string, unknown>): void {
  const service = createConfigService({ migrate: false });
  mergeConfigV2HomePatch(service.snapshot().config, payload);
}

export function homeWritableConfigPatch(config: ConfigV2): ConfigPatch {
  return {
    schemaVersion: config.schemaVersion,
    runtime: config.runtime,
    bridge: config.bridge,
    channels: config.channels,
  };
}

export function readUiHomeConfig(): ConfigV2 {
  return createConfigService({ migrate: false }).snapshot().config;
}

export function replaceUiHomeConfig(config: ConfigV2): void {
  createConfigService({ migrate: false }).replace({ kind: 'home' }, homeWritableConfigPatch(config));
}

export function saveUiConfigPayload(payload: Record<string, unknown>): ConfigV2 {
  const service = createConfigService({ migrate: false });
  service.replace({ kind: 'home' }, mergeConfigV2HomePatch(service.snapshot().config, payload));
  return service.snapshot().config;
}
