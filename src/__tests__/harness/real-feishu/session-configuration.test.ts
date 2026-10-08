import '../../setup/test-setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertAppliedSettings, assertActiveSettingsUnchanged, readOwnedTurnSettings, runActiveConfiguration, runMentionFilter,
  type NativeTurnSettings, type ConfigurationStoryContext } from '../../../testing/real-feishu/session-configuration.js';
import type { LifecycleDriver, LifecycleSession, LifecycleReport, NativeThread } from '../../../testing/real-feishu/app-server-lifecycle.js';

const session = (): LifecycleSession => ({ sessionId: 'session', threadId: 'thread', streamKeys: [], configuration: {
  'runtime.agent': 'codex', 'runtime.codex.model': 'gpt-5.4', 'runtime.codex.reasoningEffort': 'low',
  'runtime.codex.yoloMode': 'off', 'runtime.codex.sandboxMode': 'read-only', 'runtime.codex.networkAccess': false,
  'session.workspace': '/owned', 'session.requireMention': false,
} });
const native = (s: LifecycleSession, turn_id = 'turn'): NativeTurnSettings => ({ turn_id,
  model: String(s.configuration['runtime.codex.model']), effort: String(s.configuration['runtime.codex.reasoningEffort']),
  cwd: String(s.configuration['session.workspace']), approval_policy: s.configuration['runtime.codex.yoloMode'] === 'on' ? 'never' : 'on-request',
  sandbox_policy: s.configuration['runtime.codex.yoloMode'] === 'on' ? { type: 'danger-full-access' }
    : { type: String(s.configuration['runtime.codex.sandboxMode']), network_access: Boolean(s.configuration['runtime.codex.networkAccess']) },
});

test('原生应用证据同时验证模型请求、turn配置和YOLO权限，拒绝只保存未应用', () => {
  const s = session(); const context = native(s); const request = { model: 'gpt-5.4', reasoning: { effort: 'low' } };
  assertAppliedSettings(s, context, request);
  for (const wrong of [ { ...context, model: 'wrong' }, { ...context, effort: 'high' }, { ...context, cwd: '/wrong' },
    { ...context, approval_policy: 'never' }, { ...context, sandbox_policy: { type: 'danger-full-access' } } ]) {
    assert.throws(() => assertAppliedSettings(s, wrong, request));
  }
  assert.throws(() => assertAppliedSettings(s, context, { ...request, model: 'wrong' }));
  assert.throws(() => assertAppliedSettings(s, context, { ...request, reasoning: { effort: 'high' } }));
  s.configuration['runtime.codex.yoloMode'] = 'on';
  assertAppliedSettings(s, native(s), request);
  assert.throws(() => assertAppliedSettings(s, context, request));
  s.configuration['runtime.codex.yoloMode'] = 'off'; s.configuration['runtime.codex.sandboxMode'] = 'workspace-write';
  assert.throws(() => assertAppliedSettings(s, { ...native(s), sandbox_policy: { type: 'workspace-write', network_access: true } }, request));
});

test('原生turn_context读取只接受指定thread/turn，忽略未完成末行和其他线程', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codelark-turn-context-'));
  try {
    const dir = path.join(root, 'sessions/2026/10/08'); fs.mkdirSync(dir, { recursive: true });
    const line = (turn: string) => JSON.stringify({ type: 'turn_context', payload: native(session(), turn) });
    fs.writeFileSync(path.join(dir, 'rollout-thread.jsonl'), line('old')+'\n'+line('turn')+'\n{"type":');
    fs.writeFileSync(path.join(dir, 'rollout-other.jsonl'), line('alien'));
    assert.deepEqual(readOwnedTurnSettings(root, 'thread', 'turn'), native(session()));
    assert.equal(readOwnedTurnSettings(root, 'thread', 'alien'), undefined);
    assert.equal(readOwnedTurnSettings(root, 'absent', 'turn'), undefined);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

function storyFixture(fault?: 'interrupt' | 'request' | 'rebind' | 'rewrite-context') {
  let current = session(); let active = false; let captured = native(current); let turn = 'turn-0';
  const requestBodies: LifecycleDriver['model']['requests'] = [];
  const turns: NativeThread = { id: 'thread', turns: [] };
  const commands: string[] = []; const completions: LifecycleSession[] = [];
  const report = { configurationChanges: [], checks: [] } as unknown as LifecycleReport;
  const driver = { chatId: 'chat', runId: 'owned', modelName: 'gpt-5.4', alternateModelName: 'gpt-5.5', configurationWorkspace: '/owned/next',
    state: () => structuredClone(current), turnSettings: () => structuredClone(captured),
    model: { requests: requestBodies, unexpected: [], enqueue() { return { release() { active = false; if (turns.turns.at(-1)) turns.turns.at(-1)!.status = 'completed'; } }; } },
  } as unknown as LifecycleDriver;
  const c: ConfigurationStoryContext = { driver, report,
    async wait(label, read) { const value = await read(); if (value === undefined || value === false) throw new Error(label); return value; },
    async state() { return structuredClone(current); }, async thread() { return structuredClone(turns); },
    async read() { return { ok: true, identity: 'user', data: { messages: [] } }; },
    async visible() {}, check(name) { report.checks.push({ name, ok: true }); }, save() {},
    async send(_chat, text) {
      active = true; turn = `turn-${turns.turns.length}`; captured = native(current, turn);
      requestBodies.push({ method: 'POST', url: '/v1/responses', body: { model: captured.model, reasoning: { effort: captured.effort }, input: [{ text }] } });
      turns.turns.push({ id: turn, status: 'inProgress', items: [{ type: 'userMessage', text }] }); return 'input';
    },
    async command(_chat, text) {
      commands.push(text);
      const [cmd, value] = text.split(' ');
      const fields: Record<string, string> = { '/model': 'runtime.codex.model', '/reasoning': 'runtime.codex.reasoningEffort', '/cd': 'session.workspace', '/sandbox': 'runtime.codex.sandboxMode' };
      if (fields[cmd]) current.configuration[fields[cmd]] = value;
      if (cmd === '/yolo' && value !== 'status') current.configuration['runtime.codex.yoloMode'] = value;
      if (cmd === '/network') current.configuration['runtime.codex.networkAccess'] = value === 'on';
      if (cmd === '/require_at' || cmd === '/require-at') current.configuration['session.requireMention'] = value === 'on';
      if (active && fault === 'interrupt') turns.turns.at(-1)!.status = 'interrupted';
      if (active && fault === 'request') requestBodies.push(requestBodies[0]);
      if (active && fault === 'rebind') current = { ...current, sessionId: 'wrong' };
      if (active && fault === 'rewrite-context') captured = native(current, turn);
      return 'command';
    },
    async completedPrompt() {
      assert.equal(active, false); completions.push(structuredClone(current));
      return { threadId: 'thread', turnId: 'next', response: 'done' };
    },
  };
  return { c, commands, completions, active: () => active };
}

test('配置故事在持有原轮次时发命令，正常/YOLO往返后保留非默认配置用于继承', async () => {
  const f = storyFixture(); await runActiveConfiguration(f.c);
  assert.equal(f.completions.length, 3);
  assert.equal(f.completions[0].configuration['runtime.codex.model'], 'gpt-5.5');
  assert.equal(f.completions[0].configuration['runtime.codex.yoloMode'], 'on');
  assert.equal(f.completions[1].configuration['runtime.codex.model'], 'gpt-5.4');
  assert.equal(f.completions[1].configuration['runtime.codex.yoloMode'], 'off');
  assert.equal(f.completions[2].configuration['session.requireMention'], false);
  assert(!f.commands.some((cmd) => cmd === '/stop' || cmd.startsWith('/runtime ')));
  assert.equal(f.c.report.configurationChanges?.length, 2);
});

test('配置故事拒绝活动轮次被结束、额外请求、改绑或原生配置被改写，失败释放模型等待', async () => {
  for (const fault of ['interrupt', 'request', 'rebind', 'rewrite-context'] as const) {
    const f = storyFixture(fault); await assert.rejects(runActiveConfiguration(f.c)); assert.equal(f.active(), false);
  }
});

test('mention负例必须有真实入站过滤记录，拒绝额外模型请求及bot回复', async () => {
  for (const fault of [undefined, 'no-audit', 'request', 'reply'] as const) {
    const f = storyFixture(); f.c.driver.botAppId = 'app';
    f.c.state = async () => ({ ...session(), configuration: { ...session().configuration, 'session.requireMention': true } });
    f.c.send = async (_chat, _text, mention) => { assert.equal(mention, false); if (fault === 'request') f.c.driver.model.requests.push({ method: 'POST', url: '/', body: {} }); return 'filtered-id'; };
    f.c.driver.filteredMessage = () => fault === 'no-audit' ? undefined : { messageId: 'filtered-id' };
    f.c.read = async () => ({ ok: true, identity: 'user', data: { messages: fault === 'reply' ? [{ sender: { sender_type: 'app', id: 'app' }, reply_to: 'filtered-id' }] : [] } });
    if (fault) await assert.rejects(runMentionFilter(f.c, 'chat', 'test'));
    else await runMentionFilter(f.c, 'chat', 'test');
  }
});
