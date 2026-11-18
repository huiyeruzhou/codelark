import '../../../setup/test-setup.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { cursorVisibleThinkingSummary, readCursorNativeMessages, readCursorNativeUserPrompts, readCursorNativeTodos } from '../../../../runtime/cursor/cli-store.js';
import { cursorAcpSessionStorePath } from '../../../../runtime/cursor/acp-session-policy.js';
import { cursorNativeStore } from '../../../helpers/runtime/cursor-native-store.js';
import { parseCursorTranscriptRecords, readCursorSessionMirrorRecordDeltaByFilePath } from '../../../../runtime/cursor/session-index.js';
import { applyToolCallEventToTools, toolCallEventFromMirrorRecord } from '../../../../shared/progress/tool-events.js';
import { buildToolProgressBlocks } from '../../../../shared/progress/tool-rendering.js';
import type { ToolCallInfo } from '../../../../domain/progress.js';
import { enqueueCursorRecord, type CursorTurnContext } from '../../../../runtime/cursor/tmux-provider.js';

const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] });
const assistant = (...content: unknown[]) => ({ role: 'assistant', content });
const call = (id: string, args = { glob_pattern: '*.py', target_directory: '/work' }) => ({ type: 'tool-call', toolName: 'Glob', toolCallId: id, args });
const result = (id: string, text: string, isError = false) => ({ role: 'tool', content: [{ type: 'tool-result', toolName: 'Glob', toolCallId: id, result: text, isError }] });
const wire = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
const transcriptUser = (text: string) => ({ role: 'user', message: { content: [{ type: 'text', text }] } });
const transcriptCalls = (count: number) => ({ role: 'assistant', message: { content: Array.from({ length: count }, () => ({ type: 'tool_use', name: 'Glob', input: { target_directory: '/work', glob_pattern: '*.py' } })) } });

describe('Cursor native CLI progress', () => {
  let root: string;
  let store: string;
  let db: DatabaseSync;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-native-'));
    store = path.join(root, 'store.db');
    db = new DatabaseSync(store);
    db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)');
  });
  afterEach(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const put = (data: Buffer): string => {
    const id = crypto.createHash('sha256').update(data).digest('hex');
    db.prepare('INSERT OR IGNORE INTO blobs VALUES (?, ?)').run(id, data);
    return id;
  };
  const checkpoint = (messages: unknown[]) => {
    const refs = messages.map((message) => Buffer.concat([Buffer.from([10, 32]), Buffer.from(put(Buffer.from(JSON.stringify(message))), 'hex')]));
    const rootId = put(Buffer.concat(refs));
    db.prepare("INSERT OR REPLACE INTO meta VALUES ('0', ?)").run(Buffer.from(JSON.stringify({ latestRootBlobId: rootId })).toString('hex'));
  };

  it('restores five current native Todos with original text/status while ignoring all message history', () => {
    const field = (no: number, data: Buffer) => Buffer.concat([Buffer.from([no * 8 + 2, data.length]), data]);
    const todos = Array.from({length:5},(_,status)=>({id:`todo-${status}`,content:`任务 ${status}\n  保留格式 “原文”`,status}));
    const todoRefs = todos.map(todo => field(3,Buffer.from(put(Buffer.concat([
      field(1,Buffer.from(todo.id)),field(2,Buffer.from(todo.content)),Buffer.from([24,todo.status]),
    ])),'hex')));
    // Broken message/turn refs must be irrelevant: Todo restore only follows field 3.
    const rootId=put(Buffer.concat([field(1,Buffer.alloc(32,0xab)),...todoRefs,field(8,Buffer.alloc(32,0xcd))]));
    db.prepare("INSERT INTO meta VALUES ('0', ?)").run(Buffer.from(JSON.stringify({latestRootBlobId:rootId})).toString('hex'));
    const before=fs.readFileSync(store),mtime=fs.statSync(store).mtimeMs;
    assert.deepEqual(readCursorNativeTodos(store),todos);
    assert.deepEqual(readCursorNativeTodos(store),todos);
    assert.deepEqual(fs.readFileSync(store),before);
    assert.equal(fs.statSync(store).mtimeMs,mtime);
    assert.equal(readCursorNativeMessages(store),null,'the invalid historical refs are intentionally unreadable');
  });

  it('does not invent or partially restore Todos from missing, malformed or newer state', () => {
    const textFields=Buffer.from([10,1,65,18,1,66]); // id=A, content=B
    const setTodos=(blobs:Buffer[])=>{
      const rootId=put(Buffer.concat(blobs.map(blob=>Buffer.concat([Buffer.from([26,32]),Buffer.from(put(blob),'hex')]))));
      db.prepare("INSERT OR REPLACE INTO meta VALUES ('0', ?)").run(JSON.stringify({latestRootBlobId:rootId}));
    };
    assert.equal(readCursorNativeTodos(path.join(root,'missing.db')),null);
    assert.equal(fs.existsSync(path.join(root,'missing.db')),false,'read-only open must not create a store');
    checkpoint([]);assert.equal(readCursorNativeTodos(store),null,'no field 3 does not fabricate an empty list');
    setTodos([textFields]);
    assert.deepEqual(readCursorNativeTodos(store),[{id:'A',content:'B',status:0}],'omitted enum is native unknown, not pending');
    for(const bad of [
      Buffer.concat([textFields,Buffer.from([24,9])]), // Unknown enum.
      Buffer.concat([textFields,Buffer.from([24,128])]), // Truncated varint.
      Buffer.concat([textFields,Buffer.from([26,1,49])]), // Status is a string, not an enum.
      Buffer.from([10,1,65,18,50,66]), // Truncated content.
      Buffer.from([10,1,65]), // Missing content.
    ]){
      setTodos([Buffer.from([10,1,67,18,1,68,24,1]),bad]);
      const before=fs.readFileSync(store);
      assert.equal(readCursorNativeTodos(store),null,'never return only the valid prefix of a corrupt list');
      assert.deepEqual(fs.readFileSync(store),before);
    }
    const missingId=Buffer.alloc(32,0xef).toString('hex');
    const rootId=put(Buffer.concat([Buffer.from([26,32]),Buffer.from(missingId,'hex')]));
    db.prepare("UPDATE meta SET value=? WHERE key='0'").run(JSON.stringify({latestRootBlobId:rootId}));
    assert.equal(readCursorNativeTodos(store),null);
  });

  it('resolves the same ACP store path for Todo restore and permission checks without accepting path traversal', () => {
    assert.equal(cursorAcpSessionStorePath('session_1',{CURSOR_CONFIG_DIR:'/cursor-config',XDG_CONFIG_HOME:'/other'}),'/cursor-config/acp-sessions/session_1/store.db');
    assert.equal(cursorAcpSessionStorePath('session-2',{XDG_CONFIG_HOME:'/xdg'}),'/xdg/cursor/acp-sessions/session-2/store.db');
    assert.equal(cursorAcpSessionStorePath('session3',{}),path.join(os.homedir(),'.cursor','acp-sessions','session3','store.db'));
    for(const id of ['', '../other','nested/session','a\\b']) assert.throws(()=>cursorAcpSessionStorePath(id,{}),/会话 ID 无效/);
  });

  it('observes tool activity while the transcript is frozen, without inventing text, tool results or completion', () => {
    const transcript = path.join(root, 'conversation.jsonl');
    const now = Date.now();
    fs.writeFileSync(transcript, wire([transcriptUser('inspect')]));
    fs.utimesSync(transcript, new Date(now - 60 * 60_000), new Date(now - 60 * 60_000));
    const spool = `${transcript}.tool-events`; fs.mkdirSync(spool);
    const event = (at: number, sessionId = 'conversation') => {
      fs.writeFileSync(path.join(spool, `${BigInt(at) * 1_000_000n}-42-preToolUse.json`), JSON.stringify({
        conversation_id: sessionId, session_id: sessionId, transcript_path: transcript,
        hook_event_name: 'preToolUse', tool_name: 'Write', tool_use_id: 'native-write',
      }));
    };
    event(now - 120_000);
    event(now - 60_000, 'another-conversation');
    const read = () => readCursorSessionMirrorRecordDeltaByFilePath(transcript, 0, fs.statSync(transcript).size, '', null, []);
    const records = read().records;
    const activity = records.find(r => r.activityAt)!;
    assert.ok(activity);
    assert.equal(activity.timestamp, new Date(now - 120_000).toISOString());
    assert.equal(activity.turnId, records.find(r => r.type === 'task_started')?.turnId);
    assert.match(activity.content, /Write 开始执行/);
    assert.equal(records.some(r => r.type === 'task_complete' || r.type === 'tool_finished'), false);

    const events: string[] = [];
    const context: CursorTurnContext = { sessionName: 'test', sessionId: 'conversation', nextOffset: 0,
      trailingText: '', nextTurnId: null, nextSpecialCallIds: [], emittedSignatures: new Set(), emittedToolStarts: new Set(), terminalSeen: false };
    const controller: ReadableStreamDefaultController<string> = { desiredSize: 1, enqueue(data) { events.push(data); }, close() {}, error() {} };
    enqueueCursorRecord(controller, context, activity);
    enqueueCursorRecord(controller, context, read().records.find(r => r.activityAt)!);
    assert.equal(events.map(s => JSON.parse(s.slice(6))).filter(e => e.type === 'status').length, 1, 're-reading the same event must not reset the activity clock');
    assert.ok(events.some(s => s.includes(activity.activityAt!)));
    assert.equal(context.terminalSeen, false);

    fs.appendFileSync(transcript, wire([
      { role: 'assistant', message: { content: [{ type: 'text', text: 'Verified native final answer.' }] } },
      { type: 'turn_ended', status: 'success' },
    ]));
    const completed = read().records;
    assert.equal(completed.some(r => r.activityAt), false, 'a late hook cannot reopen a completed native turn');
    for (const record of completed) enqueueCursorRecord(controller, context, record);
    const delivered = [...events];
    for (const record of read().records) enqueueCursorRecord(controller, context, record);
    assert.deepEqual(events, delivered, 'transcript catch-up must be delivered only once');
    assert.ok(events.some(s => s.includes('Verified native final answer.')));
    assert.equal(context.terminalSeen, true, 'only the native terminal completes the turn');
  });

  it('uses only the current ordered prompt references and ignores orphaned results', () => {
    put(Buffer.from(JSON.stringify(result('one', 'orphaned successful result'))));
    checkpoint([user('inspect'), assistant(call('one'))]);
    assert.equal(readCursorNativeMessages(store)?.length, 2);
    const records = parseCursorTranscriptRecords(wire([transcriptUser('inspect'), transcriptCalls(1)]), store);
    assert.equal(records.filter((r) => r.type === 'tool_started').length, 1);
    assert.equal(records.filter((r) => r.type === 'tool_finished').length, 0);
  });

  it('reads accepted turns before model context, including repeated and external text, ignoring orphaned turns', () => {
    const file = path.join(root, 'accepted.db');
    const fixture = cursorNativeStore(file);
    try {
      const text = '<codelark_source>\n来源群聊：回归\n</codelark_source>\n\n继续处理';
      fixture.checkpoint([user('older model context')], [], [text, { text, blob: true }, 'orphan']);
      assert.deepEqual(readCursorNativeUserPrompts(file), [text, text, 'orphan']);
      fixture.checkpoint([user('older model context')], [], [text, { text, blob: true }]);
      assert.deepEqual(readCursorNativeUserPrompts(file), [text, text]);
      assert.deepEqual(readCursorNativeMessages(file), [user('older model context')]);
      fixture.checkpoint([user('old format')]);
      assert.deepEqual(readCursorNativeUserPrompts(file), ['old format']);
    } finally { fixture.close(); }
  });

  it('reuses immutable message blobs when the native root advances', () => {
    const original = [user('inspect'), assistant(call('one'))];
    const originalIds = original.map((message) => put(Buffer.from(JSON.stringify(message))));
    checkpoint(original);
    assert.equal(readCursorNativeMessages(store)?.length, 2);

    checkpoint([...original, result('one', 'a.py')]);
    for (const id of originalIds) db.prepare('DELETE FROM blobs WHERE id = ?').run(id);

    assert.deepEqual(
      readCursorNativeMessages(store)?.map((message) => message.role),
      ['user', 'assistant', 'tool'],
    );
  });

  it('matches repeated calls, late store-only results and errors without replaying starts', () => {
    const messages = [user('inspect'), assistant(call('one'), call('two'))];
    const file = path.join(root, 'transcript.jsonl');
    fs.writeFileSync(file, wire([transcriptUser('inspect'), transcriptCalls(2)]));
    const size = fs.statSync(file).size;
    // Transcript can arrive before the native checkpoint, so starts retain
    // their stable transcript identity when the native ID becomes available.
    const initial = readCursorSessionMirrorRecordDeltaByFilePath(file, 0, size, '', null, [], store);
    const starts = initial.records.filter((r) => r.type === 'tool_started');
    assert.equal(starts.length, 2);
    checkpoint([...messages, result('two', 'permission denied', true), result('one', 'a.py')]);
    const late = readCursorSessionMirrorRecordDeltaByFilePath(file, size, size, initial.trailingText, initial.nextTurnId, initial.nextSpecialCallIds, store);
    assert.deepEqual(late.records.map((r) => [r.type, r.toolId, r.content, r.isError]), [
      ['tool_finished', starts[0]!.toolId, 'a.py', false],
      ['tool_finished', starts[1]!.toolId, 'permission denied', true],
    ]);
    const again = readCursorSessionMirrorRecordDeltaByFilePath(file, size, size, '', late.nextTurnId, late.nextSpecialCallIds, store);
    assert.deepEqual(again.records, []);
    const replay = parseCursorTranscriptRecords(fs.readFileSync(file, 'utf8'), store);
    assert.deepEqual(replay.filter((r) => r.type === 'tool_started').map((r) => r.toolId), starts.map((r) => r.toolId));
    assert.deepEqual(replay.filter((r) => r.type === 'tool_finished').map((r) => r.signature), late.records.map((r) => r.signature));
    const tools = new Map<string, ToolCallInfo>();
    for (const record of [...initial.records, ...late.records]) {
      const event = toolCallEventFromMirrorRecord(record);
      if (event) applyToolCallEventToTools(tools, event);
    }
    assert.deepEqual([...tools.values()].map((t) => t.status), ['complete', 'error']);
    const blocks = buildToolProgressBlocks([...tools.values()]);
    assert.match(blocks[0]!.header, /搜索.*\*\.py/);
    assert.match(blocks[0]!.detail, /\/work/);
    assert.doesNotMatch(blocks.map((b) => b.header + '\n' + b.detail).join('\n'), /glob_pattern|target_directory|🔄/);
  });

  it('separates native reasoning from answers and exposes only the final summary', () => {
    const summary = '**Inspecting training configuration**\n\nI am checking the training configuration for inconsistent defaults.';
    const noisy = 'Thinking Process:\n\n1. Draft an earlier summary.\n**Draft title**\n\nI am drafting.\n\n2. Generate output.' + summary;
    const ordinary = 'Thinking Process: is the name of a field in this format.';
    checkpoint([user('inspect'), assistant({ type: 'reasoning', text: noisy }), assistant({ type: 'text', text: ordinary })]);
    const records = parseCursorTranscriptRecords(wire([
      transcriptUser('inspect'),
      { role: 'assistant', message: { content: [{ type: 'text', text: noisy }] } },
      { role: 'assistant', message: { content: [{ type: 'text', text: ordinary }] } },
      { type: 'turn_ended', status: 'success' },
    ]), store);
    assert.deepEqual(records.filter((r) => r.reasoningKind === 'summary').map((r) => r.content), [summary]);
    assert.deepEqual(records.filter((r) => r.role === 'assistant').map((r) => r.content), [ordinary]);
    assert.equal(cursorVisibleThinkingSummary('Thinking Process:\nIncomplete draft'), '');
    assert.equal(cursorVisibleThinkingSummary('**Simple summary**'), '**Simple summary**');
  });

  it('keeps repeated user turns and identical inputs separate, with results before terminal', () => {
    checkpoint([user('inspect'), assistant(call('first')), result('first', 'first.py'), user('inspect'), assistant(call('second')), result('second', 'second.py')]);
    const records = parseCursorTranscriptRecords(wire([
      transcriptUser('inspect'), transcriptCalls(1), { type: 'turn_ended', status: 'success' },
      transcriptUser('inspect'), transcriptCalls(1), { type: 'turn_ended', status: 'success' },
    ]), store);
    assert.deepEqual(records.filter((r) => r.type === 'tool_finished').map((r) => r.content), ['first.py', 'second.py']);
    assert.equal(new Set(records.filter((r) => r.type === 'tool_finished').map((r) => r.toolId)).size, 2);
    assert.equal(records.at(-2)?.type, 'tool_finished');
    assert.equal(records.at(-1)?.type, 'task_complete');
  });
});
