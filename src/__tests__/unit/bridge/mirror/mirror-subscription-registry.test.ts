import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildMirrorSubscriptionRegistryPlan,
  getMirrorRegistryBindingActivityTier,
  isMirrorRegistryBindingActive,
  type MirrorRegistrySession,
} from '../../../../bridge/mirror/subscription-registry.js';

function hasCodexThreadMirrorSource(session: MirrorRegistrySession | null | undefined): boolean {
  const activeRuntime = session?.runtime?.activeRuntime;
  return (activeRuntime === undefined || activeRuntime === 'codex')
    && Boolean(session?.runtime?.codex?.threadId?.trim());
}

describe('mirror-subscription-registry', () => {
  it('keeps channel chats that have a running channel and resolve to a Codex thread', () => {
    const bindings = [
      {
        id: 'ignore-bridge-sdk-thread',
        channelType: 'feishu-default',
        bridgeSessionId: 'session-1',
      },
      {
        id: 'keep-from-session',
        channelType: 'feishu-default',
        bridgeSessionId: 'session-2',
      },
      {
        id: 'keep-second-chat',
        channelType: 'feishu-default',
        bridgeSessionId: 'session-3',
      },
      {
        id: 'missing-channel',
        channelType: 'feishu-missing',
        bridgeSessionId: 'session-4',
      },
      {
        id: 'missing-thread',
        channelType: 'feishu-default',
        bridgeSessionId: 'session-5',
      },
    ];

    const plan = buildMirrorSubscriptionRegistryPlan(
      bindings,
      ['feishu-default'],
      [],
      (sessionId) => {
        if (sessionId === 'session-1') {
          return {};
        }
        if (sessionId === 'session-2') {
          return { runtime: { codex: { threadId: 'thread-2' } } };
        }
        if (sessionId === 'session-3') {
          return { runtime: { codex: { threadId: 'thread-3' } } };
        }
        if (sessionId === 'session-5') {
          return { runtime: { codex: { threadId: '' } } };
        }
        return null;
      },
      hasCodexThreadMirrorSource,
    );

    assert.deepEqual(
      plan.upsertBindings.map((binding) => binding.id),
      ['keep-from-session', 'keep-second-chat'],
    );
    assert.deepEqual(plan.removeBindingIds, []);
  });

  it('removes subscriptions that are no longer desired', () => {
    const plan = buildMirrorSubscriptionRegistryPlan(
      [
        {
          id: 'binding-1',
          channelType: 'feishu-default',
          bridgeSessionId: 'session-1',
        },
      ],
      ['feishu-default'],
      ['binding-1', 'binding-2', 'binding-3'],
      () => ({ runtime: { codex: { threadId: 'thread-1' } } }),
      hasCodexThreadMirrorSource,
    );

    assert.deepEqual(plan.upsertBindings.map((binding) => binding.id), ['binding-1']);
    assert.deepEqual(plan.removeBindingIds, ['binding-2', 'binding-3']);
  });

  it('delegates Codex SDK suppression to the caller policy', () => {
    const plan = buildMirrorSubscriptionRegistryPlan(
      [
        {
          id: 'sdk-binding',
          channelType: 'feishu-default',
          bridgeSessionId: 'sdk-session',
        },
        {
          id: 'legacy-binding',
          channelType: 'feishu-default',
          bridgeSessionId: 'legacy-session',
        },
      ],
      ['feishu-default'],
      ['sdk-binding'],
      (sessionId) => {
        if (sessionId === 'sdk-session') {
          return { runtime: { codex: { threadId: 'sdk-thread' } } };
        }
        if (sessionId === 'legacy-session') {
          return { runtime: { codex: { threadId: 'legacy-thread' } } };
        }
        return null;
      },
      (session) => hasCodexThreadMirrorSource(session)
        && session?.runtime?.codex?.threadId !== 'sdk-thread',
    );

    assert.deepEqual(plan.upsertBindings.map((binding) => binding.id), ['legacy-binding']);
    assert.deepEqual(plan.removeBindingIds, ['sdk-binding']);
  });

  it('does not plan Codex mirror subscriptions for Kimi runtime sessions with stale Codex thread ids', () => {
    const plan = buildMirrorSubscriptionRegistryPlan(
      [
        {
          id: 'kimi-binding',
          channelType: 'feishu-default',
          bridgeSessionId: 'kimi-session',
        },
        {
          id: 'codex-binding',
          channelType: 'feishu-default',
          bridgeSessionId: 'codex-session',
        },
      ],
      ['feishu-default'],
      ['kimi-binding'],
      (sessionId) => {
        if (sessionId === 'kimi-session') {
          return {
            runtime: {
              activeRuntime: 'kimi',
              codex: { threadId: 'stale-codex-thread' },
              kimi: { sessionId: 'session_kimi_live', cwd: '/tmp/kimi' },
            },
          };
        }
        if (sessionId === 'codex-session') {
          return {
            runtime: {
              activeRuntime: 'codex',
              codex: { threadId: 'codex-thread' },
            },
          };
        }
        return null;
      },
      hasCodexThreadMirrorSource,
    );

    assert.deepEqual(plan.upsertBindings.map((binding) => binding.id), ['codex-binding']);
    assert.deepEqual(plan.removeBindingIds, ['kimi-binding']);
  });

  it('does not mirror cloud document virtual chats through IM delivery', () => {
    const plan = buildMirrorSubscriptionRegistryPlan(
      [
        {
          id: 'doc-binding',
          channelType: 'feishu-default',
          chatId: 'doc:docx:doc-token',
          bridgeSessionId: 'doc-session',
        },
        {
          id: 'group-binding',
          channelType: 'feishu-default',
          chatId: 'oc_group',
          bridgeSessionId: 'group-session',
        },
      ],
      ['feishu-default'],
      ['doc-binding'],
      () => ({ runtime: { codex: { threadId: 'thread-1' } } }),
      hasCodexThreadMirrorSource,
    );

    assert.deepEqual(plan.upsertBindings.map((binding) => binding.id), ['group-binding']);
    assert.deepEqual(plan.removeBindingIds, ['doc-binding']);
  });

  it('keeps cold channel chats desired while classifying their activity tier separately', () => {
    const nowMs = Date.parse('2026-06-05T03:30:00.000Z');
    const hotBinding = {
      id: 'hot-binding',
      channelType: 'feishu-default',
      chatId: 'oc_hot',
      bridgeSessionId: 'hot-session',
      updatedAt: '2026-06-05T02:00:00.000Z',
      lastActivityAt: '2026-06-05T03:20:00.000Z',
    };
    const coldBinding = {
      id: 'cold-binding',
      channelType: 'feishu-default',
      chatId: 'oc_cold',
      bridgeSessionId: 'cold-session',
      updatedAt: '2026-06-05T02:20:00.000Z',
    };
    const plan = buildMirrorSubscriptionRegistryPlan(
      [hotBinding, coldBinding],
      ['feishu-default'],
      ['hot-binding', 'cold-binding'],
      () => ({ runtime: { codex: { threadId: 'thread-1' } } }),
      hasCodexThreadMirrorSource,
      { activeBindingWindowMs: 30 * 60_000, nowMs },
    );

    assert.deepEqual(plan.upsertBindings.map((binding) => binding.id), ['hot-binding', 'cold-binding']);
    assert.deepEqual(plan.removeBindingIds, []);
    assert.equal(getMirrorRegistryBindingActivityTier(hotBinding, { activeBindingWindowMs: 30 * 60_000, nowMs }), 'hot');
    assert.equal(getMirrorRegistryBindingActivityTier(coldBinding, { activeBindingWindowMs: 30 * 60_000, nowMs }), 'cold');
  });

  it('falls back to metadata timestamps when lastActivityAt has not been migrated yet', () => {
    const nowMs = Date.parse('2026-06-05T03:30:00.000Z');

    assert.equal(getMirrorRegistryBindingActivityTier({
      id: 'legacy-binding',
      channelType: 'feishu-default',
      bridgeSessionId: 'session-1',
      updatedAt: '2026-06-05T03:20:00.000Z',
    }, { activeBindingWindowMs: 30 * 60_000, nowMs }), 'hot');
  });

  it('treats bindings as active when no active window is configured', () => {
    assert.equal(isMirrorRegistryBindingActive({
      id: 'binding-without-time',
      channelType: 'feishu-default',
      bridgeSessionId: 'session-1',
    }), true);
  });
});
