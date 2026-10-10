#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createConfigService } from '../src/configuration/service.js';
import { AttachmentLarkClient, runAttachmentE2E } from '../src/testing/real-feishu/attachments.js';

const exec = promisify(execFile);
const argv = process.argv.slice(2);
const option = (name: string, fallback = '') => { const i = argv.indexOf(name); return i < 0 ? fallback : argv[i + 1] || ''; };
async function main() {
  if (argv.includes('--help')) {
    process.stdout.write('Usage: npm run real:feishu:attachments -- --home <test-home> --profile <test-user-profile> --runtime codex|cursor [--cursor-thread <dedicated-desktop-id>] [--channel <id>] [--timeout-ms 240000]\nRequires an independently configured test App; creates and retains a user-owned test group. Sends only real Feishu events, never replays events or manually sends model answers.\n'); return;
  }
  assert.equal(process.env.CODELARK_REAL_FEISHU_E2E, '1', 'Set CODELARK_REAL_FEISHU_E2E=1 for real sends');
  const home = path.resolve(option('--home'));
  assert(option('--home') && home !== path.join(os.homedir(), '.codelark'), '--home must be a dedicated test CodeLark home');
  const runtime = option('--runtime', 'codex'); assert(runtime === 'codex' || runtime === 'cursor');
  const profile = option('--profile'); assert(profile, '--profile must select the test App user authorization');
  const runId = `${runtime}-${Date.now()}`;
  const directory = path.resolve(option('--output-dir', `work/real-feishu/attachments-${runId}`));
  const relative = path.relative(process.cwd(), directory); assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'output directory must be within this checkout for lark-cli file access');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const config = createConfigService({ codelarkHome: home, env: {}, migrate: false }).snapshot().config;
  const channel = config.channels.find(c => c.provider === 'feishu' && c.enabled && (!option('--channel') || c.id === option('--channel')));
  assert(channel, 'Configure the test Feishu channel in the test UI first');
  const appId = (channel.config as { appId?: string }).appId; assert(appId);
  const production = createConfigService({ codelarkHome: path.join(os.homedir(), '.codelark'), env: {}, migrate: false }).snapshot().config;
  assert(!production.channels.some(c => (c.config as { appId?: string }).appId === appId), 'Test App must differ from the production App');
  const lark = new AttachmentLarkClient(profile, path.join(directory, 'preflight'));
  const profiles = await lark.cli(['profile', 'list']);
  assert(profiles.some((p: any) => p.name === profile && p.appId === appId), 'Lark user profile must match the test App');
  const user = await lark.api('GET', '/open-apis/authen/v1/user_info');
  const userId = user.data?.open_id; assert(userId, 'test user login required');
  const bot = await lark.api('GET', '/open-apis/bot/v3/info/', { as: 'bot' });
  const botId = bot.bot?.open_id || bot.data?.bot?.open_id; assert(botId);
  if (runtime === 'cursor') assert(option('--cursor-thread'), '--cursor-thread is required; existing work conversations are never selected automatically');
  const env = { ...process.env, CODELARK_HOME: home, CODELARK_DISABLE_DAILY_VERSION_CHECK: '1' };
  // Service start is scoped to the dedicated home and is idempotent. No second
  // WebSocket listener is created by this test harness.
  await exec(process.execPath, ['dist/cli.mjs', 'start'], { env, timeout: 45_000, maxBuffer: 1024 * 1024 });
  const workspace = path.join(directory, 'workspace'); fs.mkdirSync(workspace);
  const setupFile = path.join(directory, 'group.json');
  await exec(process.execPath, ['--import', 'tsx', 'scripts/real-feishu-product-new-session.ts',
    '--channel-type', channel.id, '--channel-alias', channel.alias || 'Attachments E2E',
    '--user-open-id', userId, '--group-name', `CodeLark 附件 E2E ${runId}`, '--workdir', workspace,
    '--run-id', runId, '--output', setupFile], { env, timeout: 60_000, maxBuffer: 2 * 1024 * 1024 });
  const { chatId } = JSON.parse(fs.readFileSync(setupFile, 'utf8')); assert(chatId);
  await lark.api('GET', `/open-apis/im/v1/chats/${chatId}`);
  process.stderr.write(`[attachments-e2e] retained test group ${chatId}; report ${directory}/report.json\n`);
  await runAttachmentE2E({ home, channel: channel.id, profile, appId, botId, runtime, chatId, runId, directory,
    cursorThread: option('--cursor-thread'), timeoutMs: Number(option('--timeout-ms', '240000')) });
}
main().catch(error => { process.stderr.write(`[attachments-e2e] ${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1; });
