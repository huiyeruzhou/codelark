import '../../../setup/test-setup.js';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createCodexForkSnapshot, readCodexForkPrefix, remapCodexForkSignatures } from '../../../../runtime/codex/fork-thread.js';

it('gives a paginated snapshot its own storage identity without rewriting conversation records', () => {
  const meta = { type: 'session_meta', timestamp: '2026-10-27', ordinal: 0,
    payload: { id: 'source', session_id: 'source', history_mode: 'paginated', cwd: '/repo', base_instructions: { text: 'retain instructions' } } };
  const tail = '\n' + JSON.stringify({ type: 'compacted', payload: { replacement_history: [{ type: 'message', role: 'user', content: 'source' }] } })
    + '\n' + JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'source', output: 'keep source unchanged' } }) + '\n';
  const prefix = JSON.stringify(meta) + tail;
  const first = createCodexForkSnapshot(prefix, 'source');
  const second = createCodexForkSnapshot(prefix, 'source');
  assert.notEqual(first.threadId, 'source');
  assert.notEqual(first.threadId, second.threadId);
  assert.match(first.threadId, /^[a-f0-9-]{36}$/);
  const actualMeta = JSON.parse(first.content.split('\n')[0]!);
  const { history_mode: _, ...payload } = meta.payload;
  assert.deepEqual(actualMeta, { ...meta, payload: { ...payload, id: first.threadId, session_id: first.threadId } });
  assert.equal(first.content.slice(first.content.indexOf('\n')), tail);
  assert.equal(prefix, JSON.stringify(meta) + tail);
  assert.throws(() => createCodexForkSnapshot(prefix, 'other'), /session_meta/);
});

it('also isolates legacy rollouts without adding paginated fields', () => {
  const prefix = JSON.stringify({ type: 'session_meta', payload: { id: 'legacy' } }) + '\n';
  const snapshot = createCodexForkSnapshot(prefix, 'legacy');
  assert.deepEqual(JSON.parse(snapshot.content).payload, { id: snapshot.threadId });
});

it('remaps inherited card boundaries after native timestamps change and rejects ambiguous or missing records', () => {
  const directory = path.join(process.env.CODEX_HOME!, 'sessions', '2026', '10', '27');
  fs.mkdirSync(directory, { recursive: true });
  const sourceId = crypto.randomUUID(), forkId = crypto.randomUUID();
  const sourceFile = path.join(directory, `rollout-2026-10-27T18-00-00-${sourceId}.jsonl`);
  const forkFile = path.join(directory, `rollout-2026-10-27T19-00-00-${forkId}.jsonl`);
  const meta = (id: string) => JSON.stringify({ type: 'session_meta', payload: { id, cwd: '/test', timestamp: '2026-10-27T18:00:00Z' } });
  const record = { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-A', last_agent_message: 'A' } };
  const source = JSON.stringify({ timestamp: '2026-10-27T18:00:00Z', ordinal: 7, ...record });
  const fork = JSON.stringify({ timestamp: '2026-10-27T19:00:00Z', ...record });
  const hash = (line: string) => crypto.createHash('sha1').update(line).digest('hex');
  fs.writeFileSync(sourceFile, meta(sourceId) + '\n' + source + '\n{"partial":');
  fs.writeFileSync(forkFile, meta(forkId) + '\n' + fork + '\n');
  const mapped = remapCodexForkSignatures(sourceId, forkId, [hash(source)]);
  assert.equal(mapped.get(hash(source)), hash(fork));
  assert.ok(readCodexForkPrefix(forkFile, forkId, mapped.get(hash(source))!).includes('turn-A'));
  assert.throws(() => remapCodexForkSignatures(sourceId, forkId, ['missing']), /缺少卡片边界/);
  fs.appendFileSync(forkFile, fork + '\n');
  assert.throws(() => remapCodexForkSignatures(sourceId, forkId, [hash(source)]), /无法唯一对应/);
});

it('resolves app-server protocol signatures by the native item id', () => {
  const rows = [
    { type: 'session_meta', payload: { id: 'app-thread' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'A' }] } },
    { type: 'event_msg', payload: { type: 'item_completed', thread_id: 'app-thread', turn_id: 'turn-1', item: { id: 'item-42', type: 'agentMessage', text: 'answer A' }, completed_at_ms: 1 } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'B' }] } },
  ].map((row) => JSON.stringify(row));
  const file = path.join(process.env.CODELARK_HOME!, 'fork-app-server.jsonl');
  fs.writeFileSync(file, rows.join('\n') + '\n');
  const signature = `app:app-thread:turn-1:item-42:true:${'a'.repeat(20)}`;
  assert.equal(readCodexForkPrefix(file, 'app-thread', signature), rows.slice(0, 3).join('\n') + '\n');
  // The completed marker suffix is optional and must not break resolution.
  const bareSignature = `app:app-thread:turn-1:item-42:${'b'.repeat(20)}`;
  assert.equal(readCodexForkPrefix(file, 'app-thread', bareSignature), rows.slice(0, 3).join('\n') + '\n');
  // A missing native item must fail loudly, never fall back to a partial read.
  assert.throws(
    () => readCodexForkPrefix(file, 'app-thread', `app:app-thread:turn-1:missing:${'c'.repeat(20)}`),
    /找不到.*边界/,
  );
});

it('fork prefix retains native compaction and tools but excludes later user input, including in the same turn', () => {
  const rows = [
    { type: 'session_meta', payload: { id: 'source-thread' } },
    { type: 'compacted', payload: { message: 'earlier context', replacement_history: [] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'A' }] } },
    { type: 'response_item', payload: { type: 'function_call', call_id: 'tool', name: 'read_file', arguments: '{}' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'tool', output: 'file contents' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer A' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'B' }] } },
  ].map((row) => JSON.stringify(row));
  const file = path.join(process.env.CODELARK_HOME!, 'fork-source.jsonl');
  const input = rows.join('\n') + '\n{"partial":';
  fs.writeFileSync(file, input);
  const signature = crypto.createHash('sha1').update(rows[5]!).digest('hex');
  assert.equal(readCodexForkPrefix(file, 'source-thread', signature), rows.slice(0, 6).join('\n') + '\n');
  assert.equal(fs.readFileSync(file, 'utf8'), input);
  assert.throws(() => readCodexForkPrefix(file, 'different-thread', signature), /不一致/);
  assert.throws(() => readCodexForkPrefix(file, 'source-thread', 'a'.repeat(40)), /找不到.*边界/);
  fs.writeFileSync(file, rows[0] + '\n{broken}\n' + rows[5] + '\n');
  assert.throws(() => readCodexForkPrefix(file, 'source-thread', signature), SyntaxError);
});
