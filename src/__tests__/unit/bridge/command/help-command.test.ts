import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildHelpCommandResponse } from '../../../../bridge/command/help.js';

describe('help command', () => {
  it('groups user-visible slash commands by bridge/runtime scope', () => {
    const text = buildHelpCommandResponse();
    for (const section of [
      '运维',
      'Bridge 控制',
      '终端工具',
      'SessionRuntime 配置',
      'GlobalRuntime 配置',
      'GlobalBridge 配置',
      '自动化',
    ]) {
      assert.match(text, new RegExp(`\\*\\*${section}\\*\\*`));
    }
    assert.match(text, /\/provider.*Bridge 控制|Bridge 控制[\s\S]*\/provider/);
    assert.match(text, /Claude 可用 `pty \| tmux \| sdk`/);
    assert.match(text, /终端工具[\s\S]*\/shell[\s\S]*\/tmux[\s\S]*\/cat[\s\S]*\/file/);
    assert.match(text, /运维[\s\S]*\/doctor[\s\S]*\/his/);
    assert.match(text, /Bridge 控制[\s\S]*\/require-at/);
    assert.doesNotMatch(text, /SessionRuntime 配置[\s\S]*\/require-at/);
    assert.match(text, /GlobalRuntime 配置[\s\S]*Codex[\s\S]*Claude Code/);
    assert.match(text, /GlobalBridge 配置[\s\S]*defaultWorkspaceRoot[\s\S]*\/ui/);
  });
});
