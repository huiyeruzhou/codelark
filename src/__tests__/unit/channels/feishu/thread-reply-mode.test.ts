import '../../../setup/test-setup.js';
import { it, after } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { CODELARK_HOME } from '../../../../configuration/paths.js';
import assert from 'node:assert/strict';
import { FeishuAdapter } from '../../../../channels/feishu/adapter.js';
import { createConfigService } from '../../../../configuration/service.js';
import { configToTomlShape, tomlToConfigPatch } from '../../../../configuration/schema.js';
import { initBridgeTestContext } from '../../../helpers/bridge/test-bridge-utils.js';
import * as router from '../../../../bridge/session/channel-router.js';
import type { InboundMessage } from '../../../../domain/index.js';

const configPath = path.join(CODELARK_HOME, 'config.toml');
const originalConfig = fs.existsSync(configPath) ? fs.readFileSync(configPath) : undefined;
after(() => { if (originalConfig) fs.writeFileSync(configPath, originalConfig); else fs.rmSync(configPath, { force: true }); });

const chatId = 'oc_threadtest';
const address = { channelType: 'feishu-threadtest', chatId, chatKind: 'group' as const, userId: 'ou_test' };
const input = (id: string, extra = {}): InboundMessage => ({ messageId: id, address, text: '补充', timestamp: Date.now(), ...extra });
function fixture() {
  const store = initBridgeTestContext();
  const instance = { id: address.channelType, alias: 'Thread test', provider: 'feishu' as const, enabled: true,
    config: { appId: 'test', appSecret: 'test', requireMention: false, streamingEnabled: true, threadReplyChats: [chatId] } };
  createConfigService({ migrate: false }).set({ kind: 'home' }, { channels: [instance] });
  const adapter = new FeishuAdapter(instance);
  const a = adapter as any;
  a.running = true;
  let cards = 0;
  let failCreate = false;
  const sent: any[] = [];
  const transmit = (method: string) => async (payload: any) => {
    sent.push({ method, ...payload }); return { code: 0, data: { message_id: `om_card${sent.length}` } };
  };
  a.restClient = {
    cardkit: { v1: { card: {
      create: async () => failCreate ? { code: 500 } : { data: { card_id: `card${++cards}` } },
      update: async () => ({}), settings: async () => ({}),
    }, cardElement: { content: async () => ({}), create: async () => ({}), patch: async () => ({}) } } },
    im: { message: { create: transmit('create'), reply: transmit('reply'),
      get: async (p: any) => ({ code: 0, data: { items: [{ message_id: p.path.message_id, chat_id: chatId,
        ...(p.path.message_id === 'om_origin' ? {} : { root_id: 'om_origin', thread_id: 'omt_one' }) }] } }),
    } },
  };
  return { adapter, a, sent, store, instance, failCreate: () => { failCreate = true; } };
}

it('shares group context across topic and outside replies, and persists only the output preference', async () => {
  const f = fixture();
  const original = router.resolve(address);
  for (const [id, metadata] of [['om_inside', { root_id: 'om_root', parent_id: 'om_parent', thread_id: 'omt_one' }], ['om_outside', {}]] as const) {
    await f.a.processIncomingEvent({ sender: { sender_type: 'user', sender_id: { open_id: 'ou_test' } }, message: {
      message_id: id, chat_id: chatId, chat_type: 'group', message_type: 'text', content: JSON.stringify({ text: '继续' }),
      create_time: String(Date.now()), ...metadata,
    } });
    const msg = await f.adapter.consumeOne(); assert(msg);
    assert.equal(msg.address.chatId, chatId);
    assert.equal(router.resolve(msg.address).bridgeSessionId, original.bridgeSessionId);
  }
  const patch = { channels: [{ id: address.channelType, config: { threadReplyChats: [chatId] } }] };
  assert.deepEqual(tomlToConfigPatch(configToTomlShape(patch)), patch);
  assert.match(f.adapter.manageThreadReplyMode(input('om_mode'), 'off'), /已关闭/);
  assert.match(new FeishuAdapter(f.instance).manageThreadReplyMode(input('om_status'), 'status'), /已关闭/);
  assert.equal(f.store.getChannelChat(address.channelType, chatId)?.bridgeSessionId, original.bridgeSessionId);
});

it('forwards thread continuations verbatim while preserving specific and ordinary quotes', async () => {
  const f = fixture();
  const reads: string[] = [];
  f.a.restClient.im.message.get = async (p: any) => {
    reads.push(p.path.message_id);
    return { code: 0, data: { items: [{ message_id: p.path.message_id, chat_id: chatId, msg_type: 'text',
      body: { content: JSON.stringify({ text: p.path.message_id === 'om_root' ? '/thread-mode on' : '具体回复内容' }) } }] } };
  };
  const binding = router.resolve(address);
  const text = '这个都fully-async了，就不用搞minibsz了吧？';
  const receive = async (id: string, metadata: Record<string, string>) => {
    await f.a.processIncomingEvent({ sender: { sender_type: 'user', sender_id: { open_id: 'ou_test' } }, message: {
      message_id: id, chat_id: chatId, chat_type: 'group', message_type: 'text', content: JSON.stringify({ text }),
      create_time: String(Date.now()), ...metadata,
    } });
    const msg = await f.adapter.consumeOne(); assert(msg);
    assert.equal(msg.text, text);
    assert.equal(router.resolve(msg.address).bridgeSessionId, binding.bridgeSessionId);
    return msg;
  };
  const continuation = await receive('om_continue', { root_id: 'om_root', parent_id: 'om_root', thread_id: 'omt_one' });
  assert.equal(continuation.contextText, undefined);
  assert.equal(continuation.replyToMessageId, 'om_root', 'delivery routing still retains the parent');
  assert.deepEqual(reads, [], 'ordinary continuation must not fetch or download the root');
  const specific = await receive('om_specific', { root_id: 'om_root', parent_id: 'om_specific_reply', thread_id: 'omt_one' });
  assert.match(specific.contextText!, /具体回复内容/);
  const ordinary = await receive('om_ordinary', { parent_id: 'om_root' });
  assert.match(ordinary.contextText!, /\/thread-mode on/);
  assert.deepEqual(reads, ['om_specific_reply', 'om_root']);
});

it('pins the initiating message through delayed creation, another incoming message, mode changes and continuation', async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const create = f.a.restClient.cardkit.v1.card.create;
  f.a.restClient.cardkit.v1.card.create = async () => { await gate; return create(); };
  f.a.lastIncomingMessageId.set(chatId, 'om_unrelated_latest');
  f.adapter.onMessageStart(chatId, 'turn-a', 'om_origin');
  f.a.lastIncomingMessageId.set(chatId, 'om_newer');
  f.adapter.manageThreadReplyMode(input('om_off'), 'off');
  f.adapter.onStreamText(chatId, '还在运行', 'turn-a');
  release();
  await f.a.cardCreatePromises.get('turn-a');
  const state = f.a.activeCards.get('turn-a'); assert(state);
  await f.a.rolloverStreamingCard('turn-a', state, { historyItemOffset: 0, historyToolCallOffset: 0, toolCallOffset: 0 }, '续页', '', '', [], {});
  assert.equal(f.sent.length, 2);
  for (const sent of f.sent) { assert.equal(sent.method, 'reply'); assert.equal(sent.path.message_id, 'om_origin'); assert.equal(sent.data.reply_in_thread, true); }
  f.adapter.onMessageEnd(chatId, 'turn-a');
  f.adapter.onMessageStart(chatId, 'turn-b', 'om_newer');
  await f.a.cardCreatePromises.get('turn-b');
  assert.equal(f.sent.at(-1).path.message_id, 'om_newer');
  assert.equal(f.sent.at(-1).data.reply_in_thread, undefined);
  f.adapter.onMessageEnd(chatId, 'turn-b');
});

it('keeps the original topic when creation fails and final output uses structured recovery', async () => {
  const f = fixture(); f.failCreate();
  f.adapter.onMessageStart(chatId, 'recover', 'om_origin');
  await f.a.cardCreatePromises.get('recover');
  f.a.lastIncomingMessageId.set(chatId, 'om_newer');
  f.adapter.onStreamText(chatId, '必须完整送达的结果', 'recover');
  assert.equal(await f.adapter.onStreamEnd(chatId, 'completed', '必须完整送达的结果', 'recover'), true);
  assert(f.sent.length > 0);
  for (const sent of f.sent) { assert.equal(sent.path.message_id, 'om_origin'); assert.equal(sent.data.reply_in_thread, true); }
  f.adapter.onMessageEnd(chatId, 'recover');
});

it('routes accepted outside steers by logical stream while inside and queued input keep the topic', async () => {
  const f = fixture();
  const stream = { streamKey: 'live', requestMessageId: 'om_origin' };
  f.adapter.onMessageStart(chatId, 'live', 'om_origin'); await f.a.cardCreatePromises.get('live');
  f.adapter.onMessageStart(chatId, 'monitor', 'om_monitor'); await f.a.cardCreatePromises.get('monitor');
  f.adapter.onStreamHistory(chatId, [
    { type: 'markdown', role: 'user', content: '首条输入' },
    { type: 'markdown', role: 'assistant', content: '正在处理' },
    { type: 'markdown', role: 'user', content: '同话题补充' },
    { type: 'markdown', role: 'user', content: '同话题再次补充' },
  ], 'live');
  await f.adapter.onInputDelivery(input('om_inside', { threadRootMessageId: 'om_origin' }), 'accepted', undefined, stream);
  await f.adapter.onInputDelivery(input('om_queued'), 'queued', undefined, stream);
  f.a.enqueueCardFlush('live'); await f.a.awaitCardFlushCompletion('live');
  assert.equal(f.sent.length, 2);
  await f.adapter.onInputDelivery(input('om_outside'), 'submitted', undefined, stream);
  f.a.enqueueCardFlush('live'); await f.a.awaitCardFlushCompletion('live');
  assert.equal(f.sent.length, 3);
  assert.equal(f.sent.at(-1).path.message_id, 'om_outside');
  assert.equal(f.sent.at(-1).data.reply_in_thread, true);
  assert.equal(f.a.activeCards.get('monitor').replyToMessageId, 'om_monitor');
  await f.adapter.onInputDelivery(input('om_origin'), 'accepted', undefined, stream);
  await f.adapter.onInputDelivery(input('om_again', { threadRootMessageId: 'om_outside' }), 'accepted', undefined, stream);
  f.a.enqueueCardFlush('live'); await f.a.awaitCardFlushCompletion('live');
  assert.equal(f.sent.length, 3, 'inside input and delayed original receipt must not move or duplicate the card');
  await f.adapter.onInputDelivery(input('om_new_topic'), 'accepted', undefined, stream);
  assert(await f.adapter.onStreamEnd(chatId, 'completed', '最终输出留在新话题', 'live'));
  assert.equal(f.sent.at(-1).path.message_id, 'om_new_topic');
  f.adapter.onMessageEnd(chatId, 'live'); f.adapter.onMessageEnd(chatId, 'monitor');
});

it('remembers an outside steer before card creation finishes and recovers to that topic after creation failure', async () => {
  for (const failed of [false, true]) {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const create = f.a.restClient.cardkit.v1.card.create;
    f.a.restClient.cardkit.v1.card.create = async () => { await gate; return failed ? { code: 500 } : create(); };
    f.adapter.onMessageStart(chatId, 'delayed', 'om_origin');
    await f.adapter.onInputDelivery(input('om_outside'), 'accepted', undefined, { streamKey: 'delayed', requestMessageId: 'om_origin' });
    assert.equal(f.a.streamReplyTargets.get('delayed').messageId, 'om_outside');
    release(); await f.a.cardCreatePromises.get('delayed');
    if (!failed) { f.a.enqueueCardFlush('delayed'); await f.a.awaitCardFlushCompletion('delayed'); }
    f.adapter.onStreamHistory(chatId, [{ type: 'markdown', role: 'user', content: '新话题补充' }, { type: 'markdown', role: 'assistant', content: '继续原运行' }], 'delayed');
    assert(await f.adapter.onStreamEnd(chatId, 'completed', '继续原运行', 'delayed'));
    assert.equal(f.sent.at(-1).path.message_id, 'om_outside');
    f.adapter.onMessageEnd(chatId, 'delayed');
  }
});


it('keeps model questions alongside their active card', async () => {
  const f = fixture();
  f.adapter.onMessageStart(chatId, 'question', 'om_origin'); await f.a.cardCreatePromises.get('question');
  const cardId = f.sent[0].data.content;
  assert(cardId);
  await f.adapter.send({ address, text: '选择方案', richCard: { title: '需要你的回答', sections: [{ markdown: '选择方案' }] } });
  assert.equal(f.sent.at(-1).path.message_id, 'om_card1');
  assert.equal(f.sent.at(-1).data.reply_in_thread, true);
  f.adapter.onMessageEnd(chatId, 'question');
});

it('keeps source-less and legacy manual mirror output in one card despite newer chat input', async () => {
  for (const source of [undefined, 'manual:internal-submission']) {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const create = f.a.restClient.cardkit.v1.card.create;
    f.a.restClient.cardkit.v1.card.create = async () => { await gate; return create(); };
    f.adapter.onMirrorStreamStart(chatId, 'local-native', source);
    f.a.lastIncomingMessageId.set(chatId, 'om_unrelated');
    f.adapter.onStreamHistory(chatId, [{ type: 'markdown', role: 'assistant', content: '本地原生输出' }], 'local-native');
    f.adapter.onStreamText(chatId, '本地原生输出', 'local-native');
    release(); await f.a.cardCreatePromises.get('local-native');
    f.a.enqueueCardFlush('local-native'); await f.a.awaitCardFlushCompletion('local-native');
    assert(await f.adapter.onStreamEnd(chatId, 'completed', '本地原生输出', 'local-native'));
    assert.equal(f.sent.length, 1, 'no phantom card followed by a topic rollover');
    assert.equal(f.sent[0].method, 'create', 'internal input IDs and unrelated input are never reply targets');
    assert.equal(f.a.streamReplyTargets.has('local-native'), false);
  }
});

it('allows a real accepted steer to establish a topic after a source-less local turn', async () => {
  const f = fixture();
  f.adapter.onMirrorStreamStart(chatId, 'local-native'); await f.a.cardCreatePromises.get('local-native');
  assert.equal(await f.adapter.onInputDelivery(input('manual:job'), 'accepted', undefined, { streamKey: 'local-native' }), false);
  await f.adapter.onInputDelivery(input('om_outside'), 'accepted', undefined, { streamKey: 'local-native' });
  f.a.enqueueCardFlush('local-native'); await f.a.awaitCardFlushCompletion('local-native');
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[1].path.message_id, 'om_outside');
  assert.equal(f.sent[1].data.reply_in_thread, true);
  f.adapter.onMessageEnd(chatId, 'local-native');
});

it('releases routing after final output so a subsequent screen stream uses its own initiating topic', async () => {
  const f = fixture();
  const key = 'tmux-screen:reused';
  for (const origin of ['om_origin', 'om_new_topic']) {
    f.adapter.onMessageStart(chatId, key, origin);
    await f.a.cardCreatePromises.get(key);
    assert.equal(f.sent.at(-1).path.message_id, origin);
    f.adapter.onStreamText(chatId, '屏幕监控已结束', key);
    assert(await f.adapter.onStreamEnd(chatId, 'completed', '屏幕监控已结束', key));
    assert.equal(f.a.streamReplyTargets.has(key), false);
    assert.equal(f.a.streamReplyChanges.has(key), false);
  }
});


it('pins a long-running shell monitor to its initiating thread through other messages and stop-like completion', async () => {
  const { handleTerminalDispatchCommand } = await import('../../../../bridge/command/dispatch-terminal.js');
  const f = fixture();
  const binding = router.resolve(address);
  f.a.lastIncomingMessageId.set(chatId, 'om_unrelated');
  await handleTerminalDispatchCommand({ adapter: f.adapter, msg: { ...input('om_origin'), text: '/shell --force echo monitor' },
    command: '/shell', args: '--force echo monitor', currentBinding: binding, commandBinding: binding, store: f.store, markdown: true,
    deps: { shellRunner: async request => {
      request.onProgress?.({ stdout: 'MONITOR_RUNNING', stderr: '' });
      await Promise.all([...f.a.cardCreatePromises.values()]);
      f.a.lastIncomingMessageId.set(chatId, 'om_outside');
      request.onProgress?.({ stdout: 'MONITOR_UPDATED', stderr: '' });
      return { exitCode: 0, stdout: 'MONITOR_STOPPED', stderr: '' };
    } },
  });
  assert.ok(f.sent.length > 0);
  for (const sent of f.sent) {
    assert.equal(sent.method, 'reply'); assert.equal(sent.path.message_id, 'om_origin'); assert.equal(sent.data.reply_in_thread, true);
  }
  for (const key of f.a.activeCards.keys()) f.adapter.onMessageEnd(chatId, key);
});
