import type { z } from 'zod';

export type ConfigSourceKind =
  | 'defaults'
  | 'home'
  | 'local'
  | 'env'
  | 'cli'
  | 'channel'
  | 'session'
  | 'request';

export type ConfigWriteScope = 'home' | 'local' | 'channel' | 'session' | 'env' | 'cli';
export type ConfigPath = string;

export interface ConfigField<T = unknown> {
  path: ConfigPath;
  tomlPath: string;
  scopes: readonly ConfigWriteScope[];
  schema: z.ZodType<T>;
  envKey?: string;
  cliOption?: string;
  commandAliases?: readonly string[];
  defaultWriteScope?: 'home' | 'local' | 'channel' | 'session';
  secret?: boolean;
  runtimeSettingsKey?: string;
  processEnvKey?: string;
  parseEnv?: (value: string) => unknown;
  formatEnv?: (value: unknown) => string | undefined;
}

export interface SourceRef {
  source: ConfigSourceKind;
  file?: string;
  env?: string;
  cli?: string;
}

export type ProvenanceMap = Map<ConfigPath, SourceRef>;
