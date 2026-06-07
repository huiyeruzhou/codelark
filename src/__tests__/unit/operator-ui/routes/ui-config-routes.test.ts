import '../../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { handleUiConfigRoute } from '../../../../operator-ui/routes/config.js';
import { configV2ToPayload, mergeConfigV2HomePatch } from '../../../../operator-ui/application/config.js';
import { CODELARK_HOME } from '../../../../configuration/paths.js';
import {
  LEGACY_CONFIG_ENV_PATH as CONFIG_PATH,
  LEGACY_CONFIG_JSON_PATH as CONFIG_JSON_PATH,
} from '../../../../configuration/migrations/legacy/paths.js';
import type { ConfigV2 } from '../../../../configuration/schema.js';

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

function baseConfigV2(overrides: Partial<ConfigV2> = {}): ConfigV2 {
  return {
    schemaVersion: 2,
    session: {
      workspace: '~',
      tmuxSessionName: '',
      tmuxCaptureLines: 80,
      tmuxAutoEnter: true,
      tmuxEchoInput: false,
    },
    runtime: {
      agent: 'codex',
      codex: {
        model: '',
        yoloMode: 'off',
        provider: '',
        skipGitRepoCheck: true,
        sandboxMode: 'workspace-write',
        networkAccess: true,
        reasoningEffort: 'medium',
      },
      claude: {
        model: '',
        yoloMode: 'off',
        permissionMode: 'default',
        provider: 'sdk',
        executable: 'claude',
        reasoningEffort: 'medium',
        idleTimeoutMinutes: 0,
      },
    },
    bridge: {
      defaultWorkspace: '~',
      uiAllowLan: false,
      uiAccessToken: '',
    },
    channels: [{
      id: 'feishu-default',
      alias: '飞书',
      provider: 'feishu',
      enabled: false,
      config: {
        historyMessageLimit: 8,
        streamStatusIdleStartSeconds: 180,
        streamStatusCheckIntervalSeconds: 10,
        appId: '',
        appSecret: '',
        site: 'feishu',
        allowedUsers: [],
        streamingEnabled: true,
        feedbackMarkdownEnabled: true,
        requireMention: false,
      },
    }],
    ...overrides,
  };
}

describe('Ui config application', () => {
  it('rejects invalid UI config fields instead of silently falling back', () => {
    const current = baseConfigV2({
      runtime: {
        ...baseConfigV2().runtime,
        codex: { ...baseConfigV2().runtime.codex, model: 'gpt-5.4', provider: 'tmux' },
      },
    });

    assert.throws(
      () => mergeConfigV2HomePatch(current, { defaultModel: 'unknown-model', historyMessageLimit: 999, claudeExecutable: 'ccr' }),
      /未知 Codex 模型|历史消息条数必须在 1 到 20 之间/,
    );
  });

  it('creates a UI access token when LAN access is enabled', () => {
    const patch = mergeConfigV2HomePatch(baseConfigV2(), { uiAllowLan: true });
    assert.equal(patch.bridge?.uiAllowLan, true);
    assert.equal(typeof patch.bridge?.uiAccessToken, 'string');
    assert.ok(patch.bridge?.uiAccessToken?.length);
  });

  it('keeps current v2 values when a partial payload omits fields', () => {
    const current = baseConfigV2({
      runtime: {
        ...baseConfigV2().runtime,
        agent: 'claude',
        codex: {
          ...baseConfigV2().runtime.codex,
          sandboxMode: 'danger-full-access',
          networkAccess: false,
          reasoningEffort: 'high',
          yoloMode: 'on',
        },
      },
      bridge: {
        defaultWorkspace: '/tmp/work',
        uiAllowLan: true,
        uiAccessToken: 'existing-token',
      },
    });
    const patch = mergeConfigV2HomePatch(current, {});

    assert.equal(patch.runtime?.agent, 'claude');
    assert.equal(patch.runtime?.codex?.sandboxMode, 'danger-full-access');
    assert.equal(patch.runtime?.codex?.networkAccess, false);
    assert.equal(patch.runtime?.codex?.reasoningEffort, 'high');
    assert.equal(patch.runtime?.codex?.yoloMode, 'on');
    assert.equal(patch.bridge?.defaultWorkspace, '/tmp/work');
    assert.equal(patch.bridge?.uiAllowLan, true);
    assert.equal(patch.bridge?.uiAccessToken, 'existing-token');
  });

  it('does not synthesize channel timing defaults when the effective config has no channel', () => {
    const patch = mergeConfigV2HomePatch(baseConfigV2({ channels: [] }), { historyMessageLimit: 19 });
    assert.deepEqual(patch.channels, []);
  });

  it('defaults the Claude provider payload to sdk', () => {
    const payload = configV2ToPayload(baseConfigV2());
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
      assert.match(savedToml, /agent = "claude"/);
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

  it('checks config payloads without writing config.toml', async () => {
    const configTomlPath = path.join(CODELARK_HOME, 'config.toml');
    const previousToml = fs.existsSync(configTomlPath) ? fs.readFileSync(configTomlPath, 'utf-8') : null;
    try {
      fs.mkdirSync(CODELARK_HOME, { recursive: true });
      fs.rmSync(configTomlPath, { force: true });

      const okResponse = createResponse();
      const okHandled = await handleUiConfigRoute({
        request: createJsonRequest('POST', {
          runtime: 'claude',
          historyMessageLimit: 13,
          codexNetworkAccess: false,
        }),
        response: okResponse,
        url: new URL('http://localhost/api/config/check'),
      });

      assert.equal(okHandled, true);
      assert.equal(okResponse.statusCodeWritten, 200);
      assert.deepEqual(JSON.parse(okResponse.body), { ok: true });
      assert.equal(fs.existsSync(configTomlPath), false);

      const badResponse = createResponse();
      const badHandled = await handleUiConfigRoute({
        request: createJsonRequest('POST', {
          historyMessageLimit: 21,
          showToolCallDetails: false,
        }),
        response: badResponse,
        url: new URL('http://localhost/api/config/check'),
      });

      assert.equal(badHandled, true);
      assert.equal(badResponse.statusCodeWritten, 400);
      const badBody = JSON.parse(badResponse.body) as { ok?: boolean; error?: string; issues?: Array<{ path: string }> };
      assert.equal(badBody.ok, false);
      assert.match(badBody.error || '', /配置字段不合法/);
      assert.ok(badBody.issues?.some((issue) => issue.path === 'historyMessageLimit'));
      assert.ok(badBody.issues?.some((issue) => issue.path === ''));
      assert.equal(fs.existsSync(configTomlPath), false);
    } finally {
      if (previousToml === null) fs.rmSync(configTomlPath, { force: true });
      else fs.writeFileSync(configTomlPath, previousToml, 'utf-8');
    }
  });

  it('rejects invalid POST writes without rewriting home config', async () => {
    const configTomlPath = path.join(CODELARK_HOME, 'config.toml');
    const previousToml = fs.existsSync(configTomlPath) ? fs.readFileSync(configTomlPath, 'utf-8') : null;
    try {
      fs.mkdirSync(CODELARK_HOME, { recursive: true });
      fs.writeFileSync(configTomlPath, `
schema_version = 2

[runtime]
agent = "codex"
`);

      const response = createResponse();
      const handled = await handleUiConfigRoute({
        request: createJsonRequest('POST', { codexSandboxMode: 'invalid' }),
        response,
        url: new URL('http://localhost/api/config'),
      });

      assert.equal(handled, true);
      assert.equal(response.statusCodeWritten, 400);
      assert.match(JSON.parse(response.body).error || '', /配置字段不合法/);
      assert.equal(fs.readFileSync(configTomlPath, 'utf-8').includes('invalid'), false);
    } finally {
      if (previousToml === null) fs.rmSync(configTomlPath, { force: true });
      else fs.writeFileSync(configTomlPath, previousToml, 'utf-8');
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
agent = "codex"

[runtime.codex]
provider = "sdk"
yolo_mode = "off"

[runtime.claude]
reasoning_effort = "high"

[[channels]]
id = "feishu-default"
alias = "飞书"
provider = "feishu"
enabled = true

[channels.config]
app_id = "ui-old-app"
app_secret = "ui-old-secret"
history_message_limit = 8
stream_status_idle_start_seconds = 180
stream_status_check_interval_seconds = 10
site = "feishu"
allowed_users = []
streaming_enabled = true
feedback_markdown_enabled = true
require_mention = false
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
      assert.match(savedToml, /agent = "claude"/);
      assert.match(savedToml, /provider = "tmux"/);
      assert.match(savedToml, /yolo_mode = "on"/);
      assert.match(savedToml, /history_message_limit = 14/);
      assert.match(savedToml, /network_access = false/);
      assert.match(savedToml, /reasoning_effort = "high"/);
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
