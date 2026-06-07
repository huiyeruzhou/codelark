import crypto from 'node:crypto';
import os from 'node:os';

import { parseSandboxMode } from '../../runtime/options.js';
import { createConfigService } from '../../configuration/service.js';
import type { ConfigPatch, ConfigV2 } from '../../configuration/schema.js';
import type { ConfigPath } from '../../configuration/fields.js';
import { normalizeReasoningEffort } from './aliases.js';
import {
  buildCommandFields,
  formatReasoningEffort,
  minimalReasoningWebSearchWarning,
} from './presentation.js';

interface ConfigPayload {
  runtime: 'codex' | 'claude';
  defaultWorkspaceRoot: string;
  defaultModel: string;
  defaultProvider: string;
  defaultMode: 'normal' | 'yolo';
  historyMessageLimit: number;
  streamStatusIdleStartSeconds: number;
  streamStatusCheckIntervalSeconds: number;
  codexSkipGitRepoCheck: boolean;
  codexSandboxMode: string;
  codexNetworkAccess: boolean;
  codexReasoningEffort: string;
  claudeProvider: string;
  claudeExecutable: string;
  claudeDefaultModel: string;
  claudePermissionMode: string;
  claudeIdleTimeoutMinutes: number;
  uiAllowLan: boolean;
  uiAccessToken: string;
}

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
  write(rawValue: string, current: ConfigV2): { ok: true; ops: ConfigWriteOperation[] } | { ok: false; message: string };
}

type ConfigWriteOperation =
  | { kind: 'set'; patch: ConfigPatch }
  | { kind: 'unset'; path: ConfigPath };

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

function generateAccessToken(): string {
  return crypto.randomBytes(18).toString('base64url');
}

function defaultChannelId(config: ConfigV2): string {
  return config.channels.find((channel) => channel.id === 'feishu-default')?.id
    || config.channels[0]?.id
    || 'feishu-default';
}

function defaultChannelConfig(config: ConfigV2): ConfigV2['channels'][number]['config'] {
  const channel = config.channels.find((entry) => entry.id === defaultChannelId(config)) || config.channels[0];
  if (!channel) throw new Error('Effective config must include at least one channel from defaults.toml.');
  return channel.config;
}

function channelConfigPatch(config: ConfigV2, patch: NonNullable<NonNullable<ConfigPatch['channels']>[number]['config']>): ConfigPatch {
  return {
    channels: [{
      id: defaultChannelId(config),
      provider: 'feishu',
      config: patch,
    }],
  };
}

function configToPayload(config: ConfigV2): ConfigPayload {
  const channel = defaultChannelConfig(config);
  return {
    runtime: config.runtime.agent,
    defaultWorkspaceRoot: config.bridge.defaultWorkspace === '~' ? os.homedir() : config.bridge.defaultWorkspace,
    defaultModel: config.runtime.codex.model || '',
    defaultProvider: config.runtime.codex.provider || '',
    defaultMode: config.runtime.codex.yoloMode === 'on' || config.runtime.codex.yoloMode === 'yolo' ? 'yolo' : 'normal',
    historyMessageLimit: channel.historyMessageLimit,
    streamStatusIdleStartSeconds: channel.streamStatusIdleStartSeconds,
    streamStatusCheckIntervalSeconds: channel.streamStatusCheckIntervalSeconds,
    codexSkipGitRepoCheck: config.runtime.codex.skipGitRepoCheck,
    codexSandboxMode: config.runtime.codex.sandboxMode,
    codexNetworkAccess: config.runtime.codex.networkAccess,
    codexReasoningEffort: config.runtime.codex.reasoningEffort,
    claudeProvider: config.runtime.claude.provider,
    claudeExecutable: config.runtime.claude.executable,
    claudeDefaultModel: config.runtime.claude.model || '',
    claudePermissionMode: config.runtime.claude.permissionMode,
    claudeIdleTimeoutMinutes: config.runtime.claude.idleTimeoutMinutes,
    uiAllowLan: config.bridge.uiAllowLan,
    uiAccessToken: config.bridge.uiAccessToken || '',
  };
}

function setOp(patch: ConfigPatch): { ok: true; ops: ConfigWriteOperation[] } {
  return { ok: true, ops: [{ kind: 'set', patch }] };
}

function unsetOp(path: ConfigPath): { ok: true; ops: ConfigWriteOperation[] } {
  return { ok: true, ops: [{ kind: 'unset', path }] };
}

function writeStringPatch(
  apply: (value: string) => ConfigPatch,
  options: { defaultPath?: ConfigPath } = {},
) {
  return (rawValue: string): { ok: true; ops: ConfigWriteOperation[] } => {
    const value = rawValue.trim();
    if (options.defaultPath && ['default', 'reset', 'unset', 'none'].includes(value.toLowerCase())) {
      return unsetOp(options.defaultPath);
    }
    return setOp(apply(value));
  };
}

function writeBooleanPatch(apply: (value: boolean, current: ConfigV2) => ConfigPatch) {
  return (rawValue: string, current: ConfigV2): { ok: true; ops: ConfigWriteOperation[] } | { ok: false; message: string } => {
    const parsed = parseBoolean(rawValue);
    if (parsed === null) return { ok: false, message: '值必须是 on/off、true/false 或 1/0。' };
    return setOp(apply(parsed, current));
  };
}

function writePositiveIntPatch(apply: (value: number, current: ConfigV2) => ConfigPatch, min: number, max?: number) {
  return (rawValue: string, current: ConfigV2): { ok: true; ops: ConfigWriteOperation[] } | { ok: false; message: string } => {
    const parsed = parsePositiveInt(rawValue);
    if (parsed === null || parsed < min || (max !== undefined && parsed > max)) {
      return { ok: false, message: max === undefined ? `值必须是大于等于 ${min} 的整数。` : `值必须是 ${min}-${max} 的整数。` };
    }
    return setOp(apply(parsed, current));
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
    write: writeStringPatch((value) => ({ bridge: { defaultWorkspace: value } }), { defaultPath: 'bridge.defaultWorkspace' }),
  },
  {
    key: 'defaultModel',
    group: 'global-runtime-codex',
    aliases: ['model'],
    label: 'Codex 默认模型',
    usage: '/set defaultModel gpt-5 或 /set defaultModel default',
    read: (payload) => payload.defaultModel || '-',
    write: writeStringPatch((value) => ({ runtime: { codex: { model: value } } }), { defaultPath: 'runtime.codex.model' }),
  },
  {
    key: 'defaultProvider',
    group: 'bridge-control',
    aliases: ['provider', 'codexProvider', 'defualtProvider'],
    label: '默认 Codex Provider',
    usage: '/set defaultProvider sdk|pty|tmux',
    read: (payload) => payload.defaultProvider || 'auto',
    write(rawValue) {
      const token = rawValue.trim().toLowerCase();
      if (['default', 'reset', 'unset', 'none', 'auto'].includes(token)) {
        return unsetOp('runtime.codex.provider');
      }
      if (token === 'sdk' || token === 'tmux' || token === 'pty') {
        return setOp({ runtime: { codex: { provider: token } } });
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
    write(rawValue) {
      const token = rawValue.trim().toLowerCase();
      if (token === 'codex' || token === 'claude') {
        return setOp({ runtime: { agent: token } });
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
    write(rawValue) {
      const token = rawValue.trim().toLowerCase();
      if (token === 'normal' || token === 'code') {
        return setOp({ runtime: { codex: { yoloMode: 'off' } } });
      }
      if (token === 'yolo') {
        return setOp({ runtime: { codex: { yoloMode: 'on' } } });
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
    write: writePositiveIntPatch((value, current) => channelConfigPatch(current, { historyMessageLimit: value }), 1, 20),
  },
  {
    key: 'streamStatusIdleStartSeconds',
    group: 'global-bridge',
    aliases: ['streamIdle', 'idleStart'],
    label: '流式状态启动秒数',
    usage: '/set streamStatusIdleStartSeconds 180',
    read: (payload) => `${payload.streamStatusIdleStartSeconds}`,
    write: writePositiveIntPatch((value, current) => channelConfigPatch(current, { streamStatusIdleStartSeconds: value }), 1),
  },
  {
    key: 'streamStatusCheckIntervalSeconds',
    group: 'global-bridge',
    aliases: ['streamCheck', 'statusInterval'],
    label: '流式状态检查间隔秒数',
    usage: '/set streamStatusCheckIntervalSeconds 10',
    read: (payload) => `${payload.streamStatusCheckIntervalSeconds}`,
    write: writePositiveIntPatch((value, current) => channelConfigPatch(current, { streamStatusCheckIntervalSeconds: value }), 1),
  },
  {
    key: 'codexSkipGitRepoCheck',
    group: 'global-runtime-codex',
    aliases: ['skipGitRepoCheck', 'skipGitCheck'],
    label: '跳过 Git 仓库检查',
    usage: '/set codexSkipGitRepoCheck on|off',
    read: (payload) => formatBool(payload.codexSkipGitRepoCheck),
    write: writeBooleanPatch((value) => ({ runtime: { codex: { skipGitRepoCheck: value } } })),
  },
  {
    key: 'codexSandboxMode',
    group: 'global-runtime-codex',
    aliases: ['sandbox', 'sandboxMode'],
    label: 'Codex 文件系统权限',
    usage: '/set codexSandboxMode read-only|workspace-write|danger-full-access',
    read: (payload) => payload.codexSandboxMode,
    write(rawValue) {
      const parsed = parseSandboxMode(rawValue.trim());
      if (!parsed) return { ok: false, message: 'sandbox 必须是 read-only、workspace-write 或 danger-full-access。' };
      return setOp({ runtime: { codex: { sandboxMode: parsed } } });
    },
  },
  {
    key: 'codexNetworkAccess',
    group: 'global-runtime-codex',
    aliases: ['network', 'networkAccess', 'net'],
    label: 'Codex 网络访问',
    usage: '/set codexNetworkAccess on|off',
    read: (payload) => formatBool(payload.codexNetworkAccess),
    write: writeBooleanPatch((value) => ({ runtime: { codex: { networkAccess: value } } })),
  },
  {
    key: 'codexReasoningEffort',
    group: 'global-runtime-codex',
    aliases: ['reasoning', 'reasoningEffort'],
    label: 'Codex 思考级别',
    usage: '/set codexReasoningEffort minimal|low|medium|high|xhigh',
    read: (payload) => formatReasoningEffort(payload.codexReasoningEffort),
    write(rawValue) {
      const parsed = normalizeReasoningEffort(rawValue);
      if (!parsed) return { ok: false, message: 'reasoning 必须是 minimal、low、medium、high、xhigh 或 1-5。' };
      return setOp({ runtime: { codex: { reasoningEffort: parsed } } });
    },
  },
  {
    key: 'claudeProvider',
    group: 'global-runtime-claude',
    aliases: ['claudeDefaultProvider'],
    label: '默认 Claude Provider',
    usage: '/set claudeProvider pty|sdk',
    read: (payload) => payload.claudeProvider || 'sdk',
    write(rawValue) {
      const token = rawValue.trim().toLowerCase();
      if (['default', 'reset', 'unset', 'none', 'auto'].includes(token)) {
        return unsetOp('runtime.claude.provider');
      }
      if (token === 'pty' || token === 'sdk') {
        return setOp({ runtime: { claude: { provider: token } } });
      }
      return { ok: false, message: '默认 Claude Provider 必须是 pty 或 sdk，也可以用 default/auto 恢复 sdk 默认。' };
    },
  },
  {
    key: 'claudeExecutable',
    group: 'global-runtime-claude',
    aliases: ['claudeExec'],
    label: 'Claude executable',
    usage: '/set claudeExecutable claude|ccr',
    read: (payload) => payload.claudeExecutable || 'claude',
    write(rawValue) {
      const token = rawValue.trim().toLowerCase();
      if (token === 'claude' || token === 'ccr') {
        return setOp({ runtime: { claude: { executable: token } } });
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
    write: writeStringPatch((value) => ({ runtime: { claude: { model: value } } }), { defaultPath: 'runtime.claude.model' }),
  },
  {
    key: 'claudePermissionMode',
    group: 'global-runtime-claude',
    aliases: ['claudePermission'],
    label: 'Claude 权限模式',
    usage: '/set claudePermissionMode default|acceptEdits|bypassPermissions|plan',
    read: (payload) => payload.claudePermissionMode || 'default',
    write(rawValue) {
      const token = rawValue.trim();
      if (token === 'default' || token === 'acceptEdits' || token === 'bypassPermissions' || token === 'plan') {
        return setOp({
          runtime: {
            claude: {
              permissionMode: token,
              yoloMode: token === 'bypassPermissions' ? 'on' : 'off',
            },
          },
        });
      }
      return { ok: false, message: 'Claude 权限模式必须是 default、acceptEdits、bypassPermissions 或 plan。' };
    },
  },
  {
    key: 'claudeIdleTimeoutMinutes',
    group: 'global-runtime-claude',
    aliases: ['claudeTimeout', 'claudeIdleTimeout'],
    label: 'Claude 空闲超时分钟',
    usage: '/set claudeIdleTimeoutMinutes 15',
    read: (payload) => `${payload.claudeIdleTimeoutMinutes ?? 0}`,
    write(rawValue) {
      const token = rawValue.trim();
      if (token === 'off' || token === '0') {
        return setOp({ runtime: { claude: { idleTimeoutMinutes: 0 } } });
      }
      const parsed = parsePositiveInt(rawValue);
      if (parsed === null || parsed > 120) return { ok: false, message: 'Claude 空闲超时必须是 0-120 的整数分钟；0/off 表示关闭。' };
      return setOp({ runtime: { claude: { idleTimeoutMinutes: parsed } } });
    },
  },
  {
    key: 'uiAllowLan',
    group: 'global-bridge',
    aliases: ['allowLan', 'uiLan'],
    label: 'UI 允许 LAN 访问',
    usage: '/set uiAllowLan on|off',
    read: (payload) => formatBool(payload.uiAllowLan),
    write: writeBooleanPatch((value, current) => ({
      bridge: {
        uiAllowLan: value,
        ...(value && !current.bridge.uiAccessToken ? { uiAccessToken: generateAccessToken() } : {}),
      },
    })),
  },
  {
    key: 'uiAccessToken',
    group: 'global-bridge',
    aliases: ['accessToken', 'uiToken'],
    label: 'UI 访问 token',
    usage: '/set uiAccessToken <token>',
    read: (payload) => maskToken(payload.uiAccessToken || ''),
    write: writeStringPatch((value) => ({ bridge: { uiAccessToken: value } })),
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
  const service = createConfigService({ migrate: false });
  const currentConfig = service.snapshot().config;
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

  const written = definition.write(parsed.value, currentConfig);
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

  for (const op of written.ops) {
    if (op.kind === 'set') service.set({ kind: 'home' }, op.patch);
    else service.unset({ kind: 'home' }, op.path);
  }
  const savedPayload = configToPayload(service.snapshot().config);
  const notes = ['配置已保存到 `~/.codelark/config.toml`；后续 `/new` 和对应 runtime 请求会读取新的全局默认值。'];
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
