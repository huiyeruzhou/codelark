import { configFields } from './fields.js';
import { getConfigPath } from './path-access.js';
import { getDefaultChannel, valueToString } from './merge.js';
import type { ConfigV2 } from './schema.js';
import type { ConfigField } from './fields-types.js';

function channelFieldValue(config: ConfigV2, fieldPath: string): unknown {
  const channel = getDefaultChannel(config);
  const relative = fieldPath.replace('channels[].', '');
  return getConfigPath(channel, relative);
}

function runtimeSettingsValue(field: ConfigField, raw: unknown): string | undefined {
  if (field.path === 'runtime.codex.yoloMode') {
    return raw === 'on' || raw === 'yolo' ? 'yolo' : 'normal';
  }
  if (field.path === 'runtime.claude.yoloMode') {
    return raw === 'on' || raw === 'yolo' ? 'bypassPermissions' : 'default';
  }
  return field.formatEnv ? field.formatEnv(raw) : valueToString(raw);
}

export function exportRuntimeSettings(config: ConfigV2): Map<string, string> {
  const settings = new Map<string, string>();
  settings.set('remote_bridge_enabled', 'true');
  settings.set('bridge_channel_instances_json', JSON.stringify(config.channels));
  settings.set('bridge_feishu_enabled', getDefaultChannel(config).enabled ? 'true' : 'false');

  for (const field of configFields as readonly ConfigField[]) {
    if (!field.runtimeSettingsKey) continue;
    const raw = field.path.startsWith('channels[].')
      ? channelFieldValue(config, field.path)
      : getConfigPath(config, field.path);
    const value = runtimeSettingsValue(field, raw);
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
    const value = field.formatEnv ? field.formatEnv(raw) : valueToString(raw);
    if (value !== undefined) env[field.processEnvKey] = value;
  }
  return env;
}
