import '../../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  cancelCodexTuiSelectionWaitersForSession,
  claimCodexSelectionCallback,
  forwardPermissionRequest as forwardPermissionRequestWithoutDeliveryWait,
  handlePermissionCallback,
  waitForCodexTuiSelectionPermission,
} from '../../../../bridge/permission/broker.js';
import { _testOnlyWaitForDeliveryQueuesForTests } from '../../../../channels/delivery/deliver.js';
import {
  initBridgeTestContext,
  RecordingAdapter,
} from '../../../helpers/bridge/test-bridge-utils.js';

async function forwardPermissionRequest(
  ...args: Parameters<typeof forwardPermissionRequestWithoutDeliveryWait>
): Promise<void> {
  forwardPermissionRequestWithoutDeliveryWait(...args);
  await _testOnlyWaitForDeliveryQueuesForTests(args[0]);
}

describe('permission-broker', () => {
  it('cancels an outstanding Codex selection waiter when clear replaces its session', async () => {
    initBridgeTestContext();
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-selection-clear-cancel' } as const;
    const permissionRequestId = 'codex-selection:generic:provider-startup:session-clear-cancel:1';
    const choice = waitForCodexTuiSelectionPermission(permissionRequestId, 10_000);

    await forwardPermissionRequest(
      adapter,
      address,
      permissionRequestId,
      'Codex TUI Selection Prompt',
      {
        provider: 'tmux',
        promptKind: 'generic',
        choices: [{ choice: 'option_1', label: 'Resume', selected: true }],
      },
      'session-clear-cancel',
    );

    assert.equal(cancelCodexTuiSelectionWaitersForSession('session-clear-cancel'), 1);
    assert.equal(await choice, null);
    assert.equal(cancelCodexTuiSelectionWaitersForSession('session-clear-cancel'), 0);
  });

  it('returns before the permission card acknowledgement and links the message from the receipt', async () => {
    const store = initBridgeTestContext();
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-permission-background' } as const;
    let resolveAck!: (value: { ok: true; messageId: string }) => void;
    const ack = new Promise<{ ok: true; messageId: string }>((resolve) => {
      resolveAck = resolve;
    });
    adapter.send = async (message) => {
      adapter.sent.push(message);
      return ack;
    };

    forwardPermissionRequestWithoutDeliveryWait(
      adapter,
      address,
      'permission-background-1',
      'Bash',
      { command: 'npm test' },
      'session-background-1',
    );

    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(adapter.sent.length, 1);
    assert.equal(store.getPermissionLink('permission-background-1'), null);

    resolveAck({ ok: true, messageId: 'permission-background-message' });
    await _testOnlyWaitForDeliveryQueuesForTests(adapter);
    assert.equal(store.getPermissionLink('permission-background-1')?.messageId, 'permission-background-message');
  });

  it('ends permission waiters immediately when queued card delivery fails', async () => {
    const denied: Array<{ id: string; behavior: string; message?: string }> = [];
    initBridgeTestContext({
      permissions: {
        resolvePendingPermission: (id, resolution) => {
          denied.push({ id, behavior: resolution.behavior, message: resolution.message });
          return true;
        },
      },
    });
    const adapter = new RecordingAdapter();
    adapter.send = async (message) => {
      adapter.sent.push(message);
      return { ok: false, error: 'Feishu unavailable' };
    };
    const address = { channelType: 'feishu', chatId: 'chat-permission-delivery-failed' } as const;
    const permissionRequestId = 'codex-selection:permission:tmux:session-delivery-failed:1';
    const choice = waitForCodexTuiSelectionPermission(permissionRequestId, 10_000);

    forwardPermissionRequestWithoutDeliveryWait(
      adapter,
      address,
      permissionRequestId,
      'Codex TUI Selection Prompt',
      {
        provider: 'tmux',
        promptKind: 'permission',
        choices: [{ choice: 'yes_proceed', label: 'Yes, proceed', selected: true }],
      },
      'session-delivery-failed',
    );

    await _testOnlyWaitForDeliveryQueuesForTests(adapter);
    assert.equal(await choice, null);
    assert.deepEqual(denied, [{
      id: permissionRequestId,
      behavior: 'deny',
      message: 'Feishu unavailable',
    }]);
  });

  it('renders Codex trust prompts as explicit trust confirmations', async () => {
    const store = initBridgeTestContext();
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-codex-trust-permission' } as const;
    const permissionRequestId = 'codex-trust:tmux:session-1:1';

    await forwardPermissionRequest(
      adapter,
      address,
      permissionRequestId,
      'Codex Trust Directory',
      {
        provider: 'tmux',
        workingDirectory: '/tmp/project',
        inspect: '/tmux-screen 80',
      },
      'session-1',
    );

    const message = adapter.sent.at(-1);
    assert.ok(message);
    assert.equal(message.parseMode, 'HTML');
    assert.match(message.text, /Codex Trust Confirmation/);
    assert.match(message.text, /Directory: \/tmp\/project/);
    assert.match(message.text, /Inspect current screen: \/tmux-screen 80/);
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
      message.richCard?.selects?.[0]?.selectedCallbackData || '',
      /^codex-tui-selection-choice:codex-selection%3Aupdate%3Atmux%3Asession-2%3A1:update_now$/,
    );
    assert.match(
      message.richCard?.selects?.[0]?.options[2]?.callbackData || '',
      /^codex-tui-selection-choice:codex-selection%3Aupdate%3Atmux%3Asession-2%3A1:skip_until_next_version$/,
    );
    assert.equal(store.getPermissionLink(permissionRequestId)?.messageId, 'reply-1');
  });

  it('suppresses duplicate Codex TUI selection cards while resolving all waiters', async () => {
    initBridgeTestContext();
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-codex-selection-dedup' } as const;
    const firstPermissionRequestId = 'codex-selection:update:provider-auto-forward-startup:session-2:1';
    const duplicatePermissionRequestId = 'codex-selection:update:mirror:session-2:2';
    const toolInput = {
      provider: 'tmux',
      inspect: '/tmux-screen 80',
      promptKind: 'update',
      defaultChoice: 'update_now',
      prompt: [
        'Update available! 0.135.0 -> 0.136.0',
        '› 1. Update now',
        '  2. Skip',
        '  3. Skip until next version',
      ].join('\n'),
      choices: [
        { choice: 'update_now', label: 'Update now', selected: true },
        { choice: 'skip', label: 'Skip', selected: false },
        { choice: 'skip_until_next_version', label: 'Skip until next version', selected: false },
      ],
    };

    const firstChoice = waitForCodexTuiSelectionPermission(firstPermissionRequestId);
    await forwardPermissionRequest(
      adapter,
      address,
      firstPermissionRequestId,
      'Codex TUI Selection Prompt',
      toolInput,
      'session-2',
    );
    const duplicateChoice = waitForCodexTuiSelectionPermission(duplicatePermissionRequestId);
    await forwardPermissionRequest(
      adapter,
      address,
      duplicatePermissionRequestId,
      'Codex TUI Selection Prompt',
      toolInput,
      'session-2',
    );

    assert.equal(adapter.sent.length, 1);
    const callbackData = adapter.sent[0]?.richCard?.selects?.[0]?.options.find((option) => (
      option.callbackData.endsWith(':skip')
    ))?.callbackData;
    assert.ok(callbackData);
    assert.equal(handlePermissionCallback(callbackData, address.chatId, 'reply-1'), true);
    assert.equal(await firstChoice, 'skip');
    assert.equal(await duplicateChoice, 'skip');
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

  it('renders Codex goal replacement selections with cancel as a known option', async () => {
    initBridgeTestContext();
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-codex-goal-selection' } as const;
    const permissionRequestId = 'codex-selection:goal:tmux:session-goal:1';

    await forwardPermissionRequest(
      adapter,
      address,
      permissionRequestId,
      'Codex TUI Selection Prompt',
      {
        provider: 'tmux',
        inspect: '/tmux-screen 80',
        promptKind: 'goal',
        prompt: [
          '› 1. Replace current goal  Set the new objective and start it now',
          '  2. Cancel                Keep the current goal',
        ].join('\n'),
        choices: [
          { choice: 'replace_current_goal', label: 'Replace current goal  Set the new objective and start it now', selected: true },
          { choice: 'cancel', label: 'Cancel                Keep the current goal' },
        ],
      },
      'session-goal',
    );

    const message = adapter.sent.at(-1);
    const select = message?.richCard?.selects?.[0];
    assert.doesNotMatch(message?.text || '', /goal replacement selection prompt/);
    assert.doesNotMatch(message?.text || '', /<pre>/);
    assert.match(message?.text || '', /› 1\. Replace current goal/);
    const cardMarkdown = message?.richCard?.sections?.[0]?.markdown || '';
    assert.match(cardMarkdown, /Codex tmux 可能停在 TUI 选择界面，请选择要执行的选项。/);
    assert.match(cardMarkdown, /可以用 `\/tmux-screen 20`核实。/);
    assert.doesNotMatch(cardMarkdown, /```text/);
    assert.doesNotMatch(cardMarkdown, /goal replacement selection prompt/);
    assert.deepEqual(select?.options.map((option) => option.text), [
      'Replace current goal  Set the new objective and start it now',
      'Cancel                Keep the current goal',
    ]);
    assert.match(select?.selectedCallbackData || '', /:replace_current_goal$/);
    assert.match(select?.options[1]?.callbackData || '', /:cancel$/);
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

  it('resolves Codex TUI selection callbacks that arrive before the permission link is recorded', async () => {
    const store = initBridgeTestContext();
    const address = { channelType: 'feishu', chatId: 'chat-codex-selection-early-callback' } as const;
    const permissionRequestId = 'codex-selection:permission:provider-auto-forward-startup:session-early:1';
    class EarlyCallbackAdapter extends RecordingAdapter {
      async send(message: Parameters<RecordingAdapter['send']>[0]): ReturnType<RecordingAdapter['send']> {
        const result = await super.send(message);
        const callbackData = message.richCard?.selects?.[0]?.options.find((option) => (
          option.callbackData.endsWith(':yes_proceed')
        ))?.callbackData;
        if (callbackData) {
          assert.equal(handlePermissionCallback(callbackData, address.chatId, result.messageId), true);
        }
        return result;
      }
    }
    const adapter = new EarlyCallbackAdapter();
    const choice = waitForCodexTuiSelectionPermission(permissionRequestId);

    await forwardPermissionRequest(
      adapter,
      address,
      permissionRequestId,
      'Codex TUI Selection Prompt',
      {
        provider: 'tmux',
        inspect: '/tmux-screen 80',
        promptKind: 'permission',
        defaultChoice: 'yes_proceed',
        prompt: [
          'Do you trust the contents of this directory?',
          '› 1. Yes, continue',
          '  2. No, quit',
        ].join('\n'),
        choices: [
          { choice: 'yes_proceed', label: 'Yes, continue', selected: true },
          { choice: 'no', label: 'No, quit', selected: false },
        ],
      },
      'session-early',
    );

    assert.equal(await choice, 'yes_proceed');
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
    const permissionRequestId = 'codex-trust:tmux:session-3:1';

    await forwardPermissionRequest(
      adapter,
      address,
      permissionRequestId,
      'Codex Trust Directory',
      {
        provider: 'tmux',
        workingDirectory: '/tmp/no-session-allow',
      },
      'session-3',
    );

    assert.equal(handlePermissionCallback(`perm:allow_session:${permissionRequestId}`, address.chatId), false);
    assert.equal(store.getPermissionLink(permissionRequestId)?.resolved, false);
  });
});
