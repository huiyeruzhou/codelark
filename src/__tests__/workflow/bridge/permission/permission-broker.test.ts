import '../../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  claimCodexSelectionCallback,
  forwardPermissionRequest,
  handlePermissionCallback,
  waitForCodexTuiSelectionPermission,
} from '../../../../bridge/permission/broker.js';
import {
  initBridgeTestContext,
  RecordingAdapter,
} from '../../../helpers/bridge/test-bridge-utils.js';

describe('permission-broker', () => {
  it('renders Codex trust prompts as explicit trust confirmations', async () => {
    const store = initBridgeTestContext();
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-codex-trust-permission' } as const;
    const permissionRequestId = 'codex-trust:pty:session-1:1';

    await forwardPermissionRequest(
      adapter,
      address,
      permissionRequestId,
      'Codex Trust Directory',
      {
        provider: 'pty',
        workingDirectory: '/tmp/project',
        inspect: '/pty-screen 80',
      },
      'session-1',
    );

    const message = adapter.sent.at(-1);
    assert.ok(message);
    assert.equal(message.parseMode, 'HTML');
    assert.match(message.text, /Codex Trust Confirmation/);
    assert.match(message.text, /Directory: \/tmp\/project/);
    assert.match(message.text, /Inspect current screen: \/pty-screen 80/);
    assert.deepEqual(message.inlineButtons?.flat().map((button) => button.text), [
      'Trust and continue',
      'Deny',
    ]);
    assert.equal(store.getPermissionLink(permissionRequestId)?.sessionId, 'session-1');
  });

  it('keeps regular permission prompts on allow, allow-session, and deny actions', async () => {
    initBridgeTestContext();
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-regular-permission' } as const;

    await forwardPermissionRequest(
      adapter,
      address,
      'regular-permission-1',
      'Bash',
      { command: 'npm test' },
      'session-regular',
    );

    const message = adapter.sent.at(-1);
    assert.ok(message);
    assert.match(message.text, /Permission Required/);
    assert.deepEqual(message.inlineButtons?.flat().map((button) => button.text), [
      'Allow',
      'Allow Session',
      'Deny',
    ]);
  });

  it('renders Codex TUI selection prompts as rich-card selects', async () => {
    const store = initBridgeTestContext();
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-codex-update-permission' } as const;
    const permissionRequestId = 'codex-selection:update:tmux:session-2:1';

    await forwardPermissionRequest(
      adapter,
      address,
      permissionRequestId,
      'Codex TUI Selection Prompt',
      {
        provider: 'tmux',
        inspect: '/tmux-screen 80',
        promptKind: 'update',
        prompt: [
          'Update available! 0.135.0 -> 0.136.0',
          '› 1. Update now (runs `npm install -g @openai/codex`)',
          '  2. Skip',
          '  3. Skip until next version',
        ].join('\n'),
      },
      'session-2',
    );

    const message = adapter.sent.at(-1);
    assert.ok(message);
    assert.equal(message.parseMode, 'HTML');
    assert.match(message.text, /Codex TUI Selection/);
    assert.equal(message.inlineButtons, undefined);
    assert.equal(message.richCard?.title, 'Codex TUI Selection');
    assert.deepEqual(message.richCard?.selects?.[0]?.options.map((option) => option.text), [
      'Update now',
      'Skip',
      'Skip until next version',
    ]);
    assert.match(
      message.richCard?.selects?.[0]?.options[2]?.callbackData || '',
      /^codex-tui-selection-choice:codex-selection%3Aupdate%3Atmux%3Asession-2%3A1:skip_until_next_version$/,
    );
    assert.equal(store.getPermissionLink(permissionRequestId)?.messageId, 'reply-1');
  });

  it('renders generic Codex TUI selections with a not-selection escape option', async () => {
    initBridgeTestContext();
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-codex-generic-selection' } as const;
    const permissionRequestId = 'codex-selection:generic:tmux:session-generic:1';

    await forwardPermissionRequest(
      adapter,
      address,
      permissionRequestId,
      'Codex TUI Selection Prompt',
      {
        provider: 'tmux',
        inspect: '/tmux-screen 80',
        promptKind: 'generic',
        defaultChoice: 'not_selection',
        choices: [
          { choice: 'option_1', label: 'Experimental profile', selected: true },
          { choice: 'option_2', label: 'Default profile' },
          { choice: 'not_selection', label: '这不是TUI选择' },
        ],
      },
      'session-generic',
    );

    const options = adapter.sent.at(-1)?.richCard?.selects?.[0]?.options || [];
    assert.deepEqual(options.map((option) => option.text), [
      'Experimental profile',
      'Default profile',
      '这不是TUI选择',
    ]);
    assert.match(options[2]?.callbackData || '', /:not_selection$/);
  });

  it('resolves Codex TUI selection callbacks to the selected choice', async () => {
    let resolved: { id: string; behavior: string; message?: string } | null = null;
    const store = initBridgeTestContext({
      permissions: {
        resolvePendingPermission: (id, resolution) => {
          resolved = { id, behavior: resolution.behavior, message: resolution.message };
          return true;
        },
      },
    });
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-codex-update-callback' } as const;
    const permissionRequestId = 'codex-selection:permission:tmux:session-4:1';

    await forwardPermissionRequest(
      adapter,
      address,
      permissionRequestId,
      'Codex TUI Selection Prompt',
      {
        provider: 'tmux',
        inspect: '/tmux-screen 80',
        promptKind: 'permission',
        choices: [
          { choice: 'yes_proceed', label: 'Yes, proceed (y)', selected: true },
          { choice: 'yes_always', label: "Yes, and don't ask again for these files (a)" },
          { choice: 'no', label: 'No, and tell Codex what to do differently (esc)' },
        ],
      },
      'session-4',
    );
    const waiter = waitForCodexTuiSelectionPermission(permissionRequestId, 1_000);
    const callbackData = adapter.sent.at(-1)?.richCard?.selects?.[0]?.options[1]?.callbackData || '';
    assert.equal(handlePermissionCallback(callbackData, address.chatId, 'reply-1'), true);
    assert.equal(await waiter, 'yes_always');
    assert.deepEqual(resolved, {
      id: permissionRequestId,
      behavior: 'allow',
      message: 'yes_always',
    });
    assert.equal(store.getPermissionLink(permissionRequestId)?.resolved, true);
  });

  it('classifies mirror Codex TUI selection callbacks with no live waiter as orphaned', async () => {
    const store = initBridgeTestContext();
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-codex-mirror-orphan' } as const;
    const permissionRequestId = 'codex-selection:permission:mirror:session-after-restart:1';

    await forwardPermissionRequest(
      adapter,
      address,
      permissionRequestId,
      'Codex TUI Selection Prompt',
      {
        provider: 'tmux',
        inspect: '/tmux-screen 80',
        promptKind: 'permission',
        choices: [
          { choice: 'yes_proceed', label: 'Yes, proceed (y)', selected: true },
          { choice: 'no', label: 'No, and tell Codex what to do differently (esc)' },
        ],
      },
      'session-after-restart',
    );

    const callbackData = adapter.sent.at(-1)?.richCard?.selects?.[0]?.options[0]?.callbackData || '';
    const claim = claimCodexSelectionCallback(callbackData, address.chatId, 'reply-1');
    assert.ok(claim);
    assert.equal(claim.handledBy, 'orphan');
    assert.equal(claim.permissionRequestId, permissionRequestId);
    assert.equal(claim.choice, 'yes_proceed');
    assert.equal(claim.link.sessionId, 'session-after-restart');
    assert.equal(store.getPermissionLink(permissionRequestId)?.resolved, true);
  });

  it('rejects allow-session callbacks for Codex trust prompts', async () => {
    const store = initBridgeTestContext();
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-trust-no-session-allow' } as const;
    const permissionRequestId = 'codex-trust:pty:session-3:1';

    await forwardPermissionRequest(
      adapter,
      address,
      permissionRequestId,
      'Codex Trust Directory',
      {
        provider: 'pty',
        workingDirectory: '/tmp/no-session-allow',
      },
      'session-3',
    );

    assert.equal(handlePermissionCallback(`perm:allow_session:${permissionRequestId}`, address.chatId), false);
    assert.equal(store.getPermissionLink(permissionRequestId)?.resolved, false);
  });
});
