import { isSupportedChannelProvider, type ChannelProvider, type RuntimeChannelInstance } from '../../configuration/channel-types.js';
import { createConfigService } from '../../configuration/service.js';
import { markdownToPlainText } from '../../shared/markdown/plain.js';
import { formatBindingChatLabel as formatBindingChatLabelBase } from '../../bridge/session/display/channel-label.js';
import type { ChannelChat } from '../../domain/index.js';

function toRuntimeChannelInstance(channel: RuntimeChannelInstance): RuntimeChannelInstance {
  return {
    id: channel.id,
    alias: channel.alias,
    provider: channel.provider,
    enabled: channel.enabled,
    config: { ...channel.config },
  };
}

export function listConfiguredChannelInstances(): RuntimeChannelInstance[] {
  try {
    return createConfigService({ migrate: false }).snapshot().config.channels
      .filter((channel) => isSupportedChannelProvider(channel.provider))
      .map(toRuntimeChannelInstance);
  } catch (error) {
    console.error('[channel-runtime] Failed to read configured channels from v2 config:', error);
    return [];
  }
}

export function getConfiguredChannelInstance(channelType: string): RuntimeChannelInstance | null {
  return listConfiguredChannelInstances().find((channel) => channel.id === channelType) || null;
}

export function inferChannelProvider(channelType: string): ChannelProvider | undefined {
  const instance = getConfiguredChannelInstance(channelType);
  return instance?.provider;
}

export function getChannelProviderKey(channelType: string): string {
  return inferChannelProvider(channelType) || channelType;
}

export function isFeedbackMarkdownEnabled(channelType: string): boolean {
  const instance = getConfiguredChannelInstance(channelType);
  if (instance?.provider === 'feishu') {
    return instance.config.feedbackMarkdownEnabled !== false;
  }
  return false;
}

export function getFeedbackParseMode(channelType: string): 'Markdown' | 'plain' {
  return isFeedbackMarkdownEnabled(channelType)
    ? 'Markdown'
    : 'plain';
}

export function renderFeedbackText(text: string, parseMode: 'Markdown' | 'plain'): string {
  return parseMode === 'Markdown' ? text : markdownToPlainText(text);
}

export function renderFeedbackTextForChannel(channelType: string, text: string): string {
  return renderFeedbackText(text, getFeedbackParseMode(channelType));
}

export function formatBindingChatLabel(
  binding: {
    channelType: string;
    channelProvider?: string;
    channelAlias?: string;
    chatId: string;
    chatDisplayName?: string;
  },
): string {
  const instance = getConfiguredChannelInstance(binding.channelType);
  return formatBindingChatLabelBase(binding, instance?.alias);
}
