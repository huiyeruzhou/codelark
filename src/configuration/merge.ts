import { Load } from 'config/lib/util.js';
import { parse } from 'smol-toml';
import { configFields } from './fields.js';
import { getConfigPath } from './path-access.js';
import { configSchema, configToTomlShape, tomlToConfigPatch, type ConfigPatch, type ConfigV2 } from './schema.js';
import type { ProvenanceMap, SourceRef } from './fields.js';

// 配置合并内部实现：只负责 patch merge、node-config 合并和 provenance 标记，不读取具体文件。
// 读取来源的路径/I/O 留在 sources.ts，业务语义投影留在 runtime。

export interface ConfigLayer {
  ref: SourceRef;
  patch: ConfigPatch;
  envByPath?: Map<string, string>;
  provenance?: ProvenanceMap;
}

export interface MergeResult {
  config: ConfigV2;
  provenance: ProvenanceMap;
}

const nodeConfigTomlParser = {
  parse(_filename: string, content: string): unknown {
    return parse(content);
  },
  getFilesOrder(): string[] {
    return ['toml'];
  },
};

export function createNodeConfigLoader(): InstanceType<typeof Load> {
  return new Load({
    configDir: '',
    gitCrypt: true,
    hostName: '',
    nodeEnv: [],
    parser: nodeConfigTomlParser as never,
    skipConfigSources: true,
  });
}

export function loadTomlFileWithNodeConfig(file: string): unknown | null {
  return createNodeConfigLoader().loadFile(file);
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
      ...(source.runtime.agent !== undefined ? { agent: source.runtime.agent } : {}),
      ...(source.runtime.codex ? { codex: { ...(target.runtime?.codex || {}), ...source.runtime.codex } } : {}),
      ...(source.runtime.claude ? { claude: { ...(target.runtime?.claude || {}), ...source.runtime.claude } } : {}),
      ...(source.runtime.kimi ? { kimi: { ...(target.runtime?.kimi || {}), ...source.runtime.kimi } } : {}),
      ...(source.runtime.cursor ? { cursor: { ...(target.runtime?.cursor || {}), ...source.runtime.cursor } } : {}),
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

export function markLayerProvenance(provenance: ProvenanceMap, layer: ConfigLayer): void {
  if (layer.provenance) {
    for (const [path, ref] of layer.provenance) provenance.set(path, ref);
    return;
  }
  markScalarProvenance(provenance, layer);
  markChannelProvenance(provenance, layer);
}

export function mergePatchesWithNodeConfig(layers: ConfigLayer[]): ConfigPatch {
  const load = createNodeConfigLoader();
  for (const layer of layers) {
    load.addConfig(layer.ref.file || layer.ref.source, configToTomlShape(layer.patch));
  }
  return tomlToConfigPatch(load.config);
}

export function mergeConfigLayers(layers: ConfigLayer[]): MergeResult {
  const provenance: ProvenanceMap = new Map();

  for (const layer of layers) {
    markLayerProvenance(provenance, layer);
  }

  return {
    config: configSchema.parse(mergePatchesWithNodeConfig(layers)),
    provenance,
  };
}
