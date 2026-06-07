import {
  DEFAULT_WORKSPACE_ROOT,
  expandHomePath,
} from '../../configuration/index.js';
import type { ConfigPath } from '../../configuration/fields-types.js';
import { createConfigService } from '../../configuration/service.js';

export interface LegacySettingReader {
  getSetting(key: string): string | null | undefined;
}

export interface GlobalConfigFallbackOptions {
  store?: LegacySettingReader;
}

export function parseLegacyBoolean(value: string | null | undefined): boolean | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'on', 'yes'].includes(normalized)) return true;
  if (['false', '0', 'off', 'no'].includes(normalized)) return false;
  return undefined;
}

export function getGlobalConfigValue<T>(
  path: ConfigPath,
  _legacySettingKey: string | undefined,
  _parseLegacy: (value: string) => T | undefined,
  _options?: GlobalConfigFallbackOptions,
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
  legacySettingKey: string,
  options?: GlobalConfigFallbackOptions,
): string | undefined {
  return getGlobalConfigValue<string>(path, legacySettingKey, (value) => value || undefined, options);
}

export function getGlobalBooleanConfig(
  path: ConfigPath,
  legacySettingKey: string,
  options?: GlobalConfigFallbackOptions,
): boolean | undefined {
  return getGlobalConfigValue<boolean>(path, legacySettingKey, parseLegacyBoolean, options);
}

export function getGlobalWorkspaceRoot(options?: GlobalConfigFallbackOptions): string {
  return expandHomePath(getGlobalConfigValue<string>(
    'bridge.defaultWorkspace',
    'bridge_default_workspace_root',
    (value) => value || undefined,
    options,
  ) || DEFAULT_WORKSPACE_ROOT) || DEFAULT_WORKSPACE_ROOT;
}
