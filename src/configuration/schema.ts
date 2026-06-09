import { z } from 'zod';

// 当前 v2 TOML shape 的运行时校验与 camelCase/snake_case 转换。
// sources.ts 负责读写文件，service.ts 负责调用链路，这里只维护结构和类型。

export const runtimeAgentSchema = z.enum(['codex', 'claude']);
export const codexProviderSchema = z.enum(['sdk', 'tmux', 'pty']);
export const claudeProviderSchema = z.enum(['sdk', 'pty', 'tmux']);
export const claudeExecutableSchema = z.enum(['claude', 'ccr']);
export const yoloModeSchema = z.enum(['off', 'on', 'yolo']);
export const sandboxModeSchema = z.enum(['read-only', 'workspace-write', 'danger-full-access']);
export const reasoningEffortSchema = z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']);
export const claudeReasoningEffortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
export const feishuSiteSchema = z.enum(['feishu', 'lark']);

const positiveIntegerSchema = z.number().int().positive();
const nonNegativeIntegerSchema = z.number().int().nonnegative();

export const sessionConfigSchema = z.object({
  workspace: z.string(),
  tmuxCaptureLines: positiveIntegerSchema,
  tmuxAutoEnter: z.boolean(),
  tmuxEchoInput: z.boolean(),
});

export const codexConfigSchema = z.object({
  model: z.string(),
  yoloMode: yoloModeSchema,
  provider: z.union([codexProviderSchema, z.literal('')]),
  skipGitRepoCheck: z.boolean(),
  sandboxMode: sandboxModeSchema,
  networkAccess: z.boolean(),
  reasoningEffort: reasoningEffortSchema,
});

export const claudeConfigSchema = z.object({
  model: z.string(),
  yoloMode: yoloModeSchema,
  provider: claudeProviderSchema,
  executable: claudeExecutableSchema,
  reasoningEffort: claudeReasoningEffortSchema,
  idleTimeoutMinutes: nonNegativeIntegerSchema,
});

export const runtimeConfigSchema = z.object({
  agent: runtimeAgentSchema,
  codex: codexConfigSchema,
  claude: claudeConfigSchema,
});

export const bridgeConfigSchema = z.object({
  defaultWorkspace: z.string(),
  uiAllowLan: z.boolean(),
  uiAccessToken: z.string(),
});

export const channelBehaviorConfigSchema = z.object({
  historyMessageLimit: positiveIntegerSchema,
  streamStatusIdleStartSeconds: positiveIntegerSchema,
  streamStatusCheckIntervalSeconds: positiveIntegerSchema,
  appId: z.string(),
  appSecret: z.string(),
  site: feishuSiteSchema,
  allowedUsers: z.array(z.string()),
  streamingEnabled: z.boolean(),
  feedbackMarkdownEnabled: z.boolean(),
  requireMention: z.boolean(),
  groupAuthorized: z.boolean(),
});

export const channelConfigSchema = z.object({
  id: z.string().min(1),
  alias: z.string(),
  provider: z.literal('feishu'),
  enabled: z.boolean(),
  config: channelBehaviorConfigSchema,
});

export const configSchema = z.object({
  schemaVersion: z.literal(2),
  session: sessionConfigSchema,
  runtime: runtimeConfigSchema,
  bridge: bridgeConfigSchema,
  channels: z.array(channelConfigSchema),
});

const channelConfigPatchSchema = z.object({
  id: z.string().min(1),
  alias: z.string().optional(),
  provider: z.literal('feishu').optional(),
  enabled: z.boolean().optional(),
  config: channelBehaviorConfigSchema.partial().optional(),
});

export const configPatchSchema = z.object({
  schemaVersion: z.literal(2).optional(),
  session: sessionConfigSchema.partial().optional(),
  runtime: z.object({
    agent: runtimeAgentSchema.optional(),
    codex: codexConfigSchema.partial().optional(),
    claude: claudeConfigSchema.partial().optional(),
  }).optional(),
  bridge: bridgeConfigSchema.partial().optional(),
  channels: z.array(channelConfigPatchSchema).optional(),
});

export type ConfigV2 = z.infer<typeof configSchema>;
export type ConfigPatch = z.infer<typeof configPatchSchema>;
export type ChannelConfigV2 = z.infer<typeof channelConfigSchema>;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function copyDefined<T extends Record<string, unknown>>(source: Record<string, unknown>, pairs: Array<[keyof T & string, string]>): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [canonical, toml] of pairs) {
    if (source[toml] !== undefined) out[canonical] = source[toml];
  }
  return out as Partial<T>;
}

export function tomlToConfigPatch(raw: unknown): ConfigPatch {
  const root = asRecord(raw);
  const runtime = asRecord(root.runtime);
  const codex = asRecord(runtime.codex);
  const claude = asRecord(runtime.claude);
  const bridge = asRecord(root.bridge);
  const session = asRecord(root.session);
  const patch: ConfigPatch = {};

  if (root.schema_version !== undefined) patch.schemaVersion = root.schema_version as 2;

  const sessionPatch = copyDefined<NonNullable<ConfigPatch['session']>>(session, [
    ['workspace', 'workspace'],
    ['tmuxCaptureLines', 'tmux_capture_lines'],
    ['tmuxAutoEnter', 'tmux_auto_enter'],
    ['tmuxEchoInput', 'tmux_echo_input'],
  ]);
  if (Object.keys(sessionPatch).length > 0) patch.session = sessionPatch;

  const runtimePatch: NonNullable<ConfigPatch['runtime']> = {};
  if (runtime.agent !== undefined) runtimePatch.agent = runtime.agent as never;
  const codexPatch = copyDefined<NonNullable<NonNullable<ConfigPatch['runtime']>['codex']>>(codex, [
    ['model', 'model'],
    ['yoloMode', 'yolo_mode'],
    ['provider', 'provider'],
    ['skipGitRepoCheck', 'skip_git_repo_check'],
    ['sandboxMode', 'sandbox_mode'],
    ['networkAccess', 'network_access'],
    ['reasoningEffort', 'reasoning_effort'],
  ]);
  if (Object.keys(codexPatch).length > 0) runtimePatch.codex = codexPatch;
  const claudePatch = copyDefined<NonNullable<NonNullable<ConfigPatch['runtime']>['claude']>>(claude, [
    ['model', 'model'],
    ['yoloMode', 'yolo_mode'],
    ['provider', 'provider'],
    ['executable', 'executable'],
    ['reasoningEffort', 'reasoning_effort'],
    ['idleTimeoutMinutes', 'idle_timeout_minutes'],
  ]);
  if (Object.keys(claudePatch).length > 0) runtimePatch.claude = claudePatch;
  if (Object.keys(runtimePatch).length > 0) patch.runtime = runtimePatch;

  const bridgePatch = copyDefined<NonNullable<ConfigPatch['bridge']>>(bridge, [
    ['defaultWorkspace', 'default_workspace'],
    ['uiAllowLan', 'ui_allow_lan'],
    ['uiAccessToken', 'ui_access_token'],
  ]);
  if (Object.keys(bridgePatch).length > 0) patch.bridge = bridgePatch;

  if (Array.isArray(root.channels)) {
    patch.channels = root.channels.map((entry) => {
      const channel = asRecord(entry);
      const config = asRecord(channel.config);
      return {
        ...copyDefined(channel, [
          ['id', 'id'],
          ['alias', 'alias'],
          ['provider', 'provider'],
          ['enabled', 'enabled'],
        ]),
        config: copyDefined(config, [
          ['historyMessageLimit', 'history_message_limit'],
          ['streamStatusIdleStartSeconds', 'stream_status_idle_start_seconds'],
          ['streamStatusCheckIntervalSeconds', 'stream_status_check_interval_seconds'],
          ['appId', 'app_id'],
          ['appSecret', 'app_secret'],
          ['site', 'site'],
          ['allowedUsers', 'allowed_users'],
          ['streamingEnabled', 'streaming_enabled'],
          ['feedbackMarkdownEnabled', 'feedback_markdown_enabled'],
          ['requireMention', 'require_mention'],
          ['groupAuthorized', 'group_authorized'],
        ]),
      };
    }) as ConfigPatch['channels'];
  }

  return configPatchSchema.parse(patch);
}

export function configToTomlShape(config: ConfigPatch): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (config.schemaVersion !== undefined) out.schema_version = config.schemaVersion;
  if (config.session) {
    out.session = {
      ...(config.session.workspace !== undefined ? { workspace: config.session.workspace } : {}),
      ...(config.session.tmuxCaptureLines !== undefined ? { tmux_capture_lines: config.session.tmuxCaptureLines } : {}),
      ...(config.session.tmuxAutoEnter !== undefined ? { tmux_auto_enter: config.session.tmuxAutoEnter } : {}),
      ...(config.session.tmuxEchoInput !== undefined ? { tmux_echo_input: config.session.tmuxEchoInput } : {}),
    };
  }
  if (config.runtime) {
    out.runtime = {
      ...(config.runtime.agent !== undefined ? { agent: config.runtime.agent } : {}),
      ...(config.runtime.codex ? { codex: {
        ...(config.runtime.codex.model !== undefined ? { model: config.runtime.codex.model } : {}),
        ...(config.runtime.codex.yoloMode !== undefined ? { yolo_mode: config.runtime.codex.yoloMode } : {}),
        ...(config.runtime.codex.provider !== undefined ? { provider: config.runtime.codex.provider } : {}),
        ...(config.runtime.codex.skipGitRepoCheck !== undefined ? { skip_git_repo_check: config.runtime.codex.skipGitRepoCheck } : {}),
        ...(config.runtime.codex.sandboxMode !== undefined ? { sandbox_mode: config.runtime.codex.sandboxMode } : {}),
        ...(config.runtime.codex.networkAccess !== undefined ? { network_access: config.runtime.codex.networkAccess } : {}),
        ...(config.runtime.codex.reasoningEffort !== undefined ? { reasoning_effort: config.runtime.codex.reasoningEffort } : {}),
      } } : {}),
      ...(config.runtime.claude ? { claude: {
        ...(config.runtime.claude.model !== undefined ? { model: config.runtime.claude.model } : {}),
        ...(config.runtime.claude.yoloMode !== undefined ? { yolo_mode: config.runtime.claude.yoloMode } : {}),
        ...(config.runtime.claude.provider !== undefined ? { provider: config.runtime.claude.provider } : {}),
        ...(config.runtime.claude.executable !== undefined ? { executable: config.runtime.claude.executable } : {}),
        ...(config.runtime.claude.reasoningEffort !== undefined ? { reasoning_effort: config.runtime.claude.reasoningEffort } : {}),
        ...(config.runtime.claude.idleTimeoutMinutes !== undefined ? { idle_timeout_minutes: config.runtime.claude.idleTimeoutMinutes } : {}),
      } } : {}),
    };
  }
  if (config.bridge) {
    out.bridge = {
      ...(config.bridge.defaultWorkspace !== undefined ? { default_workspace: config.bridge.defaultWorkspace } : {}),
      ...(config.bridge.uiAllowLan !== undefined ? { ui_allow_lan: config.bridge.uiAllowLan } : {}),
      ...(config.bridge.uiAccessToken !== undefined ? { ui_access_token: config.bridge.uiAccessToken } : {}),
    };
  }
  if (config.channels) {
    out.channels = config.channels.map((channel) => ({
      ...(channel.id !== undefined ? { id: channel.id } : {}),
      ...(channel.alias !== undefined ? { alias: channel.alias } : {}),
      ...(channel.provider !== undefined ? { provider: channel.provider } : {}),
      ...(channel.enabled !== undefined ? { enabled: channel.enabled } : {}),
      ...(channel.config ? { config: {
        ...(channel.config.historyMessageLimit !== undefined ? { history_message_limit: channel.config.historyMessageLimit } : {}),
        ...(channel.config.streamStatusIdleStartSeconds !== undefined ? { stream_status_idle_start_seconds: channel.config.streamStatusIdleStartSeconds } : {}),
        ...(channel.config.streamStatusCheckIntervalSeconds !== undefined ? { stream_status_check_interval_seconds: channel.config.streamStatusCheckIntervalSeconds } : {}),
        ...(channel.config.appId !== undefined ? { app_id: channel.config.appId } : {}),
        ...(channel.config.appSecret !== undefined ? { app_secret: channel.config.appSecret } : {}),
        ...(channel.config.site !== undefined ? { site: channel.config.site } : {}),
        ...(channel.config.allowedUsers !== undefined ? { allowed_users: channel.config.allowedUsers } : {}),
        ...(channel.config.streamingEnabled !== undefined ? { streaming_enabled: channel.config.streamingEnabled } : {}),
        ...(channel.config.feedbackMarkdownEnabled !== undefined ? { feedback_markdown_enabled: channel.config.feedbackMarkdownEnabled } : {}),
        ...(channel.config.requireMention !== undefined ? { require_mention: channel.config.requireMention } : {}),
        ...(channel.config.groupAuthorized !== undefined ? { group_authorized: channel.config.groupAuthorized } : {}),
      } } : {}),
    }));
  }
  return out;
}
