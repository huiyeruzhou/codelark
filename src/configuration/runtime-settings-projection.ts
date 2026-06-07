import { createConfigService, type ConfigServiceOptions } from './service.js';
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
    settings: service.exportRuntimeSettings(),
    config: effective,
  };
}

export function loadRuntimeSettings(options: ConfigServiceOptions = {}): Map<string, string> {
  return loadRuntimeSettingsProjection(options).settings;
}
