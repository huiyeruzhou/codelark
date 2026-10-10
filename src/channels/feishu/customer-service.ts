import type { FeishuChannelConfig } from '../types.js';

/** A logical conversation address; never pass it to a Feishu chat_id parameter. */
const PREFIX = 'feishu-topic:';

export interface FeishuTopicAddress {
  chatId: string;
  rootMessageId: string;
  threadId?: string;
}

export function topicConversationId(topic: FeishuTopicAddress): string {
  if (!/^oc_[\w]+$/.test(topic.chatId) || !/^om_[\w]+$/.test(topic.rootMessageId)) {
    throw new Error('Invalid Feishu topic address');
  }
  return `${PREFIX}${topic.chatId}:${topic.rootMessageId}`;
}

export function parseTopicConversationId(value: string): FeishuTopicAddress | undefined {
  const match = /^feishu-topic:(oc_[\w]+):(om_[\w]+)$/.exec(value);
  if (value.startsWith(PREFIX) && !match) throw new Error('Invalid Feishu topic conversation ID');
  return match ? { chatId: match[1], rootMessageId: match[2] } : undefined;
}

export function isCustomerServiceChat(config: FeishuChannelConfig, chatId: string): boolean {
  const physicalChatId = parseTopicConversationId(chatId)?.chatId || chatId;
  return config.customerServiceChats?.includes(physicalChatId) === true;
}

/** Explicit user IDs only. A group allowlist is never a control permission. */
export function customerServiceControllers(config: FeishuChannelConfig, creatorId?: string | null): string[] {
  const configured = config.customerServiceControlUsers || [];
  return configured.length ? configured : creatorId && /^ou_[a-zA-Z0-9]+$/.test(creatorId) ? [creatorId] : [];
}

export function canControlCustomerService(config: FeishuChannelConfig, userId: string, creatorId?: string | null): boolean {
  return /^ou_[\w]+$/.test(userId) && customerServiceControllers(config, creatorId).includes(userId);
}

export interface TopicMessage {
  message_id: string;
  chat_id?: string;
  root_id?: string;
  parent_id?: string;
  thread_id?: string;
}

/** Resolve older ordinary reply chains too; fail closed on missing/cross-chat parents. */
export async function resolveTopicAddress(
  chatId: string,
  message: TopicMessage,
  getMessage: (id: string) => Promise<TopicMessage>,
  getThreadRoot: (threadId: string) => Promise<TopicMessage>,
): Promise<FeishuTopicAddress> {
  let current = message;
  const visited = new Set<string>();
  for (let depth = 0; depth < 32; depth += 1) {
    if (current.chat_id && current.chat_id !== chatId) throw new Error('Reply belongs to a different Feishu chat');
    if (visited.has(current.message_id)) throw new Error('Cyclic Feishu reply chain');
    visited.add(current.message_id);
    if (current.root_id) {
      return { chatId, rootMessageId: current.root_id, threadId: current.thread_id || message.thread_id };
    }
    if (current.parent_id) {
      current = await getMessage(current.parent_id);
      continue;
    }
    if (current.thread_id) {
      const root = await getThreadRoot(current.thread_id);
      if (root.chat_id && root.chat_id !== chatId) throw new Error('Thread belongs to a different Feishu chat');
      return { chatId, rootMessageId: root.root_id || root.message_id, threadId: current.thread_id };
    }
    return { chatId, rootMessageId: current.message_id, threadId: message.thread_id };
  }
  throw new Error('Feishu reply chain exceeds 32 messages');
}
