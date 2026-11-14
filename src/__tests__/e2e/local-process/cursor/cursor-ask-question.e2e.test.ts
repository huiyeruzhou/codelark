import '../../../setup/test-setup.js';
import { it } from 'node:test';
import { WebSocketServer } from 'ws';
import { closeCodexAppServerSessions } from '../../../../runtime/codex/app-server-registry.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startFakeCursorBackend } from '../../../helpers/runtime/cursor-fake-backend.js';
import { initBridgeTestContext, RecordingAdapter, inboundMessage, resetBridgeTestState } from '../../../helpers/bridge/test-bridge-utils.js';
import { _testOnly as manager, registerAdapter } from '../../../../bridge/host/manager.js';
import { createAdapterRuntime } from '../../../../channels/adapter-runtime/runtime.js';
import { CodexRoutingProvider } from '../../../../runtime/codex/routing-provider.js';
import { tmuxCore, _testOnlyTmuxCore } from '../../../../runtime/tmux/core.js';
import { cursorTmuxSessionName } from '../../../../runtime/cursor/tmux-provider.js';
import { readCursorPendingQuestion, readCursorNativeMessages } from '../../../../runtime/cursor/cli-store.js';
import { findCursorSessionFileById } from '../../../../runtime/cursor/session-index.js';
import { clearCursorQuestions, handleCursorQuestionCallback, hasCursorQuestion } from '../../../../bridge/permission/cursor-questions.js';
import { computeBaseDiagnosis } from '../../../../bridge/health/reducer.js';

const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
class QuestionAdapter extends RecordingAdapter {
  live = true;
  events: Array<{ type: string; text: string; status?: string }> = [];
  reactions: string[] = [];
  isRunning() { return this.live; }
  consumeOne() { return this.consumeInboundMessage(this.live); }
  async stop() { this.live = false; this.rejectPendingInboundConsumers(); }
  supportsStructuredStreamingUi() { return true; }
  hasActiveStreamingUi() { return true; }
  onStreamStatus(_chat: string, text: string) { this.events.push({ type: 'status', text }); }
  onStreamText(_chat: string, text: string) { this.events.push({ type: 'text', text }); }
  async onStreamEnd(_chat: string, status: 'completed' | 'interrupted' | 'error', text: string) { this.events.push({ type: 'end', status, text }); return true; }
  async addMessageReaction(id: string) { this.reactions.push(id); return id; }
}

for (const scenario of ['single choice', 'multiple choices', 'existing Other text']) it(`real Cursor calls AskQuestion (${scenario}), accepts chat answers and resumes the same turn`, { timeout: 100_000 }, async (t) => {
  const multiple = scenario !== 'single choice', existingOther = scenario === 'existing Other text';
  const executable = process.env.CODELARK_REAL_CURSOR_E2E_EXECUTABLE || [
    path.join(process.env.CODELARK_TEST_ORIGINAL_HOME || os.homedir(), '.local/bin/agent'),
    ...(process.env.PATH || '').split(path.delimiter).map(dir => path.join(dir, 'agent')),
  ].find(candidate => fs.existsSync(candidate));
  if (!executable || !fs.existsSync(executable)) { t.skip('real Cursor CLI is not installed; no account or real model is required'); return; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-cursor-question-e2e-'));
  const workDir = path.join(root, 'workspace'); fs.mkdirSync(workDir);
  const request = { toolCallId: 'fake-question-tool', title: '回归实验参数', questions: [
    { id: 'temperature', allowMultiple: multiple, prompt: '选择温度', options: [{ id: 'low', label: '低温' }, { id: 'high', label: '高温' }] },
    { id: 'tag', prompt: '输入实验标签', options: [{ id: 'alpha', label: 'Alpha' }, { id: 'beta', label: 'Beta' }] },
  ] };
  const backend = await startFakeCursorBackend({
    call(prompt) { assert.equal(prompt, '请询问实验参数'); return request; },
    continue(answers) {
      assert.deepEqual(answers, [{ questionId: 'temperature', selectedOptionIds: existingOther ? [] : multiple ? ['low', 'high'] : ['high'], freeformText: existingOther ? 'replacement-text' : '' }, { questionId: 'tag', selectedOptionIds: [], freeformText: 'sample-中文-42' }]);
      return 'REGRESSION_DONE：已按回答继续原任务';
    },
  });
  const wrapper = path.join(root, 'cursor'), tmux = path.join(root, 'tmux');
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${quote(executable)} ${backend.args.map(quote).join(' ')} "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(tmux, `#!/bin/sh\nunset TMUX TMUX_PANE\nexec /usr/bin/tmux -S ${quote(path.join(root, 'tmux.sock'))} "$@"\n`, { mode: 0o755 });
  const env = { CURSOR_CONFIG_DIR: path.join(root, 'config'), CURSOR_DATA_DIR: path.join(root, 'data'), CURSOR_AGENT_EXECUTABLE: wrapper, CODELARK_TMUX_EXECUTABLE: tmux, CODELARK_DEBUG: '1', CODELARK_CURSOR_MODEL: 'regression-fake', CODELARK_CURSOR_FORCE: '1', CODELARK_CURSOR_TMUX_POLL_INTERVAL_MS: '100', CODELARK_CURSOR_TMUX_SESSION_FILE_TIMEOUT_MS: '30000', CURSOR_API_KEY: undefined, CURSOR_AUTH_TOKEN: undefined };
  const old = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) { old.set(key, process.env[key]); if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  fs.mkdirSync(env.CURSOR_CONFIG_DIR); fs.mkdirSync(env.CURSOR_DATA_DIR);
  fs.writeFileSync(path.join(env.CURSOR_CONFIG_DIR, 'cli-config.json'), JSON.stringify({ steering: true, approvalMode: 'unrestricted' }));
  _testOnlyTmuxCore.reset();
  resetBridgeTestState(); manager.resetStateForTests();
  const store = initBridgeTestContext({ dynamicSettings: true, llm: new CodexRoutingProvider() });
  const adapter = new QuestionAdapter(); registerAdapter(adapter);
  const bridgeState = (globalThis as any).__bridge_manager__; bridgeState.running = true;
  const blockingRequests: string[] = [];
  let blockedCodex: WebSocketServer | undefined;
  if (!multiple) {
    blockedCodex = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>(r => blockedCodex!.once('listening', r));
    blockedCodex.on('connection', socket => socket.on('message', data => {
      const request = JSON.parse(String(data)); blockingRequests.push(request.method);
      if (request.id === undefined || request.method === 'thread/resume') return;
      const result = request.method === 'thread/loaded/list' ? { data: [] }
        : request.method === 'initialize' ? { codexHome: process.env.CODEX_HOME }
        : request.method === 'config/read' ? { config: { cli_auth_credentials_store: 'ephemeral' } } : {};
      socket.send(JSON.stringify({ id: request.id, result }));
    }));
    const other = store.createSession('unrelated Codex resume stays pending', 'fake', undefined, workDir);
    store.updateSession(other.id, { runtime: { activeRuntime: 'codex', codex: { threadId: 'blocked-thread', appServerEndpoint: `ws://127.0.0.1:${(blockedCodex.address() as { port: number }).port}` } } });
    store.upsertChannelChat({ channelType: 'feishu', chatId: 'unrelated-blocked-codex', bridgeSessionId: other.id });
  }
  const session = store.createSession('fake Cursor questions', 'regression-fake', undefined, workDir, 'normal', { activeRuntime: 'cursor' });
  const target = cursorTmuxSessionName(session.id);
  store.updateSession(session.id, { runtime: { activeRuntime: 'cursor', cursor: { provider: 'tmux', transport: 'cli', force: true, model: 'regression-fake' }, general: { workingDirectory: workDir, tmuxSessionName: target } } });
  const address = { channelType: 'feishu', chatId: 'fake-question-chat' };
  store.upsertChannelChat({ ...address, bridgeSessionId: session.id, chatKind: 'group' });
  const state = { adapters: new Map(), adapterMeta: new Map(), invalidAdapters: new Map(), loopAborts: new Map(), running: true };
  const jobs: Promise<void>[] = [], finished: string[] = [];
  const runtime = createAdapterRuntime(() => state, {
    notifyAdapterSetChanged: () => {},
    handleMessage: async (a, msg) => { const job = manager.handleMessageWithoutDeliveryWait(a, msg); jobs.push(job); await job; finished.push(msg.messageId); },
    processWithSessionLock: async (_id, fn) => fn(),
    isCommandMessage: msg => manager.isBridgeCommandText(msg.text), shouldBypassSessionLock: manager.shouldBypassSessionLock,
    getImmediateLane: manager.adapterImmediateLane, getSessionLane: manager.adapterSessionLane, resolveSessionIdForMessage: () => session.id,
  });
  const reconciles = new Set<Promise<void>>();
  const reconcile = () => {
    const job = manager.reconcileMirrorSubscriptions().catch(() => {});
    reconciles.add(job); void job.finally(() => reconciles.delete(job));
  };
  const until = async (check: () => boolean, label: string, ms = 30_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (check()) return; if (backend.errors.length) break; reconcile(); await delay(100); }
    assert.ok(check(), `${label}; backend=${JSON.stringify(backend.errors)}; messages=${JSON.stringify(adapter.sent)}; events=${JSON.stringify(adapter.events.slice(-4))}`);
  };
  const cards = () => adapter.sent.filter(m => m.richCard?.title === 'Cursor 等待你的回答');
  let passed = false;
  try {
    runtime.runAdapterLoop(adapter);
    adapter.enqueueManualInboundMessage(inboundMessage(address, '请询问实验参数', 'start'));
    await until(() => cards().length === 1, 'native question must reach chat');
    if (blockedCodex) assert.ok(blockingRequests.includes('thread/resume'), 'another runtime resume must remain pending during Cursor question delivery');
    assert.ok(!finished.includes('start'), 'the original turn remains open while awaiting answers');
    assert.equal(backend.prompts.length, 1);
    const summary = findCursorSessionFileById(backend.nativeSessionId, workDir)!;
    assert.ok(summary.storePath); assert.equal(readCursorPendingQuestion(summary.storePath)?.toolCallId, request.toolCallId);
    store.updateSession(session.id, { last_progress_at: new Date(Date.now() - 38 * 60_000).toISOString() });
    assert.equal(computeBaseDiagnosis(store.getSession(session.id)!, Date.now()).healthStatus, 'waiting_input');
    const first = cards()[0]!;
    if (multiple) {
      assert.deepEqual(first.richCard!.actions, []);
      if (existingOther) await tmuxCore.sendActions(`${target}:0.0`, [{ type: 'key', key: 'Down' }, { type: 'key', key: 'Down' }, { type: 'literal', text: 'discard-old-answer' }, { type: 'key', key: 'C-a' }], { delayMs: 35, forcePasteLiterals: true });
      adapter.enqueueManualInboundMessage(inboundMessage(address, '1,2', 'answer-one'));
      if (existingOther) {
        await until(() => adapter.sent.some(m => m.text.includes('已有其他文字回答')), 'ambiguous pre-existing Other answer must fail closed');
        assert.equal(backend.answers.length, 0);
        assert.equal(cards().length, 1);
        adapter.enqueueManualInboundMessage(inboundMessage(address, 'replacement-text', 'replace-existing-answer'));
      }
    } else {
      const callbackData = first.richCard!.actions![0]![1]!.callbackData!;
      const firstId = `reply-${adapter.sent.indexOf(first) + 1}`;
      const callback = { ...inboundMessage(address, '', 'stale-answer'), callbackData, callbackMessageId: firstId };
      assert.match((await handleCursorQuestionCallback({ ...callback, address: { ...address, chatId: 'wrong-chat' } }, store))!, /失效/);
      const saved = store.getSession(session.id)!.runtime!;
      store.updateSession(session.id, { runtime: { cursor: { sessionId: 'replaced-native-session' } } });
      assert.match((await handleCursorQuestionCallback(callback, store))!, /会话已改变/);
      store.updateSession(session.id, { runtime: saved });
      assert.equal(backend.answers.length, 0);
      adapter.enqueueManualInboundMessage({ ...inboundMessage(address, '', 'answer-one'), callbackData, callbackMessageId: firstId });
      await until(() => cards().length === 2, 'first answer must reveal second native question');
      adapter.enqueueManualInboundMessage({ ...inboundMessage(address, '', 'duplicate-one'), callbackData, callbackMessageId: firstId });
      await until(() => finished.includes('duplicate-one'), 'duplicate callback handled');
      assert.equal(backend.answers.length, 0, 'duplicate must not answer the second question');
    }
    await until(() => cards().length === 2, 'first answer must reveal second native question');
    // Simulate bridge observer restart with the same native pending question.
    clearCursorQuestions(); await until(() => hasCursorQuestion(session.id), 'native question observation must recover independently');
    assert.equal(cards().length, 2, 'restart must reuse the unresolved question card');
    adapter.enqueueManualInboundMessage(inboundMessage(address, 'sample-中文-42', 'answer-two'));
    await until(() => backend.answers.length === 1, 'native AskQuestion tool result must reach fake model');
    await until(() => finished.includes('start'), 'same turn must finish');
    assert.equal(backend.prompts.length, 1, 'no new prompt, no restart, no extra model turn');
    assert.equal(readCursorPendingQuestion(summary.storePath!), null);
    assert.ok(readCursorNativeMessages(summary.storePath!)?.some(m => m.role === 'tool'));
    assert.equal(store.getSession(session.id)?.pending_user_input, undefined);
    assert.ok(adapter.events.some(e => e.type === 'end' && e.status === 'completed' && e.text.includes('REGRESSION_DONE')));
    await until(() => finished.includes('answer-two') && adapter.sent.some(m => m.text.includes('完整回答')), 'native answer acknowledgement must be delivered');
    assert.deepEqual(backend.errors, []);
    passed = true;
  } finally {
    if (!passed || process.env.CODELARK_REAL_CURSOR_E2E_KEEP_ARTIFACTS === '1') {
      fs.writeFileSync(path.join(root, 'evidence.json'), JSON.stringify({ prompts: backend.prompts, answers: backend.answers, errors: backend.errors, messages: adapter.sent, events: adapter.events }, null, 2));
      fs.writeFileSync(path.join(root, 'screen.txt'), (await tmuxCore.capturePane(`${target}:0.0`, 120).catch(() => ({ screen: '' }))).screen);
      console.error(`Cursor question evidence: ${root}`);
    }
    state.running = false; bridgeState.running = false; await adapter.stop();
    await tmuxCore.killSession(target).catch(() => {}); await backend.close();
    await closeCodexAppServerSessions();
    if (blockedCodex) { for (const client of blockedCodex.clients) client.terminate(); await new Promise<void>(r => blockedCodex!.close(() => r())); }
    await Promise.race([Promise.allSettled(reconciles), delay(2000)]);
    await Promise.race([Promise.allSettled(jobs), delay(2000)]);
    manager.resetStateForTests(); clearCursorQuestions();
    for (const [key, value] of old) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    _testOnlyTmuxCore.reset();
    if (passed && process.env.CODELARK_REAL_CURSOR_E2E_KEEP_ARTIFACTS !== '1') fs.rmSync(root, { recursive: true, force: true });
  }
});
