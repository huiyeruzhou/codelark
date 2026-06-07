import { resolveConfiguredChannelScopeId } from './channel-instances.js';
import { getEffectiveConfigSource } from './source-values.js';
import { expandHomePath } from './paths.js';
import { createConfigService, type ConfigScope } from './service.js';
import type { ConfigV2 } from './schema.js';

export interface ChannelSessionDefaultsInput {
  channelType: string;
  channelProvider?: string;
  cwd?: string;
}

export interface ChannelSessionDefaults {
  activeRuntime: 'codex' | 'claude';
  codexModel: string;
  codexMode: 'normal' | 'yolo';
  workspace: string;
}

export function channelScopeForAddress(address: Pick<ChannelSessionDefaultsInput, 'channelType' | 'channelProvider'>): ConfigScope | undefined {
  return address.channelProvider === undefined || address.channelProvider === 'feishu'
    ? { kind: 'channel', channelId: resolveConfiguredChannelScopeId(address.channelType), provider: 'feishu' }
    : undefined;
}

function codexModeFromConfig(config: ConfigV2): 'normal' | 'yolo' {
  return config.runtime.codex.yoloMode === 'on' || config.runtime.codex.yoloMode === 'yolo' ? 'yolo' : 'normal';
}

export function resolveChannelSessionDefaults(address: ChannelSessionDefaultsInput): ChannelSessionDefaults {
  const effective = createConfigService({ migrate: false }).snapshot(channelScopeForAddress(address));
  const config = effective.config;
  const workspaceSource = getEffectiveConfigSource(effective, 'session.workspace');
  const workspaceValue = workspaceSource && workspaceSource !== 'defaults'
    ? config.session.workspace
    : config.bridge.defaultWorkspace;
  const workspace = expandHomePath(workspaceValue || config.bridge.defaultWorkspace) || process.cwd();
  return {
    activeRuntime: config.runtime.agent === 'claude' ? 'claude' : 'codex',
    codexModel: config.runtime.codex.model || '',
    codexMode: codexModeFromConfig(config),
    workspace,
  };
}
