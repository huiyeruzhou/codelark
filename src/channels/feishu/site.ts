import type { FeishuSite } from '../../configuration/channel-types.js';

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
