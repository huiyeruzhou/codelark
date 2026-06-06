import '../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConfigService } from '../../../configuration/service.js';

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codelark-config-v2-'));
}

function writeFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf-8');
}

describe('ConfigService v2 foundation', () => {
  it('loads defaults.toml as the complete v2 shape', () => {
    const home = tempHome();
    try {
      const service = createConfigService({ codelarkHome: home, env: {} });
      const snapshot = service.snapshot();

      assert.equal(snapshot.config.schemaVersion, 2);
      assert.equal(snapshot.config.runtime.provider, 'codex');
      assert.equal(snapshot.config.runtime.codex.sandboxMode, 'workspace-write');
      assert.equal(snapshot.config.runtime.claude.provider, 'sdk');
      assert.equal(snapshot.config.bridge.defaultWorkspace, '~');
      assert.equal(snapshot.config.session.tmuxCaptureLines, 80);
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
      assert.equal(service.get('channels[].config.appId'), 'legacy-app');
      assert.equal(service.get('channels[].config.site'), 'lark');

      writeFile(path.join(home, 'config.env'), [
        'CODELARK_CODEX_DEFAULT_MODEL=must-not-be-read',
        'CODELARK_FEISHU_APP_ID=must-not-be-read',
      ].join('\n'));
      const afterEnvEdit = createConfigService({ codelarkHome: home, env: {} });
      assert.equal(afterEnvEdit.migrationResult?.changed, false);
      assert.equal(afterEnvEdit.get('runtime.codex.model'), 'legacy-model');
      assert.equal(afterEnvEdit.get('channels[].config.appId'), 'legacy-app');
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

  it('fails startup migration without writing state when legacy fallback needs confirmation', () => {
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

      assert.throws(
        () => createConfigService({ codelarkHome: home, env: {} }),
        /Cannot migrate legacy Claude permissionMode=acceptEdits/,
      );
      assert.equal(fs.existsSync(path.join(home, 'config.toml')), false);
      assert.equal(fs.existsSync(path.join(home, 'runtime', 'config-migrations.json')), false);
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
      assert.equal(snapshot.config.channels[0]?.enabled, true);
      assert.equal(snapshot.config.channels[0]?.config.site, 'lark');
      assert.deepEqual(
        snapshot.warnings.map((warning) => warning.envKey).sort(),
        ['CODELARK_CODEX_DEFAULT_MODEL', 'CODELARK_FEISHU_DOMAIN'],
      );
      assert.equal(service.resolve('runtime.codex.model').env, 'CODELARK_CODEX_MODEL');
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
app_secret = "home-app-secret"
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

      const appSecretExplain = service.explain('channels[].config.appSecret')[0]!;
      assert.equal(appSecretExplain.secret, true);
      assert.equal(appSecretExplain.value, '***********cret');
      assert.equal(appSecretExplain.source, 'home');
      assert.equal(appSecretExplain.file, path.join(home, 'config.toml'));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('writes and unsets TOML partials through the service API', () => {
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
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
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
        /bridge\.uiAllowLan cannot be written to session scope/,
      );
      assert.throws(
        () => service.set(
          { kind: 'channel', channelId: 'chat-1', provider: 'feishu' },
          { channels: [{ id: 'feishu-default', config: { appSecret: 'secret' } }] },
        ),
        /channels\[\]\.config\.appSecret cannot be written to channel scope/,
      );
      assert.throws(
        () => service.unset({ kind: 'session', sessionId: 's-1' }, 'bridge.uiAllowLan'),
        /bridge\.uiAllowLan cannot be written to session scope/,
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('projects effective config to process env and legacy runtime settings maps', () => {
    const home = tempHome();
    try {
      const service = createConfigService({
        codelarkHome: home,
        env: {
          CODELARK_RUNTIME: 'claude',
          CODELARK_CODEX_MODEL: 'gpt-test',
          CODELARK_FEISHU_APP_ID: 'app-id',
          CODELARK_FEISHU_APP_SECRET: 'secret',
          CODELARK_ENABLED_CHANNELS: 'feishu',
        },
      });

      const env = service.exportProcessEnv();
      assert.equal(env.CODELARK_RUNTIME, 'claude');
      assert.equal(env.CODELARK_CODEX_MODEL, 'gpt-test');
      assert.equal(env.CODELARK_FEISHU_APP_ID, 'app-id');
      assert.equal(env.CODELARK_ENABLED_CHANNELS, 'feishu');

      const settings = service.exportRuntimeSettings();
      assert.equal(settings.get('bridge_default_runtime'), 'claude');
      assert.equal(settings.get('bridge_default_model'), 'gpt-test');
      assert.equal(settings.get('default_model'), 'gpt-test');
      assert.equal(settings.get('bridge_feishu_app_secret'), 'secret');
      assert.equal(settings.get('bridge_feishu_enabled'), 'true');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('projects v2 yolo modes to legacy runtime setting values', () => {
    const home = tempHome();
    try {
      writeFile(path.join(home, 'config.toml'), `
[runtime.codex]
yolo_mode = "on"

[runtime.claude]
yolo_mode = "off"
`);
      const service = createConfigService({ codelarkHome: home, env: {} });
      let settings = service.exportRuntimeSettings();
      assert.equal(settings.get('bridge_default_mode'), 'yolo');
      assert.equal(settings.get('bridge_claude_permission_mode'), 'default');

      service.set({ kind: 'home' }, {
        runtime: {
          codex: { yoloMode: 'off' },
          claude: { yoloMode: 'on' },
        },
      });
      settings = service.exportRuntimeSettings();
      assert.equal(settings.get('bridge_default_mode'), 'normal');
      assert.equal(settings.get('bridge_claude_permission_mode'), 'bypassPermissions');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
