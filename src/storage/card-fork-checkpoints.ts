import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CODELARK_HOME } from '../configuration/paths.js';
import type { HistoryForkSource } from '../domain/progress.js';

export interface CardForkCheckpoint extends HistoryForkSource {
  channelType: string;
  chatId: string;
  messageId: string;
  status?: 'completed' | 'interrupted' | 'error' | 'continued';
  sealedAt?: number;
}

function checkpointPath(channelType: string, chatId: string, messageId: string): string {
  const key = crypto.createHash('sha256').update(JSON.stringify([channelType, chatId, messageId])).digest('hex');
  return path.join(CODELARK_HOME, 'data', 'card-fork-checkpoints', `${key}.json`);
}

/** Only successfully sealed cards are eligible; streaming updates never advance this boundary. */
export function saveCardForkCheckpoint(checkpoint: CardForkCheckpoint): void {
  const target = checkpointPath(checkpoint.channelType, checkpoint.chatId, checkpoint.messageId);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(checkpoint), { mode: 0o600 });
  fs.renameSync(temp, target);
}

export function readCardForkCheckpoint(channelType: string, chatId: string, messageId: string): CardForkCheckpoint | null {
  let raw: string;
  try { raw = fs.readFileSync(checkpointPath(channelType, chatId, messageId), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const checkpoint = JSON.parse(raw) as CardForkCheckpoint;
  if (checkpoint.channelType !== channelType || checkpoint.chatId !== chatId || checkpoint.messageId !== messageId
    || !checkpoint.sessionId || !checkpoint.threadId || typeof checkpoint.signature !== 'string' || !checkpoint.signature) {
    throw new Error('卡片分叉记录损坏，无法确定历史边界。');
  }
  return checkpoint;
}

export function readLatestCompletedCardForkCheckpoint(channelType: string, chatId: string, sessionId: string, threadId: string): CardForkCheckpoint | null {
  const directory = path.join(CODELARK_HOME, 'data', 'card-fork-checkpoints');
  let names: string[];
  try { names = fs.readdirSync(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let latest: CardForkCheckpoint | null = null;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const candidate = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')) as CardForkCheckpoint;
    if (candidate.channelType !== channelType || candidate.chatId !== chatId || candidate.sessionId !== sessionId
      || candidate.threadId !== threadId || candidate.status !== 'completed' || !Number.isFinite(candidate.sealedAt)) continue;
    const checkpoint = readCardForkCheckpoint(channelType, chatId, candidate.messageId)!;
    if (!latest || checkpoint.sealedAt! > latest.sealedAt!) latest = checkpoint;
  }
  return latest;
}
