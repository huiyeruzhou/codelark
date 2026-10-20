import '../../../setup/test-setup.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { createConfigService } from '../../../../configuration/service.js';
import { handleBridgeCommand } from '../../../../bridge/command/index.js';
import * as router from '../../../../bridge/host/channel-router.js';
import { _testOnlyTmuxCore, type TmuxCore, type TmuxSendAction } from '../../../../bridge/tmux/core.js';
import { getRuntimeTmuxInputState, resetRuntimeTmuxInputStatesForTests } from '../../../../bridge/tmux/input-state-machine.js';
import { _testOnlyWaitForDeliveryQueuesForTests } from '../../../../channels/delivery/deliver.js';
import { initBridgeTestContext, resetBridgeTestState } from '../../../helpers/bridge/test-bridge-utils.js';

const screen = fs.readFileSync(new URL('../../../fixtures/runtime/claude/mature-input-no-hints.txt', import.meta.url), 'utf8');
const sessionId = 'd630216c-3fc8-43a0-98d7-75432b08d98c';
const sessionName = `claude_${sessionId}`;

describe('Claude cold takeover through provider auto-forward', () => {
  let previousTimeout: string | undefined;
  beforeEach(() => {
    resetBridgeTestState();
    resetRuntimeTmuxInputStatesForTests();
    previousTimeout = process.env.CODELARK_CLAUDE_TMUX_READY_TIMEOUT_MS;
    process.env.CODELARK_CLAUDE_TMUX_READY_TIMEOUT_MS = '250';
  });
  afterEach(() => {
    _testOnlyTmuxCore.reset();
    resetRuntimeTmuxInputStatesForTests();
    if (previousTimeout === undefined) delete process.env.CODELARK_CLAUDE_TMUX_READY_TIMEOUT_MS;
    else process.env.CODELARK_CLAUDE_TMUX_READY_TIMEOUT_MS = previousTimeout;
  });

  function setup(launchCommand = `claude --session-id ${sessionId}`) {
    const store = initBridgeTestContext({ dynamicSettings: true });
    const address = { channelType: 'feishu', chatId: 'claude-cold-takeover' } as const;
    const binding = router.createBinding(address, process.cwd());
    store.updateSession(binding.bridgeSessionId, {
      runtime: {
        activeRuntime: 'claude',
        claude: { sessionId, cwd: process.cwd() },
        general: { tmuxSessionName: sessionName },
      },
    });
    createConfigService({ migrate: false, env: {} }).set(
      { kind: 'session', sessionId: binding.bridgeSessionId },
      { runtime: { claude: { provider: 'tmux' } } },
    );
    const calls: string[] = [];
    const submitted: TmuxSendAction[][] = [];
    const core: TmuxCore = {
      commandPreview: (args) => `tmux ${args.join(' ')}`,
      hasSession: async () => { calls.push('exists'); return { exists: true, command: 'has-session' }; },
      capturePane: async () => { calls.push('capture'); return { screen, command: 'capture-pane' }; },
      readPaneStartCommand: async () => { calls.push('identity'); return launchCommand; },
      sendActions: async (_target, actions) => {
        calls.push('send');
        submitted.push(actions);
        return { commands: ['send-input'] };
      },
      listSessions: async () => ({ sessions: [], command: 'list-sessions' }),
      ensureDetachedSession: async () => { throw new Error('must retain the existing Claude process'); },
      killSession: async () => { throw new Error('must not kill the existing Claude process'); },
      sendInterrupt: async () => { throw new Error('must not interrupt Claude'); },
      injectPromptIntoPane: async () => { throw new Error('unexpected injection path'); },
    };
    _testOnlyTmuxCore.replace(core);
    const replies: string[] = [];
    let forwarded = 0;
    const adapter: any = {
      channelType: 'feishu',
      send: async (message: { text: string }) => {
        replies.push(message.text);
        return { ok: true, messageId: `reply-${replies.length}` };
      },
    };
    async function send(text: string) {
      await handleBridgeCommand(adapter, {
        address, text: `/tmux ${text}`, messageId: `incoming-${text}`, timestamp: Date.now(),
      }, `/tmux ${text}`, {
        getActiveTask: () => undefined,
        diagnoseSessionHealth: async () => null,
        diagnoseAllActiveSessions: async () => [],
        tmuxProviderAutoForward: true,
        onTmuxProviderAutoForwarded: () => { forwarded += 1; },
      });
      await _testOnlyWaitForDeliveryQueuesForTests(adapter);
    }
    return { send, calls, submitted, replies, forwarded: () => forwarded };
  }

  it('probes a surviving mature Claude once after Bridge restart and forwards both messages', async () => {
    const test = setup();
    await test.send('after bridge restart');
    assert.deepEqual(test.replies, []);
    assert.equal(test.forwarded(), 1);
    assert.ok(test.calls.indexOf('capture') < test.calls.indexOf('identity'));
    assert.ok(test.calls.indexOf('identity') < test.calls.indexOf('send'));
    assert.equal(getRuntimeTmuxInputState('claude', sessionName).state, 'running');

    await test.send('next input');
    assert.equal(test.forwarded(), 2);
    assert.equal(test.calls.filter((call) => call === 'capture').length, 1);
    assert.deepEqual(test.submitted.map((actions) => actions.filter((a) => a.type === 'literal').map((a) => a.text).join('')), [
      'after bridge restart', 'next input',
    ]);
    assert.ok(test.submitted.every((actions) => actions.some((a) => a.type === 'key' && a.key === 'Enter')));
  });

  for (const [name, launchCommand] of Object.entries({
    missing: 'claude',
    mismatched: 'claude --session-id d630216c-3fc8-43a0-98d7-75432b08d98d',
  })) {
    it(`still rejects a ready existing pane with ${name} session identity`, async () => {
      const test = setup(launchCommand);
      await test.send('must not send');
      assert.ok(test.calls.includes('identity'), 'readiness must pass before checking identity');
      assert.equal(test.forwarded(), 0);
      assert.deepEqual(test.submitted, []);
      assert.match(test.replies.join('\n'), /无法确认 Claude tmux|与保存的绑定/u);
    });
  }
});
