import '../../../setup/test-setup.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import type { BridgeSession } from '../../../../domain/session.js';
import { projectCodexBackendStatus, readCodexBackendStatus } from '../../../../bridge/session/display/codex-backend-status.js';

const endpoint = 'unix:///tmp/owned-status-fixture.sock';
const selected: BridgeSession = {
  id: 'current-session',
  runtime: { codex: { threadId: 'thread-a', appServerEndpoint: endpoint } },
};

it('distinguishes an unstarted default, inherited bare endpoint, and legacy thread without guessing a connection', () => {
  for (const session of [{ id: 'fresh' }, { id: 'inherited', runtime: { codex: { appServerEndpoint: endpoint } } }]) {
    const status = projectCodexBackendStatus(session);
    assert.equal(status.backend, 'unstarted');
    assert.equal(status.activity, 'unknown');
    assert.notEqual(status.connection, 'ready');
  }
  for (const provider of ['sdk', 'pty', 'tmux'] as const) {
    const status = projectCodexBackendStatus({ id: 'legacy', runtime: { codex: { threadId: 'old-thread', provider } }, runtime_status: 'running' });
    assert.equal(status.backend, 'legacy');
    assert.equal(status.connection, 'not-applicable');
    assert.equal(status.activity, 'unknown');
  }
});

it('does not turn a selected endpoint, saved idle state, or terminal health into a live connection', () => {
  const session = { ...selected, runtime_status: 'idle' as const, health_status: 'completed' as const };
  const before = structuredClone(session);
  const status = projectCodexBackendStatus(session);
  assert.equal(status.backend, 'app-server');
  assert.equal(status.connection, 'unknown');
  assert.equal(status.activity, 'unknown');
  assert.equal(status.connectionLabel, '连接未确认');
  assert.equal(status.activityLabel, '活动未确认');
  assert.deepEqual(session, before);
});

it('projects ready activity and suppresses stale active or idle activity on every non-ready connection', () => {
  for (const activity of ['idle', 'active', 'waiting', 'unknown'] as const) {
    assert.equal(projectCodexBackendStatus(selected, { threadId: 'thread-a', connection: 'ready', activity }).activity, activity);
    for (const connection of ['connecting', 'disconnected'] as const) {
      const status = projectCodexBackendStatus(selected, { threadId: 'thread-a', connection, activity });
      assert.equal(status.connection, connection);
      assert.equal(status.activity, 'unknown');
    }
  }
  assert.equal(projectCodexBackendStatus(selected, { threadId: 'thread-a', connection: 'ready', activity: 'waiting' }).activityLabel, '等待答复');
});

it('ignores snapshots for another thread, a detached subscription or another active runtime', () => {
  for (const snapshot of [
    { threadId: 'old-thread', connection: 'ready' as const, activity: 'active' as const },
    { threadId: 'thread-a', attached: false, connection: 'ready' as const, activity: 'idle' as const },
  ]) {
    assert.equal(projectCodexBackendStatus(selected, snapshot).connection, 'unknown');
  }
  const other: BridgeSession = { id: selected.id, runtime: { activeRuntime: 'claude', claude: { sessionId: 'claude-thread' } } };
  const status = readCodexBackendStatus(other, () => { throw new Error('must not read the old Codex cache'); });
  assert.equal(status.backend, 'legacy');
  assert.equal(status.connection, 'not-applicable');
});

it('distinguishes the recorded remote view from a legacy writer and ordinary attached terminal', () => {
  const withName = (session: BridgeSession, name: string): BridgeSession => ({
    ...session, runtime: { codex: session.runtime?.codex, general: { tmuxSessionName: name } },
  });
  assert.equal(projectCodexBackendStatus(withName(selected, 'codex_thread-a-view')).terminal, 'view');
  assert.equal(projectCodexBackendStatus(withName(selected, 'codex_thread-a')).terminal, 'attached');
  assert.equal(projectCodexBackendStatus(withName(selected, 'ordinary-shell')).terminal, 'attached');
  assert.equal(projectCodexBackendStatus(withName(selected, 'ordinary-shell')).terminalName, 'ordinary-shell');
  const legacy: BridgeSession = { id: 'legacy', runtime: { codex: { threadId: 'thread-a' } } };
  assert.equal(projectCodexBackendStatus(withName(legacy, 'codex_thread-a')).terminal, 'execution');
  assert.equal(projectCodexBackendStatus(withName(legacy, 'ordinary-shell')).terminal, 'attached');
});

it('reads exactly one matching cached snapshot and rejects old thread or endpoint ownership', () => {
  let reads = 0;
  const cached = {
    endpoint, threadId: 'thread-a',
    lifecycle: { snapshot: (threadId: string) => {
      reads++;
      assert.equal(threadId, 'thread-a');
      return { threadId, connection: 'ready' as const, activity: 'active' as const };
    } },
  };
  assert.equal(readCodexBackendStatus(selected, (id) => { assert.equal(id, selected.id); return cached; }).activity, 'active');
  assert.equal(reads, 1);
  for (const stale of [{ ...cached, threadId: 'old-thread' }, { ...cached, endpoint: 'unix:///tmp/other.sock' }]) {
    assert.equal(readCodexBackendStatus(selected, () => stale).connection, 'unknown');
  }
  assert.equal(reads, 1, 'mismatched cache entries must not even read their snapshot');
  assert.equal(readCodexBackendStatus(selected, () => undefined).connection, 'unknown');
});

it('does not look up or create a cached session for unstarted or legacy identities', () => {
  const never = () => { throw new Error('read must not prepare or recover a backend'); };
  assert.equal(readCodexBackendStatus({ id: 'new' }, never).backend, 'unstarted');
  assert.equal(readCodexBackendStatus({ id: 'legacy', runtime: { codex: { threadId: 'old' } } }, never).backend, 'legacy');
});
