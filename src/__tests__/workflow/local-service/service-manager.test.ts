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
  warnIfLarkCliUserAuthMissing,
} from '../../../local-service/manager.js';
import { tryAcquireBridgeInstanceLock } from '../../../local-service/instance-lock.js';

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

describe('service-manager startup config and daemon env', () => {
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
        'agent = "kimi"',
        '',
        '[runtime.codex]',
        'provider = "tmux"',
        '',
        '[runtime.kimi]',
        'model = "moonshot-v1-test"',
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
        'CODELARK_DEFAULT_CODEX_PROVIDER=tmux',
        'CODELARK_KIMI_MODEL=legacy-kimi-model',
        'CODELARK_KIMI_PROVIDER=tmux',
        'CODELARK_FEISHU_APP_ID=legacy-app',
        '',
      ].join('\n'));

      const config = _testOnly.loadStartupConfig();

      assert.equal(config.runtime.agent, 'kimi');
      assert.equal(config.runtime.codex.provider, 'tmux');
      assert.equal(config.runtime.kimi.model, 'moonshot-v1-test');
      assert.equal(config.runtime.kimi.provider, 'tmux');
      assert.equal(config.channels?.[0]?.config.appId, 'toml-app');
      assert.equal(config.channels?.[0]?.config.appSecret, 'toml-secret');
    } finally {
      if (previousToml === null) fs.rmSync(configTomlPath, { force: true });
      else fs.writeFileSync(configTomlPath, previousToml, 'utf-8');
      if (previousEnvFile === null) fs.rmSync(configEnvPath, { force: true });
      else fs.writeFileSync(configEnvPath, previousEnvFile, 'utf-8');
    }
  });

  it('builds daemon env by inheriting process env without any lark-cli isolation', () => {
    const home = process.env.CODELARK_HOME!;
    const configTomlPath = path.join(home, 'config.toml');
    const configEnvPath = path.join(home, 'config.env');
    const previousToml = fs.existsSync(configTomlPath) ? fs.readFileSync(configTomlPath, 'utf-8') : null;
    const previousEnvFile = fs.existsSync(configEnvPath) ? fs.readFileSync(configEnvPath, 'utf-8') : null;
    const envKeys = [
      'CODELARK_AGENT',
      'CODELARK_CODEX_MODEL',
      'CODELARK_CODEX_PROVIDER',
      'CODELARK_KIMI_MODEL',
      'CODELARK_KIMI_DEFAULT_MODEL',
      'CODELARK_KIMI_PROVIDER',
      'CODELARK_FEISHU_APP_ID',
      'CODELARK_ENABLED_CHANNELS',
      'LARK_CHANNEL',
      'LARK_CHANNEL_HOME',
      'LARK_CHANNEL_CONFIG',
      'LARKSUITE_CLI_CONFIG_DIR',
      'PATH',
      'CLAUDECODE',
    ];
    const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));

    try {
      for (const key of envKeys) delete process.env[key];
      process.env.CODELARK_AGENT = 'user-env-agent';
      process.env.CLAUDECODE = 'legacy-flag';
      process.env.LARK_CHANNEL = '1';
      process.env.LARK_CHANNEL_HOME = home;
      process.env.LARK_CHANNEL_CONFIG = path.join(home, 'runtime', 'lark-cli-source', 'config.json');
      process.env.LARKSUITE_CLI_CONFIG_DIR = path.join(home, 'runtime', 'lark-cli');
      process.env.PATH = [path.join(home, 'runtime', 'bin'), '/usr/bin', '/bin'].join(path.delimiter);
      fs.writeFileSync(configTomlPath, [
        'schema_version = 2',
        '',
        '[runtime]',
        'agent = "claude"',
        '',
        '[runtime.codex]',
        'model = "toml-model"',
        'provider = "tmux"',
        '',
        '[runtime.kimi]',
        'model = "toml-kimi-model"',
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
        'site = "lark"',
        '',
      ].join('\n'));
      fs.writeFileSync(configEnvPath, [
        'CODELARK_AGENT=legacy-env-agent',
        'CODELARK_CODEX_MODEL=legacy-env-model',
        'CODELARK_KIMI_MODEL=legacy-kimi-model',
        'CODELARK_KIMI_PROVIDER=tmux',
        'CODELARK_FEISHU_APP_ID=legacy-app',
        '',
      ].join('\n'));

      const env = _testOnly.buildDaemonEnv();

      assert.equal(env.CODELARK_AGENT, 'user-env-agent');
      assert.equal(env.CODELARK_CODEX_MODEL, undefined);
      assert.equal(env.CODELARK_CODEX_PROVIDER, undefined);
      assert.equal(env.CODELARK_KIMI_MODEL, undefined);
      assert.equal(env.CODELARK_KIMI_DEFAULT_MODEL, undefined);
      assert.equal(env.CODELARK_KIMI_PROVIDER, undefined);
      assert.equal(env.CODELARK_FEISHU_APP_ID, undefined);
      assert.equal(env.CODELARK_ENABLED_CHANNELS, undefined);
      assert.equal(env.LARK_CHANNEL, undefined);
      assert.equal(env.LARK_CHANNEL_HOME, undefined);
      assert.equal(env.LARK_CHANNEL_CONFIG, undefined);
      assert.equal(env.LARKSUITE_CLI_CONFIG_DIR, undefined);
      const runtimeBinDir = path.join(process.env.CODELARK_HOME!, 'runtime', 'bin');
      const pathEntries = (env.PATH || '').split(path.delimiter).filter(Boolean);
      assert.equal(pathEntries.includes(runtimeBinDir), false);
      assert.notEqual(pathEntries[0], runtimeBinDir);
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

  it('applies one-shot CLI config overrides to the startup config without exporting child env', () => {
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
      ].join('\n'));

      const cli = {
        runtime: {
          agent: 'kimi' as const,
          codex: {
            model: 'cli-model',
            provider: 'tmux' as const,
            yoloMode: 'on' as const,
          },
          kimi: {
            model: 'cli-kimi-model',
            provider: 'tmux' as const,
          },
        },
      };
      const projection = _testOnly.loadStartupProjection({ cli });
      const daemonEnv = _testOnly.buildDaemonEnv({ cli });
      const uiEnv = _testOnly.buildUiServerEnv({ cli });

      assert.equal(projection.config.runtime.agent, 'kimi');
      assert.equal(projection.config.runtime.codex.model, 'cli-model');
      assert.equal(projection.config.runtime.codex.provider, 'tmux');
      assert.equal(projection.config.runtime.codex.yoloMode, 'on');
      assert.equal(projection.config.runtime.kimi.model, 'cli-kimi-model');
      assert.equal(projection.config.runtime.kimi.provider, 'tmux');
      assert.equal(daemonEnv.CODELARK_CODEX_MODEL, process.env.CODELARK_CODEX_MODEL);
      assert.equal(daemonEnv.CODELARK_KIMI_MODEL, process.env.CODELARK_KIMI_MODEL);
      assert.equal(daemonEnv.CODELARK_KIMI_PROVIDER, process.env.CODELARK_KIMI_PROVIDER);
      assert.equal(uiEnv.CODELARK_CODEX_MODEL, process.env.CODELARK_CODEX_MODEL);
      assert.equal(uiEnv.CODELARK_KIMI_MODEL, process.env.CODELARK_KIMI_MODEL);
      assert.equal(uiEnv.CODELARK_KIMI_PROVIDER, process.env.CODELARK_KIMI_PROVIDER);
    } finally {
      if (previousToml === null) fs.rmSync(configTomlPath, { force: true });
      else fs.writeFileSync(configTomlPath, previousToml, 'utf-8');
    }
  });

  it('can reuse one startup projection for preflight config without exporting child env', () => {
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
      ].join('\n'));

      const projection = _testOnly.loadStartupProjection();

      fs.writeFileSync(configTomlPath, [
        'schema_version = 2',
        '',
        '[runtime.codex]',
        'model = "second-model"',
        '',
      ].join('\n'));

      const daemonEnv = _testOnly.buildDaemonEnv({ startupProjection: projection });
      const uiEnv = _testOnly.buildUiServerEnv({ startupProjection: projection });

      assert.equal(projection.config.runtime.codex.model, 'first-model');
      assert.equal(daemonEnv.CODELARK_CODEX_MODEL, process.env.CODELARK_CODEX_MODEL);
      assert.equal(uiEnv.CODELARK_CODEX_MODEL, process.env.CODELARK_CODEX_MODEL);
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
    assert.ok(body.indexOf('refreshBundledCodeLarkSkills()') >= 0);
    assert.ok(body.indexOf('const current = getBridgeStatus()') >= 0);
    assert.ok(
      body.indexOf('const startup = startupProjectionFor(options)') < body.indexOf('const current = getBridgeStatus()'),
      'expected config migration snapshot before current-running return path',
    );
    assert.ok(
      body.indexOf('refreshBundledCodeLarkSkills()') < body.indexOf('const current = getBridgeStatus()'),
      'expected bundled skill refresh before current-running return path',
    );
  });

  it('does not maintain an isolated lark-cli runtime anymore', () => {
    const managerSource = fs.readFileSync(path.join(process.cwd(), 'src', 'local-service', 'manager.ts'), 'utf-8');

    assert.doesNotMatch(managerSource, /LARKSUITE_CLI_CONFIG_DIR/);
    assert.doesNotMatch(managerSource, /LARK_CHANNEL_CONFIG/);
    assert.doesNotMatch(managerSource, /lark-cli-source/);
    assert.doesNotMatch(managerSource, /'config', 'bind'/);
    assert.doesNotMatch(managerSource, /ensureLarkCliRuntimeConfig/);
    assert.doesNotMatch(managerSource, /ensureLarkCliShim/);
    assert.doesNotMatch(managerSource, /runtime', 'bin'/);
  });
});

describe('service-manager warnIfLarkCliUserAuthMissing', () => {
  const feishuConfig = {
    channels: [{
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      config: { appId: 'cli_test', appSecret: 'secret', site: 'feishu' as const },
    }],
  };

  it('stays silent when the global lark-cli auth check passes', async () => {
    const warnings: string[] = [];
    let checks = 0;
    await warnIfLarkCliUserAuthMissing(feishuConfig, {
      runCheck: async () => {
        checks += 1;
        return { code: 0, stdout: 'ok', stderr: '' };
      },
      warn: (message) => warnings.push(message),
    });

    assert.equal(checks, 1);
    assert.deepEqual(warnings, []);
  });

  it('warns and never throws when the global lark-cli auth check fails', async () => {
    const warnings: string[] = [];
    await warnIfLarkCliUserAuthMissing(feishuConfig, {
      runCheck: async () => ({ code: 1, stdout: '', stderr: 'missing user authorization' }),
      warn: (message) => warnings.push(message),
    });

    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /codelark setup/);
    assert.match(warnings[0]!, /missing user authorization/);
  });

  it('degrades to a warning when lark-cli is unavailable', async () => {
    const warnings: string[] = [];
    await warnIfLarkCliUserAuthMissing(feishuConfig, {
      runCheck: async () => ({ code: 127, stdout: '', stderr: 'Bundled @larksuite/cli entry script was not found.' }),
      warn: (message) => warnings.push(message),
    });

    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /codelark setup/);

    const thrownWarnings: string[] = [];
    await warnIfLarkCliUserAuthMissing(feishuConfig, {
      runCheck: async () => {
        throw new Error('spawn failed');
      },
      warn: (message) => thrownWarnings.push(message),
    });

    assert.equal(thrownWarnings.length, 1);
    assert.match(thrownWarnings[0]!, /无法执行 lark-cli 用户授权检查/);
    assert.match(thrownWarnings[0]!, /spawn failed/);
  });

  it('skips the check entirely when no enabled feishu channel exists', async () => {
    const warnings: string[] = [];
    let checks = 0;
    await warnIfLarkCliUserAuthMissing({ channels: [] }, {
      runCheck: async () => {
        checks += 1;
        return { code: 0, stdout: '', stderr: '' };
      },
      warn: (message) => warnings.push(message),
    });

    assert.equal(checks, 0);
    assert.deepEqual(warnings, []);
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
        'condition-monitor',
      ]);
      assert.deepEqual(result.externalSkills.map((skill) => skill.name), ['lark-doc']);
      assert.deepEqual(result.externalSkills[0]?.args, ['skills', 'add', 'larksuite/cli', '-s', 'lark-doc', '-y', '-g', '-a', 'claude-code']);
      for (const name of names) {
        const skillPath = path.join(codexHome, 'skills', name, 'SKILL.md');
        assert.equal(fs.existsSync(skillPath), true, `${name} should be installed`);
      }
      assert.equal(isCodexIntegrationInstalled(), true);

      const second = await installCodexIntegration({ externalSkillRunner: fakeExternalSkillRunner });
      assert.equal(second.skills.every((skill) => skill.method === 'updated'), true);
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
        skillNames: ['codelark', 'condition-monitor', 'lark-doc'],
        externalSkillRunner: fakeExternalSkillRunner,
      });
      assert.deepEqual(result.skills.map((skill) => skill.name), ['codelark', 'condition-monitor']);
      assert.deepEqual(result.externalSkills.map((skill) => skill.name), ['lark-doc']);
      assert.equal(fs.existsSync(path.join(codexHome, 'skills', 'codelark', 'SKILL.md')), true);
      assert.equal(fs.existsSync(path.join(codexHome, 'skills', 'condition-monitor', 'SKILL.md')), true);
      assert.equal(fs.existsSync(path.join(codexHome, 'skills', 'codelark-question', 'SKILL.md')), false);
      assert.equal(isCodexIntegrationInstalled(), true);

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

  it('refreshes the unified CodeLark skill and removes legacy split skills', async () => {
    const previousCodexHome = process.env.CODEX_HOME;
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-codex-skill-upgrade-'));
    process.env.CODEX_HOME = codexHome;

    try {
      const skillsDir = path.join(codexHome, 'skills');
      fs.mkdirSync(path.join(skillsDir, 'codelark'), { recursive: true });
      fs.writeFileSync(path.join(skillsDir, 'codelark', 'SKILL.md'), 'stale skill', 'utf8');
      for (const name of ['codelark-question', 'codelark-auto']) {
        fs.mkdirSync(path.join(skillsDir, name), { recursive: true });
        fs.writeFileSync(path.join(skillsDir, name, 'SKILL.md'), 'legacy', 'utf8');
      }

      const result = await installCodexIntegration({
        skillNames: ['codelark'],
        skipExternalSkills: true,
      });

      assert.equal(result.skills[0]?.method, 'updated');
      assert.match(fs.readFileSync(path.join(skillsDir, 'codelark', 'SKILL.md'), 'utf8'), /<clk-input>/u);
      assert.equal(fs.existsSync(path.join(skillsDir, 'codelark-question')), false);
      assert.equal(fs.existsSync(path.join(skillsDir, 'codelark-auto')), false);
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      fs.rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it('recovers a crashed skill backup and rejects a live concurrent installer', async () => {
    const previousCodexHome = process.env.CODEX_HOME;
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-codex-skill-recovery-'));
    process.env.CODEX_HOME = codexHome;

    try {
      const skillsDir = path.join(codexHome, 'skills');
      const backupDir = path.join(skillsDir, '.codelark.backup-crashed');
      fs.mkdirSync(backupDir, { recursive: true });
      fs.writeFileSync(path.join(backupDir, 'SKILL.md'), 'recoverable old skill', 'utf8');

      const recovered = await installCodexIntegration({ skillNames: ['codelark'], skipExternalSkills: true });
      assert.equal(recovered.skills[0]?.method, 'updated');
      assert.match(fs.readFileSync(path.join(skillsDir, 'codelark', 'SKILL.md'), 'utf8'), /<clk-input>/u);

      const lockDir = path.join(skillsDir, '.codelark.install.lock');
      fs.mkdirSync(lockDir);
      fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid }), 'utf8');
      await assert.rejects(
        installCodexIntegration({ skillNames: ['codelark'], skipExternalSkills: true }),
        /installation is already running/u,
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
