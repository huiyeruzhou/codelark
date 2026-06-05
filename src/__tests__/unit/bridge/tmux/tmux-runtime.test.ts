import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCodexResumeTmuxCommand,
  hasCodexResumeTmuxReadyPrompt,
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
});
