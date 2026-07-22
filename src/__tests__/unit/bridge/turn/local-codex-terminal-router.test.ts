import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { routeCodexRecords, routeRuntimeRecords } from '../../../../bridge/turn/local-codex-terminal-router.js';
import type { BridgeMirrorRecord } from '../../../../runtime/contracts.js';
import type { TurnCoordinator } from '../../../../bridge/turn/turn-coordinator.js';

function record(
  signature: string,
  type: BridgeMirrorRecord['type'],
  content: string,
  turnId = 'codex-turn-1',
): BridgeMirrorRecord {
  return {
    signature,
    type,
    content,
    timestamp: '2026-04-27T00:00:00.000Z',
    turnId,
  };
}

describe('local-codex-terminal-router', () => {
  it('claims terminal records and removes the claimed turn from mirror delivery', async () => {
    const claims: string[] = [];
    const coordinator: Pick<TurnCoordinator, 'claimCodexTerminal'> = {
      claimCodexTerminal: async (terminal) => {
        claims.push(`${terminal.codexThreadId}:${terminal.text}`);
        return { claimed: true };
      },
    };
    const records = [
      record('message-1', 'message', 'partial'),
      record('terminal-1', 'task_complete', 'final'),
      record('other-1', 'message', 'other turn', 'other-turn'),
    ];

    const result = await routeCodexRecords('session-1', 'codex-thread-1', records, coordinator);

    assert.equal(result.terminalClaimed, true);
    assert.deepEqual(result.claimed.map((item) => item.signature), ['message-1', 'terminal-1']);
    assert.deepEqual(result.unclaimed.map((item) => item.signature), ['other-1']);
    assert.deepEqual(claims, ['codex-thread-1:final']);
  });

  it('leaves records unclaimed when no active IM turn accepts the terminal', async () => {
    const coordinator: Pick<TurnCoordinator, 'claimCodexTerminal'> = {
      claimCodexTerminal: async () => ({ claimed: false }),
    };
    const records = [
      record('message-1', 'message', 'partial'),
      record('terminal-1', 'task_aborted', 'stopped'),
    ];

    const result = await routeCodexRecords('session-1', 'codex-thread-1', records, coordinator);

    assert.equal(result.terminalClaimed, false);
    assert.deepEqual(result.claimed, []);
    assert.deepEqual(result.unclaimed, records);
  });

  it('routes Claude terminal records through the same runtime claim interface', async () => {
    const claims: string[] = [];
    const coordinator: Pick<TurnCoordinator, 'claimRuntimeTerminal'> = {
      claimRuntimeTerminal: async (terminal) => {
        claims.push(`${terminal.runtime}:${terminal.threadId}:${terminal.text}`);
        return { claimed: true };
      },
    };
    const records = [
      record('claude-message-1', 'message', 'partial', 'claude-turn-1'),
      record('claude-terminal-1', 'task_complete', 'final', 'claude-turn-1'),
      record('other-1', 'message', 'other turn', 'other-turn'),
    ];

    const result = await routeRuntimeRecords('session-1', 'claude', 'claude-session-1', records, coordinator);

    assert.equal(result.terminalClaimed, true);
    assert.deepEqual(result.claimed.map((item) => item.signature), ['claude-message-1', 'claude-terminal-1']);
    assert.deepEqual(result.unclaimed.map((item) => item.signature), ['other-1']);
    assert.deepEqual(claims, ['claude:claude-session-1:final']);
  });

  it('routes Kimi terminal records through the same runtime claim interface', async () => {
    const claims: string[] = [];
    const coordinator: Pick<TurnCoordinator, 'claimRuntimeTerminal'> = {
      claimRuntimeTerminal: async (terminal) => {
        claims.push(`${terminal.runtime}:${terminal.threadId}:${terminal.text}`);
        return { claimed: true };
      },
    };
    const records = [
      record('kimi-message-1', 'message', 'partial', 'kimi-turn-1'),
      record('kimi-terminal-1', 'task_complete', 'final', 'kimi-turn-1'),
      record('other-1', 'message', 'other turn', 'other-turn'),
    ];

    const result = await routeRuntimeRecords('session-1', 'kimi', 'session_kimi-1', records, coordinator);

    assert.equal(result.terminalClaimed, true);
    assert.deepEqual(result.claimed.map((item) => item.signature), ['kimi-message-1', 'kimi-terminal-1']);
    assert.deepEqual(result.unclaimed.map((item) => item.signature), ['other-1']);
    assert.deepEqual(claims, ['kimi:session_kimi-1:final']);
  });
});
