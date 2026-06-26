import '../../setup/test-setup.js';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildSetupConfig,
  buildTmuxInstallGuidance,
  extractHttpUrlsFromText,
  loadSetupConfig,
  recommendRuntime,
  renderLarkCliUrlQr,
  saveSetupConfigToHomeToml,
} from '../../../entrypoints/setup-wizard.js';
import {
  FEISHU_REQUIRED_CALLBACKS,
  FEISHU_REQUIRED_EVENTS,
  feishuSetupTenantScopes,
  feishuSetupUserAuthScopeArgument,
  feishuSetupUserAuthScopes,
} from '../../../channels/feishu/permissions.js';
import type { ConfigV2 } from '../../../configuration/schema.js';

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function baseSetupConfig(): ConfigV2 {
  const home = tempDir('clk-setup-base-');
  try {
    return loadSetupConfig(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('extracts lark-cli authorization URLs from terminal output', () => {
  const urls = extractHttpUrlsFromText([
    'Open this URL:',
    '\x1b[36mhttps://open.feishu.cn/open-apis/authen/v1/authorize?app_id=cli_x&redirect_uri=http%3A%2F%2F127.0.0.1%3A3000%2Fcb\x1b[0m',
    '备用：https://accounts.larksuite.com/oauth/authorize?state=abc。',
  ].join('\n'));

  assert.deepEqual(urls, [
    'https://open.feishu.cn/open-apis/authen/v1/authorize?app_id=cli_x&redirect_uri=http%3A%2F%2F127.0.0.1%3A3000%2Fcb',
    'https://accounts.larksuite.com/oauth/authorize?state=abc',
  ]);
});

test('renders a terminal QR block for lark-cli authorization URLs', async () => {
  const rendered = await renderLarkCliUrlQr('https://open.feishu.cn/auth?state=abc');

  assert.doesNotMatch(rendered, /检测到授权链接/);
  assert.doesNotMatch(rendered, /https:\/\/open\.feishu\.cn\/auth\?state=abc/);
  assert.ok(rendered.length > 100);
});

test('real setup wizard e2e uses the CodeLark lark-cli alias by default', () => {
  const scriptPath = path.join(process.cwd(), 'scripts', 'setup-wizard-real-e2e.ts');
  const script = fs.readFileSync(scriptPath, 'utf-8');
  const legacyAliasPattern = new RegExp(`alias: 'codex${'-to-im'}'`);

  assert.match(script, /alias: 'codelark'/);
  assert.doesNotMatch(script, legacyAliasPattern);
});

test('real setup wizard e2e can load credentials from env file without npm secret args', () => {
  const scriptPath = path.join(process.cwd(), 'scripts', 'setup-wizard-real-e2e.ts');
  const script = fs.readFileSync(scriptPath, 'utf-8');

  assert.match(script, /--test-env-file/);
  assert.match(script, /--runtime/);
  assert.match(script, /codex\|ccr\|claude\|kimi/);
  assert.match(script, /CODELARK_REAL_FEISHU_TEST_APP_ID/);
  assert.match(script, /CODELARK_REAL_FEISHU_TEST_APP_SECRET/);
  assert.doesNotMatch(script, /CTI_REAL_FEISHU_TEST_APP_ID/);
  assert.doesNotMatch(script, /CTI_REAL_FEISHU_TEST_APP_SECRET/);
  assert.doesNotMatch(script, /CTI_REAL_FEISHU_TEST_SITE/);
});

test('real setup wizard wizard e2e creates credentials in an isolated home and writes CodeLark TOML', () => {
  const scriptPath = path.join(process.cwd(), 'scripts', 'setup-wizard-real-wizard-e2e.ts');
  const script = fs.readFileSync(scriptPath, 'utf-8');
  const realFeishuScript = fs.readFileSync(path.join(process.cwd(), 'scripts', 'real-feishu-e2e.ts'), 'utf-8');
  const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8')) as {
    scripts?: Record<string, string>;
  };

  assert.equal(packageJson.scripts?.['real:setup-wizard:wizard-e2e'], 'tsx scripts/setup-wizard-real-wizard-e2e.ts');
  assert.match(script, /CODELARK_SETUP_WIZARD_REAL_E2E/);
  assert.match(script, /@homebridge\/node-pty-prebuilt-multiarch/);
  assert.match(script, /auth', 'status'/);
  assert.match(script, /auth', 'check'/);
  assert.match(script, /LARKSUITE_CLI_CONFIG_DIR/);
  assert.match(script, /mock HOME/);
  assert.match(script, /--home-marker <name>/);
  assert.match(script, /runtime\?: \{/);
  assert.match(script, /agent\?: string/);
  assert.match(script, /runtime agent mismatch/);
  assert.match(script, /kimi provider mismatch/);
  assert.doesNotMatch(script, /runtime\?: \{ provider\?: string \}/);
  assert.match(script, /defaultRealFeishuTestEnvFile/);
  assert.match(script, /writeDefaultRealFeishuTestEnvFile/);
  assert.match(script, /CODELARK_REAL_FEISHU_TEST_APP_ID/);
  assert.doesNotMatch(script, /Missing test app credentials/);
  assert.match(script, /config\.toml/);
  assert.doesNotMatch(script, /writePreseedConfigEnv/);
  assert.doesNotMatch(script, /--app-id/);
  assert.doesNotMatch(script, /config\.env missing/);
  assert.match(realFeishuScript, /defaultRealFeishuTestEnvFile/);
  assert.match(realFeishuScript, /valueArg\(argv, '--test-env-file', defaultRealFeishuTestEnvFile\(\)\)/);

  const wizardSource = fs.readFileSync(path.join(process.cwd(), 'src', 'entrypoints', 'setup-wizard.ts'), 'utf-8');
  assert.match(wizardSource, /'auth', 'qrcode', url, '--ascii'/);
  assert.doesNotMatch(wizardSource, /QRCode\.toString/);
  assert.match(wizardSource, /config\.toml/);
  assert.doesNotMatch(wizardSource, /config\.json 和 config\.env/);
});

test('setup wizard binds lark-cli runtime with user-default identity and resets legacy strict runtime', () => {
  const managerSource = fs.readFileSync(path.join(process.cwd(), 'src', 'local-service', 'manager.ts'), 'utf-8');
  const wizardSource = fs.readFileSync(path.join(process.cwd(), 'src', 'entrypoints', 'setup-wizard.ts'), 'utf-8');

  assert.match(managerSource, /'config', 'bind', '--source', 'lark-channel', '--identity', 'user-default', '--force'/);
  assert.doesNotMatch(managerSource, /'--identity', 'bot-only'/);
  assert.match(managerSource, /resetLegacyStrictLarkCliRuntimeForSetup/);
  assert.match(wizardSource, /resetLegacyStrictLarkCliRuntimeForSetup\(config\)/);
  assert.match(wizardSource, /ensureLarkCliRuntimeConfig\(config, \{ allowUserAuthorization: true \}\)/);
});

test('setup wizard refreshes lark-cli identity policy after user authorization', () => {
  const wizardSource = fs.readFileSync(path.join(process.cwd(), 'src', 'entrypoints', 'setup-wizard.ts'), 'utf-8');
  const start = wizardSource.indexOf('async function ensureCodeLarkUserAuthorization');
  const end = wizardSource.indexOf('function existingFeishuCredentials', start);
  const body = wizardSource.slice(start, end);
  const firstSync = body.indexOf('ensureLarkCliRuntimeConfig(config, { allowUserAuthorization: true })');
  const login = body.indexOf("'auth',\n      'login'");
  const preLoginPolicyRefresh = body.indexOf('const preLoginPolicyWarning = await applyLarkCliRuntimeIdentityPolicy(true)');
  const policyRefresh = body.lastIndexOf('applyLarkCliRuntimeIdentityPolicy(true)');
  const postLoginCheck = body.lastIndexOf('hasCodeLarkUserAuthorization()');

  assert.ok(firstSync >= 0, 'expected pre-login lark-cli runtime sync');
  assert.ok(preLoginPolicyRefresh > firstSync, 'expected pre-login identity policy refresh');
  assert.ok(login > firstSync, 'expected auth login after pre-login sync');
  assert.ok(policyRefresh > login, 'expected post-login identity policy refresh');
  assert.ok(postLoginCheck > policyRefresh, 'expected post-login auth check');
  assert.doesNotMatch(body.slice(login), /ensureLarkCliRuntimeConfig\(config\)/);
});

test('recommends runtime from home directory markers', () => {
  const root = tempDir('clk-runtime-');
  const kimiRoot = tempDir('clk-runtime-kimi-');

  fs.mkdirSync(path.join(kimiRoot, '.kimi-code'), { recursive: true });
  assert.deepEqual(recommendRuntime(kimiRoot), {
    runtime: 'kimi',
    reason: '检测到 ~/.kimi-code，默认使用 Kimi Code。',
  });

  fs.mkdirSync(path.join(root, '.claude-code'), { recursive: true });
  assert.deepEqual(recommendRuntime(root), {
    runtime: 'claude',
    claudeExecutable: 'claude',
    reason: '检测到 Claude Code 配置，默认使用 Claude Code。',
  });

  fs.mkdirSync(path.join(root, '.claude-code-router'), { recursive: true });
  assert.deepEqual(recommendRuntime(root), {
    runtime: 'claude',
    claudeExecutable: 'ccr',
    reason: '检测到 ~/.claude-code-router，默认使用 Claude Code Router。',
  });

  fs.mkdirSync(path.join(root, '.codex'), { recursive: true });
  assert.deepEqual(recommendRuntime(root), {
    runtime: 'codex',
    reason: '检测到 ~/.codex，默认使用 Codex。',
  });
});

test('builds setup config with selected credentials, runtime, and workspace', () => {
  const current = baseSetupConfig();

  const next = buildSetupConfig(
    current,
    {
      appId: 'cli_demo',
      appSecret: 'secret_demo',
      site: 'feishu',
      alias: '主飞书',
      allowedUsers: ['ou_a'],
    },
    'ccr',
    '/work/project',
  );

  assert.equal(next.runtime.agent, 'claude');
  assert.equal(next.runtime.claude.executable, 'ccr');
  assert.equal(next.runtime.claude.provider, 'tmux');
  assert.equal(next.bridge.defaultWorkspace, '/work/project');
  assert.equal(next.runtime.codex.provider, 'tmux');
  assert.equal(next.channels?.[0]?.alias, '主飞书');
  assert.equal(next.channels?.[0]?.config.appId, 'cli_demo');
  assert.equal(next.channels?.[0]?.config.appSecret, 'secret_demo');
  assert.equal(next.channels?.[0]?.config.site, 'feishu');
  assert.deepEqual(next.channels?.[0]?.config.allowedUsers, ['ou_a']);
  assert.equal(next.channels?.[0]?.config.streamingEnabled, true);
  assert.equal(next.channels?.[0]?.config.feedbackMarkdownEnabled, true);
});

test('setup wizard saves first-run config to home TOML instead of legacy env/json files', () => {
  const home = tempDir('clk-setup-config-');
  try {
    const current = loadSetupConfig(home);
    const next = buildSetupConfig(
      current,
      {
        appId: 'cli_demo',
        appSecret: 'secret_demo',
        site: 'lark',
        alias: '主飞书',
      },
      'codex',
      '/work/project',
    );

    saveSetupConfigToHomeToml(next, home);
    const loaded = loadSetupConfig(home);

    assert.equal(fs.existsSync(path.join(home, 'config.toml')), true);
    assert.equal(fs.existsSync(path.join(home, 'config.env')), false);
    assert.equal(fs.existsSync(path.join(home, 'config.json')), false);
    assert.equal(loaded.runtime.agent, 'codex');
    assert.equal(loaded.bridge.defaultWorkspace, '/work/project');
    assert.equal(loaded.channels?.[0]?.config.appId, 'cli_demo');
    assert.equal(loaded.channels?.[0]?.config.appSecret, 'secret_demo');
    assert.equal(loaded.channels?.[0]?.config.site, 'lark');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('builds setup config with sdk providers when tmux install is declined', () => {
  const current = baseSetupConfig();

  const next = buildSetupConfig(
    current,
    {
      appId: 'cli_demo',
      appSecret: 'secret_demo',
      site: 'feishu',
    },
    'claude',
    '/work/project',
    { tmuxAvailable: false },
  );

  assert.equal(next.runtime.agent, 'claude');
  assert.equal(next.runtime.codex.provider, 'sdk');
  assert.equal(next.runtime.claude.provider, 'sdk');
});

test('builds platform-specific tmux installation guidance', () => {
  const linux = buildTmuxInstallGuidance('linux');
  assert.match(linux.command, /sudo apt update && sudo apt install -y tmux/);
  assert.match(linux.lines.join('\n'), /Linux 安装命令/);

  const macos = buildTmuxInstallGuidance('darwin');
  assert.equal(macos.command, 'brew install tmux');
  assert.match(macos.lines.join('\n'), /macOS 安装命令/);

  const windows = buildTmuxInstallGuidance('win32');
  assert.match(windows.command, /winget install --id marlocarlo\.psmux/);
  assert.match(windows.lines.join('\n'), /psmux/);
});

test('documents Feishu setup permissions required by bridge and doc-to-chat', () => {
  const tenantScopes = feishuSetupTenantScopes();
  const userScopes = feishuSetupUserAuthScopes();

  for (const scope of [
    'im:message:send_as_bot',
    'im:message:update',
    'im:message.reactions:write_only',
    'im:message.pins:write_only',
    'im:chat:read',
    'im:chat:create',
    'im:chat:update',
    'cardkit:card:write',
    'drive:file:upload',
    'drive:drive.metadata:readonly',
    'docs:permission.setting:write_only',
    'docs:permission.member:create',
    'docs:document.comment:read',
    'docs:document.comment:create',
    'docs:document.comment:write_only',
  ]) {
    assert.ok(tenantScopes.includes(scope), `missing tenant scope ${scope}`);
  }

  assert.deepEqual(userScopes, [
    'docs:document.comment:create',
    'docs:document.comment:read',
    'docs:document.comment:write_only',
    'im:chat',
    'im:chat:delete',
    'im:chat:read',
    'im:message.group_msg:get_as_user',
    'im:message.p2p_msg:get_as_user',
    'im:message.send_as_user',
  ]);
  assert.equal(feishuSetupUserAuthScopeArgument(), userScopes.join(' '));
  assert.deepEqual(FEISHU_REQUIRED_EVENTS.map((item) => item.event), [
    'im.message.receive_v1',
    'drive.notice.comment_add_v1',
    'im.chat.member.bot.deleted_v1',
    'im.chat.disbanded_v1',
  ]);
  assert.deepEqual(FEISHU_REQUIRED_CALLBACKS.map((item) => item.callback), [
    'card.action.trigger',
  ]);
});
