import type { ChannelAddress } from '../../domain/index.js';

const CONFIRMATION_TTL_MS = 10 * 60 * 1000;

interface PendingTakeoverConfirmation {
  commandText: string;
  createdAt: number;
}

export type TakeoverConfirmationReply = 'confirm' | 'cancel' | null;

const pendingTakeoverConfirmations = new Map<string, PendingTakeoverConfirmation>();

function confirmationKey(address: ChannelAddress): string {
  return [
    address.channelType,
    address.chatId,
    address.userId || '',
  ].join(':');
}

function pruneExpired(nowMs = Date.now()): void {
  for (const [key, pending] of pendingTakeoverConfirmations) {
    if (nowMs - pending.createdAt > CONFIRMATION_TTL_MS) {
      pendingTakeoverConfirmations.delete(key);
    }
  }
}

export function registerPendingTakeoverConfirmation(
  address: ChannelAddress,
  commandText: string,
  nowMs = Date.now(),
): void {
  pruneExpired(nowMs);
  pendingTakeoverConfirmations.set(confirmationKey(address), {
    commandText,
    createdAt: nowMs,
  });
}

export function clearPendingTakeoverConfirmation(address: ChannelAddress): void {
  pendingTakeoverConfirmations.delete(confirmationKey(address));
}

export function classifyTakeoverConfirmationReply(text: string): TakeoverConfirmationReply {
  const normalized = text.trim().normalize('NFKC').toLowerCase();
  if (!normalized) return null;
  if (['是', '确认', '确定', '好的', '好', 'yes', 'y'].includes(normalized)) return 'confirm';
  if (['否', '不', '不用', '取消', 'no', 'n', 'cancel'].includes(normalized)) return 'cancel';
  return null;
}

export function consumePendingTakeoverConfirmation(
  address: ChannelAddress,
  text: string,
  nowMs = Date.now(),
): { reply: TakeoverConfirmationReply; commandText?: string } {
  pruneExpired(nowMs);
  const key = confirmationKey(address);
  const pending = pendingTakeoverConfirmations.get(key);
  if (!pending) return { reply: null };

  const reply = classifyTakeoverConfirmationReply(text);
  if (!reply) return { reply: null };
  pendingTakeoverConfirmations.delete(key);
  return reply === 'confirm'
    ? { reply, commandText: pending.commandText }
    : { reply };
}
