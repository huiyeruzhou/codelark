import '../../../setup/test-setup.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { initBridgeTestContext, resetBridgeTestState, RecordingAdapter, writeCodexSessionJsonlFixture } from '../../../helpers/bridge/test-bridge-utils.js';
import { createConfigService } from '../../../../configuration/service.js';
import { createSessionHealthRuntime } from '../../../../bridge/health/runtime.js';
import { _testOnly as manager } from '../../../../bridge/host/manager.js';
import * as router from '../../../../bridge/session/channel-router.js';

it('legacy mirror restores a manual active turn without replaying history and clears it on the matching terminal', async (t) => {
  resetBridgeTestState({ cleanCodexHome: true });
  const store = initBridgeTestContext();
  manager.resetStateForTests();
  t.after(() => manager.resetStateForTests());
  const address = { channelType: 'feishu', chatId: 'manual-lifecycle' };
  const binding = router.createBinding(address, os.tmpdir());
  const threadId = randomUUID();
  store.updateSessionCodexThreadId(binding.bridgeSessionId, threadId);
  createConfigService({ migrate: false, env: {} }).set({ kind: 'session', sessionId: binding.bridgeSessionId }, { runtime: { codex: { provider: 'pty' } } });
  const now = Date.now();
  const event = (offset: number, payload: Record<string, unknown>) => ({ timestamp: new Date(now + offset).toISOString(), type: 'event_msg', payload });
  const fixture = writeCodexSessionJsonlFixture({ threadId, workDir: os.tmpdir(), lines: [
    { timestamp: new Date(now).toISOString(), type: 'session_meta', payload: { id: threadId, cwd: os.tmpdir() } },
    event(1, { type: 'task_started', turn_id: 'turn-a' }),
    event(2, { type: 'agent_reasoning', text: 'thinking in the terminal' }),
  ] });
  class Adapter extends RecordingAdapter { isRunning() { return true; } }
  const adapter = new Adapter();
  const state = (globalThis as any).__bridge_manager__;
  state.running = true;
  state.adapters.set(address.channelType, adapter);
  await manager.reconcileMirrorSubscriptions();
  assert.equal(store.getSession(binding.bridgeSessionId)?.runtime_status, 'running');
  assert.equal(store.getSession(binding.bridgeSessionId)?.health_status, 'running_active');
  assert.equal(adapter.sent.length, 0, '恢复状态不能重发历史输出');
  const health = createSessionHealthRuntime({ getStore: () => store, nowIso: () => new Date().toISOString() });
  health.reconcileSessionHealth();
  assert.notEqual(store.getSession(binding.bridgeSessionId)?.health_status, 'idle', '健康检查不能抹掉人工轮次');

  fs.appendFileSync(fixture.sessionPath, JSON.stringify(event(3, { type: 'task_complete', turn_id: 'turn-a' })) + '\n');
  await manager.reconcileMirrorSubscriptions();
  assert.equal(store.getSession(binding.bridgeSessionId)?.runtime_status, 'idle');
  assert.equal(store.getSession(binding.bridgeSessionId)?.health_status, 'completed');
});

it('late records from another turn or thread cannot terminate the current turn or restore old tools', () => {
  resetBridgeTestState();
  const store = initBridgeTestContext();
  const session = store.createSession('turn ownership', '');
  store.updateSessionCodexThreadId(session.id, 'thread');
  const health = createSessionHealthRuntime({ getStore: () => store, nowIso: () => new Date().toISOString() });
  const record = (type: 'task_started' | 'task_aborted' | 'task_complete' | 'tool_started', turnId: string, timestamp: string) => ({ type, turnId, timestamp, signature: `${type}-${turnId}`, content: '', toolId: 'tool', toolName: 'exec' });
  health.observeBridgeMirrorRecords(session.id, 'thread', [record('task_started', 'a', '2026-10-08T00:00:01Z'), record('task_started', 'b', '2026-10-08T00:00:02Z')]);
  health.observeBridgeMirrorRecords(session.id, 'thread', [record('task_aborted', 'a', '2026-10-08T00:00:03Z'), record('tool_started', 'a', '2026-10-08T00:00:03Z')]);
  health.observeBridgeMirrorRecords(session.id, 'old-thread', [record('task_complete', 'b', '2026-10-08T00:00:04Z')]);
  assert.equal(store.getSession(session.id)?.health_status, 'running_active');
  assert.equal(store.getSession(session.id)?.active_tool_name, undefined);
  health.observeBridgeMirrorRecords(session.id, 'thread', [record('task_complete', 'b', '2026-10-08T00:00:05Z'), record('tool_started', 'b', '2026-10-08T00:00:06Z'), record('task_started', 'a', '2026-10-08T00:00:01Z')]);
  assert.equal(store.getSession(session.id)?.health_status, 'completed');
  assert.equal(store.getSession(session.id)?.active_tool_name, undefined);
});
