import assert from 'node:assert/strict';
import { assertAppliedSettings, runActiveConfiguration, runMentionFilter, type NativeTurnSettings } from './session-configuration.js';
import { runNativeRequestCards, type NativeCardReport } from './native-request-cards.js';
import { CodexAppServerClient, type AppServerMessage } from '../../runtime/codex/app-server-client.js';
export interface ModelBody { model?: string; input?: unknown[]; tools?: Array<Record<string, any>>; [key: string]: unknown }
export type ModelOutput = { text: string } | { search: string } | { tool: string; arguments: Record<string, unknown> | string; callId?: string; namespace?: string };
interface FixtureModel {
  requests: Array<{ method: string; url: string; body: ModelBody }>;
  unexpected: string[];
  enqueue(output: ModelOutput | ((body: ModelBody) => ModelOutput), hold?: boolean): { release(): void };
}

/** 只有模型可编排；这些边界由真实 CLI、真实 Bridge 和只读后端观察连接提供。 */
export interface LifecycleDriver {
  runId: string;
  provider: 'sdk' | 'tmux';
  chatId: string;
  modelName: string;
  alternateModelName: string;
  configurationWorkspace: string;
  turnSettings(threadId: string, turnId: string): NativeTurnSettings | undefined;
  filteredMessage(chatId: string, messageId: string): unknown | undefined;
  sendMentioned(chatId: string, text: string): Promise<string>;
  endpoint: string;
  timeoutMs: number;
  pollMs: number;
  approvalWaitMs: number;
  nativeRequestCards?: boolean;
  workspace?: string;
  model: FixtureModel;
  observer: CodexAppServerClient;
  send(chatId: string, text: string): Promise<string>;
  read(chatId: string): Promise<unknown>;
  state(chatId: string): LifecycleSession | undefined;
  findCreatedChat(name: string): string | undefined;
  restartBridge(): Promise<void>;
  callbackEvidence(chatId: string, messageId: string, decision?: 'accept' | 'cancel'): unknown | undefined;
  save(report: LifecycleReport): void;
  progress(text: string): void;
  botAppId: string;
}
export interface LifecycleSession {
  sessionId: string;
  threadId?: string;
  endpoint?: string;
  configuration: Record<string, unknown>;
  streamKeys: string[];
  terminal?: { streamKey: string; status: string } | null;
}
export interface NativeTurn { id: string; status: string; items: Array<Record<string, unknown>> }
export interface NativeThread { id: string; turns: NativeTurn[] }
export interface LifecycleReport {
  scenario: 'app-server-lifecycle';
  runId: string;
  provider: string;
  checks: Array<{ name: string; ok: boolean; detail?: unknown }>;
  automaticPassed: boolean;
  acceptanceComplete: boolean;
  stage: string;
  approval: { status: 'not-run' | 'waiting' | 'unverified' | 'passed'; chatUrl: string; detail: string; deadline?: string; callback?: unknown; request?: AppServerMessage };
  chats: string[];
  inputs: Array<{ chatId: string; text: string; messageId: string }>;
  readbacks: Record<string, unknown>;
  sessions: Record<string, LifecycleSession>;
  protocol: AppServerMessage[];
  threads: Record<string, NativeThread>;
  modelRequests: LifecycleDriver['model']['requests'];
  activeClear?: ActiveClearEvidence;
  nativeCards?: NativeCardReport[];
  configurationChanges?: Array<Record<string, unknown>>;
  appliedSettings?: Array<{ chatId: string; name: string; sessionId: string; threadId: string; turnId: string; response: string; native: NativeTurnSettings }>;

  error?: string;
}

export function feishuChatUrl(chatId: string): string {
  return `https://applink.feishu.cn/client/chat/open?openChatId=${encodeURIComponent(chatId)}`;
}
export function userReadbackMessages(payload: unknown): Array<Record<string, any>> {
  const p = payload as { ok?: boolean; identity?: string; data?: { messages?: unknown[] } } | null;
  assert(p?.ok === true && p.identity === 'user', '最终消息必须由真实用户身份成功回读');
  assert(Array.isArray(p.data?.messages), '用户回读缺少 messages');
  return p.data.messages as Array<Record<string, any>>;
}
export async function readAllUserPages(fetchPage: (token?: string) => Promise<unknown>): Promise<unknown> {
  const pages: any[] = [];
  const messages: Array<Record<string, any>> = [];
  const tokens = new Set<string>();
  let token: string | undefined;
  do {
    assert(pages.length < 10, '隔离故事回读超过 10 页，必须检查重复发送');
    const page = await fetchPage(token) as any;
    messages.push(...userReadbackMessages(page)); pages.push(page);
    token = page.data.has_more ? page.data.page_token : undefined;
    if (page.data.has_more) {
      assert(typeof token === 'string' && token && !tokens.has(token), '真实用户回读分页游标缺失或重复');
      tokens.add(token);
    }
  } while (token);
  assert.equal(new Set(messages.map((m) => m.message_id)).size, messages.length, '分页之间不能重复消息');
  return { ...pages[0], data: { ...pages[0].data, has_more: false, page_token: '', messages }, pages };
}
export function botReplyIds(payload: unknown, appId: string, marker: string): string[] {
  return userReadbackMessages(payload).filter((m) => m.sender?.sender_type === 'app'
    && m.sender.id === appId && JSON.stringify(m.content ?? m.body?.content ?? '').includes(marker))
    .map((m) => String(m.message_id));
}
export function unexpectedRestartCards(before: unknown, after: unknown, appId: string, commandId?: string): Array<Record<string, any>> {
  const old = new Set(userReadbackMessages(before).map((m) => m.message_id));
  return userReadbackMessages(after).filter((m) => m.sender?.sender_type === 'app' && m.sender.id === appId
    && !old.has(m.message_id) && (!commandId || m.reply_to !== commandId));
}
export function assertSameTurnInput(thread: NativeThread, turnId: string, text: string): void {
  const matches = thread.turns.flatMap((turn) => turn.items.filter((item) => item.type === 'userMessage' && JSON.stringify(item).includes(text)).map(() => turn));
  assert.equal(matches.length, 1, '输入必须只进入一个原生轮次');
  assert.equal(matches[0].id, turnId, '运行中追加必须进入原轮次，不能排成新轮次');
}
export function assertInherited(before: LifecycleSession, after: LifecycleSession): void {
  assert.notEqual(after.sessionId, before.sessionId, 'clear/new 必须创建新的 BridgeSession');
  assert.deepEqual(after.configuration, before.configuration, '新会话必须继承用户配置');
  assert.equal(after.endpoint, before.endpoint, '新会话必须继续选择原共享后端');
  if (after.threadId) assert.notEqual(after.threadId, before.threadId, 'clear/new 不能复制旧 thread');
}

interface ActiveClearEvidence {
  threadId: string;
  turnId: string;
  inputMessageId: string;
  forbiddenResult: string;
  confirmationMethod: 'user-text';
  callbackStatus: 'unverified';
  chatUrl: string;
  commandMessageId?: string;
  confirmationCard?: Record<string, any>;
  answerMessageId?: string;
  confirmationResponse?: Record<string, any>;
  messageIdsBeforeNewInput?: string[];
  newReplyMarker?: string;
  viewNotice?: { messageId: string; sessionId: string; threadId: string };
  reboundAt?: string;
  oldTurnAfterNewInput?: NativeTurn;
  oldTurnReadError?: string;
  modelReleasedAt?: string;
}

export function assertNoOldClearDelivery(report: LifecycleReport, chatId: string, appId: string, payload: unknown): void {
  const evidence = report.activeClear;
  assert(evidence?.messageIdsBeforeNewInput && evidence.newReplyMarker, '缺少 active clear 完成证据');
  assert.equal(botReplyIds(payload, appId, evidence.forbiddenResult).length, 0, '旧轮次结果不能投递到 clear 后的聊天');
  const answerIndex = report.inputs.findIndex((i) => i.messageId === evidence.answerMessageId && i.chatId === chatId);
  assert(answerIndex >= 0, '缺少 clear 的真实文字确认证据');
  const allowedReplies = new Set([evidence.commandMessageId, evidence.answerMessageId,
    ...report.inputs.slice(answerIndex + 1).filter((i) => i.chatId === chatId).map((i) => i.messageId)]);
  // mirror 的真实结果卡不带 reply_to；用本轮唯一结果标记关联，仍拒绝额外空卡。
  const resultIds = botReplyIds(payload, appId, evidence.newReplyMarker);
  assert.equal(resultIds.length, 1, 'clear 后的新回复必须唯一');
  const before = new Set(evidence.messageIdsBeforeNewInput);
  let extra = userReadbackMessages(payload).filter((m) => m.sender?.sender_type === 'app' && m.sender.id === appId
    && !before.has(m.message_id) && !allowedReplies.has(m.reply_to) && !resultIds.includes(m.message_id));
  // 新 thread 的首次输入会建立新 view，生产在核对绑定后发送这条独立通知。
  const cleared = report.sessions.cleared;
  if (report.provider === 'tmux' && cleared?.threadId && cleared.threadId !== evidence.threadId) {
    const notices = extra.filter((m) => m.msg_type === 'post'
      && m.content === '已建立 tmux 查看入口，通过 --remote 连接当前共享 Codex 线程。');
    assert(notices.length <= 1, '新 thread 的 tmux 查看入口通知不能重复');
    if (notices.length === 1) {
      const messageId = String(notices[0].message_id);
      if (evidence.viewNotice) assert.equal(evidence.viewNotice.messageId, messageId, '不能用另一次 view 通知替换本次证据');
      evidence.viewNotice = { messageId, sessionId: cleared.sessionId, threadId: cleared.threadId };
      extra = extra.filter((m) => m.message_id !== messageId);
    }
  }
  assert.deepEqual(extra, [], 'clear 后出现未关联新输入的旧投递或空卡');
}

interface ActiveClearContext {
  driver: Pick<LifecycleDriver, 'runId' | 'chatId' | 'botAppId' | 'model' | 'state'>;
  report: LifecycleReport;
  before: LifecycleSession;
  wait<T>(label: string, read: () => T | undefined | false | Promise<T | undefined | false>): Promise<T>;
  read(chat: string): Promise<unknown>;
  send(chat: string, text: string): Promise<string>;
  thread(id: string): Promise<NativeThread>;
  completedPrompt(chat: string, name: string): Promise<{ threadId: string; turnId: string; response: string }>;
  check(name: string, detail?: unknown): void;
  save(): void;
}

/** 保持旧模型等待，走真实 /clear 和文字确认；不调用停止 RPC 或内部确认命令。 */
export async function runActiveClear(c: ActiveClearContext): Promise<{ threadId: string; turnId: string; response: string }> {
  const { driver: d, report, before } = c;
  assert(before.threadId, 'active clear 必须已有真实线程');
  const input = `LIFECYCLE_ACTIVE_CLEAR_INPUT_${d.runId}`;
  const forbiddenResult = `LIFECYCLE_ACTIVE_CLEAR_OLD_RESULT_${d.runId}`;
  const requestOffset = d.model.requests.length;
  const held = d.model.enqueue({ text: forbiddenResult }, true);
  const reply = (payload: unknown, id: string) => userReadbackMessages(payload).find((m) =>
    m.sender?.sender_type === 'app' && m.sender.id === d.botAppId && m.reply_to === id);
  try {
    const inputMessageId = await c.send(d.chatId, input);
    await c.wait('active clear 的模型已收到输入', () => d.model.requests.slice(requestOffset).some((r) => JSON.stringify(r.body.input).includes(input)));
    const active = await c.wait('active clear 的原生运行中轮次', async () => (await c.thread(before.threadId!)).turns.find((t) =>
      t.status === 'inProgress' && t.items.some((i) => i.type === 'userMessage' && JSON.stringify(i).includes(input))));
    const evidence: ActiveClearEvidence = report.activeClear = {
      threadId: before.threadId, turnId: active.id, inputMessageId, forbiddenResult,
      confirmationMethod: 'user-text', callbackStatus: 'unverified', chatUrl: feishuChatUrl(d.chatId),
    };
    c.save();
    evidence.commandMessageId = await c.send(d.chatId, `/clear clear-${d.runId}`); c.save();
    const card = await c.wait('active clear 的真实确认卡', async () => reply(await c.read(d.chatId), evidence.commandMessageId!));
    evidence.confirmationCard = card; c.save();
    assert.equal(card.msg_type, 'interactive', 'active clear 必须返回真实交互卡');
    const cardText = JSON.stringify(card.content ?? card.body?.content);
    for (const text of ['确认清空当前对话', '终止并新建', '保留当前配置', '无需等待状态检测或再次执行命令', '取消']) {
      assert(cardText.includes(text), `active clear 确认卡缺少新文案：${text}`);
    }
    const pending = d.state(d.chatId);
    assert.equal(pending?.sessionId, before.sessionId, '确认前不能提前切换 BridgeSession');
    assert.equal(pending?.threadId, before.threadId, '确认前不能提前切换 thread');
    assert.equal((await c.thread(before.threadId)).turns.find((t) => t.id === active.id)?.status, 'inProgress', '确认前不能提前结束旧轮次');
    c.check('active_clear_confirmation_user_readback', { messageId: card.message_id, threadId: before.threadId, turnId: active.id });

    evidence.answerMessageId = await c.send(d.chatId, '是'); c.save();
    const response = await c.wait('文字确认后一次完成新建', async () => reply(await c.read(d.chatId), evidence.answerMessageId!));
    evidence.confirmationResponse = response; c.save();
    assert(JSON.stringify(response.content ?? response.body?.content).includes('当前聊天已切到新对话，保留了原来的配置。'), '文字确认未返回新的 clear 完成文案');
    const cleared = d.state(d.chatId);
    assert(cleared, '文字确认完成后缺少新会话'); assertInherited(before, cleared);
    evidence.reboundAt = new Date().toISOString(); c.save();
    evidence.messageIdsBeforeNewInput = userReadbackMessages(await c.read(d.chatId)).map((m) => String(m.message_id)); c.save();
    // 不等旧 turn/completed，也不释放旧模型；先证明新上下文可以正常执行。
    const clearTurn = await c.completedPrompt(d.chatId, 'CLEAR');
    evidence.newReplyMarker = clearTurn.response;
    assert.notEqual(clearTurn.threadId, before.threadId);
    const after = d.state(d.chatId);
    assert(after, '新输入完成后缺少会话'); assertInherited(before, after);
    assert.equal(after.threadId, clearTurn.threadId);
    assert(!(await c.thread(clearTurn.threadId)).turns.some((t) => t.items.some((i) => i.type === 'userMessage' && JSON.stringify(i).includes(input))), '旧输入不能进入新 thread');
    report.sessions.cleared = after;
    c.check('clear_new_thread_inherits', { before: before.threadId, after: clearTurn.threadId, confirmation: 'user-text' });
    // 单次只读快照保留实际时序；读取失败也不能变成等待旧线程结束的门槛。
    try { evidence.oldTurnAfterNewInput = (await c.thread(before.threadId)).turns.find((t) => t.id === active.id); }
    catch (error) { evidence.oldTurnReadError = String(error); }
    held.release(); evidence.modelReleasedAt = new Date().toISOString(); c.save();
    const freshInput = report.inputs.find((i) => i.chatId === d.chatId && i.text === `LIFECYCLE_CLEAR_INPUT_${d.runId}`);
    assert(freshInput, '缺少 clear 后的真实用户输入证据');
    assertNoOldClearDelivery(report, d.chatId, d.botAppId, await c.read(d.chatId));
    return clearTurn;
  } finally { held.release(); }
}

/** SDK 和 tmux 使用相同输入时序与终态断言；只允许真实飞书客户端处理审批。 */
export async function runAppServerLifecycle(d: LifecycleDriver): Promise<LifecycleReport> {
  const report: LifecycleReport = {
    scenario: 'app-server-lifecycle', runId: d.runId, provider: d.provider,
    checks: [], automaticPassed: false, acceptanceComplete: false, stage: 'setup',
    approval: { status: 'not-run', chatUrl: feishuChatUrl(d.chatId), detail: '尚未执行审批步骤；不能据此宣称真实点击通过。' },
    chats: [d.chatId], inputs: [], readbacks: {}, sessions: {}, protocol: [], threads: {}, modelRequests: d.model.requests,
  };
  let unsubscribe = d.observer.onMessage((m) => { report.protocol.push(m); });
  const save = () => d.save(report);
  const check = (name: string, detail?: unknown) => { report.checks.push({ name, ok: true, detail }); save(); };
  const stage = (name: string) => { report.stage = name; d.progress(name); save(); };
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const wait = async <T>(label: string, read: () => T | undefined | false | Promise<T | undefined | false>, timeout = d.timeoutMs): Promise<T> => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const value = await read();
      if (value !== undefined && value !== false) return value;
      await sleep(d.pollMs);
    }
    throw new Error(`等待超时：${label}`);
  };
  const read = async (chat: string) => {
    const payload = await d.read(chat); userReadbackMessages(payload);
    report.readbacks[chat] = payload; save(); return payload;
  };
  const send = async (chat: string, text: string, mention = d.state(chat)?.configuration['session.requireMention'] === true) => {
    const messageId = await (mention ? d.sendMentioned(chat, text) : d.send(chat, text));
    report.inputs.push({ chatId: chat, text, messageId }); save(); return messageId;
  };
  const command = async (chat: string, text: string, expected: string) => {
    const id = await send(chat, text);
    await wait(`命令 ${text} 的真实回复`, async () => {
      // 同一命令可先发查看入口等进度通知；以所需回复出现为准。
      return userReadbackMessages(await read(chat)).find((m) => m.sender?.sender_type === 'app' && m.sender.id === d.botAppId && m.reply_to === id
        && JSON.stringify(m.content ?? m.body?.content).includes(expected));
    });
    return id;
  };
  const state = async (chat: string) => wait('持久化会话', () => d.state(chat));
  const thread = async (id: string): Promise<NativeThread> => {
    const response = await d.observer.request<{ thread: NativeThread }>('thread/read', { threadId: id, includeTurns: true });
    report.threads[id] = response.thread; return response.thread;
  };
  const subscribe = async (chat: string) => {
    const s = await wait('真实 thread 绑定', () => { const s = d.state(chat); return s?.threadId ? s : undefined; });
    assert.equal(s.endpoint, d.endpoint);
    // 无配置覆盖、无输入、无审批回复；仅订阅已有线程以观察原生服务端事件。
    await d.observer.request('thread/resume', { threadId: s.threadId });
    return s.threadId!;
  };
  const terminal = (id: string, turnId: string, status = 'completed') => wait(`原生 ${status} 终态`, async () => {
    const turn = (await thread(id)).turns.find((t) => t.id === turnId);
    if (!turn || turn.status === 'inProgress') return undefined;
    assert.equal(turn.status, status, `轮次 ${turnId} 终态错误`); return turn;
  });
  const visible = (chat: string, marker: string) => wait(`用户可见 ${marker}`, async () => {
    const payload = await read(chat);
    const ids = botReplyIds(payload, d.botAppId, marker);
    assert(ids.length <= 1, `模型结果重复发送：${marker}，消息 ${ids.join(',')}`);
    return ids.length === 1 ? ids : undefined;
  });
  const marker = (name: string) => `LIFECYCLE_${name}_${d.runId}`;
  const completedPrompt = async (chat: string, name: string) => {
    const response = marker(`${name}_RESULT`);
    const expected = await state(chat);
    const requestOffset = d.model.requests.length;
    d.model.enqueue({ text: response });
    await send(chat, marker(`${name}_INPUT`));
    await wait('真实模型收到本轮输入', () => d.model.requests.some((r) => JSON.stringify(r.body.input).includes(marker(`${name}_INPUT`))));
    const id = await subscribe(chat);
    await visible(chat, response);
    const t = await wait('输入对应的原生轮次', async () => (await thread(id)).turns.find((t) =>
      t.items.some((i) => i.type === 'userMessage' && JSON.stringify(i).includes(marker(`${name}_INPUT`)))));
    await terminal(id, t.id);
    const native = await wait('本轮原生配置已落盘', () => d.turnSettings(id, t.id));
    const request = d.model.requests.slice(requestOffset).find((r) => JSON.stringify(r.body.input).includes(marker(`${name}_INPUT`)));
    assert(request, '缺少本轮模型请求'); assertAppliedSettings(expected, native, request.body);
    report.appliedSettings ??= [];
    report.appliedSettings.push({ chatId: chat, name, sessionId: expected.sessionId, threadId: id, turnId: t.id, response, native }); save();
    return { threadId: id, turnId: t.id, response };
  };
  try {
    stage('用户配置与基本收发');
    await command(d.chatId, '/runtime codex', 'codex');
    await command(d.chatId, '/require_at off', 'off');
    await command(d.chatId, '/yolo off', 'normal');
    await command(d.chatId, `/p ${d.provider}`, d.provider === 'tmux' ? '共享 Codex 线程已就绪' : 'sdk');
    await command(d.chatId, `/model ${d.modelName}`, d.modelName);
    await command(d.chatId, '/reasoning low', 'low');
    await command(d.chatId, '/sandbox read-only', 'read-only');
    await command(d.chatId, '/network off', '网络');
    const first = await completedPrompt(d.chatId, 'BASIC');
    const original = await state(d.chatId); report.sessions.original = original;
    assert.equal(original.configuration['runtime.codex.provider'], d.provider);
    assert.equal(original.configuration['runtime.codex.reasoningEffort'], 'low');
    assert.equal(original.configuration['runtime.codex.sandboxMode'], 'read-only');
    assert.equal(original.configuration['runtime.codex.networkAccess'], false);
    check('real_user_input_and_readback', first);

    const configurationStory = { driver: d, report, wait, command, send, read, state, thread, completedPrompt, visible, check, save };
    stage('活动轮次配置保存与下轮原生应用');
    await runActiveConfiguration(configurationStory);
    await runMentionFilter(configurationStory, d.chatId, 'original');

    stage('运行中追加进入原轮次');
    const before = d.model.requests.length;
    const hold = d.model.enqueue({ text: marker('STEER_FIRST_RESULT') }, true);
    d.model.enqueue({ text: marker('STEER_FINAL_RESULT') });
    await send(d.chatId, marker('SLOW_INPUT'));
    await wait('模型已收到暂停请求', () => d.model.requests.length > before);
    const active = await wait('原生运行中轮次', async () => (await thread(first.threadId)).turns.find((t) => t.status === 'inProgress'));
    const steerMessage = await send(d.chatId, marker('STEER_INPUT'));
    // Bridge 审计输入已接收并不等于成功；释放后检查原生 userMessage 的 turn 身份。
    await wait('Bridge 已接受运行中追加', async () => userReadbackMessages(await read(d.chatId)).find((m) =>
      m.message_id === steerMessage && JSON.stringify(m.reactions || {}).includes('Get')));
    hold.release();
    await terminal(first.threadId, active.id);
    assertSameTurnInput(await thread(first.threadId), active.id, marker('STEER_INPUT'));
    assert(d.model.requests.some((r) => JSON.stringify(r.body.input).includes(marker('STEER_INPUT'))), '模型未读到追加内容');
    await visible(d.chatId, marker('STEER_FINAL_RESULT'));
    check('steer_same_native_turn', { threadId: first.threadId, turnId: active.id });

    stage('停止并等待原生与飞书终态');
    const stopBefore = d.model.requests.length;
    const previousStreams = new Set((await state(d.chatId)).streamKeys);
    const stopped = d.model.enqueue({ text: marker('MUST_NOT_FINISH') }, true);
    await send(d.chatId, marker('STOP_INPUT'));
    await wait('停止前模型已运行', () => d.model.requests.length > stopBefore);
    const stopTurn = await wait('停止前活动轮次', async () => (await thread(first.threadId)).turns.find((t) => t.status === 'inProgress'));
    await send(d.chatId, '/stop');
    await terminal(first.threadId, stopTurn.id, 'interrupted'); stopped.release();
    const stoppedStream = await wait('停止轮次的流式卡片已结束', () => {
      const t = d.state(d.chatId)?.terminal;
      return t && !previousStreams.has(t.streamKey) && ['interrupted', 'error', 'failed', 'aborted', 'cancelled'].includes(t.status) ? t : undefined;
    });
    await wait('飞书停止卡片', async () => userReadbackMessages(await read(d.chatId)).find((m) =>
      m.sender?.sender_type === 'app' && /停止|中断|取消/.test(JSON.stringify(m.content ?? m.body?.content))));
    assert.equal(botReplyIds(await read(d.chatId), d.botAppId, marker('MUST_NOT_FINISH')).length, 0);
    check('stop_native_interrupted', { threadId: first.threadId, turnId: stopTurn.id, stream: stoppedStream });
    report.checks.push({ name: 'stop_card_interrupted', ok: stoppedStream.status === 'interrupted', detail: stoppedStream }); save();

    stage('运行中 /clear 确认、新线程与配置继承');
    const clearTurn = await runActiveClear({ driver: d, report, before: await state(d.chatId), wait, read, send, thread, completedPrompt, check, save });

    stage('/new 产品路径新群与配置继承');
    const newName = `life-${d.runId}`;
    await send(d.chatId, `/new ${newName}`);
    const newChat = await wait('产品 /new 绑定的新群', () => d.findCreatedChat(newName));
    assert.notEqual(newChat, d.chatId); report.chats.push(newChat); save();
    await visible(newChat, '已创建群聊会话');
    assertInherited(report.sessions.cleared, await state(newChat));
    const newTurn = await completedPrompt(newChat, 'NEW');
    assert.notEqual(newTurn.threadId, clearTurn.threadId);
    report.sessions.new = await state(newChat);
    check('new_product_chat_inherits', { chatId: newChat, threadId: newTurn.threadId });
    report.sessions.newInherited = report.sessions.new;
    stage('require-at 与 yolo 新群继承及会话隔离');
    await runMentionFilter(configurationStory, newChat, 'new_inherited');
    await command(newChat, '/require_at off', 'off');
    await command(newChat, '/yolo off', 'normal');
    await command(newChat, `/model ${d.modelName}`, d.modelName);
    await command(newChat, '/reasoning low', 'low');
    await command(newChat, '/sandbox read-only', 'read-only');
    await command(newChat, '/network off', '网络');
    const source = await state(d.chatId);
    assert.equal(source.configuration['session.requireMention'], true);
    assert(['on', 'yolo'].includes(String(source.configuration['runtime.codex.yoloMode'])));
    await runMentionFilter(configurationStory, d.chatId, 'source_isolated');
    await completedPrompt(newChat, 'NEW_OFF');
    report.sessions.new = await state(newChat);
    check('require_at_and_yolo_session_isolation');

    stage('Bridge 重启后原线程续用与去重');
    const messagesBefore = botReplyIds(await read(newChat), d.botAppId, newTurn.response);
    const beforeRestart = new Map(await Promise.all(report.chats.map(async (chat) => [chat, await read(chat)] as const)));
    const requestsBefore = d.model.requests.length;
    // 观察连接也断开，避免它替重启中的 Bridge 保持线程订阅。
    unsubscribe(); d.observer.close();
    await d.restartBridge();
    d.observer = await CodexAppServerClient.connect(d.endpoint);
    unsubscribe = d.observer.onMessage((m) => { report.protocol.push(m); });
    const currentCommand = await command(newChat, '/current', 'Codex');
    await sleep(Math.max(6_000, d.pollMs * 2));
    report.sessions.restarted = await state(newChat);
    assert.equal(report.sessions.restarted.threadId, newTurn.threadId);
    assert.deepEqual(report.sessions.restarted.configuration, report.sessions.new.configuration, '重启不能回落用户配置');
    assert.equal(d.model.requests.length, requestsBefore, '重启不能重发模型输入');
    assert.deepEqual(botReplyIds(await read(newChat), d.botAppId, newTurn.response), messagesBefore, '重启不能重复发送历史结果');
    const extraCards = (await Promise.all(report.chats.map(async (chat) => unexpectedRestartCards(beforeRestart.get(chat),
      await read(chat), d.botAppId, chat === newChat ? currentCommand : undefined)))).flat();
    // 即使重复内容为空，也必须失败；继续独立故事以保留后续卡片验收证据。
    report.checks.push({ name: 'bridge_restart_no_extra_cards', ok: extraCards.length === 0, detail: extraCards }); save();
    const resumed = await completedPrompt(newChat, 'RESUME');
    assert.equal(resumed.threadId, newTurn.threadId);
    assertSameTurnInput(await thread(resumed.threadId), resumed.turnId, marker('RESUME_INPUT'));
    assert.deepEqual(botReplyIds(await read(newChat), d.botAppId, newTurn.response), messagesBefore);
    check('bridge_restart_reuses_thread_without_resend', resumed);

    stage('原生 Codex 问答与真实用户文字回答');
    const question = marker('QUESTION'); const answer = marker('ANSWER');
    const requestStart = report.protocol.length;
    d.model.enqueue((body) => {
      assert(body.tools?.some((t) => t.name === 'request_user_input'), '原生 Codex 未暴露 request_user_input；检查 fixture feature 支持');
      return { tool: 'request_user_input', arguments: { questions: [{ id: 'choice', header: '验收', question,
        options: [{ label: '继续', description: '继续隔离验收' }, { label: '暂停', description: '暂停隔离验收' }] }] } };
    });
    d.model.enqueue({ text: marker('QUESTION_RESULT') });
    await send(newChat, marker('QUESTION_INPUT'));
    const pendingQuestion = await wait('原生 request_user_input 请求', () => report.protocol.slice(requestStart).find((m) => m.method === 'item/tool/requestUserInput'));
    await wait('真实用户可见原生问题卡', async () => userReadbackMessages(await read(newChat)).find((m) => m.sender?.id === d.botAppId
      && JSON.stringify(m.content).includes('Codex 需要你的回答') && JSON.stringify(m.content).includes(question)));
    await send(newChat, answer);
    const qTurn = (pendingQuestion.params as { turnId: string }).turnId;
    await terminal(newTurn.threadId, qTurn);
    assert(d.model.requests.some((r) => (r.body.input || []).some((i: any) => i.type === 'function_call_output' && JSON.stringify(i).includes(answer))), '用户回答必须进入原生工具结果');
    await visible(newChat, marker('QUESTION_RESULT'));
    check('native_question_real_user_answer', { turnId: qTurn });
    save();

    stage('原生审批卡片与可选真实客户端点击');
    report.approval.chatUrl = feishuChatUrl(newChat);
    const approvalStart = report.protocol.length;
    d.model.enqueue((body) => {
      const tool = ['exec_command', 'shell_command', 'shell'].find((name) => body.tools?.some((t) => t.name === name));
      assert(tool, '原生 Codex 未提供命令工具');
      const command = `printf '${marker('APPROVED_EXECUTION')}'`;
      return { tool, arguments: {
        ...(tool === 'exec_command' ? { cmd: command } : tool === 'shell_command' ? { command } : { command: ['/bin/sh', '-c', command] }),
        sandbox_permissions: 'require_escalated', justification: '只输出本次隔离验收标记，请在真实飞书客户端点击允许。',
      } };
    });
    await send(newChat, marker('APPROVAL_INPUT'));
    const approval = await wait('原生命令审批请求', () => report.protocol.slice(approvalStart).find((m) => m.method === 'item/commandExecution/requestApproval'));
    report.approval.request = approval;
    const approvalCard = await wait('真实用户可见原生审批卡', async () => userReadbackMessages(await read(newChat)).find((m) => m.sender?.id === d.botAppId
      && JSON.stringify(m.content).includes('Codex 请求确认') && JSON.stringify(m.content).includes(marker('APPROVED_EXECUTION'))));
    check('native_approval_card_user_readback');
    const approvalTurn = (approval.params as { turnId: string }).turnId;
    if (d.approvalWaitMs > 0) {
      report.approval.status = 'waiting';
      report.approval.deadline = new Date(Date.now() + d.approvalWaitMs).toISOString();
      report.approval.detail = `请在真实飞书客户端点击允许；最多等待 ${d.approvalWaitMs}ms。harness 不发送 callback 或 RPC 审批答复。`;
      d.progress(`${report.approval.detail} ${report.approval.chatUrl}`); save();
      d.model.enqueue({ text: marker('APPROVAL_RESULT') });
      try {
        await wait('真实客户端审批后的命令完成', async () => {
          const t = (await thread(newTurn.threadId)).turns.find((t) => t.id === approvalTurn);
          return t?.items.find((i) => i.type === 'commandExecution' && i.status === 'completed' && i.exitCode === 0
            && String(i.aggregatedOutput).includes(marker('APPROVED_EXECUTION')));
        }, d.approvalWaitMs);
        report.approval.callback = await wait('真实飞书 callback 入站证据', () => d.callbackEvidence(newChat, String(approvalCard.message_id)));
        await terminal(newTurn.threadId, approvalTurn);
        await visible(newChat, marker('APPROVAL_RESULT'));
        report.approval.status = 'passed'; report.approval.detail = '真实客户端处理后，原生命令成功且最终消息已由用户回读。';
        check('native_approval_real_client_terminal');
      } catch (error) {
        report.approval.status = 'unverified'; report.approval.detail = String(error);
        const current = (await thread(newTurn.threadId)).turns.find((t) => t.id === approvalTurn);
        if (current?.status === 'inProgress') {
          await send(newChat, '/stop'); await terminal(newTurn.threadId, approvalTurn, 'interrupted');
        }
      }
    } else {
      report.approval.status = 'unverified';
      report.approval.detail = '自动部分已验证审批请求与卡片；未等待真实客户端点击，已通过真实 /stop 取消。群是否仍保留见 chatCleanup；默认结束后解散，补验收请重新运行并指定 --approval-wait-ms。';
      await send(newChat, '/stop'); await terminal(newTurn.threadId, approvalTurn, 'interrupted');
    }
    if (d.nativeRequestCards) {
      report.nativeCards = []; save();
      if (!d.approvalWaitMs || report.approval.status === 'passed') {
        await runNativeRequestCards({ driver: d, report, chatId: newChat, threadId: newTurn.threadId,
          wait, read, send, thread, terminal, visible, stage, check, save });
      }
    }
    for (const chat of report.chats) {
      const messages = userReadbackMessages(await read(chat));
      for (const input of report.inputs.filter((i) => i.chatId === chat)) {
        assert(messages.some((m) => m.message_id === input.messageId && m.sender?.sender_type === 'user'), `用户回读缺少真实用户输入 ${input.messageId}`);
      }
    }
    assert(report.activeClear, '缺少 active clear 证据');
    assertNoOldClearDelivery(report, d.chatId, d.botAppId, report.readbacks[d.chatId]);
    check('active_clear_no_old_delivery', { threadId: report.activeClear.threadId, turnId: report.activeClear.turnId });
    check('all_inputs_user_readback');
    assert.deepEqual(d.model.unexpected, [], '模型收到未编排调用');
    assert(d.model.requests.every((r) => [d.modelName, d.alternateModelName].includes(String(r.body.model))
      && ['low', 'high'].includes(String((r.body.reasoning as { effort?: string })?.effort))), '模型请求只能使用本次fixture的两种配置');
    check('fixture_model_only');
    report.automaticPassed = report.checks.every((c) => c.ok)
      && (!d.nativeRequestCards || report.nativeCards?.length === 4);
    if (!report.automaticPassed) throw new Error(`自动验收未通过：${report.checks.filter((c) => !c.ok).map((c) => c.name).join(', ') || '扩展卡片步骤未全部执行'}`);
    report.acceptanceComplete = report.automaticPassed && report.approval.status === 'passed'
      && (!d.nativeRequestCards || (report.nativeCards?.length === 4 && report.nativeCards.every((c) => c.status === 'passed')));
    stage('完成');
    return report;
  } catch (error) {
    report.error = error instanceof Error ? error.stack : String(error);
    report.checks.push({ name: report.stage, ok: false, detail: report.error });
    throw error;
  } finally { unsubscribe(); d.observer.close(); save(); }
}
