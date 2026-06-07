import {
  type Config,
  type FeishuChannelConfig,
} from '../../configuration/index.js';
import type { ConfigV2 } from '../../configuration/schema.js';
import {
  type BindingSummary,
  listBindingSummaries,
  listBindingTargetOptions,
  listChannelDefaultTargetSummaries,
} from '../../bridge/session/registry.js';
import type { JsonFileStore } from '../../storage/json-store.js';
import { findUiChannelInstance, getFeishuDomain, type UiChannelConfigSource, type UiChannelInstance } from './channel.js';

const FEISHU_CHAT_LABEL_TTL_MS = 5 * 60 * 1000;
const feishuChatLabelCache = new Map<string, { label: string; userId?: string; expiresAt: number }>();
const feishuTenantTokenCache = new Map<
  string,
  {
    token: string;
    expiresAt: number;
  }
>();

type FetchLike = typeof fetch;

function asString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function getFeishuTokenCacheKey(channel: UiChannelInstance): string {
  const feishu = channel.config as FeishuChannelConfig;
  return [
    channel.id,
    feishu.appId || '',
    feishu.appSecret || '',
    getFeishuDomain(channel),
  ].join(':');
}

async function getFeishuTenantAccessToken(
  channel: UiChannelInstance,
  fetchImpl: FetchLike,
): Promise<string | null> {
  const feishu = channel.config as FeishuChannelConfig;
  if (!feishu.appId || !feishu.appSecret) return null;

  const domain = getFeishuDomain(channel);
  const cacheKey = getFeishuTokenCacheKey(channel);
  const now = Date.now();
  const cached = feishuTenantTokenCache.get(cacheKey);
  if (cached && cached.expiresAt > now + 60_000) {
    return cached.token;
  }

  const response = await fetchImpl(`${domain}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: feishu.appId,
      app_secret: feishu.appSecret,
    }),
  });

  const data = await response.json() as {
    code?: number;
    msg?: string;
    tenant_access_token?: string;
    expire?: number;
  };
  if (!response.ok || data.code !== 0 || !data.tenant_access_token) {
    return null;
  }

  feishuTenantTokenCache.set(cacheKey, {
    token: data.tenant_access_token,
    expiresAt: now + Math.max(60, Number(data.expire || 7200)) * 1000,
  });
  return data.tenant_access_token;
}

export async function resolveFeishuBindingDisplay(
  config: UiChannelConfigSource,
  binding: BindingSummary,
  fetchImpl: FetchLike = fetch,
): Promise<Pick<BindingSummary, 'chatDisplayName' | 'chatUserId'>> {
  const channel = findUiChannelInstance(binding.channelType, config);
  if (!channel || channel.provider !== 'feishu') {
    return {
      chatDisplayName: binding.chatDisplayName,
      chatUserId: binding.chatUserId,
    };
  }

  const cached = feishuChatLabelCache.get(binding.chatId);
  if (cached && cached.expiresAt > Date.now()) {
    return {
      chatDisplayName: cached.label,
      chatUserId: cached.userId || binding.chatUserId,
    };
  }

  const token = await getFeishuTenantAccessToken(channel, fetchImpl);
  if (!token) {
    return {
      chatDisplayName: binding.chatDisplayName,
      chatUserId: binding.chatUserId,
    };
  }

  const domain = getFeishuDomain(channel);
  try {
    const chatResponse = await fetchImpl(
      `${domain}/open-apis/im/v1/chats/${encodeURIComponent(binding.chatId)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const chatData = await chatResponse.json() as {
      code?: number;
      data?: {
        name?: string;
        owner_id?: string;
        chat_mode?: string;
      };
    };

    const chatName = asString(chatData.data?.name);
    const ownerId = asString(chatData.data?.owner_id) || binding.chatUserId;
    if (chatResponse.ok && chatData.code === 0 && chatName) {
      feishuChatLabelCache.set(binding.chatId, {
        label: chatName,
        userId: ownerId,
        expiresAt: Date.now() + FEISHU_CHAT_LABEL_TTL_MS,
      });
      return {
        chatDisplayName: chatName,
        chatUserId: ownerId,
      };
    }

    if (ownerId) {
      const userResponse = await fetchImpl(
        `${domain}/open-apis/contact/v3/users/${encodeURIComponent(ownerId)}?user_id_type=open_id`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const userData = await userResponse.json() as {
        code?: number;
        data?: {
          user?: {
            name?: string;
            nickname?: string;
          };
        };
      };
      const userName = asString(userData.data?.user?.name) || asString(userData.data?.user?.nickname);
      if (userResponse.ok && userData.code === 0 && userName) {
        feishuChatLabelCache.set(binding.chatId, {
          label: userName,
          userId: ownerId,
          expiresAt: Date.now() + FEISHU_CHAT_LABEL_TTL_MS,
        });
        return {
          chatDisplayName: userName,
          chatUserId: ownerId,
        };
      }
    }
  } catch {
    // Best effort: keep raw chat id if lookup fails.
  }

  return {
    chatDisplayName: binding.chatDisplayName,
    chatUserId: binding.chatUserId,
  };
}

export async function buildUiBindingsPayload(
  store: JsonFileStore,
  config: Config | ConfigV2,
  options: { fetchImpl?: FetchLike } = {},
) {
  const bindings = listBindingSummaries(store);
  const enriched = await Promise.all(bindings.map(async (binding) => {
    const resolved = await resolveFeishuBindingDisplay(config, binding, options.fetchImpl);
    if (
      (
        resolved.chatDisplayName !== binding.chatDisplayName
        || resolved.chatUserId !== binding.chatUserId
      )
      && (resolved.chatDisplayName || resolved.chatUserId)
    ) {
      store.updateChannelChat(binding.id, {
        chatUserId: resolved.chatUserId,
      });
      if (resolved.chatDisplayName) {
        store.updateSession(binding.currentSessionId, { name: resolved.chatDisplayName }, { touch: false });
      }
    }
    return {
      ...binding,
      chatDisplayName: resolved.chatDisplayName || binding.chatDisplayName,
      chatUserId: resolved.chatUserId || binding.chatUserId,
    };
  }));

  return {
    bindings: enriched,
    options: listBindingTargetOptions(store, 12),
    channelDefaults: listChannelDefaultTargetSummaries(store),
  };
}
