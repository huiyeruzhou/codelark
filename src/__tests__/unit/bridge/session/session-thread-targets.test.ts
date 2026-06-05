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
    originator: runtime === 'claude' ? 'Claude Code' : 'Codex',
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

    assert.deepEqual(selectLocalRuntimeSessionByThreadId('alpha-', localSessions), {
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
        { kind: 'bridge', bridge: { title: 'Bridge', bridgeSessionId: bridgeSession.id } as any },
      ],
    );

    assert.equal(selected.index, 2);
    assert.equal(selected.bridgeSession, bridgeSession);
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
