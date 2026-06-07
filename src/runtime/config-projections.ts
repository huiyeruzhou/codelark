import { configFields } from '../configuration/fields.js';
import { getConfigPath } from '../configuration/path-access.js';
import type { ChannelConfigV2, ConfigV2 } from '../configuration/schema.js';
import type { ConfigField } from '../configuration/fields.js';

// 运行时投影层：把统一 ConfigV2 派生成旧 runtime settings Map 或子进程 env。
// 这些输出是应用边界语义，刻意放在 runtime 模块而不是 ConfigService 内。

function getProjectionChannel(config: ConfigV2): ChannelConfigV2 {
  return config.channels.find((channel) => channel.id === 'feishu-default')
    || config.channels[0]!;
}

function valueToString(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (Array.isArray(value)) return value.join(',');
  return String(value);
}

function channelFieldValue(config: ConfigV2, fieldPath: string): unknown {
  const channel = getProjectionChannel(config);
  const relative = fieldPath.replace('channels[].', '');
  return getConfigPath(channel, relative);
}

function runtimeSettingsValue(field: ConfigField, raw: unknown): string | undefined {
  if (field.path === 'runtime.codex.yoloMode') {
    return raw === 'on' || raw === 'yolo' ? 'yolo' : 'normal';
  }
  return field.formatEnv ? field.formatEnv(raw) : valueToString(raw);
}

export function exportRuntimeSettings(config: ConfigV2): Map<string, string> {
  const settings = new Map<string, string>();
  settings.set('remote_bridge_enabled', 'true');
  settings.set('bridge_channel_instances_json', JSON.stringify(config.channels));
  settings.set('bridge_feishu_enabled', getProjectionChannel(config).enabled ? 'true' : 'false');

  for (const field of configFields as readonly ConfigField[]) {
    if (!field.runtimeSettingsKey) continue;
    const raw = field.path.startsWith('channels[].')
      ? channelFieldValue(config, field.path)
      : getConfigPath(config, field.path);
    const value = field.path === 'runtime.claude.permissionMode'
      && raw === 'default'
      && (config.runtime.claude.yoloMode === 'on' || config.runtime.claude.yoloMode === 'yolo')
      ? 'bypassPermissions'
      : runtimeSettingsValue(field, raw);
    if (value !== undefined) settings.set(field.runtimeSettingsKey, value);
  }

  const codexModel = settings.get('bridge_default_model');
  if (codexModel) settings.set('default_model', codexModel);
  return settings;
}

export function exportProcessEnv(config: ConfigV2): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const field of configFields as readonly ConfigField[]) {
    if (!field.processEnvKey) continue;
    if (field.path === 'channels[].enabled') {
      env[field.processEnvKey] = config.channels
        .filter((channel) => channel.enabled)
        .map((channel) => channel.provider)
        .join(',');
      continue;
    }
    const raw = field.path.startsWith('channels[].')
      ? channelFieldValue(config, field.path)
      : getConfigPath(config, field.path);
    const value = field.path === 'runtime.claude.permissionMode'
      && raw === 'default'
      && (config.runtime.claude.yoloMode === 'on' || config.runtime.claude.yoloMode === 'yolo')
      ? 'bypassPermissions'
      : field.formatEnv ? field.formatEnv(raw) : valueToString(raw);
    if (value !== undefined) env[field.processEnvKey] = value;
  }
  return env;
}
