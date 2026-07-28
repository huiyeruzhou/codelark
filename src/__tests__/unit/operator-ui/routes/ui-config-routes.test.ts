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
  readUiConfigPayload,
  UI_CONFIG_INPUT_KEYS,
} from '../../../../operator-ui/application/config.js';
import { CODELARK_HOME } from '../../../../configuration/paths.js';
import {
  LEGACY_CONFIG_ENV_PATH as CONFIG_PATH,
  LEGACY_CONFIG_JSON_PATH as CONFIG_JSON_PATH,
} from '../../../../configuration/migrations/legacy/paths.js';
import { claudeProviderSchema, type ConfigV2 } from '../../../../configuration/schema.js';

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
      cursor: {
        model: '',
        provider: 'tmux',
        force: false,
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
      () => mergeConfigV2HomePatch(current, { defaultModel: 'unknown-model', claudeExecutable: 'ccr' }),
      /未知 Codex 模型/,
    );
  });

  it('preserves an existing custom Codex model while rejecting a different unknown model', () => {
    const current = baseConfigV2({
      runtime: {
        ...baseConfigV2().runtime,
        codex: { ...baseConfigV2().runtime.codex, model: 'private-codex-model' },
      },
    });

    const patch = mergeConfigV2HomePatch(current, {
      defaultModel: 'private-codex-model',
      tmuxCaptureLines: 120,
    });
    assert.equal(patch.runtime?.codex?.model, 'private-codex-model');
    assert.equal(patch.session?.tmuxCaptureLines, 120);
    assert.throws(
      () => mergeConfigV2HomePatch(current, { defaultModel: 'different-unknown-model' }),
      /未知 Codex 模型/,
    );
  });

  it('keeps per-channel history and streaming timing out of the global UI payload', () => {
    for (const key of [
      'historyMessageLimit',
      'streamStatusIdleStartSeconds',
      'streamStatusCheckIntervalSeconds',
    ]) {
      assert.throws(
        () => mergeConfigV2HomePatch(baseConfigV2(), { [key]: 5 }),
        /unrecognized key/i,
      );
    }
    const payload = configV2ToPayload(baseConfigV2()) as Record<string, unknown>;
    assert.equal('historyMessageLimit' in payload, false);
    assert.equal('streamStatusIdleStartSeconds' in payload, false);
    assert.equal('streamStatusCheckIntervalSeconds' in payload, false);
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

  it('round-trips user-configurable tmux defaults and all Claude runtime defaults', () => {
    const current = baseConfigV2();
    const patch = mergeConfigV2HomePatch(current, {
      tmuxCaptureLines: '140',
      tmuxEchoInput: true,
      claudeMode: 'yolo',
      claudeReasoningEffort: 'max',
    });

    assert.deepEqual(patch.session, {
      tmuxCaptureLines: 140,
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
    assert.equal('tmuxAutoEnter' in payload, false);
    assert.equal(payload.tmuxEchoInput, true);
    assert.equal(payload.claudeMode, 'yolo');
    assert.equal(payload.claudeReasoningEffort, 'max');
  });

  it('rejects the removed tmux auto-enter browser setting', () => {
    assert.throws(
      () => mergeConfigV2HomePatch(baseConfigV2(), { tmuxAutoEnter: false }),
      /unrecognized key/i,
    );
  });

  it('keeps the browser form submission keys equal to the backend input contract', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/operator-ui/shell.ts'), 'utf-8').replace(/\r\n/g, '\n');
    const body = source.match(/function formPayload\(\) \{\s*return \{([\s\S]*?)\n\s*\};\n\s*\}/)?.[1] || '';
    const browserKeys = [...body.matchAll(/^\s+(\w+):/gm)].map((match) => match[1]).sort();

    assert.deepEqual(browserKeys, UI_CONFIG_INPUT_KEYS);
    assert.doesNotMatch(source, /showToolCallDetails/);
    assert.doesNotMatch(source, /id="historyMessageLimit"/);
    assert.doesNotMatch(source, /id="streamStatusIdleStartSeconds"/);
    assert.doesNotMatch(source, /id="streamStatusCheckIntervalSeconds"/);
    assert.match(source, /id="channelHistoryMessageLimit"/);
    assert.match(source, /id="channelStreamStatusIdleStartSeconds"/);
    assert.match(source, /id="channelStreamStatusCheckIntervalSeconds"/);
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

  it('exposes and writes global Cursor runtime defaults', () => {
    const current = baseConfigV2({
      runtime: {
        ...baseConfigV2().runtime,
        agent: 'cursor',
        cursor: { model: 'cursor-current', provider: 'tmux', force: true },
      },
    });
    const payload = configV2ToPayload(current);
    assert.equal(payload.runtime, 'cursor');
    assert.equal(payload.cursorDefaultModel, 'cursor-current');
    assert.equal(payload.cursorProvider, 'tmux');
    assert.equal(payload.cursorForce, true);

    const patch = mergeConfigV2HomePatch(current, {
      runtime: 'cursor',
      cursorDefaultModel: 'cursor-next',
      cursorProvider: 'tmux',
      cursorForce: false,
    });
    assert.equal(patch.runtime?.agent, 'cursor');
    assert.deepEqual(patch.runtime?.cursor, { model: 'cursor-next', provider: 'tmux', force: false });
  });

  it('preserves an empty channel list when saving unrelated global config', () => {
    const patch = mergeConfigV2HomePatch(baseConfigV2({ channels: [] }), { runtime: 'claude' });
    assert.deepEqual(patch.channels, []);
  });

  it('defaults the Claude provider payload to sdk', () => {
    const payload = configV2ToPayload(baseConfigV2());
    assert.equal(payload.claudeProvider, 'sdk');
  });

  it('keeps the Claude provider control equal to the backend enum contract', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/operator-ui/shell.ts'), 'utf-8');
    const selectBody = source.match(/<select id="claudeProvider">([\s\S]*?)<\/select>/)?.[1] || '';
    const browserOptions = [...selectBody.matchAll(/<option value="([^"]*)">/g)].map((match) => match[1]);

    assert.deepEqual(browserOptions, [...claudeProviderSchema.options]);
    assert.throws(
      () => mergeConfigV2HomePatch(baseConfigV2(), { claudeProvider: '' }),
      /Invalid option/,
    );
  });

  it('keeps the global config shell wired to Kimi form fields', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/operator-ui/shell.ts'), 'utf-8');
    assert.match(source, /<select id="runtime">[\s\S]*<option value="codex" selected>codex<\/option>[\s\S]*<option value="claude">claude<\/option>[\s\S]*<option value="kimi">kimi<\/option>/);
    assert.match(source, /data-config-section="kimi"/);
    assert.match(source, /Kimi 默认值/);
    assert.match(source, /id="kimiProvider"/);
    assert.match(source, /id="kimiDefaultModel"/);
    assert.match(source, /<select id="defaultProvider">[\s\S]*<option value="sdk">sdk<\/option>[\s\S]*<option value="tmux">tmux<\/option>/);
    assert.match(source, /<option value="">跟随默认<\/option>/);
    assert.doesNotMatch(source, /<option value="">auto<\/option>/);
    assert.match(source, /跟随默认（默认值：/);
    assert.match(source, /defaultProviderInherited === true/);
    assert.match(source, /classList\.toggle\('uses-default'/);
    assert.match(source, /kimiProvider: document\.getElementById\('kimiProvider'\)\.value/);
    assert.match(source, /kimiDefaultModel: document\.getElementById\('kimiDefaultModel'\)\.value/);
    assert.match(source, /document\.getElementById\('kimiProvider'\)\.value = config\.kimiProvider \|\| 'tmux'/);
    assert.match(source, /document\.getElementById\('kimiDefaultModel'\)\.value = config\.kimiDefaultModel \|\| ''/);
  });

  it('keeps the global and session config shell wired to Cursor form fields', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/operator-ui/shell.ts'), 'utf-8');
    assert.match(source, /<option value="cursor">cursor<\/option>/);
    assert.match(source, /data-config-section="cursor"/);
    assert.match(source, /Cursor 默认值/);
    assert.match(source, /id="cursorProvider"/);
    assert.match(source, /id="cursorDefaultModel"/);
    assert.match(source, /id="cursorForce"/);
    assert.match(source, /id="sessionConfigCursorBlock"/);
    assert.match(source, /cursorProvider: document\.getElementById\('cursorProvider'\)\.value/);
    assert.match(source, /document\.getElementById\('cursorForce'\)\.checked = config\.cursorForce === true/);
  });

  it('describes /t runtime identities as thread or session ids', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/operator-ui/shell.ts'), 'utf-8');
    assert.match(source, /thread\/session id/);
    assert.doesNotMatch(source, /\/t &lt;序号\|thread id\|bridge id\|名称&gt;/);
    assert.doesNotMatch(source, /\/t archive \[序号\|bridge id\|thread id\|名称\]/);
  });
});

describe('handleUiConfigRoute', () => {
  it('renders an inherited Codex provider as a gray default state', () => {
    const configTomlPath = path.join(CODELARK_HOME, 'config.toml');
    const previousToml = fs.existsSync(configTomlPath) ? fs.readFileSync(configTomlPath, 'utf-8') : null;
    try {
      fs.mkdirSync(CODELARK_HOME, { recursive: true });
      fs.rmSync(configTomlPath, { force: true });

      const payload = readUiConfigPayload();
      assert.equal(payload.defaultProvider, '');
      assert.equal(payload.defaultProviderInherited, true);
      assert.equal(payload.defaultProviderDefaultValue, 'tmux');
    } finally {
      if (previousToml === null) fs.rmSync(configTomlPath, { force: true });
      else fs.writeFileSync(configTomlPath, previousToml, 'utf-8');
    }
  });

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
      assert.equal('historyMessageLimit' in (body.config || {}), false);
      assert.equal(body.config?.codexNetworkAccess, false);
      assert.equal(fs.readFileSync(CONFIG_PATH, 'utf-8'), 'CODELARK_HISTORY_MESSAGE_LIMIT=5\n');
      const legacyJson = JSON.parse(fs.readFileSync(CONFIG_JSON_PATH, 'utf-8')) as any;
      assert.equal(legacyJson.runtime.bridge.historyMessageLimit, 6);
      const savedToml = fs.readFileSync(configTomlPath, 'utf-8');
      assert.match(savedToml, /agent = "claude"/);
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
          tmuxCaptureLines: 0,
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
      assert.ok(badBody.issues?.some((issue) => issue.path === 'tmuxCaptureLines'));
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
      assert.equal('historyMessageLimit' in (body.config || {}), false);
      assert.equal('streamStatusIdleStartSeconds' in (body.config || {}), false);
      assert.equal(body.config?.codexNetworkAccess, false);
      assert.equal(fs.readFileSync(CONFIG_PATH, 'utf-8'), 'CODELARK_HISTORY_MESSAGE_LIMIT=5\n');
      const legacyJson = JSON.parse(fs.readFileSync(CONFIG_JSON_PATH, 'utf-8')) as any;
      assert.equal(legacyJson.runtime.bridge.historyMessageLimit, 6);
      const savedToml = fs.readFileSync(configTomlPath, 'utf-8');
      assert.match(savedToml, /agent = "claude"/);
      assert.match(savedToml, /provider = "tmux"/);
      assert.match(savedToml, /yolo_mode = "on"/);
      assert.match(savedToml, /history_message_limit = 8/);
      assert.match(savedToml, /stream_status_idle_start_seconds = 180/);
      assert.match(savedToml, /stream_status_check_interval_seconds = 10/);
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

  it('clears the home Codex provider instead of storing an empty override', async () => {
    const configTomlPath = path.join(CODELARK_HOME, 'config.toml');
    const previousToml = fs.existsSync(configTomlPath) ? fs.readFileSync(configTomlPath, 'utf-8') : null;
    try {
      fs.mkdirSync(CODELARK_HOME, { recursive: true });
      fs.writeFileSync(configTomlPath, `
schema_version = 2

[runtime.codex]
provider = "sdk"
`);

      const response = createResponse();
      const handled = await handleUiConfigRoute({
        request: createJsonRequest('POST', { defaultProvider: '' }),
        response,
        url: new URL('http://localhost/api/config'),
      });

      assert.equal(handled, true);
      assert.equal(response.statusCodeWritten, 200);
      const body = JSON.parse(response.body) as {
        ok?: boolean;
        config?: Record<string, unknown>;
      };
      assert.equal(body.ok, true);
      assert.equal(body.config?.defaultProvider, '');
      assert.equal(body.config?.defaultProviderInherited, true);
      assert.equal(body.config?.defaultProviderDefaultValue, 'tmux');
      const savedToml = fs.readFileSync(configTomlPath, 'utf-8');
      const codexBlock = savedToml.match(/\[runtime\.codex\]([\s\S]*?)(?=\n\[|$)/)?.[1] || '';
      assert.doesNotMatch(codexBlock, /\bprovider\s*=/);
    } finally {
      if (previousToml === null) fs.rmSync(configTomlPath, { force: true });
      else fs.writeFileSync(configTomlPath, previousToml, 'utf-8');
    }
  });

  it('keeps an explicitly selected tmux Codex provider distinct from the default state', async () => {
    const configTomlPath = path.join(CODELARK_HOME, 'config.toml');
    const previousToml = fs.existsSync(configTomlPath) ? fs.readFileSync(configTomlPath, 'utf-8') : null;
    try {
      fs.mkdirSync(CODELARK_HOME, { recursive: true });
      fs.rmSync(configTomlPath, { force: true });

      const response = createResponse();
      await handleUiConfigRoute({
        request: createJsonRequest('POST', { defaultProvider: 'tmux' }),
        response,
        url: new URL('http://localhost/api/config'),
      });

      const body = JSON.parse(response.body) as { config?: Record<string, unknown> };
      assert.equal(body.config?.defaultProvider, 'tmux');
      assert.equal(body.config?.defaultProviderInherited, false);
      assert.match(fs.readFileSync(configTomlPath, 'utf-8'), /provider = "tmux"/);
    } finally {
      if (previousToml === null) fs.rmSync(configTomlPath, { force: true });
      else fs.writeFileSync(configTomlPath, previousToml, 'utf-8');
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
