import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, it } from 'node:test';

import {
  findLatestZcodeTurnId,
  createZcodeMirrorSqliteSource,
  findZcodeSessionById,
  listZcodeSessionSummaries,
  readZcodeSessionMessages,
  readZcodeSessionMirrorRecords,
  resolveZcodeSessionDbPath,
} from '../../../../runtime/zcode/session-index.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codelark-zcode-index-'));
  temporaryDirectories.push(directory);
  return directory;
}

function createFixtureDatabase(root: string): string {
  const dbPath = path.join(root, 'data', 'db.sqlite');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE session (
      id text primary key,
      directory text not null,
      path text,
      title text not null,
      time_created integer not null,
      time_updated integer not null,
      time_archived integer
    );
    CREATE TABLE message (
      id text primary key,
      session_id text not null,
      time_created integer not null,
      time_updated integer not null,
      data text not null,
      sequence integer
    );
    CREATE TABLE part (
      id text primary key,
      message_id text not null,
      session_id text not null,
      time_created integer not null,
      time_updated integer not null,
      data text not null,
      sequence integer
    );
    CREATE TABLE turn_usage (
      session_id text not null,
      turn_id text not null,
      status text not null,
      started_at integer not null,
      completed_at integer,
      input_tokens integer not null default 0,
      output_tokens integer not null default 0,
      reasoning_tokens integer not null default 0,
      cache_creation_input_tokens integer not null default 0,
      cache_read_input_tokens integer not null default 0,
      computed_total_tokens integer not null default 0,
      error_type text,
      error_code text
    );
    CREATE TABLE model_usage (
      session_id text not null,
      turn_id text,
      error_message text,
      started_at integer not null,
      attempt_index integer not null default 0
    );
  `);
  const session = db.prepare(`
    INSERT INTO session (id, directory, path, title, time_created, time_updated, time_archived)
    VALUES (?, ?, ?, ?, ?, ?, NULL)
  `);
  session.run('sess_success', root, root, 'Successful turn', 1000, 2200);
  session.run('sess_error', root, root, 'Failed turn', 3000, 3300);

  const message = db.prepare(`
    INSERT INTO message (id, session_id, time_created, time_updated, data, sequence)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  message.run('msg_user', 'sess_success', 1100, 1100, JSON.stringify({
    role: 'user',
    anchor: { turnId: 'turn_success' },
  }), 0);
  message.run('msg_assistant', 'sess_success', 1200, 2100, JSON.stringify({
    role: 'assistant',
    anchor: { turnId: 'turn_success' },
  }), 1);
  message.run('msg_error', 'sess_error', 3100, 3200, JSON.stringify({
    role: 'assistant',
    error: { data: { message: 'Model provider is missing an API key: zai' } },
    anchor: { turnId: 'turn_error' },
  }), 0);

  const part = db.prepare(`
    INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, sequence)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  part.run('part_text', 'msg_assistant', 'sess_success', 1300, 1400, JSON.stringify({
    type: 'text',
    text: 'hello from zcode',
  }), 0);
  part.run('part_tool_running', 'msg_assistant', 'sess_success', 1500, 1500, JSON.stringify({
    type: 'tool',
    callID: 'tool_1',
    tool: 'Bash',
    state: { status: 'running', input: { command: 'pwd' } },
  }), 1);
  part.run('part_tool_done', 'msg_assistant', 'sess_success', 1600, 1700, JSON.stringify({
    type: 'tool',
    callID: 'tool_2',
    tool: 'Read',
    state: { status: 'completed', output: 'README' },
  }), 2);

  db.prepare(`
    INSERT INTO turn_usage (
      session_id, turn_id, status, started_at, completed_at,
      input_tokens, output_tokens, reasoning_tokens,
      cache_creation_input_tokens, cache_read_input_tokens, computed_total_tokens,
      error_type, error_code
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('sess_success', 'turn_success', 'completed', 1000, 2200, 10, 5, 2, 0, 3, 20, null, null);
  db.prepare(`
    INSERT INTO turn_usage (
      session_id, turn_id, status, started_at, completed_at,
      input_tokens, output_tokens, reasoning_tokens,
      cache_creation_input_tokens, cache_read_input_tokens, computed_total_tokens,
      error_type, error_code
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('sess_error', 'turn_error', 'error', 3000, 3300, 0, 0, 0, 0, 0, 0, 'AiSdkModelAdapterError', 'provider_not_configured');
  db.prepare(`
    INSERT INTO model_usage (session_id, turn_id, error_message, started_at, attempt_index)
    VALUES (?, ?, ?, ?, ?)
  `).run('sess_error', 'turn_error', 'Model provider is missing an API key: zai', 3200, 0);
  db.close();
  return dbPath;
}

describe('ZCode SQLite session index', () => {
  it('resolves the runtime-supported session DB environment without changing HOME', () => {
    const root = temporaryDirectory();
    assert.equal(
      resolveZcodeSessionDbPath({ ZCODE_SESSION_DB_PATH: path.join(root, 'sessions.sqlite') }),
      path.join(root, 'sessions.sqlite'),
    );
  });

  it('lists and finds persisted sessions by stable sess id and canonical cwd', () => {
    const root = temporaryDirectory();
    const dbPath = createFixtureDatabase(root);
    const listed = listZcodeSessionSummaries(root, { dbPath });

    assert.deepEqual(listed.map((session) => session.sessionId), ['sess_error', 'sess_success']);
    assert.equal(listed[0]?.dbPath, dbPath);
    assert.equal(findZcodeSessionById('sess_success', root, { dbPath })?.title, 'Successful turn');
    assert.equal(findZcodeSessionById('missing', root, { dbPath }), null);
  });

  it('maps text, tools, usage, success and provider errors into bridge records', () => {
    const root = temporaryDirectory();
    const dbPath = createFixtureDatabase(root);
    const success = readZcodeSessionMirrorRecords(dbPath, 'sess_success');

    assert.deepEqual(success.map((record) => record.type), [
      'message',
      'tool_started',
      'tool_finished',
      'task_complete',
    ]);
    assert.equal(success[0]?.content, 'hello from zcode');
    assert.deepEqual(success[1]?.toolInput, { command: 'pwd' });
    assert.equal(success[2]?.content, 'README');
    assert.equal(success[3]?.contextUsage?.lastTokenUsage?.totalTokens, 20);
    assert.equal(findLatestZcodeTurnId(dbPath, 'sess_success', 999), 'turn_success');
    assert.deepEqual(readZcodeSessionMessages(dbPath, 'sess_success', 10), [
      { role: 'assistant', content: 'hello from zcode' },
    ]);

    const failed = readZcodeSessionMirrorRecords(dbPath, 'sess_error');
    assert.equal(failed.at(-1)?.type, 'task_aborted');
    assert.equal(failed.at(-1)?.content, 'Model provider is missing an API key: zai');
    assert.equal(failed.at(-1)?.isError, true);
  });

  it('exposes only the requested session as a replaceable mirror snapshot', () => {
    const root = temporaryDirectory();
    const dbPath = createFixtureDatabase(root);
    const previous = process.env.CODELARK_ZCODE_SESSION_DB_PATH;
    process.env.CODELARK_ZCODE_SESSION_DB_PATH = dbPath;
    try {
      const source = createZcodeMirrorSqliteSource();
      assert.equal(source.readMode, 'snapshot');
      assert.equal(source.findByThreadId('sess_success', root)?.filePath, dbPath);
      const delta = source.readDelta(dbPath, 0, fs.statSync(dbPath).size, '', null, [], 'sess_success');
      assert.equal(delta.records.some((record) => record.content.includes('missing an API key')), false);
      assert.equal(delta.records.some((record) => record.content === 'hello from zcode'), true);
      assert.equal(delta.nextTurnId, 'turn_success');
    } finally {
      if (previous === undefined) delete process.env.CODELARK_ZCODE_SESSION_DB_PATH;
      else process.env.CODELARK_ZCODE_SESSION_DB_PATH = previous;
    }
  });

  it('observes SQLite WAL changes without replacing the canonical database read path', () => {
    const root = temporaryDirectory();
    const dbPath = createFixtureDatabase(root);
    const source = createZcodeMirrorSqliteSource();
    const before = source.statSnapshot?.(dbPath);
    assert.ok(before);

    fs.writeFileSync(`${dbPath}-wal`, 'first-wal-write');
    const withWal = source.statSnapshot?.(dbPath);
    assert.ok(withWal);
    assert.notEqual(withWal.identity, before.identity);
    assert.ok(withWal.size > before.size);
    assert.equal(source.watchPath?.(dbPath), path.dirname(dbPath));

    fs.appendFileSync(`${dbPath}-wal`, '-next-turn');
    const afterAppend = source.statSnapshot?.(dbPath);
    assert.ok(afterAppend);
    assert.ok(afterAppend.size > withWal.size);
  });
});
