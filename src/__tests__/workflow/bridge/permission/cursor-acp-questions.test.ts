import '../../../setup/test-setup.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { InboundMessage, OutboundMessage, PermissionResolution, SendResult } from '../../../../domain/index.js';
import { createConfigService } from '../../../../configuration/service.js';
import { PendingPermissions } from '../../../../runtime/permission-gateway.js';
import { setSessionCursorIdentityUpdate } from '../../../../domain/session-runtime.js';
import { forwardPermissionRequest } from '../../../../bridge/permission/broker.js';
import { answerCursorAcpQuestion, clearCursorAcpQuestions, forwardCursorAcpQuestion, handleCursorAcpQuestionCallback, hasCursorAcpQuestion } from '../../../../bridge/permission/cursor-acp-questions.js';
import { _testOnlyWaitForDeliveryQueuesForTests } from '../../../../channels/delivery/deliver.js';
import { initBridgeTestContext, RecordingAdapter, inboundMessage, resetBridgeTestState } from '../../../helpers/bridge/test-bridge-utils.js';

const question = (id: string, allowMultiple = false) => ({
  id, prompt: `选择 ${id}`, allowMultiple, options: [{ id: 'low', label: '低温' }, { id: 'high', label: '高温' }],
});
const registries: PendingPermissions[] = [];
function fixture() {
  const registry = new PendingPermissions(); registries.push(registry);
  const resolutions: Array<{ id: string; value: PermissionResolution }> = [];
  const permissions = {
    hasPendingPermission: (id: string) => registry.has(id),
    resolvePendingPermission: (id: string, value: PermissionResolution) => {
      resolutions.push({ id, value }); return registry.resolve(id, value);
    },
  };
  const store = initBridgeTestContext({ permissions });
  const session = store.createSession('ACP questions', 'fake', undefined, '/tmp', undefined, { activeRuntime: 'cursor' });
  store.updateSession(session.id, setSessionCursorIdentityUpdate('native-acp', '/tmp', 'acp'));
  createConfigService({ migrate: false }).set({ kind: 'session', sessionId: session.id }, { runtime: { cursor: { provider: 'acp' } } });
  const address = { channelType: 'feishu', chatId: 'question-group' };
  const binding = store.upsertChannelChat({ ...address, bridgeSessionId: session.id });
  const adapter = new RecordingAdapter();
  const start = async (questions = [question('q1')], id = 'cursor-acp:permission', replyToMessageId = 'thread-parent') => {
    const result = registry.waitFor(id);
    await forwardCursorAcpQuestion(adapter, address, id, { title: '实验问卷', toolCallId: 'call-question', questions }, session.id, store, permissions, replyToMessageId);
    return { result, id };
  };
  const text = (value: string) => answerCursorAcpQuestion(inboundMessage(address, value), session.id, store);
  const callback = (card = 0, choice = 0, overrides: Partial<InboundMessage> = {}) => handleCursorAcpQuestionCallback({
    ...inboundMessage(address, '', `callback-${card}`), callbackMessageId: `reply-${card + 1}`,
    callbackData: adapter.sent[card]!.richCard!.actions!.flat()[choice]!.callbackData, ...overrides,
  });
  return { store, registry, resolutions, permissions, session, binding, address, adapter, start, text, callback };
}

beforeEach(() => { clearCursorAcpQuestions(); resetBridgeTestState(); });
afterEach(() => { clearCursorAcpQuestions(); for (const registry of registries.splice(0)) registry.denyAll(); });

describe('Cursor ACP question lifecycle', () => {
  it('delivers every question under the original reply and submits complete option/free-text JSON exactly once', async () => {
    const f = fixture();
    const p = await f.start([question('temperature'), question('comment')]);
    assert.equal(hasCursorAcpQuestion(f.session.id), true);
    assert.match(await f.callback(0, 1) || '', /已记录此题/);
    assert.match(await f.callback(0, 0) || '', /已失效/, 'an earlier question card must not answer the next question');
    const freeform = '  {"tag":"中文 \\" 引号"}\n第二行，保留完整文本  ';
    assert.match(await f.text(freeform) || '', /自由文本将作为新消息/);
    const result = await p.result;
    assert.equal(result.behavior, 'allow');
    assert.deepEqual(JSON.parse(result.message!), { answers: [
      { questionId: 'temperature', selectedOptionIds: ['high'] },
      { questionId: 'comment', selectedOptionIds: [], freeformText: freeform },
    ] });
    assert.equal(f.resolutions.filter(item => item.value.behavior === 'allow').length, 1);
    assert.equal(f.adapter.sent.length, 2);
    for (const card of f.adapter.sent) assert.equal(card.replyToMessageId, 'thread-parent');
    assert.equal(f.store.getSession(f.session.id)?.pending_user_input, undefined);
    assert.equal(f.store.getPermissionLink(p.id)?.resolved, true);
    assert.equal(hasCursorAcpQuestion(f.session.id), false);
    assert.equal(await f.text('新的请求'), undefined);
  });

  it('accepts multiple choices as IDs, labels or numbers and deduplicates selections', async () => {
    const f = fixture(); const p = await f.start([question('multi', true)]);
    assert.deepEqual(f.adapter.sent[0]?.richCard?.actions, []);
    await f.text('1， 高温,low');
    assert.deepEqual(JSON.parse((await p.result).message!), { answers: [{ questionId: 'multi', selectedOptionIds: ['low', 'high'] }] });
  });

  it('routes the broker AskQuestion branch to a question card with the source thread', async () => {
    const f = fixture(); const id = 'cursor-acp:broker-question'; const result = f.registry.waitFor(id);
    forwardPermissionRequest(f.adapter, f.address, id, 'Cursor AskQuestion', { questions: [question('broker')] }, f.session.id, undefined, 'broker-thread');
    await _testOnlyWaitForDeliveryQueuesForTests(f.adapter);
    assert.equal(f.adapter.sent[0]?.richCard?.title, 'Cursor 等待你的回答');
    assert.equal(f.adapter.sent[0]?.replyToMessageId, 'broker-thread');
    await f.callback();
    assert.equal((await result).behavior, 'allow');
  });

  it('rejects cross-group, cross-channel, wrong-message and malformed callbacks without resolving the real request', async () => {
    const f = fixture(); const p = await f.start();
    for (const overrides of [
      { address: { ...f.address, chatId: 'other-group' } },
      { address: { ...f.address, channelType: 'another-bot' } },
      { callbackMessageId: 'old-message' },
      { callbackData: f.adapter.sent[0]!.richCard!.actions!.flat()[0]!.callbackData + ':extra' },
    ]) assert.match(await f.callback(0, 0, overrides) || '', /失效/);
    assert.equal(f.registry.has(p.id), true); assert.equal(f.resolutions.length, 0);
    await f.callback(); assert.equal((await p.result).behavior, 'allow');
  });

  for (const change of ['binding', 'native session', 'provider'] as const) {
    it(`invalidates an old question after ${change} changes`, async () => {
      const f = fixture(); const p = await f.start();
      if (change === 'binding') {
        const other = f.store.createSession('other', '', undefined, '/tmp');
        f.store.upsertChannelChat({ ...f.address, bridgeSessionId: other.id });
      } else if (change === 'native session') {
        f.store.updateSession(f.session.id, setSessionCursorIdentityUpdate('replacement-native', '/tmp', 'acp'));
      } else {
        createConfigService({ migrate: false }).set({ kind: 'session', sessionId: f.session.id }, { runtime: { cursor: { provider: 'tmux' } } });
      }
      assert.match(await f.callback() || '', /失效/);
      assert.equal((await p.result).behavior, 'deny');
      assert.equal(f.store.getSession(f.session.id)?.pending_user_input, undefined);
      assert.equal(hasCursorAcpQuestion(f.session.id), false);
      assert.ok(f.resolutions.every(item => item.value.behavior === 'deny'));
    });
  }

  it('clears a truly timed-out permission before the next chat message can be swallowed as an answer', async () => {
    const f = fixture(); (f.registry as unknown as { timeoutMs: number }).timeoutMs = 40;
    const p = await f.start([question('first'), question('second')]);
    assert.match((await p.result).message || '', /timed out/);
    assert.equal(await f.text('这是新的任务，请继续'), undefined);
    assert.equal(hasCursorAcpQuestion(f.session.id), false);
    assert.equal(f.store.getSession(f.session.id)?.pending_user_input, undefined);
    assert.equal(f.adapter.sent.length, 1, 'timeout must not issue another question card');
    assert.match(await f.callback() || '', /失效/);
  });

  it('lets the has check alone clear an expired pending flag used by the input router', async () => {
    const f = fixture(); const p = await f.start();
    f.registry.resolve(p.id, { behavior: 'deny', message: 'native cancelled' }); await p.result;
    assert.ok(f.store.getSession(f.session.id)?.pending_user_input);
    assert.equal(hasCursorAcpQuestion(f.session.id), false);
    assert.equal(f.store.getSession(f.session.id)?.pending_user_input, undefined);
  });

  for (const at of [1, 2]) {
    it(`cleans only its own pending request when delivery of question ${at} fails`, async () => {
      const f = fixture(); let sends = 0;
      f.adapter.send = async (message: OutboundMessage): Promise<SendResult> => {
        sends++;
        if (sends === at) return { ok: false, httpStatus: 403, error: 'test forbidden' };
        f.adapter.sent.push(message); return { ok: true, messageId: `reply-${sends}` };
      };
      const id = 'cursor-acp:failed'; const result = f.registry.waitFor(id);
      const delivery = forwardCursorAcpQuestion(f.adapter, f.address, id, { questions: [question('first'), question('second')] }, f.session.id, f.store, f.permissions);
      if (at === 1) await assert.rejects(delivery, /发送失败/);
      else { await delivery; assert.match(await f.text('1') || '', /发送失败/); }
      assert.equal((await result).behavior, 'deny');
      assert.equal(hasCursorAcpQuestion(f.session.id), false);
      assert.equal(f.store.getSession(f.session.id)?.pending_user_input, undefined);
      assert.equal(await f.text('下一条任务'), undefined);
    });
  }

  it('holds input during card delivery and makes a late delivered card inert after cancellation', async () => {
    const f = fixture(); let finish!: (value: SendResult) => void;
    f.adapter.send = async message => { f.adapter.sent.push(message); return new Promise(resolve => { finish = resolve; }); };
    const id = 'cursor-acp:late-delivery'; const result = f.registry.waitFor(id);
    const delivery = forwardCursorAcpQuestion(f.adapter, f.address, id, { questions: [question('first'), question('second')] }, f.session.id, f.store, f.permissions);
    assert.match(await f.text('1') || '', /正在提交/);
    clearCursorAcpQuestions(f.store, f.session.id);
    assert.equal((await result).behavior, 'deny');
    finish({ ok: true, messageId: 'reply-1' }); await delivery;
    assert.equal(f.adapter.sent.length, 1);
    assert.equal(f.store.getPermissionLink(id)?.resolved, true);
    assert.equal(f.store.getSession(f.session.id)?.pending_user_input, undefined);
    assert.match(await f.callback() || '', /失效/);
  });

  it('rejects an expired old card without clearing the replacement question flag', async () => {
    const f = fixture(); const old = await f.start([question('old')], 'cursor-acp:old');
    f.registry.resolve(old.id, { behavior: 'deny' }); await old.result;
    const current = await f.start([question('new')], 'cursor-acp:new');
    assert.match(await f.callback(0) || '', /失效/);
    assert.equal(hasCursorAcpQuestion(f.session.id), true);
    assert.ok(f.store.getSession(f.session.id)?.pending_user_input);
    await f.callback(1);
    assert.equal((await current.result).behavior, 'allow');
  });

  it('keeps compatibility with a gateway that only implements resolution', async () => {
    const f = fixture(); const id = 'cursor-acp:legacy-gateway'; const result = f.registry.waitFor(id);
    await forwardCursorAcpQuestion(f.adapter, f.address, id, { questions: [question('compat')] }, f.session.id, f.store,
      { resolvePendingPermission: f.permissions.resolvePendingPermission });
    assert.equal(hasCursorAcpQuestion(f.session.id), true);
    await f.callback(); assert.equal((await result).behavior, 'allow');
  });

  it('keeps other sessions pending when clearing one and tolerates null options without throwing', async () => {
    const f = fixture(); const first = await f.start();
    const other = f.store.createSession('other ACP', '', undefined, '/tmp', undefined, { activeRuntime: 'cursor' });
    createConfigService({ migrate: false }).set({ kind: 'session', sessionId: other.id }, { runtime: { cursor: { provider: 'acp' } } });
    const address = { ...f.address, chatId: 'another-group' }; f.store.upsertChannelChat({ ...address, bridgeSessionId: other.id });
    const id = 'cursor-acp:other-question'; const otherResult = f.registry.waitFor(id);
    await forwardCursorAcpQuestion(f.adapter, address, id, { questions: [question('other')] }, other.id, f.store, f.permissions);
    clearCursorAcpQuestions(f.store, f.session.id);
    assert.equal((await first.result).behavior, 'deny'); assert.equal(hasCursorAcpQuestion(other.id), true);
    const invalidId = 'cursor-acp:invalid'; const invalid = f.registry.waitFor(invalidId);
    await forwardCursorAcpQuestion(f.adapter, address, invalidId, { questions: [{ id: 'bad', prompt: 'bad', options: [null] }] }, other.id, f.store, f.permissions);
    assert.equal((await invalid).behavior, 'deny'); assert.equal(hasCursorAcpQuestion(other.id), true);
    clearCursorAcpQuestions(); assert.equal((await otherResult).behavior, 'deny');
  });
});
