import '../../setup/test-setup.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configToSettings, configV2ToLegacyConfig, legacyConfigToConfigPatch } from '../../../configuration/legacy.js';
import type { Config } from '../../../configuration/legacy-types.js';
import { CODELARK_HOME } from '../../../configuration/paths.js';
import {
  LEGACY_CONFIG_ENV_PATH as CONFIG_PATH,
  LEGACY_CONFIG_JSON_PATH as CONFIG_JSON_PATH,
} from '../../../configuration/migrations/legacy/paths.js';
import { createConfigService } from '../../../configuration/service.js';

function loadLegacyConfig(): Config {
  return configV2ToLegacyConfig(
    createConfigService({ codelarkHome: CODELARK_HOME }).snapshot().config,
  );
}

function saveLegacyConfig(config: Config): void {
  createConfigService({ codelarkHome: CODELARK_HOME })
    .set({ kind: 'home' }, legacyConfigToConfigPatch(config));
}

// ── configToSettings ──

describe('configToSettings', () => {
  const base: Config = {
    runtime: 'codex',
    channels: [],
    enabledChannels: [],
    defaultMode: 'normal',
  };

  it('maps feishu config', () => {
    const m = configToSettings({
      ...base,
      channels: [
        {
          id: 'feishu-default',
          alias: '飞书',
          provider: 'feishu',
          enabled: true,
          createdAt: '2026-03-28T00:00:00.000Z',
          updatedAt: '2026-03-28T00:00:00.000Z',
          config: {
            appId: 'app-id',
            appSecret: 'app-secret',
            site: 'lark',
            allowedUsers: ['fu1'],
            streamingEnabled: false,
            feedbackMarkdownEnabled: true,
            requireMention: false,
          },
        },
      ],
    });
    assert.equal(m.get('bridge_feishu_app_id'), 'app-id');
    assert.equal(m.get('bridge_feishu_app_secret'), 'app-secret');
    assert.equal(m.get('bridge_feishu_site'), 'lark');
    assert.equal(m.get('bridge_feishu_allowed_users'), 'fu1');
    assert.equal(m.get('bridge_feishu_streaming_enabled'), 'false');
    assert.equal(m.get('bridge_feishu_command_markdown_enabled'), 'true');
    assert.equal(m.get('bridge_feishu_require_mention'), 'false');
  });

  it('defaults Feishu group mention requirement to disabled', () => {
    const m = configToSettings({
      ...base,
      channels: [
        {
          id: 'feishu-default',
          alias: '飞书',
          provider: 'feishu',
          enabled: true,
          createdAt: '2026-03-28T00:00:00.000Z',
          updatedAt: '2026-03-28T00:00:00.000Z',
          config: {},
        },
      ],
    });
    assert.equal(m.get('bridge_feishu_require_mention'), 'false');
  });

  it('maps runtime defaults and scalar overrides', () => {
    const m = configToSettings(base);
    assert.equal(m.get('bridge_feishu_enabled'), 'false');
    assert.equal(m.get('remote_bridge_enabled'), 'true');
    assert.equal(m.has('bridge_default_model'), false);
    assert.equal(m.has('default_model'), false);
    assert.equal(m.has('bridge_feishu_app_id'), false);
    assert.equal(m.get('bridge_default_mode'), 'normal');
    assert.equal(m.get('bridge_history_message_limit'), '8');
    assert.equal(m.get('bridge_stream_status_idle_start_seconds'), '180');
    assert.equal(m.get('bridge_stream_status_check_interval_seconds'), '10');

    const configured = configToSettings({
      ...base,
      defaultModel: 'gpt-4o',
      defaultProvider: 'tmux',
      defaultWorkspaceRoot: '/tmp/workspace',
      historyMessageLimit: 12,
      streamStatusIdleStartSeconds: 240,
      streamStatusCheckIntervalSeconds: 15,
      codexSkipGitRepoCheck: true,
      codexSandboxMode: 'danger-full-access',
      codexNetworkAccess: true,
      codexReasoningEffort: 'xhigh',
      claudeExecutable: 'ccr',
      defaultMode: 'yolo',
    });
    assert.equal(configured.get('bridge_default_model'), 'gpt-4o');
    assert.equal(configured.get('default_model'), 'gpt-4o');
    assert.equal(configured.get('bridge_default_provider'), 'tmux');
    assert.equal(configured.get('bridge_claude_executable'), 'ccr');
    assert.equal(configured.get('bridge_default_workspace_root'), '/tmp/workspace');
    assert.equal(configured.get('bridge_history_message_limit'), '12');
    assert.equal(configured.get('bridge_stream_status_idle_start_seconds'), '240');
    assert.equal(configured.get('bridge_stream_status_check_interval_seconds'), '15');
    assert.equal(configured.get('bridge_codex_skip_git_repo_check'), 'true');
    assert.equal(configured.get('bridge_codex_sandbox_mode'), 'danger-full-access');
    assert.equal(configured.get('bridge_codex_network_access'), 'true');
    assert.equal(configured.get('bridge_codex_reasoning_effort'), 'xhigh');
    assert.equal(configured.get('bridge_default_mode'), 'yolo');
  });

  it('omits unsupported channel providers from runtime settings', () => {
    const m = configToSettings({
      ...base,
      channels: [
        {
          id: 'feishu-default',
          alias: '飞书',
          provider: 'feishu',
          enabled: true,
          createdAt: '2026-03-28T00:00:00.000Z',
          updatedAt: '2026-03-28T00:00:00.000Z',
          config: {},
        },
        {
          id: 'telegram-old',
          alias: 'Telegram',
          provider: 'telegram',
          enabled: true,
          createdAt: '2026-03-28T00:00:00.000Z',
          updatedAt: '2026-03-28T00:00:00.000Z',
          config: {},
        } as never,
      ],
    });

    const channels = JSON.parse(m.get('bridge_channel_instances_json') || '[]') as Array<{ provider: string }>;
    assert.deepEqual(channels.map((channel) => channel.provider), ['feishu']);
  });
});

// ── Config file parsing (legacy adapter round-trip) ──

describe('legacy config adapter round-trip', () => {
  let tmpDir: string;
  let origHome: string;
  let configBackup: string | null;
  let configBackupJson: string | null;
  let configBackupToml: string | null;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-config-test-'));
    origHome = process.env.HOME || '';
    configBackup = fs.existsSync(CONFIG_PATH) ? fs.readFileSync(CONFIG_PATH, 'utf-8') : null;
    configBackupJson = fs.existsSync(CONFIG_JSON_PATH) ? fs.readFileSync(CONFIG_JSON_PATH, 'utf-8') : null;
    configBackupToml = fs.existsSync(path.join(path.dirname(CONFIG_JSON_PATH), 'config.toml'))
      ? fs.readFileSync(path.join(path.dirname(CONFIG_JSON_PATH), 'config.toml'), 'utf-8')
      : null;
    fs.rmSync(CONFIG_PATH, { force: true });
    fs.rmSync(CONFIG_JSON_PATH, { force: true });
    fs.rmSync(path.join(path.dirname(CONFIG_JSON_PATH), 'config.toml'), { force: true });
    fs.rmSync(path.join(path.dirname(CONFIG_JSON_PATH), 'runtime'), { recursive: true, force: true });
    fs.rmSync(path.join(path.dirname(CONFIG_JSON_PATH), 'backups'), { recursive: true, force: true });
    fs.rmSync(`${CONFIG_PATH}.migrated-v1`, { force: true });
    fs.rmSync(`${CONFIG_JSON_PATH}.migrated-v1`, { force: true });
  });

  afterEach(() => {
    process.env.HOME = origHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(CONFIG_PATH, { force: true });
    fs.rmSync(CONFIG_JSON_PATH, { force: true });
    fs.rmSync(path.join(path.dirname(CONFIG_JSON_PATH), 'config.toml'), { force: true });
    fs.rmSync(path.join(path.dirname(CONFIG_JSON_PATH), 'runtime'), { recursive: true, force: true });
    fs.rmSync(path.join(path.dirname(CONFIG_JSON_PATH), 'backups'), { recursive: true, force: true });
    fs.rmSync(`${CONFIG_PATH}.migrated-v1`, { force: true });
    fs.rmSync(`${CONFIG_JSON_PATH}.migrated-v1`, { force: true });
    if (configBackup !== null) {
      fs.writeFileSync(CONFIG_PATH, configBackup);
    }
    if (configBackupJson !== null) {
      fs.writeFileSync(CONFIG_JSON_PATH, configBackupJson);
    }
    if (configBackupToml !== null) {
      fs.writeFileSync(path.join(path.dirname(CONFIG_JSON_PATH), 'config.toml'), configBackupToml);
    }
  });

  it('loads existing config.toml through the v2 config service and ignores config.env', () => {
    const envKeys = Object.keys(process.env)
      .filter((key) => key.startsWith('CODELARK_') && key !== 'CODELARK_HOME');
    const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
    for (const key of envKeys) delete process.env[key];
    const configTomlPath = path.join(path.dirname(CONFIG_JSON_PATH), 'config.toml');
    try {
      fs.mkdirSync(path.dirname(configTomlPath), { recursive: true });
      fs.writeFileSync(configTomlPath, `
[runtime]
agent = "claude"

[bridge]
default_workspace = "/v2/workspace"

[runtime.codex]
model = "v2-codex-model"
yolo_mode = "on"
provider = "pty"
sandbox_mode = "danger-full-access"
network_access = false
reasoning_effort = "high"

[runtime.claude]
model = "v2-claude-model"
yolo_mode = "on"
provider = "pty"
executable = "ccr"
idle_timeout_minutes = 11

[[channels]]
id = "feishu-default"
alias = "飞书"
provider = "feishu"
enabled = true

[channels.config]
history_message_limit = 17
stream_status_idle_start_seconds = 210
stream_status_check_interval_seconds = 12
app_id = "v2-app"
app_secret = "v2-secret"
site = "lark"
allowed_users = ["ou_v2"]
streaming_enabled = false
feedback_markdown_enabled = false
require_mention = true
`);
    fs.writeFileSync(CONFIG_PATH, [
      'CODELARK_RUNTIME=codex',
      'CODELARK_CODEX_DEFAULT_MODEL=must-not-read-env',
      'CODELARK_FEISHU_APP_ID=must-not-read-env',
    ].join('\n'));

      const loaded = loadLegacyConfig();

      assert.equal(loaded.schemaVersion, 2);
      assert.equal(loaded.runtime, 'claude');
      assert.equal(loaded.defaultWorkspaceRoot, '/v2/workspace');
      assert.equal(loaded.defaultModel, 'v2-codex-model');
      assert.equal(loaded.defaultProvider, 'pty');
      assert.equal(loaded.defaultMode, 'yolo');
      assert.equal(loaded.codexSandboxMode, 'danger-full-access');
      assert.equal(loaded.codexNetworkAccess, false);
      assert.equal(loaded.codexReasoningEffort, 'high');
      assert.equal(loaded.claudeDefaultModel, 'v2-claude-model');
      assert.equal(loaded.claudeProvider, 'pty');
      assert.equal(loaded.claudeExecutable, 'ccr');
      assert.equal(loaded.claudeIdleTimeoutMinutes, 11);
      assert.equal(loaded.historyMessageLimit, 17);
      assert.equal(loaded.streamStatusIdleStartSeconds, 210);
      assert.equal(loaded.streamStatusCheckIntervalSeconds, 12);
      assert.deepEqual(loaded.enabledChannels, ['feishu']);
      assert.deepEqual(
        loaded.channels?.map((channel) => ({
          id: channel.id,
          appId: (channel.config as { appId?: string }).appId,
          appSecret: (channel.config as { appSecret?: string }).appSecret,
          site: (channel.config as { site?: string }).site,
          allowedUsers: (channel.config as { allowedUsers?: string[] }).allowedUsers,
          streamingEnabled: (channel.config as { streamingEnabled?: boolean }).streamingEnabled,
          feedbackMarkdownEnabled: (channel.config as { feedbackMarkdownEnabled?: boolean }).feedbackMarkdownEnabled,
          requireMention: (channel.config as { requireMention?: boolean }).requireMention,
        })),
        [{
          id: 'feishu-default',
          appId: 'v2-app',
          appSecret: 'v2-secret',
          site: 'lark',
          allowedUsers: ['ou_v2'],
          streamingEnabled: false,
          feedbackMarkdownEnabled: false,
          requireMention: true,
        }],
      );
      assert.equal(fs.existsSync(CONFIG_JSON_PATH), false);
    } finally {
      for (const [key, value] of originalEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('saves v2 configs back to config.toml without updating legacy config.env or config.json', () => {
    const envKeys = Object.keys(process.env)
      .filter((key) => key.startsWith('CODELARK_') && key !== 'CODELARK_HOME');
    const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
    for (const key of envKeys) delete process.env[key];
    const configTomlPath = path.join(path.dirname(CONFIG_JSON_PATH), 'config.toml');
    try {
      fs.mkdirSync(path.dirname(configTomlPath), { recursive: true });
      fs.writeFileSync(configTomlPath, `
schema_version = 2

[runtime]
agent = "codex"

[runtime.codex]
model = "old-model"
provider = "sdk"
yolo_mode = "off"

[runtime.claude]
executable = "claude"

[[channels]]
id = "feishu-default"
alias = "飞书"
provider = "feishu"
enabled = true

[channels.config]
app_id = "old-app"
app_secret = "old-secret"
site = "feishu"
history_message_limit = 8
stream_status_idle_start_seconds = 180
stream_status_check_interval_seconds = 10
allowed_users = []
streaming_enabled = true
feedback_markdown_enabled = true
require_mention = false
`);
      fs.writeFileSync(CONFIG_PATH, 'CUSTOM_KEEP=1\nCODELARK_CODEX_DEFAULT_MODEL=legacy-env-model\n');
      fs.writeFileSync(CONFIG_JSON_PATH, JSON.stringify({
        schemaVersion: 1,
        runtime: { provider: 'codex', codex: { defaultModel: 'legacy-json-model' } },
        channels: [],
      }, null, 2));

      const loaded = loadLegacyConfig();
      saveLegacyConfig({
        ...loaded,
        defaultModel: 'saved-toml-model',
        defaultProvider: 'tmux',
        defaultMode: 'yolo',
        historyMessageLimit: 19,
        channels: loaded.channels?.map((channel) => ({
          ...channel,
          config: {
            ...channel.config,
            appId: 'saved-app',
            appSecret: 'saved-secret',
            site: 'lark',
          },
        })),
      });

      const reloaded = loadLegacyConfig();
      assert.equal(reloaded.schemaVersion, 2);
      assert.equal(reloaded.defaultModel, 'saved-toml-model');
      assert.equal(reloaded.defaultProvider, 'tmux');
      assert.equal(reloaded.defaultMode, 'yolo');
      assert.equal(reloaded.historyMessageLimit, 19);
      assert.equal((reloaded.channels?.[0]?.config as { appId?: string }).appId, 'saved-app');
      assert.equal((reloaded.channels?.[0]?.config as { appSecret?: string }).appSecret, 'saved-secret');
      assert.equal((reloaded.channels?.[0]?.config as { site?: string }).site, 'lark');
      assert.equal(fs.readFileSync(CONFIG_PATH, 'utf-8'), 'CUSTOM_KEEP=1\nCODELARK_CODEX_DEFAULT_MODEL=legacy-env-model\n');
      const legacyJson = JSON.parse(fs.readFileSync(CONFIG_JSON_PATH, 'utf-8')) as any;
      assert.equal(legacyJson.runtime.codex.defaultModel, 'legacy-json-model');
      const savedToml = fs.readFileSync(configTomlPath, 'utf-8');
      assert.match(savedToml, /model = "saved-toml-model"/);
      assert.match(savedToml, /provider = "tmux"/);
      assert.match(savedToml, /yolo_mode = "on"/);
      assert.match(savedToml, /app_id = "saved-app"/);
    } finally {
      for (const [key, value] of originalEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('migrates legacy config.env into home TOML and archives legacy inputs', () => {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(
      CONFIG_PATH,
      [
        'CODELARK_RUNTIME=codex',
        'CODELARK_ENABLED_CHANNELS=feishu',
        'CODELARK_FEISHU_APP_ID=app-id',
        'CODELARK_FEISHU_APP_SECRET=app-secret',
        'CODELARK_FEISHU_DOMAIN=lark',
        'CODELARK_FEISHU_ALLOWED_USERS=u1,u2',
      ].join('\n'),
    );

    const loaded = loadLegacyConfig();
    const configTomlPath = path.join(path.dirname(CONFIG_JSON_PATH), 'config.toml');
    const savedToml = fs.readFileSync(configTomlPath, 'utf-8');

    assert.equal(loaded.schemaVersion, 2);
    assert.equal(loaded.runtime, 'codex');
    assert.equal(fs.existsSync(CONFIG_PATH), false);
    assert.equal(fs.existsSync(CONFIG_JSON_PATH), false);
    assert.equal(fs.existsSync(configTomlPath), true);
    assert.match(savedToml, /schema_version = 2/);
    assert.match(savedToml, /app_id = "app-id"/);
    assert.match(savedToml, /site = "lark"/);
    assert.deepEqual(
      loaded.channels?.map((channel) => ({
        id: channel.id,
        alias: channel.alias,
        provider: channel.provider,
        enabled: channel.enabled,
        config: channel.provider === 'feishu' ? (channel.config as any).site : undefined,
      })),
      [
        {
          id: 'feishu-default',
          alias: '飞书',
          provider: 'feishu',
          enabled: true,
          config: 'lark',
        },
      ],
    );
  });

  it('migrates legacy config.json once and ignores later config.env edits', () => {
    fs.mkdirSync(path.dirname(CONFIG_JSON_PATH), { recursive: true });
    fs.writeFileSync(
      CONFIG_JSON_PATH,
      JSON.stringify({
        schemaVersion: 1,
        runtime: {
          provider: 'codex',
          codex: {
            defaultModel: 'old-model',
            defaultMode: 'yolo',
            sandboxMode: 'workspace-write',
          },
          bridge: {
            historyMessageLimit: 8,
          },
        },
        channels: [
          {
            id: 'feishu-rd',
            alias: '研发飞书',
            provider: 'feishu',
            enabled: true,
            createdAt: '2026-03-28T00:00:00.000Z',
            updatedAt: '2026-03-28T00:00:00.000Z',
            config: {
              appId: 'old-app',
              appSecret: 'old-secret',
            },
          },
          {
            id: 'feishu-cs',
            alias: '客服飞书',
            provider: 'feishu',
            enabled: false,
            createdAt: '2026-03-28T00:00:00.000Z',
            updatedAt: '2026-03-28T00:00:00.000Z',
            config: {
              appId: 'cs-app',
            },
          },
        ],
      }, null, 2),
    );
    const loaded = loadLegacyConfig();
    const configTomlPath = path.join(path.dirname(CONFIG_JSON_PATH), 'config.toml');

    assert.equal(loaded.schemaVersion, 2);
    assert.equal(loaded.defaultModel, 'old-model');
    assert.equal(loaded.defaultMode, 'yolo');
    assert.equal(loaded.historyMessageLimit, 8);
    assert.equal(fs.existsSync(configTomlPath), true);
    assert.equal(fs.existsSync(CONFIG_PATH), false);
    assert.equal(fs.existsSync(CONFIG_JSON_PATH), false);
    assert.deepEqual(
      loaded.channels?.map((channel) => ({
        id: channel.id,
        enabled: channel.enabled,
        appId: (channel.config as { appId?: string }).appId,
      })),
      [
        { id: 'feishu-rd', enabled: true, appId: 'old-app' },
        { id: 'feishu-cs', enabled: false, appId: 'cs-app' },
      ],
    );

    fs.writeFileSync(
      CONFIG_PATH,
      [
        'CODELARK_CODEX_DEFAULT_MODEL=ignored-after-migration',
        'CODELARK_FEISHU_APP_ID=ignored-after-migration',
      ].join('\n'),
    );
    const reloaded = loadLegacyConfig();
    assert.equal(reloaded.defaultModel, 'old-model');
    assert.equal(reloaded.channels?.[0]?.config.appId, 'old-app');
  });

  it('saveConfig creates home TOML and does not generate legacy env/json files', () => {
    const config: Config = {
      runtime: 'codex',
      defaultMode: 'normal',
      historyMessageLimit: 8,
      enabledChannels: ['feishu'],
      channels: [
        {
          id: 'feishu-rd',
          alias: '研发飞书',
          provider: 'feishu',
          enabled: true,
          createdAt: '2026-03-28T00:00:00.000Z',
          updatedAt: '2026-03-28T00:00:00.000Z',
          config: {
            appId: 'rd-app',
          },
        },
        {
          id: 'feishu-cs',
          alias: '客服飞书',
          provider: 'feishu',
          enabled: false,
          createdAt: '2026-03-28T00:00:00.000Z',
          updatedAt: '2026-03-28T00:00:00.000Z',
          config: {
            appId: 'cs-app',
          },
        },
      ],
    };
    saveLegacyConfig(config);

    const loaded = loadLegacyConfig();
    const configTomlPath = path.join(path.dirname(CONFIG_JSON_PATH), 'config.toml');

    assert.equal(fs.existsSync(configTomlPath), true);
    assert.equal(fs.existsSync(CONFIG_PATH), false);
    assert.equal(fs.existsSync(CONFIG_JSON_PATH), false);
    assert.deepEqual(
      loaded.channels?.map((channel) => ({
        id: channel.id,
        enabled: channel.enabled,
        appId: (channel.config as { appId?: string }).appId,
      })),
      [
        { id: 'feishu-rd', enabled: true, appId: 'rd-app' },
        { id: 'feishu-cs', enabled: false, appId: 'cs-app' },
      ],
    );
  });

  it('preserves migrated custom channel instances when saving runtime settings', () => {
    fs.mkdirSync(path.dirname(CONFIG_JSON_PATH), { recursive: true });
    fs.writeFileSync(
      CONFIG_JSON_PATH,
      JSON.stringify({
        schemaVersion: 1,
        runtime: {
          provider: 'codex',
          codex: {
            defaultMode: 'normal',
          },
          bridge: {
            historyMessageLimit: 8,
            streamStatusIdleStartSeconds: 180,
            streamStatusCheckIntervalSeconds: 10,
          },
        },
        channels: [
          {
            id: 'feishu-rd',
            alias: '研发飞书',
            provider: 'feishu',
            enabled: true,
            createdAt: '2026-03-28T00:00:00.000Z',
            updatedAt: '2026-03-28T00:00:00.000Z',
            config: {
              appId: 'rd-app',
              appSecret: 'rd-secret',
              feedbackMarkdownEnabled: true,
            },
          },
          {
            id: 'feishu-cs',
            alias: '客服飞书',
            provider: 'feishu',
            enabled: true,
            createdAt: '2026-03-28T00:00:00.000Z',
            updatedAt: '2026-03-28T00:00:00.000Z',
            config: {
              appId: 'cs-app',
              appSecret: 'cs-secret',
              feedbackMarkdownEnabled: false,
            },
          },
        ],
      }, null, 2),
    );

    const loaded = loadLegacyConfig();
    saveLegacyConfig({
      ...loaded,
      defaultMode: 'yolo',
      defaultProvider: 'sdk',
      claudeExecutable: 'ccr',
      claudeDefaultModel: 'claude-sonnet-test',
      claudeIdleTimeoutMinutes: 15,
      historyMessageLimit: 12,
      streamStatusIdleStartSeconds: 240,
      streamStatusCheckIntervalSeconds: 15,
    });

    const reloaded = loadLegacyConfig();
    assert.deepEqual(
      reloaded.channels?.map((channel) => ({
        id: channel.id,
        alias: channel.alias,
        provider: channel.provider,
        appId: (channel.config as { appId?: string }).appId,
      })),
      [
        {
          id: 'feishu-rd',
          alias: '研发飞书',
          provider: 'feishu',
          appId: 'rd-app',
        },
        {
          id: 'feishu-cs',
          alias: '客服飞书',
          provider: 'feishu',
          appId: 'cs-app',
        },
      ],
    );
    assert.equal(reloaded.defaultMode, 'yolo');
    assert.equal(reloaded.defaultProvider, 'sdk');
    assert.equal(reloaded.claudeExecutable, 'ccr');
    assert.equal(reloaded.claudeDefaultModel, 'claude-sonnet-test');
    assert.equal(reloaded.claudeIdleTimeoutMinutes, 15);
    assert.equal(reloaded.historyMessageLimit, 12);
    assert.equal(reloaded.streamStatusIdleStartSeconds, 240);
    assert.equal(reloaded.streamStatusCheckIntervalSeconds, 15);
    const savedToml = fs.readFileSync(path.join(path.dirname(CONFIG_JSON_PATH), 'config.toml'), 'utf-8');
    assert.match(savedToml, /yolo_mode = "on"/);
    assert.match(savedToml, /provider = "sdk"/);
    assert.match(savedToml, /executable = "ccr"/);
    assert.doesNotMatch(savedToml, /permission_mode/);
    assert.match(savedToml, /history_message_limit = 12/);
    assert.equal(fs.existsSync(CONFIG_PATH), false);
    assert.equal(fs.existsSync(CONFIG_JSON_PATH), false);
  });

  it('round-trips claude as the default runtime through home TOML', () => {
    const loaded = loadLegacyConfig();
    saveLegacyConfig({
      ...loaded,
      runtime: 'claude',
      claudeExecutable: 'ccr',
      claudeProvider: 'pty',
    });

    const reloaded = loadLegacyConfig();
    assert.equal(reloaded.runtime, 'claude');
    assert.equal(reloaded.claudeExecutable, 'ccr');
    assert.equal(reloaded.claudeProvider, 'pty');
    assert.equal(configToSettings(reloaded).get('bridge_default_runtime'), 'claude');
    assert.match(fs.readFileSync(path.join(path.dirname(CONFIG_JSON_PATH), 'config.toml'), 'utf-8'), /agent = "claude"/);
    assert.equal(fs.existsSync(CONFIG_PATH), false);
    assert.equal(fs.existsSync(CONFIG_JSON_PATH), false);
  });
});
