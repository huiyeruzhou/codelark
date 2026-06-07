import type { ChannelProvider, RuntimeChannelInstance } from '../../configuration/channel-types.js';
import {
  getConfiguredChannelInstance as getConfiguredChannelInstanceBase,
  listConfiguredChannelInstances as listConfiguredChannelInstancesBase,
} from '../../configuration/channel-instances.js';
import { markdownToPlainText } from '../../shared/markdown/plain.js';
import { formatBindingChatLabel as formatBindingChatLabelBase } from '../../bridge/session/display/channel-label.js';
import type { ChannelChat } from '../../domain/index.js';

export function listConfiguredChannelInstances(): RuntimeChannelInstance[] {
  try {
    return listConfiguredChannelInstancesBase();
  } catch (error) {
    console.error('[channel-runtime] Failed to read configured channels from v2 config:', error);
    return [];
  }
}

export function getConfiguredChannelInstance(channelType: string): RuntimeChannelInstance | null {
  try {
    return getConfiguredChannelInstanceBase(channelType);
  } catch (error) {
    console.error(`[channel-runtime] Failed to read configured channel ${channelType} from v2 config:`, error);
    return null;
  }
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
