import '../../setup/test-setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertInherited, assertSameTurnInput, botReplyIds, userReadbackMessages, feishuChatUrl } from '../../../testing/real-feishu/app-server-lifecycle.js';

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
