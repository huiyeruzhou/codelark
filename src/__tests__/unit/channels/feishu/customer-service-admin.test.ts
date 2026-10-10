import '../../../setup/test-setup.js';
import { afterEach, beforeEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { editCustomerServiceMode, editCustomerServiceWhitelist } from '../../../../channels/feishu/customer-service-admin.js';
import { FeishuAdapter } from '../../../../channels/feishu/adapter.js';
import { createConfigService } from '../../../../configuration/service.js';
import { initBridgeTestContext, resetBridgeTestState } from '../../../helpers/bridge/test-bridge-utils.js';
import { _testOnly as manager } from '../../../../bridge/host/manager.js';
import { _testOnlyWaitForDeliveryQueuesForTests } from '../../../../channels/delivery/deliver.js';
import { topicConversationId } from '../../../../channels/feishu/customer-service.js';
import { isKnownBridgeCommand } from '../../../../bridge/command/aliases.js';
import { sessionRequiresMention } from '../../../../bridge/session/require-mention.js';
import { getBridgeContext } from '../../../../bridge/context.js';

beforeEach(() => { manager.resetStateForTests(); resetBridgeTestState(); initBridgeTestContext(); });
afterEach(() => { manager.resetStateForTests(); resetBridgeTestState(); });
const chatId = 'oc_service';
const config = { appId: 'cli_self', customerServiceChats: [chatId], customerServiceControlUsers: ['ou_admin'], allowedUsers: ['ou_legacy'] };
const address = (userId = 'ou_admin') => ({ channelType: 'feishu-admin-test', chatId, chatKind: 'group' as const, userId });
function setup(overrides: Partial<typeof config> = {}) {
  const instance = { id: address().channelType, alias: '客服管理测试', provider: 'feishu' as const, enabled: true, config: { ...config, ...overrides } };
  createConfigService({ migrate: false }).set({ kind: 'home' }, { channels: [instance,
    { id: 'feishu-unrelated', provider: 'feishu', config: { customerServiceControlUsers: ['ou_other'] } }] });
  const a = new FeishuAdapter(instance);
  (a as any).running = true;
  (a as any).botIds.add('ou_bot');
  const sent: any[] = [];
  (a as any).restClient = { application: { application: { get: async () => ({ code: 0, data: { app: { app_id: 'cli_self', creator_id: 'ou_creator' } } }) } }, im: { message: {
    create: async (p: any) => { sent.push(p); return { code: 0, data: { message_id: `om_sent${sent.length}` } }; },
    reply: async (p: any) => { sent.push(p); return { code: 0, data: { message_id: `om_sent${sent.length}` } }; },
    get: async (p: any) => ({ code: 0, data: { items: [{ message_id: p.path.message_id, chat_id: chatId, root_id: 'om_root' }] } }),
  } } };
  return { a, sent, instance };
}
const mention = (id: string, n: number) => ({ key: `@_user_${n}`, id: { open_id: id }, name: id });
const event = (id: string, text: string, extra = {}, userId = 'ou_admin') => ({
  sender: { sender_type: 'user', sender_id: { open_id: userId } }, message: { message_id: id, chat_id: chatId,
    chat_type: 'group', message_type: 'text', content: JSON.stringify({ text }), create_time: String(Date.now()), ...extra },
});
const users = () => createConfigService({ migrate: false }).snapshot().config.channels.find((c) => c.id === address().channelType)!.config.customerServiceControlUsers;
const chats = () => createConfigService({ migrate: false }).snapshot().config.channels.find((c) => c.id === address().channelType)!.config.customerServiceChats;

it('customer mode edits only the current physical group and validates authority, scope and syntax', () => {
  assert.equal(isKnownBridgeCommand('/customer'), true);
  const base = { config: { ...config, customerServiceChats: ['oc_other'] }, address: address(), args: 'on' };
  assert.deepEqual(editCustomerServiceMode(base).chats, ['oc_other', chatId]);
  assert.equal(editCustomerServiceMode({ ...base, args: '' }).chats, undefined);
  assert.match(editCustomerServiceMode({ ...base, args: 'status' }).text, /off（未开启）/);
  assert.equal(editCustomerServiceMode({ ...base, args: 'off' }).chats, undefined);
  for (const args of ['on oc_other', 'maybe', 'off all']) {
    assert.match(editCustomerServiceMode({ ...base, args }).text, /配置未修改/);
  }
  assert.match(editCustomerServiceMode({ ...base, address: { ...address(), chatKind: 'p2p' } }).text, /请在/);
  assert.match(editCustomerServiceMode({ ...base, address: address('ou_guest') }).text, /只有客服控制白名单/);
  const topic = { ...address(), chatId: topicConversationId({ chatId, rootMessageId: 'om_root' }) };
  assert.deepEqual(editCustomerServiceMode({ ...base, config, address: topic, args: 'off' }).chats, []);
  assert.equal(editCustomerServiceMode({ ...base, config, args: 'on' }).chats, undefined);
});

it('creator enables an ordinary group without setup; old adapters route immediately and reply commands can reenable it', async () => {
  const { a, instance, sent } = setup({ customerServiceChats: [], customerServiceControlUsers: [], allowedUsers: [] });
  const old = new FeishuAdapter(instance);
  (old as any).running = true;
  (old as any).restClient = (a as any).restClient;
  await (a as any).processIncomingEvent(event('om_enable', '/customer on', {}, 'ou_creator'));
  const enable = await a.consumeOne(); assert(enable);
  assert.equal(enable.address.chatId, chatId);
  await manager.handleMessage(a, enable);
  await _testOnlyWaitForDeliveryQueuesForTests(a);
  assert.deepEqual(chats(), [chatId]);
  assert.deepEqual(users(), []);
  assert.match(sent.at(-1).data.content, /已开启当前群客服模式/);
  const question = event('om_question', 'hello', {}, 'ou_guest');
  await (old as any).processIncomingEvent(question);
  assert.equal((await old.consumeOne())?.address.chatId, topicConversationId({ chatId, rootMessageId: 'om_question' }));
  await (a as any).processIncomingEvent(event('om_disable', '/customer off', { root_id: 'om_root', parent_id: 'om_parent' }, 'ou_creator'));
  const disable = await a.consumeOne(); assert(disable);
  assert.equal(disable.address.chatId, topicConversationId({ chatId, rootMessageId: 'om_root' }));
  await manager.handleMessage(a, disable);
  await _testOnlyWaitForDeliveryQueuesForTests(a);
  assert.deepEqual(chats(), []);
  assert.equal(sent.at(-1).path.message_id, 'om_root');
  await (old as any).processIncomingEvent(event('om_normal', 'normal again', {}, 'ou_guest'));
  assert.equal((await old.consumeOne())?.address.chatId, chatId);
  // With only parent_id, the existing ordinary reply chain must still resolve.
  await (a as any).processIncomingEvent(event('om_reenable', '/customer on', { parent_id: 'om_parent' }, 'ou_creator'));
  const reenable = await a.consumeOne(); assert(reenable);
  assert.equal(reenable.address.chatId, topicConversationId({ chatId, rootMessageId: 'om_root' }));
  await manager.handleMessage(a, reenable);
  await _testOnlyWaitForDeliveryQueuesForTests(a);
  assert.deepEqual(chats(), [chatId]);
  assert.equal(sent.at(-1).path.message_id, 'om_root');
  assert.deepEqual(createConfigService({ migrate: false }).snapshot().config.channels.find(c => c.id === 'feishu-unrelated')?.config.customerServiceControlUsers, ['ou_other']);
});

it('customer commands cannot bypass controller checks before enable, after disable, or when already queued', async () => {
  const { a, sent } = setup({ customerServiceChats: [], allowedUsers: [] });
  await (a as any).processIncomingEvent(event('om_denied_on', '/customer on', {}, 'ou_guest'));
  assert.equal((a as any).inboundQueue.length, 0);
  assert.match(sent.at(-1).data.content, /只有控制白名单/);
  await (a as any).processIncomingEvent(event('om_pending_on', '/customer on'));
  const queued = await a.consumeOne(); assert(queued);
  createConfigService({ migrate: false }).set({ kind: 'home' }, { channels: [{ id: address().channelType, config: { customerServiceControlUsers: ['ou_guest'] } }] });
  await manager.handleMessage(a, queued);
  await _testOnlyWaitForDeliveryQueuesForTests(a);
  assert.deepEqual(chats(), []);
  assert.match(sent.at(-1).data.content, /只有控制白名单/);
  assert.match(a.manageCustomerServiceMode(queued, 'on'), /只有客服控制白名单/);
  await (a as any).processIncomingEvent(event('om_private_mode', '/customer on', { chat_type: 'p2p' }, 'ou_guest'));
  const privateMsg = await a.consumeOne(); assert(privateMsg);
  await manager.handleMessage(a, privateMsg);
  await _testOnlyWaitForDeliveryQueuesForTests(a);
  assert.match(sent.at(-1).data.content, /请在/);
  assert.deepEqual(chats(), []);
});

it('customer on and off follow the existing mention requirement without changing it', async () => {
  const { a } = setup({ customerServiceChats: [], allowedUsers: [] });
  const command = { address: address(), text: '/require-at on', messageId: 'require-on', timestamp: Date.now() };
  await manager.handleMessage(a, command);
  await _testOnlyWaitForDeliveryQueuesForTests(a);
  assert.equal(sessionRequiresMention(getBridgeContext().store, address()), true);
  await (a as any).processIncomingEvent(event('om_no_at', '/customer on'));
  assert.equal((a as any).inboundQueue.length, 0);
  await (a as any).processIncomingEvent(event('om_with_at', '@_user_1 /customer on', { mentions: [mention('ou_bot', 1)] }));
  const enable = await a.consumeOne(); assert(enable);
  await manager.handleMessage(a, enable);
  await _testOnlyWaitForDeliveryQueuesForTests(a);
  assert.deepEqual(chats(), [chatId]);
  a.manageCustomerServiceMode(enable, 'off');
  assert.deepEqual(chats(), []);
  assert.equal(sessionRequiresMention(getBridgeContext().store, address()), true);
});

it('defaults an empty whitelist to the verified app creator without legacy authorization or init', () => {
  for (const allowedUsers of [[], [chatId], ['ou_legacy']]) {
    const empty = { allowedUsers, customerServiceControlUsers: [] };
    const list = editCustomerServiceWhitelist({ config: empty, creatorId: 'ou_creator', userId: 'ou_creator', args: '' });
    assert.match(list.text, /默认 bot 创始人/);
    assert.equal(list.users, undefined, 'listing does not materialize a whitelist');
    assert.deepEqual(editCustomerServiceWhitelist({ config: empty, creatorId: 'ou_creator', userId: 'ou_creator', args: 'add ou_guest' }).users, ['ou_creator', 'ou_guest']);
    assert.deepEqual(editCustomerServiceWhitelist({ config: empty, creatorId: 'ou_creator', userId: 'ou_creator', args: 'init' }).users, ['ou_creator']);
    assert.deepEqual(editCustomerServiceWhitelist({ config: empty, creatorId: 'ou_creator', userId: 'ou_creator', args: 'add me' }).users, ['ou_creator']);
    assert.equal(editCustomerServiceWhitelist({ config: empty, creatorId: 'ou_creator', userId: 'ou_legacy', args: 'init' }).users, undefined);
    assert.equal(editCustomerServiceWhitelist({ config: empty, userId: 'ou_creator', args: 'add me' }).users, undefined);
  }
  assert.equal(editCustomerServiceWhitelist({ config, creatorId: 'ou_creator', userId: 'ou_creator', args: 'add me' }).users, undefined, 'nonempty list overrides the creator default');
});

it('supports multiple platform mentions, deduplication, explicit IDs and last-admin protection', () => {
  const added = editCustomerServiceWhitelist({ config, userId: 'ou_admin', args: 'add ou_guest me', mentionedUserIds: ['ou_guest', 'ou_second'] });
  assert.deepEqual(added.users, ['ou_admin', 'ou_guest', 'ou_second']);
  assert.match(added.text, /所有客服群共用/);
  const next = { ...config, customerServiceControlUsers: added.users };
  assert.deepEqual(editCustomerServiceWhitelist({ config: next, userId: 'ou_admin', args: 'remove me', mentionedUserIds: ['ou_second'] }).users, ['ou_guest']);
  assert.match(editCustomerServiceWhitelist({ config, userId: 'ou_admin', args: 'remove me' }).text, /最后一位/);
  for (const args of ['add', 'add @姓名', 'add all', 'add oc_group', 'add ou_bad_id', 'remove me extra']) {
    assert.equal(editCustomerServiceWhitelist({ config, userId: 'ou_admin', args }).users, undefined);
  }
  assert.equal(editCustomerServiceWhitelist({ config, userId: 'ou_admin', args: 'add me' }).users, undefined);
  assert.match(editCustomerServiceWhitelist({ config, userId: 'ou_admin', args: '' }).text, /ou_admin/);
});

it('text and post mentions survive ingress, skip the bot, and persist only the current channel', async () => {
  const { a } = setup();
  const mentions = [mention('ou_bot', 1), mention('ou_guest', 2)];
  await (a as any).processIncomingEvent(event('om_add', '@_user_1 /whitelist add @_user_2', { mentions }));
  const msg = await a.consumeOne(); assert(msg);
  assert.deepEqual(msg.mentionedUserIds, ['ou_guest']);
  assert.equal(msg.address.chatId, chatId);
  await manager.handleMessage(a, msg);
  await _testOnlyWaitForDeliveryQueuesForTests(a);
  assert.deepEqual(users(), ['ou_admin', 'ou_guest']);
  assert.equal(a.isControlAuthorized(address('ou_guest')), true);
  const other = createConfigService({ migrate: false }).snapshot().config.channels.find((c) => c.id === 'feishu-unrelated');
  assert.deepEqual(other?.config.customerServiceControlUsers, ['ou_other']);
  await (a as any).processIncomingEvent(event('om_remove', '', { root_id: 'om_root', parent_id: 'om_parent', mentions,
    message_type: 'post', content: JSON.stringify({ title: '', content: [[{ tag: 'at', user_id: 'ou_bot' },
      { tag: 'text', text: '/service-admin remove ' }, { tag: 'at', user_id: 'ou_guest' }]] }) }));
  const remove = await a.consumeOne(); assert(remove);
  assert.equal(remove.address.chatId, topicConversationId({ chatId, rootMessageId: 'om_root' }));
  await manager.handleMessage(a, remove);
  await _testOnlyWaitForDeliveryQueuesForTests(a);
  assert.deepEqual(users(), ['ou_admin']);
  assert.equal(a.isControlAuthorized(address('ou_guest')), false);
});

it('revokes commands and card callbacks immediately on existing adapters, including queued controls', async () => {
  const { a, sent, instance } = setup();
  a.manageCustomerServiceWhitelist({ address: address(), messageId: 'add', text: '', timestamp: Date.now() }, 'add ou_guest');
  const old = new FeishuAdapter({ ...instance, config: { ...config, customerServiceControlUsers: ['ou_admin', 'ou_guest'] } });
  await (a as any).processIncomingEvent(event('om_queued', '/whitelist add ou_intruder', {}, 'ou_guest'));
  const queued = await a.consumeOne(); assert(queued);
  a.manageCustomerServiceWhitelist({ address: address(), messageId: 'remove', text: '', timestamp: Date.now() }, 'remove ou_guest');
  assert.equal(old.isControlAuthorized(address('ou_guest')), false);
  await manager.handleMessage(a, queued);
  await _testOnlyWaitForDeliveryQueuesForTests(a);
  assert.deepEqual(users(), ['ou_admin']);
  assert.match(sent.at(-1).data.content, /只有控制白名单/);
  const denial = await (a as any).handleCardAction({ operator: { open_id: 'ou_guest' }, context: { open_chat_id: chatId, open_message_id: 'om_card' }, action: { value: { callback_data: 'cmd:/stop' } } });
  assert.equal(denial.toast.type, 'error');
  const direct = a.manageCustomerServiceWhitelist({ address: { ...address('ou_guest'), chatId: 'oc_regular' }, messageId: 'direct', text: '', timestamp: Date.now() }, 'add me');
  assert.match(direct, /只有客服控制白名单/);
});

it('resolves the bot creator automatically through ingress and manager, including controls and cards', async () => {
  const { a } = setup();
  const service = createConfigService({ migrate: false });
  service.set({ kind: 'home' }, { channels: [{ id: address().channelType, config: { customerServiceControlUsers: [], allowedUsers: [] } }] });
  let lookups = 0;
  (a as any).restClient.application.application.get = async (request: any) => {
    lookups++;
    assert.deepEqual(request, { path: { app_id: 'me' }, params: { lang: 'zh_cn', user_id_type: 'open_id' } });
    return { code: 0, data: { app: { app_id: 'cli_self', creator_id: 'ou_creator', owner: { owner_id: 'ou_notCreator' } } } };
  };
  await (a as any).processIncomingEvent(event('om_default', '/whitelist', {}, 'ou_creator'));
  const list = await a.consumeOne(); assert(list);
  await manager.handleMessage(a, list);
  await _testOnlyWaitForDeliveryQueuesForTests(a);
  assert.deepEqual(users(), []);
  assert.equal(a.isControlAuthorized(address('ou_creator'), '/stop'), true);
  assert.equal(a.isControlAuthorized(address('ou_legacy')), false);
  assert.equal(a.isControlAuthorized(address('ou_notCreator')), false);
  await (a as any).processIncomingEvent(event('om_creator_add', '/whitelist add @_user_1', { mentions: [mention('ou_guest', 1)] }, 'ou_creator'));
  const add = await a.consumeOne(); assert(add);
  await manager.handleMessage(a, add);
  await _testOnlyWaitForDeliveryQueuesForTests(a);
  assert.deepEqual(users(), ['ou_creator', 'ou_guest']);
  assert.equal(lookups, 1);
  service.set({ kind: 'home' }, { channels: [{ id: address().channelType, config: { customerServiceControlUsers: ['ou_guest'] } }] });
  assert.equal(a.isControlAuthorized(address('ou_creator')), false);
  service.set({ kind: 'home' }, { channels: [{ id: address().channelType, config: { customerServiceControlUsers: [] } }] });
  assert.equal(a.isControlAuthorized(address('ou_creator')), true);
  const callback = await (a as any).handleCardAction({ operator: { open_id: 'ou_creator' }, context: { open_chat_id: chatId, open_message_id: 'om_card' }, action: { value: { callback_data: 'cmd:/stop' } } });
  assert.notEqual(callback.toast.type, 'error');
  assert.equal(lookups, 1, 'callback uses the prefetched identity without waiting on a network request');
});

it('fails closed on missing or mismatched app identity and coalesces lookup attempts', async () => {
  const { a } = setup();
  createConfigService({ migrate: false }).set({ kind: 'home' }, { channels: [{ id: address().channelType, config: { customerServiceControlUsers: [] } }] });
  let lookups = 0;
  (a as any).restClient.application.application.get = async () => {
    lookups++;
    return { code: 0, data: { app: { app_id: 'cli_other', creator_id: 'ou_legacy' } } };
  };
  await Promise.all([a.prepareControlAuthorization(address()), a.prepareControlAuthorization(address())]);
  assert.equal(lookups, 1);
  assert.equal(a.isControlAuthorized(address('ou_legacy'), '/whitelist init'), false);
  await a.prepareControlAuthorization(address());
  assert.equal(lookups, 1, 'failed identity lookup has a cooldown');
});
