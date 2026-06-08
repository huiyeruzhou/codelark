import {
  loadConfig,
  saveConfig,
} from '../../configuration/index.js';
import { parseSandboxMode } from '../../configuration/runtime-options.js';
import {
  configToPayload,
  mergeConfig,
} from '../../operator-ui/application/config.js';
import { normalizeReasoningEffort } from './aliases.js';
import {
  buildCommandFields,
  formatReasoningEffort,
  minimalReasoningWebSearchWarning,
} from './presentation.js';

type ConfigPayload = ReturnType<typeof configToPayload>;

type SettingGroupKey = 'global-runtime-codex' | 'global-runtime-claude' | 'bridge-control' | 'global-bridge';

interface SettingGroupDefinition {
  key: SettingGroupKey;
  title: string;
  description: string;
}

interface SettingDefinition {
  key: string;
  group: SettingGroupKey;
  aliases: string[];
  label: string;
  usage: string;
  read(payload: ConfigPayload): string;
  write(payload: Record<string, unknown>, rawValue: string): { ok: true } | { ok: false; message: string };
}

const SETTING_GROUPS: SettingGroupDefinition[] = [
  {
    key: 'global-runtime-codex',
    title: 'GlobalRuntime / Codex',
    description: 'Codex 模型执行默认值，只 fallback 到 Codex runtime。',
  },
  {
    key: 'global-runtime-claude',
    title: 'GlobalRuntime / Claude',
    description: 'Claude Code 默认值，只 fallback 到 Claude runtime。',
  },
  {
    key: 'bridge-control',
    title: 'Bridge 控制',
    description: 'Bridge 如何驱动 runtime 或创建会话；不是模型执行参数。',
  },
  {
    key: 'global-bridge',
    title: 'GlobalBridge',
    description: 'Bridge 自身的工作区、历史、反馈展示和 UI 服务配置。',
  },
];

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

function maskToken(value: string): string {
  if (!value) return '-';
  if (value.length <= 6) return '******';
  return `${'*'.repeat(Math.max(6, value.length - 4))}${value.slice(-4)}`;
}

function formatBool(value: boolean): string {
  return value ? 'on' : 'off';
}

function writeString(field: string, options: { allowDefault?: boolean } = {}) {
  return (payload: Record<string, unknown>, rawValue: string): { ok: true } => {
    const value = rawValue.trim();
    payload[field] = options.allowDefault && ['default', 'reset', 'unset', 'none'].includes(value.toLowerCase())
      ? ''
      : value;
    return { ok: true };
  };
}

function writeBoolean(field: string) {
  return (payload: Record<string, unknown>, rawValue: string): { ok: true } | { ok: false; message: string } => {
    const parsed = parseBoolean(rawValue);
    if (parsed === null) return { ok: false, message: '值必须是 on/off、true/false 或 1/0。' };
    payload[field] = parsed;
    return { ok: true };
  };
}

function writePositiveInt(field: string, min: number, max?: number) {
  return (payload: Record<string, unknown>, rawValue: string): { ok: true } | { ok: false; message: string } => {
    const parsed = parsePositiveInt(rawValue);
    if (parsed === null || parsed < min || (max !== undefined && parsed > max)) {
      return { ok: false, message: max === undefined ? `值必须是大于等于 ${min} 的整数。` : `值必须是 ${min}-${max} 的整数。` };
    }
    payload[field] = parsed;
    return { ok: true };
  };
}

const SETTING_DEFINITIONS: SettingDefinition[] = [
  {
    key: 'defaultWorkspaceRoot',
    group: 'global-bridge',
    aliases: ['workspace', 'workspaceRoot', 'root', 'newRoot'],
    label: '/new 相对路径根目录',
    usage: '/set defaultWorkspaceRoot /abs/path',
    read: (payload) => payload.defaultWorkspaceRoot || '-',
    write: writeString('defaultWorkspaceRoot', { allowDefault: true }),
  },
  {
    key: 'defaultModel',
    group: 'global-runtime-codex',
    aliases: ['model'],
    label: 'Codex 默认模型',
    usage: '/set defaultModel gpt-5 或 /set defaultModel default',
    read: (payload) => payload.defaultModel || '-',
    write: writeString('defaultModel', { allowDefault: true }),
  },
  {
    key: 'defaultProvider',
    group: 'bridge-control',
    aliases: ['provider', 'codexProvider', 'defualtProvider'],
    label: '默认 Codex Provider',
    usage: '/set defaultProvider sdk|pty|tmux',
    read: (payload) => payload.defaultProvider || 'auto',
    write(payload, rawValue) {
      const token = rawValue.trim().toLowerCase();
      if (['default', 'reset', 'unset', 'none', 'auto'].includes(token)) {
        payload.defaultProvider = '';
        return { ok: true };
      }
      if (token === 'sdk' || token === 'tmux' || token === 'pty') {
        payload.defaultProvider = token;
        return { ok: true };
      }
      return { ok: false, message: '默认 Codex Provider 必须是 sdk、pty 或 tmux，也可以用 default/auto 恢复自动选择。' };
    },
  },
  {
    key: 'defaultRuntime',
    group: 'bridge-control',
    aliases: ['runtime'],
    label: '默认 Runtime',
    usage: '/set defaultRuntime codex|claude',
    read: (payload) => payload.runtime || 'codex',
    write(payload, rawValue) {
      const token = rawValue.trim().toLowerCase();
      if (token === 'codex' || token === 'claude') {
        payload.runtime = token;
        return { ok: true };
      }
      return { ok: false, message: '默认 Runtime 必须是 codex 或 claude。' };
    },
  },
  {
    key: 'defaultMode',
    group: 'global-runtime-codex',
    aliases: ['mode'],
    label: 'Codex 默认模式',
    usage: '/set defaultMode normal|yolo',
    read: (payload) => payload.defaultMode || 'normal',
    write(payload, rawValue) {
      const token = rawValue.trim().toLowerCase();
      if (token === 'normal' || token === 'code') {
        payload.defaultMode = 'normal';
        return { ok: true };
      }
      if (token === 'yolo') {
        payload.defaultMode = 'yolo';
        return { ok: true };
      }
      return { ok: false, message: '默认模式必须是 normal 或 yolo。' };
    },
  },
  {
    key: 'historyMessageLimit',
    group: 'global-bridge',
    aliases: ['history', 'hisLimit'],
    label: '历史消息条数',
    usage: '/set historyMessageLimit 8',
    read: (payload) => `${payload.historyMessageLimit}`,
    write: writePositiveInt('historyMessageLimit', 1, 20),
  },
  {
    key: 'streamStatusIdleStartSeconds',
    group: 'global-bridge',
    aliases: ['streamIdle', 'idleStart'],
    label: '流式状态启动秒数',
    usage: '/set streamStatusIdleStartSeconds 180',
    read: (payload) => `${payload.streamStatusIdleStartSeconds}`,
    write: writePositiveInt('streamStatusIdleStartSeconds', 1),
  },
  {
    key: 'streamStatusCheckIntervalSeconds',
    group: 'global-bridge',
    aliases: ['streamCheck', 'statusInterval'],
    label: '流式状态检查间隔秒数',
    usage: '/set streamStatusCheckIntervalSeconds 10',
    read: (payload) => `${payload.streamStatusCheckIntervalSeconds}`,
    write: writePositiveInt('streamStatusCheckIntervalSeconds', 1),
  },
  {
    key: 'codexSkipGitRepoCheck',
    group: 'global-runtime-codex',
    aliases: ['skipGitRepoCheck', 'skipGitCheck'],
    label: '跳过 Git 仓库检查',
    usage: '/set codexSkipGitRepoCheck on|off',
    read: (payload) => formatBool(payload.codexSkipGitRepoCheck),
    write: writeBoolean('codexSkipGitRepoCheck'),
  },
  {
    key: 'codexSandboxMode',
    group: 'global-runtime-codex',
    aliases: ['sandbox', 'sandboxMode'],
    label: 'Codex 文件系统权限',
    usage: '/set codexSandboxMode read-only|workspace-write|danger-full-access',
    read: (payload) => payload.codexSandboxMode,
    write(payload, rawValue) {
      const parsed = parseSandboxMode(rawValue.trim());
      if (!parsed) return { ok: false, message: 'sandbox 必须是 read-only、workspace-write 或 danger-full-access。' };
      payload.codexSandboxMode = parsed;
      return { ok: true };
    },
  },
  {
    key: 'codexNetworkAccess',
    group: 'global-runtime-codex',
    aliases: ['network', 'networkAccess', 'net'],
    label: 'Codex 网络访问',
    usage: '/set codexNetworkAccess on|off',
    read: (payload) => formatBool(payload.codexNetworkAccess),
    write: writeBoolean('codexNetworkAccess'),
  },
  {
    key: 'codexReasoningEffort',
    group: 'global-runtime-codex',
    aliases: ['reasoning', 'reasoningEffort'],
    label: 'Codex 思考级别',
    usage: '/set codexReasoningEffort minimal|low|medium|high|xhigh',
    read: (payload) => formatReasoningEffort(payload.codexReasoningEffort),
    write(payload, rawValue) {
      const parsed = normalizeReasoningEffort(rawValue);
      if (!parsed) return { ok: false, message: 'reasoning 必须是 minimal、low、medium、high、xhigh 或 1-5。' };
      payload.codexReasoningEffort = parsed;
      return { ok: true };
    },
  },
  {
    key: 'claudeProvider',
    group: 'global-runtime-claude',
    aliases: ['claudeDefaultProvider'],
    label: '默认 Claude Provider',
    usage: '/set claudeProvider pty|tmux|sdk',
    read: (payload) => payload.claudeProvider || 'pty',
    write(payload, rawValue) {
      const token = rawValue.trim().toLowerCase();
      if (['default', 'reset', 'unset', 'none', 'auto'].includes(token)) {
        payload.claudeProvider = '';
        return { ok: true };
      }
      if (token === 'pty' || token === 'tmux' || token === 'sdk') {
        payload.claudeProvider = token;
        return { ok: true };
      }
      return { ok: false, message: '默认 Claude Provider 必须是 pty、tmux 或 sdk，也可以用 default/auto 恢复 pty 默认。' };
    },
  },
  {
    key: 'claudeExecutable',
    group: 'global-runtime-claude',
    aliases: ['claudeExec'],
    label: 'Claude executable',
    usage: '/set claudeExecutable claude|ccr',
    read: (payload) => payload.claudeExecutable || 'claude',
    write(payload, rawValue) {
      const token = rawValue.trim().toLowerCase();
      if (token === 'claude' || token === 'ccr') {
        payload.claudeExecutable = token;
        return { ok: true };
      }
      return { ok: false, message: 'Claude executable 必须是 claude 或 ccr。' };
    },
  },
  {
    key: 'claudeDefaultModel',
    group: 'global-runtime-claude',
    aliases: ['claudeModel'],
    label: 'Claude 默认模型',
    usage: '/set claudeDefaultModel sonnet 或 /set claudeDefaultModel default',
    read: (payload) => payload.claudeDefaultModel || '-',
    write: writeString('claudeDefaultModel', { allowDefault: true }),
  },
  {
    key: 'claudePermissionMode',
    group: 'global-runtime-claude',
    aliases: ['claudePermission'],
    label: 'Claude 权限模式',
    usage: '/set claudePermissionMode default|acceptEdits|bypassPermissions|plan',
    read: (payload) => payload.claudePermissionMode || 'default',
    write(payload, rawValue) {
      const token = rawValue.trim();
      if (token === 'default' || token === 'acceptEdits' || token === 'bypassPermissions' || token === 'plan') {
        payload.claudePermissionMode = token;
        return { ok: true };
      }
      return { ok: false, message: 'Claude 权限模式必须是 default、acceptEdits、bypassPermissions 或 plan。' };
    },
  },
  {
    key: 'claudeReasoningEffort',
    group: 'global-runtime-claude',
    aliases: ['claudeReasoning', 'claudeEffort'],
    label: 'Claude 思考级别',
    usage: '/set claudeReasoningEffort default|low|medium|high|xhigh|max',
    read: (payload) => payload.claudeReasoningEffort || 'default',
    write(payload, rawValue) {
      const token = rawValue.trim().toLowerCase();
      if (['default', 'reset', 'unset', 'none'].includes(token)) {
        payload.claudeReasoningEffort = '';
        return { ok: true };
      }
      if (token === 'low' || token === 'medium' || token === 'high' || token === 'xhigh' || token === 'max') {
        payload.claudeReasoningEffort = token;
        return { ok: true };
      }
      return { ok: false, message: 'Claude reasoning 必须是 default、low、medium、high、xhigh 或 max。' };
    },
  },
  {
    key: 'claudeIdleTimeoutMinutes',
    group: 'global-runtime-claude',
    aliases: ['claudeTimeout', 'claudeIdleTimeout'],
    label: 'Claude 空闲超时分钟',
    usage: '/set claudeIdleTimeoutMinutes 15',
    read: (payload) => `${payload.claudeIdleTimeoutMinutes ?? 0}`,
    write(payload, rawValue) {
      const token = rawValue.trim();
      if (token === 'off' || token === '0') {
        payload.claudeIdleTimeoutMinutes = 0;
        return { ok: true };
      }
      const parsed = parsePositiveInt(rawValue);
      if (parsed === null || parsed > 120) return { ok: false, message: 'Claude 空闲超时必须是 0-120 的整数分钟；0/off 表示关闭。' };
      payload.claudeIdleTimeoutMinutes = parsed;
      return { ok: true };
    },
  },
  {
    key: 'uiAllowLan',
    group: 'global-bridge',
    aliases: ['allowLan', 'uiLan'],
    label: 'UI 允许 LAN 访问',
    usage: '/set uiAllowLan on|off',
    read: (payload) => formatBool(payload.uiAllowLan),
    write: writeBoolean('uiAllowLan'),
  },
  {
    key: 'uiAccessToken',
    group: 'global-bridge',
    aliases: ['accessToken', 'uiToken'],
    label: 'UI 访问 token',
    usage: '/set uiAccessToken <token>',
    read: (payload) => maskToken(payload.uiAccessToken || ''),
    write: writeString('uiAccessToken'),
  },
];

const SETTING_BY_NAME = new Map<string, SettingDefinition>();
for (const definition of SETTING_DEFINITIONS) {
  SETTING_BY_NAME.set(definition.key.toLowerCase(), definition);
  for (const alias of definition.aliases) {
    SETTING_BY_NAME.set(alias.toLowerCase(), definition);
  }
}

function findSetting(raw: string): SettingDefinition | undefined {
  return SETTING_BY_NAME.get(raw.trim().toLowerCase());
}

function parseSetArgs(raw: string): { action: 'show-all' } | { action: 'show-one'; key: string } | { action: 'set'; key: string; value: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { action: 'show-all' };

  const eqIndex = trimmed.indexOf('=');
  if (eqIndex > 0) {
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
  return value ? { action: 'set', key, value } : { action: 'show-one', key };
}

function buildSettingsFields(payload: ConfigPayload, definitions: SettingDefinition[] = SETTING_DEFINITIONS): Array<[string, string]> {
  return definitions.map((definition) => [
    `${definition.label} (${definition.key})`,
    definition.read(payload),
  ]);
}

function buildGroupedSettingsResponse(payload: ConfigPayload, markdown: boolean): string {
  const sections = SETTING_GROUPS
    .map((group) => {
      const definitions = SETTING_DEFINITIONS.filter((definition) => definition.group === group.key);
      return {
        group,
        fields: buildSettingsFields(payload, definitions),
      };
    })
    .filter((section) => section.fields.length > 0);

  if (markdown) {
    const lines = ['**全局配置**', ''];
    for (const section of sections) {
      lines.push(`**${section.group.title}**`);
      lines.push(`_${section.group.description}_`);
      for (const [label, value] of section.fields) {
        lines.push(`- **${label}**：${value}`);
      }
      lines.push('');
    }
    lines.push('**说明**');
    for (const note of buildUsageNotes()) {
      lines.push(`- ${note}`);
    }
    return lines.join('\n').trim();
  }

  const lines = ['全局配置', ''];
  for (const section of sections) {
    lines.push(section.group.title);
    lines.push(section.group.description);
    for (const [label, value] of section.fields) {
      lines.push(`${label}: ${value}`);
    }
    lines.push('');
  }
  lines.push(...buildUsageNotes());
  return lines.join('\n').trim();
}

function buildUsageNotes(): string[] {
  return [
    '发送 `/set <key> <value>` 或 `/set <key>=<value>` 修改配置；配置保存方式与 UI 设置页相同。',
    '示例：`/set defaultWorkspaceRoot ~`、`/set defaultRuntime claude`、`/set defaultProvider tmux`、`/set codexNetworkAccess off`。',
    'Codex 与 Claude Code 的 GlobalRuntime 默认值互相独立，不会互相 fallback。',
    `可用 key：${SETTING_DEFINITIONS.map((definition) => definition.key).join(', ')}`,
  ];
}

export function handleSetCommand(options: {
  args: string;
  markdown: boolean;
}): string {
  const parsed = parseSetArgs(options.args);
  const currentConfig = loadConfig();
  const currentPayload = configToPayload(currentConfig);

  if (parsed.action === 'show-all') {
    return buildGroupedSettingsResponse(currentPayload, options.markdown);
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
      `全局配置：${SETTING_GROUPS.find((group) => group.key === definition.group)?.title || definition.group}`,
      buildSettingsFields(currentPayload, [definition]),
      [`用法：\`${definition.usage}\``],
      options.markdown,
    );
  }

  const nextPayload: Record<string, unknown> = { ...currentPayload };
  const written = definition.write(nextPayload, parsed.value);
  if (!written.ok) {
    return buildCommandFields(
      '配置未更新',
      [
        ['配置项', definition.key],
        ['输入值', parsed.value],
      ],
      [written.message, `用法：\`${definition.usage}\``],
      options.markdown,
    );
  }

  const nextConfig = mergeConfig(currentConfig, nextPayload);
  saveConfig(nextConfig);
  const savedPayload = configToPayload(loadConfig());
  const notes = ['配置已保存到 `~/.codelark/config.env` 与 `config.json`；后续 `/new` 和对应 runtime 请求会读取新的全局默认值。'];
  if (definition.key === 'codexReasoningEffort') {
    const warning = minimalReasoningWebSearchWarning(String(savedPayload.codexReasoningEffort || ''));
    if (warning) notes.push(warning);
  }
  return buildCommandFields(
    '已更新全局配置',
    buildSettingsFields(savedPayload, [definition]),
    notes,
    options.markdown,
  );
}
