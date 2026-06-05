import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  normalizeChannelId,
  parseReasoningEffort,
  parseSandboxMode,
  type RuntimeReasoningEffort,
  type RuntimeSandboxMode,
} from "./runtime-options.js";

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

function parseEnvFile(content: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    entries.set(key, value);
  }
  return entries;
}

export function loadRawConfigEnv(): Map<string, string> {
  try {
    return parseEnvFile(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return new Map<string, string>();
  }
}

function splitCsv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

function parseNonNegativeInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return Math.floor(parsed);
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

function ensureConfigDir(): void {
  fs.mkdirSync(CODELARK_HOME, { recursive: true });
}

function readConfigFile(): ConfigFile | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_JSON_PATH, 'utf-8')) as ConfigFile;
    if (parsed && parsed.schemaVersion === 1 && parsed.runtime && Array.isArray(parsed.channels)) {
      parsed.runtime.provider = normalizeRuntimeProvider(parsed.runtime.provider);
      parsed.channels = normalizeChannelInstances(parsed.channels);
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function writeConfigFile(config: ConfigFile): void {
  ensureConfigDir();
  const tmpPath = CONFIG_JSON_PATH + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  fs.renameSync(tmpPath, CONFIG_JSON_PATH);
}

function getFileMtimeMs(filePath: string): number | null {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
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

function effectiveCodexRuntime(runtime: RuntimeConfig): Required<Pick<CodexRuntimeDefaultsConfig, 'defaultMode' | 'skipGitRepoCheck' | 'sandboxMode' | 'networkAccess' | 'reasoningEffort'>> & Pick<CodexRuntimeDefaultsConfig, 'defaultModel'> {
  return {
    defaultModel: runtime.codex?.defaultModel,
    defaultMode: normalizeDefaultMode(runtime.codex?.defaultMode),
    skipGitRepoCheck: runtime.codex?.skipGitRepoCheck ?? true,
    sandboxMode: runtime.codex?.sandboxMode ?? 'workspace-write',
    networkAccess: runtime.codex?.networkAccess ?? true,
    reasoningEffort: runtime.codex?.reasoningEffort ?? 'medium',
  };
}

function effectiveBridgeControl(runtime: RuntimeConfig): BridgeControlConfig {
  return {
    defaultCodexProvider: normalizeCodexProviderChoice(runtime.bridgeControl?.defaultCodexProvider),
  };
}

function effectiveGlobalBridge(runtime: RuntimeConfig): GlobalBridgeConfig {
  return {
    defaultWorkspaceRoot: runtime.bridge?.defaultWorkspaceRoot,
    historyMessageLimit: runtime.bridge?.historyMessageLimit ?? 8,
    streamStatusIdleStartSeconds: runtime.bridge?.streamStatusIdleStartSeconds
      ?? DEFAULT_STREAM_STATUS_IDLE_START_SECONDS,
    streamStatusCheckIntervalSeconds: runtime.bridge?.streamStatusCheckIntervalSeconds
      ?? DEFAULT_STREAM_STATUS_CHECK_INTERVAL_SECONDS,
    uiAllowLan: runtime.bridge?.uiAllowLan ?? false,
    uiAccessToken: runtime.bridge?.uiAccessToken,
  };
}

function effectiveClaudeRuntime(runtime: RuntimeConfig): ClaudeRuntimeDefaultsConfig | undefined {
  if (!runtime.claude) return undefined;
  const claude = {
    provider: normalizeClaudeProviderChoice(runtime.claude.provider),
    executable: normalizeClaudeExecutable(runtime.claude.executable),
    defaultModel: runtime.claude.defaultModel,
    permissionMode: normalizeClaudePermissionMode(runtime.claude.permissionMode),
    idleTimeoutMinutes: runtime.claude.idleTimeoutMinutes && runtime.claude.idleTimeoutMinutes > 0
      ? Math.floor(runtime.claude.idleTimeoutMinutes)
      : undefined,
  };
  if (!claude.provider && !claude.executable && !claude.defaultModel && !claude.permissionMode && claude.idleTimeoutMinutes === undefined) {
    return undefined;
  }
  return claude;
}

function materializeRuntimeConfig(runtime: RuntimeConfig): RuntimeConfig {
  const codex = effectiveCodexRuntime(runtime);
  const bridgeControl = effectiveBridgeControl(runtime);
  const bridge = effectiveGlobalBridge(runtime);
  const claude = effectiveClaudeRuntime(runtime);
  return {
    provider: normalizeRuntimeProvider(runtime.provider),
    codex,
    ...(claude ? { claude } : {}),
    bridgeControl,
    bridge,
  };
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

function migrateLegacyEnvToConfig(env: Map<string, string>): ConfigFile {
  const enabledChannels = splitCsv(env.get("CODELARK_ENABLED_CHANNELS")) ?? ["feishu"];
  const timestamp = nowIso();
  const channels: ChannelInstance[] = [];

  const hasFeishuConfig = Boolean(
    env.get("CODELARK_FEISHU_APP_ID")
    || env.get("CODELARK_FEISHU_APP_SECRET")
    || env.get("CODELARK_FEISHU_ALLOWED_USERS")
    || enabledChannels.includes('feishu')
  );
  if (hasFeishuConfig) {
    channels.push({
      id: buildDefaultChannelId('feishu'),
      alias: defaultAliasForProvider('feishu'),
      provider: 'feishu',
      enabled: enabledChannels.includes('feishu'),
      createdAt: timestamp,
      updatedAt: timestamp,
      config: {
        appId: env.get("CODELARK_FEISHU_APP_ID") || undefined,
        appSecret: env.get("CODELARK_FEISHU_APP_SECRET") || undefined,
        site: normalizeFeishuSite(env.get("CODELARK_FEISHU_SITE") || env.get("CODELARK_FEISHU_DOMAIN")),
        allowedUsers: splitCsv(env.get("CODELARK_FEISHU_ALLOWED_USERS")),
        streamingEnabled: env.has("CODELARK_FEISHU_STREAMING_ENABLED")
          ? env.get("CODELARK_FEISHU_STREAMING_ENABLED") === "true"
          : true,
        feedbackMarkdownEnabled: env.has("CODELARK_FEISHU_COMMAND_MARKDOWN_ENABLED")
          ? env.get("CODELARK_FEISHU_COMMAND_MARKDOWN_ENABLED") === "true"
          : true,
        requireMention: env.has("CODELARK_FEISHU_REQUIRE_MENTION")
          ? env.get("CODELARK_FEISHU_REQUIRE_MENTION") === "true"
          : false,
      },
    });
  }

  return {
    schemaVersion: 1,
    runtime: materializeRuntimeConfig({
      provider: normalizeRuntimeProvider(env.get("CODELARK_RUNTIME")),
      codex: {
        defaultModel: env.get("CODELARK_CODEX_DEFAULT_MODEL") || undefined,
        defaultMode: normalizeDefaultMode(env.get("CODELARK_CODEX_DEFAULT_MODE")),
        skipGitRepoCheck: env.has("CODELARK_CODEX_SKIP_GIT_REPO_CHECK")
          ? env.get("CODELARK_CODEX_SKIP_GIT_REPO_CHECK") === "true"
          : true,
        sandboxMode: parseSandboxMode(env.get("CODELARK_CODEX_SANDBOX_MODE")) ?? 'workspace-write',
        networkAccess: env.has("CODELARK_CODEX_NETWORK_ACCESS")
          ? env.get("CODELARK_CODEX_NETWORK_ACCESS") === "true"
          : true,
        reasoningEffort: parseReasoningEffort(env.get("CODELARK_CODEX_REASONING_EFFORT")) ?? 'medium',
      },
      bridgeControl: {
        defaultCodexProvider: normalizeCodexProviderChoice(env.get("CODELARK_DEFAULT_CODEX_PROVIDER")),
      },
      bridge: {
        defaultWorkspaceRoot: expandHomePath(env.get("CODELARK_DEFAULT_WORKSPACE_ROOT")) || undefined,
        historyMessageLimit: parsePositiveInt(env.get("CODELARK_HISTORY_MESSAGE_LIMIT")) ?? 8,
        streamStatusIdleStartSeconds: parsePositiveInt(env.get("CODELARK_STREAM_STATUS_IDLE_START_SECONDS"))
          ?? DEFAULT_STREAM_STATUS_IDLE_START_SECONDS,
        streamStatusCheckIntervalSeconds: parsePositiveInt(env.get("CODELARK_STREAM_STATUS_CHECK_INTERVAL_SECONDS"))
          ?? DEFAULT_STREAM_STATUS_CHECK_INTERVAL_SECONDS,
        uiAllowLan: env.get("CODELARK_UI_ALLOW_LAN") === "true",
        uiAccessToken: env.get("CODELARK_UI_ACCESS_TOKEN") || undefined,
      },
      claude: {
        executable: normalizeClaudeExecutable(env.get("CODELARK_CLAUDE_EXECUTABLE")),
        provider: normalizeClaudeProviderChoice(env.get("CODELARK_CLAUDE_PROVIDER")),
        defaultModel: env.get("CODELARK_CLAUDE_DEFAULT_MODEL") || undefined,
        permissionMode: normalizeClaudePermissionMode(env.get("CODELARK_CLAUDE_PERMISSION_MODE")),
        idleTimeoutMinutes: parseNonNegativeInt(env.get("CODELARK_CLAUDE_IDLE_TIMEOUT_MINUTES")),
      },
    }),
    channels,
  };
}

function buildUniqueChannelId(channels: ChannelInstance[], baseId: string): string {
  const existing = new Set(channels.map((channel) => channel.id));
  let id = normalizeChannelId(baseId);
  let suffix = 2;
  while (existing.has(id)) {
    id = normalizeChannelId(`${baseId}-${suffix}`);
    suffix += 1;
  }
  return id;
}

function warnEnvCreatedChannel(provider: ChannelProvider, channel: ChannelInstance): void {
  console.warn(
    `[CodeLark] config.env 中的 ${provider} 通道配置没有匹配到现有通道，已新增通道 ${channel.id}。请在 Web 控制台确认是否启用或合并。`,
  );
}

function createEnvImportedChannel(channels: ChannelInstance[], provider: ChannelProvider): ChannelInstance {
  const timestamp = nowIso();
  const channel: ChannelInstance = {
    id: buildUniqueChannelId(channels, `${provider}-env`),
    alias: `${defaultAliasForProvider(provider)} env导入`,
    provider,
    enabled: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    config: {},
  };
  channels.push(channel);
  warnEnvCreatedChannel(provider, channel);
  return channel;
}

function envHasAny(env: Map<string, string>, keys: string[]): boolean {
  return keys.some((key) => env.has(key));
}

function findFeishuEnvChannel(channels: ChannelInstance[], env: Map<string, string>): ChannelInstance | undefined {
  const appId = env.get("CODELARK_FEISHU_APP_ID")?.trim();
  const feishuChannels = channels.filter((channel) => channel.provider === 'feishu');
  if (appId) {
    return feishuChannels.find((channel) => (channel.config as FeishuChannelConfig).appId === appId);
  }
  if (feishuChannels.length === 1) return feishuChannels[0];
  return feishuChannels.find((channel) => (
    channel.id === buildDefaultChannelId('feishu')
    && !(channel.config as FeishuChannelConfig).appId
  ));
}

function applyRuntimeEnvOverlay(runtime: RuntimeConfig, env: Map<string, string>): RuntimeConfig {
  const next = materializeRuntimeConfig(runtime);

  if (env.has("CODELARK_RUNTIME")) {
    next.provider = normalizeRuntimeProvider(env.get("CODELARK_RUNTIME"));
  }
  if (env.has("CODELARK_DEFAULT_WORKSPACE_ROOT")) {
    const value = expandHomePath(env.get("CODELARK_DEFAULT_WORKSPACE_ROOT")) || undefined;
    next.bridge = { ...(next.bridge || {}), defaultWorkspaceRoot: value };
  }
  if (env.has("CODELARK_CODEX_DEFAULT_MODEL")) {
    const value = env.get("CODELARK_CODEX_DEFAULT_MODEL") || undefined;
    next.codex = { ...(next.codex || {}), defaultModel: value };
  }
  if (env.has("CODELARK_DEFAULT_CODEX_PROVIDER")) {
    const value = normalizeCodexProviderChoice(env.get("CODELARK_DEFAULT_CODEX_PROVIDER"));
    next.bridgeControl = { ...(next.bridgeControl || {}), defaultCodexProvider: value };
  }
  if (env.has("CODELARK_CODEX_DEFAULT_MODE")) {
    const value = normalizeDefaultMode(env.get("CODELARK_CODEX_DEFAULT_MODE"));
    next.codex = { ...(next.codex || {}), defaultMode: value };
  }
  if (env.has("CODELARK_HISTORY_MESSAGE_LIMIT")) {
    const value = parsePositiveInt(env.get("CODELARK_HISTORY_MESSAGE_LIMIT")) ?? next.bridge?.historyMessageLimit;
    next.bridge = { ...(next.bridge || {}), historyMessageLimit: value };
  }
  if (env.has("CODELARK_STREAM_STATUS_IDLE_START_SECONDS")) {
    const value = parsePositiveInt(env.get("CODELARK_STREAM_STATUS_IDLE_START_SECONDS"))
      ?? next.bridge?.streamStatusIdleStartSeconds;
    next.bridge = { ...(next.bridge || {}), streamStatusIdleStartSeconds: value };
  }
  if (env.has("CODELARK_STREAM_STATUS_CHECK_INTERVAL_SECONDS")) {
    const value = parsePositiveInt(env.get("CODELARK_STREAM_STATUS_CHECK_INTERVAL_SECONDS"))
      ?? next.bridge?.streamStatusCheckIntervalSeconds;
    next.bridge = { ...(next.bridge || {}), streamStatusCheckIntervalSeconds: value };
  }
  if (env.has("CODELARK_CODEX_SKIP_GIT_REPO_CHECK")) {
    const value = env.get("CODELARK_CODEX_SKIP_GIT_REPO_CHECK") === "true";
    next.codex = { ...(next.codex || {}), skipGitRepoCheck: value };
  }
  if (env.has("CODELARK_CODEX_SANDBOX_MODE")) {
    const value = parseSandboxMode(env.get("CODELARK_CODEX_SANDBOX_MODE")) ?? next.codex?.sandboxMode;
    next.codex = { ...(next.codex || {}), sandboxMode: value };
  }
  if (env.has("CODELARK_CODEX_NETWORK_ACCESS")) {
    const value = env.get("CODELARK_CODEX_NETWORK_ACCESS") === "true";
    next.codex = { ...(next.codex || {}), networkAccess: value };
  }
  if (env.has("CODELARK_CODEX_REASONING_EFFORT")) {
    const value = parseReasoningEffort(env.get("CODELARK_CODEX_REASONING_EFFORT"))
      ?? next.codex?.reasoningEffort;
    next.codex = { ...(next.codex || {}), reasoningEffort: value };
  }
  if (env.has("CODELARK_CLAUDE_DEFAULT_MODEL")) {
    const value = env.get("CODELARK_CLAUDE_DEFAULT_MODEL") || undefined;
    next.claude = { ...(next.claude || {}), defaultModel: value };
  }
  if (env.has("CODELARK_CLAUDE_PROVIDER")) {
    const value = normalizeClaudeProviderChoice(env.get("CODELARK_CLAUDE_PROVIDER")) ?? next.claude?.provider;
    next.claude = { ...(next.claude || {}), provider: value };
  }
  if (env.has("CODELARK_CLAUDE_EXECUTABLE")) {
    const value = normalizeClaudeExecutable(env.get("CODELARK_CLAUDE_EXECUTABLE")) ?? next.claude?.executable;
    next.claude = { ...(next.claude || {}), executable: value };
  }
  if (env.has("CODELARK_CLAUDE_PERMISSION_MODE")) {
    const value = normalizeClaudePermissionMode(env.get("CODELARK_CLAUDE_PERMISSION_MODE"));
    next.claude = { ...(next.claude || {}), permissionMode: value };
  }
  if (env.has("CODELARK_CLAUDE_IDLE_TIMEOUT_MINUTES")) {
    const value = parseNonNegativeInt(env.get("CODELARK_CLAUDE_IDLE_TIMEOUT_MINUTES")) ?? next.claude?.idleTimeoutMinutes;
    next.claude = { ...(next.claude || {}), idleTimeoutMinutes: value };
  }
  if (env.has("CODELARK_UI_ALLOW_LAN")) {
    const value = env.get("CODELARK_UI_ALLOW_LAN") === "true";
    next.bridge = { ...(next.bridge || {}), uiAllowLan: value };
  }
  if (env.has("CODELARK_UI_ACCESS_TOKEN")) {
    const value = env.get("CODELARK_UI_ACCESS_TOKEN") || undefined;
    next.bridge = { ...(next.bridge || {}), uiAccessToken: value };
  }

  return materializeRuntimeConfig(next);
}

function applyChannelEnvOverlay(channels: ChannelInstance[], env: Map<string, string>): ChannelInstance[] {
  const next = normalizeChannelInstances(channels);
  const enabledChannels = env.has("CODELARK_ENABLED_CHANNELS")
    ? new Set(splitCsv(env.get("CODELARK_ENABLED_CHANNELS")) ?? [])
    : null;

  if (enabledChannels) {
    for (const channel of next) {
      channel.enabled = enabledChannels.has(channel.provider);
    }
    for (const provider of enabledChannels) {
      if (isSupportedChannelProvider(provider)) {
        const hasProviderChannel = next.some((channel) => channel.provider === provider);
        if (!hasProviderChannel) {
          createEnvImportedChannel(next, provider).enabled = true;
        }
      }
    }
  }

  const feishuKeys = [
    "CODELARK_FEISHU_APP_ID",
    "CODELARK_FEISHU_APP_SECRET",
    "CODELARK_FEISHU_SITE",
    "CODELARK_FEISHU_DOMAIN",
    "CODELARK_FEISHU_ALLOWED_USERS",
    "CODELARK_FEISHU_STREAMING_ENABLED",
    "CODELARK_FEISHU_COMMAND_MARKDOWN_ENABLED",
    "CODELARK_FEISHU_REQUIRE_MENTION",
  ];
  if (envHasAny(env, feishuKeys)) {
    const channel = findFeishuEnvChannel(next, env) || createEnvImportedChannel(next, 'feishu');
    const config = { ...(channel.config as FeishuChannelConfig) };
    if (enabledChannels?.has('feishu')) channel.enabled = true;
    if (env.has("CODELARK_FEISHU_APP_ID")) config.appId = env.get("CODELARK_FEISHU_APP_ID") || undefined;
    if (env.has("CODELARK_FEISHU_APP_SECRET")) config.appSecret = env.get("CODELARK_FEISHU_APP_SECRET") || undefined;
    if (env.has("CODELARK_FEISHU_SITE") || env.has("CODELARK_FEISHU_DOMAIN")) {
      config.site = normalizeFeishuSite(env.get("CODELARK_FEISHU_SITE") || env.get("CODELARK_FEISHU_DOMAIN"));
    }
    if (env.has("CODELARK_FEISHU_ALLOWED_USERS")) config.allowedUsers = splitCsv(env.get("CODELARK_FEISHU_ALLOWED_USERS"));
    if (env.has("CODELARK_FEISHU_STREAMING_ENABLED")) {
      config.streamingEnabled = env.get("CODELARK_FEISHU_STREAMING_ENABLED") === "true";
    }
    if (env.has("CODELARK_FEISHU_COMMAND_MARKDOWN_ENABLED")) {
      config.feedbackMarkdownEnabled = env.get("CODELARK_FEISHU_COMMAND_MARKDOWN_ENABLED") === "true";
    }
    if (env.has("CODELARK_FEISHU_REQUIRE_MENTION")) {
      config.requireMention = env.get("CODELARK_FEISHU_REQUIRE_MENTION") === "true";
    }
    channel.config = config;
    channel.updatedAt = nowIso();
  }

  return normalizeChannelInstances(next);
}

function applyRawConfigEnvOverlay(current: ConfigFile, env: Map<string, string>): ConfigFile {
  return {
    schemaVersion: 1,
    runtime: applyRuntimeEnvOverlay(current.runtime, env),
    channels: applyChannelEnvOverlay(current.channels, env),
  };
}

function isSameConfig(a: ConfigFile, b: ConfigFile): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function getChannelByProvider(
  config: ConfigFile,
  provider: ChannelProvider,
): ChannelInstance | undefined {
  const preferredId = buildDefaultChannelId(provider);
  return config.channels.find((channel) => channel.id === preferredId)
    || config.channels.find((channel) => channel.provider === provider);
}

function expandConfig(file: ConfigFile): Config {
  const runtime = materializeRuntimeConfig(file.runtime);
  const codex = effectiveCodexRuntime(runtime);
  const bridgeControl = effectiveBridgeControl(runtime);
  const bridge = effectiveGlobalBridge(runtime);
  const claude = effectiveClaudeRuntime(runtime);
  return {
    schemaVersion: 1,
    channels: file.channels,
    runtime: runtime.provider,
    enabledChannels: Array.from(new Set(
      file.channels.filter((channel) => channel.enabled).map((channel) => channel.provider),
    )),
    defaultWorkspaceRoot: bridge.defaultWorkspaceRoot,
    defaultModel: codex.defaultModel,
    defaultProvider: normalizeCodexProviderChoice(bridgeControl.defaultCodexProvider),
    defaultMode: normalizeDefaultMode(codex.defaultMode),
    historyMessageLimit: bridge.historyMessageLimit ?? 8,
    streamStatusIdleStartSeconds: bridge.streamStatusIdleStartSeconds ?? DEFAULT_STREAM_STATUS_IDLE_START_SECONDS,
    streamStatusCheckIntervalSeconds: bridge.streamStatusCheckIntervalSeconds ?? DEFAULT_STREAM_STATUS_CHECK_INTERVAL_SECONDS,
    codexSkipGitRepoCheck: codex.skipGitRepoCheck ?? true,
    codexSandboxMode: codex.sandboxMode ?? 'workspace-write',
    codexNetworkAccess: codex.networkAccess !== false,
    codexReasoningEffort: codex.reasoningEffort ?? 'medium',
    claudeDefaultModel: claude?.defaultModel,
    claudeProvider: claude?.provider,
    claudeExecutable: claude?.executable,
    claudePermissionMode: claude?.permissionMode,
    claudeIdleTimeoutMinutes: claude?.idleTimeoutMinutes,
    uiAllowLan: bridge.uiAllowLan === true,
    uiAccessToken: bridge.uiAccessToken || undefined,
  };
}

function buildFileFromExpandedConfig(config: Config, current?: ConfigFile | null): ConfigFile {
  const hasExplicitChannels = Array.isArray(config.channels);
  let channels = hasExplicitChannels
    ? [...(config.channels || [])]
    : [...(current?.channels || [])];
  channels = normalizeChannelInstances(channels);

  const currentClaude = current?.runtime.claude;
  const claude: ClaudeRuntimeDefaultsConfig | undefined = {
    ...currentClaude,
    provider: config.claudeProvider,
    executable: config.claudeExecutable,
    defaultModel: config.claudeDefaultModel,
    permissionMode: config.claudePermissionMode,
    idleTimeoutMinutes: config.claudeIdleTimeoutMinutes,
  };
  return {
    schemaVersion: 1,
    runtime: materializeRuntimeConfig({
      provider: config.runtime,
      codex: {
        defaultModel: config.defaultModel,
        defaultMode: normalizeDefaultMode(config.defaultMode),
        skipGitRepoCheck: config.codexSkipGitRepoCheck,
        sandboxMode: config.codexSandboxMode,
        networkAccess: config.codexNetworkAccess === true,
        reasoningEffort: config.codexReasoningEffort,
      },
      bridgeControl: {
        defaultCodexProvider: normalizeCodexProviderChoice(config.defaultProvider),
      },
      bridge: {
        defaultWorkspaceRoot: config.defaultWorkspaceRoot,
        historyMessageLimit: config.historyMessageLimit,
        streamStatusIdleStartSeconds: config.streamStatusIdleStartSeconds,
        streamStatusCheckIntervalSeconds: config.streamStatusCheckIntervalSeconds,
        uiAllowLan: config.uiAllowLan,
        uiAccessToken: config.uiAccessToken,
      },
      claude,
    }),
    channels: channels.map((channel) => ({
      ...channel,
      id: normalizeChannelId(channel.id),
      alias: channel.alias?.trim() || defaultAliasForProvider(channel.provider),
    })),
  };
}

export function loadConfig(): Config {
  const current = readConfigFile();
  if (current) return expandConfig(syncConfigFromRawEnvIfNeeded(current));

  const envConfig = loadRawConfigEnv();
  if (envConfig.size > 0) {
    const migrated = migrateLegacyEnvToConfig(envConfig);
    writeConfigFile(migrated);
    return expandConfig(migrated);
  }

  const empty: ConfigFile = {
    schemaVersion: 1,
    runtime: materializeRuntimeConfig({
      provider: 'codex',
      codex: {
        defaultMode: 'normal',
        skipGitRepoCheck: true,
        sandboxMode: 'workspace-write',
        networkAccess: true,
        reasoningEffort: 'medium',
      },
      bridge: {
        defaultWorkspaceRoot: DEFAULT_WORKSPACE_ROOT,
        historyMessageLimit: 8,
        streamStatusIdleStartSeconds: DEFAULT_STREAM_STATUS_IDLE_START_SECONDS,
        streamStatusCheckIntervalSeconds: DEFAULT_STREAM_STATUS_CHECK_INTERVAL_SECONDS,
        uiAllowLan: false,
      },
    }),
    channels: [],
  };
  return expandConfig(empty);
}

function formatEnvLine(key: string, value: string | undefined): string {
  if (value === undefined || value === "") return "";
  return `${key}=${value}\n`;
}

function buildConfigEnvSnapshot(config: ConfigFile): string {
  const runtime = materializeRuntimeConfig(config.runtime);
  const codex = effectiveCodexRuntime(runtime);
  const bridgeControl = effectiveBridgeControl(runtime);
  const bridge = effectiveGlobalBridge(runtime);
  const claude = effectiveClaudeRuntime(runtime);
  let out = "";
  out += formatEnvLine("CODELARK_RUNTIME", runtime.provider);
  out += formatEnvLine(
    "CODELARK_ENABLED_CHANNELS",
    Array.from(new Set(config.channels.filter((channel) => channel.enabled).map((channel) => channel.provider))).join(","),
  );
  out += formatEnvLine("CODELARK_DEFAULT_WORKSPACE_ROOT", bridge.defaultWorkspaceRoot);
  out += formatEnvLine("CODELARK_CODEX_DEFAULT_MODEL", codex.defaultModel);
  out += formatEnvLine("CODELARK_DEFAULT_CODEX_PROVIDER", bridgeControl.defaultCodexProvider);
  out += formatEnvLine("CODELARK_CODEX_DEFAULT_MODE", codex.defaultMode);
  if (bridge.historyMessageLimit !== undefined) {
    out += formatEnvLine("CODELARK_HISTORY_MESSAGE_LIMIT", String(bridge.historyMessageLimit));
  }
  if (bridge.streamStatusIdleStartSeconds !== undefined) {
    out += formatEnvLine("CODELARK_STREAM_STATUS_IDLE_START_SECONDS", String(bridge.streamStatusIdleStartSeconds));
  }
  if (bridge.streamStatusCheckIntervalSeconds !== undefined) {
    out += formatEnvLine("CODELARK_STREAM_STATUS_CHECK_INTERVAL_SECONDS", String(bridge.streamStatusCheckIntervalSeconds));
  }
  if (codex.skipGitRepoCheck !== undefined) {
    out += formatEnvLine("CODELARK_CODEX_SKIP_GIT_REPO_CHECK", String(codex.skipGitRepoCheck));
  }
  out += formatEnvLine("CODELARK_CODEX_SANDBOX_MODE", codex.sandboxMode);
  out += formatEnvLine("CODELARK_CODEX_NETWORK_ACCESS", String(codex.networkAccess === true));
  out += formatEnvLine("CODELARK_CODEX_REASONING_EFFORT", codex.reasoningEffort);
  out += formatEnvLine("CODELARK_CLAUDE_EXECUTABLE", claude?.executable);
  out += formatEnvLine("CODELARK_CLAUDE_DEFAULT_MODEL", claude?.defaultModel);
  out += formatEnvLine("CODELARK_CLAUDE_PERMISSION_MODE", claude?.permissionMode);
  if (claude?.idleTimeoutMinutes !== undefined) {
    out += formatEnvLine("CODELARK_CLAUDE_IDLE_TIMEOUT_MINUTES", String(claude.idleTimeoutMinutes));
  }
  out += formatEnvLine("CODELARK_UI_ALLOW_LAN", String(bridge.uiAllowLan === true));
  out += formatEnvLine("CODELARK_UI_ACCESS_TOKEN", bridge.uiAccessToken);

  const feishu = getChannelByProvider(config, 'feishu');
  const feishuConfig = toFeishuConfig(feishu);
  if (feishuConfig) {
    out += formatEnvLine("CODELARK_FEISHU_APP_ID", feishuConfig.appId);
    out += formatEnvLine("CODELARK_FEISHU_APP_SECRET", feishuConfig.appSecret);
    out += formatEnvLine("CODELARK_FEISHU_SITE", feishuConfig.site);
    out += formatEnvLine("CODELARK_FEISHU_ALLOWED_USERS", feishuConfig.allowedUsers?.join(","));
    if (feishuConfig.streamingEnabled !== undefined) {
      out += formatEnvLine("CODELARK_FEISHU_STREAMING_ENABLED", String(feishuConfig.streamingEnabled));
    }
    if (feishuConfig.feedbackMarkdownEnabled !== undefined) {
      out += formatEnvLine("CODELARK_FEISHU_COMMAND_MARKDOWN_ENABLED", String(feishuConfig.feedbackMarkdownEnabled));
    }
    if (feishuConfig.requireMention !== undefined) {
      out += formatEnvLine("CODELARK_FEISHU_REQUIRE_MENTION", String(feishuConfig.requireMention));
    }
  }

  return out;
}

const CONFIG_ENV_MANAGED_KEYS = new Set([
  "CODELARK_RUNTIME",
  "CODELARK_ENABLED_CHANNELS",
  "CODELARK_DEFAULT_WORKSPACE_ROOT",
  "CODELARK_CODEX_DEFAULT_MODEL",
  "CODELARK_DEFAULT_CODEX_PROVIDER",
  "CODELARK_CODEX_DEFAULT_MODE",
  "CODELARK_HISTORY_MESSAGE_LIMIT",
  "CODELARK_STREAM_STATUS_IDLE_START_SECONDS",
  "CODELARK_STREAM_STATUS_CHECK_INTERVAL_SECONDS",
  "CODELARK_CODEX_SKIP_GIT_REPO_CHECK",
  "CODELARK_CODEX_SANDBOX_MODE",
  "CODELARK_CODEX_NETWORK_ACCESS",
  "CODELARK_CODEX_REASONING_EFFORT",
  "CODELARK_CLAUDE_PROVIDER",
  "CODELARK_CLAUDE_EXECUTABLE",
  "CODELARK_CLAUDE_DEFAULT_MODEL",
  "CODELARK_CLAUDE_PERMISSION_MODE",
  "CODELARK_CLAUDE_IDLE_TIMEOUT_MINUTES",
  "CODELARK_SHOW_TOOL_CALL_DETAILS",
  "CODELARK_UI_ALLOW_LAN",
  "CODELARK_UI_ACCESS_TOKEN",
  "CODELARK_FEISHU_APP_ID",
  "CODELARK_FEISHU_APP_SECRET",
  "CODELARK_FEISHU_SITE",
  "CODELARK_FEISHU_DOMAIN",
  "CODELARK_FEISHU_ALLOWED_USERS",
  "CODELARK_FEISHU_STREAMING_ENABLED",
  "CODELARK_FEISHU_COMMAND_MARKDOWN_ENABLED",
  "CODELARK_FEISHU_REQUIRE_MENTION",
]);
function envLineKey(line: string): string | null {
  const trimmed = line.trimStart();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const source = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trimStart() : trimmed;
  const eqIdx = source.indexOf("=");
  if (eqIdx === -1) return null;
  const key = source.slice(0, eqIdx).trim();
  return key || null;
}

function isManagedConfigEnvKey(key: string): boolean {
  return CONFIG_ENV_MANAGED_KEYS.has(key);
}

function snapshotLinesByKey(snapshot: string): Map<string, string> {
  const lines = new Map<string, string>();
  for (const line of snapshot.split("\n")) {
    const key = envLineKey(line);
    if (key) lines.set(key, line);
  }
  return lines;
}

export function mergeConfigEnvSnapshot(existing: string | null, snapshot: string): string {
  if (!existing) return snapshot;

  const nextLinesByKey = snapshotLinesByKey(snapshot);
  const emitted = new Set<string>();
  const out: string[] = [];

  for (const line of existing.split(/\r?\n/)) {
    const key = envLineKey(line);
    if (!key || !isManagedConfigEnvKey(key)) {
      out.push(line);
      continue;
    }
    if (emitted.has(key)) continue;
    const nextLine = nextLinesByKey.get(key);
    if (nextLine) {
      out.push(nextLine);
      emitted.add(key);
    }
  }

  for (const [key, line] of nextLinesByKey) {
    if (!emitted.has(key)) out.push(line);
  }

  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out.join("\n") + "\n";
}

function readTextFileIfExists(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

function syncConfigFromRawEnvIfNeeded(current: ConfigFile): ConfigFile {
  const envMtime = getFileMtimeMs(CONFIG_PATH);
  const configMtime = getFileMtimeMs(CONFIG_JSON_PATH);
  if (envMtime === null || configMtime === null || envMtime <= configMtime) return current;

  const rawEnv = readTextFileIfExists(CONFIG_PATH);
  if (!rawEnv || rawEnv === buildConfigEnvSnapshot(current)) return current;

  const env = parseEnvFile(rawEnv);
  if (env.size === 0) return current;

  const next = applyRawConfigEnvOverlay(current, env);
  if (isSameConfig(next, current)) return current;

  writeConfigFile(next);
  console.warn('[CodeLark] 检测到 config.env 已更新，已同步写入 config.json。');
  return next;
}

export function saveConfig(config: Config): void {
  const current = readConfigFile();
  const next = buildFileFromExpandedConfig(config, current);

  // Keep a lightweight env snapshot for operational visibility and shell tooling.
  const out = mergeConfigEnvSnapshot(readTextFileIfExists(CONFIG_PATH), buildConfigEnvSnapshot(next));
  ensureConfigDir();
  const tmpPath = CONFIG_PATH + ".tmp";
  fs.writeFileSync(tmpPath, out, { mode: 0o600 });
  fs.renameSync(tmpPath, CONFIG_PATH);
  writeConfigFile(next);
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
