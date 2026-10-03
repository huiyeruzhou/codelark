import '../../setup/test-setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertInherited, assertSameTurnInput, botReplyIds, userReadbackMessages, feishuChatUrl, readAllUserPages, unexpectedRestartCards } from '../../../testing/real-feishu/app-server-lifecycle.js';

const session = { sessionId: 'old', threadId: 'thread-old', endpoint: 'unix:///owned/rpc.sock', streamKeys: [],
  configuration: { provider: 'sdk', networkAccess: false, reasoningEffort: 'low' } };
test('clear/new 证据拒绝旧线程、配置回落和后端丢失', () => {
  const next = { ...session, sessionId: 'new', threadId: 'thread-new' };
  assertInherited(session, next);
  assertInherited(session, { ...next, threadId: undefined });
  assert.throws(() => assertInherited(session, session));
  assert.throws(() => assertInherited(session, { ...next, threadId: session.threadId }));
  assert.throws(() => assertInherited(session, { ...next, endpoint: undefined }));
  assert.throws(() => assertInherited(session, { ...next, configuration: { ...session.configuration, networkAccess: true } }));
});
test('steer 证据必须属于原生原轮次，拒绝排队新轮次和重复输入', () => {
  const active = { id: 'turn-1', status: 'completed', items: [{ type: 'userMessage', content: [{ text: 'steer-marker' }] }] };
  assertSameTurnInput({ id: 'thread', turns: [active] }, active.id, 'steer-marker');
  assert.throws(() => assertSameTurnInput({ id: 'thread', turns: [{ ...active, id: 'turn-2' }] }, active.id, 'steer-marker'));
  assert.throws(() => assertSameTurnInput({ id: 'thread', turns: [active, { ...active, id: 'turn-2' }] }, active.id, 'steer-marker'));
  assert.throws(() => assertSameTurnInput({ id: 'thread', turns: [{ ...active, items: [...active.items, ...active.items] }] }, active.id, 'steer-marker'));
  assert.throws(() => assertSameTurnInput({ id: 'thread', turns: [{ ...active, items: [{ type: 'agentMessage', text: 'steer-marker' }] }] }, active.id, 'steer-marker'));
});
test('飞书证据拒绝失败与 bot 身份回读，忽略用户回显和其他机器人', () => {
  const bot = { message_id: 'om_bot', sender: { sender_type: 'app', id: 'test-app' }, content: 'result-marker' };
  const payload = { ok: true, identity: 'user', data: { messages: [bot,
    { ...bot, message_id: 'om_user', sender: { sender_type: 'user', id: 'user' } },
    { ...bot, message_id: 'om_other', sender: { sender_type: 'app', id: 'other-app' } }] } };
  assert.deepEqual(botReplyIds(payload, 'test-app', 'result-marker'), ['om_bot']);
  assert.throws(() => userReadbackMessages({ ...payload, identity: 'bot' }));
  assert.throws(() => userReadbackMessages({ ...payload, ok: false }));
  assert.throws(() => userReadbackMessages({ ok: true, identity: 'user' }));
  assert.equal(feishuChatUrl('oc_owned'), 'https://applink.feishu.cn/client/chat/open?openChatId=oc_owned');
});
test('扩展故事逐页用户回读，拒绝中途换身份、重复消息和失效游标', async () => {
  const page = (id: string, token = '') => ({ ok: true, identity: 'user', data: { has_more: Boolean(token), page_token: token, messages: [{ message_id: id }] } });
  const result = await readAllUserPages(async (token) => token ? page('older') : page('newer', 'next'));
  assert.deepEqual(userReadbackMessages(result).map((m) => m.message_id), ['newer', 'older']);
  await assert.rejects(readAllUserPages(async (token) => token ? { ...page('older'), identity: 'bot' } : page('newer', 'next')));
  await assert.rejects(readAllUserPages(async (token) => page('same', token ? '' : 'next')));
  await assert.rejects(readAllUserPages(async () => page('same', 'next')));
});
test('重启去重拒绝没有结果标记的空镜像卡，允许本次current命令回复', () => {
  const bot = (message_id: string, reply_to?: string) => ({ message_id, sender: { sender_type: 'app', id: 'app' }, content: '空卡', reply_to });
  const payload = (messages: unknown[]) => ({ ok: true, identity: 'user', data: { messages } });
  const before = payload([bot('old')]);
  assert.deepEqual(unexpectedRestartCards(before, payload([bot('old'), bot('command-response', 'current')]), 'app', 'current'), []);
  assert.deepEqual(unexpectedRestartCards(before, payload([bot('old'), bot('ghost')]), 'app', 'current').map((m) => m.message_id), ['ghost']);
  assert.deepEqual(unexpectedRestartCards(before, payload([bot('ghost')]), 'app').map((m) => m.message_id), ['ghost']);
});
