import '../../../setup/test-setup.js';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CursorDesktopSessionSource, statCursorDesktopStore } from '../../../../runtime/cursor/desktop-session-source.js';
import { createMirrorRuntime } from '../../../../bridge/mirror/runtime.js';
import { consumeMirrorRecords, type BridgeMirrorTurnState } from '../../../../bridge/mirror/turns.js';
import { FeishuAdapter } from '../../../../channels/feishu/adapter.js';
import type { MirrorJsonlSource } from '../../../../runtime/contracts.js';

it('keeps one Feishu message through separate native tool polls and finalizes once on live completion without a DB write', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-card-lifecycle-'));
  const file = path.join(dir, 'state.vscdb');
  const db = new DatabaseSync(file);
  const calls: { kind: string; payload: any }[] = [];
  const adapter = new FeishuAdapter({ id: 'feishu-test', provider: 'feishu', alias: 'test', enabled: true, config: { streamingEnabled: true } });
  const internal = adapter as any;
  internal.cardFlushBaseIntervalMs = 1;
  const record = (kind: string, data = {}) => async (payload: any) => { calls.push({ kind, payload }); return { code: 0, data }; };
  internal.restClient = {
    cardkit: { v1: { card: {
      create: record('create', { card_id: 'one-card' }), update: record('update'), settings: record('settings'), batchUpdate: record('batch'),
    }, cardElement: { create: record('element-create'), content: record('content'), patch: record('patch') } } },
    im: { message: { create: record('message', { message_id: 'one-message' }) } },
  };
  let runtime: ReturnType<typeof createMirrorRuntime> | undefined;
  try {
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)');
    const put = (key: string, value: unknown) => db.prepare('INSERT OR REPLACE INTO cursorDiskKV VALUES (?,?)').run(key, JSON.stringify(value));
    const headers: { bubbleId: string }[] = [];
    const updateRoot = () => put('composerData:t', { status: 'aborted', fullConversationHeadersOnly: headers });
    updateRoot();
    let status = 'running';
    const native = new CursorDesktopSessionSource(file, { readStatus: async () => status, pollIntervalMs: 0 });
    const source: MirrorJsonlSource = {
      runtime: 'cursor', readMode: 'snapshot',
      findByThreadId: () => ({ threadId: 't', filePath: file }),
      statSnapshot: () => statCursorDesktopStore(file),
      refresh: () => native.refresh('t'),
      readDelta: (_path, _start, end) => ({ ...native.read('t')!, revisionLedger: true, nextOffset: end, trailingText: '', nextSpecialCallIds: [], unknownKinds: [] }),
    };
    const binding = { id: 'binding', channelType: 'feishu-test', chatId: 'qa-chat', bridgeSessionId: 'session', active: true };
    const session = { id: 'session', runtime: { cursor: { sessionId: 't' } }, mirror_last_event_at: null };
    const state = { running: true, adapters: new Map([['feishu-test', adapter]]), mirrorSubscriptions: new Map(), mirrorWakeTimer: null, mirrorSyncInFlight: false, activeTasks: new Map() };
    const streams = new Set<string>();
    const history = (_subscription: unknown, turn: BridgeMirrorTurnState) => {
      streams.add(turn.streamKey);
      adapter.onStreamHistory('qa-chat', turn.historyItems, turn.streamKey);
    };
    const consume = (subscription: any, records: any) => consumeMirrorRecords(subscription, records, {
      onTurnStarted: history, onStreamText: history, onToolProgress: history,
    });
    let finalized = 0;
    runtime = createMirrorRuntime(() => state as never, {
      watchDebounceMs: 0, danglingThreadRetryLimit: 3, failureSuspendThreshold: 3, failureSuspendMs: 60_000,
    }, {
      mirrorSource: source, nowIso: () => new Date().toISOString(), describeUnknownError: String,
      listChannelChats: () => [binding], getSession: () => session,
      getSessionMirrorThreadId: () => 't', hasSessionMirrorSource: () => true,
      getMirrorSourceSummary: () => source.findByThreadId('t'),
      clearSessionCodexThreadId: () => {}, getCodexSessionByThreadIdSafe: () => null,
      syncMirrorSessionStateSafe: () => {}, filterSuppressedMirrorRecords: (_session, records) => records,
      observeSessionHealthRecords: () => {}, consumeMirrorRecords: consume,
      consumeBufferedMirrorTurns: (subscription) => consume(subscription, subscription.bufferedRecords.splice(0)),
      flushTimedOutMirrorTurn: () => null, hasPendingMirrorWork: () => false, stopMirrorStreaming: () => {},
      deliverMirrorTurns: async (_subscription, turns) => {
        for (const turn of turns) {
          finalized++;
          assert.equal(turn.status, 'completed');
          assert.equal(await adapter.onStreamEnd('qa-chat', turn.status, turn.text, turn.streamKey), true);
        }
        return { deliveredCount: turns.length };
      },
    });
    const reconcile = async () => {
      await runtime!.reconcileMirrorSubscriptions();
      await Promise.all([...internal.cardCreatePromises.values(), ...internal.scheduledCardCreatePromises.values()]);
      for (const key of streams) {
        await internal.awaitCardFlushCompletion(key);
        if (internal.activeCards.has(key)) {
          internal.enqueueCardFlush(key);
          await internal.awaitCardFlushCompletion(key);
        }
      }
    };
    await reconcile();
    const at = '2026-10-09T11:10:00.000Z';
    headers.push({ bubbleId: 'user' });
    put('bubbleId:t:user', { type: 1, text: '连续执行五个工具', createdAt: at });
    updateRoot();
    await reconcile();
    const initialRefreshes = calls.filter((c) => c.kind === 'update').length;
    for (let i = 0; i < 5; i++) {
      if (i >= 3) {
        headers.push({ bubbleId: `thinking-${i}` });
        put(`bubbleId:t:thinking-${i}`, { type: 2, createdAt: at, thinking: { text: `检查第 ${i + 1} 个工具` } });
      }
      headers.push({ bubbleId: `tool-${i}` });
      const body = { type: 2, createdAt: at, toolFormerData: { name: 'run_terminal_command_v2', status: 'running', params: JSON.stringify({ command: `echo result-${i}` }) } };
      put(`bubbleId:t:tool-${i}`, body);
      updateRoot();
      await reconcile();
      // The delivery watermark can be newer than a late native result timestamp.
      state.mirrorSubscriptions.get('binding').lastDeliveredAt = new Date().toISOString();
      put(`bubbleId:t:tool-${i}`, { ...body, toolFormerData: { ...body.toolFormerData, status: 'completed', result: JSON.stringify({
        output: `RESULT-${i}\n${i === 2 ? '@@ patch @@\n- before\n+ after\n'.repeat(30) : ''}END-${i}`,
      }) } });
      await reconcile();
      assert.equal(finalized, 0);
      assert.equal(calls.filter((c) => c.kind === 'settings').length, 0);
      assert.equal(calls.filter((c) => c.kind === 'create').length, 1);
      assert.equal(calls.filter((c) => c.kind === 'message').length, 1);
      assert.equal(calls.filter((c) => c.kind === 'update').length, initialRefreshes, 'tool changes must not refresh the whole card');
    }
    const before = statCursorDesktopStore(file);
    status = 'completed';
    await reconcile();
    await reconcile();
    assert.deepEqual(statCursorDesktopStore(file), before);
    assert.equal(finalized, 1);
    assert.equal(streams.size, 1);
    assert.equal(calls.filter((c) => c.kind === 'settings').length, 1);
    assert.equal(calls.filter((c) => c.kind === 'update').length, initialRefreshes + 1, 'only finalization updates the whole card after the user boundary');
    assert.equal(calls.filter((c) => c.kind === 'batch').length, 0, 'tool children use explicit element endpoints before content updates');
    for (const call of calls) {
      const patches = call.kind === 'patch' ? [JSON.parse(call.payload.data.partial_element)]
        : call.kind === 'batch' ? JSON.parse(call.payload.data.actions).filter((a: any) => a.action === 'partial_update_element').map((a: any) => JSON.parse(a.partial_element)) : [];
      for (const patch of patches) {
        assert.equal('expanded' in patch, false);
        assert.equal('elements' in patch, false);
      }
    }
    const final = calls.filter((c) => c.kind === 'update').at(-1)!;
    for (let i = 0; i < 5; i++) assert.match(JSON.stringify(final.payload), new RegExp(`END-${i}`));
    assert.ok(calls.filter((c) => c.kind === 'message').every((c) => c.payload.data.msg_type === 'interactive'));
  } finally {
    runtime?.clearMirrorSubscriptions();
    await adapter.stop();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
