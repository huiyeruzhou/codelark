import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { LifecycleDriver, LifecycleReport, LifecycleSession, NativeThread, ModelBody } from './app-server-lifecycle.js';

export interface NativeTurnSettings {
  turn_id: string; model: string; effort: string; cwd: string;
  approval_policy: string; sandbox_policy: { type: string; network_access?: boolean };
}

/** 只读取此次隔离 CODEX_HOME 的原生日志，按 thread 文件和 turn_id 双重关联。 */
export function readOwnedTurnSettings(codexHome: string, threadId: string, turnId: string): NativeTurnSettings | undefined {
  const root = path.join(codexHome, 'sessions');
  const files = (directory: string): string[] => fs.existsSync(directory)
    ? fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
      ? files(path.join(directory, entry.name)) : entry.isFile() && entry.name.endsWith(`${threadId}.jsonl`) ? [path.join(directory, entry.name)] : []) : [];
  for (const file of files(root)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n').reverse()) {
      try {
        const item = JSON.parse(line);
        if (item.type === 'turn_context' && item.payload?.turn_id === turnId) {
          const p = item.payload;
          return { turn_id: p.turn_id, model: p.model, effort: p.effort, cwd: p.cwd,
            approval_policy: p.approval_policy, sandbox_policy: p.sandbox_policy };
        }
      } catch { /* 允许末行尚未完整写入；不把其他 turn 当作本轮证据。 */ }
    }
  }
  return undefined;
}

export function assertAppliedSettings(session: LifecycleSession, context: NativeTurnSettings, request: ModelBody): void {
  const config = session.configuration;
  const model = config['runtime.codex.model'];
  const effort = config['runtime.codex.reasoningEffort'];
  const yolo = ['on', 'yolo'].includes(String(config['runtime.codex.yoloMode']));
  assert.equal(context.model, model, '原生轮次必须使用已保存模型');
  assert.equal(request.model, model, '模型请求必须使用已保存模型');
  assert.equal(context.effort, effort, '原生轮次必须使用已保存思考级别');
  assert.equal((request.reasoning as { effort?: string })?.effort, effort, '模型请求必须使用已保存思考级别');
  assert.equal(context.cwd, config['session.workspace'], '原生轮次必须使用已保存目录');
  assert.equal(context.approval_policy, yolo ? 'never' : 'on-request', 'YOLO/正常审批策略未应用');
  assert.equal(context.sandbox_policy.type, yolo ? 'danger-full-access' : config['runtime.codex.sandboxMode'], '原生沙箱未应用');
  if (!yolo && context.sandbox_policy.type === 'workspace-write') {
    assert.equal(context.sandbox_policy.network_access, config['runtime.codex.networkAccess'], '原生网络设置未应用');
  }
}

export function assertActiveSettingsUnchanged(before: LifecycleSession, current: LifecycleSession, turnId: string, thread: NativeThread,
  beforeContext: NativeTurnSettings, currentContext: NativeTurnSettings, beforeRequests: number, afterRequests: number): void {
  assert.equal(current.sessionId, before.sessionId, '活动轮次配置不能改绑 session');
  assert.equal(current.threadId, before.threadId, '活动轮次配置不能切换 thread');
  assert.equal(thread.turns.find((t) => t.id === turnId)?.status, 'inProgress', '配置命令不能结束活动轮次');
  assert.deepEqual(currentContext, beforeContext, '活动轮次仍应使用提交时的配置');
  assert.equal(afterRequests, beforeRequests, '配置命令不能触发额外模型请求');
}

export interface ConfigurationStoryContext {
  driver: LifecycleDriver; report: LifecycleReport;
  wait<T>(label: string, read: () => T | undefined | false | Promise<T | undefined | false>): Promise<T>;
  command(chat: string, text: string, expected: string): Promise<string>;
  send(chat: string, text: string, mention?: boolean): Promise<string>;
  read(chat: string): Promise<unknown>;
  state(chat: string): Promise<LifecycleSession>;
  thread(id: string): Promise<NativeThread>;
  completedPrompt(chat: string, name: string): Promise<{ threadId: string; turnId: string; response: string }>;
  visible(chat: string, marker: string): Promise<unknown>;
  check(name: string, detail?: unknown): void;
  save(): void;
}

export async function runActiveConfiguration(c: ConfigurationStoryContext): Promise<void> {
  const { driver: d, report } = c;
  const original = await c.state(d.chatId);
  await c.command(d.chatId, '/current-runtime kimi', 'runtime.kimi');
  assert.equal((await c.state(d.chatId)).sessionId, original.sessionId, '只查看分栏不能切换会话');
  assert.equal((await c.state(d.chatId)).configuration['runtime.agent'], 'codex');
  await c.command(d.chatId, '/current-runtime common', 'require_mention');
  await c.command(d.chatId, '/current-runtime codex', 'runtime.codex');
  c.check('current_section_preserves_agent_and_binding');

  const heldChange = async (name: string, commands: Array<[string, string]>) => {
    const before = await c.state(d.chatId);
    assert(before.threadId);
    const offset = d.model.requests.length;
    const input = `LIFECYCLE_${name}_INPUT_${d.runId}`;
    const result = `LIFECYCLE_${name}_RESULT_${d.runId}`;
    const held = d.model.enqueue({ text: result }, true);
    try {
      await c.send(d.chatId, input);
      await c.wait('活动配置故事的模型请求', () => d.model.requests.length > offset);
      const active = await c.wait('活动配置故事的原生 turn', async () => (await c.thread(before.threadId!)).turns.find((t) =>
        t.status === 'inProgress' && t.items.some((i) => i.type === 'userMessage' && JSON.stringify(i).includes(input))));
      const nativeBefore = await c.wait('活动轮次的原生配置', () => d.turnSettings(before.threadId!, active.id));
      assertAppliedSettings(before, nativeBefore, d.model.requests[offset].body);
      for (const [text, expected] of commands) await c.command(d.chatId, text, expected);
      const nativeAfter = d.turnSettings(before.threadId, active.id);
      assert(nativeAfter);
      assertActiveSettingsUnchanged(before, await c.state(d.chatId), active.id, await c.thread(before.threadId),
        nativeBefore, nativeAfter, offset + 1, d.model.requests.length);
      const commandsInTurn = (await c.thread(before.threadId)).turns.find((t) => t.id === active.id)!.items
        .filter((i) => i.type === 'userMessage');
      assert.equal(commandsInTurn.length, 1, '配置命令不能追加到模型活动轮次');
      report.configurationChanges ??= [];
      report.configurationChanges.push({ name, before, saved: await c.state(d.chatId), nativeBefore, nativeAfter, turnId: active.id }); c.save();
      held.release();
      await c.visible(d.chatId, result);
      await c.wait('配置故事旧轮次正常结束', async () => (await c.thread(before.threadId!)).turns.find((t) => t.id === active.id && t.status === 'completed'));
      c.check(`active_configuration_${name.toLowerCase()}`, { turnId: active.id, nativeBefore, nativeAfter });
    } finally { held.release(); }
  };
  await heldChange('TO_YOLO', [
    [`/model ${d.alternateModelName}`, d.alternateModelName], ['/reasoning high', 'high'],
    [`/cd ${d.configurationWorkspace}`, d.configurationWorkspace], ['/sandbox workspace-write', 'workspace-write'],
    ['/network on', '网络'], ['/yolo on', 'yolo'], ['/yolo status', 'yolo'], ['/require_at on', '当前会话'],
  ]);
  await c.completedPrompt(d.chatId, 'CONFIG_YOLO');
  c.check('next_turn_applies_model_reasoning_cwd_and_yolo');
  await heldChange('TO_NORMAL', [
    ['/yolo off', 'normal'], ['/yolo status', 'normal'], [`/model ${d.modelName}`, d.modelName],
    ['/reasoning low', 'low'], ['/network off', '网络'],
  ]);
  await c.completedPrompt(d.chatId, 'CONFIG_NORMAL');
  c.check('next_turn_restores_normal_permissions_and_network');
  await c.command(d.chatId, '/require-at off', 'off');
  await c.completedPrompt(d.chatId, 'MENTION_OFF');
  c.check('require_at_off_accepts_plain_input');
  // 用非默认配置和 on 验证 clear/new，后续审批故事再通过真实命令恢复正常模式。
  await c.command(d.chatId, '/require_at on', 'on');
  await c.command(d.chatId, '/yolo on', 'yolo');
  await c.command(d.chatId, `/model ${d.alternateModelName}`, d.alternateModelName);
  await c.command(d.chatId, '/reasoning high', 'high');
}

/** 必须先看到匹配 messageId 的实际过滤记录，再验证没有执行；仅无回复不算通过。 */
export async function runMentionFilter(c: ConfigurationStoryContext, chatId: string, label: string): Promise<void> {
  const d = c.driver;
  const before = await c.state(chatId);
  assert.equal(before.configuration['session.requireMention'], true);
  assert(before.threadId);
  const offset = d.model.requests.length;
  const text = `LIFECYCLE_FILTERED_${label}_${d.runId}`;
  const messageId = await c.send(chatId, text, false);
  const audit = await c.wait('真实入站消息被 require-at 过滤', () => d.filteredMessage(chatId, messageId));
  const payload = await c.read(chatId) as any;
  assert.equal(payload.identity, 'user'); assert.equal(payload.ok, true);
  assert.equal(d.model.requests.length, offset, '未提及机器人消息不能调用模型');
  assert(!(await c.thread(before.threadId)).turns.some((t) => t.items.some((i) => i.type === 'userMessage' && JSON.stringify(i).includes(text))), '过滤输入不能进入原生线程');
  assert(!payload.data.messages.some((m: any) => m.sender?.sender_type === 'app' && m.sender.id === d.botAppId && m.reply_to === messageId), '过滤输入不应收到 bot 回复');
  c.check(`require_at_filters_${label}`, { chatId, messageId, audit });
}
