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
import { cursorTmuxSessionName } from '../../../../runtime/cursor/tmux-provider.js';

import type { StreamingHistoryItem } from '../../../../domain/index.js';

const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
class SteerAdapter extends RecordingAdapter {
  live = true;
  events: Array<{ type: string; text: string; status?: string }> = [];
  reactions: string[] = [];
  histories = new Map<string, StreamingHistoryItem[]>();
  onStreamHistory(_chat: string, items: StreamingHistoryItem[], key?: string) { this.histories.set(key || _chat, structuredClone(items)); }
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

for (const scenario of [
  { name: 'immediate safe footer', redrawDelay: 0, interruptOnlyFrames: 0 },
  { name: 'stale redraw before queue', redrawDelay: 1_200, interruptOnlyFrames: 0 },
  { name: 'interrupt-only footer before safe steer', redrawDelay: 0, interruptOnlyFrames: 4 },
  { name: 'queued input with retained editor text', redrawDelay: 0, interruptOnlyFrames: 0, retainedDraft: true },
  { name: 'long-running turn after a follow-up receipt', redrawDelay: 0, interruptOnlyFrames: 0, count: 2, longTurn: true },
  { name: 'two rapid follow-ups', redrawDelay: 0, interruptOnlyFrames: 0, count: 2 },
  { name: 'three rapid identical follow-ups', redrawDelay: 0, interruptOnlyFrames: 0, count: 3 },
  { name: 'delayed earlier input checkpoint', redrawDelay: 0, interruptOnlyFrames: 0, delayedReceipt: true, count: 2 },
]) it(`real Cursor steers into the active fake model run (${scenario.name})`, { timeout: 75_000 }, async (t) => {
  const executable = process.env.CODELARK_REAL_CURSOR_E2E_EXECUTABLE || [
    path.join(process.env.CODELARK_TEST_ORIGINAL_HOME || os.homedir(), '.local/bin/agent'),
    ...(process.env.PATH || '').split(path.delimiter).map(dir => path.join(dir, 'agent')),
  ].find(candidate => fs.existsSync(candidate));
  if (!executable) { t.skip('real Cursor CLI is not installed'); return; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-cursor-steer-e2e-'));
  const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
  const initial = '先分析当前实现', followup = '<codelark_source>\n来源群聊："回归原群"\n</codelark_source>\n\n加一个 argmax 和 remask 开关，沿用原来的着色逻辑\n保留中文、多行和代码 `x < 2`。';
  const count = 'count' in scenario ? scenario.count! : 1;
  const followups = Array.from({ length: count }, (_, i) => count === 2 ? `${followup}\n第 ${i + 1} 次补充` : followup);
  const delayedReceipt = 'delayedReceipt' in scenario;
  let releaseCheckpoint!: () => void;
  const beforeCheckpoint = new Promise<void>(resolve => { releaseCheckpoint = resolve; });
  let delayedQueueObserved = false;
  const backend = await startFakeCursorBackend({
    call(prompt) {
      if (delayedReceipt && prompt === '建立已有会话') return { final: 'READY' };
      assert.equal(prompt, initial);
      return { waitingForSteer: true, ...(delayedReceipt ? { beforeCheckpoint } : {}) };
    },
    steer(text) {
      assert.equal(text, followups[backend.steers.length - 1]);
      return backend.steers.length < count ? { waitingForSteer: true } : 'STEER_DONE：同一轮已按补充要求完成';
    },
  });
  const wrapper = path.join(root, 'cursor'), tmux = path.join(root, 'tmux');
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${quote(executable)} ${backend.args.map(quote).join(' ')} "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(tmux, `#!/bin/sh\nunset TMUX TMUX_PANE\nexec /usr/bin/tmux -S ${quote(path.join(root, 'tmux.sock'))} "$@"\n`, { mode: 0o755 });
  const env = { CURSOR_CONFIG_DIR: path.join(root, 'config'), CURSOR_DATA_DIR: path.join(root, 'data'), CURSOR_AGENT_EXECUTABLE: wrapper, CODELARK_TMUX_EXECUTABLE: tmux, CODELARK_CURSOR_MODEL: 'regression-fake', CODELARK_CURSOR_FORCE: '1', CODELARK_CURSOR_TMUX_POLL_INTERVAL_MS: '100', CURSOR_API_KEY: undefined, CURSOR_AUTH_TOKEN: undefined };
  const old = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) { old.set(key, process.env[key]); if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  fs.mkdirSync(env.CURSOR_CONFIG_DIR); fs.mkdirSync(env.CURSOR_DATA_DIR);
  fs.writeFileSync(path.join(env.CURSOR_CONFIG_DIR, 'cli-config.json'), JSON.stringify({ steering: true, approvalMode: 'unrestricted' }));
  _testOnlyTmuxCore.reset(); resetBridgeTestState(); manager.resetStateForTests();
  const store = initBridgeTestContext({ dynamicSettings: true, llm: new CodexRoutingProvider() });
  const adapter = new SteerAdapter(); registerAdapter(adapter);
  adapter.onReaction = id => {
    if (id.startsWith('steer-')) assert.ok(backend.steers.length >= Number(id.slice(6)) + 1, 'Get must not precede native steer delivery');
  };
  const bridge = (globalThis as any).__bridge_manager__; bridge.running = true;
  const session = store.createSession('Cursor steer regression', 'regression-fake', undefined, workspace, 'normal', { activeRuntime: 'cursor' });
  const target = cursorTmuxSessionName(session.id), pane = `${target}:0.0`;
  store.updateSession(session.id, { runtime: { activeRuntime: 'cursor', cursor: { provider: 'tmux', transport: 'cli', force: true, model: 'regression-fake' }, general: { workingDirectory: workspace, tmuxSessionName: target } } });
  const address = { channelType: 'feishu', chatId: 'fake-steer-chat' };
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
  const originalCapture = tmuxCore.capturePane;
  let staleUntil = 0, staleFrames = 0, interruptOnlyFrames = scenario.interruptOnlyFrames, observedInterruptOnlyFrames = 0, passed = false;
  tmuxCore.capturePane = async (...args) => {
    const capture = await originalCapture(...args);
    if (delayedReceipt && args[0] === pane && /┌─ follow-ups/.test(capture.screen) && !adapter.reactions.includes('initial')) {
      // Release the earlier receipt only after the follow-up has taken its
      // native baseline and entered the queue. It is not this input's receipt.
      delayedQueueObserved = true;
      releaseCheckpoint();
      return { ...capture, screen: capture.screen.replace(/enter\s+steer/i, 'enter interrupt and send') };
    }
    if (args[0] === pane && Date.now() < staleUntil) {
      staleFrames++; return { ...capture, screen: 'Thinking\n→ Add a follow-up    ctrl+c to stop' };
    }
    if (args[0] === pane && interruptOnlyFrames > 0 && /enter\s+steer/i.test(capture.screen)) {
      interruptOnlyFrames--;
      observedInterruptOnlyFrames++;
      return { ...capture, screen: capture.screen.replace(/enter\s+steer/i, 'enter interrupt and send') };
    }
    if ('retainedDraft' in scenario && scenario.retainedDraft && /┌─ follow-ups/.test(capture.screen)) {
      staleFrames++;
      return { ...capture, screen: capture.screen.replace(/→ Add a follow-up[^\n]*/u, `→ ${followup}`).replace(/ctrl\+c to stop/g, '') };
    }
    return capture;
  };
  const until = async (check: () => boolean, label: string) => {
    const end = Date.now() + 30_000;
    while (Date.now() < end && !check() && !backend.errors.length) { await manager.reconcileMirrorSubscriptions(); await delay(100); }
    assert.ok(check(), `${label}; errors=${JSON.stringify(backend.errors)}; sent=${JSON.stringify(adapter.sent)}`);
  };
  try {
    runtime.runAdapterLoop(adapter);
    if (delayedReceipt) {
      adapter.enqueueManualInboundMessage(inboundMessage(address, '建立已有会话', 'warmup'));
      await until(() => finished.includes('warmup'), 'warmup must persist an existing native input baseline');
    }
    adapter.enqueueManualInboundMessage(inboundMessage(address, initial, 'initial'));
    await until(() => backend.prompts.length === (delayedReceipt ? 2 : 1) && (delayedReceipt || adapter.reactions.includes('initial')), 'first model run must be active');
    if (delayedReceipt) assert.ok(!adapter.reactions.includes('initial'), 'earlier input must still await its receipt');
    assert.ok(!finished.includes('initial'));
    staleUntil = Date.now() + scenario.redrawDelay;
    for (const [i, text] of followups.entries()) {
      adapter.enqueueManualInboundMessage(inboundMessage(address, text, `steer-${i}`));
      if ('longTurn' in scenario && i === 0) {
        await until(() => finished.includes('steer-0'), 'first steer submission must finish while model keeps running');
        await until(() => [...bridge.cursorMirrorSubscriptions.values()].some((s: any) => (s.cursor.directTurnIds?.length || 0) >= 2),
          'provider must report both native turns to the mirror before finishing');
        assert.equal(bridge.mirrorSuppressUntil.get(session.id)?.length || 0, 0,
          'Cursor ownership must not depend on a prompt expiry timer');
      }
    }
    await until(() => backend.steers.length === count, 'fake model must receive each InjectContextAction during the original run');
    await until(() => finished.includes('initial') && followups.every((_, i) => finished.includes(`steer-${i}`)), 'steered original run and input delivery must complete');
    assert.equal(backend.prompts.length, delayedReceipt ? 2 : 1, 'steer must not create another model run');
    if (delayedReceipt) assert.ok(delayedQueueObserved, 'follow-up must precede the earlier checkpoint');
    assert.deepEqual(backend.steers.map(s => s.text), followups);
    assert.equal(new Set(backend.steers.map(s => s.injectionId)).size, count);
    assert.equal(new Set(backend.steers.map(s => s.expectedRunId)).size, 1);
    assert.ok(adapter.events.some(e => e.type === 'end' && e.status === 'completed' && e.text.includes('STEER_DONE')));
    assert.ok(followups.every((_, i) => adapter.reactions.includes(`steer-${i}`)));
    assert.ok(!adapter.sent.some(message => message.text.includes('tmux 执行失败')), 'input receipt delays must not produce a false failure notice');
    if (scenario.redrawDelay) assert.ok(staleFrames > 0, 'test must exercise stale frames before the queue becomes visible');
    if (scenario.interruptOnlyFrames) {
      assert.equal(observedInterruptOnlyFrames, scenario.interruptOnlyFrames,
        'test must keep the follow-up queued through each interrupt-only footer');
    }
    if ('retainedDraft' in scenario) assert.ok(staleFrames > 0, 'queued input must coexist with the stale draft');
    const history = adapter.histories.get(`im:${session.id}:initial`) || [];
    assert.deepEqual(history.flatMap(item => item.type === 'markdown' && item.role === 'user' ? [item.content] : []), [initial, ...followups],
      'the original card must contain each accepted native user input once, including identical steers');
    assert.ok(![...adapter.histories.keys()].some(key => key.startsWith('mirror:')), 'direct native output must not be replayed as another mirror card');
    assert.deepEqual(backend.errors, []); passed = true;
  } finally {
    tmuxCore.capturePane = originalCapture;
    if (!passed || process.env.CODELARK_REAL_CURSOR_E2E_KEEP_ARTIFACTS === '1') {
      fs.writeFileSync(path.join(root, 'evidence.json'), JSON.stringify({ prompts: backend.prompts, steers: backend.steers, errors: backend.errors, events: adapter.events, histories: Object.fromEntries(adapter.histories), messages: adapter.sent, staleFrames, observedInterruptOnlyFrames }, null, 2));
      fs.writeFileSync(path.join(root, 'screen.txt'), (await originalCapture(pane, 120).catch(() => ({ screen: '' }))).screen);
      console.error(`Cursor steer evidence: ${root}`);
    }
    state.running = false; bridge.running = false; await adapter.stop();
    await tmuxCore.killSession(target).catch(() => {}); await backend.close();
    await Promise.race([Promise.allSettled(jobs), delay(2000)]); manager.resetStateForTests();
    for (const [key, value] of old) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    _testOnlyTmuxCore.reset();
    if (passed && process.env.CODELARK_REAL_CURSOR_E2E_KEEP_ARTIFACTS !== '1') fs.rmSync(root, { recursive: true, force: true });
  }
});
