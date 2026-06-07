export type ChannelProvider = 'feishu';
export type FeishuSite = 'feishu' | 'lark';

export interface FeishuChannelConfig {
  appId?: string;
  appSecret?: string;
  site?: FeishuSite;
  allowedUsers?: string[];
  streamingEnabled?: boolean;
  feedbackMarkdownEnabled?: boolean;
  requireMention?: boolean;
}

export interface RuntimeChannelInstance {
  id: string;
  alias: string;
  provider: ChannelProvider;
  enabled: boolean;
  config: FeishuChannelConfig;
}

export function isSupportedChannelProvider(value: unknown): value is ChannelProvider {
  return value === 'feishu';
}

export function normalizeFeishuSite(value: string | undefined): FeishuSite {
  const normalized = (value || '').trim().replace(/\/+$/, '').toLowerCase();
  if (!normalized) return 'feishu';
  if (normalized === 'lark') return 'lark';
  if (normalized === 'feishu') return 'feishu';
  if (normalized.includes('open.larksuite.com')) return 'lark';
  return 'feishu';
}

export function feishuSiteToApiBaseUrl(site: FeishuSite | string | undefined): string {
  return normalizeFeishuSite(site) === 'lark'
    ? 'https://open.larksuite.com'
    : 'https://open.feishu.cn';
}
