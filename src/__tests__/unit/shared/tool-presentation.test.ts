import '../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { getToolPresentation } from '../../../shared/progress/tool-presentation.js';

describe('getToolPresentation', () => {
  it('uses a single-line action summary for read-like shell commands without repeating success', () => {
    const presentation = getToolPresentation({
      id: 'read-shell',
      name: 'exec_command',
      status: 'complete',
      detail: {
        kind: 'exec_command',
        command: "sed -n '20,60p' src/app.ts",
        durationMs: 125,
        output: 'line 20\nline 21',
      },
    });

    assert.equal(presentation.primary, '📖 读取 `src/app.ts`');
    assert.equal(presentation.secondary, '第 20–60 行 · 125ms · 输出 2 行');
    assert.equal(presentation.title, '📖 读取 `src/app.ts` · 第 20–60 行 · 125ms · 输出 2 行');
    assert.doesNotMatch(presentation.title, /\n/);
    assert.doesNotMatch(presentation.title, /完成|Success/);
  });

  it('surfaces Kimi search query, path, and match count in the collapsed title', () => {
    const presentation = getToolPresentation({
      id: 'grep-1',
      name: 'Grep',
      status: 'complete',
      detail: {
        kind: 'file_search',
        query: 'tool_call',
        path: 'src',
        matchCount: 18,
      },
    });

    assert.equal(presentation.title, '🔎 搜索 `tool_call` · 路径 `src` · 18 处');
  });

  it('shows non-zero exit codes exactly once', () => {
    const presentation = getToolPresentation({
      id: 'exec-fail',
      name: 'Bash',
      status: 'error',
      detail: { kind: 'exec_command', command: 'npm test', exitCode: 2, durationMs: 1400 },
    });

    assert.equal(presentation.title, '⚠️ 运行 `npm test` · exit 2 · 1.4s');
    assert.equal((presentation.title.match(/exit 2/g) || []).length, 1);
    assert.doesNotMatch(presentation.title, /异常|失败|Fail/);
  });
});
