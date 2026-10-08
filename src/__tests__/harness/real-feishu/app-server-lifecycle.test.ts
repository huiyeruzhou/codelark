import '../../setup/test-setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { assertInherited, assertSameTurnInput, botReplyIds, userReadbackMessages, feishuChatUrl, readAllUserPages, unexpectedRestartCards, runActiveClear, assertNoOldClearDelivery, assertBackendStatusReadback,
  type BackendStatusExpectation, type LifecycleReport, type NativeThread } from '../../../testing/real-feishu/app-server-lifecycle.js';

const session = { sessionId: 'old', threadId: 'thread-old', endpoint: 'unix:///owned/rpc.sock', streamKeys: [],
  configuration: { provider: 'sdk', networkAccess: false, reasoningEffort: 'low' } };

test('SDK1–3真实回读样本覆盖全部已出现状态格式，压缩旧卡及错误回复仍拒绝', () => {
  const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/backend-status-readbacks.json', import.meta.url), 'utf8')) as {
    samples: Array<{ sourceRun: string; command: string; phase: string; expected: BackendStatusExpectation; reject: boolean;
      response: { message_id: string; reply_to: string; sender: { sender_type: string; id: string }; msg_type: string; content: string } }>;
  };
  assert.deepEqual([...new Set(fixture.samples.map((s) => s.command))].sort(),
    ['/', '/current-runtime codex', '/current-runtime common', '/current-runtime kimi', '/p', '/status']);
  for (const sample of fixture.samples) {
    const { response, expected } = sample;
    const payload = (messages = [response]) => ({ ok: true, identity: 'user', data: { messages } });
    const card = sample.command === '/' || sample.command.startsWith('/current-runtime');
    const check = (messages = [response]) => assertBackendStatusReadback(payload(messages), 'test-app', response.reply_to, expected, card);
    if (sample.reject) { assert.throws(() => check(), /协议活动状态展示错误/); continue; }
    assert.equal(check()?.message_id, response.message_id, `${sample.sourceRun} ${sample.phase} ${sample.command}`);
    assert.equal(check([{ ...response, reply_to: 'old-command' }]), undefined);
    assert.equal(check([{ ...response, sender: { sender_type: 'user', id: 'test-app' } }]), undefined);
    assert.equal(check([{ ...response, sender: { sender_type: 'app', id: 'other-app' } }]), undefined);
    assert.equal(check([{ ...response, content: '' }]), undefined);
    assert.throws(() => check([response, { ...response, message_id: 'duplicate' }]), /重复状态回复/);
    assert.throws(() => check([{ ...response, content: response.content.replace('未记录终端', '未记录终端错误') }]), /终端用途/);
  }
});

test('状态验收只接受本命令的真实用户回读卡，后端/连接/活动/终端分别校验', () => {
  const content = '<card title="Codex owned">\ncodex_thread_id: thread-current\n**当前后端**\napp-server\n**连接状态**\n已连接\n**执行状态**\n运行中\n**终端用途**\n未记录终端\n</card>';
  const card = { message_id: 'status-card', sender: { sender_type: 'app', id: 'app' }, reply_to: 'status-command', msg_type: 'interactive', content };
  const payload = (messages = [card]) => ({ ok: true, identity: 'user', data: { messages } });
  const expected = { backend: 'app-server', activity: 'active', terminal: 'none', threadId: 'thread-current' } as const;
  assert.equal(assertBackendStatusReadback(payload(), 'app', 'status-command', expected, true)?.message_id, 'status-card');
  for (const invalid of [
    { ...card, reply_to: 'old-command' }, { ...card, sender: { sender_type: 'user', id: 'app' } },
    { ...card, sender: { sender_type: 'app', id: 'another-app' } }, { ...card, msg_type: 'post' }, { ...card, content: '' },
  ]) assert.equal(assertBackendStatusReadback(payload([invalid]), 'app', 'status-command', expected, true), undefined);
  for (const [from, to] of [['app-server', 'tmux'], ['已连接', '连接未确认'], ['运行中', '空闲'],
    ['未记录终端', 'tmux 查看入口'], ['Codex owned', 'Kimi owned'], ['thread-current', 'old-thread']]) {
    assert.throws(() => assertBackendStatusReadback(payload([{ ...card, content: content.replace(from!, to!) }]), 'app', 'status-command', expected, true));
  }
  assert.throws(() => assertBackendStatusReadback({ ...payload(), identity: 'bot' }, 'app', 'status-command', expected, true));
  assert.throws(() => assertBackendStatusReadback(payload([card, { ...card, message_id: 'duplicate' }]), 'app', 'status-command', expected, true));
});

test('未启动状态不冒充连接；Markdown状态详情支持运行/等待/空闲和独立tmux用途', () => {
  const reply = (content: string) => ({ ok: true, identity: 'user', data: { messages: [{
    message_id: 'reply', reply_to: 'command', sender: { sender_type: 'app', id: 'app' }, msg_type: 'post', content,
  }] } });
  const unstarted = '- **当前后端**：尚未建立\n- **终端用途**：未记录终端';
  assert(assertBackendStatusReadback(reply(unstarted), 'app', 'command', { backend: 'unstarted' }));
  assert.throws(() => assertBackendStatusReadback(reply(`${unstarted}\n- **连接状态**：已连接`), 'app', 'command', { backend: 'unstarted' }));
  assert.throws(() => assertBackendStatusReadback(reply(`${unstarted}\n- **执行状态**：活动未确认`), 'app', 'command', { backend: 'unstarted' }));
  for (const [activity, label] of [['active', '运行中'], ['waiting', '等待答复'], ['idle', '空闲']] as const) {
    const text = `- **当前后端**：app-server\n- **连接状态**：已连接\n- **执行状态**：${label}\n- **终端用途**：tmux 查看入口`;
    assert(assertBackendStatusReadback(reply(text), 'app', 'command', { backend: 'app-server', activity, terminal: 'view' }));
  }
});
test('真实 /p post 回读移除加粗后仍逐字段验收，不接受说明文字或冒充配置卡', () => {
  // status-sdk-1 的真实 CLI 用户回读；post 与 interactive 的格式不同。
  const content = '当前 Codex Provider\n- 模式：normal\n- Provider 配置：sdk (全局默认)\n- 当前后端：尚未建立\n- 终端用途：未记录终端\n说明\n- 会话尚未启动，Provider 配置不代表后端已连接。';
  const reply = (text: string) => ({ ok: true, identity: 'user', data: { messages: [{
    message_id: 'reply', reply_to: 'command', sender: { sender_type: 'app', id: 'app' }, msg_type: 'post', content: text,
  }] } });
  assert(assertBackendStatusReadback(reply(content), 'app', 'command', { backend: 'unstarted', terminal: 'none' }));
  assert.equal(assertBackendStatusReadback(reply(content), 'app', 'command', { backend: 'unstarted' }, true), undefined);
  assert.equal(assertBackendStatusReadback(reply('说明当前后端：尚未建立'), 'app', 'command', { backend: 'unstarted' }), undefined);
  assert.throws(() => assertBackendStatusReadback(reply(`${content}\n- 连接状态：已连接`), 'app', 'command', { backend: 'unstarted' }));
  for (const [activity, label] of [['active', '运行中'], ['waiting', '等待答复'], ['idle', '空闲']] as const) {
    const text = `当前 Codex Provider\n- 当前后端：app-server\n- 连接状态：已连接\n- 执行状态：${label}\n- 终端用途：tmux 查看入口`;
    assert(assertBackendStatusReadback(reply(text), 'app', 'command', { backend: 'app-server', activity, terminal: 'view' }));
    assert.throws(() => assertBackendStatusReadback(reply(text.replace('已连接', '连接未确认')), 'app', 'command', { backend: 'app-server', activity }));
  }
});
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

// 只验证 harness 编排与证据判定；这些内存替身不计为真实飞书或原生后端验收。
function activeClearFixture(fault?: 'old-card' | 'early-rebind' | 'early-stop' | 'no-confirmation' | 'old-response'
  | 'configuration-loss' | 'same-thread' | 'old-input' | 'late-result' | 'empty-card', provider = 'sdk') {
  type Context = Parameters<typeof runActiveClear>[0];
  const messages: Array<Record<string, any>> = [];
  const actions: string[] = [];
  const oldInput = 'LIFECYCLE_ACTIVE_CLEAR_INPUT_owned';
  let current = { ...session };
  let released = false;
  let newInputCompleted = false;
  let modelOutput = '';
  const oldThread: NativeThread = { id: session.threadId, turns: [{ id: 'active', status: 'inProgress', items: [] }] };
  const newThread: NativeThread = { id: 'thread-new', turns: [] };
  const report: LifecycleReport = {
    scenario: 'app-server-lifecycle', runId: 'owned', provider, checks: [], automaticPassed: false, acceptanceComplete: false,
    stage: 'active-clear', approval: { status: 'not-run', chatUrl: '', detail: '' }, chats: ['chat'], inputs: [], readbacks: {},
    sessions: {}, protocol: [], threads: {}, modelRequests: [],
  };
  const bot = (reply_to: string | undefined, content: string, msg_type = 'interactive') => {
    messages.push({ message_id: `bot-${messages.length}`, sender: { sender_type: 'app', id: 'app' }, reply_to, content, msg_type });
  };
  const recordInput = (text: string) => {
    const messageId = `user-${report.inputs.length}`;
    report.inputs.push({ chatId: 'chat', text, messageId });
    messages.push({ message_id: messageId, sender: { sender_type: 'user', id: 'user' }, content: text });
    return messageId;
  };
  const c: Context = {
    driver: {
      runId: 'owned', chatId: 'chat', botAppId: 'app', state: () => structuredClone(current),
      model: {
        requests: report.modelRequests, unexpected: [],
        enqueue(output, hold) {
          assert.equal(hold, true); assert.equal(typeof output, 'object');
          assert('text' in output); modelOutput = output.text;
          return { release() { released = true; actions.push('release'); } };
        },
      },
    },
    report, before: session,
    async wait(label, read) {
      const value = await read();
      if (value === undefined || value === false) throw new Error(`等待超时：${label}`);
      return value;
    },
    async read() { return { ok: true, identity: 'user', data: { messages: structuredClone(messages) } }; },
    async send(_chat, text) {
      actions.push(text);
      const id = recordInput(text);
      if (text === oldInput) {
        report.modelRequests.push({ method: 'POST', url: '/v1/responses', body: { input: [{ text }] } });
        oldThread.turns[0].items = [{ type: 'userMessage', content: [{ text }] }];
      } else if (text === '/clear clear-owned') {
        if (fault !== 'no-confirmation') bot(id, fault === 'old-card' ? '确认清空当前对话：请先停止并重新发送命令'
          : '确认清空当前对话：终止并新建，保留当前配置，无需等待状态检测或再次执行命令。[终止并新建] [取消]');
        if (fault === 'early-rebind') current = { ...current, sessionId: 'premature' };
        if (fault === 'early-stop') oldThread.turns[0].status = 'interrupted';
      } else if (text === '是') {
        assert.equal(current.sessionId, 'old');
        current = { ...session, sessionId: 'new', threadId: fault === 'same-thread' ? session.threadId : 'thread-new' };
        if (fault === 'configuration-loss') current.configuration = { ...session.configuration, networkAccess: true };
        bot(id, fault === 'old-response' ? '旧任务仍运行，请再次执行 /clear' : '当前聊天已切到新对话，保留了原来的配置。');
      } else assert.fail(`harness 发送了非故事输入：${text}`);
      return id;
    },
    async thread(id) {
      actions.push(`read-thread:${id}`);
      // 旧线程始终 inProgress；harness 若在确认后等待旧终态，本测试就不能完成。
      return structuredClone(id === session.threadId ? oldThread : newThread);
    },
    async completedPrompt(_chat, name) {
      assert.equal(released, false, '新输入成功之前不得释放旧模型');
      assert.equal(current.sessionId, 'new'); assert.equal(name, 'CLEAR');
      actions.push('new-input');
      const id = recordInput('LIFECYCLE_CLEAR_INPUT_owned');
      newThread.turns.push({ id: 'new-turn', status: 'completed', items: [{ type: 'userMessage', content: [{ text: 'LIFECYCLE_CLEAR_INPUT_owned' }] }] });
      if (fault === 'old-input') newThread.turns[0].items.push({ type: 'userMessage', content: [{ text: oldInput }] });
      bot(provider === 'tmux' ? undefined : id, 'LIFECYCLE_CLEAR_RESULT_owned');
      if (fault === 'late-result') bot(report.inputs[0].messageId, modelOutput);
      if (fault === 'empty-card') bot(undefined, '');
      newInputCompleted = true;
      return { threadId: 'thread-new', turnId: 'new-turn', response: 'LIFECYCLE_CLEAR_RESULT_owned' };
    },
    check(name, detail) { report.checks.push({ name, ok: true, detail }); },
    save() {},
  };
  return { c, actions, report, released: () => released, newInputCompleted: () => newInputCompleted };
}

for (const provider of ['sdk', 'tmux']) test(`active clear ${provider} 编排：文字确认后不等旧终态，新输入成功前保持旧模型等待`, async () => {
  const f = activeClearFixture(undefined, provider);
  const result = await runActiveClear(f.c);
  assert.equal(result.threadId, 'thread-new');
  assert.deepEqual(f.report.inputs.map((i) => i.text), [
    'LIFECYCLE_ACTIVE_CLEAR_INPUT_owned', '/clear clear-owned', '是', 'LIFECYCLE_CLEAR_INPUT_owned',
  ]);
  assert.equal(f.report.activeClear?.confirmationMethod, 'user-text');
  assert.equal(f.report.activeClear?.callbackStatus, 'unverified');
  assert.equal(f.report.activeClear?.oldTurnAfterNewInput?.status, 'inProgress');
  assert.deepEqual(f.report.checks.map((v) => v.name), ['active_clear_confirmation_user_readback', 'clear_new_thread_inherits']);
  assert(f.actions.indexOf('new-input') < f.actions.indexOf('release'));
  assert(!f.actions.slice(f.actions.indexOf('是') + 1, f.actions.indexOf('new-input')).includes('read-thread:thread-old'));
  assert(f.released());
});

test('active clear 拒绝旧交互、确认前切换/停止和入口阻塞，失败释放自有模型等待', async () => {
  for (const [fault, expected] of [
    ['old-card', /缺少新文案/], ['early-rebind', /确认前不能提前切换/],
    ['early-stop', /确认前不能提前结束/], ['no-confirmation', /等待超时/], ['old-response', /新的 clear 完成文案/],
  ] as const) {
    const f = activeClearFixture(fault);
    await assert.rejects(runActiveClear(f.c), expected);
    assert.equal(f.newInputCompleted(), false, fault);
    assert(f.released(), fault);
    assert(!f.report.inputs.some((i) => i.text.includes('--confirm') || i.text === '/stop'), fault);
  }
});

test('active clear 拒绝配置回落、旧 thread/输入继承、旧结果及没有标记的空卡', async () => {
  for (const [fault, expected] of [
    ['configuration-loss', /继承用户配置/], ['same-thread', /不能复制旧 thread/], ['old-input', /旧输入不能进入新 thread/],
    ['late-result', /旧轮次结果不能投递/], ['empty-card', /旧投递或空卡/],
  ] as const) {
    const f = activeClearFixture(fault);
    await assert.rejects(runActiveClear(f.c), expected);
    assert(f.released(), fault);
  }
});

test('active clear 最终回读再次检查迟到投递，允许后续真实命令回复', async () => {
  const f = activeClearFixture(undefined, 'tmux');
  await runActiveClear(f.c);
  const payload = await f.c.read('chat') as { data: { messages: Array<Record<string, any>> } };
  f.report.inputs.push({ chatId: 'chat', text: '/new owned', messageId: 'new-command' });
  const bot = { sender: { sender_type: 'app', id: 'app' }, message_id: 'new-reply', content: '新群已创建', reply_to: 'new-command' };
  payload.data.messages.push(bot);
  assertNoOldClearDelivery(f.report, 'chat', 'app', payload);
  payload.data.messages.push({ ...bot, message_id: 'late-empty', reply_to: undefined, content: '' });
  assert.throws(() => assertNoOldClearDelivery(f.report, 'chat', 'app', payload), /旧投递或空卡/);
  payload.data.messages.pop();
  payload.data.messages.push({ ...bot, message_id: 'late-result', content: f.report.activeClear!.forbiddenResult });
  assert.throws(() => assertNoOldClearDelivery(f.report, 'chat', 'app', payload), /旧轮次结果不能投递/);
});

test('active clear 只允许新 tmux thread 的一条准确查看通知，其他 post/空卡/重复仍失败', async () => {
  const f = activeClearFixture(undefined, 'tmux');
  await runActiveClear(f.c);
  const payload = await f.c.read('chat') as { data: { messages: Array<Record<string, any>> } };
  const notice = { sender: { sender_type: 'app', id: 'app' }, message_id: 'view-notice', msg_type: 'post',
    content: '已建立 tmux 查看入口，通过 --remote 连接当前共享 Codex 线程。' };
  payload.data.messages.push(notice);
  assertNoOldClearDelivery(f.report, 'chat', 'app', payload);
  assert.deepEqual(f.report.activeClear?.viewNotice, { messageId: 'view-notice', sessionId: 'new', threadId: 'thread-new' });
  payload.data.messages.push({ ...notice, message_id: 'duplicate' });
  assert.throws(() => assertNoOldClearDelivery(f.report, 'chat', 'app', payload), /通知不能重复/);
  payload.data.messages.pop();
  for (const invalid of [{ ...notice, content: '' }, { ...notice, content: '其他通知' }, { ...notice, msg_type: 'interactive' }]) {
    payload.data.messages[payload.data.messages.length - 1] = invalid;
    assert.throws(() => assertNoOldClearDelivery(f.report, 'chat', 'app', payload), /旧投递或空卡/);
  }
  payload.data.messages[payload.data.messages.length - 1] = notice;
  f.report.provider = 'sdk';
  assert.throws(() => assertNoOldClearDelivery(f.report, 'chat', 'app', payload), /旧投递或空卡/);
  f.report.provider = 'tmux'; f.report.sessions.cleared.threadId = session.threadId;
  assert.throws(() => assertNoOldClearDelivery(f.report, 'chat', 'app', payload), /旧投递或空卡/);
});
