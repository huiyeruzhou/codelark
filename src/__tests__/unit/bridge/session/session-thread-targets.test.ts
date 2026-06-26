import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  selectDirectThreadTarget,
  selectLocalRuntimeSessionByThreadId,
} from '../../../../bridge/session/command-use-cases/thread-targets.js';
import type { LocalRuntimeSessionSummary } from '../../../../bridge/session/command-use-cases/source.js';

function localSession(
  threadId: string,
  title: string,
  runtime: LocalRuntimeSessionSummary['runtime'] = 'codex',
): LocalRuntimeSessionSummary {
  return {
    runtime,
    threadId,
    filePath: `/tmp/${threadId}.jsonl`,
    cwd: `/tmp/${threadId}`,
    originator: runtime === 'claude' ? 'Claude Code' : runtime === 'kimi' ? 'Kimi Code' : 'Codex',
    firstSeenAt: '2026-01-01T00:00:00.000Z',
    lastEventAt: '2026-01-01T00:00:00.000Z',
    title,
    activeEstimate: false,
  };
}

const localSessions: LocalRuntimeSessionSummary[] = [
  localSession('alpha-1111', 'Alpha'),
  localSession('alpha-2222', 'Alpha Two'),
  localSession('claude-3333', 'Claude', 'claude'),
  localSession('session_kimi-4444', 'Kimi Four', 'kimi'),
  localSession('session_kimi-5555', 'Kimi Five', 'kimi'),
];

const threadDisplay = {
  bindingThreadId(binding: any) {
    return binding.threadId || '';
  },
  binding(binding: any) {
    return { title: binding.title || binding.id, threadId: binding.threadId || '' };
  },
} as any;

describe('session thread target selection', () => {
  it('selects local runtime sessions by exact id and flags ambiguous prefixes', () => {
    assert.deepEqual(selectLocalRuntimeSessionByThreadId('claude-3333', localSessions), {
      thread: localSessions[2],
      threadId: 'claude-3333',
    });

    assert.deepEqual(selectLocalRuntimeSessionByThreadId('session_kimi-4444', localSessions), {
      thread: localSessions[3],
      threadId: 'session_kimi-4444',
    });

    assert.deepEqual(selectLocalRuntimeSessionByThreadId('session_kimi-444', localSessions), {
      thread: localSessions[3],
      threadId: 'session_kimi-4444',
    });

    assert.deepEqual(selectLocalRuntimeSessionByThreadId('alpha-', localSessions), {
      ambiguous: true,
    });

    assert.deepEqual(selectLocalRuntimeSessionByThreadId('session_kimi-', localSessions), {
      ambiguous: true,
    });
  });

  it('selects global list indexes before id/name matching', () => {
    const bridgeSession = { id: 'bridge-session-1' };
    const store = {
      getSession(id: string) {
        return id === bridgeSession.id ? bridgeSession : null;
      },
    } as any;
    const selected = selectDirectThreadTarget(
      threadDisplay,
      '2',
      [],
      localSessions,
      [{ title: 'Bridge', bridgeSessionId: bridgeSession.id } as any],
      store,
      [
        { kind: 'local', local: localSessions[0] },
        { kind: 'local', local: localSessions[3] },
        { kind: 'bridge', bridge: { title: 'Bridge', bridgeSessionId: bridgeSession.id } as any },
      ],
    );

    assert.equal(selected.index, 2);
    assert.equal(selected.thread, localSessions[3]);
    assert.equal(selected.threadId, 'session_kimi-4444');

    const bridgeSelected = selectDirectThreadTarget(
      threadDisplay,
      '3',
      [],
      localSessions,
      [{ title: 'Bridge', bridgeSessionId: bridgeSession.id } as any],
      store,
      [
        { kind: 'local', local: localSessions[0] },
        { kind: 'local', local: localSessions[3] },
        { kind: 'bridge', bridge: { title: 'Bridge', bridgeSessionId: bridgeSession.id } as any },
      ],
    );

    assert.equal(bridgeSelected.index, 3);
    assert.equal(bridgeSelected.bridgeSession, bridgeSession);
  });

  it('selects Kimi local sessions by display title without confusing them with bridge sessions', () => {
    const selected = selectDirectThreadTarget(
      threadDisplay,
      'Kimi Four',
      [],
      localSessions,
    );

    assert.equal(selected.thread, localSessions[3]);
    assert.equal(selected.threadId, 'session_kimi-4444');

    assert.deepEqual(selectDirectThreadTarget(threadDisplay, 'Kimi Missing', [], localSessions), {});
  });

  it('reports ambiguous Kimi local session titles', () => {
    assert.deepEqual(
      selectDirectThreadTarget(threadDisplay, 'Kimi Duplicate', [], [
        ...localSessions,
        localSession('session_kimi-6666', 'Kimi Duplicate', 'kimi'),
        localSession('session_kimi-7777', 'Kimi Duplicate', 'kimi'),
      ]),
      { ambiguous: true },
    );
  });

  it('prefers binding thread ids and reports ambiguous binding thread prefixes', () => {
    const bindings = [
      { id: 'binding-a', threadId: 'thread-aaa', title: 'A' },
      { id: 'binding-b', threadId: 'thread-bbb', title: 'B' },
    ] as any[];

    assert.equal(
      selectDirectThreadTarget(threadDisplay, 'thread-aaa', bindings, localSessions).binding,
      bindings[0],
    );
    assert.deepEqual(selectDirectThreadTarget(threadDisplay, 'thread-', bindings, localSessions), {
      ambiguous: true,
    });
  });
});
