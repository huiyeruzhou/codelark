import { configFields } from './fields.js';
import type { ConfigField } from './fields.js';
import type { ConfigPatch } from './schema.js';
import { setConfigPath } from './path-access.js';

// 进程 env 兼容层：只把非 channel 实例字段映射成 ConfigPatch，并为旧 env key 生成 warning。
// channel 相关 env 在 v2 中只用于 migration 或对子进程导出，不再作为运行时配置输入。

export interface EnvCompatWarning {
  envKey: string;
  aliasFor: string;
  message: string;
}

const legacyEnvAliases = new Map<string, string>([
  ['CODELARK_RUNTIME', 'CODELARK_AGENT'],
  ['CODELARK_CODEX_DEFAULT_MODEL', 'CODELARK_CODEX_MODEL'],
  ['CODELARK_CODEX_DEFAULT_MODE', 'CODELARK_CODEX_YOLO_MODE'],
  ['CODELARK_DEFAULT_CODEX_PROVIDER', 'CODELARK_CODEX_PROVIDER'],
  ['CODELARK_CLAUDE_DEFAULT_MODEL', 'CODELARK_CLAUDE_MODEL'],
  ['CODELARK_FEISHU_DOMAIN', 'CODELARK_FEISHU_SITE'],
]);

function channelEnvKeyWarnings(env: NodeJS.ProcessEnv): EnvCompatWarning[] {
  const warnings: EnvCompatWarning[] = [];
  const channelKeys = new Set(
    (configFields as readonly ConfigField[])
      .filter((field) => field.path.startsWith('channels[].') && field.envKey)
      .map((field) => field.envKey!),
  );
  for (const [alias, newKey] of legacyEnvAliases) {
    if (channelKeys.has(newKey)) channelKeys.add(alias);
  }

  for (const key of channelKeys) {
    if (env[key] === undefined) continue;
    warnings.push({
      envKey: key,
      aliasFor: legacyEnvAliases.get(key) || key,
      message: `${key} is export-only in config v2; configure channel settings in ~/.codelark/config.toml.`,
    });
  }
  return warnings;
}

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
  const warnings: EnvCompatWarning[] = channelEnvKeyWarnings(env);
  const envByPath = new Map<string, string>();

  for (const field of Object.values(findConfigFieldsByEnv())) {
    if (!field.envKey || !field.parseEnv) continue;
    if (!field.scopes.includes('env')) continue;
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
    setConfigPath(patch, field.path, parsed);
    envByPath.set(field.path, valueSource);
  }

  return { patch, warnings, envByPath };
}

function findConfigFieldsByEnv() {
  const fields: Record<string, ConfigField> = {};
  for (const field of configFields as readonly ConfigField[]) {
    if (field.envKey) fields[field.path] = field;
  }
  return fields;
}
