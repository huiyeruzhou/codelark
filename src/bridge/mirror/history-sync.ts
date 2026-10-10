import { randomUUID } from 'node:crypto';
import type { BridgeSession, BridgeStore, ChannelChat, OutboundRichCard } from '../../domain/index.js';
import type { MirrorHistorySyncState } from '../../domain/session.js';
import type { BridgeMirrorRecord } from '../../runtime/contracts.js';
import type { BridgeMirrorSubscription } from './subscription-state.js';
import { getSessionActiveRuntime, getSessionCursorSessionId } from '../../domain/session-runtime.js';
import { buildCommandCallbackData } from '../command/callbacks.js';
import { buildFencedCodeBlock } from '../../shared/markdown/fence.js';

const LONG_GAP_MS = 30 * 60_000;
const RECENT_GRACE_MS = 2 * 60_000;
const BURST_RECORDS = 100;
const BURST_REPLIES = 10;
const PREVIEW_LIMIT = 1500;
const HISTORY_LIMIT = 20;
const PAGE_SIZE = 5;
type HistoryStore = Pick<BridgeStore, 'getSession' | 'updateSession'>;

export function needsMirrorHistoryChoice(records: BridgeMirrorRecord[], checkpointAt: string | undefined, nowMs: number): boolean {
  const old = records.filter((r) => Number.isFinite(Date.parse(r.timestamp))
    && nowMs - Date.parse(r.timestamp) > RECENT_GRACE_MS);
  if (!old.length) return false;
  const oldest = old.reduce((min, r) => Math.min(min, Date.parse(r.timestamp)), Infinity);
  const checkpoint = Date.parse(checkpointAt || '');
  const replies = new Set(old.filter((r) => r.type === 'message' && r.role === 'assistant')
    .map((r) => r.turnId || r.replacementKey || r.signature));
  return (!Number.isFinite(checkpoint) && nowMs - oldest >= LONG_GAP_MS) || nowMs - checkpoint >= LONG_GAP_MS
    || old.length >= BURST_RECORDS || replies.size >= BURST_REPLIES;
}

function updatePreviews(previous: MirrorHistorySyncState['previews'], records: BridgeMirrorRecord[]) {
  const previews = new Map(previous.map((p) => [p.key, p]));
  for (const record of records) {
    if (record.type !== 'message' || record.role !== 'assistant' || !record.content.trim()) continue;
    const key = record.replacementKey || record.turnId || record.signature;
    const characters = Array.from(record.content.trim());
    const text = characters.slice(0, PREVIEW_LIMIT).join('') + (characters.length > PREVIEW_LIMIT ? '\n…（摘要，完整内容请在 Cursor 查看）' : '');
    previews.delete(key);
    previews.set(key, { key, text, timestamp: record.timestamp });
  }
  return [...previews.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp)).slice(-HISTORY_LIMIT);
}

function historyCardKey(state: MirrorHistorySyncState, sessionId: string): string {
  return `mirror-history:${sessionId}:${state.id}`;
}

function buildHistoryPage(state: MirrorHistorySyncState, sessionId: string, page: number) {
  const selected = state.previews.slice(-Math.min(state.selectedCount || 0, HISTORY_LIMIT)).reverse();
  const pages = Math.max(1, Math.ceil(selected.length / PAGE_SIZE));
  const response = `已选取最近 ${selected.length} 条回复摘要，第 ${page + 1}/${pages} 页（从新到旧）。后续新内容继续实时同步。`;
  const actions: NonNullable<OutboundRichCard['actions']>[number] = [];
  if (page > 0) actions.push({ text: '较新的回复', callbackData: buildCommandCallbackData(`/sync-history page ${state.id} ${page - 1}`, sessionId) });
  if (page + 1 < pages) actions.push({ text: '更早的回复', callbackData: buildCommandCallbackData(`/sync-history page ${state.id} ${page + 1}`, sessionId) });
  return {
    response,
    richCard: {
      title: `最近 ${selected.length} 条回复 · ${page + 1}/${pages}`, template: 'blue',
      updateKey: historyCardKey(state, sessionId), updateTtlMs: null,
      sections: [{ text: response }, ...selected.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
        .map((preview) => ({ markdown: buildFencedCodeBlock(preview.text, 'text') }))],
      actions: actions.length ? [actions] : [],
    } satisfies OutboundRichCard,
  };
}

export function buildMirrorHistoryChoice(state: MirrorHistorySyncState, sessionId: string): OutboundRichCard {
  return {
    title: '选择历史同步范围', template: 'orange',
    updateKey: historyCardKey(state, sessionId), updateTtlMs: null,
    sections: [{ text: '发现较早的内容或大量积压，已暂停历史补发，等待你选择。' },
      { text: '可以同步最近20条回复摘要，在这张卡里翻页查看；或跳过历史、从现在继续同步。历史工具过程不补发，完整记录仍保留在 Cursor。' }],
    actions: [[
      { text: '最近20条回复', type: 'primary', callbackData: buildCommandCallbackData(`/sync-history 20 ${state.id}`, sessionId) },
      { text: '跳过历史', callbackData: buildCommandCallbackData(`/sync-history skip ${state.id}`, sessionId) },
    ]],
  };
}

export function createMirrorHistorySyncController(deps: {
  store: () => HistoryStore;
  now?: () => number;
  notify: (subscription: BridgeMirrorSubscription, card: OutboundRichCard) => Promise<unknown>;
  checkpoint: (subscription: BridgeMirrorSubscription) => void;
}) {
  return async (subscription: BridgeMirrorSubscription, records: BridgeMirrorRecord[], checkpointAt?: string, recovering = false) => {
    const store = deps.store();
    const session = store.getSession(subscription.sessionId);
    if (!session || getSessionActiveRuntime(session) !== 'cursor'
      || getSessionCursorSessionId(session) !== subscription.threadId) return { records: [], hold: true };
    const nowMs = deps.now?.() ?? Date.now();
    let pending = session.mirror_history_sync;
    if (pending && (pending.bindingId !== subscription.bindingId || pending.threadId !== subscription.threadId
      || pending.chatId !== subscription.chatId || pending.channelType !== subscription.channelType)) pending = undefined;
    let ignoreBefore = NaN;
    if (pending?.status === 'resolved') {
      const cutoff = Date.parse(pending.ignoreBefore || pending.createdAt);
      ignoreBefore = cutoff;
      // A live revision can retain its original timestamp (the CLI uses the
      // user turn timestamp for every reply). Only recovery replays need this cutoff.
      if (recovering) records = records.filter((record) => Date.parse(record.timestamp) > cutoff);
      // A decision applies to this backlog only. A later outage must ask again.
      pending = undefined;
    }
    // Backlog can already be buffered behind a direct run or a failed send.
    const backlog: BridgeMirrorRecord[] = [...subscription.bufferedRecords,
      ...subscription.pendingDeliveries.map((turn): BridgeMirrorRecord => ({
        type: 'message', role: 'assistant', signature: turn.signature, turnId: turn.streamKey,
        content: turn.text, timestamp: turn.timestamp,
      })), ...records];
    const unseenBacklog = Number.isFinite(ignoreBefore) ? backlog.filter((record) => Date.parse(record.timestamp) > ignoreBefore) : backlog;
    if (!pending && !needsMirrorHistoryChoice(unseenBacklog, checkpointAt, nowMs)) return { records, hold: false };
    pending = pending || {
      id: randomUUID(), bindingId: subscription.bindingId, threadId: subscription.threadId,
      channelType: subscription.channelType, chatId: subscription.chatId,
      status: 'pending', createdAt: new Date(nowMs).toISOString(), noticeAttempted: false, previews: [],
    };
    const shouldNotify = !pending.noticeAttempted;
    const next = { ...pending, previews: updatePreviews(pending.previews, backlog), noticeAttempted: true };
    if (JSON.stringify(session.mirror_history_sync) !== JSON.stringify(next)) {
      store.updateSession(subscription.sessionId, { mirror_history_sync: next }, { touch: false });
    }
    // Persist the read cursor and the decision before any network await. A
    // restart or an ambiguous send timeout must not replay the backlog/card.
    deps.checkpoint(subscription);
    return {
      records: [], hold: true,
      // The runtime stops any old stream and clears its queue before sending.
      notify: shouldNotify ? async () => {
        try { await deps.notify(subscription, buildMirrorHistoryChoice(next, session.id)); }
        catch (error) { console.warn('[mirror-history-sync] Choice delivery failed; /sync-history can reopen it:', error); }
      } : undefined,
    };
  };
}

export function handleMirrorHistorySyncCommand(options: {
  args: string;
  binding: ChannelChat | null;
  store: HistoryStore;
  now?: number;
}): { response: string; richCard?: OutboundRichCard } {
  const { binding, store } = options;
  const session: BridgeSession | null = binding ? store.getSession(binding.bridgeSessionId) : null;
  if (!binding || !session || getSessionActiveRuntime(session) !== 'cursor') return { response: '请在绑定 Cursor 的群聊中使用 /sync-history。' };
  const state = session.mirror_history_sync;
  const [choice, requestId, ...extra] = options.args.trim().split(/\s+/);
  if (!state || state.bindingId !== binding.id || state.threadId !== getSessionCursorSessionId(session)
    || state.chatId !== binding.chatId || state.channelType !== binding.channelType) {
    return { response: '当前没有等待选择的历史积压。后续出现较久未同步的内容时，会先让你选择。' };
  }
  if ((choice !== 'page' && extra.length) || (requestId && requestId !== state.id)) return { response: '这张历史同步卡已失效，请使用 /sync-history 查看当前状态。' };
  if (choice === 'page') {
    const page = Number(extra[0]);
    const pages = Math.max(1, Math.ceil(Math.min(state.selectedCount || 0, state.previews.length) / PAGE_SIZE));
    if (state.status !== 'resolved' || !state.selectedCount || requestId !== state.id || extra.length !== 1
      || !/^\d+$/.test(extra[0] || '') || !Number.isSafeInteger(page) || page < 0 || page >= pages) {
      return { response: '历史页码已失效，请使用 /sync-history 查看当前状态。' };
    }
    return buildHistoryPage(state, session.id, page);
  }
  if (state.status === 'resolved') {
    if (!choice && state.selectedCount) return buildHistoryPage(state, session.id, 0);
    return { response: '这次历史同步已经处理，不会重复补发。' };
  }
  if (!choice) return { response: '历史补发已暂停，请选择同步范围。', richCard: buildMirrorHistoryChoice(state, session.id) };
  if (!['skip', '1', '3', '20'].includes(choice)) return { response: '用法：/sync-history，或 /sync-history skip、/sync-history 20。' };
  const next: MirrorHistorySyncState = { ...state, status: 'resolved', selectedCount: choice === 'skip' ? 0 : Number(choice), ignoreBefore: new Date(options.now ?? Date.now()).toISOString() };
  store.updateSession(session.id, { mirror_history_sync: next }, { touch: false });
  if (choice !== 'skip') return buildHistoryPage(next, session.id, 0);
  const response = '已跳过历史积压，只同步从现在开始的新内容。';
  return {
    response,
    richCard: {
      title: '已跳过历史', template: 'blue',
      updateKey: historyCardKey(next, session.id), updateTtlMs: null,
      sections: [{ text: response }],
    },
  };
}
