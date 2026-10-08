import '../../setup/test-setup.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { projectRuntimeStatus } from '../../../operator-ui/runtime-status.js';

describe('operator runtime status projection', () => {
  it('keeps local discovery distinct from bound and running state', () => {
    const available = projectRuntimeStatus('kimi', [
      { runtime: 'kimi', lastEventAt: '2026-07-28T08:00:00.000Z' },
    ], [], { kimiProvider: 'tmux', kimiDefaultModel: 'k3' });
    assert.equal(available.tone, 'available');
    assert.equal(available.state, '可接管');
    assert.deepEqual(available.config, { provider: 'tmux', model: 'k3' });

    const idle = projectRuntimeStatus('kimi', available.sessions, [
      { currentRuntime: 'kimi', currentSessionId: 'session-1', runtimeStatus: 'completed' },
    ]);
    assert.equal(idle.tone, 'idle');
    assert.equal(idle.state, '空闲');
  });

  it('deduplicates bindings and prioritizes running, queued, then stale signals', () => {
    const bindings = [
      { currentRuntime: 'claude', currentSessionId: 'session-1', runtimeStatus: 'running' },
      { currentRuntime: 'claude', currentSessionId: 'session-1', runtimeStatus: 'running' },
      { currentRuntime: 'claude', currentSessionId: 'session-2', runtimeStatus: 'queued' },
      { currentRuntime: 'claude', currentSessionId: 'session-3', mirrorStatus: 'stale' },
    ];
    assert.equal(projectRuntimeStatus('claude', [], bindings).state, '运行中 1');
    assert.equal(projectRuntimeStatus('claude', [], bindings.slice(2)).state, '排队中 1');
    assert.equal(projectRuntimeStatus('claude', [], bindings.slice(3)).state, '待恢复 1');
  });

  it('uses the same missing-state semantics for every runtime', () => {
    for (const runtime of ['codex', 'claude', 'kimi', 'cursor', 'zcode'] as const) {
      const status = projectRuntimeStatus(runtime);
      assert.equal(status.tone, 'missing');
      assert.equal(status.state, '未发现会话');
    }
  });

  it('distinguishes an inherited Codex provider from the same explicit value', () => {
    const inherited = projectRuntimeStatus('codex', [], [], {
      defaultProvider: '',
      defaultProviderInherited: true,
      defaultProviderDefaultValue: 'tmux',
    });
    const explicit = projectRuntimeStatus('codex', [], [], {
      defaultProvider: 'tmux',
      defaultProviderInherited: false,
      defaultProviderDefaultValue: 'tmux',
    });

    assert.equal(inherited.config.provider, 'tmux（跟随默认）');
    assert.equal(explicit.config.provider, 'tmux');
  });
});


describe('app-server status observations', () => {
  const binding = {
    currentRuntime: 'codex', currentSessionId: 's', currentThreadId: 'thread', runtimeStatus: 'running',
    codexBackend: { backend: 'app-server', threadId: 'thread', connection: 'unknown', activity: 'unknown' },
  };
  const status = (connection: string, activity: string, threadId = 'thread') => ({
    codexDefault: 'app-server-auto', sessions: { s: { backend: 'app-server', threadId, connection, activity } },
  });
  it('uses protocol activity instead of stale running flags and deduplicates shared bindings', () => {
    const project = (connection: string, activity: string) => projectRuntimeStatus('codex', [], [binding, binding], {}, status(connection, activity));
    assert.equal(project('ready', 'idle').state, '空闲');
    assert.equal(project('ready', 'active').state, '运行中 1');
    assert.equal(project('ready', 'waiting').state, '等待确认或输入 1');
    assert.equal(project('disconnected', 'idle').state, '连接或执行状态未确认 1');
    assert.equal(project('connecting', 'active').tone, 'attention');
  });
  it('does not retain a live observation from an old thread or an unavailable Bridge', () => {
    for (const live of [null, status('ready', 'active', 'old-thread')]) {
      assert.equal(projectRuntimeStatus('codex', [], [binding], {}, live).state, '连接或执行状态未确认 1');
    }
  });
  it('separates default selection from actual sessions and preserves legacy behavior', () => {
    const legacy = { ...binding, codexBackend: { backend: 'legacy' } };
    const result = projectRuntimeStatus('codex', [], [legacy], {}, { codexDefault: 'app-server-auto', sessions: {} });
    assert.equal(result.state, '运行中 1');
    assert.equal(result.defaultBackendLabel, '新会话优先 app-server');
    assert.equal(result.backendSummary, 'app-server 0 · 旧执行方式 1 · 尚未启动 0');
  });
});
