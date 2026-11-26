import '../../../setup/test-setup.js';
import { it } from 'node:test';
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
import { readCursorNativeUserPrompts } from '../../../../runtime/cursor/cli-store.js';
import { findCursorSessionFileById } from '../../../../runtime/cursor/session-index.js';
import { cursorTmuxSessionName } from '../../../../runtime/cursor/tmux-provider.js';
import { createConfigService } from '../../../../configuration/service.js';

const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
class IdleAdapter extends RecordingAdapter {
  live = true;
  events: Array<{ type: string; text: string; status?: string }> = [];
  reactions: string[] = [];
  onReaction?: (id: string) => void;
  isRunning() { return this.live; }
  consumeOne() { return this.consumeInboundMessage(this.live); }
  async stop() { this.live = false; this.rejectPendingInboundConsumers(); }
  supportsStructuredStreamingUi() { return true; }
  hasActiveStreamingUi() { return true; }
  onStreamText(_chat: string, text: string) { this.events.push({ type: 'text', text }); }
  async onStreamEnd(_chat: string, status: 'completed' | 'interrupted' | 'error', text: string) { this.events.push({ type: 'end', status, text }); return true; }
  async addMessageReaction(id: string) { this.onReaction?.(id); this.reactions.push(id); return id; }
}

for (const scenario of [{ redrawDelay: 0, delayedCheckpoint: false }, { redrawDelay: 1_200, delayedCheckpoint: false }, { redrawDelay: 0, delayedCheckpoint: true }, { redrawDelay: 0, delayedCheckpoint: false, plainMultiline: true }, { redrawDelay: 0, delayedCheckpoint: false, retainedDraft: true }, { redrawDelay: 1_200, delayedCheckpoint: true, oldTerminal: true }, { redrawDelay: 0, delayedCheckpoint: false, changeDirectory: true }]) it(`real Cursor confirms idle input after the editor acknowledges a delayed paste (redraw delay ${scenario.redrawDelay}ms, delayed checkpoint ${scenario.delayedCheckpoint}, plain multiline ${Boolean(scenario.plainMultiline)}, retained draft ${Boolean(scenario.retainedDraft)}, old terminal ${Boolean(scenario.oldTerminal)}, changed directory ${Boolean(scenario.changeDirectory)})`, { timeout: 75_000 }, async (t) => {
  const { redrawDelay, delayedCheckpoint } = scenario;
  const executable = process.env.CODELARK_REAL_CURSOR_E2E_EXECUTABLE || [
    path.join(process.env.CODELARK_TEST_ORIGINAL_HOME || os.homedir(), '.local/bin/agent'),
    ...(process.env.PATH || '').split(path.delimiter).map(dir => path.join(dir, 'agent')),
  ].find(candidate => fs.existsSync(candidate));
  if (!executable) { t.skip('real Cursor CLI is not installed'); return; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-cursor-idle-e2e-'));
  const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
  const initial = '<codelark_source>\n来源群聊："回归原群"\n来源 Bot："kasumi"\n</codelark_source>\n\n先分析当前实现', followup = scenario.plainMultiline ? '核验当前任务状态，\n汇报结果并继续监控。' : '<codelark_source>\n来源群聊："回归原群"\n</codelark_source>\n\n加一个 argmax 和 remask 开关，沿用原来的着色逻辑\n保留中文、多行和代码 `x < 2`，不要重复执行。';
  const third = '继续核验第三条消息，只处理这一次的新输入。';
  let releaseFinal!: () => void;
  const beforeFinish = new Promise<void>(resolve => { releaseFinal = resolve; });
  let releaseCheckpoint!: () => void;
  const beforeCheckpoint = new Promise<void>(resolve => { releaseCheckpoint = resolve; });
  const backend = await startFakeCursorBackend({
    call(prompt) {
      prompt = prompt.trim();
      assert.ok([initial, followup, third].includes(prompt.trim()));
      return { final: prompt === initial ? 'INITIAL_DONE' : prompt === third ? 'THIRD_DONE' : 'IDLE_DONE', ...(prompt === followup ? { beforeFinish, deferModelContext: true, ...(delayedCheckpoint ? { beforeCheckpoint } : {}) } : {}) };
    },
  });
  const wrapper = path.join(root, 'cursor'), tmux = path.join(root, 'tmux');
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${quote(executable)} ${backend.args.map(quote).join(' ')} "$@"\n`, { mode: 0o755 });
  // Replay the production boundary: Alt+Enter arrived as ESC/CR inside paste
  // input, corrupting the stored query. The real Cursor must receive all text
  // without relying on this editor shortcut between pasted lines.
  const newlineDuringPaste = redrawDelay === 0 ? `if [ "$1" = send-keys ] && [ "$4" = M-Enter ]; then
  printf '\\033\\r' | /usr/bin/tmux -S ${quote(path.join(root, 'tmux.sock'))} load-buffer -b regression-newline -
  exec /usr/bin/tmux -S ${quote(path.join(root, 'tmux.sock'))} paste-buffer -d -p -r -b regression-newline -t "$3"
fi\n` : '';
  fs.writeFileSync(tmux, `#!/bin/sh\nunset TMUX TMUX_PANE\n${newlineDuringPaste}exec /usr/bin/tmux -S ${quote(path.join(root, 'tmux.sock'))} "$@"\n`, { mode: 0o755 });
  const env = { CURSOR_CONFIG_DIR: path.join(root, 'config'), CURSOR_DATA_DIR: path.join(root, 'data'), CURSOR_AGENT_EXECUTABLE: wrapper, CODELARK_TMUX_EXECUTABLE: tmux, CODELARK_CURSOR_MODEL: 'regression-fake', CODELARK_CURSOR_FORCE: '1', CODELARK_CURSOR_TMUX_POLL_INTERVAL_MS: '100', CODELARK_CURSOR_TMUX_INPUT_READY_TIMEOUT_MS: undefined as string | undefined, CURSOR_API_KEY: undefined, CURSOR_AUTH_TOKEN: undefined };
  const old = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) { old.set(key, process.env[key]); if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  fs.mkdirSync(env.CURSOR_CONFIG_DIR); fs.mkdirSync(env.CURSOR_DATA_DIR);
  fs.writeFileSync(path.join(env.CURSOR_CONFIG_DIR, 'cli-config.json'), JSON.stringify({ version: 1, steering: true, approvalMode: 'unrestricted', ...(scenario.retainedDraft ? { display: { mode: 'zen', showThinkingBlocks: false, showStatusIndicators: false, showStatusLineRunningTime: false } } : {}) }));
  _testOnlyTmuxCore.reset(); resetBridgeTestState(); manager.resetStateForTests();
  const store = initBridgeTestContext({ dynamicSettings: true, llm: new CodexRoutingProvider() });
  const adapter = new IdleAdapter(); registerAdapter(adapter);
  adapter.onReaction = id => { if (id === 'steer') assert.equal(backend.prompts.length, 2, 'Get must not precede native acceptance of the idle input'); };
  const bridge = (globalThis as any).__bridge_manager__; bridge.running = true;
  const session = store.createSession('Cursor idle submission regression', 'regression-fake', undefined, workspace, 'normal', { activeRuntime: 'cursor' });
  const target = cursorTmuxSessionName(session.id), pane = `${target}:0.0`;
  store.updateSession(session.id, { runtime: { activeRuntime: 'cursor', cursor: { provider: 'tmux', transport: 'cli', force: true, model: 'regression-fake' }, general: { workingDirectory: workspace, tmuxSessionName: target } } });
  createConfigService({ migrate: false }).set({ kind: 'session', sessionId: session.id }, { runtime: { cursor: { provider: 'tmux' } } });
  const address = { channelType: 'feishu', chatId: 'fake-idle-chat' };
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
  const originalCapture = tmuxCore.capturePane, originalInject = tmuxCore.injectPromptIntoPane, originalSend = tmuxCore.sendActions;
  let staleUntil = 0, staleFrames = 0, pasteObserved = false, passed = false;
  // Keep the actual native draft while the renderer briefly reports its old
  // frame. The first Enter must wait for the new editor contents.
  const pasteDraft = async (target: string, text: string) => {
    pasteObserved = true;
    const result = await originalSend(target, [{ type: 'literal', text: scenario.plainMultiline ? '\n' + text : text }], { forcePasteLiterals: true });
    staleUntil = Date.now() + redrawDelay;
    return result;
  };
  tmuxCore.injectPromptIntoPane = async (target, prompt, options) => {
    if (target === pane && prompt === followup && !pasteObserved) {
      const result = await pasteDraft(target, prompt);
      await options?.beforeSubmit?.();
      await originalSend(target, [{ type: 'key', key: 'Enter' }]);
      return result;
    }
    return originalInject(target, prompt, options);
  };
  tmuxCore.sendActions = async (target, actions, options) => {
    if (target === pane && !pasteObserved && actions.some(action => action.type === 'literal' && action.text === followup)) return pasteDraft(target, followup);
    return originalSend(target, actions, options);
  };
  tmuxCore.capturePane = async (...args) => {
    const capture = await originalCapture(...args);
    if (args[0] === pane && Date.now() < staleUntil) {
      staleFrames++; return { ...capture, screen: 'INITIAL_DONE\n→ Add a follow-up\nGemini 4 Carbon High' };
    }
    return capture;
  };
  const until = async (check: () => boolean | Promise<boolean>, label: string) => {
    const end = Date.now() + 30_000;
    while (Date.now() < end && !await check() && !backend.errors.length) { await manager.reconcileMirrorSubscriptions(); await delay(100); }
    assert.ok(await check(), `${label}; errors=${JSON.stringify(backend.errors)}; sent=${JSON.stringify(adapter.sent)}`);
  };
  try {
    runtime.runAdapterLoop(adapter);
    adapter.enqueueManualInboundMessage(inboundMessage(address, initial, 'initial'));
    await until(() => finished.includes('initial'), 'first native turn must complete');
    await until(async () => {
      const { screen } = await originalCapture(pane, 80);
      return /→ Add a follow-up/.test(screen) && !/ctrl\+c to stop|Working/.test(screen);
    }, 'native editor must be idle');
    assert.ok(store.getSession(session.id)?.runtime?.cursor?.sessionId, 'second input must use the known native store');
    const initialNativeId = store.getSession(session.id)!.runtime!.cursor!.sessionId;
    if (scenario.changeDirectory) {
      const newWorkspace = path.join(root, 'new-workspace');
      fs.mkdirSync(newWorkspace);
      adapter.enqueueManualInboundMessage(inboundMessage(address, `/cd ${newWorkspace}`, 'change-directory'));
      await until(() => finished.includes('change-directory'), '/cd must finish before the next user input');
      assert.ok(adapter.sent.some(message => message.text.includes('已切换工作目录') && message.text.includes(newWorkspace)));
      assert.equal(store.getSession(session.id)?.runtime?.cursor?.sessionId, initialNativeId);
    }
    if (scenario.retainedDraft) {
      await originalSend(pane, [{ type: 'literal', text: initial }], { bracketedPaste: true });
      await until(async () => (await originalCapture(pane, 80)).screen.includes('先分析当前实现'), 'retained multiline draft must be visible');
    }
    if (delayedCheckpoint) process.env.CODELARK_CURSOR_TMUX_INPUT_READY_TIMEOUT_MS = '1000';
    adapter.enqueueManualInboundMessage(inboundMessage(address, followup, 'steer'));
    if (scenario.oldTerminal) {
      await until(() => pasteObserved, 'paste must be in flight');
      const task = bridge.activeTasks.get(session.id);
      assert.ok(task?.finalizeFromExternalTerminal);
      assert.equal(await task.finalizeFromExternalTerminal('completed', 'old turn finished', 'INITIAL_DONE'), false,
        'a previous native final must not acknowledge or finish the newly submitted input');
      assert.ok(!finished.includes('steer'));
    }
    await until(() => backend.prompts.length === 2, 'fake model must receive the idle input after the paste acknowledgement');
    if (delayedCheckpoint) {
      await delay(1_600);
      assert.ok(!finished.includes('steer'), 'delayed native checkpoint must not end the active card at the old receipt deadline');
      assert.ok(!adapter.reactions.includes('steer'), 'no receipt before the native checkpoint');
      const nativeId = store.getSession(session.id)!.runtime!.cursor!.sessionId!;
      const native = findCursorSessionFileById(nativeId, workspace)!;
      assert.ok(!readCursorNativeUserPrompts(native.storePath!)?.includes(followup), 'the entire native receipt must still be absent while the model already has the input');
      assert.deepEqual(backend.prompts.map(prompt => prompt.trim()), [initial, followup], 'slow checkpoint must not resubmit input');
      releaseCheckpoint();
    }
    await until(() => adapter.reactions.includes('steer'), 'Get must acknowledge persisted input before model context updates or the final answer');
    assert.ok(!finished.includes('steer'), 'model must still be running when receipt is confirmed');
    releaseFinal();
    await until(() => finished.includes('steer'), 'second native turn must finish');
    if (scenario.changeDirectory) assert.equal(store.getSession(session.id)?.runtime?.cursor?.sessionId, initialNativeId,
      'changing bridge cwd must preserve the native conversation identity');
    assert.deepEqual(backend.prompts.map(prompt => prompt.trim()), [initial, followup], 'retry must not duplicate either request');
    assert.equal(backend.steers.length, 0, 'an idle input starts a new turn');
    assert.ok(adapter.events.some(e => e.type === 'end' && e.status === 'completed' && e.text.includes('IDLE_DONE')));
    assert.ok(adapter.reactions.includes('steer'));
    assert.equal(adapter.events.filter(e => e.type === 'end').length, 2, 'only the initial and resumed cards may finish');
    assert.ok(adapter.events.filter(e => e.type === 'end').every(e => e.status === 'completed'));
    assert.ok(pasteObserved, 'test must observe the real native draft before submission');
    if (redrawDelay) assert.ok(staleFrames > 0, 'test must observe a stale empty editor before the draft becomes visible');
    if (scenario.retainedDraft) {
      await until(async () => /→ Add a follow-up/.test((await originalCapture(pane, 80)).screen), 'second turn must return to idle');
      await originalSend(pane, [{ type: 'literal', text: followup }], { bracketedPaste: true });
      adapter.enqueueManualInboundMessage(inboundMessage(address, third, 'third'));
      await until(() => finished.includes('third'), 'third native turn must finish independently');
      assert.deepEqual(backend.prompts.map(prompt => prompt.trim()), [initial, followup, third]);
      assert.equal(adapter.events.filter(e => e.type === 'end').length, 3);
    }
    assert.deepEqual(backend.errors, []); passed = true;
  } finally {
    releaseCheckpoint(); releaseFinal();
    tmuxCore.capturePane = originalCapture; tmuxCore.injectPromptIntoPane = originalInject; tmuxCore.sendActions = originalSend;
    if (!passed || process.env.CODELARK_REAL_CURSOR_E2E_KEEP_ARTIFACTS === '1') {
      fs.writeFileSync(path.join(root, 'evidence.json'), JSON.stringify({ prompts: backend.prompts, steers: backend.steers, errors: backend.errors, events: adapter.events, messages: adapter.sent, staleFrames, pasteObserved }, null, 2));
      fs.writeFileSync(path.join(root, 'screen.txt'), (await originalCapture(pane, 120).catch(() => ({ screen: '' }))).screen);
      console.error(`Cursor idle submission evidence: ${root}`);
    }
    state.running = false; bridge.running = false; await adapter.stop();
    await tmuxCore.killSession(target).catch(() => {}); await backend.close();
    await Promise.race([Promise.allSettled(jobs), delay(2000)]); manager.resetStateForTests();
    for (const [key, value] of old) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    _testOnlyTmuxCore.reset();
    if (passed && process.env.CODELARK_REAL_CURSOR_E2E_KEEP_ARTIFACTS !== '1') fs.rmSync(root, { recursive: true, force: true });
  }
});
