import '../../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { handleUiChannelRoute } from '../../../../operator-ui/routes/channel.js';
import type { Config } from '../../../../configuration/index.js';

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

const baseConfig: Config = {
  runtime: 'codex',
  defaultMode: 'normal',
  enabledChannels: [],
  channels: [],
};

function createMemoryStore(bindings: unknown[] = []) {
  const deletedDefaults: string[] = [];
  return {
    deletedDefaults,
    listChannelChats: () => bindings,
    updateChannelChat: () => undefined,
    getChannelDefaultTarget: () => null,
    upsertChannelDefaultTarget: () => undefined,
    deleteChannelDefaultTarget: (channelId: string) => {
      deletedDefaults.push(channelId);
    },
  };
}

describe('handleUiChannelRoute', () => {
  it('saves channel config through the channel route', async () => {
    let config = { ...baseConfig };
    const store = createMemoryStore();
    const response = createResponse();

    const handled = await handleUiChannelRoute({
      request: createJsonRequest({
        provider: 'feishu',
        alias: 'Ops',
        appId: 'app-id',
        appSecret: 'secret',
      }),
      response,
      url: new URL('http://localhost/api/channels/save'),
      createStore: () => store,
      readConfig: () => config,
      writeConfig: (next) => {
        config = next;
      },
      buildBindingsPayload: async () => ({ bindings: [], options: [], channelDefaults: [] }),
    });

    assert.equal(handled, true);
    assert.equal(response.statusCodeWritten, 200);
    assert.equal(config.channels?.length, 1);
    assert.equal(config.channels?.[0]?.provider, 'feishu');
    assert.equal(config.channels?.[0]?.alias, 'Ops');
    const body = JSON.parse(response.body) as { ok?: boolean; channel?: { alias?: string } };
    assert.equal(body.ok, true);
    assert.equal(body.channel?.alias, 'Ops');
  });

  it('saves context-only group mention mode through the channel route', async () => {
    let config = { ...baseConfig };
    const store = createMemoryStore();
    const response = createResponse();

    const handled = await handleUiChannelRoute({
      request: createJsonRequest({
        provider: 'feishu',
        alias: 'Ops',
        appId: 'app-id',
        appSecret: 'secret',
        requireMention: 'context',
      }),
      response,
      url: new URL('http://localhost/api/channels/save'),
      createStore: () => store,
      readConfig: () => config,
      writeConfig: (next) => {
        config = next;
      },
      buildBindingsPayload: async () => ({ bindings: [], options: [], channelDefaults: [] }),
    });

    assert.equal(handled, true);
    assert.equal(response.statusCodeWritten, 200);
    assert.equal(config.channels?.[0]?.config.requireMention, 'context');
  });

  it('refuses to delete a channel with bindings', async () => {
    const config = {
      ...baseConfig,
      enabledChannels: ['feishu'],
      channels: [{
        id: 'feishu-ops',
        alias: 'Ops',
        provider: 'feishu' as const,
        enabled: true,
        createdAt: '2026-05-30T00:00:00.000Z',
        updatedAt: '2026-05-30T00:00:00.000Z',
        config: {},
      }],
    };
    const store = createMemoryStore([{ id: 'binding-1' }]);
    const response = createResponse();

    const handled = await handleUiChannelRoute({
      request: createJsonRequest({ channelId: 'feishu-ops' }),
      response,
      url: new URL('http://localhost/api/channels/delete'),
      createStore: () => store,
      readConfig: () => config,
      writeConfig: () => undefined,
      buildBindingsPayload: async () => ({ bindings: [], options: [], channelDefaults: [] }),
    });

    assert.equal(handled, true);
    assert.equal(response.statusCodeWritten, 400);
    const body = JSON.parse(response.body) as { error?: string };
    assert.match(body.error || '', /仍有聊天绑定/);
  });

  it('ignores routes owned by other UI modules', async () => {
    const response = createResponse();
    const handled = await handleUiChannelRoute({
      request: { method: 'GET' } as IncomingMessage,
      response,
      url: new URL('http://localhost/api/config'),
      createStore: () => createMemoryStore(),
      readConfig: () => baseConfig,
      writeConfig: () => undefined,
      buildBindingsPayload: async () => ({}),
    });

    assert.equal(handled, false);
    assert.equal(response.body, '');
  });
});
