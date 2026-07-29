import assert from 'node:assert/strict';
import test from 'node:test';

import {
  expectedScenarioChatFinalName,
  findScenarioCreatedChatIdsInBindings,
  scenarioChatNameMatchesRequested,
} from '../../../testing/real-feishu/scenario-created-chat.js';

test('finds the /new destination from isolated bridge bindings instead of audit text', () => {
  const requestedName = 'mgmt-kimi-session-management-real-cli-fake-20260729T203142';
  const chatIds = findScenarioCreatedChatIdsInBindings({
    bindings: {
      base: {
        channelType: 'feishu-env',
        chatId: 'oc_base',
        bridgeSessionId: 'session_base',
      },
      created: {
        channelType: 'feishu-env',
        chatId: 'oc_created',
        bridgeSessionId: 'session_created',
      },
      unrelated: {
        channelType: 'feishu-env',
        chatId: 'oc_unrelated',
        bridgeSessionId: 'session_unrelated',
      },
    },
    sessions: {
      session_base: { id: 'session_base', name: 'clk-real-e2e-source' },
      session_created: { id: 'session_created', name: `[test1]${requestedName.slice(0, 54)}...` },
      session_unrelated: { id: 'session_unrelated', name: '[test1]another-session' },
    },
    requestedName,
    channelType: 'feishu-env',
    excludedChatIds: ['oc_base'],
  });

  assert.deepEqual(chatIds, ['oc_created']);
});

test('ignores malformed, cross-channel, and excluded bindings', () => {
  assert.deepEqual(findScenarioCreatedChatIdsInBindings({
    bindings: [
      null,
      { channelType: 'feishu-env', chatId: 'not-a-chat', bridgeSessionId: 'one' },
      { channelType: 'other', chatId: 'oc_other', bridgeSessionId: 'two' },
      { channelType: 'feishu-env', chatId: 'oc_excluded', bridgeSessionId: 'three' },
      { channelType: 'feishu-env', chatId: 'oc_orphan', bridgeSessionId: 'missing' },
    ],
    sessions: {
      one: { id: 'one', name: 'target' },
      two: { id: 'two', name: 'target' },
      three: { id: 'three', name: 'target' },
    },
    requestedName: 'target',
    channelType: 'feishu-env',
    excludedChatIds: ['oc_excluded'],
  }), []);
});

test('uses the last lifecycle rename as the expected final group name', () => {
  assert.equal(expectedScenarioChatFinalName({
    requestedName: 'mgmt-run',
    chatId: 'oc_created',
    observations: [
      { chatId: 'oc_created', sentText: '/clear "clear run" /workspace' },
      { chatId: 'oc_other', sentText: '/t rename unrelated' },
      { chatId: 'oc_created', sentText: '/t rename final-run' },
    ],
  }), 'final-run');
  assert.equal(
    scenarioChatNameMatchesRequested('[test1]clear-kimi-session-management-real-cli-fake-20260729T2...', 'clear-kimi-session-management-real-cli-fake-20260729T210959Z'),
    true,
  );
});
