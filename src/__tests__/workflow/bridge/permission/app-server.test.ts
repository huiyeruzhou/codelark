import '../../../setup/test-setup.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { observeAppServerRequests, handleAppServerRequestCallback, answerAppServerQuestion, closeAppServerRequestObservers, releaseAppServerRequestObserver } from '../../../../bridge/permission/app-server.js';
import type { CodexAppServerSession } from '../../../../runtime/codex/app-server-registry.js';
import type { AppServerPendingRequest } from '../../../../runtime/codex/app-server-lifecycle.js';
import { _testOnlyWaitForDeliveryQueuesForTests } from '../../../../channels/delivery/deliver.js';
import { initBridgeTestContext, RecordingAdapter } from '../../../helpers/bridge/test-bridge-utils.js';

afterEach(closeAppServerRequestObservers);

function setup(method: string, params: Record<string, unknown>, item?: Record<string, unknown>) {
  const store = initBridgeTestContext();
  const adapter = new RecordingAdapter();
  const address = { channelType: 'feishu', chatId: 'protocol-approval-chat' };
  let requests: AppServerPendingRequest[] = [{ key: 'generation-1:1', id: 1, threadId: 'thread-1', turnId: 'turn-1', method, params }];
  const listeners = new Set<(id: string) => void>();
  const replies: unknown[] = [];
  const handle = { threadId: 'thread-1', endpoint: 'ws://127.0.0.1:12345', direct: false, directTurnIds: new Set(), lifecycle: {
    snapshot: () => ({ requests }),
    item: (thread: string, turn: string, id: string) => { assert.equal(thread, 'thread-1'); assert.equal(turn, 'turn-1'); assert.equal(id, 'item-1'); return item; },
    onChange: (cb: (id: string) => void) => { listeners.add(cb); return () => listeners.delete(cb); },
    onRequest: () => () => {},
    reply: (key: string, result: unknown) => { replies.push({ key, result }); requests = []; listeners.forEach((cb) => cb('thread-1')); return true; },
  } } as unknown as CodexAppServerSession;
  const change = (next: AppServerPendingRequest[]) => { requests = next; listeners.forEach((cb) => cb('thread-1')); };
  observeAppServerRequests('session-1', handle, adapter, address, store);
  const click = (callbackData: string) => handleAppServerRequestCallback({ address, callbackData, messageId: 'inbound', text: '', timestamp: Date.now() }, store);
  const actions = () => adapter.sent.at(-1)?.richCard?.sections.flatMap((section) => section.actions?.flat() || []) || [];
  return { store, adapter, address, handle, replies, change, click, actions, listeners };
}

it('finds requests that preceded observer registration, renders decision context and submits only once', async () => {
  const s = setup('item/commandExecution/requestApproval', { command: 'npm test', cwd: '/workspace/project', reason: '验证修改', internalSecret: 'omit-this' });
  await _testOnlyWaitForDeliveryQueuesForTests(s.adapter);
  assert.equal(s.adapter.sent.length, 1);
  const card = JSON.stringify(s.adapter.sent[0]?.richCard);
  assert.match(card, /npm test/); assert.match(card, /workspace\/project/); assert.match(card, /验证修改/);
  assert.doesNotMatch(card, /requestApproval|omit-this/);
  observeAppServerRequests('session-1', s.handle, s.adapter, s.address, s.store);
  assert.equal(s.adapter.sent.length, 1);
  const action = s.actions().find((a) => a.text === '允许')!.callbackData!;
  assert.match(s.click(action)!, /已提交/);
  s.click(action);
  assert.deepEqual(s.replies, [{ key: 'generation-1:1', result: { decision: 'accept' } }]);
});

it('invalidates stale connection-generation callbacks and releases detached subscriptions', async () => {
  const s = setup('item/fileChange/requestApproval', { reason: '更新实现', changes: { 'src/test.ts': { diff: '+fixed' } } });
  await _testOnlyWaitForDeliveryQueuesForTests(s.adapter);
  const old = s.actions()[0]!.callbackData!;
  assert.match(JSON.stringify(s.adapter.sent[0]?.richCard), /src\/test.ts/);
  s.change([{ key: 'generation-2:1', id: 1, threadId: 'thread-1', method: 'item/fileChange/requestApproval', params: {} }]);
  await _testOnlyWaitForDeliveryQueuesForTests(s.adapter);
  assert.match(s.click(old)!, /已处理或连接已更新/);
  releaseAppServerRequestObserver('session-1');
  assert.equal(s.listeners.size, 0);
  assert.match(s.click(s.actions()[0]!.callbackData!)!, /已处理或连接已更新/);
  assert.equal(s.replies.length, 0);
});

it('preserves all user-input questions and options instead of allowing or denying them', async () => {
  const s = setup('item/tool/requestUserInput', { questions: [
    { id: 'target', question: '选择目标', options: [{ label: '测试', description: '隔离环境' }, { label: '线上', description: '真实环境' }] },
    { id: 'detail', question: '补充要求', options: [] },
  ] });
  await _testOnlyWaitForDeliveryQueuesForTests(s.adapter);
  assert.deepEqual(s.actions().map((a) => a.text), ['测试', '线上']);
  assert.match(s.click(s.actions()[0]!.callbackData!)!, /继续回答/);
  assert.equal(s.replies.length, 0);
  assert.match(answerAppServerQuestion({ address: s.address, text: '只检查', messageId: 'answer', timestamp: Date.now() }, 'session-1', s.store)!, /已提交/);
  assert.deepEqual(s.replies, [{ key: 'generation-1:1', result: { answers: { target: { answers: ['测试'] }, detail: { answers: ['只检查'] } } } }]);
});

it('leaves unknown future requests to Desktop without generic allow buttons', async () => {
  const s = setup('future/request', { arbitrary: 'not product copy' });
  await _testOnlyWaitForDeliveryQueuesForTests(s.adapter);
  assert.equal(s.actions().length, 0);
  assert.match(JSON.stringify(s.adapter.sent[0]?.richCard), /Desktop/);
  assert.doesNotMatch(JSON.stringify(s.adapter.sent[0]?.richCard), /not product copy/);
  assert.equal(s.replies.length, 0);
});

it('uses the fileChange item associated with a native approval request to show the diff', async () => {
  const s = setup('item/fileChange/requestApproval', { itemId: 'item-1' }, {
    type: 'fileChange', changes: [{ path: '/work/fix.ts', kind: { type: 'update' }, diff: '-old\n+fixed' }],
  });
  await _testOnlyWaitForDeliveryQueuesForTests(s.adapter);
  assert.match(JSON.stringify(s.adapter.sent[0]?.richCard), /fix.ts/);
  assert.match(JSON.stringify(s.adapter.sent[0]?.richCard), /-old\\n\+fixed/);
});

it('grants only the displayed permissions for the current turn and permits explicit refusal', async () => {
  const permissions = { network: { enabled: true }, fileSystem: {
    read: ['/project/input'], write: ['/project/output'],
    entries: [{ path: { type: 'special', value: { kind: 'project_roots', subpath: 'output' } }, access: 'write' }],
  } };
  const s = setup('item/permissions/requestApproval', { permissions, reason: '写入产物' });
  await _testOnlyWaitForDeliveryQueuesForTests(s.adapter);
  assert.match(JSON.stringify(s.adapter.sent[0]?.richCard), /允许写入.*project\/output/);
  assert.match(JSON.stringify(s.adapter.sent[0]?.richCard), /项目目录\/output/);
  assert.deepEqual(s.actions().map((a) => a.text), ['仅本轮允许', '拒绝']);
  s.click(s.actions()[0]!.callbackData);
  assert.deepEqual(s.replies, [{ key: 'generation-1:1', result: { permissions, scope: 'turn' } }]);
  closeAppServerRequestObservers();
  const denied = setup('item/permissions/requestApproval', { permissions });
  await _testOnlyWaitForDeliveryQueuesForTests(denied.adapter);
  denied.click(denied.actions()[1]!.callbackData);
  assert.deepEqual(denied.replies, [{ key: 'generation-1:1', result: { permissions: {}, scope: 'turn' } }]);
});

it('rejects forged decisions that the server did not offer and does not approve unknown permission fields', async () => {
  const s = setup('item/commandExecution/requestApproval', { command: 'echo example', availableDecisions: ['cancel'] });
  await _testOnlyWaitForDeliveryQueuesForTests(s.adapter);
  assert.deepEqual(s.actions().map((a) => a.text), ['取消']);
  assert.match(s.click(s.actions()[0]!.callbackData.replace(':cancel', ':accept'))!, /无效/);
  assert.equal(s.replies.length, 0);
  s.click(s.actions()[0]!.callbackData);
  assert.deepEqual(s.replies, [{ key: 'generation-1:1', result: { decision: 'cancel' } }]);
  closeAppServerRequestObservers();
  const unsupported = setup('item/permissions/requestApproval', { permissions: { futureScope: true } });
  await _testOnlyWaitForDeliveryQueuesForTests(unsupported.adapter);
  assert.deepEqual(unsupported.actions().map((a) => a.text), ['拒绝']);
});

it('validates MCP form answers, preserves boolean/number types, and supports skipping optional fields', async () => {
  const s = setup('mcpServer/elicitation/request', { mode: 'form', serverName: 'test-service', message: '选择操作参数', requestedSchema: {
    type: 'object', required: ['count', 'enabled'], properties: {
      count: { type: 'integer', title: '数量', minimum: 1, maximum: 3 }, enabled: { type: 'boolean', title: '启用' },
      note: { type: 'string', title: '备注' },
    },
  } });
  await _testOnlyWaitForDeliveryQueuesForTests(s.adapter);
  const answer = (text: string) => answerAppServerQuestion({ address: s.address, text, messageId: 'answer', timestamp: Date.now() }, 'session-1', s.store);
  assert.match(answer('99')!, /不符合/);
  assert.match(answer('2')!, /继续回答/);
  s.click(s.actions().find((a) => a.text === '否')!.callbackData);
  s.click(s.actions().find((a) => a.text === '不填写')!.callbackData);
  assert.deepEqual(s.replies, [{ key: 'generation-1:1', result: { action: 'accept', content: { count: 2, enabled: false }, _meta: null } }]);
});

it('presents an MCP URL as a user-operated link and supports completion or cancellation without visiting it', async () => {
  const s = setup('mcpServer/elicitation/request', { mode: 'url', serverName: 'example', message: '请登录', url: 'https://example.org/authorize' });
  await _testOnlyWaitForDeliveryQueuesForTests(s.adapter);
  assert.match(JSON.stringify(s.adapter.sent[0]?.richCard), /https:\/\/example.org\/authorize/);
  assert.equal(s.replies.length, 0);
  s.click(s.actions().find((a) => a.text === '已完成')!.callbackData);
  assert.deepEqual(s.replies, [{ key: 'generation-1:1', result: { action: 'accept', content: null, _meta: null } }]);
});
