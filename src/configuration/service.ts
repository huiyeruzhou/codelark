import { configFields, findConfigField } from './fields.js';
import type { ConfigField, ConfigPath, ConfigSourceKind, ConfigWriteScope, SourceRef } from './fields-types.js';
import { envToConfigPatch, type EnvCompatWarning } from './env-compat.js';
import { mergeConfigLayers, mergePatch, type ConfigLayer, type MergeResult } from './merge.js';
import {
  runConfigMigrations,
  type ConfigMigration,
  type RunConfigMigrationsResult,
} from './migrations/index.js';
import { getConfigPath, unsetConfigPath } from './path-access.js';
import { exportProcessEnv, exportRuntimeSettings } from './projections.js';
import {
  channelTomlPath,
  defaultCodelarkHome,
  readDefaultsConfig,
  readTomlConfig,
  resolveConfigPaths,
  sessionTomlPath,
  writeTomlConfig,
  type ConfigPaths,
} from './sources.js';
import { configPatchSchema, type ConfigPatch, type ConfigV2 } from './schema.js';

export type ConfigScope =
  | { kind: 'global'; cwd?: string }
  | { kind: 'local'; cwd: string }
  | { kind: 'channel'; channelId: string; provider: 'feishu'; cwd?: string }
  | { kind: 'session'; sessionId: string; channelId?: string; provider?: 'feishu'; cwd?: string };

export type ConfigWriteTarget =
  | { kind: 'home' }
  | { kind: 'local'; cwd: string }
  | { kind: 'channel'; channelId: string; provider: 'feishu' }
  | { kind: 'session'; sessionId: string };

export interface ConfigResolveResult {
  value: unknown;
  source: ConfigSourceKind;
  file?: string;
  env?: string;
  cli?: string;
  scope?: ConfigScope;
}

export interface ConfigExplainEntry extends ConfigResolveResult {
  path: ConfigPath;
  secret?: boolean;
}

export interface EffectiveConfig extends MergeResult {
  warnings: EnvCompatWarning[];
}

export interface ConfigService {
  readonly migrationResult?: RunConfigMigrationsResult;
  snapshot(scope?: ConfigScope, request?: ConfigPatch): EffectiveConfig;
  get<T = unknown>(path: ConfigPath, scope?: ConfigScope, request?: ConfigPatch): T;
  resolve(path: ConfigPath, scope?: ConfigScope, request?: ConfigPatch): ConfigResolveResult;
  explain(path?: ConfigPath, scope?: ConfigScope): ConfigExplainEntry[];
  set(target: ConfigWriteTarget, patch: ConfigPatch): void;
  replace(target: ConfigWriteTarget, patch: ConfigPatch): void;
  unset(target: ConfigWriteTarget, path: ConfigPath): void;
  exportRuntimeSettings(scope?: ConfigScope): Map<string, string>;
  exportProcessEnv(scope?: ConfigScope): NodeJS.ProcessEnv;
}

export interface ConfigServiceOptions {
  codelarkHome?: string;
  env?: NodeJS.ProcessEnv;
  cli?: ConfigPatch;
  migrate?: boolean;
  migrations?: ConfigMigration[];
  migrationNow?: () => Date;
}

function writeScopeForTarget(target: ConfigWriteTarget): ConfigWriteScope {
  if (target.kind === 'home') return 'home';
  return target.kind;
}

function channelConfigPath(key: string): ConfigPath {
  return `channels[].config.${key}`;
}

function patchPaths(patch: ConfigPatch): ConfigPath[] {
  const paths: ConfigPath[] = [];
  if (patch.session) {
    for (const key of Object.keys(patch.session)) paths.push(`session.${key}`);
  }
  if (patch.bridge) {
    for (const key of Object.keys(patch.bridge)) paths.push(`bridge.${key}`);
  }
  if (patch.runtime?.agent !== undefined) paths.push('runtime.agent');
  if (patch.runtime?.codex) {
    for (const key of Object.keys(patch.runtime.codex)) paths.push(`runtime.codex.${key}`);
  }
  if (patch.runtime?.claude) {
    for (const key of Object.keys(patch.runtime.claude)) paths.push(`runtime.claude.${key}`);
  }
  for (const channel of patch.channels || []) {
    if (channel.enabled !== undefined) paths.push('channels[].enabled');
    if (channel.config) {
      for (const key of Object.keys(channel.config)) paths.push(channelConfigPath(key));
    }
  }
  return paths;
}

function requireWritable(scope: ConfigWriteScope, path: ConfigPath): void {
  const field = findConfigField(path) as ConfigField | undefined;
  if (!field) {
    throw new Error(`Unknown config field: ${path}`);
  }
  if (!field.scopes.includes(scope)) {
    throw new Error(`Config field ${path} cannot be written to ${scope} scope.`);
  }
}

function validateWritablePatch(target: ConfigWriteTarget, patch: ConfigPatch): ConfigPatch {
  const parsed = configPatchSchema.parse(patch);
  const scope = writeScopeForTarget(target);
  for (const path of patchPaths(parsed)) requireWritable(scope, path);
  return parsed;
}

function validateWritablePath(target: ConfigWriteTarget, path: ConfigPath): void {
  requireWritable(writeScopeForTarget(target), path);
}

function validateSourcePatch(source: ConfigSourceKind, patch: ConfigPatch): ConfigPatch {
  const parsed = configPatchSchema.parse(patch);
  if (source !== 'defaults' && source !== 'home' && parsed.channels && parsed.channels.length > 0) {
    throw new Error(`Config source ${source} cannot define channels; configure channels only in home config.toml.`);
  }
  return parsed;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function defaultChannelTemplate(defaults: ConfigPatch, id: string): NonNullable<ConfigPatch['channels']>[number] {
  const defaultChannel = defaults.channels?.find((entry) => entry.id === id)
    || defaults.channels?.find((entry) => entry.id === 'feishu-default');
  if (!defaultChannel) {
    throw new Error('defaults.toml must define a feishu-default channel.');
  }
  return { ...clone(defaultChannel), id };
}

function materializeHomeChannel(
  defaults: ConfigPatch,
  channel: NonNullable<ConfigPatch['channels']>[number],
): NonNullable<ConfigPatch['channels']>[number] {
  const template = defaultChannelTemplate(defaults, channel.id);
  return {
    ...template,
    ...channel,
    id: channel.id,
    config: {
      ...(template.config || {}),
      ...(channel.config || {}),
    },
  };
}

function materializeHomeChannelPatch(defaults: ConfigPatch, current: ConfigPatch, patch: ConfigPatch): ConfigPatch {
  if (!patch.channels || patch.channels.length === 0) return patch;
  const materialized: ConfigPatch = {};
  for (const channel of patch.channels) {
    const currentChannel = current.channels?.find((entry) => entry.id === channel.id);
    mergePatch(materialized, { channels: [materializeHomeChannel(defaults, currentChannel || channel)] });
  }
  mergePatch(materialized, { channels: patch.channels });
  return {
    ...patch,
    channels: materialized.channels,
  };
}

function patchesEqual(left: ConfigPatch, right: ConfigPatch): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function maskSecretValue(value: unknown): unknown {
  if (typeof value !== 'string') return value === undefined ? undefined : '****';
  if (value.length <= 4) return '****';
  return `${'*'.repeat(value.length - 4)}${value.slice(-4)}`;
}

export function createConfigService(options: ConfigServiceOptions = {}): ConfigService {
  const codelarkHome = options.codelarkHome || defaultCodelarkHome();
  const migrationResult = options.migrate === false
    ? undefined
    : runConfigMigrations({
      codelarkHome,
      ...(options.migrations ? { migrations: options.migrations } : {}),
      ...(options.migrationNow ? { now: options.migrationNow } : {}),
    });
  const env = options.env || process.env;
  const cli = options.cli ? configPatchSchema.parse(options.cli) : undefined;

  function pathsFor(scope?: ConfigScope): ConfigPaths {
    return resolveConfigPaths({
      codelarkHome,
      cwd: scope?.kind === 'local'
        ? scope.cwd
        : scope && 'cwd' in scope
          ? scope.cwd
          : undefined,
    });
  }

  function layer(ref: SourceRef, patch: ConfigPatch): ConfigLayer {
    return { ref, patch: validateSourcePatch(ref.source, patch) };
  }

  function fileLayer(source: ConfigSourceKind, loaded: ReturnType<typeof readTomlConfig>): ConfigLayer | null {
    if (!loaded) return null;
    return layer({ source, file: loaded.file }, loaded.patch);
  }

  function homeLayer(paths: ConfigPaths): ConfigLayer | null {
    const file = paths.homeToml;
    const loaded = readTomlConfig(file);
    if (!loaded) return null;
    const materialized = materializeHomeChannelPatch(readDefaultsConfig(paths.defaultsToml).patch, {}, loaded.patch);
    if (!patchesEqual(loaded.patch, materialized)) {
      writeTomlConfig(file, materialized);
    }
    return layer({ source: 'home', file: loaded.file }, materialized);
  }

  function buildLayers(scope?: ConfigScope, request?: ConfigPatch): { layers: ConfigLayer[]; warnings: EnvCompatWarning[] } {
    const paths = pathsFor(scope);
    const envPatch = envToConfigPatch(env);
    const layers: ConfigLayer[] = [
      layer({ source: 'defaults', file: paths.defaultsToml }, readDefaultsConfig(paths.defaultsToml).patch),
    ];

    const home = homeLayer(paths);
    if (home) layers.push(home);

    if (paths.localToml) {
      const local = fileLayer('local', readTomlConfig(paths.localToml));
      if (local) layers.push(local);
    }

    layers.push({
      ref: { source: 'env' },
      patch: envPatch.patch,
      envByPath: envPatch.envByPath,
    });

    if (cli) layers.push(layer({ source: 'cli' }, cli));

    if (scope?.kind === 'channel' || scope?.kind === 'session') {
      const channelId = scope.kind === 'channel' ? scope.channelId : scope.channelId;
      if (channelId) {
        const channelPath = channelTomlPath(paths, channelId);
        const channel = fileLayer('channel', readTomlConfig(channelPath));
        if (channel) layers.push(channel);
      }
    }

    if (scope?.kind === 'session') {
      const sessionPath = sessionTomlPath(paths, scope.sessionId);
      const session = fileLayer('session', readTomlConfig(sessionPath));
      if (session) layers.push(session);
    }

    if (request) layers.push(layer({ source: 'request' }, request));

    return { layers, warnings: envPatch.warnings };
  }

  function snapshot(scope?: ConfigScope, request?: ConfigPatch): EffectiveConfig {
    const built = buildLayers(scope, request);
    const merged = mergeConfigLayers(built.layers);
    return { ...merged, warnings: built.warnings };
  }

  function resolvedPath(path: ConfigPath, config: ConfigV2): string {
    if (!path.startsWith('channels[].')) return path;
    const id = config.channels.find((channel) => channel.id === 'feishu-default')?.id || config.channels[0]?.id;
    return id ? path.replace('channels[]', `channels.${id}`) : path;
  }

  function valueFor(path: ConfigPath, config: ConfigV2): unknown {
    if (!path.startsWith('channels[].')) return getConfigPath(config, path);
    const channel = config.channels.find((entry) => entry.id === 'feishu-default') || config.channels[0];
    return channel ? getConfigPath(channel, path.replace('channels[].', '')) : undefined;
  }

  function targetFile(target: ConfigWriteTarget): string {
    const paths = resolveConfigPaths({ codelarkHome: options.codelarkHome, cwd: target.kind === 'local' ? target.cwd : undefined });
    if (target.kind === 'home') return paths.homeToml;
    if (target.kind === 'local') return paths.localToml!;
    if (target.kind === 'channel') return channelTomlPath(paths, target.channelId);
    return sessionTomlPath(paths, target.sessionId);
  }

  function writeTargetPatch(target: ConfigWriteTarget, patch: ConfigPatch, replace = false): void {
    const file = targetFile(target);
    const current = replace ? {} : readTomlConfig(file)?.patch || {};
    const paths = resolveConfigPaths({ codelarkHome: options.codelarkHome, cwd: target.kind === 'local' ? target.cwd : undefined });
    const writablePatch = target.kind === 'home'
      ? materializeHomeChannelPatch(readDefaultsConfig(paths.defaultsToml).patch, current, patch)
      : patch;
    writeTomlConfig(file, replace ? writablePatch : mergePatch(current, writablePatch));
  }

  return {
    migrationResult,
    snapshot,
    get<T = unknown>(path: ConfigPath, scope?: ConfigScope, request?: ConfigPatch): T {
      return valueFor(path, snapshot(scope, request).config) as T;
    },
    resolve(path: ConfigPath, scope?: ConfigScope, request?: ConfigPatch): ConfigResolveResult {
      const effective = snapshot(scope, request);
      const provenance = effective.provenance.get(resolvedPath(path, effective.config))
        || effective.provenance.get(path)
        || { source: 'defaults' as const };
      return {
        value: valueFor(path, effective.config),
        ...provenance,
        scope,
      };
    },
    explain(path?: ConfigPath, scope?: ConfigScope): ConfigExplainEntry[] {
      const paths = path ? [path] : configFields.map((field) => field.path);
      return paths.map((entry) => {
        const field = findConfigField(entry);
        const resolved = this.resolve(entry, scope);
        return {
          path: entry,
          secret: field?.secret,
          ...resolved,
          value: field?.secret ? maskSecretValue(resolved.value) : resolved.value,
        };
      });
    },
    set(target: ConfigWriteTarget, patch: ConfigPatch): void {
      const writablePatch = validateWritablePatch(target, patch);
      writeTargetPatch(target, writablePatch);
    },
    replace(target: ConfigWriteTarget, patch: ConfigPatch): void {
      const writablePatch = validateWritablePatch(target, patch);
      writeTargetPatch(target, writablePatch, true);
    },
    unset(target: ConfigWriteTarget, path: ConfigPath): void {
      validateWritablePath(target, path);
      const file = targetFile(target);
      const current = readTomlConfig(file)?.patch || {};
      if (path.startsWith('channels[].')) {
        for (const channel of current.channels || []) {
          unsetConfigPath(channel as Record<string, unknown>, path.replace('channels[].', ''));
        }
      } else {
        unsetConfigPath(current as Record<string, unknown>, path);
      }
      const paths = resolveConfigPaths({ codelarkHome: options.codelarkHome, cwd: target.kind === 'local' ? target.cwd : undefined });
      writeTomlConfig(file, target.kind === 'home'
        ? materializeHomeChannelPatch(readDefaultsConfig(paths.defaultsToml).patch, {}, current)
        : current);
    },
    exportRuntimeSettings(scope?: ConfigScope): Map<string, string> {
      return exportRuntimeSettings(snapshot(scope).config);
    },
    exportProcessEnv(scope?: ConfigScope): NodeJS.ProcessEnv {
      return exportProcessEnv(snapshot(scope).config);
    },
  };
}
