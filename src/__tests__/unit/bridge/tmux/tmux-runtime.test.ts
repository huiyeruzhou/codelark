import '../../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  buildCodexResumeTmuxCommand,
  CodexResumeTmuxLaunchError,
  hasCodexResumeTmuxReadyPrompt,
  startCodexResumeTmuxSession,
  type TmuxCore,
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
  it('reports an alive Codex tmux session that never reaches the idle input prompt', async () => {
    const previousTimeout = process.env.CODELARK_CODEX_RESUME_TMUX_READY_TIMEOUT_MS;
    const previousPoll = process.env.CODELARK_CODEX_RESUME_TMUX_READY_POLL_MS;
    process.env.CODELARK_CODEX_RESUME_TMUX_READY_TIMEOUT_MS = '10';
    process.env.CODELARK_CODEX_RESUME_TMUX_READY_POLL_MS = '50';
    const core: TmuxCore = {
      commandPreview: (args) => ['tmux', ...args].join(' '),
      hasSession: async (name) => ({ exists: true, command: `tmux has-session -t ${name}` }),
      killSession: async (name) => `tmux kill-session -t ${name}`,
      listSessions: async () => ({ sessions: [], command: 'tmux list-sessions' }),
      ensureDetachedSession: async () => ({ existed: false, command: 'tmux new-session -d -s codex_busy', commands: ['tmux new-session -d -s codex_busy'] }),
      capturePane: async () => ({ screen: 'OpenAI Codex\nworking on previous turn...', command: 'tmux capture-pane -t codex_busy -p -S -80' }),
      sendActions: async () => ({ commands: [] }),
      sendInterrupt: async () => 'tmux send-keys -t codex_busy C-c',
      injectPromptIntoPane: async () => ({ commands: [] }),
    };

    try {
      await assert.rejects(
        () => startCodexResumeTmuxSession({
          sessionName: 'codex_busy',
          threadId: 'busy-thread',
          bridgeSessionId: 'bridge-busy',
          workingDirectory: '/tmp',
        }, core),
        (error) => {
          assert.ok(error instanceof CodexResumeTmuxLaunchError);
          assert.equal(error.details.sessionExists, true);
          assert.match(error.details.reason, /idle input prompt/);
          assert.match(error.details.lastScreen || '', /working on previous turn/);
          return true;
        },
      );
    } finally {
      if (previousTimeout === undefined) delete process.env.CODELARK_CODEX_RESUME_TMUX_READY_TIMEOUT_MS;
      else process.env.CODELARK_CODEX_RESUME_TMUX_READY_TIMEOUT_MS = previousTimeout;
      if (previousPoll === undefined) delete process.env.CODELARK_CODEX_RESUME_TMUX_READY_POLL_MS;
      else process.env.CODELARK_CODEX_RESUME_TMUX_READY_POLL_MS = previousPoll;
    }
  });
});
