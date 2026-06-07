import { configFields, findConfigField } from './fields.js';
import type { ConfigField, ConfigPath, ConfigSourceKind, ConfigWriteScope, SourceRef } from './fields.js';
import type { EnvCompatWarning } from './env-compat.js';
import { mergeConfigLayers, mergePatch, type ConfigLayer, type MergeResult } from './merge.js';
import {
  runConfigMigrations,
  type ConfigMigration,
  type RunConfigMigrationsResult,
} from './migrations/index.js';
import { getConfigPath, unsetConfigPath } from './path-access.js';
import {
  channelTomlPath,
  defaultCodelarkHome,
  readDefaultsConfig,
  readTomlConfig,
  resolveConfigPaths,
  sessionTomlPath,
  writeTomlConfig,
  loadStaticConfigBaseline,
  materializeHomeChannelPatch,
  type ConfigPaths,
} from './sources.js';
import { configPatchSchema, type ConfigPatch } from './schema.js';

// ConfigService 是配置模块的统一调用入口：负责迁移、按 scope 构造 effective config、来源解释和 TOML 写回。
// 它不负责把配置翻译成子进程 env、runtime settings 或通道选择，这些业务语义由调用方模块处理。

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
}

export interface ConfigServiceOptions {
  codelarkHome?: string;
  cwd?: string;
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
    throw new Error(`未知配置字段：${path}`);
  }
  if (!field.scopes.includes(scope)) {
    throw new Error(`配置字段 ${path} 不能写入 ${scope} 作用域。`);
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
    if (source === 'local') {
      const { channels: _ignoredChannels, ...withoutChannels } = parsed;
      return withoutChannels;
    }
    throw new Error(`配置来源 ${source} 不能定义 channels；通道配置只能写入 home config.toml。`);
  }
  return parsed;
}

function maskSecretValue(value: unknown): unknown {
  if (typeof value !== 'string') return value === undefined ? undefined : '****';
  if (value.length <= 4) return '****';
  return `${'*'.repeat(value.length - 4)}${value.slice(-4)}`;
}

export function createConfigService(options: ConfigServiceOptions = {}): ConfigService {
  const codelarkHome = options.codelarkHome || defaultCodelarkHome();
  const cwd = options.cwd || process.cwd();
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
          : cwd,
    });
  }

  function layer(ref: SourceRef, patch: ConfigPatch): ConfigLayer {
    return { ref, patch: validateSourcePatch(ref.source, patch) };
  }

  function fileLayer(source: ConfigSourceKind, loaded: ReturnType<typeof readTomlConfig>): ConfigLayer | null {
    if (!loaded) return null;
    return layer({ source, file: loaded.file }, loaded.patch);
  }

  function buildLayers(scope?: ConfigScope, request?: ConfigPatch): { layers: ConfigLayer[]; warnings: EnvCompatWarning[] } {
    const paths = pathsFor(scope);
    const baseline = loadStaticConfigBaseline(paths, env, cli);
    if (baseline.homeWriteback) {
      writeTomlConfig(baseline.homeWriteback.file, baseline.homeWriteback.patch);
    }
    const layers: ConfigLayer[] = [baseline.layer];

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

    return { layers, warnings: baseline.warnings };
  }

  function snapshot(scope?: ConfigScope, request?: ConfigPatch): EffectiveConfig {
    const built = buildLayers(scope, request);
    const merged = mergeConfigLayers(built.layers);
    return { ...merged, warnings: built.warnings };
  }

  function targetFile(target: ConfigWriteTarget): string {
    const paths = resolveConfigPaths({ codelarkHome, cwd: target.kind === 'local' ? target.cwd : undefined });
    if (target.kind === 'home') return paths.homeToml;
    if (target.kind === 'local') return paths.localToml!;
    if (target.kind === 'channel') return channelTomlPath(paths, target.channelId);
    return sessionTomlPath(paths, target.sessionId);
  }

  function writeTargetPatch(target: ConfigWriteTarget, patch: ConfigPatch, replace = false): void {
    const file = targetFile(target);
    const current = replace ? {} : readTomlConfig(file)?.patch || {};
    const paths = resolveConfigPaths({ codelarkHome, cwd: target.kind === 'local' ? target.cwd : undefined });
    const writablePatch = target.kind === 'home'
      ? materializeHomeChannelPatch(readDefaultsConfig(paths.defaultsToml).patch, current, patch)
      : patch;
    writeTomlConfig(file, replace ? writablePatch : mergePatch(current, writablePatch));
  }

  return {
    migrationResult,
    snapshot,
    get<T = unknown>(path: ConfigPath, scope?: ConfigScope, request?: ConfigPatch): T {
      if (path.startsWith('channels[].')) {
        throw new Error(
          `配置路径 ${path} 是字段模板，不是具体值路径；请读取 snapshot().config.channels 后在调用方选择具体通道。`,
        );
      }
      return getConfigPath(snapshot(scope, request).config, path) as T;
    },
    resolve(path: ConfigPath, scope?: ConfigScope, request?: ConfigPatch): ConfigResolveResult {
      if (path.startsWith('channels[].')) {
        throw new Error(
          `配置路径 ${path} 是字段模板，不是具体值路径；请读取 snapshot().config.channels 后在调用方选择具体通道。`,
        );
      }
      const effective = snapshot(scope, request);
      const provenance = effective.provenance.get(path) || { source: 'defaults' as const };
      return {
        value: getConfigPath(effective.config, path),
        ...provenance,
        scope,
      };
    },
    explain(path?: ConfigPath, scope?: ConfigScope): ConfigExplainEntry[] {
      const paths = path
        ? [path]
        : configFields.map((field) => field.path).filter((entry) => !entry.startsWith('channels[].'));
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
      const paths = resolveConfigPaths({ codelarkHome, cwd: target.kind === 'local' ? target.cwd : undefined });
      writeTomlConfig(file, target.kind === 'home'
        ? materializeHomeChannelPatch(readDefaultsConfig(paths.defaultsToml).patch, {}, current)
        : current);
    },
  };
}
