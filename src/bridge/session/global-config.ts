import {
  DEFAULT_WORKSPACE_ROOT,
  expandHomePath,
} from '../../configuration/index.js';
import type { ConfigPath } from '../../configuration/fields-types.js';
import { createConfigService } from '../../configuration/service.js';
import { getBridgeContext } from '../host/context.js';

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

function readLegacySetting(key: string | undefined, options?: GlobalConfigFallbackOptions): string {
  if (!key) return '';
  const explicit = options?.store?.getSetting(key);
  if (explicit) return explicit;
  try {
    return getBridgeContext().store.getSetting(key) || '';
  } catch {
    return '';
  }
}

export function getGlobalConfigValue<T>(
  path: ConfigPath,
  legacySettingKey: string | undefined,
  parseLegacy: (value: string) => T | undefined,
  options?: GlobalConfigFallbackOptions,
): T | undefined {
  try {
    const resolved = createConfigService({ migrate: false }).resolve(path);
    if (resolved.source !== 'defaults') return resolved.value as T;
    const legacy = readLegacySetting(legacySettingKey, options);
    if (legacy) {
      const parsed = parseLegacy(legacy);
      if (parsed !== undefined) return parsed;
    }
    return resolved.value as T;
  } catch (error) {
    console.error(`[bridge-manager] Failed to resolve global TOML config ${path}:`, error);
    const legacy = readLegacySetting(legacySettingKey, options);
    return legacy ? parseLegacy(legacy) : undefined;
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
