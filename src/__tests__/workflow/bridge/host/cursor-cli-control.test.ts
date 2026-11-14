import '../../../setup/test-setup.js';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { initBridgeTestContext, RecordingAdapter } from '../../../helpers/bridge/test-bridge-utils.js';
import { createAdapterRuntime } from '../../../../channels/adapter-runtime/runtime.js';
import { _testOnly as manager } from '../../../../bridge/host/manager.js';
import { tmuxCore } from '../../../../runtime/tmux/core.js';
import { cursorTmuxSessionName } from '../../../../runtime/cursor/tmux-provider.js';
import { sseEvent } from '../../../../runtime/sse.js';
import type { StreamChatParams } from '../../../../runtime/contracts.js';

async function until(check: () => boolean) {
  for (let i = 0; i < 400; i++) { if (check()) return; await delay(5); }
  assert.ok(check(), 'input was blocked by the unfinished turn');
}

it('Cursor CLI acknowledges accepted input and appends in order through the adapter while the original stream stays open', async (t) => {
  manager.resetStateForTests();
  let controller: ReadableStreamDefaultController<string> | undefined;
  let params: StreamChatParams | undefined;
  let streams = 0;
  const store = initBridgeTestContext({ llm: { streamChat: (p) => {
    streams++; params = p;
    return new ReadableStream({ start(c) { controller = c; } });
  } } });
  const session = store.createSession('Cursor CLI control', 'model', undefined, os.tmpdir());
  const nativeId = '11111111-1111-4111-8111-111111111111';
  const target = cursorTmuxSessionName(session.id);
  store.updateSession(session.id, { runtime: { activeRuntime: 'cursor', cursor: { provider: 'tmux', transport: 'cli', sessionId: nativeId }, general: { tmuxSessionName: target } } });
  const address = { channelType: 'feishu', chatId: 'cursor-cli-control' };
  store.upsertChannelChat({ ...address, bridgeSessionId: session.id });
  class QueuedAdapter extends RecordingAdapter {
    running = true;
    reactions: string[] = [];
    isRunning() { return this.running; }
    consumeOne() { return this.consumeInboundMessage(this.running); }
    async stop() { this.running = false; this.rejectPendingInboundConsumers(); }
    async addMessageReaction(id: string, emoji: string) { assert.equal(emoji, 'Get'); this.reactions.push(id); return id; }
  }
  const adapter = new QueuedAdapter();
  const state = { adapters: new Map(), adapterMeta: new Map(), invalidAdapters: new Map(), loopAborts: new Map(), running: true };
  const jobs: Promise<void>[] = [];
  const finished: string[] = [];
  let locks = 0;
  const runtime = createAdapterRuntime(() => state, {
    notifyAdapterSetChanged: () => {},
    handleMessage: async (a, msg) => {
      const job = manager.handleMessageWithoutDeliveryWait(a, msg); jobs.push(job);
      await job; finished.push(msg.messageId);
    },
    processWithSessionLock: async (_id, fn) => { locks++; await fn(); },
    isCommandMessage: (msg) => manager.isBridgeCommandText(msg.text),
    shouldBypassSessionLock: manager.shouldBypassSessionLock,
    getImmediateLane: manager.adapterImmediateLane,
    getSessionLane: manager.adapterSessionLane,
    resolveSessionIdForMessage: () => session.id,
  });
  const originals = { hasSession: tmuxCore.hasSession, sendActions: tmuxCore.sendActions, capturePane: tmuxCore.capturePane, readPaneDead: tmuxCore.readPaneDead };
  let release!: () => void;
  const sending = new Promise<void>(resolve => { release = resolve; });
  const sent: string[] = [];
  tmuxCore.hasSession = async (name) => { assert.equal(name, target); return { exists: true, command: '' }; };
  tmuxCore.readPaneDead = async () => false;
  let acceptedHistory = '';
  tmuxCore.capturePane = async () => ({ screen: acceptedHistory + '\n→ Add a follow-up    ctrl+c to stop', command: '' });
  tmuxCore.sendActions = async (name, actions) => {
    assert.equal(name, target);
    sent.push(actions.filter(a => a.type === 'literal').map(a => a.text).join(''));
    assert.ok(actions.some(a => a.type === 'key' && a.key === 'Enter'));
    if (sent.length === 1) await sending;
    if (sent.at(-1) === 'failed input') throw new Error('test input failure');
    acceptedHistory += '\n' + sent.at(-1);
    return { commands: [] };
  };
  t.after(async () => {
    release(); state.running = false; await adapter.stop();
    controller?.enqueue(sseEvent('result', { session_id: nativeId, outcome: 'completed' })); controller?.close();
    await Promise.allSettled(jobs); manager.resetStateForTests(); Object.assign(tmuxCore, originals);
  });
  runtime.runAdapterLoop(adapter);
  const send = (text: string, messageId: string) => adapter.enqueueManualInboundMessage({ address, text, messageId, timestamp: Date.now() });
  send('start', 'first');
  await until(() => Boolean(params));
  assert.deepEqual([...adapter.reactions], [], 'opening a stream does not prove input acceptance');
  params!.onInputAccepted?.();
  await until(() => adapter.reactions.includes('first'));
  send('change direction', 'followup');
  await until(() => sent.length === 1);
  send('also compare controls', 'followup-2');
  await delay(50);
  assert.deepEqual(sent, ['change direction'], 'concurrent inputs must not interleave');
  assert.deepEqual([...adapter.reactions], ['first'], 'do not acknowledge before input completes');
  release();
  await until(() => adapter.reactions.includes('followup-2'));
  assert.deepEqual(sent, ['change direction', 'also compare controls']);
  assert.equal(streams, 1, 'follow-up must reuse the original output stream');
  assert.equal(locks, 1, 'follow-up must bypass both session lock and conversation barrier');
  assert.ok(!finished.includes('first'));
  send('failed input', 'failed');
  await until(() => finished.includes('failed'));
  assert.ok(!adapter.reactions.includes('failed'));
});
