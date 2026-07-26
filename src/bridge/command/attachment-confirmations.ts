import type { ChannelAddress } from '../../domain/index.js';
import { classifyTakeoverConfirmationReply, type TakeoverConfirmationReply } from './takeover-confirmations.js';

const CONFIRMATION_TTL_MS = 10 * 60 * 1000;

interface PendingAttachmentConfirmation {
  commandText: string;
  createdAt: number;
}

const pendingAttachmentConfirmations = new Map<string, PendingAttachmentConfirmation>();

function confirmationKey(address: ChannelAddress): string {
  return [address.channelType, address.chatId, address.userId || ''].join(':');
}

function pruneExpired(nowMs = Date.now()): void {
  for (const [key, pending] of pendingAttachmentConfirmations) {
    if (nowMs - pending.createdAt > CONFIRMATION_TTL_MS) {
      pendingAttachmentConfirmations.delete(key);
    }
  }
}

export function registerPendingAttachmentConfirmation(
  address: ChannelAddress,
  commandText: string,
  nowMs = Date.now(),
): void {
  pruneExpired(nowMs);
  pendingAttachmentConfirmations.set(confirmationKey(address), { commandText, createdAt: nowMs });
}

export function clearPendingAttachmentConfirmation(address: ChannelAddress): void {
  pendingAttachmentConfirmations.delete(confirmationKey(address));
}

export function isPendingAttachmentConfirmationReply(
  address: ChannelAddress,
  text: string,
  nowMs = Date.now(),
): boolean {
  pruneExpired(nowMs);
  return pendingAttachmentConfirmations.has(confirmationKey(address))
    && classifyTakeoverConfirmationReply(text) !== null;
}

export function consumePendingAttachmentConfirmation(
  address: ChannelAddress,
  text: string,
  nowMs = Date.now(),
): { reply: TakeoverConfirmationReply; commandText?: string } {
  pruneExpired(nowMs);
  const key = confirmationKey(address);
  const pending = pendingAttachmentConfirmations.get(key);
  if (!pending) return { reply: null };
  const reply = classifyTakeoverConfirmationReply(text);
  if (!reply) return { reply: null };
  pendingAttachmentConfirmations.delete(key);
  return reply === 'confirm' ? { reply, commandText: pending.commandText } : { reply };
}
