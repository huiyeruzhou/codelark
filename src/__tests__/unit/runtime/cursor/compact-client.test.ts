import '../../../setup/test-setup.js';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { withCursorCompaction } from '../../../../runtime/cursor/compact-client.js';
import { readCursorCompactState, setCompactCopyGoal } from '../../../../runtime/cursor/compact-store.js';
import type { AcpConnection } from '../../../../runtime/acp/client.js';

function connection(trace: string[], label: string): AcpConnection {
  let live = true;
  return { get connected() { return live; }, async request<T>(method: string, params: any): Promise<T> {
    trace.push(`${label}:${method}:${params.sessionId || params.configId || ''}`);
    return (method === 'session/new' ? { sessionId: 'native-id' } : {}) as T;
  }, notify(m) { trace.push(`${label}:${m}`); }, respond() {}, reject() {}, onMessage() { return () => {}; }, onDisconnect() { return () => {}; },
  async close() { trace.push(`${label}:close`); live = false; } };
}
async function setup(compact: any) {
  const trace: string[] = [];
  const c = withCursorCompaction(connection(trace, 'old'), async () => { trace.push('restart'); return connection(trace, 'new'); },
    { executable: 'cursor', cwd: '/test' }, async options => { trace.push('compact'); return compact(options); });
  await c.request('initialize', { protocolVersion: 1 });
  await c.request('authenticate', { methodId: 'cursor_login' });
  await c.request('session/new', { cwd: '/test', mcpServers: [] });
  await c.request('session/set_config_option', { sessionId: 'native-id', configId: 'model', value: 'neon' });
  await c.request('session/set_mode', { sessionId: 'native-id', modeId: 'agent' });
  trace.length = 0;
  return { c, trace };
}
const prompt = { sessionId: 'native-id', prompt: [{ type: 'text', text: '/compact' }] };
it('compact exclusively transfers ownership, restores settings, and accepts the next prompt on the same native session', async () => {
  const { c, trace } = await setup(async (o: any) => { assert.equal(o.sessionId, 'native-id'); assert.equal(o.model, 'neon'); return { before: 8, after: 3 }; });
  const updates: any[] = []; c.onMessage(m => updates.push(m));
  assert.equal((await c.request<any>('session/prompt', prompt)).stopReason, 'end_turn');
  assert.deepEqual(trace, ['old:close', 'compact', 'restart', 'new:initialize:', 'new:authenticate:', 'new:session/load:native-id', 'new:session/set_config_option:native-id', 'new:session/set_mode:native-id']);
  await c.request('session/prompt', { ...prompt, prompt: [{ type: 'text', text: '接着做' }] });
  assert.equal(trace.at(-1), 'new:session/prompt:native-id');
  assert.match(JSON.stringify(updates), /8 → 3/); await c.close();
});
it('compact failure restores ACP and reports failure without submitting compact as model text', async () => {
  const { c, trace } = await setup(async () => { throw new Error('summary failed'); });
  await assert.rejects(c.request('session/prompt', prompt), /summary failed/);
  assert.ok(c.connected); assert.ok(trace.includes('new:session/load:native-id'));
  assert.ok(!trace.some(t => t.includes('session/prompt'))); await c.close();
});
it('stop cancels the compactor and waits for restored ownership before another input', async () => {
  let entered!: () => void; const ready = new Promise<void>(r => entered = r);
  const { c, trace } = await setup(async (o: any) => { entered(); await new Promise<void>((_, reject) => o.signal.addEventListener('abort', () => reject(new Error('cancelled')))); });
  const pending = c.request<any>('session/prompt', prompt); await ready;
  await assert.rejects(c.request('session/prompt', prompt), /不能重叠/);
  c.notify('session/cancel', { sessionId: 'native-id' });
  assert.equal((await pending).stopReason, 'cancelled'); assert.ok(trace.includes('new:session/load:native-id')); await c.close();
});
it('closing during compaction never creates a replacement ACP process', async () => {
  let entered!: () => void; const ready = new Promise<void>(r => entered = r);
  const { c, trace } = await setup(async (o: any) => { entered(); await new Promise<void>((_, reject) => o.signal.addEventListener('abort', () => reject(new Error('cancelled')))); });
  const pending = c.request('session/prompt', prompt); await ready; await c.close(); await pending;
  assert.ok(!trace.includes('restart')); assert.equal(c.connected, false);
});
it('only the private snapshot goal is paused, and restoration preserves unknown state and history byte for byte', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-compact-store-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'store.db'); const goal = Buffer.from([10, 1, 120, 32, 1, 96, 19]);
  const bytes = Buffer.concat([Buffer.from([66, 2, 42, 43, 130, 2, goal.length]), goal, Buffer.from([136, 2, 77])]);
  const hash = createHash('sha256').update(bytes).digest('hex');
  const db = new DatabaseSync(file); db.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);CREATE TABLE blobs(id TEXT PRIMARY KEY,data BLOB)');
  db.prepare('INSERT INTO meta VALUES (?,?)').run('0', JSON.stringify({ latestRootBlobId: hash })); db.prepare('INSERT INTO blobs VALUES (?,?)').run(hash, bytes); db.close();
  const before = readCursorCompactState(file); setCompactCopyGoal(file, goal, true);
  const paused = readCursorCompactState(file); assert.equal(paused.goal?.[4], 2); assert.deepEqual(paused.turns, before.turns);
  setCompactCopyGoal(file, before.goal); assert.deepEqual(readCursorCompactState(file), before);
});

it('compaction commit retains metadata and old blobs, rejects changed originals and pre-commit cancellation', async t => {
  const { commitCursorCompaction } = await import('../../../../runtime/cursor/compact-store.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-compact-commit-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const create = (name: string, bytes: Buffer, force: boolean) => {
    const file = path.join(dir, name), db = new DatabaseSync(file), hash = createHash('sha256').update(bytes).digest('hex');
    db.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);CREATE TABLE blobs(id TEXT PRIMARY KEY,data BLOB)');
    db.prepare('INSERT INTO meta VALUES (?,?)').run('0', JSON.stringify({ latestRootBlobId: hash, isRunEverything: force, name }));
    db.prepare('INSERT INTO blobs VALUES (?,?)').run(hash, bytes); db.close(); return { file, hash };
  };
  const source = create('original', Buffer.from([8, 1]), false), copy = create('copy', Buffer.from([8, 2]), true);
  const signal = new AbortController().signal;
  assert.throws(() => commitCursorCompaction(source.file, copy.file, 'stale-root', signal), /已变化/);
  const cancel = new AbortController(); cancel.abort();
  assert.throws(() => commitCursorCompaction(source.file, copy.file, source.hash, cancel.signal));
  assert.equal(readCursorCompactState(source.file).root, source.hash);
  commitCursorCompaction(source.file, copy.file, source.hash, signal);
  const db = new DatabaseSync(source.file, { readOnly: true });
  const meta = JSON.parse((db.prepare("SELECT value FROM meta WHERE key='0'").get() as any).value);
  assert.equal(meta.name, 'original'); assert.equal(meta.isRunEverything, false); assert.equal(meta.latestRootBlobId, copy.hash);
  assert.ok(db.prepare('SELECT 1 FROM blobs WHERE id=?').get(source.hash)); db.close();
});

it('uses the model selected by CLI arguments when ACP did not send a model config RPC', async () => {
  const trace: string[] = [];
  const c = withCursorCompaction(connection(trace, 'old'), async () => connection(trace, 'new'),
    { executable: 'cursor', cwd: '/test', model: 'neon-high' }, async o => { assert.equal(o.model, 'neon-high'); return { before: 8, after: 3 }; });
  await c.request('initialize', {}); await c.request('session/new', { cwd: '/test' });
  await c.request('session/prompt', prompt); await c.close();
});

it('close interrupts an in-flight ACP reload instead of waiting on its own load RPC', async () => {
  const trace: string[] = []; let loaded!: () => void, rejectLoad!: (e: Error) => void;
  const loading = new Promise<void>(r => loaded = r);
  const replacement = connection(trace, 'new'), originalRequest = replacement.request.bind(replacement), originalClose = replacement.close.bind(replacement);
  replacement.request = async <T>(method: string, params: any): Promise<T> => {
    if (method !== 'session/load') return originalRequest<T>(method, params);
    loaded(); return new Promise<T>((_, reject) => { rejectLoad = reject; });
  };
  replacement.close = async () => { rejectLoad?.(new Error('reload closed')); await originalClose(); };
  const c = withCursorCompaction(connection(trace, 'old'), async () => replacement, { executable: 'cursor', cwd: '/test' }, async () => ({ before: 8, after: 3 }));
  await c.request('initialize', {}); await c.request('session/new', { cwd: '/test' });
  const request = c.request('session/prompt', prompt); const failure = assert.rejects(request, /reload closed/);
  await loading; await c.close(); await failure; assert.equal(c.connected, false);
});
