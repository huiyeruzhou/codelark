import { parseClaudeReasoningEffort, parseSandboxMode } from '../../runtime/options.js';
import { createConfigService } from '../../configuration/service.js';
import type { ChannelConfigV2, ConfigPatch, ConfigV2 } from '../../configuration/schema.js';
import { normalizeReasoningEffort } from './aliases.js';
import { buildCommandCallbackData, buildThreadCardUpdateKey } from './callbacks.js';
import {
  buildCommandFields,
  formatReasoningEffort,
  minimalReasoningWebSearchWarning,
} from './presentation.js';
import type { OutboundRichCard } from '../../domain/index.js';
import type { ChannelAddress } from '../../domain/index.js';
import { configFields, type ConfigPath } from '../../configuration/fields.js';

export type SettingGroupKey = 'runtime' | 'runtime.codex' | 'runtime.claude' | 'runtime.kimi' | 'runtime.cursor' | 'bridge' | 'channels.feishu';
export type CurrentSessionConfigSection = 'common' | 'codex' | 'claude' | 'kimi' | 'cursor';
export const SESSION_CONFIG_INHERIT_VALUE = 'clk:config:inherit';
type SettingControl = 'select' | 'input';

interface SettingGroupDefinition {
  key: SettingGroupKey;
  title: string;
  subtitle: string;
  aliases?: string[];
}

interface SettingWriteOk {
  ok: true;
  patch: ConfigPatch;
}

export interface SettingDefinition {
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

const SETTING_DISPLAY_LABELS: Record<string, string> = {
  runtime: '默认 agent',
  defaultModel: '模型',
  defaultMode: 'YOLO模式',
  defaultProvider: 'Provider（运行方式）',
  codexSkipGitRepoCheck: '跳过 Git 仓库检查',
  codexSandboxMode: '文件系统权限',
  codexNetworkAccess: '网络访问',
  codexReasoningEffort: '思考级别',
  claudeDefaultModel: '模型',
  claudeMode: 'YOLO模式',
  claudeProvider: 'Provider（运行方式）',
  claudeExecutable: 'Claude Router',
  claudeReasoningEffort: '思考级别',
  claudeIdleTimeoutMinutes: '空闲超时（分钟）',
  kimiDefaultModel: '模型',
  kimiProvider: 'Provider（运行方式）',
  cursorDefaultModel: '模型',
  cursorProvider: 'Provider（运行方式）',
  cursorForce: 'YOLO模式',
  defaultWorkspaceRoot: '默认工作目录',
  tmuxCaptureLines: 'tmux 输出行数',
  tmuxEchoInput: '回显 tmux 输出',
  uiAllowLan: '允许局域网访问 UI',
  uiAccessToken: 'UI 访问令牌',
  historyMessageLimit: '历史消息条数',
  streamStatusIdleStartSeconds: '响应计时显示延迟秒数',
  streamStatusCheckIntervalSeconds: '流式状态检查间隔秒数',
  streamingEnabled: '启用流式反馈',
  feedbackMarkdownEnabled: '启用 Markdown 反馈',
  requireMention: '群聊需要 @bot',
  groupAuthorized: '群聊已授权',
};

const SETTING_FORM_NAMES: Record<string, string> = {
  runtime: 'rt',
  defaultWorkspaceRoot: 'ws_root',
  tmuxCaptureLines: 'tmux_lines',
  tmuxEchoInput: 'tmux_echo',
  defaultModel: 'cdx_model',
  defaultMode: 'cdx_mode',
  defaultProvider: 'cdx_provider',
  codexSkipGitRepoCheck: 'cdx_skip_git',
  codexSandboxMode: 'cdx_sandbox',
  codexNetworkAccess: 'cdx_network',
  codexReasoningEffort: 'cdx_rsn_eft',
  claudeDefaultModel: 'cld_model',
  claudeMode: 'cld_mode',
  claudeProvider: 'cld_provider',
  claudeExecutable: 'cld_exec',
  claudeReasoningEffort: 'cld_rsn_eft',
  claudeIdleTimeoutMinutes: 'cld_idle_min',
  kimiDefaultModel: 'kimi_model',
  kimiProvider: 'kimi_provider',
  cursorDefaultModel: 'cursor_model',
  cursorProvider: 'cursor_provider',
  cursorForce: 'cursor_force',
  uiAllowLan: 'ui_lan',
  uiAccessToken: 'ui_token',
  historyMessageLimit: 'hist_limit',
  streamStatusIdleStartSeconds: 'stream_idle_sec',
  streamStatusCheckIntervalSeconds: 'stream_check_sec',
  streamingEnabled: 'streaming',
  feedbackMarkdownEnabled: 'fb_md',
  requireMention: 'req_mention',
  groupAuthorized: 'grp_auth',
};

const SETTING_GROUPS: SettingGroupDefinition[] = [
  {
    key: 'runtime',
    title: '通用配置',
    subtitle: '默认 agent、工作目录和 session/tmux 默认值。',
    aliases: ['general', 'common', '[runtime]'],
  },
  {
    key: 'runtime.codex',
    title: 'Codex',
    subtitle: 'Codex runtime 的 TOML 默认值。',
    aliases: ['codex', '[runtime.codex]'],
  },
  {
    key: 'runtime.claude',
    title: 'Claude',
    subtitle: 'Claude Code runtime 的 TOML 默认值。',
    aliases: ['claude', '[runtime.claude]'],
  },
  {
    key: 'runtime.kimi',
    title: 'Kimi',
    subtitle: 'Kimi Code runtime 的 TOML 默认值。',
    aliases: ['kimi', '[runtime.kimi]'],
  },
  {
    key: 'runtime.cursor',
    title: 'Cursor',
    subtitle: 'Cursor Agent CLI runtime 的 TOML 默认值。',
    aliases: ['cursor', '[runtime.cursor]'],
  },
  {
    key: 'bridge',
    title: 'Bridge',
    subtitle: 'Bridge 自身行为和 UI 访问设置。',
    aliases: ['[bridge]'],
  },
  {
    key: 'channels.feishu',
    title: '通道配置（feishu-default）',
    subtitle: '默认 Feishu 通道配置，写入 home config.toml 的 channels 数组。',
    aliases: ['channels', 'feishu', 'feishu-default', '[[channels]]', '[[channels]] feishu-default'],
  },
];

const GROUP_BY_KEY = new Map(SETTING_GROUPS.map((group) => [group.key, group]));

function createHomeTomlConfigService() {
  return createConfigService({ migrate: false, env: {} });
}

function selectOption(text: string, value = text): { text: string; callbackData: string } {
  return { text, callbackData: value };
}

function formatClaudeReasoningEffort(value: string | null | undefined): string {
  return parseClaudeReasoningEffort(value || '') || 'medium';
}

function boolOptions(): Array<{ text: string; callbackData: string }> {
  return [selectOption('on'), selectOption('off')];
}

function parseBoolean(raw: string): boolean | null {
  const token = raw.trim().toLowerCase();
  if (['on', 'true', '1'].includes(token)) return true;
  if (['off', 'false', '0'].includes(token)) return false;
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
  return (rawValue: string): SettingWriteOk | { ok: false; message: string } => {
    const value = rawValue.trim();
    const normalized = value.toLowerCase();
    if (normalized === 'default') {
      return patch(buildPatch(options.defaultValue ?? ''));
    }
    if (normalized === 'reset' || normalized === 'unset' || normalized === 'none') {
      return { ok: false, message: '清空该配置只支持 default。' };
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
    usage: '/set runtime codex|claude|kimi|cursor',
    control: 'select',
    options: [selectOption('codex'), selectOption('claude'), selectOption('kimi'), selectOption('cursor')],
    read: (config) => config.runtime.agent,
    write(rawValue) {
      const token = rawValue.trim().toLowerCase();
      if (token === 'codex' || token === 'claude' || token === 'kimi' || token === 'cursor') return patch({ runtime: { agent: token } });
      return { ok: false, message: 'Runtime 必须是 codex、claude、kimi 或 cursor。' };
    },
  },
  {
    key: 'defaultWorkspaceRoot',
    tomlPath: 'bridge.default_workspace',
    group: 'runtime',
    aliases: ['workspace', 'workspaceRoot', 'root', 'newRoot'],
    label: 'default_workspace',
    usage: '/set defaultWorkspaceRoot /abs/path',
    control: 'input',
    placeholder: '例如 ~ 或 /data00/home/me',
    read: (config) => config.bridge.defaultWorkspace || '-',
    write: writeStringPatch((value) => ({ bridge: { defaultWorkspace: value } }), { defaultValue: '~' }),
  },
  {
    key: 'tmuxCaptureLines',
    tomlPath: 'session.tmux_capture_lines',
    group: 'runtime',
    aliases: ['tmuxLines', 'captureLines'],
    label: 'tmux_capture_lines',
    usage: '/set tmuxCaptureLines 80',
    control: 'input',
    placeholder: '1-500，影响 /tmux 默认截屏返回行数',
    read: (config) => `${config.session.tmuxCaptureLines}`,
    write: writePositiveIntPatch((value) => ({ session: { tmuxCaptureLines: value } }), 1, 500),
  },
  {
    key: 'tmuxEchoInput',
    tomlPath: 'session.tmux_echo_input',
    group: 'runtime',
    aliases: ['tmuxEcho', 'echoInput'],
    label: 'tmux_echo_input',
    usage: '/set tmuxEchoInput on|off',
    control: 'select',
    options: boolOptions(),
    read: (config) => formatBool(config.session.tmuxEchoInput),
    write: writeBooleanPatch((value) => ({ session: { tmuxEchoInput: value } })),
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
      if (token === 'normal') return patch({ runtime: { codex: { yoloMode: 'off' } } });
      if (token === 'yolo') return patch({ runtime: { codex: { yoloMode: 'on' } } });
      return { ok: false, message: 'YOLO 模式必须是 normal 或 yolo。' };
    },
  },
  {
    key: 'defaultProvider',
    tomlPath: 'runtime.codex.provider',
    group: 'runtime.codex',
    aliases: ['provider', 'codexProvider'],
    label: 'provider',
    usage: '/set defaultProvider sdk|pty|tmux|default',
    control: 'select',
    options: [selectOption('sdk'), selectOption('pty'), selectOption('tmux')],
    read: (config) => config.runtime.codex.provider || 'auto',
    write(rawValue) {
      const token = rawValue.trim().toLowerCase();
      if (token === 'default') return patch({ runtime: { codex: { provider: '' } } });
      if (token === 'sdk' || token === 'tmux' || token === 'pty') return patch({ runtime: { codex: { provider: token } } });
      return { ok: false, message: '默认 Codex Provider 运行方式必须是 sdk、pty 或 tmux，也可以用 default 恢复自动选择。' };
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
    options: [selectOption('workspace-write'), selectOption('read-only')],
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
    key: 'claudeMode',
    tomlPath: 'runtime.claude.yolo_mode',
    group: 'runtime.claude',
    aliases: ['claudeYoloMode', 'claudeMode'],
    label: 'yolo_mode',
    usage: '/set claudeMode normal|yolo',
    control: 'select',
    options: [selectOption('normal'), selectOption('yolo')],
    read: (config) => config.runtime.claude.yoloMode === 'on' || config.runtime.claude.yoloMode === 'yolo' ? 'yolo' : 'normal',
    write(rawValue) {
      const token = rawValue.trim().toLowerCase();
      if (token === 'normal') return patch({ runtime: { claude: { yoloMode: 'off' } } });
      if (token === 'yolo') return patch({ runtime: { claude: { yoloMode: 'on' } } });
      return { ok: false, message: 'Claude YOLO 模式必须是 normal 或 yolo。' };
    },
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
      if (token === 'tmux' || token === 'pty' || token === 'sdk') return patch({ runtime: { claude: { provider: token } } });
      return { ok: false, message: '默认 Claude Provider 运行方式必须是 tmux、pty 或 sdk。' };
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
      return { ok: false, message: 'Claude Router 必须是 claude（原生 Claude）或 ccr（CCR 环境）。' };
    },
  },
  {
    key: 'claudeReasoningEffort',
    tomlPath: 'runtime.claude.reasoning_effort',
    group: 'runtime.claude',
    aliases: ['claudeReasoning', 'claudeReasoningEffort'],
    label: 'reasoning_effort',
    usage: '/set claudeReasoningEffort low|medium|high|xhigh|max|m',
    control: 'select',
    options: [selectOption('medium'), selectOption('low'), selectOption('high'), selectOption('xhigh'), selectOption('max')],
    read: (config) => formatClaudeReasoningEffort(config.runtime.claude.reasoningEffort),
    write(rawValue) {
      const parsed = parseClaudeReasoningEffort(rawValue);
      if (!parsed) return { ok: false, message: 'Claude reasoning 必须是 low、medium、high、xhigh 或 max。' };
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
    placeholder: 'Claude Code 无活动多少分钟后自动停止；0 表示关闭',
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
    key: 'kimiDefaultModel',
    tomlPath: 'runtime.kimi.model',
    group: 'runtime.kimi',
    aliases: ['kimiModel'],
    label: 'model',
    usage: '/set kimiDefaultModel <model> 或 /set kimiDefaultModel default',
    control: 'input',
    placeholder: '留空则跟随 Kimi Code 默认',
    read: (config) => config.runtime.kimi.model || '-',
    write: writeStringPatch((value) => ({ runtime: { kimi: { model: value } } })),
  },
  {
    key: 'kimiProvider',
    tomlPath: 'runtime.kimi.provider',
    group: 'runtime.kimi',
    aliases: ['kimiDefaultProvider'],
    label: 'provider',
    usage: '/set kimiProvider tmux',
    control: 'select',
    options: [selectOption('tmux')],
    read: (config) => config.runtime.kimi.provider || 'tmux',
    write(rawValue) {
      const token = rawValue.trim().toLowerCase();
      if (token === 'tmux') return patch({ runtime: { kimi: { provider: 'tmux' } } });
      return { ok: false, message: 'Kimi Provider 当前只支持 tmux。' };
    },
  },
  {
    key: 'cursorDefaultModel',
    tomlPath: 'runtime.cursor.model',
    group: 'runtime.cursor',
    aliases: ['cursorModel'],
    label: 'model',
    usage: '/set cursorDefaultModel <model> 或 /set cursorDefaultModel default',
    control: 'input',
    placeholder: '留空则跟随 Cursor Agent 默认',
    read: (config) => config.runtime.cursor.model || '-',
    write: writeStringPatch((value) => ({ runtime: { cursor: { model: value } } })),
  },
  {
    key: 'cursorProvider',
    tomlPath: 'runtime.cursor.provider',
    group: 'runtime.cursor',
    aliases: ['cursorDefaultProvider'],
    label: 'provider',
    usage: '/set cursorProvider tmux',
    control: 'select',
    options: [selectOption('tmux')],
    read: (config) => config.runtime.cursor.provider || 'tmux',
    write(rawValue) {
      const token = rawValue.trim().toLowerCase();
      if (token === 'tmux') return patch({ runtime: { cursor: { provider: 'tmux' } } });
      return { ok: false, message: 'Cursor Provider 当前只支持 tmux。' };
    },
  },
  {
    key: 'cursorForce',
    tomlPath: 'runtime.cursor.force',
    group: 'runtime.cursor',
    aliases: ['cursorYolo', 'cursorMode'],
    label: 'force',
    usage: '/set cursorForce on|off',
    control: 'select',
    options: boolOptions(),
    read: (config) => formatBool(config.runtime.cursor.force),
    write: writeBooleanPatch((value) => ({ runtime: { cursor: { force: value } } })),
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
    usage: '/set streamStatusIdleStartSeconds 0',
    control: 'input',
    placeholder: '秒',
    read: (config) => `${defaultFeishuChannel(config)?.config.streamStatusIdleStartSeconds ?? '-'}`,
    write(rawValue, current) {
      const parsed = parseNonNegativeInt(rawValue);
      if (parsed === null) return { ok: false, message: '值必须是大于等于 0 的整数。' };
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
  return SETTING_GROUPS.find((group) => (
    group.key === token
    || group.title.toLowerCase() === token
    || (group.aliases || []).some((alias) => alias.toLowerCase() === token)
  ));
}

const CURRENT_RUNTIME_SETTING_KEYS: Record<'codex' | 'claude' | 'kimi' | 'cursor', string[]> = {
  codex: [
    'defaultModel',
    'defaultMode',
    'defaultProvider',
    'codexSandboxMode',
    'codexNetworkAccess',
    'codexReasoningEffort',
  ],
  claude: [
    'claudeDefaultModel',
    'claudeMode',
    'claudeProvider',
    'claudeReasoningEffort',
    'claudeIdleTimeoutMinutes',
  ],
  kimi: [
    'kimiDefaultModel',
    'kimiProvider',
  ],
  cursor: [
    'cursorDefaultModel',
    'cursorProvider',
    'cursorForce',
  ],
};

const SETTING_GROUP_ORDERS: Partial<Record<SettingGroupKey, string[]>> = {
  runtime: [
    'runtime',
    'defaultWorkspaceRoot',
    'tmuxCaptureLines',
    'tmuxEchoInput',
  ],
  'runtime.codex': [
    'defaultModel',
    'defaultMode',
    'defaultProvider',
    'codexSkipGitRepoCheck',
    'codexSandboxMode',
    'codexNetworkAccess',
    'codexReasoningEffort',
  ],
  'runtime.claude': [
    'claudeDefaultModel',
    'claudeMode',
    'claudeProvider',
    'claudeExecutable',
    'claudeReasoningEffort',
    'claudeIdleTimeoutMinutes',
  ],
  'runtime.kimi': [
    'kimiDefaultModel',
    'kimiProvider',
  ],
  'runtime.cursor': [
    'cursorDefaultModel',
    'cursorProvider',
    'cursorForce',
  ],
};

function groupDefinitions(groupKey: SettingGroupKey): SettingDefinition[] {
  const definitions = SETTING_DEFINITIONS.filter((definition) => definition.group === groupKey);
  const order = SETTING_GROUP_ORDERS[groupKey];
  if (!order) return definitions;
  const rank = new Map(order.map((key, index) => [key, index]));
  return [...definitions].sort((a, b) => (rank.get(a.key) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.key) ?? Number.MAX_SAFE_INTEGER));
}

export function runtimeSettingDefinitions(
  runtime: 'codex' | 'claude' | 'kimi' | 'cursor',
  options: { sessionWritableOnly?: boolean } = {},
): SettingDefinition[] {
  const definitions = groupDefinitions(runtime === 'cursor'
    ? 'runtime.cursor'
    : runtime === 'kimi'
    ? 'runtime.kimi'
    : runtime === 'claude' ? 'runtime.claude' : 'runtime.codex');
  if (!options.sessionWritableOnly) return definitions;
  const allowed = new Set(CURRENT_RUNTIME_SETTING_KEYS[runtime]);
  return definitions.filter((definition) => allowed.has(definition.key));
}

export function settingConfigPath(definition: Pick<SettingDefinition, 'tomlPath'>): ConfigPath {
  const field = configFields.find((entry) => entry.tomlPath === definition.tomlPath);
  if (!field) throw new Error(`配置项 ${definition.tomlPath} 缺少 canonical path。`);
  return field.path;
}

export function currentSessionSettingDefinitions(
  runtime: 'codex' | 'claude' | 'kimi' | 'cursor',
): SettingDefinition[] {
  return runtimeSettingDefinitions(runtime, { sessionWritableOnly: true });
}

export function currentSessionCommonSettingDefinitions(): SettingDefinition[] {
  return groupDefinitions('runtime').filter((definition) => definition.key === 'tmuxCaptureLines');
}

export function settingDisplayLabel(definition: Pick<SettingDefinition, 'key' | 'label'>): string {
  return SETTING_DISPLAY_LABELS[definition.key] || definition.label;
}

export function settingFormLabel(definition: Pick<SettingDefinition, 'key' | 'label' | 'tomlPath'>): string {
  return `${settingDisplayLabel(definition)} (${definition.tomlPath})`;
}

export function settingFormName(definition: Pick<SettingDefinition, 'key'>): string {
  return SETTING_FORM_NAMES[definition.key] || definition.key;
}

function settingPanelLabel(definition: Pick<SettingDefinition, 'key' | 'label'>): string {
  return settingDisplayLabel(definition);
}

export function findSettingDefinition(raw: string): SettingDefinition | undefined {
  return findSetting(raw);
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
  if (parsed.action === 'show-one') return findSetting(parsed.key)?.group || 'runtime';
  if (parsed.action === 'set') return findSetting(parsed.key)?.group || 'runtime';
  return 'runtime';
}

export function buildSettingsFields(config: ConfigV2, definitions: SettingDefinition[]): Array<[string, string]> {
  return definitions.map((definition) => [
    settingFormLabel(definition),
    definition.read(config),
  ]);
}

export function settingFormSelect(definition: SettingDefinition, config: ConfigV2): NonNullable<NonNullable<OutboundRichCard['form']>['selects']>[number] {
  const value = definition.read(config);
  return {
    elementId: definition.key,
    formName: settingFormName(definition),
    label: settingFormLabel(definition),
    placeholder: value,
    selectedCallbackData: value === 'auto' ? '' : value,
    options: definition.options || [],
  };
}

export function settingSessionFormSelect(
  definition: SettingDefinition,
  config: ConfigV2,
  overridden: boolean,
): NonNullable<NonNullable<OutboundRichCard['form']>['selects']>[number] {
  const value = definition.read(config);
  return {
    elementId: definition.key,
    formName: settingFormName(definition),
    label: settingFormLabel(definition),
    placeholder: overridden ? value : `跟随上层配置（当前：${value}）`,
    selectedCallbackData: overridden && value !== 'auto'
      ? value
      : SESSION_CONFIG_INHERIT_VALUE,
    options: [
      { text: '跟随上层配置', callbackData: SESSION_CONFIG_INHERIT_VALUE },
      ...(definition.options || []),
    ],
  };
}

function settingPanelSelect(definition: SettingDefinition, config: ConfigV2): NonNullable<NonNullable<OutboundRichCard['form']>['selects']>[number] {
  return {
    ...settingFormSelect(definition, config),
    label: settingPanelLabel(definition),
  };
}

export function settingFormInput(definition: SettingDefinition, config: ConfigV2): NonNullable<NonNullable<OutboundRichCard['form']>['extraInputs']>[number] {
  const value = definition.read(config);
  return {
    elementId: definition.key,
    formName: settingFormName(definition),
    label: settingFormLabel(definition),
    placeholder: definition.placeholder || definition.tomlPath,
    defaultValue: value === '-' ? '' : value,
  };
}

export function settingSessionFormInput(
  definition: SettingDefinition,
  config: ConfigV2,
  overridden: boolean,
): NonNullable<NonNullable<OutboundRichCard['form']>['extraInputs']>[number] {
  const value = definition.read(config);
  return {
    elementId: definition.key,
    formName: settingFormName(definition),
    label: settingFormLabel(definition),
    placeholder: overridden
      ? definition.placeholder || definition.tomlPath
      : `跟随上层配置（当前：${value}）`,
    defaultValue: overridden && value !== '-' ? value : '',
  };
}

function settingPanelInput(definition: SettingDefinition, config: ConfigV2): NonNullable<NonNullable<OutboundRichCard['form']>['extraInputs']>[number] {
  return {
    ...settingFormInput(definition, config),
    label: settingPanelLabel(definition),
  };
}

function buildGroupSelect(selectedGroup: SettingGroupKey): NonNullable<OutboundRichCard['selects']>[number] {
  return {
    id: 'set_group_select',
    placeholder: '配置分组',
    selectedCallbackData: buildCommandCallbackData(`/set --group ${selectedGroup}`),
    options: SETTING_GROUPS.map((group) => ({
      text: group.title,
      callbackData: buildCommandCallbackData(`/set --group ${group.key}`),
    })),
  };
}

export function buildSetCommandRichCard(
  selectedGroup: SettingGroupKey = 'runtime',
  address?: ChannelAddress,
): OutboundRichCard {
  const config = createHomeTomlConfigService().snapshot().config;
  const group = GROUP_BY_KEY.get(selectedGroup) || GROUP_BY_KEY.get('runtime')!;
  const definitions = groupDefinitions(group.key);
  return {
    title: '全局配置',
    subtitle: `写入 ~/.codelark/config.toml · ${group.title}`,
    template: 'blue',
    updateKey: address ? buildThreadCardUpdateKey('set', address.channelType, address.chatId) : undefined,
    updateTtlMs: address ? null : undefined,
    tags: ['home', 'toml'],
    tagColor: 'blue',
    selects: [buildGroupSelect(group.key)],
    sections: [],
    form: {
      optionElementId: 'clk_set_option',
      layout: 'two_column',
      selects: definitions.filter((definition) => definition.control === 'select').map((definition) => settingPanelSelect(definition, config)),
      extraInputs: definitions.filter((definition) => definition.control === 'input').map((definition) => settingPanelInput(definition, config)),
      controlBar: {
        actions: [
          { text: '刷新', callbackData: buildCommandCallbackData(`/set --group ${group.key}`) },
        ],
      },
      actionDividerBefore: true,
      submitText: '保存',
      submitCallbackData: buildCommandCallbackData(`/set --group ${group.key}`),
      options: [],
    },
    footer: [
      'YOLO模式：允许 agent 无需审批绕过沙箱。',
      'Provider：选择使用何种方式运行 agent，例如 tmux、pty 或 sdk。',
    ],
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

function formValueString(formValue: Record<string, unknown>, definition: SettingDefinition): string | undefined {
  for (const candidate of [settingFormName(definition), definition.key]) {
    const value = formValue[candidate];
    if (typeof value === 'string') return value.trim();
  }
  return undefined;
}

export function handleSetFormCommand(options: {
  args: string;
  formValue: Record<string, unknown>;
  markdown: boolean;
  address?: ChannelAddress;
}): { response: string; richCard: OutboundRichCard } {
  const service = createHomeTomlConfigService();
  const selectedGroup = selectedGroupFromArgs(options.args);
  let currentConfig = service.snapshot().config;
  const definitions = groupDefinitions(selectedGroup);
  const updated: SettingDefinition[] = [];

  for (const definition of definitions) {
    const rawValue = formValueString(options.formValue, definition);
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
        richCard: buildSetCommandRichCard(selectedGroup, options.address),
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
        richCard: buildSetCommandRichCard(selectedGroup, options.address),
      };
    }
  }

  const latest = service.snapshot().config;
  const notes = ['配置已保存到 `~/.codelark/config.toml`；卡片已刷新为最新配置分组。'];
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
    richCard: buildSetCommandRichCard(selectedGroup, options.address),
  };
}

export function handleSetCommand(options: {
  args: string;
  markdown: boolean;
}): string {
  const parsed = parseSetArgs(options.args);
  const service = createHomeTomlConfigService();
  const currentConfig = service.snapshot().config;

  if (parsed.action === 'show-all') {
    return buildCompactSettingsResponse(currentConfig, 'runtime', options.markdown);
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
