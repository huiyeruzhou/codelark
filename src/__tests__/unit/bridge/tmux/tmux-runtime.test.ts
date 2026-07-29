import '../../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  buildCodexResumeTmuxCommand,
  CodexResumeTmuxLaunchError,
  cleanupRuntimeTmuxSession,
  hasCodexResumeTmuxReadyPrompt,
  inspectRuntimeTmuxSession,
  startCodexResumeTmuxSession,
  waitForRuntimeTmuxReady,
  waitForCodexResumeTmuxReady,
  type RuntimeTmuxReadinessTransition,
  type TmuxCore,
  type TmuxSendAction,
} from '../../../../bridge/tmux/runtime.js';
import {
  coordinateRuntimeTmuxSelection,
  resetRuntimeTmuxInputStatesForTests,
} from '../../../../bridge/tmux/input-state-machine.js';
import { parseCodexTuiSelectionPrompt } from '../../../../runtime/codex/tmux-provider.js';

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

  it('treats a working Codex TUI screen with an input line as ready for follow-up input', () => {
    const screen = [
      '└ (no output)',
      '',
      '• Working (2m 54s • esc to interrupt)',
      '',
      '',
      '› Implement {feature}',
      '',
      '  model-name medium · /workspace/project      Pursuing goal (6h 30m)',
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
    const { codexCommand, tmuxCommand } = buildCodexResumeTmuxCommand({
      sessionName: 'codex_test',
      bridgeSessionId: 'bridge-session-1',
      threadId: '019e8d75-4f82-7df3-b15a-901980812307',
      model: 'gpt-5.4',
      workingDirectory: '/tmp/clk-work',
      modelReasoningEffort: 'low',
    });

    const launchText = Array.isArray(tmuxCommand) ? tmuxCommand.join('\n') : codexCommand;
    assert.match(launchText, /--model/);
    assert.match(launchText, /gpt-5\.4/);
    assert.match(launchText, /resume/);
    assert.match(launchText, /019e8d75-4f82-7df3-b15a-901980812307/);
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
        const commandText = Array.isArray(command) ? command.join(' ') : command || '';
        assert.match(commandText, /2> /);
        const logMatch = commandText.match(/ 2> (?:'([^']+)'|"([^"]+)"|([^;]+))/);
        launchLogPath = logMatch?.[1] || logMatch?.[2] || logMatch?.[3]?.trim() || '';
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

  it('requires a selection handler instead of auto-cancelling a startup goal selection', async () => {
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

    await assert.rejects(() => startCodexResumeTmuxSession({
      sessionName: 'codex_goal',
      threadId: 'goal-thread',
      bridgeSessionId: 'bridge-goal',
      workingDirectory: '/tmp',
    }, core), (error) => {
      assert.ok(error instanceof CodexResumeTmuxLaunchError);
      assert.equal(error.details.selectionPromptKind, 'goal');
      assert.equal(error.details.selectionPromptChoice, 'replace_current_goal');
      return true;
    });

    assert.equal(captureCount, 1);
    assert.deepEqual(sentActions, []);
  });

  it('shares one selection lifecycle when startup readiness and mirror observe the same prompt', async () => {
    resetRuntimeTmuxInputStatesForTests();
    const screen = [
      'Resume paused goal?',
      'Goal: continue lifecycle audit',
      '› 1. Resume goal   Mark it active and continue when idle',
      '  2. Leave paused  Keep it paused; use /goal resume later',
      'Press enter to confirm or esc to cancel',
    ].join('\n');
    const prompt = parseCodexTuiSelectionPrompt(screen);
    assert.ok(prompt);

    let ready = false;
    let startupWaiters = 0;
    let mirrorWaiters = 0;
    let resolveStartupChoice!: () => void;
    const startupChoice = new Promise<void>((resolve) => {
      resolveStartupChoice = resolve;
    });
    let notifyStartupWaiting!: () => void;
    const startupWaiting = new Promise<void>((resolve) => {
      notifyStartupWaiting = resolve;
    });
    const sentActions: TmuxSendAction[][] = [];
    const core = {
      commandPreview: (args: readonly string[]) => ['tmux', ...args].join(' '),
      hasSession: async (name: string) => ({ exists: true, command: `tmux has-session -t ${name}` }),
      killSession: async (name: string) => `tmux kill-session -t ${name}`,
      listSessions: async () => ({ sessions: [], command: 'tmux list-sessions' }),
      ensureDetachedSession: async () => ({ existed: true, command: '', commands: [] }),
      capturePane: async (target: string) => ({
        command: `tmux capture-pane -t ${target} -p -S -80`,
        screen: ready ? 'OpenAI Codex\n\n› ' : screen,
      }),
      sendActions: async (_target: string, actions: TmuxSendAction[]) => {
        sentActions.push(actions);
        ready = true;
        return { commands: ['tmux send-keys Down', 'tmux send-keys Enter'] };
      },
      sendInterrupt: async () => '',
      injectPromptIntoPane: async () => ({ commands: [] }),
    } as TmuxCore;

    const readiness = waitForRuntimeTmuxReady({
      runtime: 'codex',
      sessionName: 'codex_shared_goal',
      target: 'codex_shared_goal',
      core,
      onSelectionPrompt: async () => {
        startupWaiters += 1;
        notifyStartupWaiting();
        await startupChoice;
        return 'option_2' as const;
      },
    });
    await startupWaiting;
    const mirror = coordinateRuntimeTmuxSelection({
      runtime: 'codex',
      sessionName: 'codex_shared_goal',
      fingerprint: prompt.fingerprint,
      run: async () => {
        mirrorWaiters += 1;
        return { choice: 'option_2', commands: [] };
      },
    });
    resolveStartupChoice();

    const [readinessResult, mirrorResult] = await Promise.all([readiness, mirror]);
    assert.equal(readinessResult.ready, true);
    assert.equal(mirrorResult.owner, false);
    assert.equal(startupWaiters, 1);
    assert.equal(mirrorWaiters, 0);
    assert.deepEqual(sentActions, [[
      { type: 'key', key: 'Down' },
      { type: 'key', key: 'Enter' },
    ]]);
    resetRuntimeTmuxInputStatesForTests();
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
      assert.equal(result.selectionPromptChoice, 'yes_proceed');
      assert.match(result.selectionPromptSummary || '', /Yes, proceed/);
      assert.equal(Date.now() - startedAt < 1_000, true);
    } finally {
      if (oldTimeout === undefined) delete process.env.CODELARK_CODEX_RESUME_TMUX_READY_TIMEOUT_MS;
      else process.env.CODELARK_CODEX_RESUME_TMUX_READY_TIMEOUT_MS = oldTimeout;
    }
  });

  it('uses the IM selection handler for startup prompts without a default choice', async () => {
    let captureCount = 0;
    const prompts: string[] = [];
    const sentActions: Array<{ target: string; actions: TmuxSendAction[] }> = [];
    const core: TmuxCore = {
      commandPreview: (args) => ['tmux', ...args].join(' '),
      hasSession: async (name) => ({ exists: true, command: `tmux has-session -t ${name}` }),
      killSession: async (name) => `tmux kill-session -t ${name}`,
      listSessions: async () => ({ sessions: [], command: 'tmux list-sessions' }),
      ensureDetachedSession: async () => ({ existed: false, command: 'tmux new-session -d -s codex_permission_handler', commands: ['tmux new-session -d -s codex_permission_handler'] }),
      capturePane: async (name) => {
        captureCount += 1;
        return {
          command: `tmux capture-pane -t ${name} -p -S -80`,
          screen: captureCount === 1
            ? [
              'Codex wants to edit files.',
              '› 1. Yes, proceed (y)',
              "  2. Yes, and don't ask again for these files (a)",
              '  3. No, and tell Codex what to do differently (esc)',
              'Press enter to confirm or esc to cancel',
            ].join('\n')
            : 'OpenAI Codex\n\n› ',
        };
      },
      sendActions: async (target, actions) => {
        sentActions.push({ target, actions });
        return { commands: actions.map((action) => action.type === 'key' ? `tmux send-keys -t ${target} ${action.key}` : `tmux send-keys -t ${target} -l ${action.text}`) };
      },
      sendInterrupt: async () => 'tmux send-keys -t codex_permission_handler C-c',
      injectPromptIntoPane: async () => ({ commands: [] }),
    };

    const result = await waitForCodexResumeTmuxReady('codex_permission_handler', core, {
      onSelectionPrompt: (selectionPrompt) => {
        prompts.push(selectionPrompt.kind);
        return 'yes_always';
      },
    });

    assert.equal(result.ready, true);
    assert.deepEqual(prompts, ['permission']);
    assert.deepEqual(sentActions, [{
      target: 'codex_permission_handler',
      actions: [
        { type: 'key', key: 'Down' },
        { type: 'key', key: 'Enter' },
      ],
    }]);
    assert.equal(result.commands.includes('tmux send-keys -t codex_permission_handler Down'), true);
    assert.equal(result.commands.includes('tmux send-keys -t codex_permission_handler Enter'), true);
  });

  it('reports readiness state transitions around startup selection recovery', async () => {
    let captureCount = 0;
    const transitions: RuntimeTmuxReadinessTransition[] = [];
    const core: TmuxCore = {
      commandPreview: (args) => ['tmux', ...args].join(' '),
      hasSession: async (name) => ({ exists: true, command: `tmux has-session -t ${name}` }),
      killSession: async (name) => `tmux kill-session -t ${name}`,
      listSessions: async () => ({ sessions: [], command: 'tmux list-sessions' }),
      ensureDetachedSession: async () => ({ existed: false, command: 'tmux new-session -d -s codex_stateful', commands: ['tmux new-session -d -s codex_stateful'] }),
      capturePane: async (name) => {
        captureCount += 1;
        return {
          command: `tmux capture-pane -t ${name} -p -S -80`,
          screen: captureCount === 1
            ? [
              'Update available! 0.0.0 -> 9.9.9',
              'Release notes: https://github.com/openai/codex/releases/latest',
              '› 1. Update now',
              '  2. Skip',
              '  3. Skip until next version',
              'Press enter to continue',
            ].join('\n')
            : 'OpenAI Codex\n\n› ',
        };
      },
      sendActions: async (target, actions) => ({
        commands: actions.map((action) => action.type === 'key'
          ? `tmux send-keys -t ${target} ${action.key}`
          : `tmux send-keys -t ${target} -l ${action.text}`),
      }),
      sendInterrupt: async () => 'tmux send-keys -t codex_stateful C-c',
      injectPromptIntoPane: async () => ({ commands: [] }),
    };

    const result = await waitForRuntimeTmuxReady({
      runtime: 'codex',
      sessionName: 'codex_stateful',
      core,
      onStateTransition: (transition) => transitions.push(transition),
      onSelectionPrompt: () => 'skip_until_next_version',
    });

    assert.equal(result.ready, true);
    assert.deepEqual(transitions.map((transition) => [transition.from, transition.to]), [
      ['starting', 'polling'],
      ['polling', 'waiting_selection'],
      ['waiting_selection', 'selection_resolved'],
      ['selection_resolved', 'polling'],
      ['polling', 'ready'],
    ]);
    assert.equal(
      transitions.find((transition) => transition.to === 'waiting_selection')?.entryAction,
      'Wait for the selection handler and exclude that wait from the readiness timeout.',
    );
    assert.equal(
      transitions.find((transition) => transition.to === 'ready')?.entryAction,
      'Return control to the caller so queued input can be forwarded.',
    );
  });

  it('returns immediately when the tmux pane reports a dead status', async () => {
    const transitions: RuntimeTmuxReadinessTransition[] = [];
    const core: TmuxCore = {
      commandPreview: (args) => ['tmux', ...args].join(' '),
      hasSession: async (name) => ({ exists: true, command: `tmux has-session -t ${name}` }),
      killSession: async (name) => `tmux kill-session -t ${name}`,
      listSessions: async () => ({ sessions: [], command: 'tmux list-sessions' }),
      ensureDetachedSession: async () => ({ existed: false, commands: [] }),
      capturePane: async (target) => ({
        command: `tmux capture-pane -t ${target} -p -S -80`,
        screen: [
          '/bin/bash: line 1: exec: claude: not found',
          '',
          '[exited]',
          'Pane is dead (status 127, Thu Jul  2 22:01:28 2026)',
        ].join('\n'),
      }),
      sendActions: async () => ({ commands: [] }),
      sendInterrupt: async () => 'tmux send-keys C-c',
      injectPromptIntoPane: async () => ({ commands: [] }),
    };

    const result = await waitForRuntimeTmuxReady({
      runtime: 'claude',
      sessionName: 'claude_dead',
      target: 'claude_dead:0.0',
      core,
      onStateTransition: (transition) => transitions.push(transition),
    });

    assert.equal(result.ready, false);
    assert.equal(result.sessionExists, true);
    assert.equal(result.paneDead?.status, 127);
    assert.match(result.paneDead?.line || '', /Pane is dead/);
    assert.deepEqual(result.commands, ['tmux capture-pane -t claude_dead:0.0 -p -S -80']);
    assert.deepEqual(transitions.map((transition) => [transition.from, transition.to]), [
      ['starting', 'polling'],
      ['polling', 'dead'],
    ]);
  });

  it('does not count IM selection wait time against runtime readiness timeout', async () => {
    const oldTimeout = process.env.CODELARK_CODEX_RESUME_TMUX_READY_TIMEOUT_MS;
    const oldPoll = process.env.CODELARK_CODEX_RESUME_TMUX_READY_POLL_MS;
    try {
      process.env.CODELARK_CODEX_RESUME_TMUX_READY_TIMEOUT_MS = '120';
      process.env.CODELARK_CODEX_RESUME_TMUX_READY_POLL_MS = '50';
      let captureCount = 0;
      const sentActions: Array<{ target: string; actions: TmuxSendAction[] }> = [];
      const core: TmuxCore = {
        commandPreview: (args) => ['tmux', ...args].join(' '),
        hasSession: async (name) => ({ exists: true, command: `tmux has-session -t ${name}` }),
        killSession: async (name) => `tmux kill-session -t ${name}`,
        listSessions: async () => ({ sessions: [], command: 'tmux list-sessions' }),
        ensureDetachedSession: async () => ({ existed: false, command: 'tmux new-session -d -s codex_slow_selection', commands: ['tmux new-session -d -s codex_slow_selection'] }),
        capturePane: async (name) => {
          captureCount += 1;
          return {
            command: `tmux capture-pane -t ${name} -p -S -80`,
            screen: captureCount === 1
              ? [
                'Do you trust the contents of this directory?',
                '› 1. Yes, continue',
                '  2. No, quit',
                'Press enter to confirm or esc to cancel',
              ].join('\n')
              : 'OpenAI Codex\n\n› ',
          };
        },
        sendActions: async (target, actions) => {
          sentActions.push({ target, actions });
          return { commands: actions.map((action) => action.type === 'key' ? `tmux send-keys -t ${target} ${action.key}` : `tmux send-keys -t ${target} -l ${action.text}`) };
        },
        sendInterrupt: async () => 'tmux send-keys -t codex_slow_selection C-c',
        injectPromptIntoPane: async () => ({ commands: [] }),
      };

      const result = await waitForRuntimeTmuxReady({
        runtime: 'codex',
        sessionName: 'codex_slow_selection',
        core,
        onSelectionPrompt: async () => {
          await new Promise((resolve) => setTimeout(resolve, 160));
          return 'yes_proceed' as const;
        },
      });

      assert.equal(result.ready, true);
      assert.equal(captureCount >= 2, true);
      assert.deepEqual(sentActions, [{
        target: 'codex_slow_selection',
        actions: [{ type: 'key', key: 'Enter' }],
      }]);
    } finally {
      if (oldTimeout === undefined) delete process.env.CODELARK_CODEX_RESUME_TMUX_READY_TIMEOUT_MS;
      else process.env.CODELARK_CODEX_RESUME_TMUX_READY_TIMEOUT_MS = oldTimeout;
      if (oldPoll === undefined) delete process.env.CODELARK_CODEX_RESUME_TMUX_READY_POLL_MS;
      else process.env.CODELARK_CODEX_RESUME_TMUX_READY_POLL_MS = oldPoll;
    }
  });

  it('keeps waiting through a Codex update that outlives the normal startup window', async () => {
    const oldTimeout = process.env.CODELARK_CODEX_RESUME_TMUX_READY_TIMEOUT_MS;
    const oldPoll = process.env.CODELARK_CODEX_RESUME_TMUX_READY_POLL_MS;
    try {
      process.env.CODELARK_CODEX_RESUME_TMUX_READY_TIMEOUT_MS = '120';
      process.env.CODELARK_CODEX_RESUME_TMUX_READY_POLL_MS = '50';
      let captureCount = 0;
      let updateSelected = false;
      const transitions: RuntimeTmuxReadinessTransition[] = [];
      const core: TmuxCore = {
        commandPreview: (args) => ['tmux', ...args].join(' '),
        hasSession: async (name) => ({ exists: true, command: `tmux has-session -t ${name}` }),
        killSession: async (name) => `tmux kill-session -t ${name}`,
        listSessions: async () => ({ sessions: [], command: 'tmux list-sessions' }),
        ensureDetachedSession: async () => ({ existed: false, commands: [] }),
        capturePane: async (target) => {
          captureCount += 1;
          if (captureCount === 1) {
            return {
              command: `tmux capture-pane -t ${target} -p -S -80`,
              screen: [
                'Update available! 0.0.0 -> 9.9.9',
                '› 1. Update now',
                '  2. Skip',
                '  3. Skip until next version',
                'Press enter to confirm or esc to cancel',
              ].join('\n'),
            };
          }
          if (captureCount === 2) {
            await new Promise((resolve) => setTimeout(resolve, 90));
            return {
              command: `tmux capture-pane -t ${target} -p -S -80`,
              screen: 'Codex updating global CLI...\nInstalling update...',
            };
          }
          return {
            command: `tmux capture-pane -t ${target} -p -S -80`,
            screen: 'OpenAI Codex\n\n› ',
          };
        },
        sendActions: async (target, actions) => {
          updateSelected = true;
          return {
            commands: actions.map((action) => action.type === 'key'
              ? `tmux send-keys -t ${target} ${action.key}`
              : `tmux send-keys -t ${target} -l ${action.text}`),
          };
        },
        sendInterrupt: async () => 'tmux send-keys C-c',
        injectPromptIntoPane: async () => ({ commands: [] }),
      };

      const startedAt = Date.now();
      const result = await waitForRuntimeTmuxReady({
        runtime: 'codex',
        sessionName: 'codex_slow_update',
        core,
        onSelectionPrompt: () => 'update_now',
        onStateTransition: (transition) => transitions.push(transition),
      });

      assert.equal(result.ready, true);
      assert.equal(updateSelected, true);
      assert.equal(captureCount, 3);
      assert.equal(Date.now() - startedAt > 120, true, 'the update must cross the normal startup timeout');
      assert.equal(
        (transitions.find((transition) => transition.to === 'selection_resolved')?.timeoutMs || 0) > 120,
        true,
        'update_now should switch the readiness state machine to its update window',
      );
    } finally {
      if (oldTimeout === undefined) delete process.env.CODELARK_CODEX_RESUME_TMUX_READY_TIMEOUT_MS;
      else process.env.CODELARK_CODEX_RESUME_TMUX_READY_TIMEOUT_MS = oldTimeout;
      if (oldPoll === undefined) delete process.env.CODELARK_CODEX_RESUME_TMUX_READY_POLL_MS;
      else process.env.CODELARK_CODEX_RESUME_TMUX_READY_POLL_MS = oldPoll;
    }
  });

  it('stops readiness immediately when the user dismisses a generic selection false positive', async () => {
    const oldTimeout = process.env.CODELARK_CODEX_RESUME_TMUX_READY_TIMEOUT_MS;
    const oldPoll = process.env.CODELARK_CODEX_RESUME_TMUX_READY_POLL_MS;
    try {
      process.env.CODELARK_CODEX_RESUME_TMUX_READY_TIMEOUT_MS = '500';
      process.env.CODELARK_CODEX_RESUME_TMUX_READY_POLL_MS = '50';
      let captureCount = 0;
      const screen = [
        'OpenAI Codex',
        'Resume paused goal?',
        '› 1. Resume goal',
        '  2. Leave paused',
        'Press enter to confirm or esc to cancel',
      ].join('\n');
      const core: TmuxCore = {
        commandPreview: (args) => ['tmux', ...args].join(' '),
        hasSession: async (name) => ({ exists: true, command: `tmux has-session -t ${name}` }),
        killSession: async (name) => `tmux kill-session -t ${name}`,
        listSessions: async () => ({ sessions: [], command: 'tmux list-sessions' }),
        ensureDetachedSession: async () => ({ existed: false, commands: [] }),
        capturePane: async () => {
          captureCount += 1;
          return { screen, command: 'tmux capture-pane -t codex_not_selection' };
        },
        sendActions: async () => {
          throw new Error('not_selection must not send tmux input');
        },
        sendInterrupt: async () => 'tmux send-keys C-c',
        injectPromptIntoPane: async () => ({ commands: [] }),
      };

      const result = await waitForRuntimeTmuxReady({
        runtime: 'codex',
        sessionName: 'codex_not_selection',
        core,
        onSelectionPrompt: () => 'not_selection',
      });

      assert.equal(result.ready, false);
      assert.equal(result.selectionPrompt?.runtime, 'codex');
      assert.equal(captureCount, 1);
    } finally {
      if (oldTimeout === undefined) delete process.env.CODELARK_CODEX_RESUME_TMUX_READY_TIMEOUT_MS;
      else process.env.CODELARK_CODEX_RESUME_TMUX_READY_TIMEOUT_MS = oldTimeout;
      if (oldPoll === undefined) delete process.env.CODELARK_CODEX_RESUME_TMUX_READY_POLL_MS;
      else process.env.CODELARK_CODEX_RESUME_TMUX_READY_POLL_MS = oldPoll;
    }
  });

  it('uses the shared runtime readiness loop to confirm Claude trust prompts', async () => {
    const oldTimeout = process.env.CODELARK_CLAUDE_TMUX_READY_TIMEOUT_MS;
    const oldPoll = process.env.CODELARK_CLAUDE_TMUX_READY_POLL_MS;
    try {
      process.env.CODELARK_CLAUDE_TMUX_READY_TIMEOUT_MS = '5000';
      process.env.CODELARK_CLAUDE_TMUX_READY_POLL_MS = '50';
      let captureCount = 0;
      const prompts: string[] = [];
      const sentActions: Array<{ target: string; actions: TmuxSendAction[] }> = [];
      const core: TmuxCore = {
        commandPreview: (args) => ['tmux', ...args].join(' '),
        hasSession: async (name) => ({ exists: true, command: `tmux has-session -t ${name}` }),
        killSession: async (name) => `tmux kill-session -t ${name}`,
        listSessions: async () => ({ sessions: [], command: 'tmux list-sessions' }),
        ensureDetachedSession: async () => ({ existed: false, command: 'tmux new-session -d -s claude_trust', commands: ['tmux new-session -d -s claude_trust'] }),
        capturePane: async (target) => {
          captureCount += 1;
          return {
            command: `tmux capture-pane -t ${target} -p -S -80`,
            screen: captureCount === 1
              ? [
                'Quick safety check',
                'Yes, I trust this folder',
                'Enter to confirm',
              ].join('\n')
              : [
                'Claude Code v2.1.160',
                '❯ ',
                '? for shortcuts',
              ].join('\n'),
          };
        },
        sendActions: async (target, actions) => {
          sentActions.push({ target, actions });
          return { commands: actions.map((action) => action.type === 'key' ? `tmux send-keys -t ${target} ${action.key}` : `tmux send-keys -t ${target} -l ${action.text}`) };
        },
        sendInterrupt: async () => 'tmux send-keys -t claude_trust C-c',
        injectPromptIntoPane: async () => ({ commands: [] }),
      };

      const result = await waitForRuntimeTmuxReady({
        runtime: 'claude',
        sessionName: 'claude_trust',
        target: 'claude_trust:0.0',
        core,
        afterSelectionDelayMs: 0,
        onSelectionPrompt: (selectionPrompt) => {
          prompts.push(selectionPrompt.kind);
        },
      });

      assert.equal(result.ready, true);
      assert.deepEqual(prompts, ['trust']);
      assert.deepEqual(sentActions, [{
        target: 'claude_trust:0.0',
        actions: [{ type: 'key', key: 'Enter' }],
      }]);
      assert.equal(result.commands.includes('tmux send-keys -t claude_trust:0.0 Enter'), true);
    } finally {
      if (oldTimeout === undefined) delete process.env.CODELARK_CLAUDE_TMUX_READY_TIMEOUT_MS;
      else process.env.CODELARK_CLAUDE_TMUX_READY_TIMEOUT_MS = oldTimeout;
      if (oldPoll === undefined) delete process.env.CODELARK_CLAUDE_TMUX_READY_POLL_MS;
      else process.env.CODELARK_CLAUDE_TMUX_READY_POLL_MS = oldPoll;
    }
  });

  it('retries one swallowed Claude trust confirmation while the same prompt remains visible', async () => {
    const oldTimeout = process.env.CODELARK_CLAUDE_TMUX_READY_TIMEOUT_MS;
    const oldPoll = process.env.CODELARK_CLAUDE_TMUX_READY_POLL_MS;
    try {
      process.env.CODELARK_CLAUDE_TMUX_READY_TIMEOUT_MS = '5000';
      process.env.CODELARK_CLAUDE_TMUX_READY_POLL_MS = '50';
      const trustScreen = [
        'Quick safety check',
        'Yes, I trust this folder',
        'Enter to confirm',
      ].join('\n');
      let sendCount = 0;
      let promptCount = 0;
      const core: TmuxCore = {
        commandPreview: (args) => ['tmux', ...args].join(' '),
        hasSession: async (name) => ({ exists: true, command: `tmux has-session -t ${name}` }),
        killSession: async (name) => `tmux kill-session -t ${name}`,
        listSessions: async () => ({ sessions: [], command: 'tmux list-sessions' }),
        ensureDetachedSession: async () => ({ existed: false, commands: [] }),
        capturePane: async () => ({
          command: 'tmux capture-pane -t claude_swallowed_trust',
          screen: sendCount >= 2 ? 'Claude Code v2.1.160\n❯ \n? for shortcuts' : trustScreen,
        }),
        sendActions: async () => {
          sendCount += 1;
          return { commands: ['tmux send-keys -t claude_swallowed_trust Enter'] };
        },
        sendInterrupt: async () => '',
        injectPromptIntoPane: async () => ({ commands: [] }),
      };

      const result = await waitForRuntimeTmuxReady({
        runtime: 'claude',
        sessionName: 'claude_swallowed_trust',
        core,
        afterSelectionDelayMs: 0,
        onSelectionPrompt: () => {
          promptCount += 1;
        },
      });

      assert.equal(result.ready, true);
      assert.equal(promptCount, 1, 'the resolver remains the single lifecycle owner');
      assert.equal(sendCount, 2, 'the same owner retries only after the unchanged prompt is observed');
    } finally {
      if (oldTimeout === undefined) delete process.env.CODELARK_CLAUDE_TMUX_READY_TIMEOUT_MS;
      else process.env.CODELARK_CLAUDE_TMUX_READY_TIMEOUT_MS = oldTimeout;
      if (oldPoll === undefined) delete process.env.CODELARK_CLAUDE_TMUX_READY_POLL_MS;
      else process.env.CODELARK_CLAUDE_TMUX_READY_POLL_MS = oldPoll;
    }
  });

  it('inspects runtime tmux sessions and reports selection prompts', async () => {
    const core: TmuxCore = {
      commandPreview: (args) => ['tmux', ...args].join(' '),
      hasSession: async (name) => ({ exists: true, command: `tmux has-session -t ${name}` }),
      killSession: async (name) => `tmux kill-session -t ${name}`,
      listSessions: async () => ({ sessions: [], command: 'tmux list-sessions' }),
      ensureDetachedSession: async () => ({ existed: false, commands: [] }),
      capturePane: async (target, lines) => ({
        command: `tmux capture-pane -t ${target} -p -S -${lines}`,
        screen: [
          'A task is already running.',
          'Do you want to replace the current goal?',
          '› 1. Replace current goal',
          '  2. Cancel',
          'Press enter to confirm or esc to cancel',
        ].join('\n'),
      }),
      sendActions: async () => ({ commands: [] }),
      sendInterrupt: async () => 'tmux send-keys C-c',
      injectPromptIntoPane: async () => ({ commands: [] }),
    };

    const inspected = await inspectRuntimeTmuxSession({
      runtime: 'codex',
      sessionName: 'codex_goal',
      lines: 80,
      core,
    });

    assert.equal(inspected.exists, true);
    assert.equal(inspected.selectionPrompt?.runtime, 'codex');
    assert.equal(inspected.selectionPrompt?.kind, 'goal');
    assert.equal(inspected.selectionPrompt?.defaultChoice, 'replace_current_goal');
  });

  it('cleans up runtime tmux sessions through the shared cleanup helper', async () => {
    const killed: string[] = [];
    const core: TmuxCore = {
      commandPreview: (args) => ['tmux', ...args].join(' '),
      hasSession: async (name) => ({ exists: true, command: `tmux has-session -t ${name}` }),
      killSession: async (name) => {
        killed.push(name);
        return `tmux kill-session -t ${name}`;
      },
      listSessions: async () => ({ sessions: [], command: 'tmux list-sessions' }),
      ensureDetachedSession: async () => ({ existed: false, commands: [] }),
      capturePane: async () => ({ screen: '', command: 'tmux capture-pane' }),
      sendActions: async () => ({ commands: [] }),
      sendInterrupt: async () => 'tmux send-keys C-c',
      injectPromptIntoPane: async () => ({ commands: [] }),
    };

    const cleanup = await cleanupRuntimeTmuxSession({
      runtime: 'claude',
      sessionName: 'claude_old',
      core,
    });

    assert.equal(cleanup.killed, true);
    assert.deepEqual(killed, ['claude_old']);
    assert.deepEqual(cleanup.commands, ['tmux kill-session -t claude_old']);
  });
});
