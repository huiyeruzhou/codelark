import '../../../setup/test-setup.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { observeAppServerRequests, handleAppServerRequestCallback, answerAppServerQuestion, closeAppServerRequestObservers, releaseAppServerRequestObserver } from '../../../../bridge/permission/app-server.js';
import type { CodexAppServerSession } from '../../../../runtime/codex/app-server-registry.js';
import type { AppServerPendingRequest } from '../../../../runtime/codex/app-server-lifecycle.js';
import { _testOnlyWaitForDeliveryQueuesForTests } from '../../../../channels/delivery/deliver.js';
import { initBridgeTestContext, RecordingAdapter } from '../../../helpers/bridge/test-bridge-utils.js';

afterEach(closeAppServerRequestObservers);

function setup(method: string, params: Record<string, unknown>) {
  const store = initBridgeTestContext();
  const adapter = new RecordingAdapter();
  const address = { channelType: 'feishu', chatId: 'protocol-approval-chat' };
  let requests: AppServerPendingRequest[] = [{ key: 'generation-1:1', id: 1, threadId: 'thread-1', method, params }];
  const listeners = new Set<(id: string) => void>();
  const replies: unknown[] = [];
  const handle = { threadId: 'thread-1', endpoint: 'ws://127.0.0.1:12345', direct: false, directTurnIds: new Set(), lifecycle: {
    snapshot: () => ({ requests }),
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

it('leaves unknown and broader permission requests to Desktop without generic allow buttons', async () => {
  const s = setup('item/permissions/requestApproval', { arbitrary: 'not product copy' });
  await _testOnlyWaitForDeliveryQueuesForTests(s.adapter);
  assert.equal(s.actions().length, 0);
  assert.match(JSON.stringify(s.adapter.sent[0]?.richCard), /Desktop/);
  assert.doesNotMatch(JSON.stringify(s.adapter.sent[0]?.richCard), /not product copy/);
  assert.equal(s.replies.length, 0);
});
