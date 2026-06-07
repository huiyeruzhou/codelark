import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'smol-toml';
import { envToConfigPatch } from './env-compat.js';
import type { EnvCompatWarning } from './env-compat.js';
import type { ConfigSourceKind, ProvenanceMap, SourceRef } from './fields.js';
import {
  loadTomlFileWithNodeConfig,
  markLayerProvenance,
  mergePatch,
  mergePatchesWithNodeConfig,
  type ConfigLayer,
} from './merge.js';
import { DEFAULT_CODELARK_HOME } from './paths.js';
import { configPatchSchema, configToTomlShape, tomlToConfigPatch, type ConfigPatch } from './schema.js';

// 配置来源层：集中处理 defaults/home/local/channel/session TOML 的路径、I/O，以及 node-config 静态 baseline。
// 这里可以做来源合法性和 home channel materialize，但不解释 runtime/channel/session 的业务含义。

export interface ConfigPaths {
  defaultsToml: string;
  homeToml: string;
  localToml?: string;
  channelConfigDir: string;
  sessionConfigDir: string;
}

export interface SourceLoadResult {
  patch: ConfigPatch;
  file: string;
}

export interface StaticConfigBaseline {
  layer: ConfigLayer;
  envPatch: ReturnType<typeof envToConfigPatch>;
  warnings: EnvCompatWarning[];
  homeWriteback?: {
    file: string;
    patch: ConfigPatch;
  };
}

export function defaultCodelarkHome(): string {
  return process.env.CODELARK_HOME || DEFAULT_CODELARK_HOME;
}

export function resolveConfigPaths(options: {
  codelarkHome?: string;
  cwd?: string;
} = {}): ConfigPaths {
  const codelarkHome = options.codelarkHome || defaultCodelarkHome();
  return {
    defaultsToml: path.join(path.dirname(fileURLToPath(import.meta.url)), 'defaults.toml'),
    homeToml: path.join(codelarkHome, 'config.toml'),
    localToml: findLocalConfig(options.cwd),
    channelConfigDir: path.join(codelarkHome, 'config', 'channels'),
    sessionConfigDir: path.join(codelarkHome, 'config', 'sessions'),
  };
}

export function findLocalConfig(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  const direct = path.join(cwd, '.codelark', 'config.toml');
  if (fs.existsSync(direct)) return direct;
  const dotfile = path.join(cwd, '.codelark.toml');
  if (fs.existsSync(dotfile)) return dotfile;
  return direct;
}

export function readTomlConfig(file: string): SourceLoadResult | null {
  const parsed = loadTomlFileWithNodeConfig(file);
  return parsed === null ? null : { file, patch: tomlToConfigPatch(parsed) };
}

export function readDefaultsConfig(file: string): SourceLoadResult {
  const loaded = readTomlConfig(file);
  if (!loaded) throw new Error(`缺少默认配置 TOML：${file}`);
  return loaded;
}

export function writeTomlConfig(file: string, patch: ConfigPatch): void {
  const parsed = configPatchSchema.parse(patch);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, stringify(configToTomlShape(parsed)), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function channelTomlPath(paths: ConfigPaths, channelId: string): string {
  return path.join(paths.channelConfigDir, `${channelId}.toml`);
}

export function sessionTomlPath(paths: ConfigPaths, sessionId: string): string {
  return path.join(paths.sessionConfigDir, `${sessionId}.toml`);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function defaultChannelTemplate(defaults: ConfigPatch, id: string): NonNullable<ConfigPatch['channels']>[number] {
  const defaultChannel = defaults.channels?.find((entry) => entry.id === id)
    || defaults.channels?.find((entry) => entry.id === 'feishu-default');
  if (!defaultChannel) {
    throw new Error('defaults.toml 必须定义 feishu-default 通道。');
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

export function materializeHomeChannelPatch(defaults: ConfigPatch, current: ConfigPatch, patch: ConfigPatch): ConfigPatch {
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

function sanitizeStaticSource(ref: SourceRef, patch: ConfigPatch): { patch: ConfigPatch; warnings: EnvCompatWarning[] } {
  const source = ref.source;
  if (source !== 'defaults' && source !== 'home' && patch.channels && patch.channels.length > 0) {
    if (source === 'local') {
      const { channels: _ignoredChannels, ...withoutChannels } = patch;
      return {
        patch: withoutChannels,
        warnings: [{
          source,
          file: ref.file,
          path: 'channels',
          message: `项目级配置 ${ref.file || 'local'} 中的 channels 不会生效；通道配置只能写入 ~/.codelark/config.toml，已忽略该字段。`,
        }],
      };
    }
    throw new Error(`配置来源 ${source} 不能定义 channels；通道配置只能写入 home config.toml。`);
  }
  return { patch, warnings: [] };
}

function staticProvenance(sources: ConfigLayer[]): ProvenanceMap {
  const provenance: ProvenanceMap = new Map();
  for (const source of sources) markLayerProvenance(provenance, source);
  return provenance;
}

function staticLayer(ref: SourceRef, patch: ConfigPatch, envByPath?: Map<string, string>): {
  layer: ConfigLayer;
  warnings: EnvCompatWarning[];
} {
  const sanitized = sanitizeStaticSource(ref, patch);
  return {
    layer: { ref, patch: sanitized.patch, ...(envByPath ? { envByPath } : {}) },
    warnings: sanitized.warnings,
  };
}

export function loadStaticConfigBaseline(paths: ConfigPaths, env: NodeJS.ProcessEnv, cli?: ConfigPatch): StaticConfigBaseline {
  const defaults = readDefaultsConfig(paths.defaultsToml).patch;
  const warnings: EnvCompatWarning[] = [];
  const defaultsLayer = staticLayer({ source: 'defaults', file: paths.defaultsToml }, defaults);
  warnings.push(...defaultsLayer.warnings);
  const sources: ConfigLayer[] = [defaultsLayer.layer];

  const home = readTomlConfig(paths.homeToml);
  let homeWriteback: StaticConfigBaseline['homeWriteback'];
  if (home) {
    const materialized = materializeHomeChannelPatch(defaults, {}, home.patch);
    if (!patchesEqual(home.patch, materialized)) {
      homeWriteback = { file: home.file, patch: materialized };
    }
    const homeLayer = staticLayer({ source: 'home', file: home.file }, materialized);
    warnings.push(...homeLayer.warnings);
    sources.push(homeLayer.layer);
  }

  if (paths.localToml) {
    const local = readTomlConfig(paths.localToml);
    if (local) {
      const localLayer = staticLayer({ source: 'local', file: local.file }, local.patch);
      warnings.push(...localLayer.warnings);
      sources.push(localLayer.layer);
    }
  }

  const envPatch = envToConfigPatch(env);
  warnings.push(...envPatch.warnings);
  const envLayer = staticLayer({ source: 'env' }, envPatch.patch, envPatch.envByPath);
  warnings.push(...envLayer.warnings);
  sources.push(envLayer.layer);
  if (cli) {
    const cliLayer = staticLayer({ source: 'cli' }, cli);
    warnings.push(...cliLayer.warnings);
    sources.push(cliLayer.layer);
  }

  return {
    layer: {
      ref: { source: 'defaults', file: paths.defaultsToml },
      patch: mergePatchesWithNodeConfig(sources),
      provenance: staticProvenance(sources),
    },
    envPatch,
    warnings,
    ...(homeWriteback ? { homeWriteback } : {}),
  };
}
