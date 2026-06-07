import { configV2ToLegacyConfig, legacyConfigToConfigPatch } from "./legacy.js";
import { createConfigService } from "./service.js";
import {
  CODELARK_HOME,
} from "./paths.js";
import type {
  ChannelInstance,
  Config,
} from './legacy-types.js';

export {
  normalizeClaudeExecutable,
  normalizeClaudePermissionMode,
  normalizeClaudeProviderChoice,
  normalizeCodexProviderChoice,
  normalizeRuntimeProvider,
  type ClaudeExecutable,
  type ClaudePermissionMode,
  type ClaudeProviderChoice,
  type CodexProviderChoice,
  type CodexReasoningEffort,
  type CodexSandboxMode,
  type RuntimeProvider,
} from "./runtime-types.js";
export {
  feishuSiteToApiBaseUrl,
  isSupportedChannelProvider,
  normalizeFeishuSite,
  type ChannelProvider,
  type FeishuChannelConfig,
  type FeishuSite,
} from "./channel-types.js";
export {
  CODELARK_HOME,
  CONFIG_JSON_PATH,
  CONFIG_PATH,
  DEFAULT_CODELARK_HOME,
  DEFAULT_WORKSPACE_ROOT,
  expandHomePath,
} from "./paths.js";
export { configToSettings } from './legacy.js';
export type {
  BridgeControlConfig,
  ChannelInstance,
  ClaudeRuntimeDefaultsConfig,
  CodexRuntimeDefaultsConfig,
  Config,
  GlobalBridgeConfig,
  RuntimeConfig,
} from './legacy-types.js';

export function loadConfig(): Config {
  return configV2ToLegacyConfig(
    createConfigService({ codelarkHome: CODELARK_HOME }).snapshot().config,
  );
}

export function saveConfig(config: Config): void {
  createConfigService({ codelarkHome: CODELARK_HOME })
    .set({ kind: 'home' }, legacyConfigToConfigPatch(config));
}

export function maskSecret(value: string): string {
  if (value.length <= 4) return "****";
  return "*".repeat(value.length - 4) + value.slice(-4);
}

export function listChannelInstances(config?: Config): ChannelInstance[] {
  return [...(config?.channels || loadConfig().channels || [])];
}

export function findChannelInstance(channelId: string, config?: Config): ChannelInstance | undefined {
  return listChannelInstances(config).find((channel) => channel.id === channelId);
}
