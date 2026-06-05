import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createTurnCoordinator } from '../../../../bridge/turn/turn-coordinator.js';
import type { ActiveBridgeTurn, BridgeTurnTerminalRecord } from '../../../../bridge/turn/turn-types.js';

function activeTurn(overrides: Partial<ActiveBridgeTurn> = {}): ActiveBridgeTurn {
  return {
    id: 'turn-1',
    sessionId: 'session-1',
    kind: 'im_codex_reuse',
    origin: 'im',
    progressSource: 'sdk_stream',
    finalSource: 'codex_task_complete',
    codexThreadId: 'codex-thread-1',
    startedAt: 1000,
    ...overrides,
  };
}

function terminal(overrides: Partial<BridgeTurnTerminalRecord> = {}): BridgeTurnTerminalRecord {
  return {
    sessionId: 'session-1',
    codexThreadId: 'codex-thread-1',
    turnId: 'codex-turn-1',
    text: 'final answer',
    outcome: 'completed',
    timestamp: '2026-04-27T00:00:00.000Z',
    ...overrides,
  };
}

describe('turn-coordinator', () => {
  it('claims a Codex terminal for the active IM Codex reuse turn', async () => {
    const finalized: string[] = [];
    const coordinator = createTurnCoordinator({
      finalizeTerminalTurn: async (turn, record) => {
        finalized.push(`${turn.id}:${record.text}`);
        return true;
      },
    });
    coordinator.registerInteractiveTurn(activeTurn());

    const result = await coordinator.claimCodexTerminal(terminal());

    assert.equal(result.claimed, true);
    assert.equal(result.turn?.id, 'turn-1');
    assert.deepEqual(finalized, ['turn-1:final answer']);
  });

  it('does not claim terminals for pure IM SDK turns', async () => {
    const coordinator = createTurnCoordinator({
      finalizeTerminalTurn: async () => {
        throw new Error('should not finalize');
      },
    });
    coordinator.registerInteractiveTurn(activeTurn({
      kind: 'im_sdk',
      codexThreadId: undefined,
      finalSource: 'sdk_result',
    }));

    const result = await coordinator.claimCodexTerminal(terminal());

    assert.equal(result.claimed, false);
  });

  it('claims a Codex terminal for a new IM Codex mirror turn after the thread id is discovered', async () => {
    const finalized: string[] = [];
    const coordinator = createTurnCoordinator({
      finalizeTerminalTurn: async (turn, record) => {
        finalized.push(`${turn.progressSource}:${record.codexThreadId}:${record.text}`);
        return true;
      },
    });
    coordinator.registerInteractiveTurn(activeTurn({
      kind: 'im_sdk',
      progressSource: 'codex_jsonl',
      finalSource: 'codex_task_complete',
      codexThreadId: undefined,
    }));

    const result = await coordinator.claimCodexTerminal(terminal({
      codexThreadId: 'new-codex-thread',
    }));

    assert.equal(result.claimed, true);
    assert.equal(result.turn?.id, 'turn-1');
    assert.deepEqual(finalized, ['codex_jsonl:new-codex-thread:final answer']);
  });

  it('does not claim terminals from another Codex thread', async () => {
    const coordinator = createTurnCoordinator({
      finalizeTerminalTurn: async () => true,
    });
    coordinator.registerInteractiveTurn(activeTurn());

    const result = await coordinator.claimCodexTerminal(terminal({
      codexThreadId: 'other-thread',
    }));

    assert.equal(result.claimed, false);
  });

  it('claims a Claude terminal for the active Claude runtime IM turn', async () => {
    const finalized: string[] = [];
    const coordinator = createTurnCoordinator({
      finalizeTerminalTurn: async (turn, record) => {
        finalized.push(`${turn.runtime}:${record.runtime}:${record.threadId}:${record.text}`);
        return true;
      },
    });
    coordinator.registerInteractiveTurn(activeTurn({
      kind: 'im_sdk',
      runtime: 'claude',
      runtimeThreadId: 'claude-session-1',
      codexThreadId: undefined,
      finalSource: 'claude_task_complete',
    }));

    const result = await coordinator.claimRuntimeTerminal({
      runtime: 'claude',
      sessionId: 'session-1',
      threadId: 'claude-session-1',
      codexThreadId: '',
      turnId: 'claude-turn-1',
      text: 'claude final answer',
      outcome: 'completed',
      timestamp: '2026-04-27T00:00:00.000Z',
    });

    assert.equal(result.claimed, true);
    assert.equal(result.turn?.id, 'turn-1');
    assert.deepEqual(finalized, ['claude:claude:claude-session-1:claude final answer']);
  });

  it('does not claim Claude terminals for a different Claude session id', async () => {
    const coordinator = createTurnCoordinator({
      finalizeTerminalTurn: async () => true,
    });
    coordinator.registerInteractiveTurn(activeTurn({
      kind: 'im_sdk',
      runtime: 'claude',
      runtimeThreadId: 'claude-session-1',
      codexThreadId: undefined,
      finalSource: 'claude_task_complete',
    }));

    const result = await coordinator.claimRuntimeTerminal({
      runtime: 'claude',
      sessionId: 'session-1',
      threadId: 'other-claude-session',
      codexThreadId: '',
      text: 'other final answer',
      outcome: 'completed',
      timestamp: '2026-04-27T00:00:00.000Z',
    });

    assert.equal(result.claimed, false);
  });

  it('does not claim Claude terminals for normal Claude SDK turns that use mirror delivery', async () => {
    const coordinator = createTurnCoordinator({
      finalizeTerminalTurn: async () => true,
    });
    coordinator.registerInteractiveTurn(activeTurn({
      kind: 'im_sdk',
      runtime: 'claude',
      runtimeThreadId: 'claude-session-1',
      codexThreadId: undefined,
      finalSource: 'sdk_result',
    }));

    const result = await coordinator.claimRuntimeTerminal({
      runtime: 'claude',
      sessionId: 'session-1',
      threadId: 'claude-session-1',
      codexThreadId: '',
      text: 'claude final answer',
      outcome: 'completed',
      timestamp: '2026-04-27T00:00:00.000Z',
    });

    assert.equal(result.claimed, false);
  });
});
