import '../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  _testOnly,
  buildDeferredGlobalNpmUninstallLaunch,
  installCodexIntegration,
  isCodexIntegrationInstalled,
} from '../../../local-service/manager.js';
import { tryAcquireBridgeInstanceLock } from '../../../local-service/instance-lock.js';
import type { Config } from '../../../configuration/legacy-types.js';

describe('buildDeferredGlobalNpmUninstallLaunch', () => {
  it('uses npm.cmd on Windows launchers', () => {
    const launch = buildDeferredGlobalNpmUninstallLaunch({
      platform: 'win32',
      nodePath: 'C:\\Program Files\\nodejs\\node.exe',
      logPath: 'C:\\Users\\tester\\.codelark\\runtime\\npm-uninstall.log',
      cwd: 'C:\\Users\\tester',
    });

    assert.equal(launch.command, 'C:\\Program Files\\nodejs\\node.exe');
    assert.equal(launch.npmCommand, 'npm.cmd');
    assert.equal(launch.args[0], '-e');
    assert.match(launch.args[1], /"npm\.cmd"/);
    assert.match(launch.args[1], /"C:\\\\Users\\\\tester"/);
    assert.match(launch.args[1], /"C:\\\\Users\\\\tester\\\\\.codelark\\\\runtime\\\\npm-uninstall\.log"/);
    assert.match(launch.args[1], /\['uninstall', '-g', "codelark"\]/);
  });

  it('uses npm on non-Windows launchers', () => {
    const launch = buildDeferredGlobalNpmUninstallLaunch({
      platform: 'linux',
      nodePath: '/usr/bin/node',
      logPath: '/tmp/codelark-uninstall.log',
      cwd: '/tmp',
      delayMs: 2500,
    });

    assert.equal(launch.command, '/usr/bin/node');
    assert.equal(launch.npmCommand, 'npm');
    assert.equal(launch.delayMs, 2500);
    assert.equal(launch.args[0], '-e');
    assert.match(launch.args[1], /"npm"/);
    assert.match(launch.args[1], /"\/tmp"/);
    assert.match(launch.args[1], /"\/tmp\/codelark-uninstall\.log"/);
    assert.match(launch.args[1], /const delayMs = 2500;/);
  });
});

describe('service-manager Windows autostart task naming', () => {
  it('uses the CodeLark task name for new installs', () => {
    const script = _testOnly.buildInstallBridgeAutostartScript(
      'C:\\Users\\tester\\.codelark\\runtime\\bridge-autostart.ps1',
      'DESKTOP\\tester',
      'secret',
    );

    assert.equal(_testOnly.primaryBridgeAutostartTaskName, 'CodeLarkBridge');
    assert.match(script, /Register-ScheduledTask -TaskName 'CodeLarkBridge'/);
    assert.doesNotMatch(script, /Get-ScheduledTask -TaskName 'CodeLarkBridge'/);
  });

  it('checks the CodeLark autostart task when reporting status', () => {
    const script = _testOnly.buildBridgeAutostartStatusScript();
    assert.match(script, /\$taskNames = @\('CodeLarkBridge'\)/);
    assert.match(script, /foreach \(\$candidate in \$taskNames\)/);
    assert.match(script, /taskName = \$taskName/);
  });

  it('uninstalls the CodeLark autostart task', () => {
    const script = _testOnly.buildUninstallBridgeAutostartScript();

    assert.match(script, /\$taskNames = @\('CodeLarkBridge'\)/);
    assert.match(script, /Unregister-ScheduledTask -TaskName \$taskName/);
  });
});

describe('service-manager bridge pid resolution', () => {
  it('falls back to a live status pid when bridge.pid is stale', () => {
    const pid = _testOnly.resolveTrackedBridgePid(24020, 10516, undefined, (candidate) => candidate === 10516);
    assert.equal(pid, 10516);
  });

  it('prefers a live bridge.pid over a live status pid', () => {
    const pid = _testOnly.resolveTrackedBridgePid(11420, 10516, undefined, () => true);
    assert.equal(pid, 11420);
  });

  it('deduplicates tracked bridge pids', () => {
    assert.deepEqual(_testOnly.collectTrackedBridgePids(11420, 11420, 11420), [11420]);
    assert.deepEqual(_testOnly.collectTrackedBridgePids(11420, 10516, 10516), [11420, 10516]);
  });

  it('falls back to a live instance lock pid when bridge.pid and status pid are stale', () => {
    const pid = _testOnly.resolveTrackedBridgePid(24020, 10516, 32001, (candidate) => candidate === 32001);
    assert.equal(pid, 32001);
  });
});

describe('service-manager bridge startup failure messaging', () => {
  it('reports a missing channel configuration before spawning the bridge', () => {
    assert.equal(
      _testOnly.describeBridgeStartupPreflightFailure([]),
      '未配置任何通道实例。请先使用`codelark run`创建并保存至少一个飞书通道，然后再启动桥接服务。',
    );
  });

  it('reports when all configured channels are disabled', () => {
    assert.equal(
      _testOnly.describeBridgeStartupPreflightFailure([
        {
          id: 'feishu-default',
          alias: '开开1号',
          provider: 'feishu',
          enabled: false,
          createdAt: '2026-04-07T01:00:00.000Z',
          updatedAt: '2026-04-07T01:00:00.000Z',
          config: {},
        },
      ]),
      '当前所有通道实例都已禁用。请先启用至少一个通道实例，然后再启动桥接服务。',
    );
  });

  it('falls back to enabled channel labels when the bridge still fails to activate', () => {
    assert.equal(
      _testOnly.describeBridgeActivationFailure(
        { running: false },
        [
          {
            id: 'feishu-default',
            alias: '开开1号',
            provider: 'feishu',
            enabled: true,
            createdAt: '2026-04-07T01:00:00.000Z',
            updatedAt: '2026-04-07T01:00:00.000Z',
            config: {},
          },
        ],
      ),
      '没有任何通道适配器启动成功。请检查通道配置、凭据和日志。当前已启用通道：开开1号',
    );
  });

  it('prefers a daemon-provided lastExitReason when available', () => {
    assert.equal(
      _testOnly.describeBridgeActivationFailure(
        { running: false, lastExitReason: 'fatal: boom' },
        [],
      ),
      'fatal: boom',
    );
  });
});

describe('service-manager lark-cli runtime environment', () => {
  it('loads startup preflight config from ConfigService instead of legacy env files', () => {
    const home = process.env.CODELARK_HOME!;
    const configTomlPath = path.join(home, 'config.toml');
    const configEnvPath = path.join(home, 'config.env');
    const previousToml = fs.existsSync(configTomlPath) ? fs.readFileSync(configTomlPath, 'utf-8') : null;
    const previousEnvFile = fs.existsSync(configEnvPath) ? fs.readFileSync(configEnvPath, 'utf-8') : null;

    try {
      fs.writeFileSync(configTomlPath, [
        'schema_version = 2',
        '',
        '[runtime]',
        'agent = "claude"',
        '',
        '[runtime.codex]',
        'provider = "tmux"',
        '',
        '[[channels]]',
        'id = "feishu-default"',
        'alias = "飞书"',
        'provider = "feishu"',
        'enabled = true',
        '',
        '[channels.config]',
        'app_id = "toml-app"',
        'app_secret = "toml-secret"',
        '',
      ].join('\n'));
      fs.writeFileSync(configEnvPath, [
        'CODELARK_RUNTIME=codex',
        'CODELARK_DEFAULT_CODEX_PROVIDER=pty',
        'CODELARK_FEISHU_APP_ID=legacy-app',
        '',
      ].join('\n'));

      const config = _testOnly.loadStartupConfig();

      assert.equal(config.runtime.agent, 'claude');
      assert.equal(config.runtime.codex.provider, 'tmux');
      assert.equal(config.channels?.[0]?.config.appId, 'toml-app');
      assert.equal(config.channels?.[0]?.config.appSecret, 'toml-secret');
    } finally {
      if (previousToml === null) fs.rmSync(configTomlPath, { force: true });
      else fs.writeFileSync(configTomlPath, previousToml, 'utf-8');
      if (previousEnvFile === null) fs.rmSync(configEnvPath, { force: true });
      else fs.writeFileSync(configEnvPath, previousEnvFile, 'utf-8');
    }
  });

  it('builds daemon env from v2 config projection and ignores legacy config.env files', () => {
    const home = process.env.CODELARK_HOME!;
    const configTomlPath = path.join(home, 'config.toml');
    const configEnvPath = path.join(home, 'config.env');
    const previousToml = fs.existsSync(configTomlPath) ? fs.readFileSync(configTomlPath, 'utf-8') : null;
    const previousEnvFile = fs.existsSync(configEnvPath) ? fs.readFileSync(configEnvPath, 'utf-8') : null;
    const envKeys = [
      'CODELARK_AGENT',
      'CODELARK_RUNTIME',
      'CODELARK_CODEX_MODEL',
      'CODELARK_CODEX_DEFAULT_MODEL',
      'CODELARK_CODEX_PROVIDER',
      'CODELARK_DEFAULT_CODEX_PROVIDER',
      'CODELARK_CODEX_YOLO_MODE',
      'CODELARK_CODEX_DEFAULT_MODE',
      'CODELARK_FEISHU_APP_ID',
      'CODELARK_FEISHU_APP_SECRET',
      'CODELARK_FEISHU_SITE',
      'CODELARK_DEFAULT_WORKSPACE_ROOT',
      'CODELARK_ENABLED_CHANNELS',
      'CLAUDECODE',
    ];
    const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));

    try {
      for (const key of envKeys) delete process.env[key];
      process.env.CLAUDECODE = 'legacy-flag';
      fs.writeFileSync(configTomlPath, [
        'schema_version = 2',
        '',
        '[runtime]',
        'agent = "claude"',
        '',
        '[bridge]',
        'default_workspace = "/tmp/codelark-toml-workspace"',
        '',
        '[runtime.codex]',
        'model = "toml-model"',
        'provider = "tmux"',
        'yolo_mode = "on"',
        '',
        '[[channels]]',
        'id = "feishu-default"',
        'alias = "飞书"',
        'provider = "feishu"',
        'enabled = true',
        '',
        '[channels.config]',
        'app_id = "toml-app"',
        'app_secret = "toml-secret"',
        'site = "lark"',
        '',
      ].join('\n'));
      fs.writeFileSync(configEnvPath, [
        'CODELARK_RUNTIME=codex',
        'CODELARK_CODEX_DEFAULT_MODEL=legacy-env-model',
        'CODELARK_FEISHU_APP_ID=legacy-app',
        'CODELARK_DEFAULT_WORKSPACE_ROOT=/tmp/legacy-env-workspace',
        '',
      ].join('\n'));

      const env = _testOnly.buildDaemonEnv();

      assert.equal(env.CODELARK_HOME, home);
      assert.equal(env.LARK_CHANNEL_HOME, home);
      assert.equal(env.CODELARK_AGENT, 'claude');
      assert.equal(env.CODELARK_CODEX_MODEL, 'toml-model');
      assert.equal(env.CODELARK_CODEX_PROVIDER, 'tmux');
      assert.equal(env.CODELARK_CODEX_YOLO_MODE, 'on');
      assert.equal(env.CODELARK_DEFAULT_WORKSPACE_ROOT, '/tmp/codelark-toml-workspace');
      assert.equal(env.CODELARK_FEISHU_APP_ID, 'toml-app');
      assert.equal(env.CODELARK_FEISHU_APP_SECRET, 'toml-secret');
      assert.equal(env.CODELARK_FEISHU_SITE, 'lark');
      assert.equal(env.CODELARK_ENABLED_CHANNELS, 'feishu');
      assert.equal(env.CODELARK_CODEX_DEFAULT_MODEL, undefined);
      assert.equal(env.CLAUDECODE, undefined);
    } finally {
      if (previousToml === null) fs.rmSync(configTomlPath, { force: true });
      else fs.writeFileSync(configTomlPath, previousToml, 'utf-8');
      if (previousEnvFile === null) fs.rmSync(configEnvPath, { force: true });
      else fs.writeFileSync(configEnvPath, previousEnvFile, 'utf-8');
      for (const [key, value] of previousEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('applies one-shot CLI config overrides to bridge and UI child env', () => {
    const home = process.env.CODELARK_HOME!;
    const configTomlPath = path.join(home, 'config.toml');
    const previousToml = fs.existsSync(configTomlPath) ? fs.readFileSync(configTomlPath, 'utf-8') : null;

    try {
      fs.writeFileSync(configTomlPath, [
        'schema_version = 2',
        '',
        '[runtime]',
        'agent = "codex"',
        '',
        '[runtime.codex]',
        'model = "toml-model"',
        'provider = "sdk"',
        'yolo_mode = "off"',
        '',
        '[runtime.claude]',
        'model = "toml-claude"',
        '',
        '[[channels]]',
        'id = "feishu-default"',
        'alias = "飞书"',
        'provider = "feishu"',
        'enabled = true',
        '',
      ].join('\n'));

      const cli = {
        runtime: {
          agent: 'claude' as const,
          codex: {
            model: 'cli-model',
            provider: 'tmux' as const,
            yoloMode: 'on' as const,
          },
        },
      };
      const daemonEnv = _testOnly.buildDaemonEnv({ cli });
      const uiEnv = _testOnly.buildUiServerEnv({ cli });

      assert.equal(daemonEnv.CODELARK_AGENT, 'claude');
      assert.equal(daemonEnv.CODELARK_CODEX_MODEL, 'cli-model');
      assert.equal(daemonEnv.CODELARK_CODEX_PROVIDER, 'tmux');
      assert.equal(daemonEnv.CODELARK_CODEX_YOLO_MODE, 'on');
      assert.equal(uiEnv.CODELARK_AGENT, 'claude');
      assert.equal(uiEnv.CODELARK_CODEX_MODEL, 'cli-model');
      assert.equal(uiEnv.CODELARK_CODEX_PROVIDER, 'tmux');
      assert.equal(uiEnv.CODELARK_HOME, home);
    } finally {
      if (previousToml === null) fs.rmSync(configTomlPath, { force: true });
      else fs.writeFileSync(configTomlPath, previousToml, 'utf-8');
    }
  });

  it('can reuse one startup projection for preflight config and daemon env', () => {
    const home = process.env.CODELARK_HOME!;
    const configTomlPath = path.join(home, 'config.toml');
    const previousToml = fs.existsSync(configTomlPath) ? fs.readFileSync(configTomlPath, 'utf-8') : null;

    try {
      fs.writeFileSync(configTomlPath, [
        'schema_version = 2',
        '',
        '[runtime.codex]',
        'model = "first-model"',
        '',
        '[[channels]]',
        'id = "feishu-default"',
        'alias = "飞书"',
        'provider = "feishu"',
        'enabled = true',
        '',
      ].join('\n'));

      const projection = _testOnly.loadStartupProjection();

      fs.writeFileSync(configTomlPath, [
        'schema_version = 2',
        '',
        '[runtime.codex]',
        'model = "second-model"',
        '',
        '[[channels]]',
        'id = "feishu-default"',
        'alias = "飞书"',
        'provider = "feishu"',
        'enabled = true',
        '',
      ].join('\n'));

      const daemonEnv = _testOnly.buildDaemonEnv({ startupProjection: projection });
      const uiEnv = _testOnly.buildUiServerEnv({ startupProjection: projection });

      assert.equal(projection.config.runtime.codex.model, 'first-model');
      assert.equal(daemonEnv.CODELARK_CODEX_MODEL, 'first-model');
      assert.equal(uiEnv.CODELARK_CODEX_MODEL, 'first-model');
    } finally {
      if (previousToml === null) fs.rmSync(configTomlPath, { force: true });
      else fs.writeFileSync(configTomlPath, previousToml, 'utf-8');
    }
  });

  it('keeps startup config migration before the already-running bridge fast path', () => {
    const managerSource = fs.readFileSync(path.join(process.cwd(), 'src', 'local-service', 'manager.ts'), 'utf-8');
    const start = managerSource.indexOf('export async function startBridge');
    const body = managerSource.slice(start, managerSource.indexOf('export async function stopBridge', start));

    assert.ok(body.indexOf('const startup = startupProjectionFor(options)') >= 0);
    assert.ok(body.indexOf('const current = getBridgeStatus()') >= 0);
    assert.ok(
      body.indexOf('const startup = startupProjectionFor(options)') < body.indexOf('const current = getBridgeStatus()'),
      'expected config migration snapshot before current-running return path',
    );
  });

  it('builds bridge-local lark-cli environment variables', () => {
    const env = _testOnly.buildLarkCliRuntimeEnv();

    assert.equal(env.LARK_CHANNEL, '1');
    assert.equal(env.LARK_CHANNEL_HOME, process.env.CODELARK_HOME);
    assert.equal(
      env.LARK_CHANNEL_CONFIG,
      path.join(process.env.CODELARK_HOME!, 'runtime', 'lark-cli-source', 'config.json'),
    );
    assert.equal(
      env.LARKSUITE_CLI_CONFIG_DIR,
      path.join(process.env.CODELARK_HOME!, 'runtime', 'lark-cli'),
    );
  });

  it('writes a lark-cli source projection from the configured Feishu channel', () => {
    const config: Config = {
      runtime: 'codex',
      defaultMode: 'normal',
      enabledChannels: ['feishu'],
      channels: [{
        id: 'feishu-default',
        alias: '飞书',
        provider: 'feishu',
        enabled: true,
        createdAt: '2026-06-05T00:00:00.000Z',
        updatedAt: '2026-06-05T00:00:00.000Z',
        config: {
          appId: 'cli_test_app',
          appSecret: 'test-secret',
          site: 'lark',
        },
      }],
    };
    const sourcePath = _testOnly.writeLarkCliSourceProjection(config);

    assert.equal(
      sourcePath,
      path.join(process.env.CODELARK_HOME!, 'runtime', 'lark-cli-source', 'config.json'),
    );
    const parsed = JSON.parse(fs.readFileSync(sourcePath!, 'utf-8'));
    assert.deepEqual(parsed, {
      accounts: {
        app: {
          id: 'cli_test_app',
          secret: 'test-secret',
          tenant: 'lark',
        },
      },
    });
  });

  it('does not import users from the default local lark-cli config', () => {
    const config: Config = {
      runtime: 'codex',
      defaultMode: 'normal',
      enabledChannels: ['feishu'],
      channels: [{
        id: 'feishu-default',
        alias: '飞书',
        provider: 'feishu',
        enabled: true,
        createdAt: '2026-06-05T00:00:00.000Z',
        updatedAt: '2026-06-05T00:00:00.000Z',
        config: {
          appId: 'cli_user_app',
          appSecret: 'test-secret',
          site: 'feishu',
        },
      }],
    };
    const localConfigPath = path.join(os.homedir(), '.lark-cli', 'config.json');
    const targetConfigPath = path.join(process.env.CODELARK_HOME!, 'runtime', 'lark-cli', 'lark-channel', 'config.json');
    fs.mkdirSync(path.dirname(localConfigPath), { recursive: true });
    fs.mkdirSync(path.dirname(targetConfigPath), { recursive: true });
    fs.writeFileSync(localConfigPath, JSON.stringify({
      apps: [{
        appId: 'cli_user_app',
        brand: 'feishu',
        users: [{ userOpenId: 'ou_user', userName: 'Tester' }],
      }],
    }), 'utf-8');
    fs.writeFileSync(targetConfigPath, JSON.stringify({
      apps: [{
        appId: 'cli_user_app',
        brand: 'feishu',
      }],
    }), 'utf-8');

    assert.equal(_testOnly.hasTargetLarkCliUsers(config), false);
    assert.equal(_testOnly.readTargetLarkCliApp(config)?.app.users, undefined);
  });

  it('detects and resets legacy bot-only strict lark-cli runtime for setup', () => {
    const config: Config = {
      runtime: 'codex',
      defaultMode: 'normal',
      enabledChannels: ['feishu'],
      channels: [{
        id: 'feishu-default',
        alias: '飞书',
        provider: 'feishu',
        enabled: true,
        createdAt: '2026-06-05T00:00:00.000Z',
        updatedAt: '2026-06-05T00:00:00.000Z',
        config: {
          appId: 'cli_legacy_strict',
          appSecret: 'test-secret',
          site: 'feishu',
        },
      }],
    };
    const targetConfigPath = path.join(process.env.CODELARK_HOME!, 'runtime', 'lark-cli', 'lark-channel', 'config.json');
    fs.mkdirSync(path.dirname(targetConfigPath), { recursive: true });
    fs.writeFileSync(targetConfigPath, JSON.stringify({
      apps: [{
        appId: 'cli_legacy_strict',
        brand: 'feishu',
        defaultAs: 'bot',
        strictMode: 'bot',
        users: [{ userOpenId: 'ou_user', userName: 'Tester' }],
      }],
    }), 'utf-8');

    assert.equal(_testOnly.hasLegacyStrictLarkCliRuntime(config), true);
    assert.equal(_testOnly.resetLegacyStrictLarkCliRuntimeForSetup(config), true);
    assert.equal(fs.existsSync(targetConfigPath), false);
    assert.equal(_testOnly.hasLegacyStrictLarkCliRuntime(config), false);
  });

  it('allows setup user authorization before a user token exists', () => {
    assert.deepEqual(_testOnly.larkCliIdentityPolicyCommands(false, { allowUserAuthorization: true }), [
      ['config', 'strict-mode', 'off'],
      ['config', 'default-as', 'auto'],
    ]);
    assert.deepEqual(_testOnly.larkCliIdentityPolicyCommands(false), [
      ['config', 'strict-mode', 'bot'],
      ['config', 'default-as', 'bot'],
    ]);
    assert.deepEqual(_testOnly.larkCliIdentityPolicyCommands(true), [
      ['config', 'strict-mode', 'off'],
      ['config', 'default-as', 'auto'],
    ]);
  });
});

describe('service-manager Codex skill integration', () => {
  const fakeExternalSkillRunner = async (command: string, args: string[]) => ({
    name: 'lark-doc',
    command,
    args,
    method: 'npx' as const,
    exitCode: 0,
    stdout: 'installed',
    stderr: '',
  });

  it('installs bundled CodeLark skills and the official lark-doc skill', async () => {
    const previousCodexHome = process.env.CODEX_HOME;
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-codex-skills-'));
    process.env.CODEX_HOME = codexHome;

    try {
      assert.equal(isCodexIntegrationInstalled(), false);
      const result = await installCodexIntegration({ externalSkillRunner: fakeExternalSkillRunner });
      const names = result.skills.map((skill) => skill.name).sort();
      assert.deepEqual(names, [
        'codelark',
        'codelark-auto',
        'codelark-question',
      ]);
      assert.deepEqual(result.externalSkills.map((skill) => skill.name), ['lark-doc']);
      assert.deepEqual(result.externalSkills[0]?.args, ['skills', 'add', 'larksuite/cli', '-s', 'lark-doc', '-y', '-g', '-a', 'claude-code']);
      for (const name of names) {
        const skillPath = path.join(codexHome, 'skills', name, 'SKILL.md');
        assert.equal(fs.existsSync(skillPath), true, `${name} should be installed`);
      }
      assert.equal(isCodexIntegrationInstalled(), true);

      const second = await installCodexIntegration({ externalSkillRunner: fakeExternalSkillRunner });
      assert.equal(second.skills.every((skill) => skill.method === 'existing'), true);
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      fs.rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it('installs only selected CodeLark skills when requested', async () => {
    const previousCodexHome = process.env.CODEX_HOME;
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-codex-selected-skills-'));
    process.env.CODEX_HOME = codexHome;

    try {
      const result = await installCodexIntegration({
        skillNames: ['codelark', 'lark-doc'],
        externalSkillRunner: fakeExternalSkillRunner,
      });
      assert.deepEqual(result.skills.map((skill) => skill.name), ['codelark']);
      assert.deepEqual(result.externalSkills.map((skill) => skill.name), ['lark-doc']);
      assert.equal(fs.existsSync(path.join(codexHome, 'skills', 'codelark', 'SKILL.md')), true);
      assert.equal(fs.existsSync(path.join(codexHome, 'skills', 'codelark-question', 'SKILL.md')), false);
      assert.equal(isCodexIntegrationInstalled(), false);

      await assert.rejects(
        installCodexIntegration({ skillNames: ['unknown-skill'] }),
        /Unknown CodeLark skill/,
      );
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      fs.rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it('can install bundled skills while skipping external lark-doc', async () => {
    const previousCodexHome = process.env.CODEX_HOME;
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-codex-skip-external-'));
    process.env.CODEX_HOME = codexHome;

    try {
      const result = await installCodexIntegration({
        skillNames: ['codelark', 'lark-doc'],
        skipExternalSkills: true,
        externalSkillRunner: async () => {
          throw new Error('external runner should not be called');
        },
      });

      assert.deepEqual(result.skills.map((skill) => skill.name), ['codelark']);
      assert.deepEqual(result.externalSkills, []);
      assert.equal(fs.existsSync(path.join(codexHome, 'skills', 'codelark', 'SKILL.md')), true);
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      fs.rmSync(codexHome, { recursive: true, force: true });
    }
  });
});

describe('service-manager bridge startup locking', () => {
  it('acquires a fresh startup lock', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-bridge-lock-'));
    const lockPath = path.join(tempDir, 'bridge.start.lock');

    const result = _testOnly.tryAcquireBridgeStartLock({
      filePath: lockPath,
      ownerPid: 32001,
      nowMs: Date.parse('2026-04-10T10:00:00.000Z'),
    });

    assert.equal(result.acquired, true);
    assert.deepEqual(_testOnly.readBridgeStartLock(lockPath), {
      pid: 32001,
      createdAt: '2026-04-10T10:00:00.000Z',
    });
  });

  it('blocks on a live startup lock holder', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-bridge-lock-'));
    const lockPath = path.join(tempDir, 'bridge.start.lock');
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: 32001,
      createdAt: '2026-04-10T10:00:00.000Z',
    }), 'utf-8');

    const result = _testOnly.tryAcquireBridgeStartLock({
      filePath: lockPath,
      ownerPid: 32002,
      nowMs: Date.parse('2026-04-10T10:00:05.000Z'),
      isAlive: (pid) => pid === 32001,
    });

    assert.deepEqual(result, { acquired: false, holderPid: 32001 });
    assert.deepEqual(_testOnly.readBridgeStartLock(lockPath), {
      pid: 32001,
      createdAt: '2026-04-10T10:00:00.000Z',
    });
  });

  it('replaces a stale startup lock when the holder is gone', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-bridge-lock-'));
    const lockPath = path.join(tempDir, 'bridge.start.lock');
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: 32001,
      createdAt: '2026-04-10T10:00:00.000Z',
    }), 'utf-8');

    const result = _testOnly.tryAcquireBridgeStartLock({
      filePath: lockPath,
      ownerPid: 32002,
      nowMs: Date.parse('2026-04-10T10:00:10.000Z'),
      isAlive: () => false,
    });

    assert.equal(result.acquired, true);
    assert.deepEqual(_testOnly.readBridgeStartLock(lockPath), {
      pid: 32002,
      createdAt: '2026-04-10T10:00:10.000Z',
    });
  });

  it('does not release another process startup lock', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-bridge-lock-'));
    const lockPath = path.join(tempDir, 'bridge.start.lock');
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: 32001,
      createdAt: '2026-04-10T10:00:00.000Z',
    }), 'utf-8');

    _testOnly.releaseBridgeStartLock(lockPath, 32002);

    assert.equal(fs.existsSync(lockPath), true);
    assert.deepEqual(_testOnly.readBridgeStartLock(lockPath), {
      pid: 32001,
      createdAt: '2026-04-10T10:00:00.000Z',
    });
  });
});

describe('bridge instance locking', () => {
  it('blocks a second daemon while the first holder is alive', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-bridge-instance-lock-'));
    const lockPath = path.join(tempDir, 'bridge.instance.lock');

    const first = tryAcquireBridgeInstanceLock({
      filePath: lockPath,
      ownerPid: 32001,
      nowMs: Date.parse('2026-04-24T12:00:00.000Z'),
    });
    const second = tryAcquireBridgeInstanceLock({
      filePath: lockPath,
      ownerPid: 32002,
      nowMs: Date.parse('2026-04-24T12:00:10.000Z'),
      isAlive: (pid) => pid === 32001,
    });

    assert.equal(first.acquired, true);
    assert.deepEqual(second, { acquired: false, holderPid: 32001 });
    assert.deepEqual(_testOnly.readBridgeInstanceLock(lockPath), {
      pid: 32001,
      createdAt: '2026-04-24T12:00:00.000Z',
    });
  });

  it('replaces a stale instance lock when the holder is gone', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-bridge-instance-lock-'));
    const lockPath = path.join(tempDir, 'bridge.instance.lock');
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: 32001,
      createdAt: '2026-04-24T12:00:00.000Z',
    }), 'utf-8');

    const result = tryAcquireBridgeInstanceLock({
      filePath: lockPath,
      ownerPid: 32002,
      nowMs: Date.parse('2026-04-24T12:00:10.000Z'),
      isAlive: () => false,
    });

    assert.equal(result.acquired, true);
    assert.deepEqual(_testOnly.readBridgeInstanceLock(lockPath), {
      pid: 32002,
      createdAt: '2026-04-24T12:00:10.000Z',
    });
  });

  it('does not clear a live instance lock owned by another process', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-bridge-instance-lock-'));
    const lockPath = path.join(tempDir, 'bridge.instance.lock');
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: 32001,
      createdAt: '2026-04-24T12:00:00.000Z',
    }), 'utf-8');

    _testOnly.clearStaleBridgeInstanceLock(lockPath, (pid) => pid === 32001);

    assert.equal(fs.existsSync(lockPath), true);
    assert.deepEqual(_testOnly.readBridgeInstanceLock(lockPath), {
      pid: 32001,
      createdAt: '2026-04-24T12:00:00.000Z',
    });
  });
});
