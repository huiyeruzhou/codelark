import {
  normalizeChannelId,
} from "./runtime-options.js";
import { configV2ToLegacyConfig, legacyConfigToConfigPatch } from "./legacy.js";
import { createConfigService } from "./service.js";
import {
  feishuSiteToApiBaseUrl,
  isSupportedChannelProvider,
  normalizeFeishuSite,
  type ChannelProvider,
  type FeishuChannelConfig,
  type FeishuSite,
} from "./channel-types.js";
import type {
  ClaudeExecutable,
  ClaudePermissionMode,
  ClaudeProviderChoice,
  CodexProviderChoice,
  CodexReasoningEffort,
  CodexSandboxMode,
  RuntimeProvider,
} from "./runtime-types.js";
import {
  CODELARK_HOME,
  CONFIG_JSON_PATH,
  CONFIG_PATH,
  DEFAULT_WORKSPACE_ROOT,
  expandHomePath,
} from "./paths.js";

export {
  normalizeClaudeExecutable,
  normalizeClaudePermissionMode,
  normalizeClaudeProviderChoice,
  normalizeCodexProviderChoice,
  normalizeRuntimeProvider,
  type ClaudeExecutable,
  type ClaudePermissionMode,
  type ClaudeProviderChoice,
  type CodexProviderChoice,
  type CodexReasoningEffort,
  type CodexSandboxMode,
  type RuntimeProvider,
} from "./runtime-types.js";
export {
  feishuSiteToApiBaseUrl,
  isSupportedChannelProvider,
  normalizeFeishuSite,
  type ChannelProvider,
  type FeishuChannelConfig,
  type FeishuSite,
} from "./channel-types.js";
export {
  CODELARK_HOME,
  CONFIG_JSON_PATH,
  CONFIG_PATH,
  DEFAULT_CODELARK_HOME,
  DEFAULT_WORKSPACE_ROOT,
  expandHomePath,
} from "./paths.js";

export interface CodexRuntimeDefaultsConfig {
  defaultModel?: string;
  defaultMode?: string;
  skipGitRepoCheck?: boolean;
  sandboxMode?: CodexSandboxMode;
  networkAccess?: boolean;
  reasoningEffort?: CodexReasoningEffort;
}

export interface ClaudeRuntimeDefaultsConfig {
  provider?: ClaudeProviderChoice;
  executable?: ClaudeExecutable;
  defaultModel?: string;
  permissionMode?: ClaudePermissionMode;
  idleTimeoutMinutes?: number;
}

export interface BridgeControlConfig {
  defaultCodexProvider?: CodexProviderChoice;
}

export interface GlobalBridgeConfig {
  defaultWorkspaceRoot?: string;
  historyMessageLimit?: number;
  streamStatusIdleStartSeconds?: number;
  streamStatusCheckIntervalSeconds?: number;
  uiAllowLan?: boolean;
  uiAccessToken?: string;
}

export interface RuntimeConfig {
  provider: RuntimeProvider;
  codex?: CodexRuntimeDefaultsConfig;
  claude?: ClaudeRuntimeDefaultsConfig;
  bridgeControl?: BridgeControlConfig;
  bridge?: GlobalBridgeConfig;
}

export interface ChannelInstance {
  id: string;
  alias: string;
  provider: ChannelProvider;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  config: FeishuChannelConfig;
}

interface ConfigFile {
  schemaVersion: 1;
  runtime: RuntimeConfig;
  channels: ChannelInstance[];
}

function toFeishuConfig(channel?: ChannelInstance): FeishuChannelConfig | undefined {
  return channel?.provider === 'feishu' ? channel.config as FeishuChannelConfig : undefined;
}

export interface Config {
  runtime: RuntimeConfig['provider'];
  defaultWorkspaceRoot?: string;
  defaultModel?: string;
  defaultProvider?: CodexProviderChoice;
  defaultMode: string;
  historyMessageLimit?: number;
  streamStatusIdleStartSeconds?: number;
  streamStatusCheckIntervalSeconds?: number;
  codexSkipGitRepoCheck?: boolean;
  codexSandboxMode?: CodexSandboxMode;
  codexNetworkAccess?: boolean;
  codexReasoningEffort?: CodexReasoningEffort;
  claudeDefaultModel?: string;
  claudeProvider?: ClaudeProviderChoice;
  claudeExecutable?: ClaudeExecutable;
  claudePermissionMode?: ClaudePermissionMode;
  claudeIdleTimeoutMinutes?: number;
  uiAllowLan?: boolean;
  uiAccessToken?: string;
  schemaVersion?: number;
  channels?: ChannelInstance[];
  enabledChannels: string[];
}

const DEFAULT_STREAM_STATUS_IDLE_START_SECONDS = 180;
const DEFAULT_STREAM_STATUS_CHECK_INTERVAL_SECONDS = 10;

function nowIso(): string {
  return new Date().toISOString();
}

function defaultAliasForProvider(provider: ChannelProvider): string {
  return provider === 'feishu' ? '飞书' : provider;
}

function buildDefaultChannelId(provider: ChannelProvider): string {
  return `${provider}-default`;
}

function normalizeDefaultMode(value: unknown): string {
  if (value === 'yolo') return 'yolo';
  return 'normal';
}

function normalizeChannelInstances(value: unknown): ChannelInstance[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry): ChannelInstance[] => {
    if (!entry || typeof entry !== 'object') return [];
    const record = entry as Record<string, unknown>;
    if (!isSupportedChannelProvider(record.provider)) return [];

    const provider = record.provider;
    const config = record.config && typeof record.config === 'object'
      ? record.config as ChannelInstance['config']
      : {};
    const timestamp = nowIso();
    return [{
      id: normalizeChannelId(
        typeof record.id === 'string' && record.id.trim()
          ? record.id
          : buildDefaultChannelId(provider),
      ),
      alias: typeof record.alias === 'string' && record.alias.trim()
        ? record.alias.trim()
        : defaultAliasForProvider(provider),
      provider,
      enabled: record.enabled === true,
      createdAt: typeof record.createdAt === 'string' ? record.createdAt : timestamp,
      updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : timestamp,
      config,
    }];
  });
}

function getChannelByProvider(
  config: ConfigFile,
  provider: ChannelProvider,
): ChannelInstance | undefined {
  const preferredId = buildDefaultChannelId(provider);
  return config.channels.find((channel) => channel.id === preferredId)
    || config.channels.find((channel) => channel.provider === provider);
}

export function loadConfig(): Config {
  return configV2ToLegacyConfig(
    createConfigService({ codelarkHome: CODELARK_HOME }).snapshot().config,
  );
}

export function saveConfig(config: Config): void {
  createConfigService({ codelarkHome: CODELARK_HOME })
    .set({ kind: 'home' }, legacyConfigToConfigPatch(config));
}

export function maskSecret(value: string): string {
  if (value.length <= 4) return "****";
  return "*".repeat(value.length - 4) + value.slice(-4);
}

export function listChannelInstances(config?: Config): ChannelInstance[] {
  return [...(config?.channels || loadConfig().channels || [])];
}

export function findChannelInstance(channelId: string, config?: Config): ChannelInstance | undefined {
  return listChannelInstances(config).find((channel) => channel.id === channelId);
}

export function configToSettings(config: Config): Map<string, string> {
  const m = new Map<string, string>();
  const channels = normalizeChannelInstances(config.channels || []);
  const current: ConfigFile = {
    schemaVersion: 1,
    runtime: {
      provider: config.runtime,
      codex: {
        defaultMode: normalizeDefaultMode(config.defaultMode),
      },
    },
    channels,
  };
  const feishu = getChannelByProvider(current, 'feishu');
  const feishuConfig = toFeishuConfig(feishu);
  m.set("remote_bridge_enabled", "true");
  if (config.defaultWorkspaceRoot) {
    m.set("bridge_default_workspace_root", config.defaultWorkspaceRoot);
  }
  if (config.defaultModel) {
    m.set("bridge_default_model", config.defaultModel);
    m.set("default_model", config.defaultModel);
  }
  if (config.defaultProvider) {
    m.set("bridge_default_provider", config.defaultProvider);
  }
  m.set("bridge_default_runtime", config.runtime === 'claude' ? 'claude' : 'codex');
  m.set("bridge_default_mode", normalizeDefaultMode(config.defaultMode));
  m.set(
    "bridge_history_message_limit",
    String(config.historyMessageLimit && config.historyMessageLimit > 0 ? config.historyMessageLimit : 8),
  );
  m.set(
    "bridge_stream_status_idle_start_seconds",
    String(
      config.streamStatusIdleStartSeconds && config.streamStatusIdleStartSeconds > 0
        ? config.streamStatusIdleStartSeconds
        : DEFAULT_STREAM_STATUS_IDLE_START_SECONDS,
    ),
  );
  m.set(
    "bridge_stream_status_check_interval_seconds",
    String(
      config.streamStatusCheckIntervalSeconds && config.streamStatusCheckIntervalSeconds > 0
        ? config.streamStatusCheckIntervalSeconds
        : DEFAULT_STREAM_STATUS_CHECK_INTERVAL_SECONDS,
    ),
  );
  m.set(
    "bridge_codex_skip_git_repo_check",
    config.codexSkipGitRepoCheck === true ? "true" : "false",
  );
  m.set(
    "bridge_codex_sandbox_mode",
    config.codexSandboxMode || 'workspace-write',
  );
  m.set(
    "bridge_codex_network_access",
    config.codexNetworkAccess === true ? "true" : "false",
  );
  m.set(
    "bridge_codex_reasoning_effort",
    config.codexReasoningEffort || 'medium',
  );
  if (config.claudeExecutable) {
    m.set("bridge_claude_executable", config.claudeExecutable);
  }
  if (config.claudeProvider) {
    m.set("bridge_claude_provider", config.claudeProvider);
  }
  if (config.claudeDefaultModel) {
    m.set("bridge_claude_default_model", config.claudeDefaultModel);
  }
  if (config.claudePermissionMode) {
    m.set("bridge_claude_permission_mode", config.claudePermissionMode);
  }
  if (config.claudeIdleTimeoutMinutes !== undefined) {
    m.set("bridge_claude_idle_timeout_minutes", String(config.claudeIdleTimeoutMinutes));
  }
  m.set(
    "bridge_channel_instances_json",
    JSON.stringify(channels),
  );

  m.set(
    "bridge_feishu_enabled",
    feishu?.enabled === true ? "true" : "false",
  );
  if (feishuConfig?.appId) m.set("bridge_feishu_app_id", feishuConfig.appId);
  if (feishuConfig?.appSecret) m.set("bridge_feishu_app_secret", feishuConfig.appSecret);
  if (feishuConfig?.site) m.set("bridge_feishu_site", feishuConfig.site);
  if (feishuConfig?.allowedUsers) m.set("bridge_feishu_allowed_users", feishuConfig.allowedUsers.join(","));
  m.set(
    "bridge_feishu_streaming_enabled",
    feishuConfig?.streamingEnabled === false ? "false" : "true",
  );
  m.set(
    "bridge_feishu_command_markdown_enabled",
    feishuConfig?.feedbackMarkdownEnabled === false ? "false" : "true",
  );
  m.set(
    "bridge_feishu_require_mention",
    feishuConfig?.requireMention === true ? "true" : "false",
  );

  return m;
}
