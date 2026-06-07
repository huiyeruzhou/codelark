import {
  isSupportedChannelProvider,
  type ChannelProvider,
  type RuntimeChannelInstance,
} from './channel-types.js';
import { createConfigService, type ConfigService, type ConfigServiceOptions } from './service.js';

type ConfigSource = ConfigService | ConfigServiceOptions;

function serviceFrom(serviceOrOptions: ConfigSource = {}): ConfigService {
  return 'snapshot' in serviceOrOptions
    ? serviceOrOptions
    : createConfigService({ ...serviceOrOptions, migrate: false });
}

function toRuntimeChannelInstance(channel: RuntimeChannelInstance): RuntimeChannelInstance {
  return {
    id: channel.id,
    alias: channel.alias,
    provider: channel.provider,
    enabled: channel.enabled,
    config: { ...channel.config },
  };
}

export function defaultAliasForChannelProvider(provider: string | undefined): string | undefined {
  if (provider === 'feishu') return '飞书';
  return undefined;
}

export function asChannelProvider(value: string | undefined): ChannelProvider | undefined {
  return isSupportedChannelProvider(value) ? value : undefined;
}

export function listConfiguredChannelInstances(serviceOrOptions: ConfigSource = {}): RuntimeChannelInstance[] {
  return serviceFrom(serviceOrOptions)
    .snapshot()
    .config
    .channels
    .filter((channel) => isSupportedChannelProvider(channel.provider))
    .map(toRuntimeChannelInstance);
}

export function getConfiguredChannelInstance(
  channelTypeOrProvider: string,
  serviceOrOptions: ConfigSource = {},
): RuntimeChannelInstance | null {
  const instances = listConfiguredChannelInstances(serviceOrOptions);
  return instances.find((channel) => channel.id === channelTypeOrProvider)
    || instances.find((channel) => channel.provider === channelTypeOrProvider)
    || null;
}

export function resolveConfiguredChannelScopeId(
  channelTypeOrProvider: string,
  serviceOrOptions: ConfigSource = {},
): string {
  return getConfiguredChannelInstance(channelTypeOrProvider, serviceOrOptions)?.id || channelTypeOrProvider;
}

export function resolveConfiguredChannelMeta(
  channelType: string,
  fallbackProvider?: string,
  serviceOrOptions: ConfigSource = {},
): {
  provider?: ChannelProvider;
  alias?: string;
} {
  const instance = getConfiguredChannelInstance(channelType, serviceOrOptions);
  if (instance) {
    return {
      provider: instance.provider,
      alias: instance.alias,
    };
  }
  const provider = asChannelProvider(fallbackProvider);
  return {
    provider,
    alias: channelType,
  };
}
