import '../../../setup/test-setup.js';
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { handleUiBindingRoute } from '../../../../operator-ui/routes/binding.js';
import type { ConfigV2 } from '../../../../configuration/schema.js';
import { listChannelDefaultTargetSummaries } from '../../../../bridge/session/registry/bindings.js';
import { computeKimiWorkspaceDirName } from '../../../../runtime/kimi/session-index.js';
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
  fs.writeFileSync(path.join(wireDir, 'wire.jsonl'), `${JSON.stringify({
    type: 'context.append_loop_event',
    time: Date.parse('2026-06-27T00:00:00.000Z'),
    event: { type: 'content.part', part: { type: 'text', text: 'binding route reply' } },
  })}\n`, 'utf-8');
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
    createdAt: '2026-06-27T00:00:00.000Z',
    updatedAt: '2026-06-27T00:00:01.000Z',
    title: 'Kimi binding route session',
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
  const handled = await handleUiBindingRoute({
    request,
    response,
    url: new URL(url),
    createStore: () => store,
    readConfig: () => ({}) as ConfigV2,
    buildBindingsPayload: async (payloadStore) => ({
      bindings: payloadStore.listChannelChats(),
      channelDefaults: listChannelDefaultTargetSummaries(payloadStore),
      options: payloadStore.listSessions(),
    }),
  });
  assert.equal(handled, true);
  return {
    statusCode: response.statusCodeWritten,
    body: JSON.parse(response.body),
  };
}

describe('handleUiBindingRoute', () => {
  beforeEach(() => {
    resetBridgeTestState();
  });

  it('materializes Kimi Code sessions when updating channel defaults and bindings through HTTP routes', async () => {
    const kimiHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-ui-binding-route-kimi-home-'));
    const previousKimiHome = process.env.KIMI_CODE_HOME;
    process.env.KIMI_CODE_HOME = kimiHome;
    const cwd = path.join(kimiHome, 'workspace');
    const sessionId = 'session_kimi-ui-binding-route';
    writeKimiWireFixture({ homeDir: kimiHome, cwd, sessionId });
    const store = new JsonFileStore(makeBridgeSettings());
    const oldSession = store.createSession('Old binding target', 'test-model', undefined, '/tmp/old-binding-target');
    const binding = store.upsertChannelChat({
      channelType: 'feishu',
      chatId: 'chat-kimi-binding-route',
      bridgeSessionId: oldSession.id,
    });

    try {
      const defaultTarget = await dispatch(
        store,
        createJsonRequest({ channelType: 'feishu', kimiSessionId: sessionId, kimiCwd: cwd }),
        'http://localhost/api/channel-default-targets/update',
      );
      assert.equal(defaultTarget.statusCode, 200);
      assert.equal(defaultTarget.body.ok, true);
      assert.equal(defaultTarget.body.updated.targetRuntime, 'kimi');
      assert.equal(defaultTarget.body.updated.targetRuntimeThreadId, sessionId);
      assert.equal(defaultTarget.body.updated.targetKimiCwd, cwd);
      assert.equal(defaultTarget.body.updated.mode, 'normal');
      assert.equal(defaultTarget.body.updated.executionProvider, 'tmux');
      assert.equal(defaultTarget.body.channelDefaults[0].mode, 'normal');
      assert.equal(defaultTarget.body.channelDefaults[0].executionProvider, 'tmux');
      assert.equal(defaultTarget.body.channelDefaults[0].bridgeSessionId, defaultTarget.body.updated.targetSessionId);

      const materializedSessionId = defaultTarget.body.updated.targetSessionId;
      const materialized = store.getSession(materializedSessionId);
      assert.ok(materialized);
      assert.equal(materialized.runtime?.activeRuntime, 'kimi');
      assert.equal(materialized.runtime?.kimi?.sessionId, sessionId);
      assert.equal(materialized.runtime?.kimi?.cwd, cwd);
      assert.equal(materialized.runtime?.kimi?.provider, 'tmux');
      assert.equal(store.getChannelDefaultTarget('feishu')?.bridgeSessionId, materializedSessionId);

      const updatedBinding = await dispatch(
        store,
        createJsonRequest({ bindingId: binding.id, kimiSessionId: sessionId, kimiCwd: cwd }),
        'http://localhost/api/bindings/update',
      );
      assert.equal(updatedBinding.statusCode, 200);
      assert.equal(updatedBinding.body.ok, true);
      assert.equal(updatedBinding.body.updated.currentRuntime, 'kimi');
      assert.equal(updatedBinding.body.updated.currentRuntimeThreadId, sessionId);
      assert.equal(updatedBinding.body.updated.currentKimiCwd, cwd);
      assert.equal(updatedBinding.body.updated.mode, 'normal');
      assert.equal(updatedBinding.body.updated.executionProvider, 'tmux');
      assert.equal(updatedBinding.body.updated.currentSessionId, materializedSessionId);
      assert.equal(store.getChannelChat('feishu', 'chat-kimi-binding-route')?.bridgeSessionId, materializedSessionId);
    } finally {
      if (previousKimiHome === undefined) delete process.env.KIMI_CODE_HOME;
      else process.env.KIMI_CODE_HOME = previousKimiHome;
      fs.rmSync(kimiHome, { recursive: true, force: true });
    }
  });
});
