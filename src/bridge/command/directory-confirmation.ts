import { randomUUID } from 'node:crypto';
import type { BridgeSession, ChannelAddress, ChannelChat, OutboundRichCard } from '../../domain/index.js';
import { getSessionWorkingDirectory } from '../../domain/session-runtime.js';
import { buildCommandCallbackData } from './callbacks.js';

interface PendingDirectory {
  address: ChannelAddress; bindingId: string; sessionId: string; previousDirectory?: string;
  directory: string; command: string; formValue?: Record<string, unknown>; createdAt: number;
}
const pending = new Map<string, PendingDirectory>();
const ttl = 10 * 60_000;

export function requestDirectoryCreation(options: {
  address: ChannelAddress; binding: ChannelChat; session: BridgeSession; directory: string;
  command: string; formValue?: Record<string, unknown>;
}): { response: string; richCard: OutboundRichCard } {
  for (const [id, entry] of pending) if (Date.now() - entry.createdAt > ttl || entry.bindingId === options.binding.id) pending.delete(id);
  const id = randomUUID();
  pending.set(id, { address: options.address, bindingId: options.binding.id, sessionId: options.session.id,
    previousDirectory: getSessionWorkingDirectory(options.session), directory: options.directory,
    command: options.command, formValue: options.formValue ? structuredClone(options.formValue) : undefined, createdAt: Date.now() });
  const response = `目录不存在：${options.directory}\n是否创建此目录（包含缺失的父目录），然后继续保存？`;
  return { response, richCard: { title: '创建工作目录', template: 'orange', sections: [{ text: response }], actions: [[
    { text: '创建并继续', type: 'primary', callbackData: buildCommandCallbackData(`/mkdir-confirm ${id}`, options.session.id) },
    { text: '取消', callbackData: buildCommandCallbackData(`/mkdir-cancel ${id}`, options.session.id) },
  ]] } };
}

export function consumeDirectoryCreation(id: string, address: ChannelAddress, binding: ChannelChat | null, session: BridgeSession | null): PendingDirectory | undefined {
  const entry = pending.get(id);
  if (!entry || entry.address.channelType !== address.channelType || entry.address.chatId !== address.chatId
    || entry.address.userId !== address.userId) return undefined;
  pending.delete(id);
  if (Date.now() - entry.createdAt > ttl || binding?.id !== entry.bindingId || binding.bridgeSessionId !== entry.sessionId
    || session?.id !== entry.sessionId || getSessionWorkingDirectory(session) !== entry.previousDirectory) return undefined;
  return entry;
}
