import type { ConfigPath, ConfigSourceKind } from './fields-types.js';
import { createConfigService, type ConfigScope, type ConfigService, type ConfigServiceOptions, type EffectiveConfig } from './service.js';
import type { ConfigPatch } from './schema.js';

export function configSourceRank(source: ConfigSourceKind | undefined): number {
  switch (source) {
    case 'request': return 7;
    case 'session': return 6;
    case 'channel': return 5;
    case 'cli': return 4;
    case 'env': return 3;
    case 'local': return 2;
    case 'home': return 1;
    case 'defaults':
    default: return 0;
  }
}

export function getEffectiveConfigSource(effective: EffectiveConfig, path: ConfigPath): ConfigSourceKind | undefined {
  return effective.provenance.get(path)?.source;
}

export function isEffectiveConfigSource(
  effective: EffectiveConfig,
  path: ConfigPath,
  sources: readonly ConfigSourceKind[],
): boolean {
  const source = getEffectiveConfigSource(effective, path);
  return source !== undefined && sources.includes(source);
}

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
