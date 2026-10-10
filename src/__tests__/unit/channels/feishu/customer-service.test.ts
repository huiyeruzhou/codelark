import '../../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FeishuAdapter } from '../../../../channels/feishu/adapter.js';
import { parseTopicConversationId, resolveTopicAddress, topicConversationId, canControlCustomerService } from '../../../../channels/feishu/customer-service.js';
import { initBridgeTestContext } from '../../../helpers/bridge/test-bridge-utils.js';
import * as router from '../../../../bridge/session/channel-router.js';
import { createConfigService } from '../../../../configuration/service.js';
import { _testOnly as manager } from '../../../../bridge/host/manager.js';
import { JsonFileStore } from '../../../../storage/json-store.js';

const chatId = 'oc_service';
const admin = 'ou_admin';
function adapter(config: Record<string, unknown> = {}) {
  const result = new FeishuAdapter({ id: 'feishu-default', alias: '客服', provider: 'feishu', enabled: true,
    config: { customerServiceChats: [chatId], customerServiceControlUsers: [admin], requireMention: true, allowedUsers: [admin], ...config } });
  (result as any).running = true;
  return result;
}
function event(id: string, text: string, extra = {}, user = 'ou_customer') {
  return { sender: { sender_type: 'user', sender_id: { open_id: user } }, message: {
    message_id: id, chat_id: chatId, chat_type: 'group', message_type: 'text', content: JSON.stringify({ text }), create_time: String(Date.now()), ...extra,
  } };
}
function transport(a: FeishuAdapter) {
  const sent: any[] = [];
  (a as any).restClient = { im: { message: {
    reply: async (p: any) => { sent.push({ method: 'reply', ...p }); return { code: 0, data: { message_id: `om_sent${sent.length}` } }; },
    create: async (p: any) => { sent.push({ method: 'create', ...p }); return { code: 0, data: { message_id: `om_sent${sent.length}` } }; },
    get: async (p: any) => ({ code: 0, data: { items: [{ message_id: p.path.message_id, chat_id: chatId, root_id: 'om_root', thread_id: 'omt_thread' }] } }),
  } } };
  return sent;
}

describe('customer service topics', () => {
  it('uses stable root identity before and after a thread exists, including multi-hop ordinary replies', async () => {
    const root = { chatId, rootMessageId: 'om_root' };
    assert.deepEqual(parseTopicConversationId(topicConversationId(root)), root);
    const noRead = async (): Promise<never> => { throw Error('unexpected fetch'); };
    const direct = await resolveTopicAddress(chatId, { message_id: 'om_reply', root_id: 'om_root', parent_id: 'om_parent', thread_id: 'omt_thread' }, noRead, noRead);
    assert.equal(topicConversationId(direct), topicConversationId(root));
    const chain = await resolveTopicAddress(chatId, { message_id: 'om_third', parent_id: 'om_second' }, async (id) =>
      id === 'om_second' ? { message_id: id, parent_id: 'om_root' } : { message_id: id }, noRead);
    assert.equal(topicConversationId(chain), topicConversationId(root));
    const threadOnly = await resolveTopicAddress(chatId, { message_id: 'om_unknown', thread_id: 'omt_thread' }, noRead,
      async () => ({ message_id: 'om_root', chat_id: chatId }));
    assert.equal(topicConversationId(threadOnly), topicConversationId(root));
    await assert.rejects(resolveTopicAddress(chatId, { message_id: 'om_x', parent_id: 'om_y' }, async () => ({ message_id: 'om_y', chat_id: 'oc_other' }), noRead), /different/);
    await assert.rejects(resolveTopicAddress(chatId, { message_id: 'om_x', parent_id: 'om_x' }, async () => ({ message_id: 'om_x', parent_id: 'om_x' }), noRead), /Cyclic/);
  });

  it('accepts questions when the group permits no mention, isolates topics and resumes bindings after store reload', async () => {
    const store = initBridgeTestContext();
    const a = adapter(); transport(a);
    const groupBinding = router.resolve({ channelType: a.channelType, chatId, chatKind: 'group' });
    createConfigService({ migrate: false }).set({ kind: 'session', sessionId: groupBinding.bridgeSessionId }, { session: { requireMention: false }, runtime: { codex: { model: 'inherited-service-model' } } });
    store.updateSession(groupBinding.bridgeSessionId, { runtime: { codex: { threadId: 'must-not-reuse-parent' } } });
    await (a as any).processIncomingEvent(event('om_root', '问题 A'));
    const first = await a.consumeOne(); assert(first);
    assert.equal(first.address.chatId, topicConversationId({ chatId, rootMessageId: 'om_root' }));
    const binding = router.resolve(first.address);
    assert.equal(createConfigService({ migrate: false }).get('runtime.codex.model', { kind: 'session', sessionId: binding.bridgeSessionId }), 'inherited-service-model');
    assert.equal(store.getSession(binding.bridgeSessionId)?.runtime?.codex?.threadId, undefined);
    await (a as any).processIncomingEvent(event('om_secondroot', '问题 B'));
    const second = await a.consumeOne(); assert(second);
    const other = router.resolve(second.address);
    assert.notEqual(binding.bridgeSessionId, other.bridgeSessionId);
    await (a as any).processIncomingEvent(event('om_followup', 'A 的追问', { root_id: 'om_root', parent_id: 'om_sent1', thread_id: 'omt_thread' }));
    const follow = await a.consumeOne(); assert(follow);
    assert.equal(router.resolve(follow.address).bridgeSessionId, binding.bridgeSessionId);
    const reloaded = new JsonFileStore(new Map());
    assert.equal(reloaded.getChannelChat(first.address.channelType, first.address.chatId)?.bridgeSessionId, binding.bridgeSessionId);
    assert.equal(store.getChannelChat(first.address.channelType, first.address.chatId)?.feishuTopic?.chatId, chatId);
  });

  it('blocks commands and every card callback without granting authority through a group ID or empty whitelist', async () => {
    initBridgeTestContext(); const a = adapter(); const sent = transport(a);
    assert.equal(canControlCustomerService({ customerServiceControlUsers: [chatId] }, chatId), false);
    assert.equal(canControlCustomerService({ customerServiceControlUsers: [] }, admin), false);
    await (a as any).processIncomingEvent(event('om_stop', '/stop'));
    assert.equal((a as any).inboundQueue.length, 0);
    assert.equal(sent[0].data.reply_in_thread, true);
    assert.match(sent[0].data.content, /白名单/);
    (a as any).getTopicMessage = async () => { throw Error('must not fetch in callback response'); };
    const cb = { operator: { open_id: 'ou_customer' }, context: { open_chat_id: chatId, open_message_id: 'om_card' }, action: { value: { callback_data: 'clk-feishu-group-authorized' } } };
    const denial = await (a as any).handleCardAction(cb);
    assert.equal(denial.toast.type, 'error');
    assert.equal((a as any).inboundQueue.length, 0);
    await (a as any).processIncomingEvent(event('om_admin', '/stop', { root_id: 'om_root' }, admin));
    const command = await a.consumeOne(); assert.equal(command?.text, '/stop');
    assert(command); router.resolve(command.address);
    await (a as any).handleCardAction({ ...cb, operator: { open_id: admin }, action: { value: { callback_data: 'cmd:/stop' } } });
    (a as any).getTopicMessage = async () => ({ message_id: 'om_card', root_id: 'om_root', chat_id: chatId });
    const callback = await a.consumeOne(); assert.equal(callback?.address.chatId, topicConversationId({ chatId, rootMessageId: 'om_root' }));
  });

  it('keeps every output form and fallback in its topic, never sends a synthetic ID to Feishu', async () => {
    initBridgeTestContext(); const a = adapter(); const sent = transport(a);
    const address = { channelType: a.channelType, chatId: topicConversationId({ chatId, rootMessageId: 'om_root' }) };
    for (const message of [
      { text: '纯文本', parseMode: 'plain' as const }, { text: '**正文**' }, { text: '```ts\nconst a = 1;\n```' },
      { text: '', richCard: { title: '客服', sections: [{ markdown: '完整答复' }] } },
      { text: '', platformMessage: { msgType: 'text', content: { text: '结构化' }, uuid: 'dedup-test' } },
      { text: '批准', inlineButtons: [[{ text: '允许', callbackData: 'perm:allow:request1' }]] },
    ]) assert.equal((await a.send({ address, ...message })).ok, true);
    assert.equal(sent.length, 6);
    for (const call of sent) { assert.equal(call.method, 'reply'); assert.equal(call.path.message_id, 'om_root'); assert.equal(call.data.reply_in_thread, true); }
    assert.equal(sent[4].data.uuid, 'dedup-test');
    await a.send({ address: { ...address, chatId: 'oc_regular' }, text: '普通群', parseMode: 'plain' });
    assert.equal(sent.at(-1).method, 'create'); assert.equal(sent.at(-1).data.receive_id, 'oc_regular');
  });
  it('checks the host dispatch boundary and retires all topics when their group is removed', async () => {
    const store = initBridgeTestContext(); const a = adapter(); transport(a);
    const address = { channelType: a.channelType, chatId: topicConversationId({ chatId, rootMessageId: 'om_root' }), feishuTopic: { chatId, rootMessageId: 'om_root' }, userId: 'ou_customer' };
    const binding = router.resolve(address);
    await manager.handleMessage(a, { messageId: 'om_control', address, text: '/model unauthorized-model', timestamp: Date.now() });
    assert.notEqual(createConfigService({ migrate: false }).get('runtime.codex.model', { kind: 'session', sessionId: binding.bridgeSessionId }), 'unauthorized-model');
    const second = router.resolve({ ...address, chatId: topicConversationId({ chatId, rootMessageId: 'om_second' }), feishuTopic: { chatId, rootMessageId: 'om_second' } });
    const other = router.resolve({ channelType: a.channelType, chatId: 'oc_other', chatKind: 'group' });
    await manager.handleMessage(a, { messageId: 'event_remove', address: { channelType: a.channelType, chatId }, text: '', timestamp: Date.now(), channelEvent: { type: 'chat_removed', reason: 'bot_removed' } });
    assert.equal(store.getChannelChat(a.channelType, binding.chatId), null);
    assert.equal(store.getChannelChat(a.channelType, second.chatId), null);
    assert.equal(store.getChannelChat(a.channelType, other.chatId)?.id, other.id);
    manager.resetStateForTests();
  });

  it('uses the physical group for Drive membership permission', async () => {
    const a = adapter(); let actual: any;
    (a as any).restClient = { drive: { v1: { permissionMember: { create: async (request: any) => { actual = request; return { code: 0 }; } } } } };
    const warnings = await (a as any).makeDriveFileVisibleToChat('file_token', { channelType: a.channelType, chatKind: 'group', chatId: topicConversationId({ chatId, rootMessageId: 'om_root' }) });
    assert.deepEqual(warnings, []);
    assert.equal(actual.data.member_id, chatId);
  });

  it('keeps top-level admin commands and their cards in group configuration scope', async () => {
    initBridgeTestContext(); const a = adapter(); transport(a);
    await (a as any).processIncomingEvent(event('om_adminroot', '/current', {}, admin));
    const message = await a.consumeOne(); assert(message);
    assert.equal(message.address.chatId, chatId);
    assert.equal(message.address.feishuTopic, undefined);
    await (a as any).processIncomingEvent(event('om_adminpost', '', { message_type: 'post', content: JSON.stringify({ title: '', content: [[{ tag: 'text', text: '/current' }]] }) }, admin));
    assert.equal((a as any).inboundQueue.length, 1, 'received post payload should enqueue a control');
    const post = await a.consumeOne(); assert.equal(post?.address.chatId, chatId);
    router.resolve(message.address);
    await (a as any).handleCardAction({ operator: { open_id: admin }, context: { open_chat_id: chatId, open_message_id: 'om_card' }, action: { value: { callback_data: 'cmd:/current' } } });
    const callback = await a.consumeOne(); assert.equal(callback?.address.chatId, chatId);
  });

  it('follows the physical group mention setting for new questions and existing topic replies', async () => {
    initBridgeTestContext(); const a = adapter(); transport(a);
    (a as any).botIds.add('ou_bot');
    const group = router.resolve({ channelType: a.channelType, chatId, chatKind: 'group' });
    const config = createConfigService({ migrate: false });
    const scope = { kind: 'session' as const, sessionId: group.bridgeSessionId };
    config.set(scope, { session: { requireMention: true } });
    await (a as any).processIncomingEvent(event('om_no_at', '未 @ 的首问'));
    assert.equal((a as any).inboundQueue.length, 0);
    const mentions = [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: '客服' }];
    await (a as any).processIncomingEvent(event('om_with_at', '@_user_1 首问', { mentions }));
    assert.equal((a as any).inboundQueue.length, 1);
    const first = await a.consumeOne(); assert(first);
    const topic = router.resolve(first.address);
    // A topic-local setting must not supersede the physical group's ingress rule.
    config.set({ kind: 'session', sessionId: topic.bridgeSessionId }, { session: { requireMention: false } });
    await (a as any).processIncomingEvent(event('om_follow_no_at', '未 @ 的追问', { root_id: 'om_with_at', parent_id: 'om_answer' }));
    assert.equal((a as any).inboundQueue.length, 0);
    await (a as any).processIncomingEvent(event('om_follow_at', '@_user_1 追问', { root_id: 'om_with_at', parent_id: 'om_answer', mentions }));
    assert.equal((a as any).inboundQueue.length, 1);
    assert.equal((await a.consumeOne())?.address.chatId, first.address.chatId);
    config.set(scope, { session: { requireMention: false } });
    await (a as any).processIncomingEvent(event('om_follow_off', '关闭群 @ 要求后的追问', { root_id: 'om_with_at' }));
    assert.equal((a as any).inboundQueue.length, 1);
    assert.equal((await a.consumeOne())?.address.chatId, first.address.chatId);
    config.set(scope, { session: { requireMention: true } });
    await (a as any).processIncomingEvent(event('om_follow_on', '重新开启群 @ 要求后的追问', { root_id: 'om_with_at' }));
    assert.equal((a as any).inboundQueue.length, 0);
  });

});
