import '../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConfigService } from '../../../configuration/service.js';
import { loadStaticConfigBaseline, resolveConfigPaths } from '../../../configuration/sources.js';
import { exportRuntimeSettings } from '../../../runtime/config-projections.js';

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codelark-config-v2-'));
}

function writeFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf-8');
}

function firstChannel(service: ReturnType<typeof createConfigService>) {
  const channel = service.snapshot().config.channels[0];
  assert.ok(channel);
  return channel;
}

describe('ConfigService v2 foundation', () => {
  it('loads defaults.toml as the complete v2 shape', () => {
    const home = tempHome();
    try {
      const service = createConfigService({ codelarkHome: home, env: {} });
      const snapshot = service.snapshot();

      assert.equal(snapshot.config.schemaVersion, 2);
      assert.equal(snapshot.config.runtime.agent, 'codex');
      assert.equal(snapshot.config.runtime.codex.sandboxMode, 'workspace-write');
      assert.equal(snapshot.config.runtime.claude.provider, 'tmux');
      assert.equal(snapshot.config.bridge.defaultWorkspace, '~');
      assert.equal(snapshot.config.session.tmuxCaptureLines, 20);
      assert.equal(snapshot.config.channels[0]?.id, 'feishu-default');
      assert.equal(snapshot.config.channels[0]?.config.historyMessageLimit, 8);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('runs startup migrations before reading home TOML and then ignores legacy config.env', () => {
    const home = tempHome();
    try {
      writeFile(path.join(home, 'config.env'), [
        'CODELARK_ENABLED_CHANNELS=feishu',
        'CODELARK_CODEX_DEFAULT_MODEL=legacy-model',
        'CODELARK_FEISHU_APP_ID=legacy-app',
        'CODELARK_FEISHU_DOMAIN=lark',
      ].join('\n'));

      const service = createConfigService({
        codelarkHome: home,
        env: {},
        migrationNow: () => new Date('2026-06-06T15:00:00.000Z'),
      });

      assert.equal(service.migrationResult?.changed, true);
      assert.equal(service.migrationResult?.applied[0]?.id, 'v1');
      assert.equal(fs.existsSync(path.join(home, 'config.toml')), true);
      assert.equal(service.get('runtime.codex.model'), 'legacy-model');
      assert.equal(firstChannel(service).config.appId, 'legacy-app');
      assert.equal(firstChannel(service).config.site, 'lark');

      writeFile(path.join(home, 'config.env'), [
        'CODELARK_CODEX_DEFAULT_MODEL=must-not-be-read',
        'CODELARK_FEISHU_APP_ID=must-not-be-read',
      ].join('\n'));
      const afterEnvEdit = createConfigService({ codelarkHome: home, env: {} });
      assert.equal(afterEnvEdit.migrationResult?.changed, false);
      assert.equal(afterEnvEdit.get('runtime.codex.model'), 'legacy-model');
      assert.equal(firstChannel(afterEnvEdit).config.appId, 'legacy-app');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('can disable startup migrations for low-level source-chain tests', () => {
    const home = tempHome();
    try {
      writeFile(path.join(home, 'config.env'), 'CODELARK_CODEX_DEFAULT_MODEL=legacy-model\n');
      const service = createConfigService({ codelarkHome: home, env: {}, migrate: false });

      assert.equal(service.migrationResult, undefined);
      assert.equal(service.get('runtime.codex.model'), '');
      assert.equal(fs.existsSync(path.join(home, 'config.toml')), false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('ignores legacy Claude permission mode during startup migration', () => {
    const home = tempHome();
    try {
      writeFile(path.join(home, 'config.json'), JSON.stringify({
        schemaVersion: 1,
        runtime: {
          provider: 'claude',
          claude: {
            permissionMode: 'acceptEdits',
          },
        },
        channels: [],
      }));

      const service = createConfigService({ codelarkHome: home, env: {} });

      assert.equal(service.get('runtime.claude.yoloMode'), 'off');
      assert.equal(fs.existsSync(path.join(home, 'config.toml')), true);
      assert.doesNotMatch(fs.readFileSync(path.join(home, 'config.toml'), 'utf-8'), /permission_mode/);
      assert.equal(service.migrationResult?.applied[0]?.id, 'v1');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('merges home, local, env, cli, channel, session, and request in source-chain order', () => {
    const home = tempHome();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codelark-config-local-'));
    try {
      writeFile(path.join(home, 'config.toml'), `
[runtime.codex]
reasoning_effort = "low"
sandbox_mode = "read-only"
`);
      writeFile(path.join(cwd, '.codelark', 'config.toml'), `
[runtime.codex]
reasoning_effort = "medium"
`);
      writeFile(path.join(home, 'config', 'channels', 'ch-1.toml'), `
[runtime.codex]
reasoning_effort = "high"
`);
      writeFile(path.join(home, 'config', 'sessions', 's-1.toml'), `
[runtime.codex]
sandbox_mode = "danger-full-access"
`);

      const service = createConfigService({
        codelarkHome: home,
        env: { CODELARK_CODEX_REASONING_EFFORT: 'minimal' },
        cli: { runtime: { codex: { reasoningEffort: 'low' } } },
      });

      const scoped = { kind: 'session', sessionId: 's-1', channelId: 'ch-1', provider: 'feishu', cwd } as const;
      assert.equal(service.get('runtime.codex.reasoningEffort', scoped), 'high');
      assert.equal(service.resolve('runtime.codex.reasoningEffort', scoped).source, 'channel');
      assert.equal(service.get('runtime.codex.sandboxMode', scoped), 'danger-full-access');
      assert.equal(service.resolve('runtime.codex.sandboxMode', scoped).source, 'session');

      const requestValue = service.resolve(
        'runtime.codex.reasoningEffort',
        scoped,
        { runtime: { codex: { reasoningEffort: 'xhigh' } } },
      );
      assert.equal(requestValue.value, 'xhigh');
      assert.equal(requestValue.source, 'request');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('uses the service cwd as the local source for unscoped snapshots', () => {
    const home = tempHome();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codelark-config-local-default-'));
    const otherCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codelark-config-local-scope-'));
    try {
      writeFile(path.join(home, 'config.toml'), `
[runtime.codex]
model = "home-model"
reasoning_effort = "low"
`);
      writeFile(path.join(cwd, '.codelark', 'config.toml'), `
[runtime.codex]
model = "local-model"
`);
      writeFile(path.join(otherCwd, '.codelark.toml'), `
[runtime.codex]
model = "scoped-local-model"
`);

      const service = createConfigService({ codelarkHome: home, cwd, env: {}, migrate: false });

      assert.equal(service.get('runtime.codex.model'), 'local-model');
      assert.equal(service.resolve('runtime.codex.model').source, 'local');
      assert.equal(service.get('runtime.codex.reasoningEffort'), 'low');

      const scoped = { kind: 'local', cwd: otherCwd } as const;
      assert.equal(service.get('runtime.codex.model', scoped), 'scoped-local-model');
      assert.equal(service.resolve('runtime.codex.model', scoped).source, 'local');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(otherCwd, { recursive: true, force: true });
    }
  });

  it('supports deprecated env aliases while preferring new env keys', () => {
    const home = tempHome();
    try {
      const service = createConfigService({
        codelarkHome: home,
        env: {
          CODELARK_CODEX_DEFAULT_MODEL: 'legacy-model',
          CODELARK_CODEX_MODEL: 'new-model',
          CODELARK_FEISHU_DOMAIN: 'lark',
          CODELARK_ENABLED_CHANNELS: 'feishu',
        },
      });

      const snapshot = service.snapshot();
      assert.equal(snapshot.config.runtime.codex.model, 'new-model');
      assert.equal(snapshot.config.channels[0]?.enabled, false);
      assert.equal(snapshot.config.channels[0]?.config.site, 'feishu');
      assert.deepEqual(
        snapshot.warnings.map((warning) => warning.envKey).sort(),
        ['CODELARK_CODEX_DEFAULT_MODEL', 'CODELARK_ENABLED_CHANNELS', 'CODELARK_FEISHU_DOMAIN'],
      );
      assert.match(
        snapshot.warnings.find((warning) => warning.envKey === 'CODELARK_FEISHU_DOMAIN')?.message || '',
        /只用于导出给子进程/,
      );
      assert.equal(service.resolve('runtime.codex.model').env, 'CODELARK_CODEX_MODEL');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('keeps channels home-only and warns when local channel definitions are ignored', () => {
    const home = tempHome();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codelark-config-local-'));
    try {
      const service = createConfigService({
        codelarkHome: home,
        env: {
          CODELARK_FEISHU_APP_ID: 'env-app',
          CODELARK_ENABLED_CHANNELS: '',
        },
        cli: {
          channels: [{ id: 'feishu-default', config: { appId: 'cli-app' } }],
        },
        migrate: false,
      });

      assert.throws(
        () => service.snapshot(),
        /配置来源 cli 不能定义 channels/,
      );

      const noCli = createConfigService({
        codelarkHome: home,
        env: {
          CODELARK_FEISHU_APP_ID: 'env-app',
          CODELARK_ENABLED_CHANNELS: '',
        },
        migrate: false,
      });
      assert.equal(firstChannel(noCli).config.appId, '');
      assert.equal(firstChannel(noCli).enabled, false);

      writeFile(path.join(cwd, '.codelark', 'config.toml'), `
[[channels]]
id = "feishu-default"
provider = "feishu"
`);
      const localSnapshot = noCli.snapshot({ kind: 'local', cwd });
      assert.equal(localSnapshot.config.channels[0]?.id, 'feishu-default');
      assert.equal(localSnapshot.config.channels[0]?.enabled, false);
      assert.equal(
        localSnapshot.warnings.find((warning) => warning.source === 'local' && warning.path === 'channels')?.message,
        `项目级配置 ${path.join(cwd, '.codelark', 'config.toml')} 中的 channels 不会生效；通道配置只能写入 ~/.codelark/config.toml，已忽略该字段。`,
      );

      writeFile(path.join(home, 'config', 'channels', 'feishu-default.toml'), `
[[channels]]
id = "feishu-default"
provider = "feishu"
`);
      assert.throws(
        () => noCli.snapshot({ kind: 'channel', channelId: 'feishu-default', provider: 'feishu' }),
        /配置来源 channel 不能定义 channels/,
      );

      writeFile(path.join(home, 'config', 'sessions', 's-1.toml'), `
[[channels]]
id = "feishu-default"
provider = "feishu"
`);
      assert.throws(
        () => noCli.snapshot({ kind: 'session', sessionId: 's-1', channelId: 'feishu-default', provider: 'feishu' }),
        /配置来源 channel 不能定义 channels/,
      );

      fs.rmSync(path.join(home, 'config', 'channels', 'feishu-default.toml'), { force: true });
      assert.throws(
        () => noCli.snapshot(
          { kind: 'session', sessionId: 's-1', channelId: 'feishu-default', provider: 'feishu' },
        ),
        /配置来源 session 不能定义 channels/,
      );

      assert.throws(
        () => noCli.snapshot(undefined, {
          channels: [{ id: 'feishu-default', config: { appId: 'request-app' } }],
        }),
        /配置来源 request 不能定义 channels/,
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('replaces default channels with the home channel list', () => {
    const home = tempHome();
    try {
      writeFile(path.join(home, 'config.toml'), `
[[channels]]
id = "feishu-home"
alias = "Home"
provider = "feishu"
enabled = true

[channels.config]
history_message_limit = 12
stream_status_idle_start_seconds = 180
stream_status_check_interval_seconds = 10
app_id = "home-app"
app_secret = "home-secret"
site = "lark"
allowed_users = []
streaming_enabled = true
feedback_markdown_enabled = true
require_mention = false
`);

      const service = createConfigService({ codelarkHome: home, env: {}, migrate: false });
      const channels = service.snapshot().config.channels;
      assert.deepEqual(channels.map((channel) => channel.id), ['feishu-home']);
      assert.equal(channels[0]?.config.appId, 'home-app');
      assert.equal(service.snapshot().provenance.get('channels.feishu-home.config.appId')?.source, 'home');
      assert.throws(
        () => service.get('channels[].config.appId'),
        /字段模板，不是具体值路径/,
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('materializes partial home channels from defaults.toml and writes them back', () => {
    const home = tempHome();
    const configTomlPath = path.join(home, 'config.toml');
    try {
      writeFile(configTomlPath, `
[[channels]]
id = "feishu-home"
provider = "feishu"

[channels.config]
app_id = "home-app"
`);

      const service = createConfigService({ codelarkHome: home, env: {}, migrate: false });
      const channel = service.snapshot().config.channels[0]!;
      assert.equal(channel.id, 'feishu-home');
      assert.equal(channel.alias, '飞书');
      assert.equal(channel.enabled, false);
      assert.equal(channel.config.appId, 'home-app');
      assert.equal(channel.config.historyMessageLimit, 8);
      assert.equal(channel.config.streamStatusIdleStartSeconds, 180);
      assert.equal(channel.config.site, 'feishu');

      const savedToml = fs.readFileSync(configTomlPath, 'utf-8');
      assert.match(savedToml, /alias = "飞书"/);
      assert.match(savedToml, /history_message_limit = 8/);
      assert.match(savedToml, /app_id = "home-app"/);
      assert.match(savedToml, /streaming_enabled = true/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('keeps static node-config loading side-effect free and lets the service write back materialized home channels', () => {
    const home = tempHome();
    const configTomlPath = path.join(home, 'config.toml');
    try {
      writeFile(configTomlPath, `
[[channels]]
id = "feishu-home"
provider = "feishu"

[channels.config]
app_id = "home-app"
`);

      const baseline = loadStaticConfigBaseline(resolveConfigPaths({ codelarkHome: home }), {}, undefined);
      assert.equal(baseline.layer.patch.channels?.[0]?.config?.historyMessageLimit, 8);
      assert.equal(baseline.homeWriteback?.file, configTomlPath);
      assert.doesNotMatch(fs.readFileSync(configTomlPath, 'utf-8'), /history_message_limit = 8/);

      const service = createConfigService({ codelarkHome: home, env: {}, migrate: false });
      assert.equal(firstChannel(service).config.historyMessageLimit, 8);
      assert.match(fs.readFileSync(configTomlPath, 'utf-8'), /history_message_limit = 8/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('explains values with source provenance and masks secret fields by default', () => {
    const home = tempHome();
    try {
      writeFile(path.join(home, 'config.toml'), `
[bridge]
ui_access_token = "home-secret-token"

[[channels]]
id = "feishu-default"
alias = "飞书"
provider = "feishu"
enabled = true

[channels.config]
history_message_limit = 8
stream_status_idle_start_seconds = 180
stream_status_check_interval_seconds = 10
app_id = ""
app_secret = "home-app-secret"
site = "feishu"
allowed_users = []
streaming_enabled = true
feedback_markdown_enabled = true
require_mention = false
`);
      const service = createConfigService({
        codelarkHome: home,
        env: {
          CODELARK_UI_ACCESS_TOKEN: 'env-secret-token',
          CODELARK_CODEX_REASONING_EFFORT: 'high',
        },
      });

      assert.equal(service.resolve('bridge.uiAccessToken').value, 'env-secret-token');

      const tokenExplain = service.explain('bridge.uiAccessToken')[0]!;
      assert.equal(tokenExplain.secret, true);
      assert.equal(tokenExplain.value, '************oken');
      assert.equal(tokenExplain.source, 'env');
      assert.equal(tokenExplain.env, 'CODELARK_UI_ACCESS_TOKEN');

      const effortExplain = service.explain('runtime.codex.reasoningEffort')[0]!;
      assert.equal(effortExplain.secret, undefined);
      assert.equal(effortExplain.value, 'high');
      assert.equal(effortExplain.source, 'env');

      assert.throws(
        () => service.explain('channels[].config.appSecret'),
        /字段模板，不是具体值路径/,
      );
      assert.equal(firstChannel(service).config.appSecret, 'home-app-secret');
      assert.equal(service.snapshot().provenance.get('channels.feishu-default.config.appSecret')?.source, 'home');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('writes, replaces, and unsets TOML through the service API', () => {
    const home = tempHome();
    try {
      const service = createConfigService({ codelarkHome: home, env: {} });
      service.set({ kind: 'home' }, {
        runtime: { codex: { reasoningEffort: 'high' } },
        bridge: { uiAllowLan: true },
      });

      assert.equal(service.get('runtime.codex.reasoningEffort'), 'high');
      assert.equal(service.get('bridge.uiAllowLan'), true);
      assert.match(fs.readFileSync(path.join(home, 'config.toml'), 'utf-8'), /reasoning_effort = "high"/);

      service.unset({ kind: 'home' }, 'runtime.codex.reasoningEffort');
      assert.equal(service.get('runtime.codex.reasoningEffort'), 'medium');

      service.replace({ kind: 'home' }, {
        schemaVersion: 2,
        runtime: { agent: 'claude' },
        channels: [{
          id: 'feishu-default',
          alias: '飞书',
          provider: 'feishu',
          enabled: true,
          config: { historyMessageLimit: 12 },
        }],
      });
      assert.equal(service.get('runtime.agent'), 'claude');
      assert.equal(firstChannel(service).config.historyMessageLimit, 12);
      assert.equal(service.get('bridge.uiAllowLan'), false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('keeps write targets bound to the service CODELARK_HOME snapshot', () => {
    const home = tempHome();
    const otherHome = tempHome();
    const previousHome = process.env.CODELARK_HOME;
    try {
      process.env.CODELARK_HOME = home;
      const service = createConfigService({ env: {}, migrate: false });
      process.env.CODELARK_HOME = otherHome;

      service.set({ kind: 'home' }, {
        runtime: { codex: { model: 'stable-home-model' } },
      });

      assert.equal(service.get('runtime.codex.model'), 'stable-home-model');
      assert.match(fs.readFileSync(path.join(home, 'config.toml'), 'utf-8'), /model = "stable-home-model"/);
      assert.equal(fs.existsSync(path.join(otherHome, 'config.toml')), false);
    } finally {
      if (previousHome === undefined) {
        delete process.env.CODELARK_HOME;
      } else {
        process.env.CODELARK_HOME = previousHome;
      }
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(otherHome, { recursive: true, force: true });
    }
  });

  it('enforces field write scopes for set and unset operations', () => {
    const home = tempHome();
    try {
      const service = createConfigService({ codelarkHome: home, env: {} });

      service.set(
        { kind: 'channel', channelId: 'chat-1', provider: 'feishu' },
        { runtime: { codex: { reasoningEffort: 'high' } } },
      );
      assert.equal(
        service.get('runtime.codex.reasoningEffort', { kind: 'channel', channelId: 'chat-1', provider: 'feishu' }),
        'high',
      );

      assert.throws(
        () => service.set(
          { kind: 'session', sessionId: 's-1' },
          { bridge: { uiAllowLan: true } },
        ),
        /bridge\.uiAllowLan 不能写入 session 作用域/,
      );
      assert.throws(
        () => service.set(
          { kind: 'channel', channelId: 'chat-1', provider: 'feishu' },
          { channels: [{ id: 'feishu-default', config: { appSecret: 'secret' } }] },
        ),
        /channels\[\]\.config\.appSecret 不能写入 channel 作用域/,
      );
      assert.throws(
        () => service.unset({ kind: 'session', sessionId: 's-1' }, 'bridge.uiAllowLan'),
        /bridge\.uiAllowLan 不能写入 session 作用域/,
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('projects effective config to legacy runtime settings maps', () => {
    const home = tempHome();
    try {
      writeFile(path.join(home, 'config.toml'), `
[[channels]]
id = "feishu-default"
alias = "飞书"
provider = "feishu"
enabled = true

[channels.config]
history_message_limit = 8
stream_status_idle_start_seconds = 180
stream_status_check_interval_seconds = 10
app_id = "home-app"
app_secret = "home-secret"
site = "feishu"
allowed_users = []
streaming_enabled = true
feedback_markdown_enabled = true
require_mention = false
`);
      const service = createConfigService({
        codelarkHome: home,
        env: {
          CODELARK_AGENT: 'claude',
          CODELARK_CODEX_MODEL: 'gpt-test',
          CODELARK_FEISHU_APP_ID: 'env-app',
          CODELARK_FEISHU_APP_SECRET: 'env-secret',
          CODELARK_ENABLED_CHANNELS: '',
        },
      });


      const settings = exportRuntimeSettings(service.snapshot().config);
      assert.equal(settings.get('bridge_default_runtime'), 'claude');
      assert.equal(settings.get('bridge_default_model'), 'gpt-test');
      assert.equal(settings.get('default_model'), 'gpt-test');
      assert.equal(settings.get('bridge_feishu_app_secret'), 'home-secret');
      assert.equal(settings.get('bridge_feishu_enabled'), 'true');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('projects v2 modes to legacy runtime setting values without Claude permission mode', () => {
    const home = tempHome();
    try {
      writeFile(path.join(home, 'config.toml'), `
[runtime.codex]
yolo_mode = "on"

[runtime.claude]
yolo_mode = "on"
`);
      const service = createConfigService({ codelarkHome: home, env: {} });
      let settings = exportRuntimeSettings(service.snapshot().config);
      assert.equal(settings.get('bridge_default_mode'), 'yolo');
      assert.equal(settings.has('bridge_claude_permission_mode'), false);

      service.set({ kind: 'home' }, {
        runtime: {
          codex: { yoloMode: 'off' },
          claude: { yoloMode: 'off' },
        },
      });
      settings = exportRuntimeSettings(service.snapshot().config);
      assert.equal(settings.get('bridge_default_mode'), 'normal');
      assert.equal(settings.has('bridge_claude_permission_mode'), false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
