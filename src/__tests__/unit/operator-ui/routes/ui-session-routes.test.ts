import '../../../setup/test-setup.js';
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { handleUiSessionRoute } from '../../../../operator-ui/routes/session.js';
import { computeKimiWorkspaceDirName, isArchivedKimiSession } from '../../../../runtime/kimi/session-index.js';
import {
  cursorWorkspaceHash,
  encodeCursorConversationId,
  getCursorTranscriptCandidates,
  isArchivedCursorSession,
} from '../../../../runtime/cursor/session-index.js';
import { JsonFileStore } from '../../../../storage/json-store.js';
import { makeBridgeSettings, resetBridgeTestState } from '../../../helpers/bridge/test-bridge-utils.js';

function createResponse(): ServerResponse & { body: string; statusCodeWritten?: number } {
  return {
    body: '',
    writeHead(statusCode: number) {
      this.statusCodeWritten = statusCode;
      return this;
    },
    end(chunk?: unknown) {
      if (typeof chunk === 'string') this.body += chunk;
      else if (chunk instanceof Uint8Array) this.body += Buffer.from(chunk).toString('utf-8');
      return this;
    },
  } as ServerResponse & { body: string; statusCodeWritten?: number };
}

function createJsonRequest(body: unknown): IncomingMessage {
  return Object.assign(Readable.from([JSON.stringify(body)]), {
    method: 'POST',
  }) as IncomingMessage;
}

function createGetRequest(): IncomingMessage {
  return { method: 'GET' } as IncomingMessage;
}

function writeKimiWireFixture(params: {
  homeDir: string;
  cwd: string;
  sessionId: string;
}): void {
  const sessionDir = path.join(
    params.homeDir,
    'sessions',
    computeKimiWorkspaceDirName(params.cwd),
    params.sessionId,
  );
  const wireDir = path.join(sessionDir, 'agents', 'main');
  fs.mkdirSync(wireDir, { recursive: true });
  fs.writeFileSync(path.join(wireDir, 'wire.jsonl'), [
    JSON.stringify({
      type: 'context.append_message',
      time: Date.parse('2026-06-27T00:00:00.000Z'),
      message: { role: 'user', content: 'hello kimi ui route' },
    }),
    JSON.stringify({
      type: 'context.append_loop_event',
      time: Date.parse('2026-06-27T00:00:01.000Z'),
      event: { type: 'content.part', part: { type: 'think', think: 'private route thinking' } },
    }),
    JSON.stringify({
      type: 'context.append_loop_event',
      time: Date.parse('2026-06-27T00:00:02.000Z'),
      event: { type: 'content.part', part: { type: 'text', text: 'route kimi **reply**' } },
    }),
  ].join('\n') + '\n', 'utf-8');
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
    createdAt: '2026-06-27T00:00:00.000Z',
    updatedAt: '2026-06-27T00:00:02.000Z',
    title: 'Kimi UI route session',
  }), 'utf-8');
  fs.writeFileSync(path.join(params.homeDir, 'session_index.jsonl'), `${JSON.stringify({
    sessionId: params.sessionId,
    sessionDir,
    workDir: params.cwd,
  })}\n`, 'utf-8');
}

function writeCursorTranscriptFixture(params: { configDir: string; cwd: string; sessionId: string }): void {
  fs.mkdirSync(params.cwd, { recursive: true });
  const sessionDir = path.join(params.configDir, 'chats', cursorWorkspaceHash(params.cwd), params.sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'meta.json'), JSON.stringify({
    schemaVersion: 1,
    title: 'Cursor UI route session',
    createdAtMs: Date.parse('2026-07-25T00:00:00.000Z'),
    updatedAtMs: Date.parse('2026-07-25T00:00:02.000Z'),
    hasConversation: true,
    isSubagent: false,
    cwd: params.cwd,
  }), 'utf-8');
  const transcript = getCursorTranscriptCandidates(params.sessionId, params.cwd)[0];
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, [
    JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: 'hello cursor ui route' }] } }),
    JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: 'cursor route reply' }] } }),
    JSON.stringify({ type: 'turn_ended', status: 'success' }),
  ].join('\n') + '\n', 'utf-8');
  assert.equal(path.basename(transcript), `${encodeCursorConversationId(params.sessionId)}.jsonl`);
}

function writeZcodeDatabaseFixture(params: { dbPath: string; cwd: string; sessionId: string }): void {
  fs.mkdirSync(params.cwd, { recursive: true });
  fs.mkdirSync(path.dirname(params.dbPath), { recursive: true });
  const db = new DatabaseSync(params.dbPath);
  db.exec(`
    CREATE TABLE session (id text primary key, directory text not null, path text, title text not null, time_created integer not null, time_updated integer not null, time_archived integer);
    CREATE TABLE message (id text primary key, session_id text not null, time_created integer not null, time_updated integer not null, data text not null, sequence integer);
    CREATE TABLE part (id text primary key, message_id text not null, session_id text not null, time_created integer not null, time_updated integer not null, data text not null, sequence integer);
    CREATE TABLE turn_usage (session_id text not null, turn_id text not null, status text not null, started_at integer not null, completed_at integer, input_tokens integer not null default 0, output_tokens integer not null default 0, reasoning_tokens integer not null default 0, cache_creation_input_tokens integer not null default 0, cache_read_input_tokens integer not null default 0, computed_total_tokens integer not null default 0, error_type text, error_code text);
    CREATE TABLE model_usage (session_id text not null, turn_id text, error_message text, started_at integer not null, attempt_index integer not null default 0);
  `);
  db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, NULL)').run(params.sessionId, params.cwd, params.cwd, 'ZCode UI route session', 1000, 3000);
  db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?, ?)').run('msg_zcode_user', params.sessionId, 1100, 1100, JSON.stringify({ role: 'user', anchor: { turnId: 'turn_zcode' } }), 0);
  db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?, ?)').run('msg_zcode_assistant', params.sessionId, 1200, 2200, JSON.stringify({ role: 'assistant', anchor: { turnId: 'turn_zcode' } }), 1);
  db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?, ?)').run('part_zcode_user', 'msg_zcode_user', params.sessionId, 1100, 1100, JSON.stringify({ type: 'text', text: 'hello zcode ui route' }), 0);
  db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?, ?)').run('part_zcode_assistant', 'msg_zcode_assistant', params.sessionId, 1300, 2100, JSON.stringify({ type: 'text', text: 'zcode route reply' }), 0);
  db.prepare('INSERT INTO turn_usage VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)').run(params.sessionId, 'turn_zcode', 'completed', 1000, 3000, 10, 5, 0, 0, 0, 15);
  db.close();
}

async function dispatch(
  store: JsonFileStore,
  request: IncomingMessage,
  url: string,
): Promise<{ statusCode: number | undefined; body: any }> {
  const response = createResponse();
  const handled = await handleUiSessionRoute({
    request,
    response,
    url: new URL(url),
    createStore: () => store,
  });
  assert.equal(handled, true);
  return {
    statusCode: response.statusCodeWritten,
    body: JSON.parse(response.body),
  };
}

describe('handleUiSessionRoute', () => {
  beforeEach(() => {
    resetBridgeTestState();
  });

  it('imports, reads, renames, and archives Kimi Code sessions through HTTP routes', async () => {
    const kimiHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-ui-session-route-kimi-home-'));
    const previousKimiHome = process.env.KIMI_CODE_HOME;
    process.env.KIMI_CODE_HOME = kimiHome;
    const cwd = path.join(kimiHome, 'workspace');
    const sessionId = 'session_kimi-ui-route-session';
    writeKimiWireFixture({ homeDir: kimiHome, cwd, sessionId });
    const store = new JsonFileStore(makeBridgeSettings());

    try {
      const imported = await dispatch(
        store,
        createJsonRequest({ kimiSessionId: sessionId, kimiCwd: cwd }),
        'http://localhost/api/sessions/import-kimi-thread',
      );
      assert.equal(imported.statusCode, 200);
      assert.equal(imported.body.ok, true);
      assert.equal(imported.body.config.activeRuntime, 'kimi');
      assert.equal(imported.body.session.kimiSessionId, sessionId);
      assert.equal(store.getSession(imported.body.bridgeSessionId)?.runtime?.kimi?.provider, 'tmux');

      const history = await dispatch(
        store,
        createGetRequest(),
        `http://localhost/api/session-history?kimiSessionId=${encodeURIComponent(sessionId)}&kimiCwd=${encodeURIComponent(cwd)}`,
      );
      assert.equal(history.statusCode, 200);
      assert.equal(history.body.source, 'kimi');
      assert.equal(history.body.session.kimiSessionId, sessionId);
      assert.equal(history.body.messages.length, 2);
      assert.equal(history.body.messages.some((message: { role?: string; content?: string }) => (
        message.role === 'user' && message.content === 'hello kimi ui route'
      )), true);
      const assistantMessage = history.body.messages.find((message: { role?: string }) => message.role === 'assistant');
      assert.equal(assistantMessage?.content, 'route kimi **reply**');
      assert.match(assistantMessage?.renderedContent || '', /<strong>reply<\/strong>/);
      assert.equal(JSON.stringify(history.body).includes('private route thinking'), false);

      const renamed = await dispatch(
        store,
        createJsonRequest({ kimiSessionId: sessionId, kimiCwd: cwd, name: 'Renamed Kimi Route' }),
        'http://localhost/api/sessions/rename',
      );
      assert.equal(renamed.statusCode, 200);
      assert.equal(renamed.body.config.name, 'Renamed Kimi Route');
      assert.equal(store.getSession(imported.body.bridgeSessionId)?.name, 'Renamed Kimi Route');

      const deleted = await dispatch(
        store,
        createJsonRequest({ kimiSessionId: sessionId, kimiCwd: cwd }),
        'http://localhost/api/sessions/delete',
      );
      assert.equal(deleted.statusCode, 200);
      assert.equal(deleted.body.ok, true);
      assert.deepEqual(deleted.body.deletedBridgeSessionIds, [imported.body.bridgeSessionId]);
      assert.equal(store.getSession(imported.body.bridgeSessionId), null);
      assert.equal(isArchivedKimiSession(sessionId, cwd), true);
    } finally {
      if (previousKimiHome === undefined) delete process.env.KIMI_CODE_HOME;
      else process.env.KIMI_CODE_HOME = previousKimiHome;
      fs.rmSync(kimiHome, { recursive: true, force: true });
    }
  });

  it('imports, reads, and archives Cursor Agent sessions through HTTP routes', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-ui-session-route-cursor-'));
    const configDir = path.join(root, 'config');
    const dataDir = path.join(root, 'data');
    const cwd = path.join(root, 'workspace');
    const sessionId = '019f9b31-1df0-7777-a111-123456789abc';
    const previousConfig = process.env.CURSOR_CONFIG_DIR;
    const previousData = process.env.CURSOR_DATA_DIR;
    process.env.CURSOR_CONFIG_DIR = configDir;
    process.env.CURSOR_DATA_DIR = dataDir;
    writeCursorTranscriptFixture({ configDir, cwd, sessionId });
    const store = new JsonFileStore(makeBridgeSettings());

    try {
      const imported = await dispatch(store, createJsonRequest({ cursorSessionId: sessionId, cursorCwd: cwd }), 'http://localhost/api/sessions/import-cursor-thread');
      assert.equal(imported.statusCode, 200);
      assert.equal(imported.body.config.activeRuntime, 'cursor');
      assert.equal(imported.body.session.cursorSessionId, sessionId);
      assert.equal(store.getSession(imported.body.bridgeSessionId)?.runtime?.cursor?.provider, 'tmux');

      const history = await dispatch(store, createGetRequest(), `http://localhost/api/session-history?cursorSessionId=${encodeURIComponent(sessionId)}&cursorCwd=${encodeURIComponent(cwd)}`);
      assert.equal(history.statusCode, 200);
      assert.equal(history.body.source, 'cursor');
      assert.equal(history.body.messages.some((message: { content?: string }) => message.content === 'hello cursor ui route'), true);
      assert.equal(history.body.messages.some((message: { content?: string }) => message.content === 'cursor route reply'), true);

      const deleted = await dispatch(store, createJsonRequest({ cursorSessionId: sessionId, cursorCwd: cwd }), 'http://localhost/api/sessions/delete');
      assert.equal(deleted.statusCode, 200);
      assert.deepEqual(deleted.body.deletedBridgeSessionIds, [imported.body.bridgeSessionId]);
      assert.equal(isArchivedCursorSession(sessionId, cwd), true);
    } finally {
      if (previousConfig === undefined) delete process.env.CURSOR_CONFIG_DIR;
      else process.env.CURSOR_CONFIG_DIR = previousConfig;
      if (previousData === undefined) delete process.env.CURSOR_DATA_DIR;
      else process.env.CURSOR_DATA_DIR = previousData;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('imports, reads, renames, and archives ZCode sessions through HTTP routes', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-ui-session-route-zcode-'));
    const cwd = path.join(root, 'workspace');
    const dbPath = path.join(root, 'data', 'sessions.sqlite');
    const sessionId = 'sess_zcode_ui_route';
    const previousDbPath = process.env.CODELARK_ZCODE_SESSION_DB_PATH;
    process.env.CODELARK_ZCODE_SESSION_DB_PATH = dbPath;
    writeZcodeDatabaseFixture({ dbPath, cwd, sessionId });
    const store = new JsonFileStore(makeBridgeSettings());

    try {
      const imported = await dispatch(store, createJsonRequest({ zcodeSessionId: sessionId, zcodeCwd: cwd }), 'http://localhost/api/sessions/import-zcode-thread');
      assert.equal(imported.statusCode, 200);
      assert.equal(imported.body.config.activeRuntime, 'zcode');
      assert.equal(imported.body.session.zcodeSessionId, sessionId);
      assert.equal(store.getSession(imported.body.bridgeSessionId)?.runtime?.zcode?.provider, 'tmux');

      const history = await dispatch(store, createGetRequest(), `http://localhost/api/session-history?zcodeSessionId=${encodeURIComponent(sessionId)}&zcodeCwd=${encodeURIComponent(cwd)}`);
      assert.equal(history.statusCode, 200);
      assert.equal(history.body.source, 'zcode');
      assert.equal(history.body.messages.some((message: { content?: string }) => message.content === 'hello zcode ui route'), true);
      assert.equal(history.body.messages.some((message: { content?: string }) => message.content === 'zcode route reply'), true);

      const renamed = await dispatch(store, createJsonRequest({ zcodeSessionId: sessionId, zcodeCwd: cwd, name: 'Renamed ZCode Route' }), 'http://localhost/api/sessions/rename');
      assert.equal(renamed.statusCode, 200);
      assert.equal(renamed.body.config.name, 'Renamed ZCode Route');

      const deleted = await dispatch(store, createJsonRequest({ zcodeSessionId: sessionId, zcodeCwd: cwd }), 'http://localhost/api/sessions/delete');
      assert.equal(deleted.statusCode, 200);
      assert.deepEqual(deleted.body.deletedBridgeSessionIds, [imported.body.bridgeSessionId]);
      assert.equal(store.getSession(imported.body.bridgeSessionId), null);
    } finally {
      if (previousDbPath === undefined) delete process.env.CODELARK_ZCODE_SESSION_DB_PATH;
      else process.env.CODELARK_ZCODE_SESSION_DB_PATH = previousDbPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
