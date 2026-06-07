import {
  feishuSiteToApiBaseUrl,
  isSupportedChannelProvider,
  normalizeFeishuSite,
  type ChannelInstance,
  type ChannelProvider,
  type Config,
  type FeishuChannelConfig,
  type FeishuSite,
} from '../../configuration/index.js';
import { normalizeChannelId } from '../../configuration/runtime-options.js';
import type { ChannelConfigV2, ConfigV2 } from '../../configuration/schema.js';

export type UiChannelConfigSource = {
  channels?: UiChannelInstance[];
};

export type UiChannelInstance = {
  id: string;
  alias: string;
  provider: ChannelProvider;
  enabled: boolean;
  createdAt?: string;
  updatedAt?: string;
  config: Partial<FeishuChannelConfig>;
};

function asString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function payloadString(payload: Record<string, unknown>, key: string, fallback: string): string {
  if (!Object.prototype.hasOwnProperty.call(payload, key)) return fallback;
  return typeof payload[key] === 'string' ? payload[key].trim() : fallback;
}

function parseCsv(value: unknown): string[] | undefined {
  const text = asString(value);
  if (!text) return undefined;
  return text.split(',').map((item) => item.trim()).filter(Boolean);
}

function payloadCsv(payload: Record<string, unknown>, key: string, fallback: string[]): string[] {
  if (!Object.prototype.hasOwnProperty.call(payload, key)) return fallback;
  if (typeof payload[key] !== 'string') return fallback;
  return payload[key].split(',').map((item) => item.trim()).filter(Boolean);
}

function normalizeChannelAlias(value: string | undefined, provider: ChannelProvider): string {
  const trimmed = value?.trim();
  if (trimmed) return trimmed;
  return '飞书';
}

function buildChannelId(provider: ChannelProvider, alias: string, takenIds: Set<string>, currentId?: string): string {
  const base = normalizeChannelId(`${provider}-${alias}`);
  if (!takenIds.has(base) || base === currentId) return base;
  let suffix = 2;
  while (takenIds.has(`${base}-${suffix}`) && `${base}-${suffix}` !== currentId) {
    suffix += 1;
  }
  return `${base}-${suffix}`;
}

function cloneChannel(channel: ChannelInstance): ChannelInstance {
  return {
    ...channel,
    config: { ...channel.config } as ChannelInstance['config'],
  };
}

export function getChannelLabel(channel: Pick<ChannelInstance, 'alias' | 'provider'>): string {
  const providerLabel = '飞书';
  return channel.alias?.trim() ? `${channel.alias} · ${providerLabel}` : providerLabel;
}

export function getFeishuSite(channel: UiChannelInstance): FeishuSite {
  const feishu = channel.config as FeishuChannelConfig;
  return normalizeFeishuSite(feishu.site);
}

export function getFeishuDomain(channel: UiChannelInstance): string {
  return feishuSiteToApiBaseUrl(getFeishuSite(channel));
}

export function findUiChannelInstance(channelId: string, config: UiChannelConfigSource): UiChannelInstance | undefined {
  return (config.channels || []).find((channel) => channel.id === channelId);
}

export function mergeChannelInstance(
  payload: Record<string, unknown>,
  current: Config,
): { config: Config; channel: ChannelInstance } {
  const provider = isSupportedChannelProvider(payload.provider) ? payload.provider : undefined;
  if (!provider) {
    throw new Error('通道提供方只能是飞书。');
  }

  const existingId = asString(payload.id);
  const existing = existingId ? findUiChannelInstance(existingId, current) : undefined;
  const alias = normalizeChannelAlias(asString(payload.alias), provider);
  const baseChannels = (current.channels || []).map(cloneChannel);
  const takenIds = new Set(baseChannels.map((channel) => channel.id));
  const channelId = existing?.id || buildChannelId(provider, alias, takenIds);
  const now = new Date().toISOString();

  const nextConfig: FeishuChannelConfig = {
    appId: asString(payload.appId),
    appSecret: asString(payload.appSecret),
    site: normalizeFeishuSite(asString(payload.site) || asString(payload.domain)),
    allowedUsers: parseCsv(payload.allowedUsers),
    streamingEnabled: payload.streamingEnabled !== false,
    feedbackMarkdownEnabled: payload.feedbackMarkdownEnabled !== false,
    requireMention: payload.requireMention === true,
  };

  const nextChannel: ChannelInstance = {
    id: channelId,
    alias,
    provider,
    enabled: payload.enabled !== false,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    config: nextConfig,
  };

  const nextChannels = existing
    ? baseChannels.map((channel) => channel.id === existing.id ? nextChannel : channel)
    : [...baseChannels, nextChannel];

  return {
    config: {
      ...current,
      channels: nextChannels,
      enabledChannels: Array.from(new Set(nextChannels.filter((channel) => channel.enabled).map((channel) => channel.provider))),
    },
    channel: nextChannel,
  };
}

export function deleteChannelInstance(current: Config, channelId: string): Config {
  const channels = current.channels || [];
  const nextChannels = channels.filter((channel) => channel.id !== channelId);
  if (nextChannels.length === channels.length) {
    throw new Error('指定的通道不存在。');
  }

  return {
    ...current,
    channels: nextChannels,
    enabledChannels: Array.from(new Set(nextChannels.filter((channel) => channel.enabled).map((channel) => channel.provider))),
  };
}

function defaultChannelTemplate(current: ConfigV2): ChannelConfigV2['config'] {
  const template = current.channels.find((channel) => channel.id === 'feishu-default') || current.channels[0];
  if (!template) {
    throw new Error('缺少默认通道模板，无法保存通道配置。');
  }
  return template.config;
}

export function mergeChannelInstanceV2(
  payload: Record<string, unknown>,
  current: ConfigV2,
): { config: ConfigV2; channel: ChannelConfigV2 } {
  const provider = isSupportedChannelProvider(payload.provider) ? payload.provider : undefined;
  if (!provider) {
    throw new Error('通道提供方只能是飞书。');
  }

  const existingId = asString(payload.id);
  const existing = existingId ? current.channels.find((channel) => channel.id === existingId) : undefined;
  const alias = normalizeChannelAlias(asString(payload.alias), provider);
  const takenIds = new Set(current.channels.map((channel) => channel.id));
  const channelId = existing?.id || buildChannelId(provider, alias, takenIds);
  const template = existing?.config || defaultChannelTemplate(current);

  const nextChannel: ChannelConfigV2 = {
    id: channelId,
    alias,
    provider,
    enabled: payload.enabled !== false,
    config: {
      ...template,
      appId: payloadString(payload, 'appId', existing?.config.appId || ''),
      appSecret: payloadString(payload, 'appSecret', existing?.config.appSecret || ''),
      site: normalizeFeishuSite(payloadString(
        payload,
        'site',
        payloadString(payload, 'domain', existing?.config.site || template.site),
      )),
      allowedUsers: payloadCsv(payload, 'allowedUsers', existing?.config.allowedUsers || template.allowedUsers),
      streamingEnabled: Object.prototype.hasOwnProperty.call(payload, 'streamingEnabled')
        ? payload.streamingEnabled !== false
        : existing?.config.streamingEnabled ?? template.streamingEnabled,
      feedbackMarkdownEnabled: Object.prototype.hasOwnProperty.call(payload, 'feedbackMarkdownEnabled')
        ? payload.feedbackMarkdownEnabled !== false
        : existing?.config.feedbackMarkdownEnabled ?? template.feedbackMarkdownEnabled,
      requireMention: Object.prototype.hasOwnProperty.call(payload, 'requireMention')
        ? payload.requireMention === true
        : existing?.config.requireMention ?? template.requireMention,
    },
  };

  const nextChannels = existing
    ? current.channels.map((channel) => channel.id === existing.id ? nextChannel : channel)
    : [...current.channels, nextChannel];

  return {
    config: {
      ...current,
      channels: nextChannels,
    },
    channel: nextChannel,
  };
}

export function deleteChannelInstanceV2(current: ConfigV2, channelId: string): ConfigV2 {
  const nextChannels = current.channels.filter((channel) => channel.id !== channelId);
  if (nextChannels.length === current.channels.length) {
    throw new Error('指定的通道不存在。');
  }

  return {
    ...current,
    channels: nextChannels,
  };
}

export async function validateFeishuCredentials(channel: UiChannelInstance): Promise<{ ok: boolean; message: string }> {
  const feishu = channel.config as FeishuChannelConfig;
  if (!feishu.appId || !feishu.appSecret) {
    return { ok: false, message: 'Feishu App ID / App Secret 不能为空。' };
  }

  const domain = getFeishuDomain(channel);
  const response = await fetch(`${domain}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: feishu.appId,
      app_secret: feishu.appSecret,
    }),
  });

  const data = await response.json() as { code?: number; msg?: string; tenant_access_token?: string };
  if (response.ok && data.code === 0 && data.tenant_access_token) {
    return { ok: true, message: '飞书凭据校验成功，tenant_access_token 已获取。' };
  }

  return {
    ok: false,
    message: `${getChannelLabel(channel)} 校验失败：${data.msg || `HTTP ${response.status}`}`,
  };
}
