import '../../../setup/test-setup.js';
import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type { ClaudeExecutable } from '../../../../configuration/index.js';
import { _testOnlyClaudePty, ClaudePtyProvider } from '../../../../runtime/claude/pty-provider.js';
import {
  commandAvailable,
  startLocalResponsesProxy,
} from '../../../helpers/runtime/real-codex-e2e-utils.js';
import {
  findLatestClaudeSessionJsonl,
  readClaudeSessionMirrorRecordStreamByFilePath,
} from '../../../../runtime/claude/session-jsonl.js';
import { createMirrorFeedbackController } from '../../../../bridge/mirror/feedback-controller.js';
import { buildMirrorDeliveryPlan } from '../../../../bridge/mirror/delivery-plan.js';
import { createMirrorSubscription } from '../../../../bridge/mirror/subscription-state.js';
import { consumeMirrorRecords } from '../../../../bridge/mirror/turns.js';
import { initBridgeTestContext, RecordingAdapter } from '../../../helpers/bridge/test-bridge-utils.js';

class RecordingStreamingAdapter extends RecordingAdapter {
  readonly mirrorStarts: Array<{ chatId: string; streamKey?: string }> = [];
  readonly streamTexts: Array<{ chatId: string; text: string; streamKey?: string }> = [];
  readonly streamEnds: Array<{ chatId: string; status: string; text: string; streamKey?: string }> = [];

  supportsStructuredStreamingUi(): boolean { return true; }
  hasActiveStreamingUi(): boolean { return true; }
  getStructuredStreamingUiMessageId(_chatId: string, streamKey?: string): string | null {
    return `fake-card-${streamKey || 'default'}`;
  }
  onMirrorStreamStart(chatId: string, streamKey?: string): void {
    this.mirrorStarts.push({ chatId, streamKey });
  }
  onStreamText(chatId: string, text: string, streamKey?: string): void {
    this.streamTexts.push({ chatId, text, streamKey });
  }
  async onStreamEnd(chatId: string, status: 'completed' | 'interrupted' | 'error', text: string, streamKey?: string): Promise<boolean> {
    this.streamEnds.push({ chatId, status, text, streamKey });
    return true;
  }
}

const execFileAsync = promisify(execFile);

const REAL_CLAUDE_E2E_ENV = 'CODELARK_REAL_CLAUDE_E2E';
const REAL_CLAUDE_CCR_FAKE_E2E_ENV = 'CODELARK_REAL_CLAUDE_CCR_FAKE_E2E';
const REAL_CLAUDE_EXECUTABLE_ENV = 'CODELARK_REAL_CLAUDE_E2E_EXECUTABLE';
const REAL_CLAUDE_PROMPT_ENV = 'CODELARK_REAL_CLAUDE_E2E_PROMPT';
const REAL_CLAUDE_EXPECT_ENV = 'CODELARK_REAL_CLAUDE_E2E_EXPECT';
const REAL_CLAUDE_MARKER = 'CODELARK_REAL_CLAUDE_E2E_SMOKE';

async function ptyRuntimeAvailable(): Promise<boolean> {
  try {
    const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<unknown>;
    await dynamicImport('@homebridge/node-pty-prebuilt-multiarch');
    return true;
  } catch {
    return false;
  }
}

function normalizeClaudeExecutable(value: string | undefined): ClaudeExecutable {
  return value?.trim() === 'claude' ? 'claude' : 'ccr';
}

async function readStream(stream: ReadableStream<string>): Promise<string> {
  let output = '';
  for await (const chunk of stream) {
    output += chunk;
  }
  return output;
}

async function reserveLocalPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

function copyFileIfExists(sourcePath: string, targetPath: string): void {
  if (!fs.existsSync(sourcePath) || fs.existsSync(targetPath)) return;
  if (!fs.statSync(sourcePath).isFile()) return;
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);
}

function copyJsonFileIfExists(sourcePath: string, targetPath: string, overrides: Record<string, unknown>): void {
  if (!fs.existsSync(sourcePath) || fs.existsSync(targetPath)) return;
  if (!fs.statSync(sourcePath).isFile()) return;
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const parsed = JSON.parse(fs.readFileSync(sourcePath, 'utf-8')) as Record<string, unknown>;
  fs.writeFileSync(targetPath, `${JSON.stringify({ ...parsed, ...overrides }, null, 2)}\n`, 'utf-8');
}

function copyHostClaudeRuntimeConfig(sourceHome: string, targetHome: string, ccrPort: number): void {
  for (const relativePath of [
    path.join('.claude', 'settings.json'),
    path.join('.claude', 'settings.local.json'),
    path.join('.claude', '.credentials.json'),
  ]) {
    copyFileIfExists(path.join(sourceHome, relativePath), path.join(targetHome, relativePath));
  }
  copyJsonFileIfExists(
    path.join(sourceHome, '.claude-code-router', 'config.json'),
    path.join(targetHome, '.claude-code-router', 'config.json'),
    { HOST: '127.0.0.1', PORT: ccrPort },
  );
}

async function withRealClaudeEnvironment<T>(fn: (workDir: string) => Promise<T>): Promise<T> {
  const previousEnv = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    CODELARK_CLAUDE_PTY_PROMPT_DELAY_MS: process.env.CODELARK_CLAUDE_PTY_PROMPT_DELAY_MS,
    CODELARK_CLAUDE_PTY_RESPONSE_QUIET_MS: process.env.CODELARK_CLAUDE_PTY_RESPONSE_QUIET_MS,
    CODELARK_CLAUDE_PTY_RESPONSE_TIMEOUT_MS: process.env.CODELARK_CLAUDE_PTY_RESPONSE_TIMEOUT_MS,
  };
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-real-claude-home-'));
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-real-claude-pty-'));
  const originalHome = process.env.CODELARK_TEST_ORIGINAL_HOME;
  if (originalHome) {
    copyHostClaudeRuntimeConfig(originalHome, homeDir, await reserveLocalPort());
  }
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  process.env.CODELARK_CLAUDE_PTY_PROMPT_DELAY_MS = process.env.CODELARK_CLAUDE_PTY_PROMPT_DELAY_MS || '1200';
  process.env.CODELARK_CLAUDE_PTY_RESPONSE_QUIET_MS = process.env.CODELARK_CLAUDE_PTY_RESPONSE_QUIET_MS || '2000';
  process.env.CODELARK_CLAUDE_PTY_RESPONSE_TIMEOUT_MS = process.env.CODELARK_CLAUDE_PTY_RESPONSE_TIMEOUT_MS || '120000';
  _testOnlyClaudePty.clear();

  try {
    return await fn(workDir);
  } finally {
    _testOnlyClaudePty.clear();
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function writeFakeCcrExecutable(binDir: string): string {
  const executablePath = path.join(binDir, process.platform === 'win32' ? 'ccr.cmd' : 'ccr');
  const nodeScriptPath = path.join(binDir, 'fake-ccr.cjs');
  fs.writeFileSync(nodeScriptPath, String.raw`#!/usr/bin/env node
const fs = require('node:fs');

const command = process.argv[2] || '';
const callsPath = process.env.CODELARK_FAKE_CCR_CALLS_PATH;
const runningPath = process.env.CODELARK_FAKE_CCR_RUNNING_PATH;

function record(extra = {}) {
  if (!callsPath) return;
  fs.appendFileSync(callsPath, JSON.stringify({
    command,
    argv: process.argv.slice(2),
    env: {
      ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
      ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      CODELARK_FAKE_CCR_BRIDGE_ENV: process.env.CODELARK_FAKE_CCR_BRIDGE_ENV,
    },
    ...extra,
  }) + '\n');
}

if (command === 'activate') {
  record();
  process.stdout.write('export ANTHROPIC_BASE_URL="http://127.0.0.1:3456"\n');
  process.stdout.write("export ANTHROPIC_AUTH_TOKEN='fake-router-token'\n");
  process.stdout.write('ANTHROPIC_API_KEY=\n');
  process.exit(0);
}

if (command === 'status') {
  const running = Boolean(runningPath && fs.existsSync(runningPath));
  record({ running });
  if (running) {
    process.stdout.write('📊 Claude Code Router Status\n');
    process.stdout.write('✅ Status: Running\n');
    process.stdout.write('🆔 Process ID: 12345\n');
    process.stdout.write('🚀 Ready to use!\n');
    process.exit(0);
  }
  process.stdout.write('❌ Status: Not Running\n');
  process.exit(1);
}

if (command === 'start') {
  record();
  if (runningPath) fs.writeFileSync(runningPath, 'running');
  process.exit(0);
}

if (command === 'code') {
  record();
  process.stdout.write('Claude Code v2.1.159\n');
  process.stdout.write('❯ ? for shortcuts · /effort\n');
  let responded = false;
  process.stdin.on('data', () => {
    if (responded) return;
    responded = true;
    record({ promptReceived: true });
    process.stdout.write('\nCODELARK_FAKE_CCR_ENV_OK ' + process.env.ANTHROPIC_AUTH_TOKEN + ' ' + process.env.CODELARK_FAKE_CCR_BRIDGE_ENV + '\n');
    process.stdout.write('❯ ? for shortcuts · /effort\n');
  });
  setInterval(() => {}, 1000);
  return;
}

record({ unsupported: true });
process.exit(2);
`, 'utf-8');

  if (process.platform === 'win32') {
    fs.writeFileSync(executablePath, `@echo off\r\n"${process.execPath}" "${nodeScriptPath}" %*\r\n`, 'utf-8');
  } else {
    fs.writeFileSync(executablePath, `#!/usr/bin/env sh\nexec "${process.execPath}" "${nodeScriptPath}" "$@"\n`, 'utf-8');
    fs.chmodSync(executablePath, 0o755);
  }
  return executablePath;
}

function readJsonLines<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

describe('real Claude Code pty provider e2e', () => {
  it('starts Claude Code Router and passes activation env into ccr code', { timeout: 30_000 }, async (t: TestContext) => {
    if (!(await ptyRuntimeAvailable())) {
      t.skip('node pty runtime is not available');
      return;
    }

    const previousEnv = {
      PATH: process.env.PATH,
      CODELARK_CLAUDE_CCR_START_TIMEOUT_MS: process.env.CODELARK_CLAUDE_CCR_START_TIMEOUT_MS,
      CODELARK_CLAUDE_PTY_PROMPT_DELAY_MS: process.env.CODELARK_CLAUDE_PTY_PROMPT_DELAY_MS,
      CODELARK_CLAUDE_PTY_JSONL_DISCOVERY_TIMEOUT_MS: process.env.CODELARK_CLAUDE_PTY_JSONL_DISCOVERY_TIMEOUT_MS,
      CODELARK_CLAUDE_PTY_RESPONSE_QUIET_MS: process.env.CODELARK_CLAUDE_PTY_RESPONSE_QUIET_MS,
      CODELARK_CLAUDE_PTY_RESPONSE_TIMEOUT_MS: process.env.CODELARK_CLAUDE_PTY_RESPONSE_TIMEOUT_MS,
      CODELARK_FAKE_CCR_BRIDGE_ENV: process.env.CODELARK_FAKE_CCR_BRIDGE_ENV,
      CODELARK_FAKE_CCR_CALLS_PATH: process.env.CODELARK_FAKE_CCR_CALLS_PATH,
      CODELARK_FAKE_CCR_RUNNING_PATH: process.env.CODELARK_FAKE_CCR_RUNNING_PATH,
    };
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-fake-ccr-e2e-'));
    const binDir = path.join(tempDir, 'bin');
    const workDir = path.join(tempDir, 'work');
    const callsPath = path.join(tempDir, 'calls.jsonl');
    const runningPath = path.join(tempDir, 'router-running');
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(workDir, { recursive: true });
    writeFakeCcrExecutable(binDir);

    process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH || ''}`;
    process.env.CODELARK_CLAUDE_CCR_START_TIMEOUT_MS = '3000';
    process.env.CODELARK_CLAUDE_PTY_PROMPT_DELAY_MS = '0';
    process.env.CODELARK_CLAUDE_PTY_JSONL_DISCOVERY_TIMEOUT_MS = '0';
    process.env.CODELARK_CLAUDE_PTY_RESPONSE_QUIET_MS = '300';
    process.env.CODELARK_CLAUDE_PTY_RESPONSE_TIMEOUT_MS = '5000';
    process.env.CODELARK_FAKE_CCR_BRIDGE_ENV = 'bridge-env-visible';
    process.env.CODELARK_FAKE_CCR_CALLS_PATH = callsPath;
    process.env.CODELARK_FAKE_CCR_RUNNING_PATH = runningPath;
    _testOnlyClaudePty.clear();

    try {
      const provider = new ClaudePtyProvider();
      const output = await readStream(provider.streamChat({
        prompt: 'verify fake ccr env',
        sessionId: `fake-ccr-env-${process.pid}-${Date.now()}`,
        runtime: 'claude',
        claudeExecutable: 'ccr',
        workingDirectory: workDir,
      }));

      assert.match(output, /CODELARK_FAKE_CCR_ENV_OK fake-router-token bridge-env-visible/);
      assert.match(output, /已为Claude Code sdk 注入 Router 环境。/);
      assert.doesNotMatch(output, /Claude Code Router 未运行，正在自动启动。/);
      assert.doesNotMatch(output, /已读取 Claude Code Router 环境变量/);
      const calls = readJsonLines<{
        command: string;
        running?: boolean;
        promptReceived?: boolean;
        env: Record<string, string | undefined>;
      }>(callsPath);
      const commands = calls.map((call) => call.command);
      assert.equal(commands[0], 'activate');
      assert.ok(commands.includes('start'), 'expected ccr start to be called');
      assert.ok(commands.includes('code'), 'expected ccr code to be launched');
      assert.ok(commands.indexOf('code') > commands.indexOf('activate'), 'expected activation before ccr code launch');
      assert.ok(calls.some((call) => call.command === 'status' && call.running === false));
      assert.ok(calls.some((call) => call.command === 'status' && call.running === true));
      assert.ok(fs.existsSync(runningPath), 'expected ccr start to mark router running');
      const codeCall = calls.find((call) => call.command === 'code');
      assert.equal(codeCall?.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:3456');
      assert.equal(codeCall?.env.ANTHROPIC_AUTH_TOKEN, 'fake-router-token');
      assert.equal(codeCall?.env.ANTHROPIC_API_KEY, '');
      assert.equal(codeCall?.env.CODELARK_FAKE_CCR_BRIDGE_ENV, 'bridge-env-visible');
      assert.ok(calls.some((call) => call.command === 'code' && call.promptReceived));
    } finally {
      _testOnlyClaudePty.clear();
      fs.rmSync(tempDir, { recursive: true, force: true });
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('submits a smoke prompt through real Claude Code pty', { timeout: 180_000 }, async (t: TestContext) => {
    if (process.env[REAL_CLAUDE_E2E_ENV] !== '1') {
      t.skip(`set ${REAL_CLAUDE_E2E_ENV}=1 to run real Claude Code e2e tests`);
      return;
    }
    if (!(await ptyRuntimeAvailable())) {
      t.skip('node pty runtime is not available');
      return;
    }

    const executable = normalizeClaudeExecutable(process.env[REAL_CLAUDE_EXECUTABLE_ENV]);
    const commandCheck = executable === 'ccr'
      ? await commandAvailable('ccr', ['-v'])
      : await commandAvailable('claude', ['--version']);
    if (!commandCheck) {
      t.skip(`${executable} executable is not available`);
      return;
    }

    await withRealClaudeEnvironment(async (workDir) => {
      const expected = process.env[REAL_CLAUDE_EXPECT_ENV] || REAL_CLAUDE_MARKER;
      const prompt = process.env[REAL_CLAUDE_PROMPT_ENV]
        || `Reply with exactly: ${expected}`;
      const provider = new ClaudePtyProvider();
      const output = await readStream(provider.streamChat({
        prompt,
        sessionId: `real-claude-pty-${process.pid}-${Date.now()}`,
        runtime: 'claude',
        claudeExecutable: executable,
        workingDirectory: workDir,
      }));

      const expectedPattern = new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      const expectedTailPattern = new RegExp(expected.slice(1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      assert.equal(
        expectedPattern.test(output) || expectedTailPattern.test(output),
        true,
        'real Claude Code output should include the requested smoke marker; TUI capture may replace the first character with a status glyph',
      );
      assert.equal(_testOnlyClaudePty.count(), 1);
    });
  });

  it('mirrors Claude Code jsonl from ccr code with a fake model backend', { timeout: 240_000 }, async (t: TestContext) => {
    if (process.env[REAL_CLAUDE_CCR_FAKE_E2E_ENV] !== '1') {
      t.skip(`set ${REAL_CLAUDE_CCR_FAKE_E2E_ENV}=1 to run fake CCR Claude Code jsonl mirror e2e`);
      return;
    }
    if (!(await ptyRuntimeAvailable())) {
      t.skip('node pty runtime is not available');
      return;
    }
    if (!(await commandAvailable('ccr', ['-v']))) {
      t.skip('ccr executable is not available');
      return;
    }

    const previousEnv = {
      HOME: process.env.HOME,
      CODELARK_CLAUDE_PTY_PROMPT_DELAY_MS: process.env.CODELARK_CLAUDE_PTY_PROMPT_DELAY_MS,
      CODELARK_CLAUDE_PTY_RESPONSE_QUIET_MS: process.env.CODELARK_CLAUDE_PTY_RESPONSE_QUIET_MS,
      CODELARK_CLAUDE_PTY_RESPONSE_TIMEOUT_MS: process.env.CODELARK_CLAUDE_PTY_RESPONSE_TIMEOUT_MS,
    };
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-real-ccr-home-'));
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-real-ccr-work-'));
    const responseText = `CODELARK_CCR_FAKE_JSONL_${process.pid}_${Date.now()}`;
    const proxy = await startLocalResponsesProxy({ responseText });
    const ccrPort = await reserveLocalPort();

    process.env.HOME = homeDir;
    process.env.CODELARK_CLAUDE_PTY_PROMPT_DELAY_MS = process.env.CODELARK_CLAUDE_PTY_PROMPT_DELAY_MS || '1200';
    process.env.CODELARK_CLAUDE_PTY_RESPONSE_QUIET_MS = process.env.CODELARK_CLAUDE_PTY_RESPONSE_QUIET_MS || '2000';
    process.env.CODELARK_CLAUDE_PTY_RESPONSE_TIMEOUT_MS = process.env.CODELARK_CLAUDE_PTY_RESPONSE_TIMEOUT_MS || '120000';
    _testOnlyClaudePty.clear();

    try {
      const ccrDir = path.join(homeDir, '.claude-code-router');
      fs.mkdirSync(ccrDir, { recursive: true });
      fs.writeFileSync(path.join(ccrDir, 'config.json'), JSON.stringify({
        LOG: false,
        HOST: '127.0.0.1',
        PORT: ccrPort,
        API_TIMEOUT_MS: '120000',
        Providers: [{
          name: 'clk-fake',
          api_base_url: `${proxy.baseUrl}/chat/completions`,
          api_key: 'clk-fake-key',
          models: ['clk-fake-claude'],
          transformer: { use: ['openrouter'] },
        }],
        Router: {
          default: 'clk-fake,clk-fake-claude',
          background: 'clk-fake,clk-fake-claude',
          think: 'clk-fake,clk-fake-claude',
          longContext: 'clk-fake,clk-fake-claude',
          webSearch: 'clk-fake,clk-fake-claude',
        },
      }, null, 2), 'utf-8');

      const provider = new ClaudePtyProvider();
      const prompt = `Reply with exactly: ${responseText}`;
      const output = await readStream(provider.streamChat({
        prompt,
        sessionId: `real-ccr-fake-${process.pid}-${Date.now()}`,
        runtime: 'claude',
        claudeExecutable: 'ccr',
        workingDirectory: workDir,
      }));

      assert.match(output, new RegExp(responseText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      const claudeJsonl = findLatestClaudeSessionJsonl(workDir, homeDir);
      assert.ok(claudeJsonl, 'expected Claude Code to write a jsonl transcript');
      const records = readClaudeSessionMirrorRecordStreamByFilePath(claudeJsonl.filePath);
      const subscription = {
        sessionId: 'bridge-session-ccr-fake',
        threadId: claudeJsonl.sessionId,
        pendingTurn: null,
        bufferedRecords: [],
      };
      const deliveryPlan = buildMirrorDeliveryPlan(subscription, records, {
        blocked: false,
        filterSuppressedRecords: (_sessionId, incoming) => incoming,
        flushTimedOutTurn: () => null,
        consumeBufferedTurns: (currentSubscription) => consumeMirrorRecords(currentSubscription, currentSubscription.bufferedRecords.splice(0)),
      });
      assert.equal(deliveryPlan.finalizedTurns.at(-1)?.text, responseText);

      initBridgeTestContext({ dynamicSettings: true });
      const adapter = new RecordingStreamingAdapter();
      const mirrorSubscription = createMirrorSubscription({
        bindingId: 'binding-ccr-fake-card',
        sessionId: 'bridge-session-ccr-fake-card',
        channelType: 'feishu',
        chatId: 'chat-ccr-fake-card',
        threadId: claudeJsonl.sessionId,
        filePath: claudeJsonl.filePath,
        lastDeliveredAt: null,
      });
      const feedback = createMirrorFeedbackController({
        getAdapter: () => adapter,
        getThreadTitle: () => 'Claude Code fake mirror',
        getStructuredStreamStatusConfig: () => ({ idleStartMs: 0, heartbeatMs: 1000 }),
        nowIso: () => new Date().toISOString(),
        eventBatchLimit: 10,
        deliverResponse: async () => ({ ok: true, messageId: 'fallback-delivery-not-used' }),
      });
      const finalizedTurns = consumeMirrorRecords(mirrorSubscription, records, feedback.hooks);
      assert.ok(finalizedTurns.some((turn) => turn.text.includes(responseText)));
      const cardDelivery = await feedback.deliverMirrorTurns(mirrorSubscription, finalizedTurns);
      assert.equal(cardDelivery.error, undefined);
      assert.ok(cardDelivery.deliveredCount >= 1);
      assert.ok(adapter.mirrorStarts.length >= 1);
      assert.ok(adapter.streamTexts.some((entry) => entry.text.includes(responseText)));
      assert.ok(adapter.streamEnds.some((entry) => entry.status === 'completed' && entry.text.includes(responseText)));
    } finally {
      _testOnlyClaudePty.clear();
      try {
        await execFileAsync('ccr', ['stop'], { env: { ...process.env, HOME: homeDir } });
      } catch {
        // The service may have already exited.
      }
      await proxy.close();
      fs.rmSync(homeDir, { recursive: true, force: true });
      fs.rmSync(workDir, { recursive: true, force: true });
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
