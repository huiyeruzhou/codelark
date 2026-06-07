import { createConfigService, type ConfigServiceOptions } from './service.js';
import { exportRuntimeSettings } from './projections.js';
import type { ConfigV2 } from './schema.js';

export interface RuntimeSettingsProjection {
  settings: Map<string, string>;
  config: ConfigV2;
}

export function loadRuntimeSettingsProjection(
  options: ConfigServiceOptions = {},
): RuntimeSettingsProjection {
  const service = createConfigService(options);
  const effective = service.snapshot().config;
  return {
    settings: exportRuntimeSettings(effective),
    config: effective,
  };
}

export function loadRuntimeSettings(options: ConfigServiceOptions = {}): Map<string, string> {
  return loadRuntimeSettingsProjection(options).settings;
}
