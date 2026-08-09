import path from 'node:path';

import type { BaseChannelAdapter } from '../../channels/contracts.js';
import type { BridgeStore, ChannelChat } from '../../domain/index.js';
import { getSessionActiveRuntime, getSessionWorkingDirectory } from '../../domain/session-runtime.js';
import type { AgentMessageSource, DiscoveredBridgeSession } from './contracts.js';

function sessionName(binding: ChannelChat, storedName?: string): string {
  return storedName?.trim() || binding.chatId;
}

export function listDiscoveredBridgeSessions(options: {
  store: BridgeStore;
  codelarkHome: string;
  getAdapter(channelType: string): BaseChannelAdapter | null | undefined;
  query?: string;
}): DiscoveredBridgeSession[] {
  const query = options.query?.trim().toLocaleLowerCase() || '';
  const codelarkHome = path.resolve(options.codelarkHome);
  return options.store.listChannelChats().flatMap((binding) => {
    const adapter = options.getAdapter(binding.channelType);
    const session = options.store.getSession(binding.bridgeSessionId);
    if (!adapter?.isRunning() || !session) return [];
    const chatName = sessionName(binding, session.name);
    const item: DiscoveredBridgeSession = {
      codelarkHome,
      internalChatId: binding.id,
      platformChatId: binding.chatId,
      bridgeSessionId: binding.bridgeSessionId,
      chatName,
      agentName: adapter.getBotDisplayName(),
      channelType: binding.channelType,
      runtime: getSessionActiveRuntime(session) || 'codex',
      runtimeStatus: session.runtime_status || 'idle',
      cwd: getSessionWorkingDirectory(session),
      updatedAt: binding.lastActivityAt || binding.updatedAt,
    };
    if (!query) return [item];
    const haystack = Object.values(item).filter((value) => value !== undefined).join('\n').toLocaleLowerCase();
    return haystack.includes(query) ? [item] : [];
  }).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

export function sourceMetadataForBinding(options: {
  store: BridgeStore;
  codelarkHome: string;
  binding: ChannelChat;
  botName: string;
}): AgentMessageSource {
  const session = options.store.getSession(options.binding.bridgeSessionId);
  const chatName = sessionName(options.binding, session?.name);
  return {
    codelarkHome: path.resolve(options.codelarkHome),
    internalChatId: options.binding.id,
    platformChatId: options.binding.chatId,
    bridgeSessionId: options.binding.bridgeSessionId,
    chatName,
    botName: options.botName,
  };
}

function quoteContextValue(value: string): string {
  return JSON.stringify(value)
    .replace(/</gu, '\\u003c')
    .replace(/>/gu, '\\u003e');
}

export function formatAgentSourceXml(source: AgentMessageSource): string {
  return [
    '<codelark_source>',
    `来源群聊：${quoteContextValue(source.chatName)}`,
    `来源 Bot：${quoteContextValue(source.botName)}`,
    `来源会话 ID：${quoteContextValue(source.bridgeSessionId)}`,
    '</codelark_source>',
  ].join('\n');
}
