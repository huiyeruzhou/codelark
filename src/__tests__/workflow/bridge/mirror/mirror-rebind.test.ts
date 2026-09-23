import '../../../setup/test-setup.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMirrorRuntime } from '../../../../bridge/mirror/runtime.js';
import { mirrorReadPosition } from '../../../../bridge/mirror/subscription-state.js';
import { consumeMirrorRecords, consumeBufferedMirrorTurns, hasPendingMirrorWork } from '../../../../bridge/mirror/turns.js';
import type { BridgeSession } from '../../../../domain/session.js';

for (const mode of ['rebind', 'restart', 'same-poll', 'legacy']) it(`resumes after the skills request: ${mode}`, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-rebind-'));
  const filePath = path.join(root, 'rollout.jsonl');
  const sessionPath = path.join(root, 'session.json');
  const request = '然后你把我这一整套逻辑整理回skills，包括这各种设计';
  const message = (timestamp: string, text: string, role = 'assistant') => JSON.stringify({
    timestamp, type: 'response_item', payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] },
  }) + '\n';
  fs.writeFileSync(filePath, JSON.stringify({ timestamp: '2026-09-23T16:10:54.220Z', type: 'event_msg',
    payload: { type: 'task_started', turn_id: 'long-turn' } }) + '\n'
    + message('2026-09-23T16:11:00.000Z', '二十多分钟前的旧内容')
    + message('2026-09-23T16:34:44.380Z', request, 'user'));
  let session: BridgeSession = { id: 'session-1', runtime: { activeRuntime: 'codex', codex: { threadId: 'thread-1' } },
    mirror_last_event_at: '2026-09-23T16:09:49.124Z' };
  let bindings = [{ id: 'old-binding', bridgeSessionId: session.id, channelType: 'feishu-default', chatId: 'old-chat' }];
  const received: Array<{ chat: string; content?: string }> = [];
  const state = { running: true, adapters: new Map([['feishu-default', { isRunning: () => true }]]),
    mirrorSubscriptions: new Map(), mirrorSyncInFlight: false, mirrorWakeTimer: null, activeTasks: new Map() };
  const makeRuntime = () => createMirrorRuntime(() => state as never, {
    watchDebounceMs: 100000, danglingThreadRetryLimit: 3, failureSuspendThreshold: 3, failureSuspendMs: 60000,
  }, {
    nowIso: () => '2026-09-23T16:36:10.392Z', describeUnknownError: String,
    listChannelChats: () => bindings, getSession: () => session, clearSessionCodexThreadId: () => {},
    getCodexSessionByThreadIdSafe: () => ({ filePath }) as never,
    syncMirrorSessionStateSafe: () => {
      for (const sub of state.mirrorSubscriptions.values()) {
        const position = mirrorReadPosition(sub);
        if (position) session.mirror_read_position = position;
      }
      fs.writeFileSync(sessionPath, JSON.stringify(session));
    },
    filterSuppressedMirrorRecords: (_id, records) => records, observeSessionHealthRecords: () => {},
    consumeMirrorRecords,
    flushTimedOutMirrorTurn: () => null,
    hasPendingMirrorWork,
    consumeBufferedMirrorTurns: sub => {
      for (const record of sub.bufferedRecords) received.push({ chat: sub.chatId, content: record.content });
      return consumeBufferedMirrorTurns(sub, 600000, Date.parse('2026-09-23T16:36:10.392Z'));
    },
    stopMirrorStreaming: () => {}, deliverMirrorTurns: async (_sub, turns) => ({ deliveredCount: turns.length }),
  });
  let runtime = makeRuntime();
  try {
    await runtime.reconcileMirrorSubscriptions();
    assert.ok(received.some(x => x.content === request));
    assert.ok(session.mirror_read_position?.lastEventSignature);
    const oldStreamKey = state.mirrorSubscriptions.get('old-binding').pendingTurn.streamKey;
    if (mode !== 'same-poll') {
      bindings = [];
      await runtime.reconcileMirrorSubscriptions();
    }
    received.length = 0;
    if (mode === 'restart') {
      runtime.clearMirrorSubscriptions();
      session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
      runtime = makeRuntime();
    }
    if (mode === 'legacy') {
      session.mirror_read_position = undefined;
      session.last_progress_at = '2026-09-23T16:34:44.380Z';
    }
    // 时间戳相同但事件不同，也不能因为只比较时间而漏掉。
    fs.appendFileSync(filePath, message(mode === 'legacy' ? '2026-09-23T16:35:00.000Z' : '2026-09-23T16:34:44.380Z', '解绑期间新增')
      + message('2026-09-23T16:36:10.000Z', '换群后的新进展'));
    bindings = [{ id: 'new-binding', bridgeSessionId: session.id, channelType: 'feishu-default', chatId: 'new-chat' }];
    await runtime.reconcileMirrorSubscriptions();
    const texts = received.filter(x => x.content).map(x => x.content);
    assert.deepEqual(texts, ['解绑期间新增', '换群后的新进展']);
    assert.ok(received.every(x => x.chat === 'new-chat'));
    const sub = state.mirrorSubscriptions.get('new-binding');
    assert.notEqual(sub.pendingTurn.streamKey, oldStreamKey, 'old-card finalization must not close the new binding card');
    assert.ok(!JSON.stringify(sub.pendingTurn.historyItems).includes(request));
    await runtime.reconcileMirrorSubscriptions();
    assert.equal(received.filter(x => x.content).length, 2);
  } finally {
    runtime.clearMirrorSubscriptions();
    if (state.mirrorWakeTimer) clearTimeout(state.mirrorWakeTimer);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
