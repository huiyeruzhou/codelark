import type { ConfigPath, ConfigSourceKind } from './fields-types.js';
import { createConfigService, type ConfigScope, type ConfigService, type ConfigServiceOptions } from './service.js';
import type { ConfigPatch } from './schema.js';

export function getConfigValueFromSource<T>(
  service: ConfigService,
  path: ConfigPath,
  source: ConfigSourceKind,
  scope?: ConfigScope,
  request?: ConfigPatch,
): T | undefined {
  const resolved = service.resolve(path, scope, request);
  return resolved.source === source ? resolved.value as T : undefined;
}

export function getSessionConfigOverride<T>(
  sessionId: string | null | undefined,
  path: ConfigPath,
  serviceOrOptions: ConfigService | ConfigServiceOptions = {},
): T | undefined {
  if (!sessionId) return undefined;
  const service = 'snapshot' in serviceOrOptions
    ? serviceOrOptions
    : createConfigService({ ...serviceOrOptions, migrate: false });
  return getConfigValueFromSource<T>(service, path, 'session', {
    kind: 'session',
    sessionId,
  });
}
