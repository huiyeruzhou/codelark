import { configV2ToLegacyConfig } from './legacy.js';
import { createConfigService, type ConfigServiceOptions } from './service.js';
import type { Config } from './index.js';

export interface RuntimeSettingsProjection {
  settings: Map<string, string>;
  legacyConfig: Config;
}

export function loadRuntimeSettingsProjection(
  options: ConfigServiceOptions = {},
): RuntimeSettingsProjection {
  const service = createConfigService(options);
  const effective = service.snapshot().config;
  return {
    settings: service.exportRuntimeSettings(),
    legacyConfig: configV2ToLegacyConfig(effective),
  };
}

export function loadRuntimeSettings(options: ConfigServiceOptions = {}): Map<string, string> {
  return loadRuntimeSettingsProjection(options).settings;
}
