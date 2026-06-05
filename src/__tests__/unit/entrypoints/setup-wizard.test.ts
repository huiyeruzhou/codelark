import '../../setup/test-setup.js';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildSetupConfig,
  extractHttpUrlsFromText,
  recommendRuntime,
  renderLarkCliUrlQr,
} from '../../../entrypoints/setup-wizard.js';
import {
  FEISHU_REQUIRED_CALLBACKS,
  FEISHU_REQUIRED_EVENTS,
  feishuSetupTenantScopes,
  feishuSetupUserAuthScopeArgument,
  feishuSetupUserAuthScopes,
} from '../../../channels/feishu/permissions.js';
import type { Config } from '../../../configuration/index.js';

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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

  assert.match(rendered, /检测到 lark-cli 授权链接/);
  assert.match(rendered, /https:\/\/open\.feishu\.cn\/auth\?state=abc/);
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
  assert.match(script, /CODELARK_REAL_FEISHU_TEST_APP_ID/);
  assert.match(script, /CODELARK_REAL_FEISHU_TEST_APP_SECRET/);
  assert.match(script, /CTI_REAL_FEISHU_TEST_APP_ID/);
  assert.match(script, /CTI_REAL_FEISHU_TEST_APP_SECRET/);
});

test('recommends runtime from home directory markers', () => {
  const root = tempDir('clk-runtime-');

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
  const current: Config = {
    runtime: 'codex',
    defaultMode: 'normal',
    enabledChannels: [],
    channels: [],
  };

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

  assert.equal(next.runtime, 'claude');
  assert.equal(next.claudeExecutable, 'ccr');
  assert.equal(next.claudeProvider, 'pty');
  assert.equal(next.defaultWorkspaceRoot, '/work/project');
  assert.equal(next.defaultProvider, 'tmux');
  assert.equal(next.channels?.[0]?.alias, '主飞书');
  assert.deepEqual(next.channels?.[0]?.config, {
    appId: 'cli_demo',
    appSecret: 'secret_demo',
    site: 'feishu',
    allowedUsers: ['ou_a'],
    streamingEnabled: true,
    feedbackMarkdownEnabled: true,
  });
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
