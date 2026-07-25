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

  it('keeps the existing search presentation while parsing the quoted path correctly', () => {
    const presentation = getToolPresentation({
      id: 'compound-shell',
      name: 'exec_command',
      status: 'complete',
      detail: {
        kind: 'exec_command',
        command: 'rg -n "toolPanels:" src/__tests__ -g \'*.ts\' && git diff --check',
        durationMs: 100,
        output: 'one\ntwo',
      },
    });

    assert.equal(
      presentation.title,
      '🔎 搜索 `toolPanels:` · 路径 `src/__tests__` · 100ms · 输出 2 行',
    );
  });

  it('keeps quoted rg query and path boundaries intact', () => {
    const presentation = getToolPresentation({
      id: 'quoted-search',
      name: 'exec_command',
      status: 'complete',
      detail: { kind: 'exec_command', command: 'rg -n "toolPanels:" src/__tests__ -g \'*.ts\'' },
    });

    assert.equal(presentation.title, '🔎 搜索 `toolPanels:` · 路径 `src/__tests__`');
  });

  it('shows a yielded background terminal id in the title', () => {
    const presentation = getToolPresentation({
      id: 'background-shell',
      name: 'exec_command',
      status: 'complete',
      detail: { kind: 'exec_command', command: 'npm test', runningSessionId: '90' },
    });

    assert.equal(presentation.title, '💻 运行 `npm test` · 后台终端 `90`');
  });

  it('does not show a background marker for a completed wait without a yielded id', () => {
    const presentation = getToolPresentation({
      id: 'completed-wait',
      name: 'wait',
      status: 'complete',
      detail: { kind: 'terminal_stdin', sessionId: '90', isPoll: true },
    });

    assert.equal(presentation.title, '⏳ 等待 终端 `90`');
    assert.doesNotMatch(presentation.title, /后台终端/);
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

  it('lists every apply_patch file when complete Markdown tokens fit', () => {
    const presentation = getToolPresentation({
      id: 'patch-files-fit',
      name: 'apply_patch',
      status: 'complete',
      detail: {
        kind: 'patch_apply',
        files: [
          { path: 'src/app.ts', action: 'update' },
          { path: 'docs/guide.md', action: 'update' },
        ],
      },
    });

    assert.equal(presentation.primary, '🛠️ 修改 2 个文件');
    assert.equal(presentation.secondary, '`src/app.ts` · `docs/guide.md`');
  });

  it('falls back to one complete apply_patch filename instead of cutting inline Markdown', () => {
    const firstPath = `src/${'a'.repeat(96)}.ts`;
    const presentation = getToolPresentation({
      id: 'patch-files-partial',
      name: 'apply_patch',
      status: 'complete',
      detail: {
        kind: 'patch_apply',
        files: [
          { path: firstPath, action: 'update' },
          { path: 'src/second.ts', action: 'update' },
          { path: 'src/third.ts', action: 'update' },
        ],
      },
    });

    assert.equal(presentation.secondary, `\`${firstPath}\` 等 3 个文件`);
    assert.equal((presentation.secondary.match(/`/g) || []).length, 2);
  });

  it('shows only the apply_patch file count when no complete filename fits', () => {
    const presentation = getToolPresentation({
      id: 'patch-file-too-long',
      name: 'apply_patch',
      status: 'complete',
      detail: {
        kind: 'patch_apply',
        files: [
          { path: `src/${'a'.repeat(140)}.ts`, action: 'update' },
          { path: 'src/second.ts', action: 'update' },
        ],
      },
    });

    assert.equal(presentation.title, '🛠️ 修改 2 个文件');
  });
});
