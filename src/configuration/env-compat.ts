import { findConfigField } from './fields.js';
import type { ConfigPatch } from './schema.js';
import { setConfigPath } from './path-access.js';

export interface EnvCompatWarning {
  envKey: string;
  aliasFor: string;
  message: string;
}

const legacyEnvAliases = new Map<string, string>([
  ['CODELARK_CODEX_DEFAULT_MODEL', 'CODELARK_CODEX_MODEL'],
  ['CODELARK_CODEX_DEFAULT_MODE', 'CODELARK_CODEX_YOLO_MODE'],
  ['CODELARK_DEFAULT_CODEX_PROVIDER', 'CODELARK_CODEX_PROVIDER'],
  ['CODELARK_CLAUDE_DEFAULT_MODEL', 'CODELARK_CLAUDE_MODEL'],
  ['CODELARK_FEISHU_DOMAIN', 'CODELARK_FEISHU_SITE'],
]);

function normalizeLegacyValue(newKey: string, value: string): string {
  if (newKey === 'CODELARK_CODEX_YOLO_MODE') return value === 'yolo' ? 'on' : 'off';
  return value;
}

export function envToConfigPatch(env: NodeJS.ProcessEnv): {
  patch: ConfigPatch;
  warnings: EnvCompatWarning[];
  envByPath: Map<string, string>;
} {
  const patch: ConfigPatch = {};
  const warnings: EnvCompatWarning[] = [];
  const envByPath = new Map<string, string>();

  for (const field of Object.values(findConfigFieldsByEnv())) {
    if (!field.envKey || !field.parseEnv) continue;
    const raw = env[field.envKey];
    let valueSource = field.envKey;
    let rawValue = raw;
    for (const [alias, newKey] of legacyEnvAliases) {
      if (newKey !== field.envKey) continue;
      const aliasValue = env[alias];
      if (aliasValue === undefined) continue;
      warnings.push({
        envKey: alias,
        aliasFor: newKey,
        message: `${alias} is deprecated; use ${newKey}.`,
      });
      if (rawValue === undefined) {
        rawValue = normalizeLegacyValue(newKey, aliasValue);
        valueSource = alias;
      }
    }
    if (rawValue === undefined) continue;
    const parsed = field.parseEnv(rawValue);
    if (parsed === undefined) continue;
    if (field.path === 'channels[].enabled') {
      const channel = ensureDefaultChannelPatch(patch);
      channel.enabled = Array.isArray(parsed) && parsed.includes('feishu');
    } else if (field.path.startsWith('channels[].')) {
      const channel = ensureDefaultChannelPatch(patch);
      channel.config ??= {};
      setConfigPath(channel, field.path.replace('channels[].', ''), parsed);
    } else {
      setConfigPath(patch, field.path, parsed);
    }
    envByPath.set(field.path, valueSource);
  }

  return { patch, warnings, envByPath };
}

function ensureDefaultChannelPatch(patch: ConfigPatch): NonNullable<ConfigPatch['channels']>[number] {
  patch.channels ??= [];
  let channel = patch.channels.find((entry) => entry.id === 'feishu-default');
  if (!channel) {
    channel = { id: 'feishu-default' };
    patch.channels.push(channel);
  }
  return channel;
}

function findConfigFieldsByEnv() {
  const fields: Record<string, NonNullable<ReturnType<typeof findConfigField>>> = {};
  for (const key of [
    'runtime.provider',
    'bridge.defaultWorkspace',
    'bridge.uiAllowLan',
    'bridge.uiAccessToken',
    'runtime.codex.model',
    'runtime.codex.yoloMode',
    'runtime.codex.provider',
    'runtime.codex.skipGitRepoCheck',
    'runtime.codex.sandboxMode',
    'runtime.codex.networkAccess',
    'runtime.codex.reasoningEffort',
    'runtime.claude.model',
    'runtime.claude.yoloMode',
    'runtime.claude.permissionMode',
    'runtime.claude.provider',
    'runtime.claude.executable',
    'runtime.claude.reasoningEffort',
    'runtime.claude.idleTimeoutMinutes',
    'channels[].enabled',
    'channels[].config.historyMessageLimit',
    'channels[].config.streamStatusIdleStartSeconds',
    'channels[].config.streamStatusCheckIntervalSeconds',
    'channels[].config.appId',
    'channels[].config.appSecret',
    'channels[].config.site',
    'channels[].config.allowedUsers',
    'channels[].config.streamingEnabled',
    'channels[].config.feedbackMarkdownEnabled',
    'channels[].config.requireMention',
  ]) {
    const field = findConfigField(key);
    if (field) fields[key] = field;
  }
  return fields;
}
