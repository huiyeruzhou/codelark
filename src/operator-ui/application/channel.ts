import { z } from 'zod';

import type {
  FeishuChannelConfig,
  FeishuSite,
} from '../../configuration/channel-types.js';
import { feishuSiteSchema, type ChannelConfigV2, type ConfigV2 } from '../../configuration/schema.js';
import {
  feishuSiteToApiBaseUrl,
  normalizeFeishuSite,
} from '../../channels/feishu/site.js';
import { normalizeChannelId } from '../../shared/channel-id.js';

export type UiChannelConfigSource = {
  channels?: UiChannelInstance[];
};

export type UiChannelInstance = {
  id: string;
  alias: string;
  provider: 'feishu';
  enabled: boolean;
  createdAt?: string;
  updatedAt?: string;
  config: Partial<FeishuChannelConfig>;
};

function trimString(schema: z.ZodString = z.string()) {
  return z.preprocess(
    (value) => typeof value === 'string' ? value.trim() : value,
    schema,
  );
}

function optionalTrimmedString() {
  return trimString().optional();
}

const uiChannelPayloadSchema = z.object({
  id: trimString(z.string().min(1)).optional(),
  provider: z.preprocess(
    (value) => typeof value === 'string' ? value.trim().toLowerCase() : value,
    z.literal('feishu'),
  ),
  alias: optionalTrimmedString(),
  enabled: z.boolean().optional(),
  appId: optionalTrimmedString(),
  appSecret: optionalTrimmedString(),
  site: z.preprocess(
    (value) => typeof value === 'string' ? value.trim().toLowerCase() : value,
    feishuSiteSchema,
  ).optional(),
  allowedUsers: trimString()
    .transform((value) => value.split(',').map((item) => item.trim()).filter(Boolean))
    .optional(),
  streamingEnabled: z.boolean().optional(),
  feedbackMarkdownEnabled: z.boolean().optional(),
  requireMention: z.boolean().optional(),
}).strict();

type UiChannelPayload = z.infer<typeof uiChannelPayloadSchema>;

export function parseUiChannelPayload(payload: Record<string, unknown>): UiChannelPayload {
  return uiChannelPayloadSchema.parse(payload);
}

function normalizeChannelAlias(value: string | undefined): string {
  const trimmed = value?.trim();
  if (trimmed) return trimmed;
  return '飞书';
}

function buildChannelId(provider: 'feishu', alias: string, takenIds: Set<string>, currentId?: string): string {
  const base = normalizeChannelId(`${provider}-${alias}`);
  if (!takenIds.has(base) || base === currentId) return base;
  let suffix = 2;
  while (takenIds.has(`${base}-${suffix}`) && `${base}-${suffix}` !== currentId) {
    suffix += 1;
  }
  return `${base}-${suffix}`;
}

export function getChannelLabel(channel: Pick<UiChannelInstance, 'alias' | 'provider'>): string {
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
  const parsed = parseUiChannelPayload(payload);
  const provider = parsed.provider;
  const existingId = parsed.id;
  const existing = existingId ? current.channels.find((channel) => channel.id === existingId) : undefined;
  const alias = normalizeChannelAlias(parsed.alias);
  const takenIds = new Set(current.channels.map((channel) => channel.id));
  const channelId = existing?.id || buildChannelId(provider, alias, takenIds);
  const template = existing?.config || defaultChannelTemplate(current);

  const nextChannel: ChannelConfigV2 = {
    id: channelId,
    alias,
    provider,
    enabled: parsed.enabled ?? existing?.enabled ?? true,
    config: {
      ...template,
      appId: parsed.appId ?? existing?.config.appId ?? '',
      appSecret: parsed.appSecret ?? existing?.config.appSecret ?? '',
      site: parsed.site ?? existing?.config.site ?? template.site,
      allowedUsers: parsed.allowedUsers ?? existing?.config.allowedUsers ?? template.allowedUsers,
      streamingEnabled: parsed.streamingEnabled ?? existing?.config.streamingEnabled ?? template.streamingEnabled,
      feedbackMarkdownEnabled: parsed.feedbackMarkdownEnabled
        ?? existing?.config.feedbackMarkdownEnabled
        ?? template.feedbackMarkdownEnabled,
      requireMention: parsed.requireMention ?? existing?.config.requireMention ?? template.requireMention,
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
