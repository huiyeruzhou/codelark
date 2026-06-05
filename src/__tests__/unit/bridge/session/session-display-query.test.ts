import '../../../setup/test-setup.js';
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { CodexSessionSummary } from '../../../../runtime/codex/session-index.js';
import type { LocalRuntimeSessionSummary } from '../../../../bridge/session/local-runtime-session.js';
import { SessionDisplayQuery } from '../../../../bridge/session/display/session-display-query.js';
import { JsonFileStore } from '../../../../storage/json-store.js';
import { makeBridgeSettings, resetBridgeTestState } from '../../../helpers/bridge/test-bridge-utils.js';

function codexSessionSummary(overrides: Partial<CodexSessionSummary>): CodexSessionSummary {
  return {
    threadId: 'thread-default',
    filePath: '/tmp/thread-default.jsonl',
    cwd: '/tmp/default',
    originator: 'Codex Desktop',
    source: 'desktop',
    firstSeenAt: '2026-05-29T00:00:00.000Z',
    lastEventAt: '2026-05-29T00:00:00.000Z',
    title: 'Codex thread',
    activeEstimate: false,
    ...overrides,
  };
}

describe('SessionDisplayQuery', () => {
  beforeEach(() => {
    resetBridgeTestState();
  });

  it('builds UI-compatible summaries with canonical identity, CodexSource, and Creator fields', () => {
    const store = new JsonFileStore(makeBridgeSettings());
    const linked = store.createSession('Desktop: Linked workspace', 'test-model', undefined, '/repo/linked');
    store.updateSession(linked.id, { runtime: { codex: { provider: 'tmux', mode: 'yolo' } } });
    store.updateSessionCodexThreadId(linked.id, 'thread-linked');
    const bridgeOnly = store.createSession('Bridge only', 'test-model', undefined, '/repo/bridge');

    const payload = new SessionDisplayQuery(store).listSessions([
      codexSessionSummary({
        threadId: 'thread-linked',
        cwd: '/repo/codex-linked',
        title: 'Raw Codex title',
        originator: 'Codex Desktop',
        source: 'vscode',
        cliVersion: '1.2.3',
        lastEventAt: '2026-05-29T01:00:00.000Z',
      }),
      codexSessionSummary({
        threadId: 'thread-unlinked',
        cwd: '/repo/unlinked',
        title: 'Unlinked Codex',
        originator: 'Codex CLI',
        source: 'cli',
        lastEventAt: '2026-05-29T00:30:00.000Z',
      }),
    ], { root: '/codex-root' });

    assert.equal(payload.root, '/codex-root');
    assert.equal(payload.counts.codexPhysical, 2);
    assert.equal(payload.counts.bridgeStored, 2);
    assert.equal(payload.counts.bridgeWithoutCodexThread, 1);
    assert.equal(payload.counts.dedupedBridgeRows, 1);
    assert.equal(payload.counts.totalDisplayable, 3);

    const linkedRow = payload.sessions.find((session) => session.codexThreadId === 'thread-linked');
    assert.ok(linkedRow);
    assert.equal(linkedRow.kind, 'bridge');
    assert.equal(linkedRow.bridgeSessionId, linked.id);
    assert.equal(linkedRow.sessionId, linked.id);
    assert.equal(linkedRow.displayTitle, 'Linked workspace');
    assert.equal(linkedRow.title, 'Linked workspace');
    assert.equal(linkedRow.codexTitle, 'Raw Codex title');
    assert.equal(linkedRow.cwd, '/repo/linked');
    assert.equal(linkedRow.mode, 'yolo');
    assert.equal(linkedRow.executionProvider, 'tmux');
    assert.equal(linkedRow.codexProvider, 'tmux');
    assert.equal(linkedRow.creatorKind, 'bridge');
    assert.equal(linkedRow.creatorLabel, 'Bridge');
    assert.equal(linkedRow.creatorClass, 'bridge');
    assert.equal(linkedRow.codexSource, undefined);

    const bridgeOnlyRow = payload.sessions.find((session) => session.bridgeSessionId === bridgeOnly.id);
    assert.ok(bridgeOnlyRow);
    assert.equal(bridgeOnlyRow.kind, 'bridge');
    assert.equal(bridgeOnlyRow.codexThreadId, '');
    assert.equal(bridgeOnlyRow.creatorKind, 'bridge');
    assert.equal(bridgeOnlyRow.creatorLabel, 'Bridge');
    assert.equal(bridgeOnlyRow.creatorClass, 'bridge');

    const unlinkedRow = payload.sessions.find((session) => session.codexThreadId === 'thread-unlinked');
    assert.ok(unlinkedRow);
    assert.equal(unlinkedRow.bridgeSessionId, undefined);
    assert.equal(unlinkedRow.creatorKind, 'tui_cli');
    assert.equal(unlinkedRow.creatorLabel, 'TUI / CLI');
    assert.equal(unlinkedRow.creatorClass, 'tui');
    assert.equal(unlinkedRow.executionProvider, 'unknown');
    assert.equal(unlinkedRow.codexTitle, 'Unlinked Codex');
  });

  it('uses BridgeSession codex_title for linked Codex rows when name is not set', () => {
    const store = new JsonFileStore(makeBridgeSettings());
    const linked = store.createSession('', 'test-model', undefined, '/repo/linked');
    store.updateSession(linked.id, { runtime: { codex: { title: 'Stored Codex Title' } } });
    store.updateSessionCodexThreadId(linked.id, 'thread-linked');

    const payload = new SessionDisplayQuery(store).listSessions([
      codexSessionSummary({
        threadId: 'thread-linked',
        cwd: '/repo/codex-linked',
        title: 'Raw Codex title',
      }),
    ], { root: '/codex-root' });

    const linkedRow = payload.sessions.find((session) => session.codexThreadId === 'thread-linked');
    assert.ok(linkedRow);
    assert.equal(linkedRow.displayTitle, 'Stored Codex Title');
    assert.equal(linkedRow.title, 'Stored Codex Title');
    assert.equal(linkedRow.codexTitle, 'Stored Codex Title');
  });

  it('lists unbound and linked Claude Code local sessions through the runtime display interface', () => {
    const store = new JsonFileStore(makeBridgeSettings());
    const linked = store.createSession('Linked Claude', 'test-model', undefined, '/repo/linked-claude', 'normal', {
      activeRuntime: 'claude',
    });
    store.updateSession(linked.id, {
      runtime: {
        activeRuntime: 'claude',
        claude: { sessionId: 'claude-linked', cwd: '/repo/linked-claude' },
        general: { workingDirectory: '/repo/linked-claude' },
      },
    });
    const localSessions: LocalRuntimeSessionSummary[] = [
      {
        runtime: 'claude',
        threadId: 'claude-linked',
        filePath: '/tmp/claude-linked.jsonl',
        cwd: '/repo/linked-claude',
        originator: 'Claude Code',
        source: 'claude',
        firstSeenAt: '2026-06-02T00:00:00.000Z',
        lastEventAt: '2026-06-02T00:00:01.000Z',
        title: 'Raw linked Claude',
        activeEstimate: false,
      },
      {
        runtime: 'claude',
        threadId: 'claude-unbound',
        filePath: '/tmp/claude-unbound.jsonl',
        cwd: '/repo/unbound-claude',
        originator: 'Claude Code',
        source: 'claude',
        firstSeenAt: '2026-06-02T00:00:02.000Z',
        lastEventAt: '2026-06-02T00:00:03.000Z',
        title: 'Unbound Claude',
        activeEstimate: false,
      },
    ];

    const payload = new SessionDisplayQuery(store).listRuntimeSessions(localSessions, { root: '/codex-root' });

    assert.equal(payload.counts.claudePhysical, 2);
    assert.equal(payload.counts.bridgeClaudeLinked, 1);
    assert.equal(payload.counts.dedupedBridgeRows, 1);
    const linkedRow = payload.sessions.find((session) => session.bridgeSessionId === linked.id);
    assert.ok(linkedRow);
    assert.equal(linkedRow.kind, 'bridge');
    assert.equal(linkedRow.runtime, 'claude');
    assert.equal(linkedRow.claudeSessionId, 'claude-linked');
    assert.equal(linkedRow.threadId, 'claude-linked');

    const unboundRow = payload.sessions.find((session) => session.claudeSessionId === 'claude-unbound');
    assert.ok(unboundRow);
    assert.equal(unboundRow.kind, 'claude');
    assert.equal(unboundRow.runtime, 'claude');
    assert.equal(unboundRow.bridgeSessionId, undefined);
    assert.equal(unboundRow.executionProvider, 'pty');
    assert.equal(unboundRow.codexProvider, '-');
  });
});
