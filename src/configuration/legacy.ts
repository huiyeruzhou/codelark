import os from 'node:os';
import { normalizeChannelId } from '../shared/channel-id.js';
import type {
  ChannelInstance,
  Config,
  RuntimeConfig,
} from './legacy-types.js';
import {
  isSupportedChannelProvider,
  type ChannelProvider,
  type FeishuChannelConfig,
} from '../channels/types.js';
import type { ConfigPatch, ConfigV2 } from './schema.js';

// legacy adapter：只负责 v1 Config 与 v2 ConfigPatch/ConfigV2 的兼容转换。
// 新运行时读取不应从这里取配置，旧字段迁移完成后由 migrations 归档输入文件。

export const LEGACY_DEFAULT_STREAM_STATUS_IDLE_START_SECONDS = 180;
export const LEGACY_DEFAULT_STREAM_STATUS_CHECK_INTERVAL_SECONDS = 10;
const LEGACY_DEFAULT_HISTORY_MESSAGE_LIMIT = 8;

function legacyCodexMode(mode: ConfigV2['runtime']['codex']['yoloMode']): string {
  return mode === 'on' || mode === 'yolo' ? 'yolo' : 'normal';
}

function v2CodexYoloMode(mode: string | undefined): ConfigV2['runtime']['codex']['yoloMode'] | undefined {
  if (mode === undefined) return undefined;
  return mode === 'yolo' ? 'on' : 'off';
}

function hasLegacyChannelBehaviorConfig(config: Config): boolean {
  return config.historyMessageLimit !== undefined
    || config.streamStatusIdleStartSeconds !== undefined
    || config.streamStatusCheckIntervalSeconds !== undefined
    || config.enabledChannels.includes('feishu');
}

function legacyChannelsForPatch(config: Config): NonNullable<Config['channels']> {
  if (config.channels && config.channels.length > 0) return config.channels;
  if (!hasLegacyChannelBehaviorConfig(config)) return [];
  return [{
    id: 'feishu-default',
    alias: '飞书',
    provider: 'feishu',
    enabled: config.enabledChannels.includes('feishu'),
    createdAt: '',
    updatedAt: '',
    config: {},
  }];
}

interface ConfigFile {
  schemaVersion: 1;
  runtime: RuntimeConfig;
  channels: ChannelInstance[];
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

function toFeishuConfig(channel?: ChannelInstance): FeishuChannelConfig | undefined {
  return channel?.provider === 'feishu' ? channel.config as FeishuChannelConfig : undefined;
}

export function configV2ToLegacyConfig(config: ConfigV2): Config {
  const defaultChannel = config.channels.find((channel) => channel.id === 'feishu-default') || config.channels[0];
  return {
    schemaVersion: 2,
    channels: config.channels.map((channel): ChannelInstance => ({
      id: channel.id,
      alias: channel.alias,
      provider: channel.provider,
      enabled: channel.enabled,
      createdAt: '',
      updatedAt: '',
      config: { ...channel.config },
    })),
    runtime: config.runtime.agent,
    enabledChannels: Array.from(new Set(
      config.channels.filter((channel) => channel.enabled).map((channel) => channel.provider),
    )),
    defaultWorkspaceRoot: config.bridge.defaultWorkspace === '~' ? os.homedir() : config.bridge.defaultWorkspace,
    defaultModel: config.runtime.codex.model || undefined,
    defaultProvider: config.runtime.codex.provider || undefined,
    defaultMode: legacyCodexMode(config.runtime.codex.yoloMode),
    historyMessageLimit: defaultChannel?.config.historyMessageLimit,
    streamStatusIdleStartSeconds: defaultChannel?.config.streamStatusIdleStartSeconds,
    streamStatusCheckIntervalSeconds: defaultChannel?.config.streamStatusCheckIntervalSeconds,
    codexSkipGitRepoCheck: config.runtime.codex.skipGitRepoCheck,
    codexSandboxMode: config.runtime.codex.sandboxMode,
    codexNetworkAccess: config.runtime.codex.networkAccess,
    codexReasoningEffort: config.runtime.codex.reasoningEffort,
    claudeDefaultModel: config.runtime.claude.model || undefined,
    claudeProvider: config.runtime.claude.provider,
    claudeExecutable: config.runtime.claude.executable,
    claudeIdleTimeoutMinutes: config.runtime.claude.idleTimeoutMinutes,
    uiAllowLan: config.bridge.uiAllowLan,
    uiAccessToken: config.bridge.uiAccessToken || undefined,
  };
}

export function legacyConfigToConfigPatch(config: Config): ConfigPatch {
  const codexYoloMode = v2CodexYoloMode(config.defaultMode);
  const channels: NonNullable<ConfigPatch['channels']> = legacyChannelsForPatch(config).map((channel) => ({
    id: channel.id,
    alias: channel.alias,
    provider: channel.provider,
    enabled: channel.enabled,
    config: {
      historyMessageLimit: config.historyMessageLimit ?? LEGACY_DEFAULT_HISTORY_MESSAGE_LIMIT,
      streamStatusIdleStartSeconds: config.streamStatusIdleStartSeconds ?? LEGACY_DEFAULT_STREAM_STATUS_IDLE_START_SECONDS,
      streamStatusCheckIntervalSeconds: config.streamStatusCheckIntervalSeconds ?? LEGACY_DEFAULT_STREAM_STATUS_CHECK_INTERVAL_SECONDS,
      appId: (channel.config as FeishuChannelConfig).appId ?? '',
      appSecret: (channel.config as FeishuChannelConfig).appSecret ?? '',
      site: (channel.config as FeishuChannelConfig).site ?? 'feishu',
      allowedUsers: (channel.config as FeishuChannelConfig).allowedUsers ?? [],
      streamingEnabled: (channel.config as FeishuChannelConfig).streamingEnabled ?? true,
      feedbackMarkdownEnabled: (channel.config as FeishuChannelConfig).feedbackMarkdownEnabled ?? true,
      requireMention: (channel.config as FeishuChannelConfig).requireMention ?? false,
      groupAuthorized: (channel.config as FeishuChannelConfig).groupAuthorized ?? false,
    },
  }));
  const defaultChannel = channels.find((channel) => channel.id === 'feishu-default') || channels[0];
  if (defaultChannel) {
    defaultChannel.config = {
      ...defaultChannel.config,
      historyMessageLimit: config.historyMessageLimit ?? LEGACY_DEFAULT_HISTORY_MESSAGE_LIMIT,
      streamStatusIdleStartSeconds: config.streamStatusIdleStartSeconds ?? LEGACY_DEFAULT_STREAM_STATUS_IDLE_START_SECONDS,
      streamStatusCheckIntervalSeconds: config.streamStatusCheckIntervalSeconds ?? LEGACY_DEFAULT_STREAM_STATUS_CHECK_INTERVAL_SECONDS,
    };
  }

  return {
    schemaVersion: 2,
    runtime: {
      agent: config.runtime,
      codex: {
        model: config.defaultModel,
        provider: config.defaultProvider || '',
        yoloMode: codexYoloMode,
        skipGitRepoCheck: config.codexSkipGitRepoCheck,
        sandboxMode: config.codexSandboxMode,
        networkAccess: config.codexNetworkAccess,
        reasoningEffort: config.codexReasoningEffort,
      },
      claude: {
        model: config.claudeDefaultModel,
        provider: config.claudeProvider,
        executable: config.claudeExecutable,
        idleTimeoutMinutes: config.claudeIdleTimeoutMinutes,
      },
    },
    bridge: {
      defaultWorkspace: config.defaultWorkspaceRoot,
      uiAllowLan: config.uiAllowLan,
      uiAccessToken: config.uiAccessToken,
    },
    channels,
  };
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
  m.set('remote_bridge_enabled', 'true');
  if (config.defaultWorkspaceRoot) {
    m.set('bridge_default_workspace_root', config.defaultWorkspaceRoot);
  }
  if (config.defaultModel) {
    m.set('bridge_default_model', config.defaultModel);
    m.set('default_model', config.defaultModel);
  }
  if (config.defaultProvider) {
    m.set('bridge_default_provider', config.defaultProvider);
  }
  m.set('bridge_default_runtime', config.runtime === 'claude' ? 'claude' : 'codex');
  m.set('bridge_default_mode', normalizeDefaultMode(config.defaultMode));
  m.set(
    'bridge_history_message_limit',
    String(config.historyMessageLimit && config.historyMessageLimit > 0 ? config.historyMessageLimit : LEGACY_DEFAULT_HISTORY_MESSAGE_LIMIT),
  );
  m.set(
    'bridge_stream_status_idle_start_seconds',
    String(
      config.streamStatusIdleStartSeconds && config.streamStatusIdleStartSeconds > 0
        ? config.streamStatusIdleStartSeconds
        : LEGACY_DEFAULT_STREAM_STATUS_IDLE_START_SECONDS,
    ),
  );
  m.set(
    'bridge_stream_status_check_interval_seconds',
    String(
      config.streamStatusCheckIntervalSeconds && config.streamStatusCheckIntervalSeconds > 0
        ? config.streamStatusCheckIntervalSeconds
        : LEGACY_DEFAULT_STREAM_STATUS_CHECK_INTERVAL_SECONDS,
    ),
  );
  m.set(
    'bridge_codex_skip_git_repo_check',
    config.codexSkipGitRepoCheck === true ? 'true' : 'false',
  );
  m.set(
    'bridge_codex_sandbox_mode',
    config.codexSandboxMode || 'workspace-write',
  );
  m.set(
    'bridge_codex_network_access',
    config.codexNetworkAccess === true ? 'true' : 'false',
  );
  m.set(
    'bridge_codex_reasoning_effort',
    config.codexReasoningEffort || 'medium',
  );
  if (config.claudeExecutable) {
    m.set('bridge_claude_executable', config.claudeExecutable);
  }
  if (config.claudeProvider) {
    m.set('bridge_claude_provider', config.claudeProvider);
  }
  if (config.claudeDefaultModel) {
    m.set('bridge_claude_default_model', config.claudeDefaultModel);
  }
  if (config.claudeIdleTimeoutMinutes !== undefined) {
    m.set('bridge_claude_idle_timeout_minutes', String(config.claudeIdleTimeoutMinutes));
  }
  m.set(
    'bridge_channel_instances_json',
    JSON.stringify(channels),
  );

  m.set(
    'bridge_feishu_enabled',
    feishu?.enabled === true ? 'true' : 'false',
  );
  if (feishuConfig?.appId) m.set('bridge_feishu_app_id', feishuConfig.appId);
  if (feishuConfig?.appSecret) m.set('bridge_feishu_app_secret', feishuConfig.appSecret);
  if (feishuConfig?.site) m.set('bridge_feishu_site', feishuConfig.site);
  if (feishuConfig?.allowedUsers) m.set('bridge_feishu_allowed_users', feishuConfig.allowedUsers.join(','));
  m.set(
    'bridge_feishu_streaming_enabled',
    feishuConfig?.streamingEnabled === false ? 'false' : 'true',
  );
  m.set(
    'bridge_feishu_command_markdown_enabled',
    feishuConfig?.feedbackMarkdownEnabled === false ? 'false' : 'true',
  );
  m.set(
    'bridge_feishu_require_mention',
    feishuConfig?.requireMention === true ? 'true' : 'false',
  );

  return m;
}
