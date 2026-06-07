import { DEFAULT_WORKSPACE_ROOT, expandHomePath } from '../../configuration/paths.js';
import type { ConfigPath } from '../../configuration/fields.js';
import { createConfigService } from '../../configuration/service.js';
import type { ConfigV2 } from '../../configuration/schema.js';

export function getGlobalConfigValue<T>(
  path: ConfigPath,
): T | undefined {
  const resolved = createConfigService({ migrate: false }).resolve(path);
  return resolved.value as T;
}

export function getGlobalStringConfig(
  path: ConfigPath,
): string | undefined {
  return getGlobalConfigValue<string>(path) || undefined;
}

export function getGlobalBooleanConfig(
  path: ConfigPath,
): boolean | undefined {
  return getGlobalConfigValue<boolean>(path);
}

export function getGlobalWorkspaceRoot(): string {
  return expandHomePath(getGlobalConfigValue<string>(
    'bridge.defaultWorkspace',
  ) || DEFAULT_WORKSPACE_ROOT) || DEFAULT_WORKSPACE_ROOT;
}

export function getGlobalRuntimeAgent(): 'codex' | 'claude' {
  return getGlobalStringConfig('runtime.agent') === 'claude' ? 'claude' : 'codex';
}

export function getGlobalCodexModel(): string | undefined {
  return getGlobalStringConfig('runtime.codex.model');
}

export function getGlobalDefaultChannelConfig(): ConfigV2['channels'][number]['config'] | undefined {
  const config = createConfigService({ migrate: false }).snapshot().config;
  return (config.channels.find((channel) => channel.id === 'feishu-default') || config.channels[0])?.config;
}
