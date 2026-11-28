import '../../../setup/test-setup.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { compactCursorSession } from '../../../../runtime/cursor/cli-compact.js';
import { readCursorCompactState } from '../../../../runtime/cursor/compact-store.js';

function fixture(t: any, behavior: 'summary' | 'timeout' | 'hang' | 'no-selector') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-compact-e2e-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = path.join(dir, 'config'), id = randomUUID(), source = path.join(config, 'acp-sessions', id, 'store.db');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  const db = new DatabaseSync(source);
  db.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);CREATE TABLE blobs(id TEXT PRIMARY KEY,data BLOB)');
  const goal = Buffer.from([10, 1, 120, 32, 1, 96, 19]);
  const bytes = Buffer.concat([Buffer.from([66, 2, 42, 43, 130, 2, goal.length]), goal]);
  const root = createHash('sha256').update(bytes).digest('hex');
  db.prepare('INSERT INTO blobs VALUES (?,?)').run(root, bytes); db.prepare('INSERT INTO meta VALUES (?,?)').run('0', JSON.stringify({ latestRootBlobId: root, isRunEverything: false, name: 'original' })); db.close();
  const binary = path.join(dir, 'cursor-test');
  fs.writeFileSync(binary, `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{DatabaseSync}=require('node:sqlite');
const id=process.argv[process.argv.indexOf('--resume')+1];
const file=path.join(process.env.CURSOR_CONFIG_DIR,'chats',crypto.createHash('md5').update(process.cwd()).digest('hex'),id,'store.db');
fs.writeFileSync(path.join(process.cwd(),'child-pid'),String(process.pid));
process.stdout.write('Gemini · 7.1%\\n→ Add a follow-up\\n');
process.stdin.setRawMode(true);process.stdin.setEncoding('utf8');process.stdin.on('data',s=>{
 if(s.includes('/summarize')){fs.writeFileSync(path.join(process.cwd(),'received'),s);if(${JSON.stringify(behavior)}!=='no-selector')process.stdout.write('→ /summarize  Summarize the conversation to reduce context\\n');return;}
 if(!s.includes('\\r'))return;
 fs.writeFileSync(path.join(process.cwd(),'entered'),'1');
 if(${JSON.stringify(behavior)}!=='summary')return;
 const db=new DatabaseSync(file);const meta=JSON.parse(db.prepare("SELECT value FROM meta WHERE key='0'").get().value);
 const bytes=Buffer.from(db.prepare('SELECT data FROM blobs WHERE id=?').get(meta.latestRootBlobId).data);
 if(!bytes.includes(Buffer.from([32,2])))throw Error('active goal was not paused before CLI started');
 const summary=Buffer.from('native summary');const ref=crypto.createHash('sha256').update(summary).digest();
 const next=Buffer.concat([bytes,Buffer.from([50,32]),ref]);const hash=crypto.createHash('sha256').update(next).digest('hex');
 db.prepare('INSERT INTO blobs VALUES (?,?)').run(ref.toString('hex'),summary);db.prepare('INSERT INTO blobs VALUES (?,?)').run(hash,next);
 meta.latestRootBlobId=hash;meta.isRunEverything=true;db.prepare("UPDATE meta SET value=? WHERE key='0'").run(JSON.stringify(meta));db.close();
});
setInterval(()=>{},1000);
`, { mode: 0o700 });
  return { dir, source, root, options: { executable: binary, cwd: dir, sessionId: id, env: { ...process.env, CURSOR_CONFIG_DIR: config }, signal: new AbortController().signal, timeoutMs: 2000 } };
}
it('real PTY compactor submits once, pauses only the copy, waits for child exit and commits a verified native summary', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t, 'summary'), before = readCursorCompactState(f.source);
  await compactCursorSession(f.options);
  const after = readCursorCompactState(f.source); assert.ok(after.summary); assert.deepEqual(after.goal, before.goal); assert.deepEqual(after.turns, before.turns);
  assert.equal(fs.readFileSync(path.join(f.dir, 'received'), 'utf8').trim(), '/summarize');
  const pid = Number(fs.readFileSync(path.join(f.dir, 'child-pid'), 'utf8')); assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  const db = new DatabaseSync(f.source, { readOnly: true }); assert.equal(JSON.parse((db.prepare("SELECT value FROM meta WHERE key='0'").get() as any).value).isRunEverything, false); db.close();
});
it('compacts from a symlinked workspace using the same directory identity as the native CLI', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t, 'summary');
  const aliasRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-compact-alias-'));
  t.after(() => fs.rmSync(aliasRoot, { recursive: true, force: true }));
  const cwd = path.join(aliasRoot, 'workspace');
  fs.symlinkSync(f.dir, cwd, 'dir');
  await compactCursorSession({ ...f.options, cwd });
  assert.ok(readCursorCompactState(f.source).summary);
  assert.equal(fs.readFileSync(path.join(f.dir, 'received'), 'utf8').trim(), '/summarize');
});
it('CLI timeout never copies partial state or retries the slash input', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t, 'timeout');
  await assert.rejects(compactCursorSession(f.options), /未完成/); assert.equal(readCursorCompactState(f.source).root, f.root);
  assert.equal(fs.readFileSync(path.join(f.dir, 'received'), 'utf8').trim(), '/summarize');
});
it('stop kills only the owned compaction child and leaves the original root unchanged', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t, 'hang'), abort = new AbortController();
  const pending = compactCursorSession({ ...f.options, signal: abort.signal });
  const rejected = assert.rejects(pending, /取消/);
  for (let i = 0; i < 100 && !fs.existsSync(path.join(f.dir, 'child-pid')); i++) await new Promise(r => setTimeout(r, 10));
  abort.abort(); await rejected; assert.equal(readCursorCompactState(f.source).root, f.root);
});

it('never presses Enter when the CLI has not identified the native summarize action', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t, 'no-selector');
  await assert.rejects(compactCursorSession(f.options), /未完成/);
  assert.equal(fs.existsSync(path.join(f.dir, 'entered')), false);
  assert.equal(readCursorCompactState(f.source).root, f.root);
});
