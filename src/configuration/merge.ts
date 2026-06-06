import { configFields } from './fields.js';
import { getConfigPath, setConfigPath } from './path-access.js';
import { configSchema, type ChannelConfigV2, type ConfigPatch, type ConfigV2 } from './schema.js';
import type { ProvenanceMap, SourceRef } from './fields-types.js';

export interface ConfigLayer {
  ref: SourceRef;
  patch: ConfigPatch;
  envByPath?: Map<string, string>;
}

export interface MergeResult {
  config: ConfigV2;
  provenance: ProvenanceMap;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function getChannel(config: ConfigPatch, id: string): NonNullable<ConfigPatch['channels']>[number] | undefined {
  return config.channels?.find((channel) => channel.id === id);
}

function upsertChannel(config: ConfigPatch, id: string): NonNullable<ConfigPatch['channels']>[number] {
  config.channels ??= [];
  let channel = getChannel(config, id);
  if (!channel) {
    const defaultChannel = getChannel(config, 'feishu-default');
    channel = defaultChannel
      ? { ...clone(defaultChannel), id }
      : { id };
    config.channels.push(channel);
  }
  return channel;
}

function mergeChannel(target: ConfigPatch, source: NonNullable<ConfigPatch['channels']>[number]): void {
  const channel = upsertChannel(target, source.id);
  if (source.alias !== undefined) channel.alias = source.alias;
  if (source.provider !== undefined) channel.provider = source.provider;
  if (source.enabled !== undefined) channel.enabled = source.enabled;
  if (source.config) {
    channel.config = { ...(channel.config || {}), ...source.config };
  }
}

export function mergePatch(target: ConfigPatch, source: ConfigPatch): ConfigPatch {
  if (source.schemaVersion !== undefined) target.schemaVersion = source.schemaVersion;
  if (source.session) target.session = { ...(target.session || {}), ...source.session };
  if (source.bridge) target.bridge = { ...(target.bridge || {}), ...source.bridge };
  if (source.runtime) {
    target.runtime = {
      ...(target.runtime || {}),
      ...(source.runtime.provider !== undefined ? { provider: source.runtime.provider } : {}),
      ...(source.runtime.codex ? { codex: { ...(target.runtime?.codex || {}), ...source.runtime.codex } } : {}),
      ...(source.runtime.claude ? { claude: { ...(target.runtime?.claude || {}), ...source.runtime.claude } } : {}),
    };
  }
  for (const channel of source.channels || []) mergeChannel(target, channel);
  return target;
}

function markScalarProvenance(provenance: ProvenanceMap, layer: ConfigLayer): void {
  for (const field of configFields) {
    if (field.path.startsWith('channels[].')) continue;
    const value = getConfigPath(layer.patch, field.path);
    if (value === undefined) continue;
    provenance.set(field.path, {
      ...layer.ref,
      env: layer.envByPath?.get(field.path) ?? layer.ref.env,
    });
  }
}

function markChannelProvenance(provenance: ProvenanceMap, layer: ConfigLayer): void {
  for (const channel of layer.patch.channels || []) {
    const prefix = `channels.${channel.id}`;
    if (channel.enabled !== undefined) provenance.set(`${prefix}.enabled`, layer.ref);
    if (channel.alias !== undefined) provenance.set(`${prefix}.alias`, layer.ref);
    if (channel.provider !== undefined) provenance.set(`${prefix}.provider`, layer.ref);
    for (const [key, value] of Object.entries(channel.config || {})) {
      if (value !== undefined) provenance.set(`${prefix}.config.${key}`, layer.ref);
    }
  }
}

export function mergeConfigLayers(layers: ConfigLayer[]): MergeResult {
  const merged: ConfigPatch = {};
  const provenance: ProvenanceMap = new Map();

  for (const layer of layers) {
    mergePatch(merged, clone(layer.patch));
    markScalarProvenance(provenance, layer);
    markChannelProvenance(provenance, layer);
  }

  return {
    config: configSchema.parse(merged),
    provenance,
  };
}

export function getDefaultChannel(config: ConfigV2): ChannelConfigV2 {
  return config.channels.find((channel) => channel.id === 'feishu-default')
    || config.channels[0]!;
}

export function valueToString(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (Array.isArray(value)) return value.join(',');
  return String(value);
}

export function setPatchPath(patch: ConfigPatch, path: string, value: unknown): ConfigPatch {
  setConfigPath(patch as Record<string, unknown>, path, value);
  return patch;
}
