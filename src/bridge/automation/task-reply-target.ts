import type { ChannelAddress } from '../../domain/index.js';
import type { BaseChannelAdapter } from '../../channels/contracts.js';
import { getConfiguredChannelInstance } from '../../channels/adapter-runtime/channel-runtime.js';
import { parseTopicConversationId } from '../../channels/feishu/customer-service.js';
import { deliver } from '../../channels/delivery/deliver.js';

export function scheduledTaskUsesThread(address: ChannelAddress): boolean {
  if (parseTopicConversationId(address.chatId)) return true;
  const channel = getConfiguredChannelInstance(address.channelType);
  return channel?.provider === 'feishu'
    && Array.isArray(channel.config.threadReplyChats)
    && channel.config.threadReplyChats.includes(address.chatId);
}

export async function ensureScheduledTaskReplyTarget(options: {
  adapter: BaseChannelAdapter;
  address: ChannelAddress;
  bridgeSessionId: string;
  source: 'every' | 'then' | 'manual';
  prompt: string;
}): Promise<string | undefined> {
  if (parseTopicConversationId(options.address.chatId)) {
    throw new Error('隔离客服话题暂不支持自动创建新话题；本次输入尚未提交。请在普通群的 thread 模式下创建自动任务。');
  }
  if (!scheduledTaskUsesThread(options.address)) return undefined;

  const label = options.prompt.trim().split('\n')[0]?.slice(0, 60) || '继续当前会话';
  const title = `${options.source === 'every' ? '定时任务' : options.source === 'then' ? '后续任务' : 'Agent 消息'}：${label}`;
  const result = await deliver(options.adapter, {
    address: options.address,
    text: title,
    parseMode: 'plain',
    platformMessage: { msgType: 'text', content: { text: title } },
    startNewThread: true,
  }, { sessionId: options.bridgeSessionId, audit: true });
  if (!result.ok || !result.messageId?.trim()) {
    throw new Error(`无法创建任务话题：${result.error || '平台未返回消息 ID'}，本次输入尚未提交。`);
  }
  return result.messageId;
}
