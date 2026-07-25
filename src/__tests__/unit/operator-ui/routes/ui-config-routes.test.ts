import '../../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { handleUiConfigRoute } from '../../../../operator-ui/routes/config.js';
import {
  configV2ToPayload,
  mergeConfigV2HomePatch,
  UI_CONFIG_INPUT_KEYS,
} from '../../../../operator-ui/application/config.js';
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
        provider: 'sdk',
        executable: 'claude',
        reasoningEffort: 'medium',
        idleTimeoutMinutes: 0,
      },
      kimi: {
        model: '',
        provider: 'tmux',
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
        groupAuthorized: false,
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
        kimi: {
          model: 'kimi-current',
          provider: 'tmux',
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
    assert.equal(patch.runtime?.kimi?.model, 'kimi-current');
    assert.equal(patch.runtime?.kimi?.provider, 'tmux');
    assert.equal(patch.bridge?.defaultWorkspace, '/tmp/work');
    assert.equal(patch.bridge?.uiAllowLan, true);
    assert.equal(patch.bridge?.uiAccessToken, 'existing-token');
  });

  it('round-trips shared tmux defaults and all Claude runtime defaults', () => {
    const current = baseConfigV2();
    const patch = mergeConfigV2HomePatch(current, {
      tmuxCaptureLines: '140',
      tmuxAutoEnter: false,
      tmuxEchoInput: true,
      claudeMode: 'yolo',
      claudeReasoningEffort: 'max',
    });

    assert.deepEqual(patch.session, {
      tmuxCaptureLines: 140,
      tmuxAutoEnter: false,
      tmuxEchoInput: true,
    });
    assert.equal(patch.runtime?.claude?.yoloMode, 'on');
    assert.equal(patch.runtime?.claude?.reasoningEffort, 'max');

    const payload = configV2ToPayload({
      ...current,
      session: { ...current.session, ...patch.session },
      runtime: {
        ...current.runtime,
        claude: { ...current.runtime.claude, ...patch.runtime?.claude },
      },
    });
    assert.equal(payload.tmuxCaptureLines, 140);
    assert.equal(payload.tmuxAutoEnter, false);
    assert.equal(payload.tmuxEchoInput, true);
    assert.equal(payload.claudeMode, 'yolo');
    assert.equal(payload.claudeReasoningEffort, 'max');
  });

  it('keeps the browser form submission keys equal to the backend input contract', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/operator-ui/shell.ts'), 'utf-8');
    const body = source.match(/function formPayload\(\) \{\s*return \{([\s\S]*?)\n\s*\};\n\s*\}/)?.[1] || '';
    const browserKeys = [...body.matchAll(/^\s+(\w+):/gm)].map((match) => match[1]).sort();

    assert.deepEqual(browserKeys, UI_CONFIG_INPUT_KEYS);
    assert.doesNotMatch(source, /showToolCallDetails/);
    assert.match(source, /运行状态刷新间隔（秒）/);
    assert.match(source, /id="streamStatusCheckIntervalSeconds"[^>]*value="5"/);
    assert.match(source, /config\.streamStatusCheckIntervalSeconds \|\| 5/);
    assert.doesNotMatch(source, /长任务提示刷新间隔/);
  });

  it('exposes and writes global Kimi runtime defaults', () => {
    const current = baseConfigV2({
      runtime: {
        ...baseConfigV2().runtime,
        agent: 'kimi',
        kimi: {
          model: 'moonshot-v1-current',
          provider: 'tmux',
        },
      },
    });

    const payload = configV2ToPayload(current);
    assert.equal(payload.runtime, 'kimi');
    assert.equal(payload.kimiDefaultModel, 'moonshot-v1-current');
    assert.equal(payload.kimiProvider, 'tmux');

    const patch = mergeConfigV2HomePatch(current, {
      runtime: 'kimi',
      kimiDefaultModel: 'moonshot-v1-next',
      kimiProvider: 'tmux',
    });
    assert.equal(patch.runtime?.agent, 'kimi');
    assert.equal(patch.runtime?.kimi?.model, 'moonshot-v1-next');
    assert.equal(patch.runtime?.kimi?.provider, 'tmux');
    assert.equal(patch.runtime?.codex?.provider, current.runtime.codex.provider);
    assert.equal(patch.runtime?.claude?.provider, current.runtime.claude.provider);
  });

  it('rejects invalid global Kimi provider values', () => {
    assert.throws(
      () => mergeConfigV2HomePatch(baseConfigV2(), { kimiProvider: 'sdk' }),
      /Invalid input: expected \\"tmux\\"/,
    );
  });

  it('does not synthesize channel timing defaults when the effective config has no channel', () => {
    const patch = mergeConfigV2HomePatch(baseConfigV2({ channels: [] }), { historyMessageLimit: 19 });
    assert.deepEqual(patch.channels, []);
  });

  it('defaults the Claude provider payload to sdk', () => {
    const payload = configV2ToPayload(baseConfigV2());
    assert.equal(payload.claudeProvider, 'sdk');
  });

  it('keeps the global config shell wired to Kimi form fields', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/operator-ui/shell.ts'), 'utf-8');
    assert.match(source, /<select id="runtime">[\s\S]*<option value="codex" selected>codex<\/option>[\s\S]*<option value="claude">claude<\/option>[\s\S]*<option value="kimi">kimi<\/option>/);
    assert.match(source, /GlobalRuntime \/ Kimi/);
    assert.match(source, /id="kimiProvider"/);
    assert.match(source, /id="kimiDefaultModel"/);
    assert.match(source, /<select id="defaultProvider">[\s\S]*<option value="sdk">sdk<\/option>[\s\S]*<option value="pty">pty<\/option>[\s\S]*<option value="tmux">tmux<\/option>/);
    assert.match(source, /kimiProvider: document\.getElementById\('kimiProvider'\)\.value/);
    assert.match(source, /kimiDefaultModel: document\.getElementById\('kimiDefaultModel'\)\.value/);
    assert.match(source, /document\.getElementById\('kimiProvider'\)\.value = config\.kimiProvider \|\| 'tmux'/);
    assert.match(source, /document\.getElementById\('kimiDefaultModel'\)\.value = config\.kimiDefaultModel \|\| ''/);
  });

  it('describes /t runtime identities as thread or session ids', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/operator-ui/shell.ts'), 'utf-8');
    assert.match(source, /thread\/session id/);
    assert.doesNotMatch(source, /\/t &lt;序号\|thread id\|bridge id\|名称&gt;/);
    assert.doesNotMatch(source, /\/t archive \[序号\|bridge id\|thread id\|名称\]/);
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
          streamStatusIdleStartSeconds: 0,
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
      assert.equal(body.config?.streamStatusIdleStartSeconds, 0);
      assert.equal(body.config?.codexNetworkAccess, false);
      assert.equal(fs.readFileSync(CONFIG_PATH, 'utf-8'), 'CODELARK_HISTORY_MESSAGE_LIMIT=5\n');
      const legacyJson = JSON.parse(fs.readFileSync(CONFIG_JSON_PATH, 'utf-8')) as any;
      assert.equal(legacyJson.runtime.bridge.historyMessageLimit, 6);
      const savedToml = fs.readFileSync(configTomlPath, 'utf-8');
      assert.match(savedToml, /agent = "claude"/);
      assert.match(savedToml, /provider = "tmux"/);
      assert.match(savedToml, /yolo_mode = "on"/);
      assert.match(savedToml, /history_message_limit = 14/);
      assert.match(savedToml, /stream_status_idle_start_seconds = 0/);
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
