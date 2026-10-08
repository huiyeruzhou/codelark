import { createConfigService } from '../../configuration/service.js';
import type { BridgeStore, ChannelAddress } from '../../domain/index.js';

/** 入站时读取当前绑定；不缓存到 adapter，也不让一个 App 的其他群共享开关。 */
export function sessionRequiresMention(store: BridgeStore, address: Pick<ChannelAddress, 'channelType' | 'chatId'>): boolean {
  const binding = store.getChannelChat(address.channelType, address.chatId);
  if (!binding || !store.getSession(binding.bridgeSessionId)) return false;
  return createConfigService({ migrate: false }).get('session.requireMention', {
    kind: 'session', sessionId: binding.bridgeSessionId,
  }) === true;
}
