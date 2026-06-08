import '../../setup/test-setup.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CONFIG_PATH,
  CONFIG_JSON_PATH,
  loadConfig,
  maskSecret,
  saveConfig,
  configToSettings,
  type Config,
} from '../../../configuration/index.js';

describe('maskSecret', () => {
  it('masks short values and preserves the last four characters for longer values', () => {
    assert.equal(maskSecret(''), '****');
    assert.equal(maskSecret('abc'), '****');
    assert.equal(maskSecret('abcd'), '****');
    assert.equal(maskSecret('12345'), '*2345');
    assert.equal(maskSecret('12345678'), '****5678');
    assert.equal(maskSecret('secret-token-abcd'), '*************abcd');
  });
});

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
    assert.equal(m.get('remote_bridge_enabled'), 'true');
    assert.equal(m.has('bridge_default_model'), false);
    assert.equal(m.has('default_model'), false);
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

  it('omits optional fields when not set', () => {
    const m = configToSettings(base);
    assert.equal(m.has('bridge_feishu_app_id'), false);
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

// ── Config file parsing (loadConfig/saveConfig round-trip) ──

describe('loadConfig/saveConfig round-trip', () => {
  let tmpDir: string;
  let origHome: string;
  let configBackup: string | null;
  let configBackupJson: string | null;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-config-test-'));
    origHome = process.env.HOME || '';
    configBackup = fs.existsSync(CONFIG_PATH) ? fs.readFileSync(CONFIG_PATH, 'utf-8') : null;
    configBackupJson = fs.existsSync(CONFIG_JSON_PATH) ? fs.readFileSync(CONFIG_JSON_PATH, 'utf-8') : null;
    fs.rmSync(CONFIG_PATH, { force: true });
    fs.rmSync(CONFIG_JSON_PATH, { force: true });
  });

  afterEach(() => {
    process.env.HOME = origHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(CONFIG_PATH, { force: true });
    fs.rmSync(CONFIG_JSON_PATH, { force: true });
    if (configBackup !== null) {
      fs.writeFileSync(CONFIG_PATH, configBackup);
    }
    if (configBackupJson !== null) {
      fs.writeFileSync(CONFIG_JSON_PATH, configBackupJson);
    }
  });

  it('configToSettings returns correct defaults', () => {
    const m = configToSettings({
      runtime: 'codex',
      channels: [],
      enabledChannels: [],
      defaultMode: 'normal',
    });
    assert.equal(m.get('bridge_feishu_enabled'), 'false');
  });

  it('migrates legacy env config into config.json default channel instances', () => {
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

    const loaded = loadConfig();
    assert.equal(loaded.schemaVersion, 1);
    assert.ok(fs.existsSync(CONFIG_JSON_PATH));
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

  it('accepts CODELARK config.env aliases while preserving CODELARK precedence', () => {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(
      CONFIG_PATH,
      [
        'CODELARK_RUNTIME=claude',
        'CODELARK_RUNTIME=codex',
        'CODELARK_ENABLED_CHANNELS=feishu',
        'CODELARK_FEISHU_APP_ID=alias-app',
        'CODELARK_FEISHU_APP_SECRET=alias-secret',
        'CODELARK_FEISHU_SITE=lark',
        'CODELARK_CODEX_DEFAULT_MODEL=alias-model',
        'CODELARK_DEFAULT_CODEX_PROVIDER=tmux',
        'CODELARK_HISTORY_MESSAGE_LIMIT=13',
      ].join('\n'),
    );

    const loaded = loadConfig();
    assert.equal(loaded.runtime, 'codex');
    assert.equal(loaded.defaultModel, 'alias-model');
    assert.equal(loaded.defaultProvider, 'tmux');
    assert.equal(loaded.historyMessageLimit, 13);
    assert.deepEqual(
      loaded.channels?.map((channel) => ({
        id: channel.id,
        enabled: channel.enabled,
        appId: (channel.config as { appId?: string }).appId,
        appSecret: (channel.config as { appSecret?: string }).appSecret,
        site: (channel.config as { site?: string }).site,
      })),
      [
        {
          id: 'feishu-default',
          enabled: true,
          appId: 'alias-app',
          appSecret: 'alias-secret',
          site: 'lark',
        },
      ],
    );
  });

  it('applies a newer config.env overlay and imports unmatched channel config as a new channel', () => {
    fs.mkdirSync(path.dirname(CONFIG_JSON_PATH), { recursive: true });
    fs.writeFileSync(
      CONFIG_JSON_PATH,
      JSON.stringify({
        schemaVersion: 1,
        runtime: {
          provider: 'codex',
          codex: {
            defaultModel: 'old-model',
            defaultMode: 'normal',
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
    fs.writeFileSync(
      CONFIG_PATH,
      [
        'CODELARK_CODEX_DEFAULT_MODEL=new-model',
        'CODELARK_DEFAULT_CODEX_PROVIDER=tmux',
        'CODELARK_HISTORY_MESSAGE_LIMIT=15',
        'CODELARK_CODEX_SANDBOX_MODE=danger-full-access',
        'CODELARK_FEISHU_APP_ID=env-app',
      ].join('\n'),
    );
    const past = new Date(Date.now() - 10_000);
    const future = new Date(Date.now() + 10_000);
    fs.utimesSync(CONFIG_JSON_PATH, past, past);
    fs.utimesSync(CONFIG_PATH, future, future);

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown) => {
      warnings.push(String(message));
    };
    let loaded: Config;
    try {
      loaded = loadConfig();
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(loaded.defaultModel, 'new-model');
    assert.equal(loaded.defaultProvider, 'tmux');
    assert.equal(loaded.historyMessageLimit, 15);
    assert.equal(loaded.codexSandboxMode, 'danger-full-access');
    assert.deepEqual(
      loaded.channels?.map((channel) => ({
        id: channel.id,
        enabled: channel.enabled,
        appId: (channel.config as { appId?: string }).appId,
      })),
      [
        { id: 'feishu-rd', enabled: true, appId: 'old-app' },
        { id: 'feishu-cs', enabled: false, appId: 'cs-app' },
        { id: 'feishu-env', enabled: false, appId: 'env-app' },
      ],
    );
    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /没有匹配到现有通道/);
    assert.match(warnings[0], /feishu-env/);
    assert.match(warnings[1], /config\.env 已更新/);
    assert.match(warnings[1], /config\.json/);

    const persisted = JSON.parse(fs.readFileSync(CONFIG_JSON_PATH, 'utf-8')) as any;
    assert.equal('defaultModel' in persisted.runtime, false);
    assert.equal(persisted.runtime.codex.defaultModel, 'new-model');
    assert.equal('defaultProvider' in persisted.runtime, false);
    assert.equal(persisted.runtime.bridgeControl.defaultCodexProvider, 'tmux');
    assert.equal(persisted.runtime.bridge.historyMessageLimit, 15);
    assert.equal(persisted.runtime.codex.sandboxMode, 'danger-full-access');
    assert.equal('showToolCallDetails' in persisted.runtime, false);
    assert.equal('showToolCallDetails' in persisted.runtime.bridge, false);
    assert.equal(persisted.channels[0].config.appId, 'old-app');
    assert.equal(persisted.channels[2].config.appId, 'env-app');
  });

  it('applies a newer config.env overlay over grouped runtime config', () => {
    fs.mkdirSync(path.dirname(CONFIG_JSON_PATH), { recursive: true });
    fs.writeFileSync(
      CONFIG_JSON_PATH,
      JSON.stringify({
        schemaVersion: 1,
        runtime: {
          provider: 'codex',
          codex: {
            defaultModel: 'nested-old-model',
            defaultMode: 'normal',
            sandboxMode: 'workspace-write',
            networkAccess: true,
            reasoningEffort: 'medium',
          },
          bridgeControl: {
            defaultCodexProvider: 'sdk',
          },
          bridge: {
            historyMessageLimit: 8,
          },
        },
        channels: [],
      }, null, 2),
    );
    fs.writeFileSync(
      CONFIG_PATH,
      [
        'CODELARK_CODEX_DEFAULT_MODEL=env-model',
        'CODELARK_DEFAULT_CODEX_PROVIDER=tmux',
        'CODELARK_CODEX_DEFAULT_MODE=yolo',
        'CODELARK_HISTORY_MESSAGE_LIMIT=16',
        'CODELARK_CODEX_SANDBOX_MODE=danger-full-access',
        'CODELARK_CODEX_NETWORK_ACCESS=false',
        'CODELARK_CODEX_REASONING_EFFORT=high',
      ].join('\n'),
    );
    const past = new Date(Date.now() - 10_000);
    const future = new Date(Date.now() + 10_000);
    fs.utimesSync(CONFIG_JSON_PATH, past, past);
    fs.utimesSync(CONFIG_PATH, future, future);

    const loaded = loadConfig();
    assert.equal(loaded.defaultModel, 'env-model');
    assert.equal(loaded.defaultProvider, 'tmux');
    assert.equal(loaded.defaultMode, 'yolo');
    assert.equal(loaded.historyMessageLimit, 16);
    assert.equal(loaded.codexSandboxMode, 'danger-full-access');
    assert.equal(loaded.codexNetworkAccess, false);
    assert.equal(loaded.codexReasoningEffort, 'high');

    const persisted = JSON.parse(fs.readFileSync(CONFIG_JSON_PATH, 'utf-8')) as any;
    assert.equal(persisted.runtime.codex.defaultModel, 'env-model');
    assert.equal(persisted.runtime.codex.defaultMode, 'yolo');
    assert.equal(persisted.runtime.codex.sandboxMode, 'danger-full-access');
    assert.equal(persisted.runtime.codex.networkAccess, false);
    assert.equal(persisted.runtime.codex.reasoningEffort, 'high');
    assert.equal(persisted.runtime.bridgeControl.defaultCodexProvider, 'tmux');
    assert.equal(persisted.runtime.bridge.historyMessageLimit, 16);
    assert.equal('showToolCallDetails' in persisted.runtime.bridge, false);
  });

  it('updates an existing channel when config.env matches its channel identity', () => {
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
              appId: 'same-app',
              appSecret: 'old-secret',
            },
          },
        ],
      }, null, 2),
    );
    fs.writeFileSync(
      CONFIG_PATH,
      [
        'CODELARK_FEISHU_APP_ID=same-app',
        'CODELARK_FEISHU_APP_SECRET=new-secret',
      ].join('\n'),
    );
    const past = new Date(Date.now() - 10_000);
    const future = new Date(Date.now() + 10_000);
    fs.utimesSync(CONFIG_JSON_PATH, past, past);
    fs.utimesSync(CONFIG_PATH, future, future);

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown) => {
      warnings.push(String(message));
    };
    let loaded: Config;
    try {
      loaded = loadConfig();
    } finally {
      console.warn = originalWarn;
    }
    assert.deepEqual(
      loaded.channels?.map((channel) => ({
        id: channel.id,
        appId: (channel.config as { appId?: string }).appId,
        appSecret: (channel.config as { appSecret?: string }).appSecret,
      })),
      [
        { id: 'feishu-rd', appId: 'same-app', appSecret: 'new-secret' },
      ],
    );
    assert.deepEqual(warnings, ['[CodeLark] 检测到 config.env 已更新，已同步写入 config.json。']);
  });

  it('ignores a newer config.env when it still matches the generated snapshot', () => {
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
    saveConfig(config);
    const future = new Date(Date.now() + 10_000);
    fs.utimesSync(CONFIG_PATH, future, future);

    const loaded = loadConfig();
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

  it('filters unsupported providers from config.json on load', () => {
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
        },
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
          },
        ],
      }, null, 2),
    );

    const loaded = loadConfig();
    assert.deepEqual(loaded.channels?.map((channel) => channel.provider), ['feishu']);
    assert.deepEqual(loaded.enabledChannels, ['feishu']);
  });

  it('preserves custom channel instances when saving runtime settings', () => {
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

    const loaded = loadConfig();
    saveConfig({
      ...loaded,
      defaultMode: 'yolo',
      defaultProvider: 'sdk',
      claudeExecutable: 'ccr',
      claudeDefaultModel: 'claude-sonnet-test',
      claudePermissionMode: 'acceptEdits',
      claudeReasoningEffort: 'max',
      claudeIdleTimeoutMinutes: 15,
      historyMessageLimit: 12,
      streamStatusIdleStartSeconds: 240,
      streamStatusCheckIntervalSeconds: 15,
    });

    const reloaded = loadConfig();
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
    assert.equal(reloaded.claudePermissionMode, 'acceptEdits');
    assert.equal(reloaded.claudeReasoningEffort, 'max');
    assert.equal(reloaded.claudeIdleTimeoutMinutes, 15);
    assert.equal(reloaded.historyMessageLimit, 12);
    assert.equal(reloaded.streamStatusIdleStartSeconds, 240);
    assert.equal(reloaded.streamStatusCheckIntervalSeconds, 15);
    assert.doesNotMatch(fs.readFileSync(CONFIG_PATH, 'utf-8'), /CODELARK_SHOW_TOOL_CALL_DETAILS/);
    assert.match(fs.readFileSync(CONFIG_PATH, 'utf-8'), /CODELARK_DEFAULT_CODEX_PROVIDER=sdk/);
    assert.match(fs.readFileSync(CONFIG_PATH, 'utf-8'), /CODELARK_CLAUDE_EXECUTABLE=ccr/);
    assert.match(fs.readFileSync(CONFIG_PATH, 'utf-8'), /CODELARK_CLAUDE_REASONING_EFFORT=max/);
    const persisted = JSON.parse(fs.readFileSync(CONFIG_JSON_PATH, 'utf-8')) as any;
    assert.equal(persisted.runtime.codex.defaultMode, 'yolo');
    assert.equal(persisted.runtime.bridgeControl.defaultCodexProvider, 'sdk');
    assert.equal(persisted.runtime.claude.executable, 'ccr');
    assert.equal(persisted.runtime.claude.defaultModel, 'claude-sonnet-test');
    assert.equal(persisted.runtime.claude.permissionMode, 'acceptEdits');
    assert.equal(persisted.runtime.claude.reasoningEffort, 'max');
    assert.equal(persisted.runtime.bridge.historyMessageLimit, 12);
  });

  it('updates managed config.env keys while preserving custom env lines', () => {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(
      CONFIG_PATH,
      [
        '# local shell override',
        'CUSTOM_KEEP=1',
        'CODELARK_RUNTIME=claude',
        'CODELARK_FEISHU_APP_ID=old-app',
        'CODELARK_FEISHU_APP_SECRET=old-secret',
        'CODELARK_FEISHU_DOMAIN=lark',
        'CODELARK_FEISHU_ALLOWED_USERS=old-user',
        'CODELARK_RUNTIME=claude',
        'CODELARK_FEISHU_APP_ID=alias-old-app',
        'CODELARK_FEISHU_ALLOWED_USERS=alias-old-user',
      ].join('\n') + '\n',
    );

    saveConfig({
      runtime: 'codex',
      defaultMode: 'normal',
      enabledChannels: ['feishu'],
      channels: [
        {
          id: 'feishu-default',
          alias: '飞书',
          provider: 'feishu',
          enabled: true,
          createdAt: '2026-03-28T00:00:00.000Z',
          updatedAt: '2026-03-28T00:00:00.000Z',
          config: {
            appId: 'new-app',
            appSecret: 'new-secret',
            site: 'feishu',
          },
        },
      ],
    });

    const saved = fs.readFileSync(CONFIG_PATH, 'utf-8');
    assert.match(saved, /^# local shell override$/m);
    assert.match(saved, /^CUSTOM_KEEP=1$/m);
    assert.match(saved, /^CODELARK_RUNTIME=codex$/m);
    assert.match(saved, /^CODELARK_FEISHU_APP_ID=new-app$/m);
    assert.match(saved, /^CODELARK_FEISHU_APP_SECRET=new-secret$/m);
    assert.match(saved, /^CODELARK_FEISHU_SITE=feishu$/m);
    assert.doesNotMatch(saved, /^CODELARK_FEISHU_DOMAIN=/m);
    assert.doesNotMatch(saved, /^CODELARK_FEISHU_ALLOWED_USERS=/m);
    assert.equal(saved.match(/^CODELARK_RUNTIME=/gm)?.length, 1);
    assert.equal(saved.match(/^CODELARK_FEISHU_APP_ID=/gm)?.length, 1);
  });

  it('round-trips claude as the default runtime through config.v1 and config.env', () => {
    const loaded = loadConfig();
    saveConfig({
      ...loaded,
      runtime: 'claude',
      claudeExecutable: 'ccr',
      claudeProvider: 'tmux',
      claudeReasoningEffort: 'high',
    });

    const reloaded = loadConfig();
    assert.equal(reloaded.runtime, 'claude');
    assert.equal(reloaded.claudeExecutable, 'ccr');
    assert.equal(reloaded.claudeProvider, 'tmux');
    assert.equal(reloaded.claudeReasoningEffort, 'high');
    assert.match(fs.readFileSync(CONFIG_PATH, 'utf-8'), /CODELARK_RUNTIME=claude/);
    assert.equal(configToSettings(reloaded).get('bridge_default_runtime'), 'claude');
    assert.equal(configToSettings(reloaded).get('bridge_claude_provider'), 'tmux');
    assert.equal(configToSettings(reloaded).get('bridge_claude_reasoning_effort'), 'high');
    const persisted = JSON.parse(fs.readFileSync(CONFIG_JSON_PATH, 'utf-8')) as any;
    assert.equal(persisted.runtime.provider, 'claude');
  });
});
