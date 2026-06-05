import { isSupportedChannelProvider, type ChannelInstance, type ChannelProvider } from '../../configuration/index.js';
import { getBridgeContext } from '../../bridge/host/context.js';
import { markdownToPlainText } from '../../shared/markdown/plain.js';
import { formatBindingChatLabel as formatBindingChatLabelBase } from '../../bridge/session/display/channel-label.js';
import type { ChannelChat } from '../../domain/index.js';

export function listConfiguredChannelInstances(): ChannelInstance[] {
  const { store } = getBridgeContext();
  const raw = store.getSetting('bridge_channel_instances_json');
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((channel): channel is ChannelInstance => (
      channel
      && typeof channel === 'object'
      && isSupportedChannelProvider((channel as { provider?: unknown }).provider)
    ));
  } catch {
    return [];
  }
}

export function getConfiguredChannelInstance(channelType: string): ChannelInstance | null {
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
    return (instance.config as ChannelInstance['config'] & { feedbackMarkdownEnabled?: boolean }).feedbackMarkdownEnabled !== false;
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
