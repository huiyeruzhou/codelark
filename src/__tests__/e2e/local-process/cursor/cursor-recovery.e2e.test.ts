import '../../../setup/test-setup.js';
import { execFileSync } from 'node:child_process';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startFakeCursorBackend } from '../../../helpers/runtime/cursor-fake-backend.js';
import { initBridgeTestContext, RecordingAdapter, inboundMessage, resetBridgeTestState } from '../../../helpers/bridge/test-bridge-utils.js';
import { _testOnly as manager, registerAdapter, stop as stopBridge } from '../../../../bridge/host/manager.js';
import { createAdapterRuntime } from '../../../../channels/adapter-runtime/runtime.js';
import { CodexRoutingProvider } from '../../../../runtime/codex/routing-provider.js';
import { tmuxCore, _testOnlyTmuxCore } from '../../../../runtime/tmux/core.js';
import { parseCommandCallbackData } from '../../../../bridge/command/callbacks.js';
import type { StructuredStreamingUiActionButton } from '../../../../channels/contracts.js';
import { cursorTmuxSessionName } from '../../../../runtime/cursor/tmux-provider.js';

const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
class RecoveryAdapter extends RecordingAdapter {
  live = true;
  events: Array<{ type: string; text: string; status?: string; streamKey?: string }> = [];
  actions: Array<{ streamKey?: string; actions: StructuredStreamingUiActionButton[][] }> = [];
  onStreamActions(_chat: string, actions: StructuredStreamingUiActionButton[][], streamKey?: string) { this.actions.push({ streamKey, actions }); }
  reactions: string[] = [];
  onReaction?: (id: string) => void;
  isRunning() { return this.live; }
  consumeOne() { return this.consumeInboundMessage(this.live); }
  async stop() { this.live = false; this.rejectPendingInboundConsumers(); }
  supportsStructuredStreamingUi() { return true; }
  hasActiveStreamingUi() { return true; }
  onStreamText(_chat: string, text: string, streamKey?: string) { this.events.push({ type: 'text', text, streamKey }); }
  async onStreamEnd(_chat: string, status: 'completed' | 'interrupted' | 'error', text: string, streamKey?: string) { this.events.push({ type: 'end', status, text, streamKey }); return true; }
  async addMessageReaction(id: string) { this.onReaction?.(id); this.reactions.push(id); return id; }
}

for (const scenario of ['dead-pane', 'manual-mirror', 'bridge-restart'] as const) it(`real Cursor recovers ${scenario} through the bridge`, { timeout: 75_000 }, async (t) => {
  const executable = process.env.CODELARK_REAL_CURSOR_E2E_EXECUTABLE || [
    path.join(process.env.CODELARK_TEST_ORIGINAL_HOME || os.homedir(), '.local/bin/agent'),
    ...(process.env.PATH || '').split(path.delimiter).map(dir => path.join(dir, 'agent')),
  ].find(candidate => fs.existsSync(candidate));
  if (!executable) { t.skip('real Cursor CLI is not installed'); return; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-cursor-recovery-e2e-'));
  const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
  const initial = '先分析当前实现', followup = '本地手动 hi', rejected = '继续';
  let releaseFinal!: () => void;
  const beforeFinish = new Promise<void>(resolve => { releaseFinal = resolve; });
  const backend = await startFakeCursorBackend({
    call(prompt) {
      assert.ok([initial, followup].includes(prompt));
      return { final: prompt === initial ? 'INITIAL_DONE' : 'RECOVERED_DONE', ...(scenario !== 'dead-pane' && prompt === followup ? { beforeFinish } : {}) };
    },
  });
  const wrapper = path.join(root, 'cursor'), tmux = path.join(root, 'tmux');
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${quote(executable)} ${backend.args.map(quote).join(' ')} "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(tmux, `#!/bin/sh\nunset TMUX TMUX_PANE\nexec /usr/bin/tmux -S ${quote(path.join(root, 'tmux.sock'))} "$@"\n`, { mode: 0o755 });
  const env = { CURSOR_CONFIG_DIR: path.join(root, 'config'), CURSOR_DATA_DIR: path.join(root, 'data'), CURSOR_AGENT_EXECUTABLE: wrapper, CODELARK_TMUX_EXECUTABLE: tmux, CODELARK_CURSOR_MODEL: 'regression-fake', CODELARK_CURSOR_FORCE: '1', CODELARK_DEBUG: '1', CODELARK_CURSOR_TMUX_POLL_INTERVAL_MS: '100', CURSOR_API_KEY: undefined, CURSOR_AUTH_TOKEN: undefined };
  const old = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) { old.set(key, process.env[key]); if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  fs.mkdirSync(env.CURSOR_CONFIG_DIR); fs.mkdirSync(env.CURSOR_DATA_DIR);
  fs.writeFileSync(path.join(env.CURSOR_CONFIG_DIR, 'cli-config.json'), JSON.stringify({ steering: true, approvalMode: 'unrestricted' }));
  _testOnlyTmuxCore.reset(); resetBridgeTestState(); manager.resetStateForTests();
  const store = initBridgeTestContext({ dynamicSettings: true, llm: new CodexRoutingProvider() });
  const adapter = new RecoveryAdapter(); registerAdapter(adapter);
  const bridge = (globalThis as any).__bridge_manager__; bridge.running = true;
  const session = store.createSession('Cursor idle submission regression', 'regression-fake', undefined, workspace, 'normal', { activeRuntime: 'cursor' });
  const target = cursorTmuxSessionName(session.id), pane = `${target}:0.0`;
  store.updateSession(session.id, { runtime: { activeRuntime: 'cursor', cursor: { provider: 'tmux', transport: 'cli', force: true, model: 'regression-fake' }, general: { workingDirectory: workspace, tmuxSessionName: target } } });
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
  const originalCapture = tmuxCore.capturePane, originalInject = tmuxCore.injectPromptIntoPane;
  let passed = false;
  const until = async (check: () => boolean | Promise<boolean>, label: string, timeoutMs = 30_000) => {
    const end = Date.now() + timeoutMs;
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
    const nativeSessionId = store.getSession(session.id)?.runtime?.cursor?.sessionId;
    assert.ok(nativeSessionId);
    if (scenario === 'dead-pane') {
      execFileSync(tmux, ['set-option', '-t', target, 'remain-on-exit', 'on']);
      const pid = Number(execFileSync(tmux, ['display-message', '-p', '-t', pane, '#{pane_pid}'], { encoding: 'utf8' }).trim());
      process.kill(pid, 'SIGTERM'); // Only this test's isolated Cursor process.
      await until(() => execFileSync(tmux, ['display-message', '-p', '-t', pane, '#{pane_dead}'], { encoding: 'utf8' }).trim() === '1', 'test must retain a dead native pane');
      assert.equal((await tmuxCore.hasSession(target)).exists, true);
      adapter.enqueueManualInboundMessage(inboundMessage(address, followup, 'relaunch'));
      await until(() => finished.includes('relaunch'), 'IM request after process exit must finish');
      assert.ok(adapter.events.some(e => e.type === 'end' && e.status === 'completed' && e.text.includes('RECOVERED_DONE')), 'dead pane must relaunch and deliver a successful reply');
    } else if (scenario === 'bridge-restart') {
      // Production has no debug escape hatch: shutdown must preserve native work.
      delete process.env.CODELARK_DEBUG;
      adapter.enqueueManualInboundMessage(inboundMessage(address, followup, 'running-before-restart'));
      await until(() => adapter.reactions.includes('running-before-restart'), 'native input must be accepted before shutdown');
      const panePid = execFileSync(tmux, ['display-message', '-p', '-t', pane, '#{pane_pid}'], { encoding: 'utf8' }).trim();
      await stopBridge();
      await Promise.all(jobs);
      await delay(300);
      assert.equal((await tmuxCore.hasSession(target)).exists, true, 'bridge shutdown must not kill the active native Cursor');
      assert.equal(execFileSync(tmux, ['display-message', '-p', '-t', pane, '#{pane_pid}'], { encoding: 'utf8' }).trim(), panePid);
      bridge.running = true;
      adapter.live = true;
      registerAdapter(adapter);
      await manager.reconcileMirrorSubscriptions();
      releaseFinal();
      await until(() => adapter.events.some(e => e.streamKey?.startsWith('mirror:') && e.type === 'end'
        && e.status === 'completed' && e.text.includes('RECOVERED_DONE')), 'restarted bridge must mirror the original turn final without resending its input');
    } else {
      tmuxCore.injectPromptIntoPane = async (target, prompt, options) => {
        if (prompt === rejected) throw new Error('test: input failed before native acceptance');
        return originalInject(target, prompt, options);
      };
      adapter.enqueueManualInboundMessage(inboundMessage(address, rejected, 'failed-input'));
      await until(() => finished.includes('failed-input'), 'failed IM input must release the active task');
      tmuxCore.injectPromptIntoPane = originalInject;
      assert.equal(backend.prompts.length, 1);
      assert.ok(adapter.events.some(e => e.type === 'end' && e.status === 'error'));
      await originalInject(pane, followup); // Manual local input, bypassing the IM input path.
      await until(() => backend.prompts.length === 2, 'native model must receive manual input');
      await until(() => adapter.events.some(e => e.streamKey?.startsWith('mirror:') && e.text.includes(followup)), 'manual input must create a live mirror before the model completes, without waiting for the failed IM suppression to expire', 5_000);
      const stop = adapter.actions.find(event => event.streamKey?.startsWith('mirror:'))?.actions[0]?.[0];
      assert.ok(stop, 'a live native mirror must expose the existing stop action');
      assert.deepEqual(parseCommandCallbackData(stop.callbackData), { commandText: '/stop', scopeSessionId: session.id });
      releaseFinal();
      await until(() => adapter.events.some(e => e.streamKey?.startsWith('mirror:') && e.type === 'end' && e.status === 'completed' && e.text.includes('RECOVERED_DONE')), 'manual mirror must deliver the final reply');
    }
    assert.deepEqual(backend.prompts, [initial, followup], 'recovery must not duplicate inputs');
    assert.equal(backend.nativeSessionId, nativeSessionId, 'recovery must preserve native history identity');
    assert.equal(store.getSession(session.id)?.runtime?.cursor?.sessionId, nativeSessionId);
    assert.deepEqual(backend.errors, []); passed = true;
  } finally {
    tmuxCore.injectPromptIntoPane = originalInject; releaseFinal();
    if (!passed || process.env.CODELARK_REAL_CURSOR_E2E_KEEP_ARTIFACTS === '1') {
      fs.writeFileSync(path.join(root, 'mirror-state.json'), JSON.stringify({ session: store.getSession(session.id), subscriptions: [...bridge.cursorMirrorSubscriptions.values()], suppression: [...bridge.mirrorSuppressUntil] }, (_key, value) => value instanceof Set ? [...value] : value instanceof Map ? [...value] : value, 2));
      fs.writeFileSync(path.join(root, 'evidence.json'), JSON.stringify({ prompts: backend.prompts, steers: backend.steers, errors: backend.errors, events: adapter.events, messages: adapter.sent }, null, 2));
      fs.writeFileSync(path.join(root, 'screen.txt'), (await originalCapture(pane, 120).catch(() => ({ screen: '' }))).screen);
      console.error(`Cursor recovery evidence: ${root}`);
    }
    state.running = false; bridge.running = false; await adapter.stop();
    await tmuxCore.killSession(target).catch(() => {}); await backend.close();
    await Promise.race([Promise.allSettled(jobs), delay(2000)]); manager.resetStateForTests();
    for (const [key, value] of old) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    _testOnlyTmuxCore.reset();
    if (passed && process.env.CODELARK_REAL_CURSOR_E2E_KEEP_ARTIFACTS !== '1') fs.rmSync(root, { recursive: true, force: true });
  }
});
