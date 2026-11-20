import '../../../setup/test-setup.js';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { CODELARK_HOME } from '../../../../configuration/paths.js';
import { setTimeout as delay } from 'node:timers/promises';
import { initBridgeTestContext, RecordingAdapter } from '../../../helpers/bridge/test-bridge-utils.js';
import { createAdapterRuntime } from '../../../../channels/adapter-runtime/runtime.js';
import { _testOnly as manager } from '../../../../bridge/host/manager.js';
import { tmuxCore } from '../../../../runtime/tmux/core.js';
import { cursorTmuxSessionName } from '../../../../runtime/cursor/tmux-provider.js';
import { FeishuAdapter } from '../../../../channels/feishu/adapter.js';
import { createConfigService } from '../../../../configuration/service.js';
import { sseEvent } from '../../../../runtime/sse.js';
import type { StreamChatParams } from '../../../../runtime/contracts.js';

async function until(check: () => boolean) {
  for (let i = 0; i < 400; i++) { if (check()) return; await delay(5); }
  assert.ok(check(), 'input was blocked by the unfinished turn');
}

for (const threadMode of [false, true]) it(`Cursor CLI ${threadMode ? 'Feishu thread replies' : 'plain messages'} get acknowledged once and append in order while the original stream stays open`, async (t) => {
  const configPath = path.join(CODELARK_HOME, 'config.toml');
  const originalConfig = fs.existsSync(configPath) ? fs.readFileSync(configPath) : undefined;
  t.after(() => { if (originalConfig) fs.writeFileSync(configPath, originalConfig); else fs.rmSync(configPath, { force: true }); });
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
  const address = { channelType: 'feishu', chatId: 'oc_cursorclicontrol' };
  store.upsertChannelChat({ ...address, bridgeSessionId: session.id });
  class QueuedAdapter extends RecordingAdapter {
    running = true;
    reactions: string[] = [];
    isRunning() { return this.running; }
    consumeOne() { return this.consumeInboundMessage(this.running); }
    async stop() { this.running = false; this.rejectPendingInboundConsumers(); }
    async addMessageReaction(id: string, emoji: string) { assert.equal(emoji, 'Get'); this.reactions.push(id); return id; }
  }
  const threadInstance = { id: 'feishu', alias: 'Thread test', provider: 'feishu' as const, enabled: true,
    config: { appId: 'test', appSecret: 'test', requireMention: false, streamingEnabled: false, threadReplyChats: [address.chatId] } };
  class ThreadAdapter extends FeishuAdapter {
    reactions: string[] = [];
    constructor() {
      super(threadInstance);
      const a = this as any;
      a.running = true;
      a.restClient = { im: {
        messageReaction: { create: async (p: any) => {
          assert.equal(p.data.reaction_type.emoji_type, 'Get'); this.reactions.push(p.path.message_id);
          return { code: 0, data: { reaction_id: p.path.message_id } };
        } },
        message: { get: async () => ({ code: 0, data: { items: [] } }),
          create: async () => ({ code: 0, data: { message_id: 'notice' } }),
          reply: async () => ({ code: 0, data: { message_id: 'notice' } }) },
      } };
    }
  }
  if (threadMode) createConfigService({ migrate: false }).set({ kind: 'home' }, { channels: [threadInstance] });
  const adapter = threadMode ? new ThreadAdapter() : new QueuedAdapter();
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
  const originals = { hasSession: tmuxCore.hasSession, sendActions: tmuxCore.sendActions, capturePane: tmuxCore.capturePane, readPaneDead: tmuxCore.readPaneDead, injectPromptIntoPane: tmuxCore.injectPromptIntoPane };
  let release!: () => void;
  const sending = new Promise<void>(resolve => { release = resolve; });
  const sent: string[] = [];
  tmuxCore.hasSession = async (name) => { assert.equal(name, target); return { exists: true, command: '' }; };
  tmuxCore.readPaneDead = async () => false;
  let acceptedHistory = '';
  let draft = '';
  tmuxCore.capturePane = async () => ({ screen: acceptedHistory + `\n→ ${draft || 'Add a follow-up'}\nctrl+c to stop`, command: '' });
  tmuxCore.injectPromptIntoPane = async (pane, prompt, options) => {
    assert.equal(pane, `${target}:0.0`);
    draft = prompt;
    await options?.beforeSubmit?.();
    sent.push(prompt);
    if (sent.length === 1) await sending;
    if (prompt.endsWith('failed input')) throw new Error('test input failure');
    acceptedHistory += '\n' + prompt;
    draft = '';
    return { commands: [] };
  };
  t.after(async () => {
    release(); state.running = false;
    controller?.enqueue(sseEvent('result', { session_id: nativeId, outcome: 'completed' })); controller?.close();
    await Promise.allSettled(jobs); await adapter.stop(); manager.resetStateForTests(); Object.assign(tmuxCore, originals);
  });
  runtime.runAdapterLoop(adapter);
  const send = async (text: string, messageId: string) => {
    if (!threadMode) { adapter.enqueueManualInboundMessage({ address, text, messageId, timestamp: Date.now() }); return; }
    const event = { sender: { sender_type: 'user', sender_id: { open_id: 'ou_test' } }, message: {
      message_id: messageId, chat_id: address.chatId, chat_type: 'group', message_type: 'text',
      content: JSON.stringify({ text }), create_time: String(Date.now()),
      ...(messageId === 'followup-2' ? {} : { root_id: 'om_root', parent_id: 'om_root', thread_id: 'omt_one' }),
    } };
    await (adapter as any).processIncomingEvent(event);
    await (adapter as any).processIncomingEvent(event); // Feishu redelivery must not duplicate a steer or Get.
  };
  await send('start', 'first');
  await until(() => Boolean(params));
  if (threadMode) assert.equal(params!.prompt, 'start', 'thread ownership must not prepend the root message');
  assert.deepEqual([...adapter.reactions], [], 'opening a stream does not prove input acceptance');
  params!.onInputAccepted?.();
  await until(() => adapter.reactions.includes('first'));
  await send('change direction', 'followup');
  await until(() => sent.length === 1);
  await send('also compare controls', 'followup-2');
  await delay(50);
  assert.deepEqual(sent, ['change direction'], 'concurrent inputs must not interleave or prepend the thread root');
  assert.deepEqual([...adapter.reactions], ['first'], 'do not acknowledge before input completes');
  release();
  await until(() => adapter.reactions.includes('followup-2'));
  assert.deepEqual(sent, ['change direction', 'also compare controls']);
  assert.deepEqual(adapter.reactions, ['first', 'followup', 'followup-2'], 'Get belongs to each exact input, never the thread root or parent');
  assert.equal(streams, 1, 'follow-up must reuse the original output stream');
  assert.equal(locks, 1, 'follow-up must bypass both session lock and conversation barrier');
  assert.ok(!finished.includes('first'));
  const failedAudit: string[] = [];
  const insertAudit = store.insertAuditLog.bind(store);
  t.mock.method(store, 'insertAuditLog', (entry: Parameters<typeof store.insertAuditLog>[0]) => { if (entry.messageId === 'failed') failedAudit.push(entry.summary); insertAudit(entry); });
  await send('failed input', 'failed');
  await until(() => finished.includes('failed'));
  assert.ok(!adapter.reactions.includes('failed'));
  assert.ok(!failedAudit.some(summary => summary.includes('input actions completed')),
    'failed input must not be recorded as accepted');
});
