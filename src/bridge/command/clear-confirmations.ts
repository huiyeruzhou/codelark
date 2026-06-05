import type { ChannelAddress } from '../../domain/index.js';

const CONFIRMATION_TTL_MS = 10 * 60 * 1000;

interface PendingClearConfirmation {
  commandText: string;
  createdAt: number;
}

export type ClearConfirmationReply = 'confirm' | 'cancel' | null;

const pendingClearConfirmations = new Map<string, PendingClearConfirmation>();

function clearConfirmationKey(address: ChannelAddress): string {
  return [
    address.channelType,
    address.chatId,
    address.userId || '',
  ].join(':');
}

function pruneExpired(nowMs = Date.now()): void {
  for (const [key, pending] of pendingClearConfirmations) {
    if (nowMs - pending.createdAt > CONFIRMATION_TTL_MS) {
      pendingClearConfirmations.delete(key);
    }
  }
}

export function registerPendingClearConfirmation(
  address: ChannelAddress,
  commandText: string,
  nowMs = Date.now(),
): void {
  pruneExpired(nowMs);
  pendingClearConfirmations.set(clearConfirmationKey(address), {
    commandText,
    createdAt: nowMs,
  });
}

export function clearPendingClearConfirmation(address: ChannelAddress): void {
  pendingClearConfirmations.delete(clearConfirmationKey(address));
}

export function classifyClearConfirmationReply(text: string): ClearConfirmationReply {
  const normalized = text.trim().normalize('NFKC').toLowerCase();
  if (!normalized) return null;
  if (['是', '确认', '确定', '好的', '好', 'yes', 'y'].includes(normalized)) return 'confirm';
  if (['否', '不', '不用', '取消', 'no', 'n', 'cancel'].includes(normalized)) return 'cancel';
  return null;
}

export function consumePendingClearConfirmation(
  address: ChannelAddress,
  text: string,
  nowMs = Date.now(),
): { reply: ClearConfirmationReply; commandText?: string } {
  pruneExpired(nowMs);
  const key = clearConfirmationKey(address);
  const pending = pendingClearConfirmations.get(key);
  if (!pending) return { reply: null };

  const reply = classifyClearConfirmationReply(text);
  if (!reply) return { reply: null };
  pendingClearConfirmations.delete(key);
  return reply === 'confirm'
    ? { reply, commandText: pending.commandText }
    : { reply };
}
