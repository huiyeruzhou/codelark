import '../../../setup/test-setup.js';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { it } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { FeishuAdapter } from '../../../../channels/feishu/adapter.js';
import { buildHistoryPage } from '../../../../channels/feishu/streaming-history-page.js';
import type { StreamingHistoryItem } from '../../../../domain/index.js';
import { consumeMirrorRecords, type MirrorTurnStateHolder } from '../../../../bridge/mirror/turns.js';
import { readCardForkCheckpoint } from '../../../../storage/card-fork-checkpoints.js';

const user = (content: string): StreamingHistoryItem => ({ type: 'markdown', role: 'user', content });
const answer = (content: string): StreamingHistoryItem => ({ type: 'markdown', role: 'assistant', content });
const start = { historyItemOffset: 0, historyToolCallOffset: 0 };

it('starts a new page for every user input, including identical consecutive inputs', () => {
  const history = [user('继续'), user('继续'), answer('第二条输入的回答')];
  const first = buildHistoryPage(history, start, () => true);
  assert.deepEqual(first.items, history.slice(0, 1));
  assert.equal(first.hasMore, true);
  const second = buildHistoryPage(history, first.next, () => true);
  assert.deepEqual(second.items, history.slice(1));
  assert.equal(second.hasMore, false);
});

it('preserves long user input fragments before advancing to the next user', () => {
  const history = [user('a'.repeat(50)), answer('first-answer'), user('next-user')];
  const pages: StreamingHistoryItem[][] = [];
  let cursor = start;
  for (let i = 0; i < 10; i += 1) {
    const page = buildHistoryPage(history, cursor, (items) => JSON.stringify(items).length < 100);
    pages.push(page.items);
    cursor = page.next;
    if (!page.hasMore) break;
  }
  const text = pages.flat().map((item) => item.type === 'markdown' ? item.content : '').join('');
  assert.equal(text, 'a'.repeat(50) + 'first-answernext-user');
  assert.deepEqual(pages.at(-1), [user('next-user')]);
});

function fixture() {
  const cards = new Map<string, Record<string, any>>();
  const messages: string[] = [];
  const messageIds: string[] = [];
  const adapter = new FeishuAdapter({
    id: 'user-boundary', provider: 'feishu', alias: 'test', enabled: true,
    config: { streamingEnabled: true },
  });
  const internal = adapter as any;
  internal.cardFlushBaseIntervalMs = 1;
  internal.restClient = {
    cardkit: { v1: { cardElement: {
      content: async () => ({ code: 0 }),
    }, card: {
      create: async (payload: any) => {
        const id = `card-${cards.size + 1}`;
        cards.set(id, JSON.parse(payload.data.data));
        return { code: 0, data: { card_id: id } };
      },
      update: async (payload: any) => {
        cards.set(payload.path.card_id, JSON.parse(payload.data.card.data));
        return { code: 0 };
      },
      settings: async () => ({ code: 0 }),
    } } },
    im: { message: {
      create: async (payload: any) => {
        messages.push(JSON.parse(payload.data.content).data.card_id);
        const messageId = crypto.randomUUID();
        messageIds.push(messageId);
        return { code: 0, data: { message_id: messageId } };
      },
    } },
  };
  const historyText = (id: string) => JSON.stringify(cards.get(id)?.body.elements
    .find((element: any) => element.element_id === 'stream_history'));
  const settle = async () => {
    await internal.cardCreatePromises.get('same-runtime-turn');
    for (let i = 0; i < 200; i += 1) {
      assert.equal(await internal.awaitCardFlushCompletion('same-runtime-turn'), true);
      const state = internal.activeCards.get('same-runtime-turn');
      if (!state?.throttleTimer && !state?.flushInFlight && !state?.flushQueued) return;
      await setTimeout(5);
    }
    assert.fail('Card updates did not settle');
  };
  return { adapter, internal, cards, messages, messageIds, historyText, settle };
}

it('persists only sealed card boundaries, including duplicate native records and terminal history', async () => {
  const { adapter, messageIds } = fixture();
  const subscription: MirrorTurnStateHolder = { sessionId: 'fork-session', threadId: 'fork-thread', pendingTurn: null };
  const base = { timestamp: '2026-10-27T10:00:00.000Z', turnId: 'fork-turn' };
  const signature = (value: string) => crypto.createHash('sha1').update(value).digest('hex');
  const updateHistory = (_: MirrorTurnStateHolder, turn: NonNullable<MirrorTurnStateHolder['pendingTurn']>) =>
    adapter.onStreamHistory('fork-chat', turn.historyItems, turn.streamKey);
  const hooks = { onStreamText: updateHistory, onHistoryCheckpoint: updateHistory };
  consumeMirrorRecords(subscription, [
    { ...base, signature: signature('user-a'), type: 'message', role: 'user', content: 'A' },
    { ...base, signature: signature('event-a'), type: 'message', role: 'assistant', content: 'ANSWER-A' },
    { ...base, signature: signature('response-a'), type: 'message', role: 'assistant', content: 'ANSWER-A' },
  ], hooks);
  const key = subscription.pendingTurn!.streamKey;
  const firstId = await adapter.waitForStructuredStreamingUiMessageId('fork-chat', key);
  assert.ok(firstId);
  assert.equal(readCardForkCheckpoint(adapter.channelType, 'fork-chat', firstId), null);
  const completed = consumeMirrorRecords(subscription, [
    { ...base, signature: signature('user-b'), type: 'message', role: 'user', content: 'B' },
    { ...base, signature: signature('answer-b'), type: 'message', role: 'assistant', content: 'ANSWER-B' },
    { ...base, signature: signature('terminal-b'), type: 'task_complete', content: 'ANSWER-B' },
  ], hooks);
  assert.equal(await adapter.onStreamEnd('fork-chat', 'completed', completed[0]!.text, key), true);
  assert.equal(messageIds.length, 2);
  assert.equal(readCardForkCheckpoint(adapter.channelType, 'fork-chat', messageIds[0]!)?.signature, signature('response-a'));
  assert.equal(readCardForkCheckpoint(adapter.channelType, 'fork-chat', messageIds[1]!)?.signature, signature('terminal-b'));
  assert.equal(readCardForkCheckpoint(adapter.channelType, 'other-chat', messageIds[0]!), null);
});

it('does not checkpoint a failed final update', async () => {
  const { adapter, internal, messageIds } = fixture();
  const forkSource = { sessionId: 's', threadId: 't', signature: 'f'.repeat(40) };
  adapter.onStreamHistory('failed-chat', [{ ...user('A'), forkSource }, { ...answer('B'), forkSource }], 'failed-turn');
  await adapter.waitForStructuredStreamingUiMessageId('failed-chat', 'failed-turn');
  internal.restClient.cardkit.v1.card.update = async () => ({ code: 999, msg: 'test rejection' });
  await adapter.onStreamEnd('failed-chat', 'completed', '', 'failed-turn');
  assert.equal(readCardForkCheckpoint(adapter.channelType, 'failed-chat', messageIds[0]!), null);
});

it('only checkpoints the final continuation of an oversized native record', async () => {
  const { adapter, messageIds } = fixture();
  const forkSource = { sessionId: 's', threadId: 't', signature: 'd'.repeat(40) };
  const userSource = { ...forkSource, signature: 'c'.repeat(40) };
  adapter.onStreamHistory('long-chat', [{ ...user('Long response'), forkSource: userSource },
    { ...answer('complete-native-record '.repeat(1800)), forkSource }], 'long-turn');
  assert.equal(await adapter.onStreamEnd('long-chat', 'completed', '', 'long-turn'), true);
  assert.ok(messageIds.length > 2);
  assert.equal(readCardForkCheckpoint(adapter.channelType, 'long-chat', messageIds[0]!)?.signature, userSource.signature);
  for (const id of messageIds.slice(1, -1)) {
    assert.equal(readCardForkCheckpoint(adapter.channelType, 'long-chat', id), null);
  }
  assert.equal(readCardForkCheckpoint(adapter.channelType, 'long-chat', messageIds.at(-1)!)?.signature, forkSource.signature);
});

it('creates separate cards for multiple users received together during card creation', async () => {
  const { adapter, messages, cards, historyText } = fixture();
  adapter.onStreamHistory('chat', [user('USER-A'), answer('ANSWER-A')], 'same-runtime-turn');
  adapter.onStreamHistory('chat', [
    user('USER-A'), answer('ANSWER-A'), user('USER-B'), answer('ANSWER-B'), user('USER-C'), answer('ANSWER-C'),
  ], 'same-runtime-turn');
  assert.equal(await adapter.onStreamEnd('chat', 'completed', '', 'same-runtime-turn'), true);
  assert.equal(messages.length, 3);
  for (const [i, letter] of ['A', 'B', 'C'].entries()) {
    const text = historyText(messages[i]!);
    assert.match(text, new RegExp(`USER-${letter}`));
    assert.match(text, new RegExp(`ANSWER-${letter}`));
    for (const other of ['A', 'B', 'C'].filter((value) => value !== letter)) {
      assert.doesNotMatch(text, new RegExp(`(?:USER|ANSWER)-${other}`));
    }
    assert.notEqual(cards.get(messages[i]!)?.config.streaming_mode, true);
  }
});

it('keeps one card for output updates and rotates only when a new user input arrives', async () => {
  const { adapter, messages, historyText, settle } = fixture();
  const history = [user('USER-A'), answer('ANSWER-A')];
  adapter.onStreamHistory('chat', history, 'same-runtime-turn');
  await settle();
  adapter.onStreamHistory('chat', [...history, answer('MORE-A')], 'same-runtime-turn');
  await settle();
  assert.equal(messages.length, 1);
  adapter.onStreamHistory('chat', [...history, answer('MORE-A'), user('USER-B'), answer('ANSWER-B')], 'same-runtime-turn');
  await settle();
  assert.equal(messages.length, 2);
  const oldCard = historyText(messages[0]!);
  assert.match(oldCard, /MORE-A/);
  assert.doesNotMatch(oldCard, /USER-B|ANSWER-B/);
  assert.equal(await adapter.onStreamEnd('chat', 'completed', '', 'same-runtime-turn'), true);
  assert.equal(historyText(messages[0]!), oldCard);
  assert.match(historyText(messages[1]!), /USER-B/);
  assert.doesNotMatch(historyText(messages[1]!), /USER-A|ANSWER-A|MORE-A/);
});

it('splits mirror user messages into cards without splitting the runtime turn', async () => {
  const { adapter, messages, historyText } = fixture();
  const subscription: MirrorTurnStateHolder = {
    sessionId: 'session', threadId: 'thread', pendingTurn: null,
  };
  const record = { timestamp: '2026-10-23T10:00:00.000Z', turnId: 'runtime-turn' };
  const completed = consumeMirrorRecords(subscription, [
    { ...record, signature: 'start', type: 'task_started', content: '' },
    { ...record, signature: 'user-a', type: 'message', role: 'user', content: 'USER-A' },
    { ...record, signature: 'answer-a', type: 'message', role: 'assistant', content: 'ANSWER-A' },
    { ...record, signature: 'user-b', type: 'message', role: 'user', content: 'USER-B' },
    { ...record, signature: 'answer-b', type: 'message', role: 'assistant', content: 'ANSWER-B' },
    { ...record, signature: 'end', type: 'task_complete', content: 'ANSWER-B' },
  ], {
    onTurnStarted: (_subscription, turn) => adapter.onMirrorStreamStart('chat', turn.streamKey),
    onStreamText: (_subscription, turn) => adapter.onStreamHistory('chat', turn.historyItems, turn.streamKey),
  });
  assert.equal(completed.length, 1);
  assert.equal(completed[0]!.status, 'completed');
  assert.equal(await adapter.onStreamEnd('chat', 'completed', completed[0]!.text, completed[0]!.streamKey), true);
  assert.equal(messages.length, 2);
  assert.match(historyText(messages[0]!), /USER-A/);
  assert.doesNotMatch(historyText(messages[0]!), /USER-B|ANSWER-B/);
  assert.match(historyText(messages[1]!), /USER-B/);
  assert.doesNotMatch(historyText(messages[1]!), /USER-A|ANSWER-A/);
});
