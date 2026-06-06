import '../../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { handleUiConfigRoute } from '../../../../operator-ui/routes/config.js';
import { configToPayload, mergeConfig } from '../../../../operator-ui/application/config.js';
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

function createJsonRequest(method: string, body: unknown): IncomingMessage {
  const chunks = [Buffer.from(JSON.stringify(body))];
  return {
    method,
    async *[Symbol.asyncIterator]() {
      yield* chunks;
    },
  } as IncomingMessage;
}

const baseConfig: Config = {
  runtime: 'codex',
  defaultMode: 'normal',
  enabledChannels: [],
  channels: [],
};

describe('Ui config application', () => {
  it('preserves the current default model when an unknown model is submitted', () => {
    const merged = mergeConfig(
      { ...baseConfig, defaultModel: 'gpt-5.4', defaultProvider: 'tmux', claudeExecutable: 'claude' },
      { defaultModel: 'unknown-model', historyMessageLimit: 999, claudeExecutable: 'ccr' },
    );

    assert.equal(merged.defaultModel, 'gpt-5.4');
    assert.equal(merged.defaultProvider, 'tmux');
    assert.equal(merged.claudeExecutable, 'ccr');
    assert.equal(merged.historyMessageLimit, 20);
  });

  it('creates a UI access token when LAN access is enabled', () => {
    const merged = mergeConfig(baseConfig, { uiAllowLan: true });
    assert.equal(merged.uiAllowLan, true);
    assert.equal(typeof merged.uiAccessToken, 'string');
    assert.ok(merged.uiAccessToken?.length);
  });

  it('defaults the Claude provider payload to sdk', () => {
    const payload = configToPayload(baseConfig);
    assert.equal(payload.claudeProvider, 'sdk');
  });
});

describe('handleUiConfigRoute', () => {
  it('handles config reads', async () => {
    const response = createResponse();
    const handled = await handleUiConfigRoute({
      request: { method: 'GET' } as IncomingMessage,
      response,
      url: new URL('http://localhost/api/config'),
    });

    assert.equal(handled, true);
    assert.equal(response.statusCodeWritten, 200);
    const body = JSON.parse(response.body) as { runtime?: string; availableModels?: unknown[] };
    assert.equal(body.runtime, 'codex');
    assert.ok(Array.isArray(body.availableModels));
  });

  it('creates home config.toml for POST writes when only legacy config files exist', async () => {
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

      const response = createResponse();
      const handled = await handleUiConfigRoute({
        request: createJsonRequest('POST', {
          runtime: 'claude',
          historyMessageLimit: 13,
          codexNetworkAccess: false,
        }),
        response,
        url: new URL('http://localhost/api/config'),
      });

      assert.equal(handled, true);
      assert.equal(response.statusCodeWritten, 200);
      const body = JSON.parse(response.body) as { ok?: boolean; config?: Record<string, unknown> };
      assert.equal(body.ok, true);
      assert.equal(body.config?.runtime, 'claude');
      assert.equal(body.config?.historyMessageLimit, 13);
      assert.equal(body.config?.codexNetworkAccess, false);
      assert.equal(fs.readFileSync(CONFIG_PATH, 'utf-8'), 'CODELARK_HISTORY_MESSAGE_LIMIT=5\n');
      const legacyJson = JSON.parse(fs.readFileSync(CONFIG_JSON_PATH, 'utf-8')) as any;
      assert.equal(legacyJson.runtime.bridge.historyMessageLimit, 6);
      const savedToml = fs.readFileSync(configTomlPath, 'utf-8');
      assert.match(savedToml, /provider = "claude"/);
      assert.match(savedToml, /history_message_limit = 13/);
      assert.match(savedToml, /network_access = false/);
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

  it('posts v2 config updates through TOML without rewriting legacy env/json files', async () => {
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
      fs.writeFileSync(configTomlPath, `
schema_version = 2

[runtime]
provider = "codex"

[runtime.codex]
provider = "sdk"
yolo_mode = "off"

[[channels]]
id = "feishu-default"
alias = "飞书"
provider = "feishu"
enabled = true

[channels.config]
app_id = "ui-old-app"
app_secret = "ui-old-secret"
history_message_limit = 8
`);
      fs.writeFileSync(CONFIG_PATH, 'CODELARK_HISTORY_MESSAGE_LIMIT=5\n');
      fs.writeFileSync(CONFIG_JSON_PATH, JSON.stringify({
        schemaVersion: 1,
        runtime: { provider: 'codex', bridge: { historyMessageLimit: 6 } },
        channels: [],
      }, null, 2));

      const response = createResponse();
      const handled = await handleUiConfigRoute({
        request: createJsonRequest('POST', {
          runtime: 'claude',
          defaultProvider: 'tmux',
          defaultMode: 'yolo',
          historyMessageLimit: 14,
          codexNetworkAccess: false,
        }),
        response,
        url: new URL('http://localhost/api/config'),
      });

      assert.equal(handled, true);
      assert.equal(response.statusCodeWritten, 200);
      const body = JSON.parse(response.body) as { ok?: boolean; config?: Record<string, unknown> };
      assert.equal(body.ok, true);
      assert.equal(body.config?.runtime, 'claude');
      assert.equal(body.config?.defaultProvider, 'tmux');
      assert.equal(body.config?.defaultMode, 'yolo');
      assert.equal(body.config?.historyMessageLimit, 14);
      assert.equal(body.config?.codexNetworkAccess, false);
      assert.equal(fs.readFileSync(CONFIG_PATH, 'utf-8'), 'CODELARK_HISTORY_MESSAGE_LIMIT=5\n');
      const legacyJson = JSON.parse(fs.readFileSync(CONFIG_JSON_PATH, 'utf-8')) as any;
      assert.equal(legacyJson.runtime.bridge.historyMessageLimit, 6);
      const savedToml = fs.readFileSync(configTomlPath, 'utf-8');
      assert.match(savedToml, /provider = "claude"/);
      assert.match(savedToml, /provider = "tmux"/);
      assert.match(savedToml, /yolo_mode = "on"/);
      assert.match(savedToml, /history_message_limit = 14/);
      assert.match(savedToml, /network_access = false/);
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

  it('ignores routes owned by other UI modules', async () => {
    const response = createResponse();
    const handled = await handleUiConfigRoute({
      request: { method: 'GET' } as IncomingMessage,
      response,
      url: new URL('http://localhost/api/status'),
    });

    assert.equal(handled, false);
    assert.equal(response.body, '');
  });
});
