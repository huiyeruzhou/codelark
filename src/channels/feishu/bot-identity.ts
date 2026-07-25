import type { FeishuSite } from '../types.js';
import { feishuSiteToApiBaseUrl, normalizeFeishuSite } from './site.js';

export interface FeishuBotIdentity {
  openId: string;
  botId?: string;
  name?: string;
  avatarUrl?: string;
}

interface FeishuBotIdentityOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function responseError(payload: unknown, fallback: string): Error {
  if (typeof payload === 'object' && payload !== null) {
    const message = (payload as { msg?: unknown; message?: unknown }).msg
      || (payload as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return new Error(message.trim());
  }
  return new Error(fallback);
}

export async function fetchFeishuBotIdentity(
  credentials: { appId: string; appSecret: string; site?: FeishuSite | string },
  options: FeishuBotIdentityOptions = {},
): Promise<FeishuBotIdentity> {
  const fetchImpl = options.fetchImpl || fetch;
  const baseUrl = feishuSiteToApiBaseUrl(credentials.site);
  const signal = AbortSignal.timeout(options.timeoutMs ?? 10_000);
  const tokenResponse = await fetchImpl(`${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: credentials.appId, app_secret: credentials.appSecret }),
    signal,
  });
  const tokenPayload = await tokenResponse.json() as {
    code?: number;
    tenant_access_token?: string;
  };
  if (!tokenResponse.ok || tokenPayload.code !== 0 || !tokenPayload.tenant_access_token) {
    throw responseError(tokenPayload, `获取 tenant access token 失败：HTTP ${tokenResponse.status}`);
  }

  const botResponse = await fetchImpl(`${baseUrl}/open-apis/bot/v3/info/`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${tokenPayload.tenant_access_token}` },
    signal,
  });
  const botPayload = await botResponse.json() as {
    code?: number;
    bot?: Record<string, unknown>;
    data?: { bot?: Record<string, unknown> };
  };
  if (!botResponse.ok || botPayload.code !== 0) {
    throw responseError(botPayload, `获取机器人信息失败：HTTP ${botResponse.status}`);
  }
  const bot = botPayload.bot || botPayload.data?.bot;
  const openId = typeof bot?.open_id === 'string' ? bot.open_id.trim() : '';
  if (!openId) throw new Error('机器人信息未返回 bot open_id。');
  return {
    openId,
    ...(typeof bot?.bot_id === 'string' && bot.bot_id.trim() ? { botId: bot.bot_id.trim() } : {}),
    ...(typeof bot?.app_name === 'string' && bot.app_name.trim()
      ? { name: bot.app_name.trim() }
      : typeof bot?.name === 'string' && bot.name.trim()
        ? { name: bot.name.trim() }
        : {}),
    ...(typeof bot?.avatar_url === 'string' && bot.avatar_url.trim() ? { avatarUrl: bot.avatar_url.trim() } : {}),
  };
}

export function buildFeishuBotChatAppLink(site: FeishuSite | string | undefined, botOpenId: string): string {
  const host = normalizeFeishuSite(site) === 'lark'
    ? 'applink.larksuite.com'
    : 'applink.feishu.cn';
  const url = new URL(`https://${host}/client/chat/open`);
  url.searchParams.set('openId', botOpenId.trim());
  return url.toString();
}
