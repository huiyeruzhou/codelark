import type { ConfigPath } from './fields-types.js';
import { createConfigService, type ConfigService, type ConfigServiceOptions } from './service.js';
import type { ConfigPatch } from './schema.js';

function serviceFrom(serviceOrOptions: ConfigService | ConfigServiceOptions = {}): ConfigService {
  return 'snapshot' in serviceOrOptions
    ? serviceOrOptions
    : createConfigService({ ...serviceOrOptions, migrate: false });
}

export function setSessionConfigPatch(
  sessionId: string,
  patch: ConfigPatch,
  serviceOrOptions: ConfigService | ConfigServiceOptions = {},
): void {
  serviceFrom(serviceOrOptions).set({ kind: 'session', sessionId }, patch);
}

export function unsetSessionConfigPath(
  sessionId: string,
  path: ConfigPath,
  serviceOrOptions: ConfigService | ConfigServiceOptions = {},
): void {
  serviceFrom(serviceOrOptions).unset({ kind: 'session', sessionId }, path);
}

export function setOrUnsetSessionConfigPath(
  sessionId: string,
  path: ConfigPath,
  value: unknown,
  patchForValue: (value: never) => ConfigPatch,
  serviceOrOptions: ConfigService | ConfigServiceOptions = {},
): void {
  if (value === undefined || value === '') {
    unsetSessionConfigPath(sessionId, path, serviceOrOptions);
    return;
  }
  setSessionConfigPatch(sessionId, patchForValue(value as never), serviceOrOptions);
}
