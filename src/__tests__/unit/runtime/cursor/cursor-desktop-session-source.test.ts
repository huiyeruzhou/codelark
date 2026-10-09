import assert from 'node:assert/strict';
import { it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CursorDesktopSessionSource, cursorDesktopToolResult, statCursorDesktopStore } from '../../../../runtime/cursor/desktop-session-source.js';
import { reconcileBridgeMirrorCursor } from '../../../../bridge/mirror/cursor.js';
import { applyToolCallEventToTools, toolCallEventFromMirrorRecord } from '../../../../shared/progress/tool-events.js';
import { buildToolProgressBlocks } from '../../../../shared/progress/tool-rendering.js';
import type { ToolCallInfo } from '../../../../domain/progress.js';

it('mirrors real outputs and late completions under stable native IDs across WAL snapshots', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-native-results-'));
  const file = path.join(dir, 'state.vscdb');
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)');
    const put = (key: string, value: unknown) => db.prepare('INSERT OR REPLACE INTO cursorDiskKV VALUES (?,?)').run(key, JSON.stringify(value));
    const at = '2026-10-09T10:00:00.000Z';
    const headers = ['user', 'tool', 'answer'].map((bubbleId) => ({ bubbleId, createdAt: at }));
    const root = { status: 'running', fullConversationHeadersOnly: headers };
    const tool = { type: 2, createdAt: at, toolFormerData: {
      name: 'run_terminal_command_v2', toolCallId: 'native-id\nwith-newline',
      status: 'running', params: JSON.stringify({ command: 'printf result' }),
    } };
    put('composerData:t1', root);
    put('bubbleId:t1:user', { type: 1, text: 'Run it', createdAt: at });
    put('bubbleId:t1:tool', tool);
    put('bubbleId:t1:answer', { type: 2, text: 'Still working', createdAt: at });
    const source = new CursorDesktopSessionSource(file);
    const first = source.read('t1')!;
    const start = first.records.find((r) => r.type === 'tool_started')!;
    assert.equal(start.toolName, 'Shell');
    const cursor = reconcileBridgeMirrorCursor(null, first.records).nextCursor;
    const previousLength = first.records.length;
    put('bubbleId:t1:tool', { ...tool, completedAtMs: Date.parse(at) + 1000,
      toolFormerData: { ...tool.toolFormerData, status: 'completed', result: JSON.stringify({ output: 'actual output\nlast line', exitCode: 0 }) } });
    const second = source.read('t1')!;
    const delta = reconcileBridgeMirrorCursor(cursor, second.records).deliverableRecords;
    assert.equal(second.records.length, previousLength + 1);
    assert.deepEqual(delta.map((r) => r.type), ['tool_finished']);
    assert.equal(delta[0]?.toolId, start.toolId);
    assert.equal(delta[0]?.content, 'actual output\nlast line');
    const tools = new Map<string, ToolCallInfo>();
    applyToolCallEventToTools(tools, toolCallEventFromMirrorRecord(start)!);
    applyToolCallEventToTools(tools, toolCallEventFromMirrorRecord(delta[0]!)!);
    assert.match(buildToolProgressBlocks([...tools.values()])[0]!.detail, /actual output\nlast line/);
    assert.equal(source.read('t1')!.records.length, second.records.length);
    assert.ok(statCursorDesktopStore(file)!.size > fs.statSync(file).size);
    put('composerData:t1', { ...root, status: 'completed' });
    const complete = source.read('t1')!;
    assert.equal(complete.nextTurnId, null);
    assert.equal(complete.records.at(-1)?.type, 'task_complete');
    assert.equal(complete.records.filter((r) => r.type === 'tool_finished').length, 1);
    assert.equal(source.read('other'), null);
    assert.ok(new CursorDesktopSessionSource(file).read('t1')!.records.some((r) => r.content.includes('actual output')));
    put('bubbleId:t1:answer2', { type: 2, text: 'Final answer', createdAt: at });
    put('composerData:t1', { ...root, fullConversationHeadersOnly: [...headers, { bubbleId: 'answer2', createdAt: at }], status: 'completed' });
    const revised = source.read('t1')!;
    assert.equal(revised.records.findLast((r) => r.role === 'assistant')?.content, 'Still working\n\nFinal answer');
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

it('reports failed, empty, structured and pruned outputs without inventing historical content', () => {
  assert.deepEqual(cursorDesktopToolResult({ status: 'completed', result: '{"output":""}' }), { content: '', isError: false });
  assert.deepEqual(cursorDesktopToolResult({ status: 'completed', result: '{"output":"failure","exitCode":2}' }), { content: 'failure', isError: true });
  assert.equal(cursorDesktopToolResult({ status: 'cancelled', result: '{}' }).isError, true);
  assert.match(cursorDesktopToolResult({ status: 'completed', result: '{"totalLinesInFile":31}' }).content, /未保留完整原始输出/);
  assert.match(cursorDesktopToolResult({ status: 'completed', additionalData: { isPruned: true, totalMatches: 59 } }).content, /59/);
  const long = 'unchanged\n'.repeat(20000);
  assert.equal(cursorDesktopToolResult({ status: 'completed', result: JSON.stringify({ output: long }) }).content, long);
});
