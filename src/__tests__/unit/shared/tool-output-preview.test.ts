import assert from 'node:assert/strict';
import { it } from 'node:test';
import { buildToolProgressBlocks } from '../../../shared/progress/tool-rendering.js';
import type { ToolCallInfo } from '../../../domain/progress.js';

for (const output of ['正文😀'.repeat(10_000), 'line\n'.repeat(5_000), 'a'.repeat(100_000)]) {
  it(`bounds retained tool output in the card while keeping the original (${Buffer.byteLength(output)} bytes)`, () => {
    const tool: ToolCallInfo = { id: 'read', name: 'Read', input: JSON.stringify({ path: '/very/long/project/src/example.py' }),
      output, status: 'complete', showOutput: true };
    const block = buildToolProgressBlocks([tool])[0]!;
    assert.match(block.detail, /显示 \d+\/\d+ 字符 · \d+\/\d+ 行/);
    assert.ok(Buffer.byteLength(block.detail) < 4_300);
    assert.equal(tool.output, output, 'display limits must not rewrite runtime results');
    assert.equal((block.detail.match(/^```/gm) || []).length, 2);
    assert.equal(block.presentation.primary, '📖 读取 `example.py`');
    assert.equal(block.detail.split('/very/long/project/src/example.py').length - 1, 1);
  });
}

it('shows a short read exactly once, without JSON escaping or a duplicate path in the title', () => {
  const [block] = buildToolProgressBlocks([{ id: 'read', name: 'Read', status: 'complete', showOutput: true,
    input: JSON.stringify({ path: 'C:\\long\\project\\file.py' }), output: 'first line\nsecond line' }]);
  assert.equal(block!.presentation.primary, '📖 读取 `file.py`');
  assert.match(block!.detail, /first line\nsecond line/);
  assert.equal(block!.detail.split('first line').length - 1, 1);
  assert.doesNotMatch(block!.detail, /显示 \d+\/|\\nsecond/);
});

it('keeps the edited project path in the diff while using only its filename as the title', () => {
  const file = '/very/long/project/src/example.py';
  const [block] = buildToolProgressBlocks([{ id: 'edit', name: 'apply_patch', status: 'complete',
    input: JSON.stringify({ patch: `*** Begin Patch\n*** Update File: ${file}\n@@\n-old\n+new\n*** End Patch`, workdir: '/very/long/project' }) }]);
  assert.equal(block!.presentation.primary, '🛠️ 修改 `example.py`');
  assert.equal(block!.detail.split('src/example.py').length - 1, 1);
  assert.match(block!.detail, /-old\n\+new/);
});

it('uses native search counts instead of counting formatted JSON lines as matches', () => {
  for (const totalMatches of [0, 123]) {
    const [block] = buildToolProgressBlocks([{ id: 'search', name: 'Search', status: 'complete', showOutput: true,
      output: JSON.stringify({ totalMatches, truncated: true }, null, 2) }]);
    assert.match(block!.presentation.title, new RegExp(`${totalMatches} 处`));
  }
  const [glob] = buildToolProgressBlocks([{ id: 'glob', name: 'Search', status: 'complete', showOutput: true,
    output: JSON.stringify({ totalFiles: 123, truncated: false }, null, 2) }]);
  assert.doesNotMatch(glob!.presentation.title, /\d+ 处/);
});
