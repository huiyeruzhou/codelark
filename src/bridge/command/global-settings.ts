import { parseSandboxMode } from '../../runtime/options.js';
import { createConfigService } from '../../configuration/service.js';
import type { ConfigV2 } from '../../configuration/schema.js';
import {
  configV2ToPayload,
  mergeConfigV2HomePatch,
} from '../../operator-ui/application/config.js';
import { normalizeReasoningEffort } from './aliases.js';
import { buildCommandCallbackData } from './callbacks.js';
import {
  buildCommandFields,
  formatReasoningEffort,
  minimalReasoningWebSearchWarning,
} from './presentation.js';
import type { OutboundRichCard } from '../../domain/index.js';

interface ConfigPayload {
  runtime: string;
  defaultWorkspaceRoot: string;
  defaultModel: string;
  defaultProvider: string;
  defaultMode: string;
  historyMessageLimit?: number;
  streamStatusIdleStartSeconds?: number;
  streamStatusCheckIntervalSeconds?: number;
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
  write(rawValue: string, current: ConfigV2): { ok: true; payload: Record<string, unknown> } | { ok: false; message: string };
}

const SETTING_GROUPS: SettingGroupDefinition[] = [
  {
    key: 'global-runtime-codex',
    title: 'GlobalRuntime / Codex',
    description: 'Codex 模型执行默认值，只作为 Codex runtime 的回退配置。',
  },
  {
    key: 'global-runtime-claude',
    title: 'GlobalRuntime / Claude',
    description: 'Claude Code 默认值，只作为 Claude runtime 的回退配置。',
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

function configToPayload(config: ConfigV2): ConfigPayload {
  return configV2ToPayload(config);
}

function uiPayload(payload: Record<string, unknown>): { ok: true; payload: Record<string, unknown> } {
  return { ok: true, payload };
}

function writeStringPatch(
  key: string,
  options: { defaultValue?: string } = {},
) {
  return (rawValue: string): { ok: true; payload: Record<string, unknown> } => {
    const value = rawValue.trim();
    if (['default', 'reset', 'unset', 'none'].includes(value.toLowerCase())) {
      return uiPayload({ [key]: options.defaultValue ?? '' });
    }
    return uiPayload({ [key]: value });
  };
}

function writeBooleanPatch(key: string) {
  return (rawValue: string): { ok: true; payload: Record<string, unknown> } | { ok: false; message: string } => {
    const parsed = parseBoolean(rawValue);
    if (parsed === null) return { ok: false, message: '值必须是 on/off、true/false 或 1/0。' };
    return uiPayload({ [key]: parsed });
  };
}

function writePositiveIntPatch(key: string, min: number, max?: number) {
  return (rawValue: string): { ok: true; payload: Record<string, unknown> } | { ok: false; message: string } => {
    const parsed = parsePositiveInt(rawValue);
    if (parsed === null || parsed < min || (max !== undefined && parsed > max)) {
      return { ok: false, message: max === undefined ? `值必须是大于等于 ${min} 的整数。` : `值必须是 ${min}-${max} 的整数。` };
    }
    return uiPayload({ [key]: parsed });
  };
}

const SETTING_DEFINITIONS: SettingDefinition[] = [
  {
    key: 'runtime',
    group: 'global-runtime-codex',
    aliases: ['defaultRuntime'],
    label: 'Runtime',
    usage: '/set runtime codex|claude',
    read: (payload) => payload.runtime || 'codex',
    write(rawValue) {
      const token = rawValue.trim().toLowerCase();
      if (token === 'codex' || token === 'claude') {
        return uiPayload({ runtime: token });
      }
      return { ok: false, message: 'Runtime 必须是 codex 或 claude。' };
    },
  },
  {
    key: 'defaultWorkspaceRoot',
    group: 'global-bridge',
    aliases: ['workspace', 'workspaceRoot', 'root', 'newRoot'],
    label: '/new 相对路径根目录',
    usage: '/set defaultWorkspaceRoot /abs/path',
    read: (payload) => payload.defaultWorkspaceRoot || '-',
    write: writeStringPatch('defaultWorkspaceRoot'),
  },
  {
    key: 'defaultModel',
    group: 'global-runtime-codex',
    aliases: ['model'],
    label: 'Codex 默认模型',
    usage: '/set defaultModel gpt-5 或 /set defaultModel default',
    read: (payload) => payload.defaultModel || '-',
    write: writeStringPatch('defaultModel'),
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
        return uiPayload({ defaultProvider: '' });
      }
      if (token === 'sdk' || token === 'tmux' || token === 'pty') {
        return uiPayload({ defaultProvider: token });
      }
      return { ok: false, message: '默认 Codex Provider 必须是 sdk、pty 或 tmux，也可以用 default/auto 恢复自动选择。' };
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
        return uiPayload({ defaultMode: 'normal' });
      }
      if (token === 'yolo') {
        return uiPayload({ defaultMode: 'yolo' });
      }
      return { ok: false, message: '默认模式必须是 normal 或 yolo。' };
    },
  },
  {
    key: 'historyMessageLimit',
    group: 'global-bridge',
    aliases: ['history', 'hisLimit'],
    label: '/his 返回条数',
    usage: '/set historyMessageLimit 8',
    read: (payload) => `${payload.historyMessageLimit ?? '-'}`,
    write: writePositiveIntPatch('historyMessageLimit', 1, 20),
  },
  {
    key: 'streamStatusIdleStartSeconds',
    group: 'global-bridge',
    aliases: ['streamIdle', 'idleStart'],
    label: '长任务提示延迟',
    usage: '/set streamStatusIdleStartSeconds 180',
    read: (payload) => `${payload.streamStatusIdleStartSeconds ?? '-'}`,
    write: writePositiveIntPatch('streamStatusIdleStartSeconds', 1),
  },
  {
    key: 'streamStatusCheckIntervalSeconds',
    group: 'global-bridge',
    aliases: ['streamCheck', 'statusInterval'],
    label: '长任务提示刷新间隔',
    usage: '/set streamStatusCheckIntervalSeconds 10',
    read: (payload) => `${payload.streamStatusCheckIntervalSeconds ?? '-'}`,
    write: writePositiveIntPatch('streamStatusCheckIntervalSeconds', 1),
  },
  {
    key: 'codexSkipGitRepoCheck',
    group: 'global-runtime-codex',
    aliases: ['skipGitRepoCheck', 'skipGitCheck'],
    label: '允许在未信任 Git 目录运行 Codex',
    usage: '/set codexSkipGitRepoCheck on|off',
    read: (payload) => formatBool(payload.codexSkipGitRepoCheck),
    write: writeBooleanPatch('codexSkipGitRepoCheck'),
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
      return uiPayload({ codexSandboxMode: parsed });
    },
  },
  {
    key: 'codexNetworkAccess',
    group: 'global-runtime-codex',
    aliases: ['network', 'networkAccess', 'net'],
    label: 'Codex 网络访问',
    usage: '/set codexNetworkAccess on|off',
    read: (payload) => formatBool(payload.codexNetworkAccess),
    write: writeBooleanPatch('codexNetworkAccess'),
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
      return uiPayload({ codexReasoningEffort: parsed });
    },
  },
  {
    key: 'claudeProvider',
    group: 'global-runtime-claude',
    aliases: ['claudeDefaultProvider'],
    label: '默认 Claude Provider',
    usage: '/set claudeProvider tmux|pty|sdk',
    read: (payload) => payload.claudeProvider || 'tmux',
    write(rawValue) {
      const token = rawValue.trim().toLowerCase();
      if (['default', 'reset', 'unset', 'none', 'auto'].includes(token)) {
        return uiPayload({ claudeProvider: 'tmux' });
      }
      if (token === 'tmux' || token === 'pty' || token === 'sdk') {
        return uiPayload({ claudeProvider: token });
      }
      return { ok: false, message: '默认 Claude Provider 必须是 tmux、pty 或 sdk，也可以用 default/auto 恢复默认。' };
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
        return uiPayload({ claudeExecutable: token });
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
    write: writeStringPatch('claudeDefaultModel'),
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
        return uiPayload({ claudePermissionMode: token });
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
        return uiPayload({ claudeIdleTimeoutMinutes: 0 });
      }
      const parsed = parsePositiveInt(rawValue);
      if (parsed === null || parsed > 120) return { ok: false, message: 'Claude 空闲超时必须是 0-120 的整数分钟；0/off 表示关闭。' };
      return uiPayload({ claudeIdleTimeoutMinutes: parsed });
    },
  },
  {
    key: 'uiAllowLan',
    group: 'global-bridge',
    aliases: ['allowLan', 'uiLan'],
    label: 'UI 允许 LAN 访问',
    usage: '/set uiAllowLan on|off',
    read: (payload) => formatBool(payload.uiAllowLan),
    write: writeBooleanPatch('uiAllowLan'),
  },
  {
    key: 'uiAccessToken',
    group: 'global-bridge',
    aliases: ['accessToken', 'uiToken'],
    label: 'UI 访问 token',
    usage: '/set uiAccessToken <token>',
    read: (payload) => maskToken(payload.uiAccessToken || ''),
    write: writeStringPatch('uiAccessToken'),
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

function selectOption(text: string, value = text): { text: string; callbackData: string } {
  return { text, callbackData: value };
}

function formSelect(
  elementId: string,
  label: string,
  selectedValue: string,
  options: Array<{ text: string; callbackData: string }>,
): NonNullable<NonNullable<OutboundRichCard['form']>['selects']>[number] {
  return {
    elementId,
    label,
    placeholder: selectedValue || 'auto',
    selectedCallbackData: selectedValue,
    options,
  };
}

function formInput(
  elementId: string,
  label: string,
  placeholder: string,
  defaultValue: string | number | undefined,
): NonNullable<NonNullable<OutboundRichCard['form']>['extraInputs']>[number] {
  return {
    elementId,
    label,
    placeholder,
    defaultValue: defaultValue === undefined ? '' : String(defaultValue),
  };
}

export function buildSetCommandRichCard(): OutboundRichCard {
  const payload = configToPayload(createConfigService({ migrate: false }).snapshot().config);
  return {
    title: '全局配置',
    subtitle: '保存后写入 ~/.codelark/config.toml（home level），字段与 Web 配置页一致。',
    template: 'blue',
    tags: ['home level', 'config'],
    tagColor: 'blue',
    sections: SETTING_GROUPS.map((group) => ({
      title: group.title,
      fields: buildSettingsFields(
        payload,
        SETTING_DEFINITIONS.filter((definition) => definition.group === group.key),
      ),
    })),
    form: {
      optionElementId: 'clk_set_option',
      inputElementId: 'defaultWorkspaceRoot',
      inputLabel: '/new 相对路径根目录',
      inputPlaceholder: '留空时使用 ~',
      inputDefaultValue: payload.defaultWorkspaceRoot || '',
      layout: 'two_column',
      controlBar: {
        actions: [
          { text: '刷新', callbackData: buildCommandCallbackData('/set') },
        ],
      },
      selects: [
        formSelect('runtime', 'Runtime', payload.runtime || 'codex', [selectOption('codex'), selectOption('claude')]),
        formSelect('defaultMode', 'Codex 默认模式', payload.defaultMode || 'normal', [selectOption('normal'), selectOption('yolo')]),
        formSelect('defaultProvider', '默认 Codex Provider', payload.defaultProvider || '', [selectOption('auto', ''), selectOption('sdk'), selectOption('pty'), selectOption('tmux')]),
        formSelect('codexSandboxMode', 'Codex 文件系统权限', payload.codexSandboxMode || 'workspace-write', [selectOption('workspace-write'), selectOption('read-only'), selectOption('danger-full-access')]),
        formSelect('codexReasoningEffort', 'Codex 思考级别', payload.codexReasoningEffort || 'medium', [selectOption('medium'), selectOption('minimal'), selectOption('low'), selectOption('high'), selectOption('xhigh')]),
        formSelect('codexNetworkAccess', 'Codex 网络访问', payload.codexNetworkAccess ? 'on' : 'off', [selectOption('on'), selectOption('off')]),
        formSelect('codexSkipGitRepoCheck', '允许未信任 Git 目录', payload.codexSkipGitRepoCheck ? 'on' : 'off', [selectOption('on'), selectOption('off')]),
        formSelect('claudeExecutable', 'Claude executable', payload.claudeExecutable || 'claude', [selectOption('claude'), selectOption('ccr')]),
        formSelect('claudeProvider', '默认 Claude Provider', payload.claudeProvider || 'tmux', [selectOption('tmux'), selectOption('pty'), selectOption('sdk')]),
        formSelect('claudePermissionMode', 'Claude 权限模式', payload.claudePermissionMode || 'default', [selectOption('default'), selectOption('acceptEdits'), selectOption('bypassPermissions'), selectOption('plan')]),
        formSelect('uiAllowLan', '允许局域网访问 Web 控制台', payload.uiAllowLan ? 'on' : 'off', [selectOption('on'), selectOption('off')]),
      ],
      extraInputs: [
        formInput('defaultModel', 'Codex 默认模型', '留空则跟随 Codex 默认', payload.defaultModel),
        formInput('historyMessageLimit', '/his 返回条数', '1-20', payload.historyMessageLimit),
        formInput('streamStatusIdleStartSeconds', '长任务提示延迟', '秒，默认 180', payload.streamStatusIdleStartSeconds),
        formInput('streamStatusCheckIntervalSeconds', '长任务提示刷新间隔', '秒，默认 10', payload.streamStatusCheckIntervalSeconds),
        formInput('claudeDefaultModel', 'Claude 默认模型', '留空则跟随 Claude Code 默认', payload.claudeDefaultModel),
        formInput('claudeIdleTimeoutMinutes', 'Claude 空闲超时', '分钟，0 表示关闭', payload.claudeIdleTimeoutMinutes),
        formInput('uiAccessToken', '局域网访问 token', '开启 LAN 后可留空自动生成', payload.uiAccessToken),
      ],
      submitText: '保存',
      submitCallbackData: buildCommandCallbackData('/set'),
      options: [],
    },
    footer: [
      '也可发送 `/set <key> <value>` 修改单项配置；旧名 `defaultRuntime` 仍兼容。',
    ],
  };
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
    '发送 `/set <key> <value>` 或 `/set <key>=<value>` 修改配置；默认写入 home level，配置保存方式与 UI 设置页相同。',
    '示例：`/set defaultWorkspaceRoot ~`、`/set runtime claude`、`/set defaultProvider tmux`、`/set codexNetworkAccess off`。',
    'Codex 与 Claude Code 的 GlobalRuntime 默认值互相独立，不会互相回退。',
    `可用 key：${SETTING_DEFINITIONS.map((definition) => definition.key).join(', ')}`,
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

const SET_FORM_FIELD_KEYS = [
  'runtime',
  'defaultMode',
  'defaultProvider',
  'codexSandboxMode',
  'codexReasoningEffort',
  'codexNetworkAccess',
  'codexSkipGitRepoCheck',
  'claudeExecutable',
  'claudeProvider',
  'claudePermissionMode',
  'uiAllowLan',
  'defaultWorkspaceRoot',
  'defaultModel',
  'historyMessageLimit',
  'streamStatusIdleStartSeconds',
  'streamStatusCheckIntervalSeconds',
  'claudeDefaultModel',
  'claudeIdleTimeoutMinutes',
  'uiAccessToken',
] as const;

function formValueString(formValue: Record<string, unknown>, key: string): string | undefined {
  const value = formValue[key];
  return typeof value === 'string' ? value.trim() : undefined;
}

export function handleSetFormCommand(options: {
  formValue: Record<string, unknown>;
  markdown: boolean;
}): { response: string; richCard: OutboundRichCard } {
  const service = createConfigService({ migrate: false });
  let currentConfig = service.snapshot().config;
  const combinedPayload: Record<string, unknown> = {};

  for (const key of SET_FORM_FIELD_KEYS) {
    const rawValue = formValueString(options.formValue, key);
    if (rawValue === undefined) continue;
    const definition = findSetting(key);
    if (!definition) continue;
    const written = definition.write(rawValue, currentConfig);
    if (!written.ok) {
      return {
        response: buildCommandFields(
          '配置未更新',
          [
            ['配置项', definition.key],
            ['输入值', rawValue],
          ],
          [written.message, `用法：\`${definition.usage}\``],
          options.markdown,
        ),
        richCard: buildSetCommandRichCard(),
      };
    }
    Object.assign(combinedPayload, written.payload);
  }

  try {
    service.replace({ kind: 'home' }, mergeConfigV2HomePatch(currentConfig, combinedPayload));
    currentConfig = service.snapshot().config;
  } catch (error) {
    return {
      response: buildCommandFields(
        '配置未更新',
        [],
        [formatConfigWriteError(error), '请刷新 `/set` 卡片后重试。'],
        options.markdown,
      ),
      richCard: buildSetCommandRichCard(),
    };
  }

  const savedPayload = configToPayload(currentConfig);
  const notes = ['配置已保存到 `~/.codelark/config.toml`（home level）；卡片已刷新为最新值。'];
  const warning = minimalReasoningWebSearchWarning(String(savedPayload.codexReasoningEffort || ''));
  if (warning) notes.push(warning);
  return {
    response: buildCommandFields(
      '已保存全局配置',
      [
        ['Runtime', savedPayload.runtime],
        ['默认 Codex Provider', savedPayload.defaultProvider || 'auto'],
        ['Codex 网络访问', formatBool(savedPayload.codexNetworkAccess)],
        ['/new 相对路径根目录', savedPayload.defaultWorkspaceRoot || '-'],
      ],
      notes,
      options.markdown,
    ),
    richCard: buildSetCommandRichCard(),
  };
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

  try {
    service.replace({ kind: 'home' }, mergeConfigV2HomePatch(currentConfig, written.payload));
  } catch (error) {
    return buildCommandFields(
      '配置未更新',
      [
        ['配置项', definition.key],
        ['输入值', parsed.value],
      ],
      [formatConfigWriteError(error), `用法：\`${definition.usage}\``],
      options.markdown,
    );
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
