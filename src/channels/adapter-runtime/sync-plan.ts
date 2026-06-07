import { isSupportedChannelProvider, type RuntimeChannelInstance } from '../../channels/types.js';
import type { AdapterRuntimeInstance } from '../contracts.js';

export function stableFingerprintValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableFingerprintValue);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entryValue]) => [key, stableFingerprintValue(entryValue)]),
    );
  }
  return value;
}

export function buildAdapterConfigFingerprint(instance: AdapterRuntimeInstance): string {
  const normalizedConfig = stableFingerprintValue(instance.config);
  return JSON.stringify({
    provider: instance.provider,
    alias: instance.alias,
    enabled: instance.enabled,
    config: normalizedConfig,
  });
}

export function listEnabledAdapterInstances(
  configuredChannels: RuntimeChannelInstance[],
): AdapterRuntimeInstance[] {
  return configuredChannels
    .filter((channel) => channel.enabled && isSupportedChannelProvider(channel.provider))
    .map<AdapterRuntimeInstance>((channel) => ({
      id: channel.id,
      provider: channel.provider,
      alias: channel.alias,
      enabled: channel.enabled,
      config: channel.config,
    }));
}

export interface AdapterStartPlanItem {
  instance: AdapterRuntimeInstance;
  fingerprint: string;
  restartExisting: boolean;
}

export interface BuildAdapterSyncPlanOptions {
  currentAdapterIds: Iterable<string>;
  invalidAdapterIds: Iterable<string>;
  warningCacheIds: Iterable<string>;
  desiredInstances: AdapterRuntimeInstance[];
  getExistingFingerprint: (channelType: string) => string | null | undefined;
}

export interface AdapterSyncPlan {
  stopChannelTypes: string[];
  removeInvalidIds: string[];
  removeWarningCacheIds: string[];
  startItems: AdapterStartPlanItem[];
}

export function buildAdapterSyncPlan(options: BuildAdapterSyncPlanOptions): AdapterSyncPlan {
  const desiredKeys = new Set(options.desiredInstances.map((channel) => channel.id));
  const desiredFingerprints = new Map(
    options.desiredInstances.map((instance) => [instance.id, buildAdapterConfigFingerprint(instance)]),
  );
  const currentAdapterIds = Array.from(options.currentAdapterIds);

  return {
    stopChannelTypes: currentAdapterIds.filter((channelType) => !desiredKeys.has(channelType)),
    removeInvalidIds: Array.from(options.invalidAdapterIds).filter((channelType) => !desiredKeys.has(channelType)),
    removeWarningCacheIds: Array.from(options.warningCacheIds).filter((channelType) => !desiredKeys.has(channelType)),
    startItems: options.desiredInstances.flatMap((instance) => {
      const fingerprint = desiredFingerprints.get(instance.id) || '';
      const hasExistingAdapter = currentAdapterIds.includes(instance.id);
      const existingFingerprint = options.getExistingFingerprint(instance.id);
      if (hasExistingAdapter && existingFingerprint === fingerprint) {
        return [];
      }
      return [{
        instance,
        fingerprint,
        restartExisting: hasExistingAdapter,
      }];
    }),
  };
}
