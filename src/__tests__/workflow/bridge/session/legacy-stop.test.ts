import '../../../setup/test-setup.js';
import { beforeEach, afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { initBridgeTestContext, resetBridgeTestState } from '../../../helpers/bridge/test-bridge-utils.js';
import { createConfigService } from '../../../../configuration/service.js';
import { createSessionHealthRuntime } from '../../../../bridge/health/runtime.js';
import { createInteractiveRuntime } from '../../../../bridge/host/interactive-runtime.js';
import { getProviderOwnedRuntimeTmuxTarget, stopRunningSession, type StopRunningSessionDeps } from '../../../../bridge/session/stop-running-session.js';
import { handleStopCommand } from '../../../../bridge/command/control.js';
import { CommandThreadDisplay } from '../../../../bridge/command/thread-display.js';
import { _testOnlyTmuxCore, type TmuxCore } from '../../../../bridge/tmux/core.js';
import { kimiTmuxSessionName } from '../../../../runtime/kimi/tmux-provider.js';
import { cursorTmuxSessionName } from '../../../../runtime/cursor/tmux-provider.js';
import { zcodeTmuxSessionName } from '../../../../runtime/zcode/tmux-provider.js';
import { claudeTmuxSessionName } from '../../../../bridge/tmux/runtime.js';
import { resetRuntimeTmuxInputStatesForTests } from '../../../../bridge/tmux/input-state-machine.js';

beforeEach(() => { resetBridgeTestState(); resetRuntimeTmuxInputStatesForTests(); });
afterEach(() => _testOnlyTmuxCore.reset());

function fixture(runtime: 'codex' | 'claude' | 'kimi' | 'cursor' | 'zcode' = 'codex', provider: 'sdk' | 'tmux' = 'tmux') {
  const store = initBridgeTestContext();
  const session = store.createSession('legacy stop fixture', 'test-model');
  createConfigService({ migrate: false, env: {} }).set(
    { kind: 'session', sessionId: session.id }, { runtime: { [runtime]: { provider } } },
  );
  const target = runtime === 'kimi' ? kimiTmuxSessionName(session.id)
    : runtime === 'zcode' ? zcodeTmuxSessionName(session.id)
      : runtime === 'cursor' ? cursorTmuxSessionName(session.id)
        : runtime === 'claude' ? claudeTmuxSessionName(session.id) : `codex_${session.id}`;
  store.updateSession(session.id, {
    runtime: runtime === 'codex'
      ? { activeRuntime: 'codex', codex: { threadId: session.id }, general: { tmuxSessionName: target } }
      : { activeRuntime: runtime, general: { tmuxSessionName: target } },
    runtime_status: 'idle', health_status: 'idle',
  });
  const address = { channelType: 'fixture', chatId: session.id };
  const binding = store.upsertChannelChat({ ...address, bridgeSessionId: session.id });
  const sent: string[] = [];
  let send: (name: string) => Promise<string> = async (name) => {
    assert.equal(name, target, 'only the current runtime target may receive input');
    sent.push(name);
    return `tmux send-keys -t ${name} C-c`;
  };
  _testOnlyTmuxCore.replace(new Proxy({} as TmuxCore, {
    get: (_object, key) => key === 'sendInterrupt' ? (name: string) => send(name)
      : () => assert.fail(`unexpected tmux operation: ${String(key)}`),
  }));
  const health = createSessionHealthRuntime({ getStore: () => store, nowIso: () => new Date().toISOString() });
  const state = { activeTasks: new Map(), queuedCounts: new Map(), sessionLocks: new Map() };
  const interactive = createInteractiveRuntime(() => state, { getStore: () => store, nowIso: () => new Date().toISOString() });
  const healthEnds: string[] = [];
  const deps: StopRunningSessionDeps = {
    getActiveTask: (id) => interactive.getActiveTask(id),
    forceStopSession: (id, detail) => interactive.forceStopSession(id, detail),
    cancelQueuedSessionMessages: (id) => interactive.cancelQueuedSessionMessages(id),
    recordInteractiveHealthEnd: (id, outcome) => { healthEnds.push(outcome); health.recordInteractiveEnd(id, outcome); },
  };
  const stop = () => stopRunningSession({ store, binding, deps, detail: 'fixture stop requested' });
  const command = () => handleStopCommand({ store, binding, deps, markdown: false,
    threadDisplay: new CommandThreadDisplay(store), msg: { address, text: '/stop', messageId: 'fixture-stop', timestamp: Date.now() } });
  return { store, session, binding, target, sent, health, state, interactive, deps, healthEnds, stop, command,
    replaceSend: (replacement: typeof send) => { send = replacement; } };
}

it('explicit /stop reaches its bound tmux runtime after health reconcile loses a manual turn', async () => {
  const f = fixture();
  f.health.observeBridgeMirrorRecords(f.session.id, 'thread', [{
    signature: 'manual-start', type: 'task_started', turnId: 'manual-turn', content: '', timestamp: new Date().toISOString(),
  }]);
  assert.equal(f.store.getSession(f.session.id)?.health_status, 'running_active');
  f.health.reconcileSessionHealth();
  assert.equal(f.store.getSession(f.session.id)?.health_status, 'idle', 'baseline upstream health loss is reproduced');
  const response = await f.command();
  assert.deepEqual(f.sent, [f.target]);
  assert.match(response, /已发送.*(停止|中断)/);
  assert.doesNotMatch(response, /任务已停止|当前没有正在运行/);
  assert.deepEqual(f.healthEnds, []);
});

it('tmux key delivery does not manufacture a terminal health event', async () => {
  const f = fixture();
  f.health.recordInteractiveStart(f.session.id);
  f.health.recordToolState(f.session.id, 'tool', 'exec_command', 'running');
  const result = await f.stop();
  assert.equal(result.method, 'tmux_interrupt');
  assert.deepEqual(f.sent, [f.target]);
  assert.deepEqual(f.healthEnds, []);
  assert.equal(f.store.getSession(f.session.id)?.health_status, 'waiting_tool');
  assert.ok(f.store.getSession(f.session.id)?.active_tool_name);
  f.health.observeBridgeMirrorRecords(f.session.id, 'thread', [{
    signature: 'real-abort', type: 'task_aborted', content: '', timestamp: new Date().toISOString(),
  }]);
  await f.interactive.reconcileTerminalSessionRuntimeState();
  assert.equal(f.store.getSession(f.session.id)?.health_status, 'aborted');
  assert.equal(f.store.getSession(f.session.id)?.active_tool_name, undefined);
  assert.equal(f.store.getSession(f.session.id)?.runtime_status, 'idle');
});

it('SDK health residue without an active task is not evidence of a stopped task', async () => {
  const f = fixture('codex', 'sdk');
  f.health.recordInteractiveStart(f.session.id);
  f.health.recordToolState(f.session.id, 'old-tool', 'shell', 'running');
  let forced = 0;
  f.deps.forceStopSession = async () => { forced++; return false; };
  const result = await f.stop();
  assert.equal(result.stopped, false);
  assert.equal(result.method, 'idle');
  assert.equal(forced, 0);
  assert.deepEqual(f.sent, []);
  assert.deepEqual(f.healthEnds, []);
  assert.doesNotMatch(await f.command(), /任务已停止|已停止当前任务/);
});

it('a normal attached terminal is not a runtime interrupt target', async () => {
  const f = fixture('codex', 'sdk');
  f.store.updateSession(f.session.id, { runtime: { general: { tmuxSessionName: 'ordinary-attached-shell' } } });
  f.health.recordInteractiveStart(f.session.id);
  const response = await f.command();
  assert.deepEqual(f.sent, []);
  assert.deepEqual(f.healthEnds, []);
  assert.doesNotMatch(response, /任务已停止|已发送/);
});

it('a generic attachment is not owned even when the configured provider is tmux', async () => {
  const f = fixture();
  f.store.updateSession(f.session.id, { runtime: { general: { tmuxSessionName: 'ordinary-shell' } } });
  f.health.recordInteractiveStart(f.session.id);
  assert.equal(getProviderOwnedRuntimeTmuxTarget(f.store.getSession(f.session.id), f.binding), undefined);
  assert.equal((await f.stop()).stopped, false);
  assert.deepEqual(f.sent, []);
});

it('the ownership query recognizes an idle recorded target but rejects another thread and remote views', () => {
  const f = fixture();
  assert.deepEqual(getProviderOwnedRuntimeTmuxTarget(f.store.getSession(f.session.id), f.binding), { runtime: 'codex', sessionName: f.target });
  f.store.updateSession(f.session.id, { runtime: { general: { tmuxSessionName: `${f.target}-other` } } });
  assert.equal(getProviderOwnedRuntimeTmuxTarget(f.store.getSession(f.session.id), f.binding), undefined);
  f.store.updateSession(f.session.id, { runtime: { general: { tmuxSessionName: f.target }, codex: { appServerEndpoint: 'unix:///fixture/view.sock' } } });
  assert.equal(getProviderOwnedRuntimeTmuxTarget(f.store.getSession(f.session.id), f.binding), undefined);
});

it('the ownership query does not invent a target for an unstarted Kimi provider', () => {
  const f = fixture('kimi');
  f.store.updateSession(f.session.id, { runtime: { general: { tmuxSessionName: undefined } } });
  assert.equal(getProviderOwnedRuntimeTmuxTarget(f.store.getSession(f.session.id), f.binding), undefined);
});

for (const runtime of ['claude', 'kimi', 'cursor', 'zcode'] as const) it(`${runtime} ownership uses this BridgeSession's exact recorded target`, () => {
  const f = fixture(runtime);
  assert.deepEqual(getProviderOwnedRuntimeTmuxTarget(f.store.getSession(f.session.id), f.binding), { runtime, sessionName: f.target });
  f.store.updateSession(f.session.id, { runtime: { general: { tmuxSessionName: `${f.target}-other` } } });
  assert.equal(getProviderOwnedRuntimeTmuxTarget(f.store.getSession(f.session.id), f.binding), undefined);
});

it('a stale binding cannot stop the old session or cancel its queued input', async () => {
  const f = fixture();
  f.store.updateChannelChat(f.binding.id, { bridgeSessionId: f.store.createSession('replacement', 'test-model').id });
  f.deps.cancelQueuedSessionMessages = () => assert.fail('stale request must not cancel old queued input');
  assert.equal((await f.stop()).stopped, false);
  assert.deepEqual(f.sent, []);
});

for (const runtime of ['kimi', 'zcode'] as const) it(`active ${runtime} stop preserves its existing interrupt count and releases local task ownership`, async () => {
  const f = fixture(runtime);
  const abortController = new AbortController();
  f.state.activeTasks.set(f.session.id, { id: 'active', sessionId: f.session.id, abortController });
  f.interactive.syncSessionRuntimeState(f.session.id);
  f.health.recordInteractiveStart(f.session.id);
  const result = await f.stop();
  assert.equal(result.method, 'active_task');
  assert.equal(abortController.signal.aborted, true);
  assert.equal(f.interactive.getActiveTask(f.session.id), undefined);
  assert.equal(f.interactive.getQueuedCount(f.session.id), 0);
  assert.equal(f.sent.length, runtime === 'kimi' ? 2 : 1);
  assert.deepEqual(f.healthEnds, []);
});

it('active SDK /stop aborts the actual task without claiming its terminal result', async () => {
  const f = fixture('codex', 'sdk');
  const abortController = new AbortController();
  f.state.activeTasks.set(f.session.id, { id: 'active', sessionId: f.session.id, abortController });
  f.interactive.syncSessionRuntimeState(f.session.id);
  const response = await f.command();
  assert.equal(abortController.signal.aborted, true);
  assert.equal(f.interactive.getActiveTask(f.session.id), undefined);
  assert.deepEqual(f.sent, []);
  assert.deepEqual(f.healthEnds, []);
  assert.doesNotMatch(response, /任务已停止/);
});

it('active Cursor stop still uses its stream abort and cleanup instead of adding a new key sequence', async () => {
  const f = fixture('cursor');
  const abortController = new AbortController();
  f.state.activeTasks.set(f.session.id, { id: 'active', sessionId: f.session.id, abortController });
  await f.stop();
  assert.equal(abortController.signal.aborted, true);
  assert.equal(f.interactive.getActiveTask(f.session.id), undefined);
  assert.deepEqual(f.sent, []);
});

it('failed tmux input propagates failure without manufacturing an aborted state', async () => {
  const f = fixture();
  f.health.recordInteractiveStart(f.session.id);
  f.replaceSend(async () => { throw new Error('fixture target disappeared'); });
  await assert.rejects(f.stop(), /fixture target disappeared/);
  assert.deepEqual(f.healthEnds, []);
  assert.equal(f.store.getSession(f.session.id)?.health_status, 'running_active');
});

it('does not send the second Kimi interrupt after the chat changes binding', async () => {
  const f = fixture('kimi');
  f.health.recordInteractiveStart(f.session.id);
  f.replaceSend(async (target) => {
    f.sent.push(target);
    f.store.updateChannelChat(f.binding.id, { bridgeSessionId: f.store.createSession('replacement', 'test-model').id });
    return 'fixture C-c';
  });
  await f.stop();
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.healthEnds, []);
});

it('does not interrupt a new task that appears while the old Kimi task is stopping', async () => {
  const f = fixture('kimi');
  const oldAbort = new AbortController();
  const nextAbort = new AbortController();
  f.state.activeTasks.set(f.session.id, { id: 'old', sessionId: f.session.id, abortController: oldAbort });
  f.deps.forceStopSession = async () => {
    oldAbort.abort();
    await Promise.resolve();
    f.state.activeTasks.set(f.session.id, { id: 'next', sessionId: f.session.id, abortController: nextAbort });
    return true;
  };
  await f.stop();
  assert.equal(nextAbort.signal.aborted, false);
  assert.deepEqual(f.sent, []);
  assert.deepEqual(f.healthEnds, []);
});

it('an active Kimi task retains its deterministic interrupt target before attachment metadata is saved', async () => {
  const f = fixture('kimi');
  f.store.updateSession(f.session.id, { runtime: { general: { tmuxSessionName: undefined } } });
  const abortController = new AbortController();
  f.state.activeTasks.set(f.session.id, { id: 'active', sessionId: f.session.id, abortController });
  await f.stop();
  assert.equal(abortController.signal.aborted, true);
  assert.deepEqual(f.sent, [f.target, f.target]);
});
