import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildMirrorSubscriptionRegistryPlan,
  getMirrorRegistryBindingActivityTier,
  isMirrorRegistryBindingActive,
} from '../../../../bridge/mirror/subscription-registry.js';

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
          return { runtime: { codex: { threadId: 'thread-2', provider: 'pty' } } };
        }
        if (sessionId === 'session-3') {
          return { runtime: { codex: { threadId: 'thread-3', provider: 'tmux' } } };
        }
        if (sessionId === 'session-5') {
          return { runtime: { codex: { threadId: '' } } };
        }
        return null;
      },
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
    );

    assert.deepEqual(plan.upsertBindings.map((binding) => binding.id), ['binding-1']);
    assert.deepEqual(plan.removeBindingIds, ['binding-2', 'binding-3']);
  });

  it('does not create mirror subscriptions for Codex SDK sessions', () => {
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
          return { runtime: { codex: { threadId: 'sdk-thread', provider: 'sdk' } } };
        }
        if (sessionId === 'legacy-session') {
          return { runtime: { codex: { threadId: 'legacy-thread' } } };
        }
        return null;
      },
    );

    assert.deepEqual(plan.upsertBindings.map((binding) => binding.id), ['legacy-binding']);
    assert.deepEqual(plan.removeBindingIds, ['sdk-binding']);
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
      () => ({ runtime: { codex: { threadId: 'thread-1', provider: 'pty' } } }),
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
      () => ({ runtime: { codex: { threadId: 'thread-1', provider: 'pty' } } }),
      undefined,
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
