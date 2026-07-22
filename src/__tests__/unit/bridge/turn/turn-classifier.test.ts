import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyInteractiveTurn,
  getCodexThreadId,
} from '../../../../bridge/turn/turn-classifier.js';
import type { BridgeSession } from '../../../../domain/index.js';
import type { ChannelChat } from '../../../../domain/index.js';

function binding(overrides: Partial<ChannelChat> = {}): ChannelChat {
  return {
    id: 'binding-1',
    channelType: 'feishu-default',
    chatId: 'chat-1',
    bridgeSessionId: 'session-1',
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-01T00:00:00.000Z',
    ...overrides,
  };
}

function session(overrides: Partial<BridgeSession> = {}): BridgeSession {
  return {
    id: 'session-1',
    name: 'session',
    runtime: {
      codex: { model: 'gpt-test' },
      general: { workingDirectory: '/tmp/project' },
    },
    ...overrides,
  };
}

describe('turn-classifier', () => {
  it('classifies sessions whose Codex thread is not locally visible as pure IM SDK', () => {
    const currentSession = session({
      runtime: { codex: { threadId: 'codex-thread-1' } },
    });
    const result = classifyInteractiveTurn(
      binding(),
      currentSession,
      () => false,
    );

    assert.equal(result.kind, 'im_sdk');
    assert.equal(result.reason, 'bridge_thread');
    assert.equal(result.codexThreadId, 'codex-thread-1');
    assert.equal(result.codexThreadAvailable, false);
  });

  it('classifies sessions with a locally visible Codex thread as IM Codex reuse', () => {
    const currentSession = session({
      runtime: { codex: { threadId: 'codex-thread-1' } },
    });
    const result = classifyInteractiveTurn(
      binding(),
      currentSession,
      (threadId) => threadId === 'codex-thread-1',
    );

    assert.equal(result.kind, 'im_codex_reuse');
    assert.equal(result.reason, 'codex_thread');
    assert.equal(result.codexThreadId, 'codex-thread-1');
    assert.equal(result.codexThreadAvailable, true);
  });

  it('classifies Kimi sessions as pure IM SDK even when a stale Codex thread is present', () => {
    const currentSession = session({
      runtime: {
        activeRuntime: 'kimi',
        codex: { threadId: 'stale-codex-thread' },
        kimi: {
          provider: 'tmux',
          sessionId: 'session_kimi_classifier',
          cwd: '/tmp/project',
        },
      },
    } as unknown as BridgeSession);
    const lookedUpThreadIds: string[] = [];

    const result = classifyInteractiveTurn(
      binding(),
      currentSession,
      (threadId) => {
        lookedUpThreadIds.push(threadId);
        return true;
      },
    );

    assert.equal(
      (currentSession.runtime as { codex?: { threadId?: string } })?.codex?.threadId,
      'stale-codex-thread',
    );
    assert.equal(getCodexThreadId(currentSession), undefined);
    assert.equal(result.kind, 'im_sdk');
    assert.equal(result.reason, 'runtime_kimi');
    assert.equal(result.codexThreadId, undefined);
    assert.equal(result.codexThreadAvailable, false);
    assert.deepEqual(lookedUpThreadIds, []);
  });

  it('does not read legacy thread fields from bindings or session fallbacks', () => {
    const currentSession = session({
      runtime: { codex: { threadId: 'codex-thread-only' } },
    });

    assert.equal(getCodexThreadId(currentSession), 'codex-thread-only');
  });
});
