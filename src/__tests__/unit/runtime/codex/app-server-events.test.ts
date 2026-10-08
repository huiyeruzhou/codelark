import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  appServerFileChangePatchText,
  protocolItemRecord,
} from '../../../../runtime/codex/app-server-events.js';
import { CONTEXT_COMPACTED_NOTICE } from '../../../../runtime/codex/session-index/internal-control-events.js';
import { renderToolCallDetailMarkdown } from '../../../../shared/progress/tool-call-details.js';
import { getToolPresentation } from '../../../../shared/progress/tool-presentation.js';

describe('app-server protocol item records', () => {
  it('renders array-shaped fileChange items as a multi-file patch instead of raw JSON', () => {
    const item = {
      id: 'change-1',
      type: 'FileChange',
      status: 'completed',
      changes: [
        {
          path: 'src/app.ts',
          kind: { type: 'update', move_path: null },
          diff: '@@\n-const ready = false;\n+const ready = true;',
        },
        {
          path: 'scripts/check.py',
          kind: { type: 'add' },
          content: 'ready = True\n',
        },
      ],
    };
    const patchText = appServerFileChangePatchText(item);
    assert.equal(patchText, [
      '*** Begin Patch',
      '*** Update File: src/app.ts',
      '@@',
      '-const ready = false;',
      '+const ready = true;',
      '*** Add File: scripts/check.py',
      '+ready = True',
      '+',
      '*** End Patch',
    ].join('\n'));

    const started = protocolItemRecord('thread', 'turn', { ...item, status: 'inProgress' }, false);
    assert.equal(started?.type, 'tool_started');
    assert.equal(started?.toolInput, patchText);
    assert.equal(started?.toolDetail?.kind, 'patch_apply');

    const record = protocolItemRecord('thread', 'turn', item, true);
    assert(record);
    assert.equal(record.type, 'tool_finished');
    assert.equal(record.toolName, 'apply_patch');
    assert.equal(record.toolInput, patchText);
    assert.equal(record.isError, false);
    assert.deepEqual(record.toolDetail?.kind === 'patch_apply' ? record.toolDetail.files : null, [
      { path: 'src/app.ts', action: 'update' },
      { path: 'scripts/check.py', action: 'add' },
    ]);
    const markdown = renderToolCallDetailMarkdown({
      id: item.id,
      name: 'apply_patch',
      status: 'complete',
      detail: record.toolDetail,
    });
    assert.match(markdown, /```typescript\n\*\*\* Update File: src\/app\.ts/);
    assert.match(markdown, /```python\n\*\*\* Add File: scripts\/check\.py/);
    assert.doesNotMatch(markdown, /"type":\s*"fileChange"|```json/);
  });

  it('supports object-shaped FileChange payloads, moves, unified_diff, and failures', () => {
    const item = {
      id: 'change-2',
      type: 'fileChange',
      status: 'failed',
      changes: {
        'docs/old.md': {
          type: 'update',
          unified_diff: '@@\n-old\n+new',
          move_path: 'docs/new.md',
        },
      },
    };
    const record = protocolItemRecord('thread', 'turn', item, true);
    assert(record);
    assert.equal(record.isError, true);
    assert.match(String(record.toolInput), /\*\*\* Update File: docs\/old\.md/);
    assert.match(String(record.toolInput), /\*\*\* Move to: docs\/new\.md/);
    assert.deepEqual(record.toolDetail?.kind === 'patch_apply' ? record.toolDetail.files : null, [{
      path: 'docs/old.md',
      action: 'move',
      toPath: 'docs/new.md',
    }]);
  });

  it('normalizes mcpToolCall items from the app-server schema', () => {
    const item = {
      type: 'mcpToolCall',
      id: 'call-mcp-1',
      server: 'cua_repl',
      tool: 'js',
      status: 'completed',
      arguments: { code: 'await cua.getState()', title: '读取状态' },
      appContext: null,
      pluginId: 'unified-computer-use@openai-bundled',
      readOnlyHint: true,
      result: {
        content: [{ type: 'text', text: 'Window: Cursor' }],
        structuredContent: null,
        isError: false,
      },
      error: null,
      durationMs: 42,
    };

    const started = protocolItemRecord('thread', 'turn', { ...item, status: 'inProgress', result: null }, false);
    assert.equal(started?.type, 'tool_started');
    assert.equal(started?.toolName, 'mcp__cua_repl__js');
    assert.deepEqual(started?.toolInput, item.arguments);
    assert.deepEqual(started?.toolDetail, {
      kind: 'mcp',
      server: 'cua_repl',
      tool: 'js',
      title: '读取状态',
      input: item.arguments,
    });

    const completed = protocolItemRecord('thread', 'turn', item, true);
    assert.equal(completed?.type, 'tool_finished');
    assert.equal(completed?.toolName, 'mcp__cua_repl__js');
    assert.equal(completed?.content, 'Window: Cursor');
    assert.equal(completed?.isError, false);
    assert.deepEqual(completed?.toolDetail, {
      kind: 'mcp',
      server: 'cua_repl',
      tool: 'js',
      title: '读取状态',
      input: item.arguments,
      output: 'Window: Cursor',
    });
    const presentation = getToolPresentation({
      id: item.id,
      name: completed?.toolName || '',
      status: 'complete',
      detail: completed?.toolDetail,
    });
    assert.equal(presentation.title, '🔧 读取状态');
    const markdown = renderToolCallDetailMarkdown({
      id: item.id,
      name: completed?.toolName || '',
      status: 'complete',
      detail: completed?.toolDetail,
    });
    assert.match(markdown, /mcp: `cua_repl\/js`/u);
    assert.match(markdown, /"code": "await cua\.getState\(\)"/u);
    assert.match(markdown, /Window: Cursor/u);
    assert.doesNotMatch(markdown, /"type":\s*"mcpToolCall"/u);
  });

  it('uses failed MCP result text as the error instead of rendering the raw item', () => {
    const completed = protocolItemRecord('thread', 'turn', {
      type: 'McpToolCall',
      id: 'call-mcp-2',
      server: 'cua_repl',
      tool: 'js',
      status: 'failed',
      arguments: { code: 'await app.click(22)' },
      result: {
        content: [{ type: 'text', text: 'elementIndex must be an integer' }],
        isError: true,
      },
      error: null,
    }, true);

    assert.equal(completed?.toolName, 'mcp__cua_repl__js');
    assert.equal(completed?.content, 'elementIndex must be an integer');
    assert.equal(completed?.isError, true);
    assert.equal(completed?.toolDetail?.kind === 'mcp' ? completed.toolDetail.errorText : '', 'elementIndex must be an integer');
    assert.doesNotMatch(completed?.content || '', /"type":\s*"McpToolCall"/u);
  });

  it('uses the same context-compaction notice as the rollout mirror', () => {
    assert.equal(
      protocolItemRecord('thread', 'turn', { id: 'compact-1', type: 'ContextCompaction' }, true)?.content,
      CONTEXT_COMPACTED_NOTICE,
    );
    assert.equal(
      protocolItemRecord('thread', 'turn', { id: 'compact-1', type: 'contextCompaction' }, false),
      undefined,
    );
  });
});
