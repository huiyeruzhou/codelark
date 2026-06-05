export function formatBindingChatLabel(
  binding: {
    channelType: string;
    channelProvider?: string;
    channelAlias?: string;
    chatId: string;
    chatDisplayName?: string;
  },
  resolvedAlias?: string,
): string {
  const channelLabel = binding.channelAlias
    || resolvedAlias
    || (binding.channelProvider === 'feishu' ? '飞书' : binding.channelType);
  const chatLabel = binding.chatDisplayName?.trim() || binding.chatId;
  return `${channelLabel} 聊天 ${chatLabel}`;
}
