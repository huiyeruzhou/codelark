import { createConfigService } from '../../configuration/service.js';
import type { BridgeStore, ChannelAddress } from '../../domain/index.js';

/** 话题没有独立的 @ 规则；命令、展示和入站均读取所属物理群。 */
export function mentionSettingsAddress(store: BridgeStore, address: Pick<ChannelAddress, 'channelType' | 'chatId' | 'feishuTopic'>) {
  const topic = address.feishuTopic || store.getChannelChat(address.channelType, address.chatId)?.feishuTopic;
  return { channelType: address.channelType, chatId: topic?.chatId || address.chatId };
}

/** 入站时读取当前绑定；不缓存到 adapter，也不让一个 App 的其他群共享开关。 */
export function sessionRequiresMention(store: BridgeStore, address: Pick<ChannelAddress, 'channelType' | 'chatId' | 'feishuTopic'>): boolean {
  const target = mentionSettingsAddress(store, address);
  const binding = store.getChannelChat(target.channelType, target.chatId);
  if (!binding || !store.getSession(binding.bridgeSessionId)) return false;
  return createConfigService({ migrate: false }).get('session.requireMention', {
    kind: 'session', sessionId: binding.bridgeSessionId,
  }) === true;
}
