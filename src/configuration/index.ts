import os from "node:os";
import path from "node:path";
import {
  normalizeChannelId,
  type RuntimeReasoningEffort,
  type RuntimeSandboxMode,
} from "./runtime-options.js";
import { configV2ToLegacyConfig, legacyConfigToConfigPatch } from "./legacy.js";
import { createConfigService } from "./service.js";

export type CodexSandboxMode = RuntimeSandboxMode;
export type CodexReasoningEffort = RuntimeReasoningEffort;
export type ChannelProvider = 'feishu';
export type FeishuSite = 'feishu' | 'lark';
export type RuntimeProvider = 'codex' | 'claude';
export type CodexProviderChoice = 'sdk' | 'tmux' | 'pty';
export type ClaudeProviderChoice = 'pty' | 'sdk';
export type ClaudeExecutable = 'claude' | 'ccr';
export type ClaudePermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';

export function isSupportedChannelProvider(value: unknown): value is ChannelProvider {
  return value === 'feishu';
}

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

export interface FeishuChannelConfig {
  appId?: string;
  appSecret?: string;
  site?: FeishuSite;
  allowedUsers?: string[];
  streamingEnabled?: boolean;
  feedbackMarkdownEnabled?: boolean;
  requireMention?: boolean;
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

const DEFAULT_CODELARK_HOME = path.join(os.homedir(), ".codelark");
export const DEFAULT_WORKSPACE_ROOT = os.homedir();

export const CODELARK_HOME = process.env.CODELARK_HOME || DEFAULT_CODELARK_HOME;
export const CONFIG_PATH = path.join(CODELARK_HOME, "config.env");
export const CONFIG_JSON_PATH = path.join(CODELARK_HOME, "config.json");
const DEFAULT_STREAM_STATUS_IDLE_START_SECONDS = 180;
const DEFAULT_STREAM_STATUS_CHECK_INTERVAL_SECONDS = 10;

export function expandHomePath(value: string | undefined): string | undefined {
  if (!value) return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

export function normalizeFeishuSite(value: string | undefined): FeishuSite {
  const normalized = (value || '').trim().replace(/\/+$/, '').toLowerCase();
  if (!normalized) return 'feishu';
  if (normalized === 'lark') return 'lark';
  if (normalized === 'feishu') return 'feishu';
  if (normalized.includes('open.larksuite.com')) return 'lark';
  return 'feishu';
}

export function feishuSiteToApiBaseUrl(site: FeishuSite | string | undefined): string {
  return normalizeFeishuSite(site) === 'lark'
    ? 'https://open.larksuite.com'
    : 'https://open.feishu.cn';
}

function nowIso(): string {
  return new Date().toISOString();
}

function defaultAliasForProvider(provider: ChannelProvider): string {
  return provider === 'feishu' ? '飞书' : provider;
}

function buildDefaultChannelId(provider: ChannelProvider): string {
  return `${provider}-default`;
}

export function normalizeRuntimeProvider(value: unknown): RuntimeProvider {
  return typeof value === 'string' && value.trim().toLowerCase() === 'claude' ? 'claude' : 'codex';
}

function normalizeDefaultMode(value: unknown): string {
  if (value === 'yolo') return 'yolo';
  return 'normal';
}

export function normalizeCodexProviderChoice(value: unknown): CodexProviderChoice | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'sdk' || normalized === 'tmux' || normalized === 'pty') return normalized;
  return 'tmux';
}

export function normalizeClaudeProviderChoice(value: unknown): ClaudeProviderChoice | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'sdk' || normalized === 'pty') return normalized;
  return 'sdk';
}

function normalizeClaudePermissionMode(value: unknown): ClaudePermissionMode | undefined {
  if (value === 'default' || value === 'acceptEdits' || value === 'bypassPermissions' || value === 'plan') {
    return value;
  }
  return undefined;
}

export function normalizeClaudeExecutable(value: unknown): ClaudeExecutable | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'claude' || normalized === 'ccr') return normalized;
  return undefined;
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
