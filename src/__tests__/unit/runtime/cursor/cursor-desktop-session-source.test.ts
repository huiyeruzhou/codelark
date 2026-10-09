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

it('mirrors real outputs and late completions under stable native IDs across WAL snapshots', async () => {
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
    let status = 'running';
    const source = new CursorDesktopSessionSource(file, { readStatus: async () => status, pollIntervalMs: 0 });
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
    status = 'completed';
    await source.refresh('t1');
    put('bubbleId:t1:answer2', { type: 2, text: 'Final answer', createdAt: at });
    headers.push({ bubbleId: 'answer2', createdAt: at });
    put('composerData:t1', { ...root, status: 'completed' });
    await source.refresh('t1');
    assert.notEqual(source.read('t1')!.nextTurnId, null, 'final output invalidates the first terminal observation');
    assert.equal(source.read('t1')!.records.findLast((r) => r.role === 'assistant')?.content, 'Still working\n\nFinal answer');
    put('composerData:unrelated', { status: 'running', fullConversationHeadersOnly: [] });
    await source.refresh('t1');
    const complete = source.read('t1')!;
    assert.equal(complete.nextTurnId, null);
    assert.equal(complete.records.at(-1)?.type, 'task_complete');
    assert.equal(complete.records.filter((r) => r.type === 'tool_finished').length, 1);
    assert.equal(source.read('other'), null);
    assert.ok(new CursorDesktopSessionSource(file).read('t1')!.records.some((r) => r.content.includes('actual output')));
    put('bubbleId:t1:answer3', { type: 2, text: 'Historical revision', createdAt: at });
    put('composerData:t1', { ...root, fullConversationHeadersOnly: [...headers, { bubbleId: 'answer3', createdAt: at }], status: 'completed' });
    const revised = source.read('t1')!;
    assert.equal(revised.records.findLast((r) => r.role === 'assistant')?.content, 'Still working\n\nFinal answer', 'closed historical turns do not reopen');
    put('bubbleId:t1:user2', { type: 1, text: 'Next prompt', createdAt: at });
    put('composerData:t1', { ...root, fullConversationHeadersOnly: [...headers, { bubbleId: 'user2', createdAt: at }] });
    status = 'error';
    await source.refresh('t1');
    assert.equal(source.read('t1')!.nextTurnId, 'cursor-desktop:t1:turn:user2');
    await source.refresh('t1');
    assert.equal(source.read('t1')!.records.at(-1)?.type, 'task_aborted');
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

it('does not finish a live turn from stale persisted aborted state on each tool completion', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-stale-status-'));
  const file = path.join(dir, 'state.vscdb');
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)');
    const put = (key: string, value: unknown) => db.prepare('INSERT OR REPLACE INTO cursorDiskKV VALUES (?,?)').run(key, JSON.stringify(value));
    const headers = [{ bubbleId: 'user' }];
    put('bubbleId:t:user', { type: 1, text: 'keep working', createdAt: '2026-10-09T11:10:00.000Z' });
    let status = 'running';
    const source = new CursorDesktopSessionSource(file, { readStatus: async () => status, pollIntervalMs: 0 });
    for (let i = 0; i < 5; i += 1) {
      headers.push({ bubbleId: `tool-${i}` });
      put(`bubbleId:t:tool-${i}`, { type: 2, createdAt: `2026-10-09T11:13:0${i}.000Z`, toolFormerData: {
        name: 'run_terminal_command_v2', status: 'completed', result: JSON.stringify({ output: `result-${i}` }),
      } });
      put('composerData:t', { status: 'aborted', lastUpdatedAt: Date.parse('2026-10-09T11:10:00.000Z'), fullConversationHeadersOnly: headers });
      await source.refresh('t');
      const snapshot = source.read('t')!;
      assert.equal(snapshot.nextTurnId, 'cursor-desktop:t:turn:user');
      assert.equal(snapshot.records.filter((r) => r.type === 'task_complete' || r.type === 'task_aborted').length, 0);
      assert.equal(snapshot.records.filter((r) => r.type === 'tool_finished').length, i + 1);
    }
    const disk = statCursorDesktopStore(file);
    status = 'completed';
    assert.equal(await source.refresh('t'), true);
    assert.notEqual(source.read('t')!.nextTurnId, null, 'allow final native bubbles to settle');
    await source.refresh('t');
    assert.deepEqual(statCursorDesktopStore(file), disk, 'status-only completion needs no SQLite write');
    const final = source.read('t')!;
    const finalCount = final.records.length;
    assert.equal(final.nextTurnId, null);
    assert.equal(final.records.filter((r) => r.type === 'task_complete').length, 1);
    assert.equal(final.records.filter((r) => r.type === 'task_aborted').length, 0);
    put('bubbleId:t:tool-4', { type: 2, createdAt: '2026-10-09T11:13:04.000Z', completedAtMs: Date.parse('2026-10-09T11:14:00.000Z'), toolFormerData: {
      name: 'run_terminal_command_v2', status: 'completed', result: '{"output":"late output"}',
    } });
    await source.refresh('t');
    assert.equal(source.read('t')!.records.filter((r) => r.type === 'task_complete').length, 1, 'late revisions never mint another terminal');
    assert.equal(source.read('t')!.records.length, finalCount, 'closed turn revisions cannot start another card');
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

it('discards a cached or racing terminal after new native activity and fails open on unavailable live state', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-status-race-'));
  const file = path.join(dir, 'state.vscdb');
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)');
    const put = (key: string, value: unknown) => db.prepare('INSERT OR REPLACE INTO cursorDiskKV VALUES (?,?)').run(key, JSON.stringify(value));
    const writeUser = (id: string) => {
      put(`bubbleId:t:${id}`, { type: 1, text: id, createdAt: '2026-10-09T11:10:00.000Z' });
      put('composerData:t', { status: 'completed', fullConversationHeadersOnly: [{ bubbleId: id }] });
    };
    writeUser('old');
    let fail = false;
    let race = false;
    const source = new CursorDesktopSessionSource(file, { pollIntervalMs: 0, readStatus: async () => {
      if (fail) throw new Error('offline');
      if (race) writeUser('racing');
      return 'completed';
    } });
    await source.refresh('t');
    writeUser('new');
    assert.equal(source.read('t')!.nextTurnId, 'cursor-desktop:t:turn:new');
    race = true;
    await source.refresh('t');
    assert.equal(source.read('t')!.nextTurnId, 'cursor-desktop:t:turn:racing');
    fail = true;
    await source.refresh('t');
    assert.equal(source.read('t')!.records.filter((r) => r.type === 'task_complete' || r.type === 'task_aborted').length, 0);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
