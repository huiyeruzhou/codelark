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

it('distinguishes transport submission, queueing and acceptance outside the topic without moving the live card', async () => {
  const f = fixture();
  f.adapter.onMessageStart(chatId, 'live', 'om_origin'); await f.a.cardCreatePromises.get('live');
  await f.adapter.onInputDelivery(input('om_inside', { threadRootMessageId: 'om_origin' }), 'accepted');
  assert.equal(f.sent.length, 1);
  for (const [status, expected] of [['submitted', '接收状态待确认'], ['queued', '已排队'], ['accepted', '模型已接收']] as const) {
    await f.adapter.onInputDelivery(input(`om_${status}`), status);
    assert.match(f.sent.at(-1).data.content, new RegExp(expected));
    assert.match(f.sent.at(-1).data.content, /om_card1/);
    assert.equal(f.sent.at(-1).path.message_id, `om_${status}`);
    assert.equal(f.a.activeCards.get('live').replyToMessageId, 'om_origin');
  }
  f.adapter.onMessageEnd(chatId, 'live');
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
