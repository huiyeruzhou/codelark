import { envToConfigPatch } from './env-compat.js';
import type { ConfigSourceKind, ProvenanceMap, SourceRef } from './fields-types.js';
import { markLayerProvenance, mergePatch, mergePatchesWithNodeConfig, type ConfigLayer } from './merge.js';
import type { ConfigPatch } from './schema.js';
import { readTomlConfig, writeTomlConfig, type ConfigPaths, type SourceLoadResult } from './sources.js';

export interface StaticConfigBaseline {
  layer: ConfigLayer;
  envPatch: ReturnType<typeof envToConfigPatch>;
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

function validateStaticSource(source: ConfigSourceKind, patch: ConfigPatch): void {
  if (source !== 'defaults' && source !== 'home' && patch.channels && patch.channels.length > 0) {
    throw new Error(`Config source ${source} cannot define channels; configure channels only in home config.toml.`);
  }
}

function readDefaultsWithNodeConfig(file: string): SourceLoadResult {
  const loaded = readTomlConfig(file);
  if (!loaded) throw new Error(`Missing defaults TOML: ${file}`);
  return loaded;
}

function staticProvenance(sources: ConfigLayer[]): ProvenanceMap {
  const provenance: ProvenanceMap = new Map();
  for (const source of sources) markLayerProvenance(provenance, source);
  return provenance;
}

function staticLayer(ref: SourceRef, patch: ConfigPatch, envByPath?: Map<string, string>): ConfigLayer {
  validateStaticSource(ref.source, patch);
  return { ref, patch, ...(envByPath ? { envByPath } : {}) };
}

export function loadStaticConfigBaseline(paths: ConfigPaths, env: NodeJS.ProcessEnv, cli?: ConfigPatch): StaticConfigBaseline {
  const defaults = readDefaultsWithNodeConfig(paths.defaultsToml).patch;
  const sources: ConfigLayer[] = [
    staticLayer({ source: 'defaults', file: paths.defaultsToml }, defaults),
  ];

  const home = readTomlConfig(paths.homeToml);
  if (home) {
    const materialized = materializeHomeChannelPatch(defaults, {}, home.patch);
    if (!patchesEqual(home.patch, materialized)) writeTomlConfig(home.file, materialized);
    sources.push(staticLayer({ source: 'home', file: home.file }, materialized));
  }

  if (paths.localToml) {
    const local = readTomlConfig(paths.localToml);
    if (local) sources.push(staticLayer({ source: 'local', file: local.file }, local.patch));
  }

  const envPatch = envToConfigPatch(env);
  sources.push(staticLayer({ source: 'env' }, envPatch.patch, envPatch.envByPath));
  if (cli) sources.push(staticLayer({ source: 'cli' }, cli));

  return {
    layer: {
      ref: { source: 'defaults', file: paths.defaultsToml },
      patch: mergePatchesWithNodeConfig(sources),
      provenance: staticProvenance(sources),
    },
    envPatch,
  };
}
