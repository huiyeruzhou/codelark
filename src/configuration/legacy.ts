import os from 'node:os';
import type {
  ChannelInstance,
  ClaudePermissionMode,
  Config,
  FeishuChannelConfig,
} from './index.js';
import type { ConfigPatch, ConfigV2 } from './schema.js';

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

function v2ClaudeYoloMode(permissionMode: ClaudePermissionMode | undefined): ConfigV2['runtime']['claude']['yoloMode'] | undefined {
  if (permissionMode === undefined) return undefined;
  return permissionMode === 'bypassPermissions' ? 'on' : 'off';
}

function legacyClaudePermissionMode(config: ConfigV2['runtime']['claude']): ClaudePermissionMode {
  if (config.permissionMode !== 'default') return config.permissionMode;
  return config.yoloMode === 'on' || config.yoloMode === 'yolo' ? 'bypassPermissions' : 'default';
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
    runtime: config.runtime.provider,
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
    claudePermissionMode: legacyClaudePermissionMode(config.runtime.claude),
    claudeIdleTimeoutMinutes: config.runtime.claude.idleTimeoutMinutes,
    uiAllowLan: config.bridge.uiAllowLan,
    uiAccessToken: config.bridge.uiAccessToken || undefined,
  };
}

export function legacyConfigToConfigPatch(config: Config): ConfigPatch {
  const codexYoloMode = v2CodexYoloMode(config.defaultMode);
  const claudeYoloMode = v2ClaudeYoloMode(config.claudePermissionMode);
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
      provider: config.runtime,
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
        yoloMode: claudeYoloMode,
        permissionMode: config.claudePermissionMode,
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
