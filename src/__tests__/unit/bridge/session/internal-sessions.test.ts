import '../../../setup/test-setup.js';
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as router from '../../../../bridge/session/channel-router.js';
import { resetDraftSession } from '../../../../bridge/session/internal-sessions.js';
import {
  initBridgeTestContext,
  makeBridgeSettings,
  resetBridgeTestState,
} from '../../../helpers/bridge/test-bridge-utils.js';

describe('chat-scoped draft sessions', () => {
  beforeEach(() => {
    resetBridgeTestState();
  });

  it('keeps a group and private chat isolated when the same user opens both', () => {
    const store = initBridgeTestContext({ settings: makeBridgeSettings() });
    const userId = 'ou_same_user';
    const privateAddress = {
      channelType: 'feishu-default',
      chatId: 'oc_private_chat',
      chatKind: 'p2p' as const,
      userId,
    };
    const groupAddress = {
      channelType: 'feishu-default',
      chatId: 'oc_group_chat',
      chatKind: 'group' as const,
      userId,
    };

    const privateBinding = router.resolve(privateAddress);
    const groupBinding = router.resolve(groupAddress);

    assert.notEqual(privateBinding.bridgeSessionId, groupBinding.bridgeSessionId);
    assert.equal(store.getChannelChat(privateAddress.channelType, privateAddress.chatId)?.bridgeSessionId, privateBinding.bridgeSessionId);
    assert.equal(store.getChannelChat(groupAddress.channelType, groupAddress.chatId)?.bridgeSessionId, groupBinding.bridgeSessionId);
  });

  it('resets only the requesting chat draft when two chats have the same user label', () => {
    const store = initBridgeTestContext({ settings: makeBridgeSettings() });
    const userId = 'ou_same_user';
    const privateAddress = {
      channelType: 'feishu-default',
      chatId: 'oc_private_reset',
      chatKind: 'p2p' as const,
      userId,
    };
    const groupAddress = {
      channelType: 'feishu-default',
      chatId: 'oc_group_reset',
      chatKind: 'group' as const,
      userId,
    };
    const privateBinding = router.resolve(privateAddress);
    const groupBinding = router.resolve(groupAddress);

    const nextPrivateDraft = resetDraftSession(store, privateAddress);

    assert.notEqual(nextPrivateDraft.id, privateBinding.bridgeSessionId);
    assert.equal(store.getSession(privateBinding.bridgeSessionId), null);
    assert.ok(store.getSession(groupBinding.bridgeSessionId));
    assert.equal(store.getChannelChat(groupAddress.channelType, groupAddress.chatId)?.bridgeSessionId, groupBinding.bridgeSessionId);
  });
});
