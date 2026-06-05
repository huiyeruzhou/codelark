import fs from 'node:fs';
import path from 'node:path';

import { CODELARK_HOME } from '../../configuration/index.js';
import type { BaseChannelAdapter } from '../../channels/contracts.js';
import type { ChannelAddress } from '../../domain/index.js';
import type { ThreadCardScope } from './presentation.js';

interface ThreadTableMessageRecord {
  channelType: string;
  channelProvider?: string;
  channelAlias?: string;
  chatId: string;
  scope: ThreadCardScope;
  messageId: string;
  pinnedMessageId?: string;
  updatedAt: string;
}

type ThreadTableMessageStore = Record<string, ThreadTableMessageRecord>;

const THREAD_TABLE_MESSAGES_PATH = path.join(CODELARK_HOME, 'data', 'thread-table-messages.json');
const pinJobTails = new Map<string, Promise<void>>();

function legacyTableMessageKey(address: ChannelAddress): string {
  return `${address.channelType}:${address.chatId}`;
}

function tableMessageKey(address: ChannelAddress, scope: ThreadCardScope): string {
  return `${legacyTableMessageKey(address)}:${scope}`;
}

function readThreadTableMessages(): ThreadTableMessageStore {
  try {
    return JSON.parse(fs.readFileSync(THREAD_TABLE_MESSAGES_PATH, 'utf-8')) as ThreadTableMessageStore;
  } catch {
    return {};
  }
}

function writeThreadTableMessages(records: ThreadTableMessageStore): void {
  fs.mkdirSync(path.dirname(THREAD_TABLE_MESSAGES_PATH), { recursive: true });
  fs.writeFileSync(THREAD_TABLE_MESSAGES_PATH, JSON.stringify(records, null, 2));
}

export function getThreadTableMessageRecord(
  address: ChannelAddress,
  scope?: ThreadCardScope,
): ThreadTableMessageRecord | null {
  const records = readThreadTableMessages();
  if (scope) {
    const scoped = records[tableMessageKey(address, scope)];
    if (scoped) return scoped;
    const legacy = records[legacyTableMessageKey(address)];
    return legacy?.scope === scope ? legacy : null;
  }

  const candidates = [
    records[legacyTableMessageKey(address)],
    records[tableMessageKey(address, 'global')],
    records[tableMessageKey(address, 'bound')],
  ].filter((record): record is ThreadTableMessageRecord => Boolean(record));
  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] || null;
}

export function saveThreadTableMessageRecord(
  address: ChannelAddress,
  scope: ThreadCardScope,
  messageId: string,
  pinnedMessageId?: string,
): void {
  const records = readThreadTableMessages();
  records[tableMessageKey(address, scope)] = {
    channelType: address.channelType,
    channelProvider: address.channelProvider,
    channelAlias: address.channelAlias,
    chatId: address.chatId,
    scope,
    messageId,
    pinnedMessageId,
    updatedAt: new Date().toISOString(),
  };
  const legacyKey = legacyTableMessageKey(address);
  if (records[legacyKey]?.scope === scope) {
    delete records[legacyKey];
  }
  writeThreadTableMessages(records);
}

async function runThreadTablePinJob(
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
  scope: ThreadCardScope,
  messageId: string,
  previousPinnedId?: string,
): Promise<void> {
  const startedAt = Date.now();
  const key = tableMessageKey(address, scope);
  let status: 'success' | 'skipped' | 'failed' = 'success';
  let error: string | undefined;

  try {
    const current = getThreadTableMessageRecord(address, scope);
    if (!current || current.messageId !== messageId || current.pinnedMessageId === messageId) {
      status = 'skipped';
      return;
    }

    if (!adapter.pinMessage) {
      status = 'skipped';
      return;
    }

    const pinResult = await adapter.pinMessage(address.chatId, messageId);
    if (!pinResult.ok) {
      status = 'failed';
      error = pinResult.error || messageId;
      console.warn('[thread-table-pins] Failed to pin latest thread table:', error);
      return;
    }

    const afterPin = getThreadTableMessageRecord(address, scope);
    if (!afterPin || afterPin.messageId !== messageId) {
      status = 'skipped';
      return;
    }

    saveThreadTableMessageRecord(address, scope, messageId, messageId);
    if (
      previousPinnedId
      && previousPinnedId !== messageId
      && adapter.unpinMessage
    ) {
      const unpinResult = await adapter.unpinMessage(address.chatId, previousPinnedId);
      if (!unpinResult.ok) {
        console.warn('[thread-table-pins] Failed to unpin previous thread table:', unpinResult.error || previousPinnedId);
      }
    }
  } catch (err) {
    status = 'failed';
    error = err instanceof Error ? err.message : String(err);
    console.warn('[thread-table-pins] Failed to update thread table pin:', error);
  } finally {
    const durationMs = Date.now() - startedAt;
    console.log('[thread-table-pins] Thread table pin job:', {
      event: 'perf.thread_table_pin',
      duration_ms: durationMs,
      status,
      channel: address.channelType,
      chat: address.chatId,
      scope,
      operation: 'pin_latest_thread_table',
      message_id: messageId,
      previous_pinned_message_id: previousPinnedId,
      key,
      ...(error ? { error } : {}),
    });
  }
}

function scheduleThreadTablePinJob(
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
  scope: ThreadCardScope,
  messageId: string,
  previousPinnedId?: string,
): void {
  const key = tableMessageKey(address, scope);
  const previous = pinJobTails.get(key) || Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(() => runThreadTablePinJob(adapter, address, scope, messageId, previousPinnedId));
  pinJobTails.set(key, current);
  current.finally(() => {
    if (pinJobTails.get(key) === current) {
      pinJobTails.delete(key);
    }
  }).catch(() => undefined);
}

export async function flushThreadTablePinJobs(): Promise<void> {
  await Promise.all(Array.from(pinJobTails.values()).map((job) => job.catch(() => undefined)));
}

export async function persistAndPinLatestThreadTableMessage(
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
  scope: ThreadCardScope,
  messageId: string | null | undefined,
): Promise<void> {
  const trimmedMessageId = messageId?.trim();
  if (!trimmedMessageId) return;

  const previous = getThreadTableMessageRecord(address, scope);
  let pinnedMessageId = previous?.pinnedMessageId;

  if (previous?.messageId === trimmedMessageId && previous.pinnedMessageId === trimmedMessageId) {
    saveThreadTableMessageRecord(address, scope, trimmedMessageId, pinnedMessageId);
    return;
  }

  saveThreadTableMessageRecord(address, scope, trimmedMessageId, pinnedMessageId);

  if (adapter.pinMessage) {
    scheduleThreadTablePinJob(
      adapter,
      address,
      scope,
      trimmedMessageId,
      previous?.pinnedMessageId || previous?.messageId,
    );
  }
}
