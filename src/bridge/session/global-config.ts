import {
  DEFAULT_WORKSPACE_ROOT,
  expandHomePath,
} from '../../configuration/index.js';
import type { ConfigPath } from '../../configuration/fields-types.js';
import { createConfigService } from '../../configuration/service.js';

export function getGlobalConfigValue<T>(
  path: ConfigPath,
): T | undefined {
  try {
    const resolved = createConfigService({ migrate: false }).resolve(path);
    return resolved.value as T;
  } catch (error) {
    console.error(`[bridge-manager] Failed to resolve global TOML config ${path}:`, error);
    return undefined;
  }
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
