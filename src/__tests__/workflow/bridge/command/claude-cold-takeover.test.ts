import '../../../setup/test-setup.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { getClaudeProjectDir } from '../../../../runtime/claude/session-jsonl.js';
import { parseClaudeLaunchSessionId } from '../../../../runtime/claude/session-identity.js';

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

  function setup(launchCommand = `claude --session-id ${sessionId}`, migrate = false, initialScreen = screen) {
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
    const launches: string[] = [];
    let currentScreen = initialScreen;
    const core: TmuxCore = {
      commandPreview: (args) => `tmux ${args.join(' ')}`,
      hasSession: async () => { calls.push('exists'); return { exists: true, command: 'has-session' }; },
      capturePane: async () => { calls.push('capture'); return { screen: currentScreen, command: 'capture-pane' }; },
      readPaneStartCommand: async () => { calls.push('identity'); return launchCommand; },
      sendActions: async (_target, actions) => {
        calls.push('send');
        submitted.push(actions);
        return { commands: ['send-input'] };
      },
      listSessions: async () => ({ sessions: [], command: 'list-sessions' }),
      ensureDetachedSession: async (params) => {
        assert.equal(migrate, true, 'must retain the existing Claude process');
        assert.equal(params.recreate, true);
        calls.push('restart');
        launchCommand = Array.isArray(params.command) ? params.command.join(' ') : params.command || '';
        launches.push(launchCommand);
        currentScreen = screen;
        return { existed: true, commands: ['recreate'] };
      },
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
    return { send, calls, submitted, replies, launches, store, binding, setScreen: (value: string) => { currentScreen = value; }, forwarded: () => forwarded };
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


  it('automatically resumes the saved transcript for a legacy window and sends the original message once', async () => {
    const oldCli = process.env.CODELARK_CLAUDE_CLI_PATH;
    process.env.CODELARK_CLAUDE_CLI_PATH = process.execPath;
    const project = getClaudeProjectDir(process.cwd());
    fs.mkdirSync(project, { recursive: true });
    const transcript = path.join(project, `${sessionId}.jsonl`);
    fs.writeFileSync(transcript, JSON.stringify({ sessionId, cwd: process.cwd(), type: 'user', message: { role: 'user', content: 'original history' } }) + '\n');
    try {
      const test = setup('claude --model sonnet', true);
      await test.send('continue my work');
      assert.deepEqual(test.replies, []);
      assert.equal(test.launches.length, 1);
      assert.equal(parseClaudeLaunchSessionId(test.launches[0]!), sessionId);
      assert.match(test.launches[0]!, /--resume/u);
      assert.equal(test.submitted.length, 1);
      assert.ok(test.calls.indexOf('restart') < test.calls.indexOf('send'));
      assert.equal(test.store.getSession(test.binding.bridgeSessionId)?.runtime?.claude?.sessionId, sessionId);
      await test.send('another message');
      assert.equal(test.launches.length, 1);
      assert.equal(test.submitted.length, 2);
      assert.equal(test.forwarded(), 2);
    } finally {
      if (oldCli === undefined) delete process.env.CODELARK_CLAUDE_CLI_PATH; else process.env.CODELARK_CLAUDE_CLI_PATH = oldCli;
      fs.rmSync(transcript, { force: true });
    }
  });


  for (const reason of ['ambiguous identity', 'missing transcript', 'conflicting binding', 'manual target', 'active Claude']) {
    it(`does not rebuild a legacy window with ${reason}`, async () => {
      const project = getClaudeProjectDir(process.cwd());
      fs.mkdirSync(project, { recursive: true });
      const transcript = path.join(project, `${sessionId}.jsonl`);
      if (reason !== 'missing transcript') fs.writeFileSync(transcript, JSON.stringify({ sessionId, cwd: process.cwd(), type: 'user', message: { role: 'user', content: 'history' } }) + '\n');
      try {
        const test = setup(reason === 'ambiguous identity' ? `claude --resume ${sessionId} --session-id ${sessionId}` : 'claude', true,
          reason === 'active Claude' ? `${screen}\nesc to interrupt` : screen);
        if (reason === 'manual target') test.store.updateSession(test.binding.bridgeSessionId, { runtime: { general: { tmuxSessionName: 'manual-work-terminal' } } });
        if (reason === 'conflicting binding') {
          const other = test.store.createSession('other', 'test', '', process.cwd());
          test.store.updateSession(other.id, { runtime: { activeRuntime: 'claude', claude: { sessionId }, general: { tmuxSessionName: `claude_${other.id}` } } });
        }
        await test.send('do not lose or cross-bind my work');
        assert.equal(test.launches.length, 0);
        assert.equal(test.submitted.length, 0);
        assert.equal(test.forwarded(), 0);
      } finally { fs.rmSync(transcript, { force: true }); }
    });
  }

  it('keeps a transcript-disabled window blocked on later input when no history can be recovered', async () => {
    const test = setup(`claude --resume ${sessionId}`, true, `${screen}\n⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker`);
    await test.send('first blocked message');
    assert.equal(getRuntimeTmuxInputState('claude', sessionName).state, 'failed');
    await test.send('still cannot save');
    assert.equal(test.submitted.length, 0);
    assert.equal(test.launches.length, 0);
  });

  it('automatically relaunches a bound idle window whose inherited child marker disabled saving', async () => {
    const oldCli = process.env.CODELARK_CLAUDE_CLI_PATH;
    process.env.CODELARK_CLAUDE_CLI_PATH = process.execPath;
    const project = getClaudeProjectDir(process.cwd());
    fs.mkdirSync(project, { recursive: true });
    const transcript = path.join(project, `${sessionId}.jsonl`);
    fs.writeFileSync(transcript, JSON.stringify({ sessionId, cwd: process.cwd(), type: 'user', message: { role: 'user', content: 'saved history' } }) + '\n');
    try {
      const test = setup(`claude --resume ${sessionId}`, true, `${screen}\n⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker`);
      await test.send('save my next reply');
      assert.equal(test.launches.length, 1);
      assert.match(test.launches[0]!, /CLAUDE_CODE_CHILD_SESSION/u);
      assert.equal(test.submitted.length, 1);
      assert.deepEqual(test.replies, []);
    } finally {
      if (oldCli === undefined) delete process.env.CODELARK_CLAUDE_CLI_PATH; else process.env.CODELARK_CLAUDE_CLI_PATH = oldCli;
      fs.rmSync(transcript, { force: true });
    }
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
