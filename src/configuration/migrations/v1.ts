import fs from 'node:fs';
import { configToTomlShape, type ConfigPatch } from '../schema.js';
import { mergePatch } from '../merge.js';
import type { ConfigMigration, MigrationContext, MigrationResult } from './types.js';
import { parseLegacyEnvFile } from './legacy/env-file.js';
import {
  hasLegacySessionJsonConfig,
  migrateLegacySessionJsonConfigToToml,
} from './legacy/session-json.js';

// v1 -> v2 迁移：读取 config.json/config.env 和旧 sessions.json 中的配置覆盖，写入统一 TOML。
// 这里是旧字段语义的集中解释点，避免 legacy 回退逻辑泄漏到运行时模块。

type LegacyRuntimeProvider = 'codex' | 'claude';
type LegacyCodexProvider = 'sdk' | 'tmux' | 'pty';
type LegacyClaudeProvider = 'sdk' | 'pty';
type LegacyClaudeExecutable = 'claude' | 'ccr';
type LegacyFeishuSite = 'feishu' | 'lark';
type LegacyReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
type LegacySandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

interface LegacyConfigFile {
  schemaVersion: 1;
  runtime?: {
    provider?: unknown;
    codex?: {
      defaultModel?: unknown;
      model?: unknown;
      defaultMode?: unknown;
      mode?: unknown;
      skipGitRepoCheck?: unknown;
      sandboxMode?: unknown;
      networkAccess?: unknown;
      reasoningEffort?: unknown;
    };
    claude?: {
      provider?: unknown;
      executable?: unknown;
      defaultModel?: unknown;
      model?: unknown;
      permissionMode?: unknown;
      reasoningEffort?: unknown;
      idleTimeoutMinutes?: unknown;
    };
    bridgeControl?: {
      defaultCodexProvider?: unknown;
    };
    bridge?: {
      defaultWorkspaceRoot?: unknown;
      historyMessageLimit?: unknown;
      streamStatusIdleStartSeconds?: unknown;
      streamStatusCheckIntervalSeconds?: unknown;
      uiAllowLan?: unknown;
      uiAccessToken?: unknown;
    };
  };
  channels?: Array<{
    id?: unknown;
    alias?: unknown;
    provider?: unknown;
    enabled?: unknown;
    config?: {
      appId?: unknown;
      appSecret?: unknown;
      site?: unknown;
      allowedUsers?: unknown;
      streamingEnabled?: unknown;
      feedbackMarkdownEnabled?: unknown;
      requireMention?: unknown;
      groupAuthorized?: unknown;
    };
  }>;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function boolValue(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}

function positiveIntValue(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

function nonNegativeIntValue(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return Math.floor(parsed);
}

function csvValue(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string');
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return value.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function runtimeProvider(value: unknown): LegacyRuntimeProvider | undefined {
  return value === 'claude' ? 'claude' : value === 'codex' ? 'codex' : undefined;
}

function codexProvider(value: unknown): LegacyCodexProvider | undefined {
  return value === 'sdk' || value === 'tmux' || value === 'pty' ? value : undefined;
}

function claudeProvider(value: unknown): LegacyClaudeProvider | undefined {
  return value === 'sdk' || value === 'pty' ? value : undefined;
}

function claudeExecutable(value: unknown): LegacyClaudeExecutable | undefined {
  return value === 'claude' || value === 'ccr' ? value : undefined;
}

function sandboxMode(value: unknown): LegacySandboxMode | undefined {
  return value === 'read-only' || value === 'workspace-write' || value === 'danger-full-access'
    ? value
    : undefined;
}

function reasoningEffort(value: unknown): LegacyReasoningEffort | undefined {
  return value === 'minimal' || value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh'
    ? value
    : undefined;
}

function feishuSite(value: unknown): LegacyFeishuSite | undefined {
  const normalized = typeof value === 'string' ? value.trim().replace(/\/+$/, '').toLowerCase() : '';
  if (!normalized) return undefined;
  if (normalized === 'lark' || normalized.includes('open.larksuite.com')) return 'lark';
  if (normalized === 'feishu' || normalized.includes('open.feishu.cn')) return 'feishu';
  return undefined;
}

function codexYoloMode(value: unknown): 'off' | 'on' | undefined {
  if (value === 'yolo' || value === 'on') return 'on';
  if (value === 'normal' || value === 'off') return 'off';
  return undefined;
}

function claudeYoloMode(value: unknown, warnings: string[]): 'off' | 'on' | undefined {
  if (value === 'bypassPermissions' || value === 'on') return 'on';
  if (value === 'default' || value === 'acceptEdits' || value === 'plan' || value === 'off') return 'off';
  if (value !== undefined) warnings.push(`已忽略不合法的旧版 Claude permissionMode：${String(value)}`);
  return undefined;
}

function claudePermissionMode(value: unknown, warnings: string[]): 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | undefined {
  if (value === 'default' || value === 'acceptEdits' || value === 'bypassPermissions' || value === 'plan') return value;
  if (value === 'on') return 'bypassPermissions';
  if (value === 'off') return 'default';
  if (value !== undefined) warnings.push(`已忽略不合法的旧版 Claude permissionMode：${String(value)}`);
  return undefined;
}

function patchFromLegacyConfig(config: LegacyConfigFile, warnings: string[]): ConfigPatch {
  const runtime = config.runtime || {};
  const codex = runtime.codex || {};
  const claude = runtime.claude || {};
  const bridge = runtime.bridge || {};
  const bridgeControl = runtime.bridgeControl || {};
  const patch: ConfigPatch = { schemaVersion: 2 };

  const provider = runtimeProvider(runtime.provider);
  if (provider) patch.runtime = { agent: provider };

  const codexPatch: NonNullable<NonNullable<ConfigPatch['runtime']>['codex']> = {};
  const codexModel = stringValue(codex.model) ?? stringValue(codex.defaultModel);
  if (codexModel !== undefined) codexPatch.model = codexModel;
  const legacyCodexMode = codexYoloMode(codex.mode ?? codex.defaultMode);
  if (legacyCodexMode !== undefined) codexPatch.yoloMode = legacyCodexMode;
  const legacyCodexProvider = codexProvider(bridgeControl.defaultCodexProvider);
  if (legacyCodexProvider !== undefined) codexPatch.provider = legacyCodexProvider;
  const skipGitRepoCheck = boolValue(codex.skipGitRepoCheck);
  if (skipGitRepoCheck !== undefined) codexPatch.skipGitRepoCheck = skipGitRepoCheck;
  const legacySandboxMode = sandboxMode(codex.sandboxMode);
  if (legacySandboxMode !== undefined) codexPatch.sandboxMode = legacySandboxMode;
  const networkAccess = boolValue(codex.networkAccess);
  if (networkAccess !== undefined) codexPatch.networkAccess = networkAccess;
  const codexEffort = reasoningEffort(codex.reasoningEffort);
  if (codexEffort !== undefined) codexPatch.reasoningEffort = codexEffort;

  const claudePatch: NonNullable<NonNullable<ConfigPatch['runtime']>['claude']> = {};
  const claudeModel = stringValue(claude.model) ?? stringValue(claude.defaultModel);
  if (claudeModel !== undefined) claudePatch.model = claudeModel;
  const legacyClaudeMode = claudeYoloMode(claude.permissionMode, warnings);
  if (legacyClaudeMode !== undefined) claudePatch.yoloMode = legacyClaudeMode;
  const legacyClaudePermissionMode = claudePermissionMode(claude.permissionMode, warnings);
  if (legacyClaudePermissionMode !== undefined) claudePatch.permissionMode = legacyClaudePermissionMode;
  const legacyClaudeProvider = claudeProvider(claude.provider);
  if (legacyClaudeProvider !== undefined) claudePatch.provider = legacyClaudeProvider;
  const legacyClaudeExecutable = claudeExecutable(claude.executable);
  if (legacyClaudeExecutable !== undefined) claudePatch.executable = legacyClaudeExecutable;
  const claudeEffort = reasoningEffort(claude.reasoningEffort);
  if (claudeEffort !== undefined) claudePatch.reasoningEffort = claudeEffort;
  const idleTimeoutMinutes = nonNegativeIntValue(claude.idleTimeoutMinutes);
  if (idleTimeoutMinutes !== undefined) claudePatch.idleTimeoutMinutes = idleTimeoutMinutes;

  if (Object.keys(codexPatch).length > 0 || Object.keys(claudePatch).length > 0) {
    patch.runtime = {
      ...(patch.runtime || {}),
      ...(Object.keys(codexPatch).length > 0 ? { codex: codexPatch } : {}),
      ...(Object.keys(claudePatch).length > 0 ? { claude: claudePatch } : {}),
    };
  }

  const bridgePatch: NonNullable<ConfigPatch['bridge']> = {};
  const defaultWorkspace = stringValue(bridge.defaultWorkspaceRoot);
  if (defaultWorkspace !== undefined) bridgePatch.defaultWorkspace = defaultWorkspace;
  const uiAllowLan = boolValue(bridge.uiAllowLan);
  if (uiAllowLan !== undefined) bridgePatch.uiAllowLan = uiAllowLan;
  const uiAccessToken = stringValue(bridge.uiAccessToken);
  if (uiAccessToken !== undefined) bridgePatch.uiAccessToken = uiAccessToken;
  if (Object.keys(bridgePatch).length > 0) patch.bridge = bridgePatch;

  const channels = (config.channels || []).flatMap((channel): NonNullable<ConfigPatch['channels']> => {
    if (channel.provider !== 'feishu') return [];
    const channelConfig = channel.config || {};
    const behavior: NonNullable<NonNullable<ConfigPatch['channels']>[number]['config']> = {};
    const appId = stringValue(channelConfig.appId);
    if (appId !== undefined) behavior.appId = appId;
    const appSecret = stringValue(channelConfig.appSecret);
    if (appSecret !== undefined) behavior.appSecret = appSecret;
    const site = feishuSite(channelConfig.site);
    if (site !== undefined) behavior.site = site;
    const allowedUsers = csvValue(channelConfig.allowedUsers);
    if (allowedUsers !== undefined) behavior.allowedUsers = allowedUsers;
    const streamingEnabled = boolValue(channelConfig.streamingEnabled);
    if (streamingEnabled !== undefined) behavior.streamingEnabled = streamingEnabled;
    const feedbackMarkdownEnabled = boolValue(channelConfig.feedbackMarkdownEnabled);
    if (feedbackMarkdownEnabled !== undefined) behavior.feedbackMarkdownEnabled = feedbackMarkdownEnabled;
    const requireMention = boolValue(channelConfig.requireMention);
    if (requireMention !== undefined) behavior.requireMention = requireMention;
    const groupAuthorized = boolValue(channelConfig.groupAuthorized);
    if (groupAuthorized !== undefined) behavior.groupAuthorized = groupAuthorized;
    return [{
      id: stringValue(channel.id) || 'feishu-default',
      alias: stringValue(channel.alias) || '飞书',
      provider: 'feishu',
      enabled: boolValue(channel.enabled) ?? false,
      config: {
        historyMessageLimit: 8,
        streamStatusIdleStartSeconds: 180,
        streamStatusCheckIntervalSeconds: 10,
        appId: '',
        appSecret: '',
        site: 'feishu',
        allowedUsers: [],
        streamingEnabled: true,
        feedbackMarkdownEnabled: true,
        requireMention: false,
        groupAuthorized: false,
        ...behavior,
      },
    }];
  });
  if (channels.length > 0) patch.channels = channels;

  const historyMessageLimit = positiveIntValue(bridge.historyMessageLimit);
  const streamStatusIdleStartSeconds = positiveIntValue(bridge.streamStatusIdleStartSeconds);
  const streamStatusCheckIntervalSeconds = positiveIntValue(bridge.streamStatusCheckIntervalSeconds);
  if (historyMessageLimit !== undefined || streamStatusIdleStartSeconds !== undefined || streamStatusCheckIntervalSeconds !== undefined) {
    patch.channels ??= [{ id: 'feishu-default', provider: 'feishu' }];
    const defaultChannel = patch.channels[0]!;
    defaultChannel.config ??= {};
    if (historyMessageLimit !== undefined) defaultChannel.config.historyMessageLimit = historyMessageLimit;
    if (streamStatusIdleStartSeconds !== undefined) defaultChannel.config.streamStatusIdleStartSeconds = streamStatusIdleStartSeconds;
    if (streamStatusCheckIntervalSeconds !== undefined) defaultChannel.config.streamStatusCheckIntervalSeconds = streamStatusCheckIntervalSeconds;
  }

  return patch;
}

function patchFromLegacyEnv(env: Map<string, string>, warnings: string[]): ConfigPatch {
  const enabledChannels = csvValue(env.get('CODELARK_ENABLED_CHANNELS')) || [];
  const patch = patchFromLegacyConfig({
    schemaVersion: 1,
    runtime: {
      provider: env.get('CODELARK_RUNTIME'),
      codex: {
        defaultModel: env.get('CODELARK_CODEX_MODEL') ?? env.get('CODELARK_CODEX_DEFAULT_MODEL'),
        defaultMode: env.get('CODELARK_CODEX_YOLO_MODE') ?? env.get('CODELARK_CODEX_DEFAULT_MODE'),
        skipGitRepoCheck: env.get('CODELARK_CODEX_SKIP_GIT_REPO_CHECK'),
        sandboxMode: env.get('CODELARK_CODEX_SANDBOX_MODE'),
        networkAccess: env.get('CODELARK_CODEX_NETWORK_ACCESS'),
        reasoningEffort: env.get('CODELARK_CODEX_REASONING_EFFORT'),
      },
      bridgeControl: {
        defaultCodexProvider: env.get('CODELARK_CODEX_PROVIDER') ?? env.get('CODELARK_DEFAULT_CODEX_PROVIDER'),
      },
      bridge: {
        defaultWorkspaceRoot: env.get('CODELARK_DEFAULT_WORKSPACE_ROOT'),
        historyMessageLimit: env.get('CODELARK_HISTORY_MESSAGE_LIMIT'),
        streamStatusIdleStartSeconds: env.get('CODELARK_STREAM_STATUS_IDLE_START_SECONDS'),
        streamStatusCheckIntervalSeconds: env.get('CODELARK_STREAM_STATUS_CHECK_INTERVAL_SECONDS'),
        uiAllowLan: env.get('CODELARK_UI_ALLOW_LAN'),
        uiAccessToken: env.get('CODELARK_UI_ACCESS_TOKEN'),
      },
      claude: {
        provider: env.get('CODELARK_CLAUDE_PROVIDER'),
        executable: env.get('CODELARK_CLAUDE_EXECUTABLE'),
        defaultModel: env.get('CODELARK_CLAUDE_MODEL') ?? env.get('CODELARK_CLAUDE_DEFAULT_MODEL'),
        permissionMode: env.get('CODELARK_CLAUDE_PERMISSION_MODE') ?? env.get('CODELARK_CLAUDE_YOLO_MODE'),
        reasoningEffort: env.get('CODELARK_CLAUDE_REASONING_EFFORT'),
        idleTimeoutMinutes: env.get('CODELARK_CLAUDE_IDLE_TIMEOUT_MINUTES'),
      },
    },
    channels: [{
      id: 'feishu-default',
      alias: '飞书',
      provider: 'feishu',
      enabled: enabledChannels.includes('feishu'),
      config: {
        appId: env.get('CODELARK_FEISHU_APP_ID'),
        appSecret: env.get('CODELARK_FEISHU_APP_SECRET'),
        site: env.get('CODELARK_FEISHU_SITE') ?? env.get('CODELARK_FEISHU_DOMAIN'),
        allowedUsers: env.get('CODELARK_FEISHU_ALLOWED_USERS'),
        streamingEnabled: env.get('CODELARK_FEISHU_STREAMING_ENABLED'),
        feedbackMarkdownEnabled: env.get('CODELARK_FEISHU_COMMAND_MARKDOWN_ENABLED'),
        requireMention: env.get('CODELARK_FEISHU_REQUIRE_MENTION'),
      },
    }],
  }, warnings);
  if (!env.has('CODELARK_ENABLED_CHANNELS') && !hasLegacyFeishuEnv(env)) {
    patch.channels = undefined;
  }
  return patch;
}

function hasLegacyFeishuEnv(env: Map<string, string>): boolean {
  return [
    'CODELARK_FEISHU_APP_ID',
    'CODELARK_FEISHU_APP_SECRET',
    'CODELARK_FEISHU_SITE',
    'CODELARK_FEISHU_DOMAIN',
    'CODELARK_FEISHU_ALLOWED_USERS',
    'CODELARK_FEISHU_STREAMING_ENABLED',
    'CODELARK_FEISHU_COMMAND_MARKDOWN_ENABLED',
    'CODELARK_FEISHU_REQUIRE_MENTION',
  ].some((key) => env.has(key));
}

function readLegacyEnv(context: MigrationContext): Map<string, string> {
  try {
    return parseLegacyEnvFile(fs.readFileSync(context.paths.legacyConfigEnv, 'utf-8'));
  } catch {
    return new Map();
  }
}

function shouldOverlayEnv(context: MigrationContext, hasJson: boolean): boolean {
  if (!fs.existsSync(context.paths.legacyConfigEnv)) return false;
  if (!hasJson) return true;
  const envMtime = fs.statSync(context.paths.legacyConfigEnv).mtimeMs;
  const jsonMtime = fs.statSync(context.paths.legacyConfigJson).mtimeMs;
  return envMtime > jsonMtime;
}

function readLegacyJson(context: MigrationContext): LegacyConfigFile | null {
  const parsed = context.readJson<LegacyConfigFile>(context.paths.legacyConfigJson);
  return parsed?.schemaVersion === 1 ? parsed : null;
}

function nextArchivePath(filePath: string): string {
  const base = `${filePath}.migrated-v1`;
  if (!fs.existsSync(base)) return base;
  for (let index = 1; ; index += 1) {
    const candidate = `${base}.${index}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
}

function archiveLegacyInput(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  const archivePath = nextArchivePath(filePath);
  fs.renameSync(filePath, archivePath);
  return archivePath;
}

export const v1ConfigMigration: ConfigMigration = {
  id: 'v1',
  description: '迁移旧版 config.json/config.env 和会话 runtime 覆盖到 v2 TOML',
  fromVersion: 1,
  toVersion: 2,
  detect(context) {
    const needsHomeMigration = !fs.existsSync(context.paths.homeToml)
      && (fs.existsSync(context.paths.legacyConfigJson) || fs.existsSync(context.paths.legacyConfigEnv));
    return needsHomeMigration || hasLegacySessionJsonConfig({ codelarkHome: context.codelarkHome });
  },
  apply(context): MigrationResult {
    const warnings: string[] = [];
    const shouldMigrateHome = !fs.existsSync(context.paths.homeToml)
      && (fs.existsSync(context.paths.legacyConfigJson) || fs.existsSync(context.paths.legacyConfigEnv));
    const shouldMigrateSessions = hasLegacySessionJsonConfig({ codelarkHome: context.codelarkHome });
    const writtenFiles: string[] = [];
    const backedUpFiles: string[] = [];
    let patch: ConfigPatch | null = null;

    if (shouldMigrateHome) {
      const hasJson = fs.existsSync(context.paths.legacyConfigJson);
      const legacyJson = hasJson ? readLegacyJson(context) : null;
      const env = readLegacyEnv(context);
      patch = { schemaVersion: 2 };

      if (legacyJson) mergePatch(patch, patchFromLegacyConfig(legacyJson, warnings));
      if (shouldOverlayEnv(context, Boolean(legacyJson)) && env.size > 0) {
        mergePatch(patch, patchFromLegacyEnv(env, warnings));
      }
    }

    for (const file of [
      shouldMigrateHome ? context.paths.legacyConfigJson : undefined,
      shouldMigrateHome ? context.paths.legacyConfigEnv : undefined,
      shouldMigrateSessions ? context.paths.dataSessionsJson : undefined,
    ]) {
      if (!file) continue;
      const backup = context.backupFile(file, 'v1');
      if (backup) backedUpFiles.push(backup);
    }

    if (patch) {
      context.writeTomlAtomic(context.paths.homeToml, configToTomlShape(patch));
      writtenFiles.push(context.paths.homeToml);
      for (const file of [context.paths.legacyConfigJson, context.paths.legacyConfigEnv]) {
        const archivePath = archiveLegacyInput(file);
        if (archivePath) writtenFiles.push(archivePath);
      }
    }

    if (shouldMigrateSessions) {
      const sessionResult = migrateLegacySessionJsonConfigToToml({
        codelarkHome: context.codelarkHome,
        pruneSessionJson: true,
      });
      writtenFiles.push(...sessionResult.writtenFiles);
      if (sessionResult.prunedSessionsJson) writtenFiles.push(context.paths.dataSessionsJson);
    }

    return {
      changed: writtenFiles.length > 0,
      writtenFiles,
      backedUpFiles,
      warnings,
    };
  },
};
