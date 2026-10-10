import '../../../setup/test-setup.js';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { JsonFileStore } from '../../../../storage/json-store.js';
import type { ChannelChat, OutboundRichCard } from '../../../../domain/index.js';
import type { BridgeMirrorRecord, MirrorJsonlSource } from '../../../../runtime/contracts.js';
import { createMirrorHistorySyncController, handleMirrorHistorySyncCommand, needsMirrorHistoryChoice } from '../../../../bridge/mirror/history-sync.js';
import { createMirrorSubscription, mirrorReadPosition, type BridgeMirrorSubscription } from '../../../../bridge/mirror/subscription-state.js';
import { createMirrorRuntime } from '../../../../bridge/mirror/runtime.js';
import { consumeMirrorRecords, hasPendingMirrorWork } from '../../../../bridge/mirror/turns.js';
import { buildCommandCallbackData, parseCommandCallbackData } from '../../../../bridge/command/callbacks.js';
import { setSessionActiveRuntimeUpdate, setSessionCursorIdentityUpdate } from '../../../../domain/session-runtime.js';
import { buildRichCardContent } from '../../../../channels/feishu/markdown.js';
import { createCursorMirrorJsonlSource } from '../../../../runtime/cursor/session-index.js';

const NOW = Date.parse('2026-10-09T15:40:00.000Z');
const stamp = (offset: number) => new Date(NOW + offset).toISOString();
const reply = (n: number, offset = -40 * 60_000 + n * 1000): BridgeMirrorRecord => ({
  signature: `reply-${n}`, turnId: `turn-${n}`, type: 'message', role: 'assistant', content: `回答 ${n}`, timestamp: stamp(offset),
});

function fixture() {
  let store = new JsonFileStore(new Map());
  const session = store.createSession('history gate', '', undefined, '/tmp');
  store.updateSession(session.id, setSessionActiveRuntimeUpdate('cursor'));
  store.updateSession(session.id, setSessionCursorIdentityUpdate('thread', '/tmp'));
  const binding: ChannelChat = { id: `binding-${session.id}`, channelType: 'feishu-test', chatId: 'isolated-chat',
    bridgeSessionId: session.id, createdAt: stamp(0), updatedAt: stamp(0) };
  const subscription = createMirrorSubscription({ bindingId: binding.id, sessionId: session.id,
    channelType: binding.channelType, chatId: binding.chatId, threadId: 'thread', filePath: null, lastDeliveredAt: null });
  const notices: OutboundRichCard[] = [];
  let now = NOW;
  const gate = createMirrorHistorySyncController({ store: () => store, now: () => now,
    checkpoint: (sub) => { store.updateSession(session.id, { mirror_read_position: mirrorReadPosition(sub) }, { touch: false }); },
    notify: async (_sub, card) => { notices.push(card); },
  });
  return { session, binding, subscription, notices, gate, get store() { return store; },
    restart: () => { store = new JsonFileStore(new Map()); }, setNow: (time: number) => { now = time; },
    command: (args: string, target = binding) => handleMirrorHistorySyncCommand({ args, binding: target, store, now }),
    state: () => store.getSession(session.id)!.mirror_history_sync!,
  };
}

it('asks for long gaps or old bursts, but not a fresh reply after a quiet night or a live tool burst', () => {
  assert.equal(needsMirrorHistoryChoice([reply(1)], undefined, NOW), true);
  assert.equal(needsMirrorHistoryChoice([reply(1, -5 * 60_000)], stamp(-60 * 60_000), NOW), true);
  assert.equal(needsMirrorHistoryChoice([reply(1, -1000)], stamp(-24 * 60 * 60_000), NOW), false);
  assert.equal(needsMirrorHistoryChoice(Array.from({ length: 100 }, (_, n) => ({ ...reply(n, -1000), type: 'tool_finished' as const })), undefined, NOW), false);
  assert.equal(needsMirrorHistoryChoice(Array.from({ length: 10 }, (_, n) => reply(n, -5 * 60_000)), undefined, NOW), true);
  assert.equal(needsMirrorHistoryChoice(Array.from({ length: 100 }, (_, n) => ({ ...reply(n, -5 * 60_000), type: 'tool_finished' as const })), undefined, NOW), true);
});

it('persists the cursor before notifying; restart and duplicate polls cannot replay history or the choice card', async () => {
  const f = fixture();
  f.subscription.cursor = { initialized: true, lastEventCount: 60, lastEventSignature: 'reply-59', lastEventTimestamp: reply(59).timestamp };
  const result = await f.gate(f.subscription, Array.from({ length: 60 }, (_, n) => reply(n)));
  assert.equal(result.hold, true);
  assert.deepEqual(result.records, []);
  assert.equal(f.notices.length, 0);
  f.restart();
  assert.equal(f.store.getSession(f.session.id)!.mirror_read_position!.lastEventSignature, 'reply-59');
  assert.equal(f.state().status, 'pending');
  assert.deepEqual(f.state().previews.map((p) => p.text), Array.from({ length: 20 }, (_, n) => `回答 ${n + 40}`));
  await result.notify?.();
  assert.equal(f.notices.length, 1);
  const again = await f.gate(f.subscription, [reply(59)]);
  await again.notify?.();
  assert.equal(f.notices.length, 1);
  assert.equal(again.hold, true);
  assert.ok(f.command('').richCard, 'manual /sync-history can reopen the choice');
});

for (const count of [1, 3, 20]) {
  it(`returns only ${count} bounded replies, deduplicates revisions, and makes callback retries idempotent`, async () => {
    const f = fixture();
    const records = Array.from({ length: 60 }, (_, n) => ({ ...reply(n), content: `回答 ${n}\n` + '长'.repeat(4000) + '\n```patch\n+danger\n```' }));
    records.push({ ...reply(59), signature: 'revision-59', content: '回答 59 最新修订' });
    records.push({ ...reply(60), type: 'tool_finished', content: '不能补发的工具结果' });
    const gated = await f.gate(f.subscription, records);
    await gated.notify?.();
    assert.deepEqual(f.notices[0].actions![0].map((b) => b.text), ['最近20条回复', '跳过历史']);
    const callback = parseCommandCallbackData(count === 20 ? f.notices[0].actions![0][0].callbackData!
      : buildCommandCallbackData(`/sync-history ${count} ${f.state().id}`, f.session.id));
    assert.ok(callback);
    assert.equal(callback.scopeSessionId, f.session.id);
    const result = f.command(callback.commandText.replace('/sync-history ', ''));
    assert.equal(result.richCard!.sections!.length, Math.min(count, 5) + 1);
    const content = JSON.stringify(result.richCard);
    assert.ok(content.length < 11000);
    assert.ok(content.includes('回答 59 最新修订'));
    assert.ok(!content.includes('不能补发的工具结果'));
    const rendered = buildRichCardContent(result.richCard!);
    assert.equal(rendered.match(/回答 59 最新修订/g)?.length, 1, 'each preview must be rendered exactly once');
    if (count >= 3) {
      assert.ok(rendered.includes('摘要，完整内容请在 Cursor 查看'));
      assert.ok(rendered.length > 3000, 'the rich-card text field must not silently truncate previews to 600 characters');
    }
    assert.equal(f.state().status, 'resolved');
    assert.equal(f.command(`${count} ${f.state().id}`).richCard, undefined);
    f.restart();
    assert.equal(f.command(`${count} ${f.state().id}`).richCard, undefined);
  });
}

it('skip drops unread old records, resumes future content, and asks again for a later outage', async () => {
  const f = fixture();
  await f.gate(f.subscription, [reply(1)]);
  const oldId = f.state().id;
  assert.match(f.command(`skip ${oldId}`).response, /已跳过/);
  f.restart();
  const fresh = reply(2, 1000);
  const result = await f.gate(f.subscription, [reply(1), fresh], stamp(-60 * 60_000), true);
  assert.equal(result.hold, false);
  assert.deepEqual(result.records, [fresh]);
  f.setNow(NOW + 2 * 60 * 60_000);
  assert.equal((await f.gate(f.subscription, [reply(3, 60 * 60_000)], fresh.timestamp)).hold, true);
  assert.notEqual(f.state().id, oldId);
  assert.equal(f.command(`skip ${oldId}`).richCard, undefined);
  assert.equal(f.state().status, 'pending');
});

it('pages all 20 newest replies in the same card, survives restart, and rejects stale or invalid pages', async () => {
  const f = fixture();
  const gated = await f.gate(f.subscription, Array.from({ length: 60 }, (_, n) => reply(n)));
  await gated.notify?.();
  const id = f.state().id;
  assert.equal(f.command(`page ${id} 0`).richCard, undefined, 'pending is not selected yet');
  let result = f.command(`20 ${id}`);
  const key = result.richCard!.updateKey;
  assert.equal(key, f.notices[0].updateKey, 'selection replaces the choice card');
  const seen: string[] = [];
  for (let page = 0; page < 4; page++) {
    assert.equal(result.richCard!.updateKey, key);
    assert.equal(result.richCard!.sections.length, 6);
    seen.push(...result.richCard!.sections.slice(1).map((section) => section.markdown!.match(/回答 \d+/)![0]));
    if (page === 3) {
      assert.equal(result.richCard!.actions![0].length, 1, 'no older page after the 20th reply');
      break;
    }
    const next = result.richCard!.actions![0].find((button) => button.text === '更早的回复')!;
    const parsed = parseCommandCallbackData(next.callbackData!)!;
    assert.ok(parsed);
    f.restart();
    result = f.command(parsed.commandText.replace('/sync-history ', ''));
  }
  assert.deepEqual(seen, Array.from({ length: 20 }, (_, n) => `回答 ${59 - n}`));
  assert.equal(new Set(seen).size, 20);
  assert.equal(f.command('').richCard!.updateKey, key, 'manual reopen uses the frozen selection');
  for (const args of [`page ${id} -1`, `page ${id} 4`, `page ${id} 1 extra`, `page old-id 0`, `page ${id} NaN`]) {
    assert.equal(f.command(args).richCard, undefined);
  }
  assert.equal(f.state().selectedCount, 20);
  assert.equal(f.command(`20 ${id}`).richCard, undefined, 'duplicate selection does not emit history');
  assert.equal((await f.gate(f.subscription, [reply(61, 1000)], stamp(0))).hold, false);
  assert.equal(f.state().previews.at(-1)!.text, '回答 59', 'live output does not mutate the selected history pages');
});

it('rejects choices from an old binding, different chat, or replaced Cursor thread', async () => {
  const f = fixture();
  await f.gate(f.subscription, [reply(1)]);
  for (const target of [{ ...f.binding, id: 'old-binding' }, { ...f.binding, chatId: 'other-chat' }]) {
    assert.equal(f.command(`3 ${f.state().id}`, target).richCard, undefined);
    assert.equal(f.state().status, 'pending');
  }
  f.store.updateSession(f.session.id, setSessionCursorIdentityUpdate('another-thread', '/tmp'));
  assert.equal(f.command(`skip ${f.state().id}`).richCard, undefined);
  assert.equal(f.state().status, 'pending');
});

it('holds safely after an ambiguous notification failure without automatic retries', async () => {
  const f = fixture();
  let attempts = 0;
  const gate = createMirrorHistorySyncController({ store: () => f.store, now: () => NOW, checkpoint: () => {},
    notify: async () => { attempts++; throw new Error('request timed out after acceptance'); },
  });
  await (await gate(f.subscription, [reply(1)])).notify?.();
  f.restart();
  await (await gate(f.subscription, [reply(1)])).notify?.();
  assert.equal(attempts, 1);
  assert.ok(f.command('').richCard);
});

it('keeps a new same-turn revision after skip even if Cursor retains its old timestamp', async () => {
  const f = fixture();
  await f.gate(f.subscription, [reply(1)]);
  f.command('skip');
  const revision = { ...reply(1), signature: 'new-revision', content: '选择后生成的新回复' };
  const delta = await f.gate(f.subscription, [revision], stamp(0), false);
  assert.equal(delta.hold, false);
  assert.deepEqual(delta.records, [revision]);
  f.subscription.bufferedRecords = [revision];
  f.subscription.pendingDeliveries = [{ streamKey: 'late-turn', signature: 'late-final', text: revision.content,
    timestamp: revision.timestamp, status: 'completed', userText: null }];
  await f.gate(f.subscription, [], stamp(0), false);
  assert.equal(f.subscription.bufferedRecords.length, 1, 'new buffered output must survive an old turn timestamp');
  assert.equal(f.subscription.pendingDeliveries.length, 1, 'a failed new delivery must remain retryable');
  const recovered = await f.gate(f.subscription, [reply(1)], stamp(0), true);
  assert.deepEqual(recovered.records, [], 'a reset must still suppress the old backlog');
});

it('uses the bound Desktop source without its discovery index, recovers from fallback, and reads new native replies', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-bound-source-'));
  const previous = process.env.CURSOR_DESKTOP_USER_DIR;
  process.env.CURSOR_DESKTOP_USER_DIR = root;
  fs.mkdirSync(path.join(root, 'globalStorage'));
  const file = path.join(root, 'globalStorage', 'state.vscdb');
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)');
    const put = (key: string, value: unknown) => db.prepare('INSERT OR REPLACE INTO cursorDiskKV VALUES (?,?)').run(key, JSON.stringify(value));
    let clock = NOW;
    t.mock.method(Date, 'now', () => clock);
    const source = createCursorMirrorJsonlSource();
    assert.equal(source.findByThreadId('bound', root, 'desktop'), null);
    assert.equal(source.refreshSource!('bound', 'fallback.jsonl'), null);
    put('composerData:bound', { fullConversationHeadersOnly: [{ bubbleId: 'user' }] });
    put('bubbleId:bound:user', { type: 1, createdAt: stamp(0), text: '当前对话' });
    clock += 31_000;
    assert.equal(source.refreshSource!('bound', 'fallback.jsonl')?.filePath, file);
    assert.equal(source.findByThreadId('bound', root, 'cli'), null, 'a CLI binding must not switch to Desktop');
    const summary = source.findByThreadId('bound', root, 'desktop');
    assert.equal(summary?.filePath, file);
    put('composerData:bound', { fullConversationHeadersOnly: [{ bubbleId: 'user' }, { bubbleId: 'answer' }] });
    put('bubbleId:bound:answer', { type: 2, createdAt: stamp(1000), text: '原生库中的最新回复' });
    const delta = source.readDelta(file, 0, source.statSnapshot!(file)!.size, '', null, [], 'bound');
    assert.equal(delta.records.at(-1)?.content, '原生库中的最新回复');
    assert.equal(delta.revisionLedger, true);
  } finally {
    db.close();
    if (previous === undefined) delete process.env.CURSOR_DESKTOP_USER_DIR;
    else process.env.CURSOR_DESKTOP_USER_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const sourceKind of ['snapshot', 'buffer', 'retry'] as const) {
  it(`prevents a 60-reply flood from ${sourceKind} before any stream/delivery, then resumes one fresh turn`, async () => {
    const f = fixture();
    f.store.updateSession(f.session.id, { mirror_read_position: { threadId: 'thread', lastEventCount: 0, lastEventTimestamp: stamp(-60 * 60_000) } });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-history-gate-'));
    const file = path.join(root, 'transcript.jsonl');
    fs.writeFileSync(file, 'initial');
    let records: BridgeMirrorRecord[] = sourceKind === 'snapshot' ? Array.from({ length: 60 }, (_, n) => reply(n)) : [];
    const source: MirrorJsonlSource = {
      runtime: 'cursor', readMode: 'snapshot',
      findByThreadId: () => ({ threadId: 'thread', filePath: file }),
      readDelta: (_file, _start, end) => ({ records, nextTurnId: records.at(-1)?.turnId || null, nextOffset: end, trailingText: '', nextSpecialCallIds: [], unknownKinds: [] }),
    };
    const state = { running: true, adapters: new Map([['feishu-test', { channelType: 'feishu-test', provider: 'feishu', isRunning: () => false }]]),
      mirrorSubscriptions: new Map<string, BridgeMirrorSubscription>(), mirrorWakeTimer: null, mirrorSyncInFlight: false, activeTasks: new Map() };
    const deliveries: string[] = [];
    const streamed: string[] = [];
    const consume = (sub: BridgeMirrorSubscription, items: BridgeMirrorRecord[]) => consumeMirrorRecords(sub, items, {
      onStreamText: (_sub, turn) => { streamed.push(turn.streamKey); },
    });
    let noticeCount = 0;
    const gate = createMirrorHistorySyncController({ store: () => f.store, now: () => NOW,
      checkpoint: (sub) => { f.store.updateSession(f.session.id, { mirror_read_position: mirrorReadPosition(sub) }); },
      notify: async (sub) => {
        noticeCount++;
        assert.equal(sub.pendingDeliveries.length, 0);
        assert.equal(sub.bufferedRecords.length, 0);
        assert.equal(sub.pendingTurn, null);
      },
    });
    const runtime = createMirrorRuntime(() => state as never, {
      watchDebounceMs: 0, danglingThreadRetryLimit: 3, failureSuspendThreshold: 3, failureSuspendMs: 60_000,
    }, {
      mirrorSource: source, nowIso: () => stamp(0), describeUnknownError: String,
      listChannelChats: () => [f.binding], getSession: (id) => f.store.getSession(id),
      hasSessionMirrorSource: () => true, getSessionMirrorThreadId: () => 'thread', getMirrorSourceSummary: () => source.findByThreadId('thread'),
      clearSessionCodexThreadId: () => {}, getCodexSessionByThreadIdSafe: () => null,
      syncMirrorSessionStateSafe: () => {}, observeSessionHealthRecords: () => {},
      filterSuppressedMirrorRecords: (_id, items) => items, filterHistorySync: gate,
      consumeMirrorRecords: consume, consumeBufferedMirrorTurns: (sub) => consume(sub, sub.bufferedRecords.splice(0)),
      hasPendingMirrorWork, flushTimedOutMirrorTurn: () => null, stopMirrorStreaming: () => {},
      deliverMirrorTurns: async (_sub, turns) => { deliveries.push(...turns.map((turn) => turn.text)); return { deliveredCount: turns.length }; },
    });
    try {
      await runtime.reconcileMirrorSubscriptions();
      const sub = state.mirrorSubscriptions.get(f.binding.id)!;
      if (sourceKind === 'buffer') sub.bufferedRecords = Array.from({ length: 60 }, (_, n) => reply(n));
      if (sourceKind === 'retry') sub.pendingDeliveries = Array.from({ length: 60 }, (_, n) => ({
        streamKey: `old-${n}`, signature: `old-${n}`, timestamp: reply(n).timestamp, text: reply(n).content, userText: null, status: 'completed',
      }));
      await runtime.reconcileMirrorSubscriptions();
      assert.equal(noticeCount, 1);
      assert.deepEqual(deliveries, []);
      assert.deepEqual(streamed, []);
      f.command('skip');
      const fresh = reply(61, 1000);
      records = [...records, { ...fresh, signature: 'new-start', type: 'task_started', content: '' }, fresh,
        { ...fresh, signature: 'new-end', type: 'task_complete' }];
      fs.appendFileSync(file, 'changed');
      await runtime.reconcileMirrorSubscriptions();
      assert.deepEqual(deliveries, ['回答 61']);
      assert.equal(noticeCount, 1);
      assert.ok(streamed.length > 0);
    } finally {
      runtime.clearMirrorSubscriptions();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
