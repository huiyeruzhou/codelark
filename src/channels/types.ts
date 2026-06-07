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
  groupAuthorized?: boolean;
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
