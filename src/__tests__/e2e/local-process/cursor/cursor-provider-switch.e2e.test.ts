import '../../../setup/test-setup.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startFakeCursorBackend, type FakeCursorStreamEvent } from '../../../helpers/runtime/cursor-fake-backend.js';
import { initBridgeTestContext, RecordingAdapter, inboundMessage, resetBridgeTestState } from '../../../helpers/bridge/test-bridge-utils.js';
import { _testOnly as manager, registerAdapter } from '../../../../bridge/host/manager.js';
import { createAdapterRuntime } from '../../../../channels/adapter-runtime/runtime.js';
import { CodexRoutingProvider } from '../../../../runtime/codex/routing-provider.js';
import { closeAllCursorAcpSessions } from '../../../../runtime/cursor/acp-provider.js';
import { tmuxCore, _testOnlyTmuxCore } from '../../../../runtime/tmux/core.js';
import { cursorTmuxSessionName } from '../../../../runtime/cursor/tmux-provider.js';
import { createConfigService } from '../../../../configuration/service.js';

const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
it('real Cursor switches a stalled TUI to ACP through the confirmation and executes one tool once', { timeout: 75_000 }, async t => {
  if (process.platform === 'win32') { t.skip('isolated Cursor TUI test requires POSIX tmux'); return; }
  const tmuxExecutable = (process.env.PATH || '').split(path.delimiter)
    .map(dir => path.join(dir, 'tmux')).find(candidate => fs.existsSync(candidate));
  if (!tmuxExecutable) { t.skip('tmux is not installed'); return; }
  const executable = process.env.CODELARK_REAL_CURSOR_E2E_EXECUTABLE || [
    path.join(process.env.CODELARK_TEST_ORIGINAL_HOME || os.homedir(), '.local/bin/agent'),
    ...(process.env.PATH || '').split(path.delimiter).map(dir => path.join(dir, 'agent')),
  ].find(candidate => fs.existsSync(candidate));
  if (!executable) { t.skip('real Cursor CLI not installed'); return; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-cursor-switch-'));
  const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
  const backend = await startFakeCursorBackend({ persistConversationSteps: true, call(prompt) {
    if (prompt === 'keep running') return { waitingForSteer: true };
    assert.equal(prompt, 'verify ACP');
    return { final: 'ACP_SWITCH_DONE', stream: (async function* (): AsyncGenerator<FakeCursorStreamEvent> {
      yield { type: 'execute_shell', id: 'switch-shell', command: 'printf ACP_SWITCH_TOOL', cwd: workspace };
      yield { type: 'text', text: 'ACP_SWITCH_DONE' };
    })() };
  } });
  const wrapper = path.join(root, 'cursor'), tmux = path.join(root, 'tmux');
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${quote(executable)} ${backend.args.map(quote).join(' ')} "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(tmux, `#!/bin/sh\nunset TMUX TMUX_PANE\nexec ${quote(tmuxExecutable)} -S ${quote(path.join(root, 'tmux.sock'))} "$@"\n`, { mode: 0o755 });
  const env = { CURSOR_CONFIG_DIR: path.join(root, 'config'), CURSOR_DATA_DIR: path.join(root, 'data'),
    CURSOR_AGENT_EXECUTABLE: wrapper, CODELARK_TMUX_EXECUTABLE: tmux, CODELARK_CURSOR_MODEL: 'regression-fake',
    CODELARK_CURSOR_FORCE: '1', CODELARK_CURSOR_TMUX_POLL_INTERVAL_MS: '100', CURSOR_API_KEY: undefined, CURSOR_AUTH_TOKEN: undefined };
  const old = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) { old.set(key, process.env[key]); if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  fs.mkdirSync(env.CURSOR_CONFIG_DIR); fs.mkdirSync(env.CURSOR_DATA_DIR);
  fs.writeFileSync(path.join(env.CURSOR_CONFIG_DIR, 'cli-config.json'), JSON.stringify({ steering: true, approvalMode: 'unrestricted' }));
  _testOnlyTmuxCore.reset(); resetBridgeTestState(); manager.resetStateForTests();
  const store = initBridgeTestContext({ dynamicSettings: true, llm: new CodexRoutingProvider() });
  class Adapter extends RecordingAdapter {
    live = true;
    results: Array<{ status: string; text: string }> = [];
    isRunning() { return this.live; }
    consumeOne() { return this.consumeInboundMessage(this.live); }
    async stop() { this.live = false; this.rejectPendingInboundConsumers(); }
    supportsStructuredStreamingUi() { return true; }
    hasActiveStreamingUi() { return true; }
    onStreamText() {}
    async onStreamEnd(_chat: string, status: string, text: string) { this.results.push({ status, text }); return true; }
  }
  const adapter = new Adapter(); registerAdapter(adapter);
  const bridge = (globalThis as any).__bridge_manager__; bridge.running = true;
  const session = store.createSession('Cursor switch', 'regression-fake', undefined, workspace, 'normal', { activeRuntime: 'cursor' });
  const target = cursorTmuxSessionName(session.id);
  store.updateSession(session.id, { runtime: { activeRuntime: 'cursor', cursor: { provider: 'tmux', transport: 'cli', force: true, model: 'regression-fake' }, general: { workingDirectory: workspace, tmuxSessionName: target } } });
  createConfigService({ migrate: false }).set({ kind: 'session', sessionId: session.id }, { runtime: { cursor: { model: 'regression-fake', provider: 'tmux', force: true } } });
  const address = { channelType: 'feishu', chatId: 'fake-provider-switch' };
  store.upsertChannelChat({ ...address, bridgeSessionId: session.id, chatKind: 'group' });
  const state = { adapters: new Map(), adapterMeta: new Map(), invalidAdapters: new Map(), loopAborts: new Map(), running: true };
  const jobs: Promise<void>[] = [];
  const runtime = createAdapterRuntime(() => state, {
    notifyAdapterSetChanged: () => {},
    handleMessage: async (a, msg) => { const job = manager.handleMessageWithoutDeliveryWait(a, msg); jobs.push(job); await job; },
    processWithSessionLock: async (_id, fn) => fn(),
    isCommandMessage: msg => manager.isBridgeCommandText(msg.text), shouldBypassSessionLock: manager.shouldBypassSessionLock,
    getImmediateLane: manager.adapterImmediateLane, getSessionLane: manager.adapterSessionLane, resolveSessionIdForMessage: () => session.id,
  });
  const until = async (check: () => boolean, message: string) => {
    for (let i = 0; i < 500; i++) { if (check()) return; await delay(100); }
    assert.ok(check(), message);
  };
  let passed = false;
  try {
    runtime.runAdapterLoop(adapter);
    adapter.enqueueManualInboundMessage(inboundMessage(address, 'keep running', 'initial'));
    await until(() => backend.prompts.length === 1 && !!store.getSession(session.id)?.runtime?.cursor?.sessionId, 'TUI must be running');
    const oldNative = store.getSession(session.id)!.runtime!.cursor!.sessionId!;
    adapter.enqueueManualInboundMessage(inboundMessage(address, '/p acp', 'switch'));
    await until(() => adapter.sent.some(m => m.richCard?.title === '切换到 ACP'), 'switch must respond while the TUI stream is still open');
    assert.equal(store.getSession(session.id)?.runtime?.cursor?.sessionId, oldNative);
    const card = adapter.sent.find(m => m.richCard?.title === '切换到 ACP')!.richCard!;
    adapter.enqueueManualInboundMessage({ ...inboundMessage(address, '', 'confirm'), callbackData: card.actions![0]![0]!.callbackData, callbackMessageId: 'switch-card' });
    await until(() => store.getSession(session.id)?.runtime?.cursor?.sessionProvider === 'acp', 'confirmation must commit ACP ownership');
    assert.equal(store.getSession(session.id)?.runtime?.cursor?.previousSession?.sessionId, oldNative);
    assert.equal((await tmuxCore.hasSession(target)).exists, false);
    adapter.enqueueManualInboundMessage(inboundMessage(address, 'verify ACP', 'acp-input'));
    await until(() => adapter.results.some(r => r.status === 'completed' && r.text.includes('ACP_SWITCH_DONE')), 'ACP must complete the next real request');
    assert.deepEqual(backend.prompts, ['keep running', 'verify ACP']);
    assert.equal(backend.shellResults.length, 1);
    assert.notEqual(store.getSession(session.id)?.runtime?.cursor?.sessionId, oldNative);
    assert.deepEqual(backend.errors, []);
    passed = true;
  } finally {
    if (!passed) { fs.writeFileSync(path.join(root, 'evidence.json'), JSON.stringify({ prompts: backend.prompts, errors: backend.errors, messages: adapter.sent, results: adapter.results }, null, 2)); console.error(`Cursor switch evidence: ${root}`); }
    state.running = false; bridge.running = false; await adapter.stop();
    await closeAllCursorAcpSessions(); await tmuxCore.killSession(target).catch(() => {}); await backend.close();
    await Promise.race([Promise.allSettled(jobs), delay(2000)]); manager.resetStateForTests();
    for (const [key, value] of old) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    _testOnlyTmuxCore.reset(); if (passed) fs.rmSync(root, { recursive: true, force: true });
  }
});
