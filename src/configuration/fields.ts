import { z } from 'zod';
import {
  claudeExecutableSchema,
  claudePermissionModeSchema,
  claudeProviderSchema,
  codexProviderSchema,
  feishuSiteSchema,
  reasoningEffortSchema,
  runtimeAgentSchema,
  sandboxModeSchema,
  yoloModeSchema,
} from './schema.js';
import type { ConfigField } from './fields-types.js';

function boolFromEnv(value: string): boolean | undefined {
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}

function positiveIntFromEnv(value: string): number | undefined {
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

function nonNegativeIntFromEnv(value: string): number | undefined {
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return Math.floor(parsed);
}

function csvFromEnv(value: string): string[] {
  return value.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function stringFromEnv(value: string): string {
  return value;
}

function enumFromEnv<T extends z.ZodEnum>(schema: T): (value: string) => z.infer<T> | undefined {
  return (value) => {
    const parsed = schema.safeParse(value.trim());
    return parsed.success ? parsed.data : undefined;
  };
}

const allScopes = ['home', 'local', 'channel', 'session', 'env', 'cli'] as const;
const globalScopes = ['home', 'local', 'env', 'cli'] as const;
const channelScopes = ['home', 'local', 'channel', 'env', 'cli'] as const;
const sessionScopes = ['home', 'local', 'channel', 'session', 'env', 'cli'] as const;

export const configFields = [
  {
    path: 'session.workspace',
    tomlPath: 'session.workspace',
    scopes: ['local', 'channel', 'session', 'cli'],
    schema: z.string(),
    cliOption: '--workspace <path>',
    commandAliases: ['/cd'],
    defaultWriteScope: 'channel',
  },
  {
    path: 'session.tmuxSessionName',
    tomlPath: 'session.tmux_session_name',
    scopes: ['session', 'cli'],
    schema: z.string(),
  },
  {
    path: 'session.tmuxCaptureLines',
    tomlPath: 'session.tmux_capture_lines',
    scopes: ['session', 'cli'],
    schema: z.number().int().positive(),
  },
  {
    path: 'session.tmuxAutoEnter',
    tomlPath: 'session.tmux_auto_enter',
    scopes: ['session', 'cli'],
    schema: z.boolean(),
  },
  {
    path: 'session.tmuxEchoInput',
    tomlPath: 'session.tmux_echo_input',
    scopes: ['session', 'cli'],
    schema: z.boolean(),
  },
  {
    path: 'runtime.agent',
    tomlPath: 'runtime.agent',
    scopes: allScopes,
    schema: runtimeAgentSchema,
    envKey: 'CODELARK_AGENT',
    processEnvKey: 'CODELARK_AGENT',
    runtimeSettingsKey: 'bridge_default_runtime',
    parseEnv: enumFromEnv(runtimeAgentSchema),
  },
  {
    path: 'bridge.defaultWorkspace',
    tomlPath: 'bridge.default_workspace',
    scopes: globalScopes,
    schema: z.string(),
    envKey: 'CODELARK_DEFAULT_WORKSPACE_ROOT',
    processEnvKey: 'CODELARK_DEFAULT_WORKSPACE_ROOT',
    runtimeSettingsKey: 'bridge_default_workspace_root',
    parseEnv: stringFromEnv,
  },
  {
    path: 'bridge.uiAllowLan',
    tomlPath: 'bridge.ui_allow_lan',
    scopes: globalScopes,
    schema: z.boolean(),
    envKey: 'CODELARK_UI_ALLOW_LAN',
    processEnvKey: 'CODELARK_UI_ALLOW_LAN',
    parseEnv: boolFromEnv,
  },
  {
    path: 'bridge.uiAccessToken',
    tomlPath: 'bridge.ui_access_token',
    scopes: globalScopes,
    schema: z.string(),
    envKey: 'CODELARK_UI_ACCESS_TOKEN',
    processEnvKey: 'CODELARK_UI_ACCESS_TOKEN',
    parseEnv: stringFromEnv,
    secret: true,
  },
  {
    path: 'runtime.codex.model',
    tomlPath: 'runtime.codex.model',
    scopes: sessionScopes,
    schema: z.string(),
    envKey: 'CODELARK_CODEX_MODEL',
    processEnvKey: 'CODELARK_CODEX_MODEL',
    runtimeSettingsKey: 'bridge_default_model',
    parseEnv: stringFromEnv,
    commandAliases: ['/model'],
    defaultWriteScope: 'channel',
  },
  {
    path: 'runtime.codex.yoloMode',
    tomlPath: 'runtime.codex.yolo_mode',
    scopes: sessionScopes,
    schema: yoloModeSchema,
    envKey: 'CODELARK_CODEX_YOLO_MODE',
    processEnvKey: 'CODELARK_CODEX_YOLO_MODE',
    runtimeSettingsKey: 'bridge_default_mode',
    parseEnv: enumFromEnv(yoloModeSchema),
    commandAliases: ['/mode'],
    defaultWriteScope: 'channel',
  },
  {
    path: 'runtime.codex.provider',
    tomlPath: 'runtime.codex.provider',
    scopes: sessionScopes,
    schema: z.union([codexProviderSchema, z.literal('')]),
    envKey: 'CODELARK_CODEX_PROVIDER',
    processEnvKey: 'CODELARK_CODEX_PROVIDER',
    runtimeSettingsKey: 'bridge_default_provider',
    parseEnv: (value) => {
      const normalized = value.trim();
      if (normalized === '') return '';
      const parsed = codexProviderSchema.safeParse(normalized);
      return parsed.success ? parsed.data : undefined;
    },
  },
  {
    path: 'runtime.codex.skipGitRepoCheck',
    tomlPath: 'runtime.codex.skip_git_repo_check',
    scopes: globalScopes,
    schema: z.boolean(),
    envKey: 'CODELARK_CODEX_SKIP_GIT_REPO_CHECK',
    processEnvKey: 'CODELARK_CODEX_SKIP_GIT_REPO_CHECK',
    runtimeSettingsKey: 'bridge_codex_skip_git_repo_check',
    parseEnv: boolFromEnv,
  },
  {
    path: 'runtime.codex.sandboxMode',
    tomlPath: 'runtime.codex.sandbox_mode',
    scopes: sessionScopes,
    schema: sandboxModeSchema,
    envKey: 'CODELARK_CODEX_SANDBOX_MODE',
    processEnvKey: 'CODELARK_CODEX_SANDBOX_MODE',
    runtimeSettingsKey: 'bridge_codex_sandbox_mode',
    parseEnv: enumFromEnv(sandboxModeSchema),
    commandAliases: ['/sandbox'],
    defaultWriteScope: 'channel',
  },
  {
    path: 'runtime.codex.networkAccess',
    tomlPath: 'runtime.codex.network_access',
    scopes: sessionScopes,
    schema: z.boolean(),
    envKey: 'CODELARK_CODEX_NETWORK_ACCESS',
    processEnvKey: 'CODELARK_CODEX_NETWORK_ACCESS',
    runtimeSettingsKey: 'bridge_codex_network_access',
    parseEnv: boolFromEnv,
    commandAliases: ['/network'],
    defaultWriteScope: 'channel',
  },
  {
    path: 'runtime.codex.reasoningEffort',
    tomlPath: 'runtime.codex.reasoning_effort',
    scopes: sessionScopes,
    schema: reasoningEffortSchema,
    envKey: 'CODELARK_CODEX_REASONING_EFFORT',
    processEnvKey: 'CODELARK_CODEX_REASONING_EFFORT',
    runtimeSettingsKey: 'bridge_codex_reasoning_effort',
    parseEnv: enumFromEnv(reasoningEffortSchema),
    commandAliases: ['/r'],
    defaultWriteScope: 'channel',
  },
  {
    path: 'runtime.claude.model',
    tomlPath: 'runtime.claude.model',
    scopes: sessionScopes,
    schema: z.string(),
    envKey: 'CODELARK_CLAUDE_MODEL',
    processEnvKey: 'CODELARK_CLAUDE_MODEL',
    runtimeSettingsKey: 'bridge_claude_default_model',
    parseEnv: stringFromEnv,
  },
  {
    path: 'runtime.claude.yoloMode',
    tomlPath: 'runtime.claude.yolo_mode',
    scopes: sessionScopes,
    schema: yoloModeSchema,
    envKey: 'CODELARK_CLAUDE_YOLO_MODE',
    processEnvKey: 'CODELARK_CLAUDE_YOLO_MODE',
    parseEnv: enumFromEnv(yoloModeSchema),
    commandAliases: ['/mode'],
    defaultWriteScope: 'channel',
  },
  {
    path: 'runtime.claude.permissionMode',
    tomlPath: 'runtime.claude.permission_mode',
    scopes: sessionScopes,
    schema: claudePermissionModeSchema,
    envKey: 'CODELARK_CLAUDE_PERMISSION_MODE',
    processEnvKey: 'CODELARK_CLAUDE_PERMISSION_MODE',
    runtimeSettingsKey: 'bridge_claude_permission_mode',
    parseEnv: enumFromEnv(claudePermissionModeSchema),
    commandAliases: ['/mode'],
    defaultWriteScope: 'channel',
  },
  {
    path: 'runtime.claude.provider',
    tomlPath: 'runtime.claude.provider',
    scopes: sessionScopes,
    schema: claudeProviderSchema,
    envKey: 'CODELARK_CLAUDE_PROVIDER',
    processEnvKey: 'CODELARK_CLAUDE_PROVIDER',
    runtimeSettingsKey: 'bridge_claude_provider',
    parseEnv: enumFromEnv(claudeProviderSchema),
  },
  {
    path: 'runtime.claude.executable',
    tomlPath: 'runtime.claude.executable',
    scopes: globalScopes,
    schema: claudeExecutableSchema,
    envKey: 'CODELARK_CLAUDE_EXECUTABLE',
    processEnvKey: 'CODELARK_CLAUDE_EXECUTABLE',
    runtimeSettingsKey: 'bridge_claude_executable',
    parseEnv: enumFromEnv(claudeExecutableSchema),
  },
  {
    path: 'runtime.claude.reasoningEffort',
    tomlPath: 'runtime.claude.reasoning_effort',
    scopes: sessionScopes,
    schema: reasoningEffortSchema,
    envKey: 'CODELARK_CLAUDE_REASONING_EFFORT',
    processEnvKey: 'CODELARK_CLAUDE_REASONING_EFFORT',
    parseEnv: enumFromEnv(reasoningEffortSchema),
  },
  {
    path: 'runtime.claude.idleTimeoutMinutes',
    tomlPath: 'runtime.claude.idle_timeout_minutes',
    scopes: sessionScopes,
    schema: z.number().int().nonnegative(),
    envKey: 'CODELARK_CLAUDE_IDLE_TIMEOUT_MINUTES',
    processEnvKey: 'CODELARK_CLAUDE_IDLE_TIMEOUT_MINUTES',
    runtimeSettingsKey: 'bridge_claude_idle_timeout_minutes',
    parseEnv: nonNegativeIntFromEnv,
  },
  {
    path: 'channels[].enabled',
    tomlPath: 'channels[].enabled',
    scopes: channelScopes,
    schema: z.boolean(),
    envKey: 'CODELARK_ENABLED_CHANNELS',
    processEnvKey: 'CODELARK_ENABLED_CHANNELS',
    parseEnv: csvFromEnv,
  },
  {
    path: 'channels[].config.historyMessageLimit',
    tomlPath: 'channels[].config.history_message_limit',
    scopes: channelScopes,
    schema: z.number().int().positive(),
    envKey: 'CODELARK_HISTORY_MESSAGE_LIMIT',
    processEnvKey: 'CODELARK_HISTORY_MESSAGE_LIMIT',
    runtimeSettingsKey: 'bridge_history_message_limit',
    parseEnv: positiveIntFromEnv,
  },
  {
    path: 'channels[].config.streamStatusIdleStartSeconds',
    tomlPath: 'channels[].config.stream_status_idle_start_seconds',
    scopes: channelScopes,
    schema: z.number().int().positive(),
    envKey: 'CODELARK_STREAM_STATUS_IDLE_START_SECONDS',
    processEnvKey: 'CODELARK_STREAM_STATUS_IDLE_START_SECONDS',
    runtimeSettingsKey: 'bridge_stream_status_idle_start_seconds',
    parseEnv: positiveIntFromEnv,
  },
  {
    path: 'channels[].config.streamStatusCheckIntervalSeconds',
    tomlPath: 'channels[].config.stream_status_check_interval_seconds',
    scopes: channelScopes,
    schema: z.number().int().positive(),
    envKey: 'CODELARK_STREAM_STATUS_CHECK_INTERVAL_SECONDS',
    processEnvKey: 'CODELARK_STREAM_STATUS_CHECK_INTERVAL_SECONDS',
    runtimeSettingsKey: 'bridge_stream_status_check_interval_seconds',
    parseEnv: positiveIntFromEnv,
  },
  {
    path: 'channels[].config.appId',
    tomlPath: 'channels[].config.app_id',
    scopes: ['home', 'local', 'env', 'cli'],
    schema: z.string(),
    envKey: 'CODELARK_FEISHU_APP_ID',
    processEnvKey: 'CODELARK_FEISHU_APP_ID',
    runtimeSettingsKey: 'bridge_feishu_app_id',
    parseEnv: stringFromEnv,
  },
  {
    path: 'channels[].config.appSecret',
    tomlPath: 'channels[].config.app_secret',
    scopes: ['home', 'local', 'env', 'cli'],
    schema: z.string(),
    envKey: 'CODELARK_FEISHU_APP_SECRET',
    processEnvKey: 'CODELARK_FEISHU_APP_SECRET',
    runtimeSettingsKey: 'bridge_feishu_app_secret',
    parseEnv: stringFromEnv,
    secret: true,
  },
  {
    path: 'channels[].config.site',
    tomlPath: 'channels[].config.site',
    scopes: ['home', 'local', 'env', 'cli'],
    schema: feishuSiteSchema,
    envKey: 'CODELARK_FEISHU_SITE',
    processEnvKey: 'CODELARK_FEISHU_SITE',
    runtimeSettingsKey: 'bridge_feishu_site',
    parseEnv: enumFromEnv(feishuSiteSchema),
  },
  {
    path: 'channels[].config.allowedUsers',
    tomlPath: 'channels[].config.allowed_users',
    scopes: ['home', 'local', 'env', 'cli'],
    schema: z.array(z.string()),
    envKey: 'CODELARK_FEISHU_ALLOWED_USERS',
    processEnvKey: 'CODELARK_FEISHU_ALLOWED_USERS',
    runtimeSettingsKey: 'bridge_feishu_allowed_users',
    parseEnv: csvFromEnv,
    formatEnv: (value) => Array.isArray(value) ? value.join(',') : undefined,
  },
  {
    path: 'channels[].config.streamingEnabled',
    tomlPath: 'channels[].config.streaming_enabled',
    scopes: channelScopes,
    schema: z.boolean(),
    envKey: 'CODELARK_FEISHU_STREAMING_ENABLED',
    processEnvKey: 'CODELARK_FEISHU_STREAMING_ENABLED',
    runtimeSettingsKey: 'bridge_feishu_streaming_enabled',
    parseEnv: boolFromEnv,
  },
  {
    path: 'channels[].config.feedbackMarkdownEnabled',
    tomlPath: 'channels[].config.feedback_markdown_enabled',
    scopes: channelScopes,
    schema: z.boolean(),
    envKey: 'CODELARK_FEISHU_COMMAND_MARKDOWN_ENABLED',
    processEnvKey: 'CODELARK_FEISHU_COMMAND_MARKDOWN_ENABLED',
    runtimeSettingsKey: 'bridge_feishu_command_markdown_enabled',
    parseEnv: boolFromEnv,
  },
  {
    path: 'channels[].config.requireMention',
    tomlPath: 'channels[].config.require_mention',
    scopes: channelScopes,
    schema: z.boolean(),
    envKey: 'CODELARK_FEISHU_REQUIRE_MENTION',
    processEnvKey: 'CODELARK_FEISHU_REQUIRE_MENTION',
    runtimeSettingsKey: 'bridge_feishu_require_mention',
    parseEnv: boolFromEnv,
  },
] as const satisfies readonly ConfigField[];

export type KnownConfigPath = typeof configFields[number]['path'];

export function findConfigField(path: string): ConfigField | undefined {
  return configFields.find((field) => field.path === path);
}
