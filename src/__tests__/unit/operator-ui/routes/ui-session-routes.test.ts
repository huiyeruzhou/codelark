import '../../../setup/test-setup.js';
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { handleUiSessionRoute } from '../../../../operator-ui/routes/session.js';
import { computeKimiWorkspaceDirName, isArchivedKimiSession } from '../../../../runtime/kimi/session-index.js';
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
});
