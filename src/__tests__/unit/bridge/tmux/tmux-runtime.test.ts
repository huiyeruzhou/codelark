import '../../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  buildCodexResumeTmuxCommand,
  CodexResumeTmuxLaunchError,
  hasCodexResumeTmuxReadyPrompt,
  startCodexResumeTmuxSession,
  waitForCodexResumeTmuxReady,
  type TmuxCore,
  type TmuxSendAction,
} from '../../../../bridge/tmux/runtime.js';

describe('codex tmux runtime', () => {
  it('detects a resumed Codex TUI prompt that already contains suggested text', () => {
    const screen = [
      '╭─────────────────────────────────────────────╮',
      '│ >_ OpenAI Codex (v0.136.0)                  │',
      '│ model:     gpt-5.5 low   /model to change   │',
      '╰─────────────────────────────────────────────╯',
      '',
      '■ Conversation interrupted - tell the model what to do differently.',
      '',
      '› Summarize recent commits',
      '',
      '  gpt-5.5 low · /tmp/clk-debug-tmux-ready',
    ].join('\n');

    assert.equal(hasCodexResumeTmuxReadyPrompt(screen), true);
  });

  it('does not treat a Codex TUI selection prompt as a resumed idle prompt', () => {
    const screen = [
      'Codex wants to edit files.',
      '› 1. Yes, proceed (y)',
      "  2. Yes, and don't ask again for these files (a)",
      '  3. No, and tell Codex what to do differently (esc)',
      'Press enter to confirm or esc to cancel',
    ].join('\n');

    assert.equal(hasCodexResumeTmuxReadyPrompt(screen), false);
  });

  it('passes the requested model when launching a resumed Codex tmux session', () => {
    const { codexCommand } = buildCodexResumeTmuxCommand({
      sessionName: 'codex_test',
      bridgeSessionId: 'bridge-session-1',
      threadId: '019e8d75-4f82-7df3-b15a-901980812307',
      model: 'gpt-5.4',
      workingDirectory: '/tmp/clk-work',
      modelReasoningEffort: 'low',
    });

    assert.match(codexCommand, /--model gpt-5\.4/);
    assert.match(codexCommand, /resume 019e8d75-4f82-7df3-b15a-901980812307/);
  });
  it('includes the Codex process stderr when a tmux launch exits before pane capture', async () => {
    let launchLogPath = '';
    const commands: string[] = [];
    const core: TmuxCore = {
      commandPreview: (args) => ['tmux', ...args].join(' '),
      hasSession: async (name) => {
        const command = `tmux has-session -t ${name}`;
        commands.push(command);
        return { exists: false, command };
      },
      killSession: async (name) => {
        const command = `tmux kill-session -t ${name}`;
        commands.push(command);
        return command;
      },
      listSessions: async () => ({ sessions: [], command: 'tmux list-sessions' }),
      ensureDetachedSession: async ({ command }) => {
        assert.match(command || '', /2> /);
        launchLogPath = (command || '').match(/ 2> ([^;]+)/)?.[1] || '';
        assert.match(launchLogPath, /codelark-codex-tmux-.*-codex_fail\.log$/);
        fs.writeFileSync(launchLogPath, 'bash: codex: command not found\n[codelark] process exited with status 127\n', 'utf-8');
        return { existed: false, command: 'tmux new-session -d -s codex_fail', commands: ['tmux new-session -d -s codex_fail'] };
      },
      capturePane: async () => {
        throw new Error("can't find pane: codex_fail");
      },
      sendActions: async () => ({ commands: [] }),
      sendInterrupt: async () => 'tmux send-keys -t codex_fail C-c',
      injectPromptIntoPane: async () => ({ commands: [] }),
    };

    await assert.rejects(
      () => startCodexResumeTmuxSession({
        sessionName: 'codex_fail',
        threadId: 'fail-thread',
        bridgeSessionId: 'bridge-fail',
        workingDirectory: '/tmp',
      }, core),
      (error) => {
        assert.ok(error instanceof CodexResumeTmuxLaunchError);
        assert.equal(error.details.sessionExists, false);
        assert.match(error.details.lastError || '', /can't find pane: codex_fail/);
        assert.match(error.details.launchOutput || '', /codex: command not found/);
        assert.match(error.details.launchOutput || '', /status 127/);
        assert.equal(error.details.launchLogPath, launchLogPath);
        assert.equal(fs.existsSync(launchLogPath), false);
        return true;
      },
    );
    assert.ok(commands.some((command) => /kill-session -t codex_fail/.test(command)));
  });
  it('waits for a resumed Codex TUI prompt before accepting a launched session', async () => {
    let captureCount = 0;
    const core: TmuxCore = {
      commandPreview: (args) => ['tmux', ...args].join(' '),
      hasSession: async (name) => ({ exists: true, command: `tmux has-session -t ${name}` }),
      killSession: async (name) => `tmux kill-session -t ${name}`,
      listSessions: async () => ({ sessions: [], command: 'tmux list-sessions' }),
      ensureDetachedSession: async () => ({ existed: false, command: 'tmux new-session -d -s codex_busy', commands: ['tmux new-session -d -s codex_busy'] }),
      capturePane: async (name) => {
        captureCount += 1;
        return {
          command: `tmux capture-pane -t ${name} -p -S -80`,
          screen: captureCount === 1
            ? 'OpenAI Codex\nStarting up...'
            : 'OpenAI Codex\n\n› ',
        };
      },
      sendActions: async () => ({ commands: [] }),
      sendInterrupt: async () => 'tmux send-keys -t codex_busy C-c',
      injectPromptIntoPane: async () => ({ commands: [] }),
    };

    const result = await startCodexResumeTmuxSession({
      sessionName: 'codex_busy',
      threadId: 'busy-thread',
      bridgeSessionId: 'bridge-busy',
      workingDirectory: '/tmp',
    }, core);

    assert.equal(result.ready, true);
    assert.deepEqual(result.commands, [
      'tmux new-session -d -s codex_busy',
      'tmux capture-pane -t codex_busy -p -S -80',
      'tmux capture-pane -t codex_busy -p -S -80',
    ]);
    assert.equal(captureCount, 2);
  });

  it('clears a startup goal selection before accepting a launched session as ready', async () => {
    let captureCount = 0;
    const sentActions: Array<{ target: string; actions: TmuxSendAction[] }> = [];
    const core: TmuxCore = {
      commandPreview: (args) => ['tmux', ...args].join(' '),
      hasSession: async (name) => ({ exists: true, command: `tmux has-session -t ${name}` }),
      killSession: async (name) => `tmux kill-session -t ${name}`,
      listSessions: async () => ({ sessions: [], command: 'tmux list-sessions' }),
      ensureDetachedSession: async () => ({ existed: false, command: 'tmux new-session -d -s codex_goal', commands: ['tmux new-session -d -s codex_goal'] }),
      capturePane: async (name) => {
        captureCount += 1;
        return {
          command: `tmux capture-pane -t ${name} -p -S -80`,
          screen: captureCount === 1
            ? [
              'A task is already running.',
              'Do you want to replace the current goal?',
              '› 1. Replace current goal',
              '  2. Cancel',
              'Press enter to confirm or esc to cancel',
            ].join('\n')
            : 'OpenAI Codex\n\n› ',
        };
      },
      sendActions: async (target, actions) => {
        sentActions.push({ target, actions });
        return { commands: actions.map((action) => action.type === 'key' ? `tmux send-keys -t ${target} ${action.key}` : `tmux send-keys -t ${target} -l ${action.text}`) };
      },
      sendInterrupt: async () => 'tmux send-keys -t codex_goal C-c',
      injectPromptIntoPane: async () => ({ commands: [] }),
    };

    const result = await startCodexResumeTmuxSession({
      sessionName: 'codex_goal',
      threadId: 'goal-thread',
      bridgeSessionId: 'bridge-goal',
      workingDirectory: '/tmp',
    }, core);

    assert.equal(result.ready, true);
    assert.equal(captureCount, 2);
    assert.deepEqual(sentActions, [{
      target: 'codex_goal',
      actions: [
        { type: 'key', key: 'Down' },
        { type: 'key', key: 'Enter' },
      ],
    }]);
    assert.equal(result.commands.includes('tmux send-keys -t codex_goal Down'), true);
    assert.equal(result.commands.includes('tmux send-keys -t codex_goal Enter'), true);
  });

  it('reports unsupported startup selection prompts without waiting for the full ready timeout', async () => {
    const oldTimeout = process.env.CODELARK_CODEX_RESUME_TMUX_READY_TIMEOUT_MS;
    try {
      process.env.CODELARK_CODEX_RESUME_TMUX_READY_TIMEOUT_MS = '5000';
      const core: TmuxCore = {
        commandPreview: (args) => ['tmux', ...args].join(' '),
        hasSession: async (name) => ({ exists: true, command: `tmux has-session -t ${name}` }),
        killSession: async (name) => `tmux kill-session -t ${name}`,
        listSessions: async () => ({ sessions: [], command: 'tmux list-sessions' }),
        ensureDetachedSession: async () => ({ existed: false, command: 'tmux new-session -d -s codex_permission', commands: ['tmux new-session -d -s codex_permission'] }),
        capturePane: async (name) => ({
          command: `tmux capture-pane -t ${name} -p -S -80`,
          screen: [
            'Codex wants to edit files.',
            '› 1. Yes, proceed (y)',
            "  2. Yes, and don't ask again for these files (a)",
            '  3. No, and tell Codex what to do differently (esc)',
            'Press enter to confirm or esc to cancel',
          ].join('\n'),
        }),
        sendActions: async () => {
          throw new Error('permission prompt should not be auto-confirmed');
        },
        sendInterrupt: async () => 'tmux send-keys -t codex_permission C-c',
        injectPromptIntoPane: async () => ({ commands: [] }),
      };

      const startedAt = Date.now();
      const result = await waitForCodexResumeTmuxReady('codex_permission', core);

      assert.equal(result.ready, false);
      assert.equal(result.selectionPromptKind, 'permission');
      assert.equal(result.selectionPromptChoice, undefined);
      assert.match(result.selectionPromptSummary || '', /Yes, proceed/);
      assert.equal(Date.now() - startedAt < 1_000, true);
    } finally {
      if (oldTimeout === undefined) delete process.env.CODELARK_CODEX_RESUME_TMUX_READY_TIMEOUT_MS;
      else process.env.CODELARK_CODEX_RESUME_TMUX_READY_TIMEOUT_MS = oldTimeout;
    }
  });
});
