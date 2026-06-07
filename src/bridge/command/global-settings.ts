import { parseSandboxMode } from '../../runtime/options.js';
import { createConfigService } from '../../configuration/service.js';
import type { ChannelConfigV2, ConfigPatch, ConfigV2 } from '../../configuration/schema.js';
import { normalizeReasoningEffort } from './aliases.js';
import { buildCommandCallbackData } from './callbacks.js';
import {
  buildCommandFields,
  formatReasoningEffort,
  minimalReasoningWebSearchWarning,
} from './presentation.js';
import type { OutboundRichCard } from '../../domain/index.js';

type SettingGroupKey = 'runtime' | 'runtime.codex' | 'runtime.claude' | 'bridge' | 'channels.feishu';
type SettingControl = 'select' | 'input';

interface SettingGroupDefinition {
  key: SettingGroupKey;
  title: string;
  subtitle: string;
}

interface SettingWriteOk {
  ok: true;
  patch: ConfigPatch;
}

interface SettingDefinition {
  key: string;
  tomlPath: string;
  group: SettingGroupKey;
  aliases: string[];
  label: string;
  usage: string;
  control: SettingControl;
  placeholder?: string;
  options?: Array<{ text: string; callbackData: string }>;
  read(config: ConfigV2): string;
  write(rawValue: string, current: ConfigV2): SettingWriteOk | { ok: false; message: string };
}

const SETTING_GROUPS: SettingGroupDefinition[] = [
  {
    key: 'runtime',
    title: '[runtime]',
    subtitle: '全局默认 runtime。',
  },
  {
    key: 'runtime.codex',
    title: '[runtime.codex]',
    subtitle: 'Codex runtime 的 TOML 默认值。',
  },
  {
    key: 'runtime.claude',
    title: '[runtime.claude]',
    subtitle: 'Claude Code runtime 的 TOML 默认值。',
  },
  {
    key: 'bridge',
    title: '[bridge]',
    subtitle: 'Bridge 自身行为和 UI 访问设置。',
  },
  {
    key: 'channels.feishu',
    title: '[[channels]] feishu-default',
    subtitle: '默认 Feishu 通道配置，写入 home config.toml 的 channels 数组。',
  },
];

const GROUP_BY_KEY = new Map(SETTING_GROUPS.map((group) => [group.key, group]));

function selectOption(text: string, value = text): { text: string; callbackData: string } {
  return { text, callbackData: value };
}

function boolOptions(): Array<{ text: string; callbackData: string }> {
  return [selectOption('on'), selectOption('off')];
}

function parseBoolean(raw: string): boolean | null {
  const token = raw.trim().toLowerCase();
  if (['on', 'true', '1', 'yes', 'enable', 'enabled'].includes(token)) return true;
  if (['off', 'false', '0', 'no', 'disable', 'disabled'].includes(token)) return false;
  return null;
}

function parsePositiveInt(raw: string): number | null {
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || parsed < 1) return null;
  return Math.floor(parsed);
}

function parseNonNegativeInt(raw: string): number | null {
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed);
}

function formatBool(value: boolean): string {
  return value ? 'on' : 'off';
}

function maskToken(value: string): string {
  if (!value) return '-';
  if (value.length <= 6) return '******';
  return `${'*'.repeat(Math.max(6, value.length - 4))}${value.slice(-4)}`;
}

function defaultFeishuChannel(config: ConfigV2): ChannelConfigV2 {
  return config.channels.find((channel) => channel.id === 'feishu-default')
    || config.channels.find((channel) => channel.provider === 'feishu')
    || config.channels[0]!;
}

function channelId(config: ConfigV2): string {
  return defaultFeishuChannel(config)?.id || 'feishu-default';
}

function patch(patchValue: ConfigPatch): SettingWriteOk {
  return { ok: true, patch: patchValue };
}

function patchChannelConfig(current: ConfigV2, config: NonNullable<NonNullable<ConfigPatch['channels']>[number]['config']>): SettingWriteOk {
  return patch({ channels: [{ id: channelId(current), config }] });
}

function writeStringPatch(
  buildPatch: (value: string) => ConfigPatch,
  options: { defaultValue?: string } = {},
) {
  return (rawValue: string): SettingWriteOk => {
    const value = rawValue.trim();
    if (['default', 'reset', 'unset', 'none'].includes(value.toLowerCase())) {
      return patch(buildPatch(options.defaultValue ?? ''));
    }
    return patch(buildPatch(value));
  };
}

function writeBooleanPatch(buildPatch: (value: boolean) => ConfigPatch) {
  return (rawValue: string): SettingWriteOk | { ok: false; message: string } => {
    const parsed = parseBoolean(rawValue);
    if (parsed === null) return { ok: false, message: '值必须是 on/off、true/false 或 1/0。' };
    return patch(buildPatch(parsed));
  };
}

function writePositiveIntPatch(
  buildPatch: (value: number) => ConfigPatch,
  min: number,
  max?: number,
) {
  return (rawValue: string): SettingWriteOk | { ok: false; message: string } => {
    const parsed = parsePositiveInt(rawValue);
    if (parsed === null || parsed < min || (max !== undefined && parsed > max)) {
      return { ok: false, message: max === undefined ? `值必须是大于等于 ${min} 的整数。` : `值必须是 ${min}-${max} 的整数。` };
    }
    return patch(buildPatch(parsed));
  };
}

const SETTING_DEFINITIONS: SettingDefinition[] = [
  {
    key: 'runtime',
    tomlPath: 'runtime.agent',
    group: 'runtime',
    aliases: ['defaultRuntime', 'agent'],
    label: 'agent',
    usage: '/set runtime codex|claude',
    control: 'select',
    options: [selectOption('codex'), selectOption('claude')],
    read: (config) => config.runtime.agent,
    write(rawValue) {
      const token = rawValue.trim().toLowerCase();
      if (token === 'codex' || token === 'claude') return patch({ runtime: { agent: token } });
      return { ok: false, message: 'Runtime 必须是 codex 或 claude。' };
    },
  },
  {
    key: 'defaultModel',
    tomlPath: 'runtime.codex.model',
    group: 'runtime.codex',
    aliases: ['model', 'codexModel'],
    label: 'model',
    usage: '/set defaultModel gpt-5 或 /set defaultModel default',
    control: 'input',
    placeholder: '留空则跟随 Codex 默认',
    read: (config) => config.runtime.codex.model || '-',
    write: writeStringPatch((value) => ({ runtime: { codex: { model: value } } })),
  },
  {
    key: 'defaultMode',
    tomlPath: 'runtime.codex.yolo_mode',
    group: 'runtime.codex',
    aliases: ['mode', 'codexMode'],
    label: 'yolo_mode',
    usage: '/set defaultMode normal|yolo',
    control: 'select',
    options: [selectOption('normal'), selectOption('yolo')],
    read: (config) => config.runtime.codex.yoloMode === 'on' || config.runtime.codex.yoloMode === 'yolo' ? 'yolo' : 'normal',
    write(rawValue) {
      const token = rawValue.trim().toLowerCase();
      if (token === 'normal' || token === 'code' || token === 'off') return patch({ runtime: { codex: { yoloMode: 'off' } } });
      if (token === 'yolo' || token === 'on') return patch({ runtime: { codex: { yoloMode: 'on' } } });
      return { ok: false, message: '默认模式必须是 normal 或 yolo。' };
    },
  },
  {
    key: 'defaultProvider',
    tomlPath: 'runtime.codex.provider',
    group: 'runtime.codex',
    aliases: ['provider', 'codexProvider', 'defualtProvider'],
    label: 'provider',
    usage: '/set defaultProvider sdk|pty|tmux|default',
    control: 'select',
    options: [selectOption('auto', ''), selectOption('sdk'), selectOption('pty'), selectOption('tmux')],
    read: (config) => config.runtime.codex.provider || 'auto',
    write(rawValue) {
      const token = rawValue.trim().toLowerCase();
      if (['default', 'reset', 'unset', 'none', 'auto'].includes(token)) return patch({ runtime: { codex: { provider: '' } } });
      if (token === 'sdk' || token === 'tmux' || token === 'pty') return patch({ runtime: { codex: { provider: token } } });
      return { ok: false, message: '默认 Codex Provider 必须是 sdk、pty 或 tmux，也可以用 default/auto 恢复自动选择。' };
    },
  },
  {
    key: 'codexSkipGitRepoCheck',
    tomlPath: 'runtime.codex.skip_git_repo_check',
    group: 'runtime.codex',
    aliases: ['skipGitRepoCheck', 'skipGitCheck'],
    label: 'skip_git_repo_check',
    usage: '/set codexSkipGitRepoCheck on|off',
    control: 'select',
    options: boolOptions(),
    read: (config) => formatBool(config.runtime.codex.skipGitRepoCheck),
    write: writeBooleanPatch((value) => ({ runtime: { codex: { skipGitRepoCheck: value } } })),
  },
  {
    key: 'codexSandboxMode',
    tomlPath: 'runtime.codex.sandbox_mode',
    group: 'runtime.codex',
    aliases: ['sandbox', 'sandboxMode'],
    label: 'sandbox_mode',
    usage: '/set codexSandboxMode read-only|workspace-write|danger-full-access',
    control: 'select',
    options: [selectOption('workspace-write'), selectOption('read-only'), selectOption('danger-full-access')],
    read: (config) => config.runtime.codex.sandboxMode,
    write(rawValue) {
      const parsed = parseSandboxMode(rawValue.trim());
      if (!parsed) return { ok: false, message: 'sandbox 必须是 read-only、workspace-write 或 danger-full-access。' };
      return patch({ runtime: { codex: { sandboxMode: parsed } } });
    },
  },
  {
    key: 'codexNetworkAccess',
    tomlPath: 'runtime.codex.network_access',
    group: 'runtime.codex',
    aliases: ['network', 'networkAccess', 'net'],
    label: 'network_access',
    usage: '/set codexNetworkAccess on|off',
    control: 'select',
    options: boolOptions(),
    read: (config) => formatBool(config.runtime.codex.networkAccess),
    write: writeBooleanPatch((value) => ({ runtime: { codex: { networkAccess: value } } })),
  },
  {
    key: 'codexReasoningEffort',
    tomlPath: 'runtime.codex.reasoning_effort',
    group: 'runtime.codex',
    aliases: ['reasoning', 'reasoningEffort'],
    label: 'reasoning_effort',
    usage: '/set codexReasoningEffort minimal|low|medium|high|xhigh',
    control: 'select',
    options: [selectOption('medium'), selectOption('minimal'), selectOption('low'), selectOption('high'), selectOption('xhigh')],
    read: (config) => formatReasoningEffort(config.runtime.codex.reasoningEffort),
    write(rawValue) {
      const parsed = normalizeReasoningEffort(rawValue);
      if (!parsed) return { ok: false, message: 'reasoning 必须是 minimal、low、medium、high、xhigh 或 1-5。' };
      return patch({ runtime: { codex: { reasoningEffort: parsed } } });
    },
  },
  {
    key: 'claudeDefaultModel',
    tomlPath: 'runtime.claude.model',
    group: 'runtime.claude',
    aliases: ['claudeModel'],
    label: 'model',
    usage: '/set claudeDefaultModel sonnet 或 /set claudeDefaultModel default',
    control: 'input',
    placeholder: '留空则跟随 Claude Code 默认',
    read: (config) => config.runtime.claude.model || '-',
    write: writeStringPatch((value) => ({ runtime: { claude: { model: value } } })),
  },
  {
    key: 'claudeProvider',
    tomlPath: 'runtime.claude.provider',
    group: 'runtime.claude',
    aliases: ['claudeDefaultProvider'],
    label: 'provider',
    usage: '/set claudeProvider tmux|pty|sdk',
    control: 'select',
    options: [selectOption('tmux'), selectOption('pty'), selectOption('sdk')],
    read: (config) => config.runtime.claude.provider || 'tmux',
    write(rawValue) {
      const token = rawValue.trim().toLowerCase();
      if (['default', 'reset', 'unset', 'none', 'auto'].includes(token)) return patch({ runtime: { claude: { provider: 'tmux' } } });
      if (token === 'tmux' || token === 'pty' || token === 'sdk') return patch({ runtime: { claude: { provider: token } } });
      return { ok: false, message: '默认 Claude Provider 必须是 tmux、pty 或 sdk，也可以用 default/auto 恢复默认。' };
    },
  },
  {
    key: 'claudeExecutable',
    tomlPath: 'runtime.claude.executable',
    group: 'runtime.claude',
    aliases: ['claudeExec'],
    label: 'executable',
    usage: '/set claudeExecutable claude|ccr',
    control: 'select',
    options: [selectOption('claude'), selectOption('ccr')],
    read: (config) => config.runtime.claude.executable || 'claude',
    write(rawValue) {
      const token = rawValue.trim().toLowerCase();
      if (token === 'claude' || token === 'ccr') return patch({ runtime: { claude: { executable: token } } });
      return { ok: false, message: 'Claude executable 必须是 claude 或 ccr。' };
    },
  },
  {
    key: 'claudePermissionMode',
    tomlPath: 'runtime.claude.permission_mode',
    group: 'runtime.claude',
    aliases: ['claudePermission'],
    label: 'permission_mode',
    usage: '/set claudePermissionMode default|acceptEdits|bypassPermissions|plan',
    control: 'select',
    options: [selectOption('default'), selectOption('acceptEdits'), selectOption('bypassPermissions'), selectOption('plan')],
    read: (config) => config.runtime.claude.permissionMode || 'default',
    write(rawValue) {
      const token = rawValue.trim();
      if (token === 'default' || token === 'acceptEdits' || token === 'bypassPermissions' || token === 'plan') {
        return patch({ runtime: { claude: { permissionMode: token } } });
      }
      return { ok: false, message: 'Claude 权限模式必须是 default、acceptEdits、bypassPermissions 或 plan。' };
    },
  },
  {
    key: 'claudeReasoningEffort',
    tomlPath: 'runtime.claude.reasoning_effort',
    group: 'runtime.claude',
    aliases: ['claudeReasoning', 'claudeReasoningEffort'],
    label: 'reasoning_effort',
    usage: '/set claudeReasoningEffort minimal|low|medium|high|xhigh',
    control: 'select',
    options: [selectOption('medium'), selectOption('minimal'), selectOption('low'), selectOption('high'), selectOption('xhigh')],
    read: (config) => formatReasoningEffort(config.runtime.claude.reasoningEffort),
    write(rawValue) {
      const parsed = normalizeReasoningEffort(rawValue);
      if (!parsed) return { ok: false, message: 'reasoning 必须是 minimal、low、medium、high、xhigh 或 1-5。' };
      return patch({ runtime: { claude: { reasoningEffort: parsed } } });
    },
  },
  {
    key: 'claudeIdleTimeoutMinutes',
    tomlPath: 'runtime.claude.idle_timeout_minutes',
    group: 'runtime.claude',
    aliases: ['claudeTimeout', 'claudeIdleTimeout'],
    label: 'idle_timeout_minutes',
    usage: '/set claudeIdleTimeoutMinutes 15',
    control: 'input',
    placeholder: '分钟，0 表示关闭',
    read: (config) => `${config.runtime.claude.idleTimeoutMinutes ?? 0}`,
    write(rawValue) {
      const token = rawValue.trim();
      if (token === 'off') return patch({ runtime: { claude: { idleTimeoutMinutes: 0 } } });
      const parsed = parseNonNegativeInt(rawValue);
      if (parsed === null || parsed > 120) return { ok: false, message: 'Claude 空闲超时必须是 0-120 的整数分钟；0/off 表示关闭。' };
      return patch({ runtime: { claude: { idleTimeoutMinutes: parsed } } });
    },
  },
  {
    key: 'defaultWorkspaceRoot',
    tomlPath: 'bridge.default_workspace',
    group: 'bridge',
    aliases: ['workspace', 'workspaceRoot', 'root', 'newRoot'],
    label: 'default_workspace',
    usage: '/set defaultWorkspaceRoot /abs/path',
    control: 'input',
    placeholder: '例如 ~ 或 /data00/home/me',
    read: (config) => config.bridge.defaultWorkspace || '-',
    write: writeStringPatch((value) => ({ bridge: { defaultWorkspace: value } }), { defaultValue: '~' }),
  },
  {
    key: 'uiAllowLan',
    tomlPath: 'bridge.ui_allow_lan',
    group: 'bridge',
    aliases: ['allowLan', 'uiLan'],
    label: 'ui_allow_lan',
    usage: '/set uiAllowLan on|off',
    control: 'select',
    options: boolOptions(),
    read: (config) => formatBool(config.bridge.uiAllowLan),
    write: writeBooleanPatch((value) => ({ bridge: { uiAllowLan: value } })),
  },
  {
    key: 'uiAccessToken',
    tomlPath: 'bridge.ui_access_token',
    group: 'bridge',
    aliases: ['accessToken', 'uiToken'],
    label: 'ui_access_token',
    usage: '/set uiAccessToken <token>',
    control: 'input',
    placeholder: '开启 LAN 后可留空自动生成',
    read: (config) => maskToken(config.bridge.uiAccessToken || ''),
    write: writeStringPatch((value) => ({ bridge: { uiAccessToken: value } })),
  },
  {
    key: 'historyMessageLimit',
    tomlPath: 'channels[].config.history_message_limit',
    group: 'channels.feishu',
    aliases: ['history', 'hisLimit'],
    label: 'history_message_limit',
    usage: '/set historyMessageLimit 8',
    control: 'input',
    placeholder: '1-20',
    read: (config) => `${defaultFeishuChannel(config)?.config.historyMessageLimit ?? '-'}`,
    write(rawValue, current) {
      const parsed = parsePositiveInt(rawValue);
      if (parsed === null || parsed > 20) return { ok: false, message: '值必须是 1-20 的整数。' };
      return patchChannelConfig(current, { historyMessageLimit: parsed });
    },
  },
  {
    key: 'streamStatusIdleStartSeconds',
    tomlPath: 'channels[].config.stream_status_idle_start_seconds',
    group: 'channels.feishu',
    aliases: ['streamIdle', 'idleStart'],
    label: 'stream_status_idle_start_seconds',
    usage: '/set streamStatusIdleStartSeconds 180',
    control: 'input',
    placeholder: '秒',
    read: (config) => `${defaultFeishuChannel(config)?.config.streamStatusIdleStartSeconds ?? '-'}`,
    write(rawValue, current) {
      const parsed = parsePositiveInt(rawValue);
      if (parsed === null) return { ok: false, message: '值必须是大于等于 1 的整数。' };
      return patchChannelConfig(current, { streamStatusIdleStartSeconds: parsed });
    },
  },
  {
    key: 'streamStatusCheckIntervalSeconds',
    tomlPath: 'channels[].config.stream_status_check_interval_seconds',
    group: 'channels.feishu',
    aliases: ['streamCheck', 'statusInterval'],
    label: 'stream_status_check_interval_seconds',
    usage: '/set streamStatusCheckIntervalSeconds 10',
    control: 'input',
    placeholder: '秒',
    read: (config) => `${defaultFeishuChannel(config)?.config.streamStatusCheckIntervalSeconds ?? '-'}`,
    write(rawValue, current) {
      const parsed = parsePositiveInt(rawValue);
      if (parsed === null) return { ok: false, message: '值必须是大于等于 1 的整数。' };
      return patchChannelConfig(current, { streamStatusCheckIntervalSeconds: parsed });
    },
  },
  {
    key: 'streamingEnabled',
    tomlPath: 'channels[].config.streaming_enabled',
    group: 'channels.feishu',
    aliases: ['streaming'],
    label: 'streaming_enabled',
    usage: '/set streamingEnabled on|off',
    control: 'select',
    options: boolOptions(),
    read: (config) => formatBool(defaultFeishuChannel(config)?.config.streamingEnabled ?? true),
    write(rawValue, current) {
      const parsed = parseBoolean(rawValue);
      if (parsed === null) return { ok: false, message: '值必须是 on/off、true/false 或 1/0。' };
      return patchChannelConfig(current, { streamingEnabled: parsed });
    },
  },
  {
    key: 'feedbackMarkdownEnabled',
    tomlPath: 'channels[].config.feedback_markdown_enabled',
    group: 'channels.feishu',
    aliases: ['markdown', 'commandMarkdown'],
    label: 'feedback_markdown_enabled',
    usage: '/set feedbackMarkdownEnabled on|off',
    control: 'select',
    options: boolOptions(),
    read: (config) => formatBool(defaultFeishuChannel(config)?.config.feedbackMarkdownEnabled ?? true),
    write(rawValue, current) {
      const parsed = parseBoolean(rawValue);
      if (parsed === null) return { ok: false, message: '值必须是 on/off、true/false 或 1/0。' };
      return patchChannelConfig(current, { feedbackMarkdownEnabled: parsed });
    },
  },
  {
    key: 'requireMention',
    tomlPath: 'channels[].config.require_mention',
    group: 'channels.feishu',
    aliases: ['requireAt', 'mention'],
    label: 'require_mention',
    usage: '/set requireMention on|off',
    control: 'select',
    options: boolOptions(),
    read: (config) => formatBool(defaultFeishuChannel(config)?.config.requireMention ?? false),
    write(rawValue, current) {
      const parsed = parseBoolean(rawValue);
      if (parsed === null) return { ok: false, message: '值必须是 on/off、true/false 或 1/0。' };
      return patchChannelConfig(current, { requireMention: parsed });
    },
  },
  {
    key: 'groupAuthorized',
    tomlPath: 'channels[].config.group_authorized',
    group: 'channels.feishu',
    aliases: ['authorized'],
    label: 'group_authorized',
    usage: '/set groupAuthorized on|off',
    control: 'select',
    options: boolOptions(),
    read: (config) => formatBool(defaultFeishuChannel(config)?.config.groupAuthorized ?? false),
    write(rawValue, current) {
      const parsed = parseBoolean(rawValue);
      if (parsed === null) return { ok: false, message: '值必须是 on/off、true/false 或 1/0。' };
      return patchChannelConfig(current, { groupAuthorized: parsed });
    },
  },
];

const SETTING_BY_NAME = new Map<string, SettingDefinition>();
for (const definition of SETTING_DEFINITIONS) {
  SETTING_BY_NAME.set(definition.key.toLowerCase(), definition);
  SETTING_BY_NAME.set(definition.tomlPath.toLowerCase(), definition);
  for (const alias of definition.aliases) {
    SETTING_BY_NAME.set(alias.toLowerCase(), definition);
  }
}

function findSetting(raw: string): SettingDefinition | undefined {
  return SETTING_BY_NAME.get(raw.trim().toLowerCase());
}

function findGroup(raw: string): SettingGroupDefinition | undefined {
  const token = raw.trim().toLowerCase();
  return SETTING_GROUPS.find((group) => group.key === token || group.title.toLowerCase() === token);
}

function groupDefinitions(groupKey: SettingGroupKey): SettingDefinition[] {
  return SETTING_DEFINITIONS.filter((definition) => definition.group === groupKey);
}

type ParsedSetArgs =
  | { action: 'show-all' }
  | { action: 'show-group'; group: SettingGroupKey }
  | { action: 'show-one'; key: string }
  | { action: 'set'; key: string; value: string };

function parseSetArgs(raw: string): ParsedSetArgs {
  const trimmed = raw.trim();
  if (!trimmed) return { action: 'show-all' };

  const groupMatch = trimmed.match(/^--group(?:=|\s+)(\S+)$/);
  if (groupMatch) {
    const group = findGroup(groupMatch[1]);
    return group ? { action: 'show-group', group: group.key } : { action: 'show-one', key: groupMatch[1] };
  }

  const eqIndex = trimmed.indexOf('=');
  if (eqIndex > 0 && !trimmed.startsWith('--group=')) {
    return {
      action: 'set',
      key: trimmed.slice(0, eqIndex).trim(),
      value: trimmed.slice(eqIndex + 1).trim(),
    };
  }

  const match = trimmed.match(/^(\S+)(?:\s+([\s\S]+))?$/);
  if (!match) return { action: 'show-all' };
  const key = match[1];
  const value = match[2]?.trim();
  if (value) return { action: 'set', key, value };
  const group = findGroup(key);
  return group && !findSetting(key) ? { action: 'show-group', group: group.key } : { action: 'show-one', key };
}

function selectedGroupFromArgs(raw: string): SettingGroupKey {
  const parsed = parseSetArgs(raw);
  if (parsed.action === 'show-group') return parsed.group;
  if (parsed.action === 'show-one') return findSetting(parsed.key)?.group || 'runtime.codex';
  if (parsed.action === 'set') return findSetting(parsed.key)?.group || 'runtime.codex';
  return 'runtime.codex';
}

function buildSettingsFields(config: ConfigV2, definitions: SettingDefinition[]): Array<[string, string]> {
  return definitions.map((definition) => [
    `${definition.label} (${definition.tomlPath})`,
    definition.read(config),
  ]);
}

function formSelect(definition: SettingDefinition, config: ConfigV2): NonNullable<NonNullable<OutboundRichCard['form']>['selects']>[number] {
  const value = definition.read(config);
  return {
    elementId: definition.key,
    label: definition.label,
    placeholder: value,
    selectedCallbackData: value === 'auto' ? '' : value,
    options: definition.options || [],
  };
}

function formInput(definition: SettingDefinition, config: ConfigV2): NonNullable<NonNullable<OutboundRichCard['form']>['extraInputs']>[number] {
  const value = definition.read(config);
  return {
    elementId: definition.key,
    label: definition.label,
    placeholder: definition.placeholder || definition.tomlPath,
    defaultValue: value === '-' ? '' : value,
  };
}

function buildGroupSelect(selectedGroup: SettingGroupKey): NonNullable<OutboundRichCard['selects']>[number] {
  return {
    id: 'set_group_select',
    placeholder: 'TOML section',
    selectedCallbackData: buildCommandCallbackData(`/set --group ${selectedGroup}`),
    options: SETTING_GROUPS.map((group) => ({
      text: group.title,
      callbackData: buildCommandCallbackData(`/set --group ${group.key}`),
    })),
  };
}

export function buildSetCommandRichCard(selectedGroup: SettingGroupKey = 'runtime.codex'): OutboundRichCard {
  const config = createConfigService({ migrate: false }).snapshot().config;
  const group = GROUP_BY_KEY.get(selectedGroup) || GROUP_BY_KEY.get('runtime.codex')!;
  const definitions = groupDefinitions(group.key);
  return {
    title: '全局配置',
    subtitle: `写入 ~/.codelark/config.toml · ${group.title}`,
    template: 'blue',
    tags: ['home', 'toml'],
    tagColor: 'blue',
    selects: [buildGroupSelect(group.key)],
    sections: [],
    form: {
      optionElementId: 'clk_set_option',
      layout: 'two_column',
      selects: definitions.filter((definition) => definition.control === 'select').map((definition) => formSelect(definition, config)),
      extraInputs: definitions.filter((definition) => definition.control === 'input').map((definition) => formInput(definition, config)),
      controlBar: {
        actions: [
          { text: '刷新', callbackData: buildCommandCallbackData(`/set --group ${group.key}`) },
        ],
      },
      submitText: '保存',
      submitCallbackData: buildCommandCallbackData(`/set --group ${group.key}`),
      options: [],
    },
  };
}

function buildCompactSettingsResponse(config: ConfigV2, groupKey: SettingGroupKey, markdown: boolean): string {
  const group = GROUP_BY_KEY.get(groupKey)!;
  return buildCommandFields(
    `全局配置：${group.title}`,
    buildSettingsFields(config, groupDefinitions(group.key)),
    [],
    markdown,
  );
}

function buildUsageNotes(): string[] {
  return [
    '发送 `/set` 打开 TOML 配置卡片；卡片顶部下拉切换 section。',
    '发送 `/set <key> <value>` 或 `/set <toml.path> <value>` 修改单项配置。',
  ];
}

function formatConfigWriteError(error: unknown): string {
  const issues = error && typeof error === 'object' && Array.isArray((error as { issues?: unknown[] }).issues)
    ? (error as { issues: Array<{ path?: unknown[]; message?: string }> }).issues
    : [];
  if (issues.length > 0) {
    return issues
      .map((issue) => {
        const path = Array.isArray(issue.path) && issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
        return `${path}${issue.message || '配置字段不合法。'}`;
      })
      .join('\n');
  }
  return error instanceof Error ? error.message : '配置字段不合法。';
}

function formValueString(formValue: Record<string, unknown>, key: string): string | undefined {
  const value = formValue[key];
  return typeof value === 'string' ? value.trim() : undefined;
}

export function handleSetFormCommand(options: {
  args: string;
  formValue: Record<string, unknown>;
  markdown: boolean;
}): { response: string; richCard: OutboundRichCard } {
  const service = createConfigService({ migrate: false });
  const selectedGroup = selectedGroupFromArgs(options.args);
  let currentConfig = service.snapshot().config;
  const definitions = groupDefinitions(selectedGroup);
  const updated: SettingDefinition[] = [];

  for (const definition of definitions) {
    const rawValue = formValueString(options.formValue, definition.key);
    if (rawValue === undefined) continue;
    const currentValue = definition.read(currentConfig);
    const normalizedCurrent = currentValue === 'auto' ? '' : currentValue;
    if (rawValue === normalizedCurrent) continue;
    const written = definition.write(rawValue, currentConfig);
    if (!written.ok) {
      return {
        response: buildCommandFields(
          '配置未更新',
          [
            ['TOML path', definition.tomlPath],
            ['输入值', rawValue],
          ],
          [written.message, `用法：\`${definition.usage}\``],
          options.markdown,
        ),
        richCard: buildSetCommandRichCard(selectedGroup),
      };
    }
    try {
      service.set({ kind: 'home' }, written.patch);
      currentConfig = service.snapshot().config;
      updated.push(definition);
    } catch (error) {
      return {
        response: buildCommandFields(
          '配置未更新',
          [['TOML path', definition.tomlPath]],
          [formatConfigWriteError(error), '请刷新 `/set` 卡片后重试。'],
          options.markdown,
        ),
        richCard: buildSetCommandRichCard(selectedGroup),
      };
    }
  }

  const latest = service.snapshot().config;
  const notes = ['配置已保存到 `~/.codelark/config.toml`；卡片已刷新为最新 TOML section。'];
  const codexReasoning = updated.find((definition) => definition.key === 'codexReasoningEffort');
  if (codexReasoning) {
    const warning = minimalReasoningWebSearchWarning(latest.runtime.codex.reasoningEffort);
    if (warning) notes.push(warning);
  }
  return {
    response: buildCommandFields(
      updated.length > 0 ? '已保存全局配置' : '全局配置未变化',
      updated.length > 0 ? buildSettingsFields(latest, updated) : [],
      notes,
      options.markdown,
    ),
    richCard: buildSetCommandRichCard(selectedGroup),
  };
}

export function handleSetCommand(options: {
  args: string;
  markdown: boolean;
}): string {
  const parsed = parseSetArgs(options.args);
  const service = createConfigService({ migrate: false });
  const currentConfig = service.snapshot().config;

  if (parsed.action === 'show-all') {
    return buildCompactSettingsResponse(currentConfig, 'runtime.codex', options.markdown);
  }

  if (parsed.action === 'show-group') {
    return buildCompactSettingsResponse(currentConfig, parsed.group, options.markdown);
  }

  const definition = findSetting(parsed.key);
  if (!definition) {
    return buildCommandFields(
      '未知配置项',
      [['配置项', parsed.key]],
      buildUsageNotes(),
      options.markdown,
    );
  }

  if (parsed.action === 'show-one') {
    return buildCommandFields(
      `全局配置：${GROUP_BY_KEY.get(definition.group)?.title || definition.group}`,
      buildSettingsFields(currentConfig, [definition]),
      [`用法：\`${definition.usage}\``],
      options.markdown,
    );
  }

  const written = definition.write(parsed.value, currentConfig);
  if (!written.ok) {
    return buildCommandFields(
      '配置未更新',
      [
        ['TOML path', definition.tomlPath],
        ['输入值', parsed.value],
      ],
      [written.message, `用法：\`${definition.usage}\``],
      options.markdown,
    );
  }

  try {
    service.set({ kind: 'home' }, written.patch);
  } catch (error) {
    return buildCommandFields(
      '配置未更新',
      [
        ['TOML path', definition.tomlPath],
        ['输入值', parsed.value],
      ],
      [formatConfigWriteError(error), `用法：\`${definition.usage}\``],
      options.markdown,
    );
  }

  const savedConfig = service.snapshot().config;
  const notes = ['配置已保存到 `~/.codelark/config.toml`；后续请求会读取新的 TOML 默认值。'];
  if (definition.key === 'codexReasoningEffort') {
    const warning = minimalReasoningWebSearchWarning(savedConfig.runtime.codex.reasoningEffort);
    if (warning) notes.push(warning);
  }
  return buildCommandFields(
    '已更新全局配置',
    buildSettingsFields(savedConfig, [definition]),
    notes,
    options.markdown,
  );
}

export function setCommandSelectedGroup(args: string): SettingGroupKey {
  return selectedGroupFromArgs(args);
}
