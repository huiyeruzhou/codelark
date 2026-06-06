import '../../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { handleUiChannelRoute } from '../../../../operator-ui/routes/channel.js';
import { CODELARK_HOME, CONFIG_JSON_PATH, CONFIG_PATH, type Config } from '../../../../configuration/index.js';

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

  it('creates home config.toml for channel saves when only legacy config files exist', async () => {
    const configTomlPath = path.join(CODELARK_HOME, 'config.toml');
    const previousToml = fs.existsSync(configTomlPath) ? fs.readFileSync(configTomlPath, 'utf-8') : null;
    const previousEnvFile = fs.existsSync(CONFIG_PATH) ? fs.readFileSync(CONFIG_PATH, 'utf-8') : null;
    const previousJsonFile = fs.existsSync(CONFIG_JSON_PATH) ? fs.readFileSync(CONFIG_JSON_PATH, 'utf-8') : null;
    const envKeys = Object.keys(process.env)
      .filter((key) => key.startsWith('CODELARK_') && key !== 'CODELARK_HOME');
    const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));

    try {
      for (const key of envKeys) delete process.env[key];
      fs.mkdirSync(CODELARK_HOME, { recursive: true });
      fs.rmSync(configTomlPath, { force: true });
      fs.writeFileSync(CONFIG_PATH, 'CODELARK_HISTORY_MESSAGE_LIMIT=5\n');
      fs.writeFileSync(CONFIG_JSON_PATH, JSON.stringify({
        schemaVersion: 1,
        runtime: { provider: 'codex', bridge: { historyMessageLimit: 6 } },
        channels: [],
      }, null, 2));

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
        buildBindingsPayload: async () => ({ bindings: [], options: [], channelDefaults: [] }),
      });

      assert.equal(handled, true);
      assert.equal(response.statusCodeWritten, 200);
      const body = JSON.parse(response.body) as { ok?: boolean; channel?: { alias?: string } };
      assert.equal(body.ok, true);
      assert.equal(body.channel?.alias, 'Ops');
      assert.equal(fs.readFileSync(CONFIG_PATH, 'utf-8'), 'CODELARK_HISTORY_MESSAGE_LIMIT=5\n');
      const legacyJson = JSON.parse(fs.readFileSync(CONFIG_JSON_PATH, 'utf-8')) as any;
      assert.equal(legacyJson.runtime.bridge.historyMessageLimit, 6);
      const savedToml = fs.readFileSync(configTomlPath, 'utf-8');
      assert.match(savedToml, /alias = "Ops"/);
      assert.match(savedToml, /app_id = "app-id"/);
      assert.match(savedToml, /app_secret = "secret"/);
    } finally {
      if (previousToml === null) fs.rmSync(configTomlPath, { force: true });
      else fs.writeFileSync(configTomlPath, previousToml, 'utf-8');
      if (previousEnvFile === null) fs.rmSync(CONFIG_PATH, { force: true });
      else fs.writeFileSync(CONFIG_PATH, previousEnvFile, 'utf-8');
      if (previousJsonFile === null) fs.rmSync(CONFIG_JSON_PATH, { force: true });
      else fs.writeFileSync(CONFIG_JSON_PATH, previousJsonFile, 'utf-8');
      for (const [key, value] of previousEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
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

  it('deletes channels from home config.toml through the default ConfigService writer', async () => {
    const configTomlPath = path.join(CODELARK_HOME, 'config.toml');
    const previousToml = fs.existsSync(configTomlPath) ? fs.readFileSync(configTomlPath, 'utf-8') : null;
    try {
      fs.mkdirSync(CODELARK_HOME, { recursive: true });
      fs.writeFileSync(configTomlPath, `
schema_version = 2

[runtime]
provider = "codex"

[[channels]]
id = "feishu-default"
alias = "飞书"
provider = "feishu"
enabled = true

[channels.config]
history_message_limit = 8
app_id = "default-app"
app_secret = "default-secret"

[[channels]]
id = "feishu-ops"
alias = "Ops"
provider = "feishu"
enabled = true

[channels.config]
app_id = "ops-app"
app_secret = "ops-secret"
`);

      const store = createMemoryStore();
      const response = createResponse();
      const handled = await handleUiChannelRoute({
        request: createJsonRequest({ channelId: 'feishu-ops' }),
        response,
        url: new URL('http://localhost/api/channels/delete'),
        createStore: () => store,
        buildBindingsPayload: async () => ({ bindings: [], options: [], channelDefaults: [] }),
      });

      assert.equal(handled, true);
      assert.equal(response.statusCodeWritten, 200);
      const body = JSON.parse(response.body) as { ok?: boolean; config?: { channels?: Array<{ id?: string }> } };
      assert.equal(body.ok, true);
      assert.deepEqual(body.config?.channels?.map((channel) => channel.id), ['feishu-default']);
      assert.equal(store.deletedDefaults.includes('feishu-ops'), true);
      const savedToml = fs.readFileSync(configTomlPath, 'utf-8');
      assert.match(savedToml, /feishu-default/);
      assert.doesNotMatch(savedToml, /feishu-ops/);
      assert.doesNotMatch(savedToml, /ops-secret/);
    } finally {
      if (previousToml === null) fs.rmSync(configTomlPath, { force: true });
      else fs.writeFileSync(configTomlPath, previousToml, 'utf-8');
    }
  });

  it('tests channel credentials from home config.toml through the default ConfigService reader', async () => {
    const configTomlPath = path.join(CODELARK_HOME, 'config.toml');
    const previousToml = fs.existsSync(configTomlPath) ? fs.readFileSync(configTomlPath, 'utf-8') : null;
    try {
      fs.mkdirSync(CODELARK_HOME, { recursive: true });
      fs.writeFileSync(configTomlPath, `
schema_version = 2

[[channels]]
id = "feishu-ops"
alias = "Ops"
provider = "feishu"
enabled = true

[channels.config]
history_message_limit = 8
app_id = "ops-app"
app_secret = ""
`);

      const response = createResponse();
      const handled = await handleUiChannelRoute({
        request: createJsonRequest({ channelId: 'feishu-ops' }),
        response,
        url: new URL('http://localhost/api/channels/test'),
        createStore: () => createMemoryStore(),
        buildBindingsPayload: async () => ({ bindings: [], options: [], channelDefaults: [] }),
      });

      assert.equal(handled, true);
      assert.equal(response.statusCodeWritten, 200);
      const body = JSON.parse(response.body) as { ok?: boolean; message?: string };
      assert.equal(body.ok, false);
      assert.match(body.message || '', /App ID \/ App Secret 不能为空/);
    } finally {
      if (previousToml === null) fs.rmSync(configTomlPath, { force: true });
      else fs.writeFileSync(configTomlPath, previousToml, 'utf-8');
    }
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
