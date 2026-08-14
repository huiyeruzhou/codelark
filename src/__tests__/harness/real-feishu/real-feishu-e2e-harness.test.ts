import '../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { DEFAULT_WORKSPACE_ROOT } from '../../../configuration/paths.js';
import { startLocalCodexResponsesProxy } from '../../../testing/real-feishu/codex-responses-proxy.js';
import { serializeFailureError } from '../../../testing/real-feishu/failure-report.js';
import { containsGeneratedReplyTexts } from '../../../testing/real-feishu/reply-evidence.js';

const RUNTIME_PROVIDER_MATRIX_SUFFIXES = [
  'codex-sdk',
  'codex-tmux',
  'claude-sdk',
  'claude-tmux',
  'kimi-tmux',
  'cursor-tmux',
  'zcode-tmux',
];

describe('unit::real-feishu-e2e-harness::reply-evidence', () => {
  it('does not accept a marker that appears only in the echoed user history', () => {
    const marker = 'CODELARK_CURSOR_REPLY_EVIDENCE';
    const prompt = `Reply with exactly this marker and no other text: ${marker}`;
    const initialCard = `<card>\n▼ 历史记录\n**用户**：${prompt}\n> 正在初始化 Cursor\n▲\n</card>`;
    const completedCard = `${initialCard}\n${marker}`;

    assert.equal(containsGeneratedReplyTexts(initialCard, prompt, [marker]), false);
    assert.equal(containsGeneratedReplyTexts(completedCard, prompt, [marker]), true);
    assert.equal(containsGeneratedReplyTexts(marker, prompt, [marker]), true);
  });

  it('keeps a command token when the generated help card legitimately repeats it', () => {
    const source = '/new';
    const card = [
      '<card title="创建群聊会话">',
      '<form>',
      '[创建]',
      '</form>',
      '提交后等同发送 `/new <名称> <目录>`。',
      '</card>',
    ].join('\n');

    assert.equal(
      containsGeneratedReplyTexts(card, source, ['创建群聊会话', '[创建]', '提交后等同发送 `/new <名称> <目录>`。']),
      true,
    );
    assert.equal(containsGeneratedReplyTexts(source, source, [source]), false);
  });
});

function expectedRuntimeProviderMatrix(prefix: string): string[] {
  return RUNTIME_PROVIDER_MATRIX_SUFFIXES.map((suffix) => `${prefix}::${suffix}`);
}

function runIdToken(runId: string): string {
  return runId
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48)
    || 'RUN';
}

function commandStateFixtureCommand(runId: string): string {
  return `/file ${path.join(os.tmpdir(), `clk-real-feishu-${runId}`, 'fixtures', `codelark-file-${runIdToken(runId)}.txt`)}`;
}

function commandStateLargeFixtureCommand(runId: string): string {
  return `/file ${path.join(os.tmpdir(), `clk-real-feishu-${runId}`, 'fixtures', `codelark-large-file-${runIdToken(runId)}.bin`)}`;
}

function passingChecks(names: string[]): Array<{ name: string; ok: boolean; detail: string }> {
  return names.map((name) => ({ name, ok: true, detail: `${name} passed` }));
}

const COMMON_CANONICAL_CHECKS = [
  'canonical_report_eligible',
  'message_observations_passed',
  'final_feishu_transcript_present',
  'coverage_metadata_present',
  'created_chat_cleanup_completed',
  'scenario_created_chat_cleanup_completed',
  'scenario_created_chat_names_match_requests',
  'required_checks_passed',
  'unexpected_mirror_absent',
];

const KIMI_TMUX_CANONICAL_CHECKS = [
  'runtime_identity_bound',
  'kimi_wire_jsonl_found',
  'provider_output_path',
  'mirror_final_not_duplicated_in_direct_reply',
];

const KIMI_TMUX_SMOKE_CANONICAL_CHECKS = [
  ...COMMON_CANONICAL_CHECKS,
  ...KIMI_TMUX_CANONICAL_CHECKS,
];

const COMMAND_STATE_KIMI_CANONICAL_CHECKS = [
  ...COMMON_CANONICAL_CHECKS,
  ...KIMI_TMUX_CANONICAL_CHECKS,
  'runtime_prompt_final_transcript_marker',
  'command_state_runtime_settings_transcript',
  'command_state_file_and_large_file_transcript',
];

const RUNTIME_PROMPT_KIMI_CANONICAL_CHECKS = [
  ...COMMON_CANONICAL_CHECKS,
  ...KIMI_TMUX_CANONICAL_CHECKS,
  'runtime_prompt_final_transcript_marker',
];

const BASIC_DIALOGUE_KIMI_CANONICAL_CHECKS = [
  ...COMMON_CANONICAL_CHECKS,
  'basic_dialogue_stream_card_checkpoints',
  'basic_dialogue_terminal_append_input_delivered',
  'basic_dialogue_scripted_kimi_lifecycle_and_ctrl_s',
  'basic_dialogue_kimi_runtime_slot_persisted',
  'basic_dialogue_kimi_wire_transcript_read',
  'basic_dialogue_kimi_history_transcript_excludes_thinking',
  'basic_dialogue_kimi_thinking_status_only',
  'basic_dialogue_kimi_tool_card',
];

const SESSION_MANAGEMENT_KIMI_CANONICAL_CHECKS = [
  ...RUNTIME_PROMPT_KIMI_CANONICAL_CHECKS,
  'session_management_runtime_identity_transcript',
];

const HISTORY_SUITE_KIMI_CANONICAL_CHECKS = [
  ...RUNTIME_PROMPT_KIMI_CANONICAL_CHECKS,
  'history_suite_transcript_contract',
];

const AGENT_QUESTION_KIMI_CANONICAL_CHECKS = [
  ...COMMON_CANONICAL_CHECKS,
  ...KIMI_TMUX_CANONICAL_CHECKS,
  'agent_question_form_interactive_transcript',
];

const MARKDOWN_KIMI_CANONICAL_CHECKS = [
  ...RUNTIME_PROMPT_KIMI_CANONICAL_CHECKS,
  'markdown_rendering_transcript_structure',
];

function writeCanonicalReport(reportsDir: string, testName: string, checks: string[]): void {
  const safeName = testName
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  fs.writeFileSync(
    path.join(reportsDir, `${safeName}.json`),
    JSON.stringify({
      runId: `${safeName}-canonical`,
      dryRun: false,
      coverage: { testName },
      canonicalEligibility: { eligible: true, blockers: [] },
      checks: passingChecks(checks),
    }),
  );
}

function sessionManagementShellMarker(runId: string): string {
  return `CODELARK_SHELL_${runIdToken(runId)}`;
}

function sessionManagementShellCommand(runId: string): string {
  return `/shell --sandbox read-only printf ${sessionManagementShellMarker(runId)}`;
}

const staticHarnessOutputCache = new Map<string, string>();

function runHarness(args: string[], env: NodeJS.ProcessEnv = {}): string {
  const cacheKey = Object.keys(env).length === 0
    && args.length === 1
    && (args[0] === '--list-scenarios' || args[0] === '--help')
    ? args[0]
    : null;
  if (cacheKey && staticHarnessOutputCache.has(cacheKey)) {
    return staticHarnessOutputCache.get(cacheKey)!;
  }
  const output = execFileSync(
    process.execPath,
    ['--import', 'tsx', 'scripts/real-feishu-e2e.ts', ...args],
    {
      cwd: process.cwd(),
      encoding: 'utf-8',
      env: {
        ...process.env,
        ...env,
        NODE_OPTIONS: '',
      },
    },
  );
  if (cacheKey) staticHarnessOutputCache.set(cacheKey, output);
  return output;
}

function runHarnessFailure(args: string[], env: NodeJS.ProcessEnv = {}): string {
  try {
    execFileSync(
      process.execPath,
      ['--import', 'tsx', 'scripts/real-feishu-e2e.ts', ...args],
      {
        cwd: process.cwd(),
        encoding: 'utf-8',
        env: {
          ...process.env,
          ...env,
          NODE_OPTIONS: '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  } catch (error) {
    const failure = error as { stderr?: Buffer | string; stdout?: Buffer | string };
    return `${failure.stdout ? String(failure.stdout) : ''}${failure.stderr ? String(failure.stderr) : ''}`;
  }
  assert.fail(`Expected harness failure for args: ${args.join(' ')}`);
}

function installFakeNpxForLarkAuthStatus(payload: unknown): string {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-fake-npx-'));
  const executable = path.join(binDir, 'npx');
  fs.writeFileSync(
    executable,
    [
      '#!/usr/bin/env node',
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      'const args = process.argv.slice(2);',
      'if (args[0] === "lark-cli" && args.includes("config") && args.includes("init")) {',
      '  const appId = args[args.indexOf("--app-id") + 1] || "cli_fake";',
      '  const brand = args[args.indexOf("--brand") + 1] || "feishu";',
      '  const home = process.env.HOME || process.env.USERPROFILE;',
      '  if (home) {',
      '    const configPath = path.join(home, ".lark-cli", "config.json");',
      '    fs.mkdirSync(path.dirname(configPath), { recursive: true });',
      '    fs.writeFileSync(configPath, JSON.stringify({ apps: [{ appId, brand, defaultAs: "auto", strictMode: "off" }] }, null, 2));',
      '  }',
      '  console.log(JSON.stringify({ ok: true }));',
      '  process.exit(0);',
      '}',
      'if (args[0] === "lark-cli" && args.includes("auth") && args.includes("status")) {',
      '  if (process.env.FAKE_NPX_ENV_LOG) {',
      '    fs.writeFileSync(process.env.FAKE_NPX_ENV_LOG, JSON.stringify({',
      '      HOME: process.env.HOME || "",',
      '      USERPROFILE: process.env.USERPROFILE || "",',
      '      LARKSUITE_CLI_CONFIG_DIR: process.env.LARKSUITE_CLI_CONFIG_DIR || "",',
      '      XDG_DATA_HOME: process.env.XDG_DATA_HOME || ""',
      '    }, null, 2));',
      '  }',
      `  console.log(${JSON.stringify(JSON.stringify(payload))});`,
      '  process.exit(0);',
      '}',
      'console.error(`unexpected fake npx command: ${args.join(" ")}`);',
      'process.exit(1);',
      '',
    ].join('\n'),
    { encoding: 'utf-8', mode: 0o755 },
  );
  return binDir;
}

function expectationAt(
  expectations: Array<{
    command: string;
    expectedTexts: string[];
    expectedForbiddenTexts?: string[];
    expectedReplyMessageTypes?: string[];
    expectedReplyContentKeys?: string[];
    observationMode?: string;
    replyTimeoutMs?: number;
    reason?: string;
  }>,
  command: string,
  occurrence = 0,
): {
  command: string;
  expectedTexts: string[];
  expectedForbiddenTexts?: string[];
  expectedReplyMessageTypes?: string[];
  expectedReplyContentKeys?: string[];
  observationMode?: string;
  replyTimeoutMs?: number;
  reason?: string;
} {
  const matches = expectations.filter((item) => item.command === command);
  const found = matches[occurrence];
  assert.ok(found, `expected commandReplyExpectation for ${command} occurrence ${occurrence}`);
  return found;
}

describe('unit::real-feishu-e2e-harness::failure-report-diagnostics', () => {
  it('serializes thrown errors for real Feishu failure reports', () => {
    const inner = new Error('inner mirror wait failed');
    const outer = new Error('outer Kimi transcript gate failed') as Error & { cause?: unknown };
    outer.cause = inner;

    const serialized = serializeFailureError(outer);

    assert.equal(serialized.name, 'Error');
    assert.equal(serialized.message, 'outer Kimi transcript gate failed');
    assert.match(serialized.stack || '', /outer Kimi transcript gate failed/);
    assert.equal(serialized.cause?.message, 'inner mirror wait failed');
    assert.deepEqual(
      serializeFailureError('plain failure'),
      { message: 'plain failure' },
    );
  });
});

describe('unit::real-feishu-e2e-harness::auth-preflight', () => {
  it('refuses a second isolated bridge when the live bridge uses the same Feishu app', () => {
    const liveHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-live-same-app-home-'));
    fs.mkdirSync(path.join(liveHome, 'runtime'), { recursive: true });
    fs.writeFileSync(
      path.join(liveHome, 'config.toml'),
      [
        'schema_version = 2',
        '',
        '[[channels]]',
        'id = "feishu-default"',
        'alias = "Feishu"',
        'provider = "feishu"',
        'enabled = true',
        '',
        '[channels.config]',
        'app_id = "cli_same_app_guard"',
        'app_secret = "test-secret"',
        'site = "feishu"',
        '',
      ].join('\n'),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(liveHome, 'runtime', 'status.json'),
      JSON.stringify({ running: true, pid: process.pid, channels: ['feishu-default'] }),
      'utf-8',
    );

    const output = runHarnessFailure([
      '--scenario',
      'basic-dialogue-suite',
      '--scripted-basic-dialogue',
      '--fake-ccr',
      '--launch-bridge',
      '--test-feishu-app-id',
      'cli_same_app_guard',
      '--test-feishu-app-secret',
      'test-secret',
      '--run-id',
      'same-app-guard',
    ], {
      CODELARK_REAL_FEISHU_E2E: '1',
      CODELARK_HOME: liveHome,
    });

    assert.match(output, /Refusing to launch a second bridge for Feishu test app cli_same_app_guard/);
    assert.match(output, /live_bridge_count=1/);
    assert.match(output, /live_clk_home=/);
    assert.match(output, /test_clk_home=/);
    assert.match(output, /events are load-balanced, not broadcast/);
    assert.match(output, /Use the separate test Feishu app/);
    assert.match(output, /stop\/switch the live bridge first/);
    assert.doesNotMatch(output, /allow-concurrent-app/);
  });

  it('refuses a test app already used by a live sibling CodeLark home', () => {
    const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-live-sibling-app-root-'));
    const primaryHome = path.join(homeRoot, '.codelark');
    const siblingHome = path.join(homeRoot, '.codelark-coding-agent');
    fs.mkdirSync(path.join(primaryHome, 'runtime'), { recursive: true });
    fs.mkdirSync(path.join(siblingHome, 'runtime'), { recursive: true });
    fs.writeFileSync(
      path.join(siblingHome, 'config.toml'),
      [
        'schema_version = 2',
        '',
        '[[channels]]',
        'id = "feishu-coding-agent"',
        'alias = "Coding Agent"',
        'provider = "feishu"',
        'enabled = true',
        '',
        '[channels.config]',
        'app_id = "cli_sibling_app_guard"',
        'app_secret = "test-secret"',
        'site = "feishu"',
        '',
      ].join('\n'),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(siblingHome, 'runtime', 'status.json'),
      JSON.stringify({ running: true, pid: process.pid, channels: ['feishu-coding-agent'] }),
      'utf-8',
    );

    try {
      const output = runHarnessFailure([
        '--scenario',
        'runtime-message',
        '--launch-bridge',
        '--test-feishu-app-id',
        'cli_sibling_app_guard',
        '--test-feishu-app-secret',
        'test-secret',
        '--run-id',
        'sibling-app-guard',
      ], {
        CODELARK_REAL_FEISHU_E2E: '1',
        CODELARK_HOME: primaryHome,
        HOME: homeRoot,
      });

      assert.match(output, /Refusing to launch a second bridge for Feishu test app cli_sibling_app_guard/);
      assert.match(output, /live_bridge_count=1/);
      assert.match(output, new RegExp(siblingHome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(output, new RegExp(`live_pid=${process.pid}`));
      assert.match(output, /live_channels=feishu-coding-agent/);
      assert.doesNotMatch(output, /Launching isolated bridge/);
    } finally {
      fs.rmSync(homeRoot, { recursive: true, force: true });
    }
  });

  it('refuses a live same-app bridge whose CODELARK_HOME is outside the sibling-home tree', () => {
    if (process.platform !== 'linux') return;
    const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-live-primary-app-root-'));
    const primaryHome = path.join(homeRoot, '.codelark');
    const detachedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-live-detached-app-home-'));
    fs.mkdirSync(path.join(primaryHome, 'runtime'), { recursive: true });
    fs.mkdirSync(path.join(detachedHome, 'runtime'), { recursive: true });
    fs.writeFileSync(
      path.join(detachedHome, 'config.toml'),
      [
        'schema_version = 2',
        '',
        '[[channels]]',
        'id = "feishu-detached"',
        'alias = "Detached Feishu"',
        'provider = "feishu"',
        'enabled = true',
        '',
        '[channels.config]',
        'app_id = "cli_detached_app_guard"',
        'app_secret = "test-secret"',
        'site = "feishu"',
        '',
      ].join('\n'),
      'utf-8',
    );
    const bridge = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      env: { ...process.env, CODELARK_HOME: detachedHome },
      stdio: 'ignore',
    });

    try {
      assert.ok(bridge.pid);
      fs.writeFileSync(
        path.join(detachedHome, 'runtime', 'status.json'),
        JSON.stringify({ running: true, pid: bridge.pid, channels: ['feishu-detached'] }),
        'utf-8',
      );
      const output = runHarnessFailure([
        '--scenario',
        'runtime-message',
        '--launch-bridge',
        '--test-feishu-app-id',
        'cli_detached_app_guard',
        '--test-feishu-app-secret',
        'test-secret',
        '--run-id',
        'detached-app-guard',
      ], {
        CODELARK_REAL_FEISHU_E2E: '1',
        CODELARK_HOME: primaryHome,
        HOME: homeRoot,
      });

      assert.match(output, /Refusing to launch a second bridge for Feishu test app cli_detached_app_guard/);
      assert.match(output, new RegExp(detachedHome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(output, new RegExp(`live_pid=${bridge.pid}`));
      assert.doesNotMatch(output, /Launching isolated bridge/);
    } finally {
      bridge.kill('SIGTERM');
      fs.rmSync(homeRoot, { recursive: true, force: true });
      fs.rmSync(detachedHome, { recursive: true, force: true });
    }
  });

  it('fails before running real Feishu actions when lark-cli has no user authorization', () => {
    const fakeBin = installFakeNpxForLarkAuthStatus({
      appId: 'cli_test',
      identities: {
        bot: {
          status: 'ready',
          available: true,
          verified: true,
        },
      },
    });
    const output = runHarnessFailure([
      '--scenario',
      'message-only',
      '--chat-id',
      'oc_test',
      '--runtime',
      'codex',
      '--provider',
      'sdk',
      '--run-id',
      'auth-preflight',
      '--launch-bridge',
      '--test-feishu-app-id',
      'cli_auth_preflight_test',
      '--test-feishu-app-secret',
      'test-secret',
    ], {
      CODELARK_REAL_FEISHU_E2E: '1',
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
      HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'clk-auth-preflight-home-')),
    });

    assert.match(output, /lark-cli user authorization preflight failed before running real Feishu E2E/);
    assert.match(output, /user_open_id=-/);
    assert.match(output, /lark-cli auth login --scope/);
  });

  it('fails preflight when lark-cli user auth lacks message send scope', () => {
    const fakeBin = installFakeNpxForLarkAuthStatus({
      appId: 'cli_auth_scope_test',
      identities: {
        bot: {
          status: 'ready',
          available: true,
          verified: true,
        },
        user: {
          status: 'ready',
          available: true,
          verified: true,
          openId: 'ou_scope_test',
          tokenStatus: 'valid',
          scope: [
            'im:chat',
            'im:chat:read',
            'im:chat:create_by_user',
            'im:chat:delete',
            'im:message.group_msg:get_as_user',
            'im:message.p2p_msg:get_as_user',
          ].join(' '),
        },
      },
    });
    const output = runHarnessFailure([
      '--scenario',
      'message-only',
      '--chat-id',
      'oc_test',
      '--runtime',
      'kimi',
      '--provider',
      'tmux',
      '--run-id',
      'auth-scope-preflight',
      '--launch-bridge',
      '--test-feishu-app-id',
      'cli_auth_scope_test',
      '--test-feishu-app-secret',
      'test-secret',
    ], {
      CODELARK_REAL_FEISHU_E2E: '1',
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
      HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'clk-auth-scope-home-')),
    });

    assert.match(output, /lark-cli user authorization preflight failed before running real Feishu E2E/);
    assert.match(output, /missing_scopes=im:message\.send_as_user/);
    assert.doesNotMatch(output, /Launching isolated bridge/);
  });

  it('requires exact lark-cli read scopes instead of accepting umbrella message scope aliases', () => {
    const fakeBin = installFakeNpxForLarkAuthStatus({
      appId: 'cli_auth_exact_scope_test',
      identities: {
        bot: {
          status: 'ready',
          available: true,
          verified: true,
        },
        user: {
          status: 'ready',
          available: true,
          verified: true,
          openId: 'ou_scope_test',
          tokenStatus: 'valid',
          scope: [
            'im:chat:read',
            'im:chat:delete',
            'im:message',
            'im:message.send_as_user',
          ].join(' '),
        },
      },
    });
    const output = runHarnessFailure([
      '--scenario',
      'message-only',
      '--chat-id',
      'oc_test',
      '--runtime',
      'kimi',
      '--provider',
      'tmux',
      '--run-id',
      'auth-exact-scope-preflight',
      '--launch-bridge',
      '--test-feishu-app-id',
      'cli_auth_exact_scope_test',
      '--test-feishu-app-secret',
      'test-secret',
    ], {
      CODELARK_REAL_FEISHU_E2E: '1',
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
      HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'clk-auth-exact-scope-home-')),
    });

    assert.match(output, /lark-cli user authorization preflight failed before running real Feishu E2E/);
    assert.match(output, /missing_scopes=im:message\.group_msg:get_as_user, im:message\.p2p_msg:get_as_user/);
    assert.doesNotMatch(output, /Launching isolated bridge/);
  });

  it('uses the current lark-cli user auth environment without copying user tokens into the isolated bridge home', () => {
    const fakeBin = installFakeNpxForLarkAuthStatus({
      appId: 'cli_host_auth_env_test',
      identities: {
        bot: {
          status: 'ready',
          available: true,
          verified: true,
        },
        user: {
          status: 'ready',
          available: true,
          verified: true,
          openId: 'ou_host_auth_user',
          tokenStatus: 'valid',
          scope: 'im:chat:read im:message.send_as_user im:message.group_msg:get_as_user im:message.p2p_msg:get_as_user',
        },
      },
    });
    const authHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-host-lark-auth-env-'));
    const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-real-feishu-host-auth-env-'));
    const envLog = path.join(runRoot, 'auth-env.json');

    try {
      const output = runHarnessFailure([
        '--scenario',
        'message-only',
        '--runtime',
        'kimi',
        '--provider',
        'tmux',
        '--run-root',
        runRoot,
        '--keep-clk-home',
        '--launch-bridge',
        '--test-feishu-app-id',
        'cli_host_auth_env_test',
        '--test-feishu-app-secret',
        'test-secret',
      ], {
        CODELARK_REAL_FEISHU_E2E: '1',
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
        CODELARK_REAL_FEISHU_AUTH_HOME: authHome,
        FAKE_NPX_ENV_LOG: envLog,
        CODELARK_HOME: path.join(authHome, '.codelark-live-empty'),
      });

      assert.match(output, /lark-cli user authorization preflight failed before running real Feishu E2E/);
      assert.match(output, new RegExp(`home=${authHome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      assert.match(output, /missing_scopes=im:chat:delete/);
      assert.doesNotMatch(output, /im:chat:create_by_user/);
      assert.doesNotMatch(output, /Copied host lark-cli user auth into isolated HOME=/);
      const env = JSON.parse(fs.readFileSync(envLog, 'utf-8')) as { HOME: string; USERPROFILE: string };
      assert.equal(env.HOME, authHome);
      assert.equal(env.USERPROFILE, authHome);
      const isolatedDataDir = path.join(runRoot, 'runtime-home', '.local', 'share', 'lark-cli');
      assert.equal(fs.existsSync(isolatedDataDir), false);
    } finally {
      fs.rmSync(authHome, { recursive: true, force: true });
      fs.rmSync(runRoot, { recursive: true, force: true });
      fs.rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it('rejects removed real Feishu escape switches instead of keeping compatibility paths', () => {
    for (const flag of ['--create-chat', '--source-chat-id', '--allow-concurrent-app']) {
      const output = runHarnessFailure([
        '--dry-run',
        flag,
        '--scenario',
        'message-only',
        '--runtime',
        'kimi',
        '--provider',
        'tmux',
      ]);

      assert.match(output, new RegExp(`Unknown option: ${flag}`));
    }
  });

  it('rejects removed coverage shortcut switches as unknown options', () => {
    for (const flag of ['--require-kimi-current-canonical', '--require-kimi-canonical']) {
      const output = runHarnessFailure([
        '--coverage-matrix',
        flag,
      ]);

      assert.match(output, new RegExp(`Unknown option: ${flag}`));
    }
  });

  it('rejects invalid enum-like option values instead of silently falling back', () => {
    assert.match(
      runHarnessFailure(['--dry-run', '--runtime', 'kimi-code']),
      /Invalid runtime "kimi-code"/,
    );
    assert.match(
      runHarnessFailure(['--dry-run', '--claude-executable', 'claude-code']),
      /Invalid Claude executable "claude-code"/,
    );
    assert.match(
      runHarnessFailure(['--dry-run', '--feishu-site', 'cn']),
      /Invalid Feishu site "cn"/,
    );
    assert.match(
      runHarnessFailure(['--dry-run', '--timeout-ms', 'soon']),
      /Invalid --timeout-ms "soon"/,
    );
    assert.match(
      runHarnessFailure(['--dry-run', '--poll-ms', '0']),
      /Invalid --poll-ms "0"/,
    );
  });

  it('restricts fake Kimi to the real Kimi tmux runtime', () => {
    assert.match(
      runHarnessFailure(['--dry-run', '--fake-kimi', '--runtime', 'codex', '--provider', 'tmux']),
      /--fake-kimi requires --runtime kimi --provider tmux/,
    );
    assert.match(
      runHarnessFailure([
        '--dry-run',
        '--fake-kimi',
        '--scripted-kimi',
        '--scenario',
        'runtime-message',
        '--runtime',
        'kimi',
        '--provider',
        'tmux',
      ]),
      /--fake-kimi cannot be combined with a scripted Kimi executable/,
    );
  });

  it('copies host Kimi auth into isolated KIMI_CODE_HOME without copying sessions', () => {
    const fakeBin = installFakeNpxForLarkAuthStatus({
      appId: 'cli_kimi_auth_copy_test',
      identities: {
        bot: {
          status: 'ready',
          available: true,
          verified: true,
        },
      },
    });
    const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-host-kimi-auth-'));
    const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-real-feishu-kimi-auth-copy-'));
    const hostConfigPath = path.join(hostHome, '.lark-cli', 'config.json');
    const hostDataDir = path.join(hostHome, '.local', 'share', 'lark-cli');
    const hostKimiHome = path.join(hostHome, '.kimi-code');
    fs.mkdirSync(path.dirname(hostConfigPath), { recursive: true });
    fs.mkdirSync(hostDataDir, { recursive: true });
    fs.mkdirSync(path.join(hostKimiHome, 'credentials'), { recursive: true });
    fs.mkdirSync(path.join(hostKimiHome, 'oauth'), { recursive: true });
    fs.mkdirSync(path.join(hostKimiHome, 'sessions', 'wd_live', 'session_live'), { recursive: true });
    fs.writeFileSync(
      hostConfigPath,
      JSON.stringify({
        apps: [{
          appId: 'cli_kimi_auth_copy_test',
          brand: 'feishu',
          users: [{ userOpenId: 'ou_kimi_auth_copy_user', userName: 'Kimi Auth Copy User' }],
        }],
      }),
      'utf-8',
    );
    fs.writeFileSync(path.join(hostDataDir, 'master.key'), 'host-master-key', 'utf-8');
    fs.writeFileSync(path.join(hostDataDir, 'appsecret_cli_kimi_auth_copy_test.enc'), 'host-app-secret', 'utf-8');
    fs.writeFileSync(path.join(hostDataDir, 'cli_kimi_auth_copy_test_ou_kimi_auth_copy_user.enc'), 'host-user-token', 'utf-8');
    fs.writeFileSync(path.join(hostKimiHome, 'credentials', 'kimi-code.json'), '{"token":"fake"}\n', 'utf-8');
    fs.writeFileSync(path.join(hostKimiHome, 'oauth', 'kimi-code'), '', 'utf-8');
    fs.writeFileSync(path.join(hostKimiHome, 'config.toml'), 'model = "kimi"\n', 'utf-8');
    fs.writeFileSync(path.join(hostKimiHome, 'tui.toml'), 'theme = "dark"\n', 'utf-8');
    fs.writeFileSync(path.join(hostKimiHome, 'device_id'), 'device-id\n', 'utf-8');
    fs.writeFileSync(path.join(hostKimiHome, 'sessions', 'wd_live', 'session_live', 'wire.jsonl'), '{}\n', 'utf-8');

    try {
      const output = runHarnessFailure([
        '--scenario',
        'message-only',
        '--chat-id',
        'oc_test',
        '--runtime',
        'kimi',
        '--provider',
        'tmux',
        '--run-id',
        'kimi-auth-copy',
        '--run-root',
        runRoot,
        '--keep-clk-home',
        '--launch-bridge',
        '--test-feishu-app-id',
        'cli_kimi_auth_copy_test',
        '--test-feishu-app-secret',
        'test-secret',
      ], {
        CODELARK_REAL_FEISHU_E2E: '1',
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
        HOME: hostHome,
        XDG_DATA_HOME: path.join(hostHome, '.local', 'share'),
        CODELARK_HOME: path.join(hostHome, '.codelark-live-empty'),
        CODELARK_REAL_FEISHU_TEST_KIMI_HOME: hostKimiHome,
      });

      assert.doesNotMatch(output, /Copied host lark-cli user auth into isolated HOME=/);
      const isolatedKimiHome = path.join(runRoot, 'runtime-home', '.kimi-code');
      assert.equal(fs.readFileSync(path.join(isolatedKimiHome, 'credentials', 'kimi-code.json'), 'utf-8'), '{"token":"fake"}\n');
      assert.equal(fs.readFileSync(path.join(isolatedKimiHome, 'config.toml'), 'utf-8'), 'model = "kimi"\n');
      assert.equal(fs.readFileSync(path.join(isolatedKimiHome, 'tui.toml'), 'utf-8'), 'theme = "dark"\n');
      assert.equal(fs.readFileSync(path.join(isolatedKimiHome, 'device_id'), 'utf-8'), 'device-id\n');
      assert.equal(fs.existsSync(path.join(isolatedKimiHome, 'sessions')), false);
    } finally {
      fs.rmSync(hostHome, { recursive: true, force: true });
      fs.rmSync(runRoot, { recursive: true, force: true });
      fs.rmSync(fakeBin, { recursive: true, force: true });
    }
  });
});

describe('unit::real-feishu-e2e-harness::scenario-coverage-metadata', () => {
  it('keeps Kimi, Cursor, and ZCode coverage inside the real Feishu runtime/provider matrix', () => {
    const output = runHarness(['--list-scenarios']);
    const parsed = JSON.parse(output) as {
      scenarios: Array<{
        scenario: string;
        testNamePattern: string;
        providerCoverage: string;
        providerMatrix: string[];
        providerSequence?: string[];
      }>;
    };
    const runtimeParameterized = parsed.scenarios.filter((item) => item.providerCoverage === 'runtime-parameterized');

    assert.ok(runtimeParameterized.length > 0);
    for (const scenario of runtimeParameterized) {
      assert.equal(scenario.testNamePattern, `real-feishu::${scenario.scenario}::<runtime>-<provider>`);
      assert.deepEqual(scenario.providerMatrix, expectedRuntimeProviderMatrix(`real-feishu::${scenario.scenario}`));
      assert.equal(
        scenario.providerMatrix.filter((name) => name.endsWith('::kimi-tmux')).length,
        1,
        `${scenario.scenario} should include Kimi exactly once through the shared matrix`,
      );
      assert.equal(
        scenario.providerMatrix.filter((name) => name.endsWith('::cursor-tmux')).length,
        1,
        `${scenario.scenario} should include Cursor exactly once through the shared matrix`,
      );
      assert.equal(
        scenario.providerMatrix.filter((name) => name.endsWith('::zcode-tmux')).length,
        1,
        `${scenario.scenario} should include ZCode exactly once through the shared matrix`,
      );
    }

    const basicDialogue = parsed.scenarios.find((item) => item.scenario === 'basic-dialogue-suite');
    assert.ok(basicDialogue);
    assert.equal(basicDialogue.providerCoverage, 'cross-provider-suite');
    assert.deepEqual(basicDialogue.providerSequence, [
      'codex-sdk',
      'claude-sdk',
      'kimi-tmux',
      'codex-tmux',
    ]);

    const helpText = runHarness(['--help']);
    assert.match(helpText, /--runtime <claude\|codex\|kimi\|cursor\|zcode>/);
    assert.doesNotMatch(helpText, /--kimi[\w-]*/);
  });

  it('exposes session-management as a dual runtime/provider real Feishu scenario', () => {
    const output = runHarness(['--list-scenarios']);
    const parsed = JSON.parse(output) as {
      scenarios: Array<{
        scenario: string;
        testNamePattern: string;
        providerCoverage: string;
        providerMatrix: string[];
        requiresRuntimeOutput: boolean;
        unitCoverage: string[];
        e2eCoverage: string[];
      }>;
    };
    const scenario = parsed.scenarios.find((item) => item.scenario === 'session-management');

    assert.ok(scenario);
    assert.equal(scenario.testNamePattern, 'real-feishu::session-management::<runtime>-<provider>');
    assert.equal(scenario.providerCoverage, 'runtime-parameterized');
    assert.deepEqual(scenario.providerMatrix, expectedRuntimeProviderMatrix('real-feishu::session-management'));
    assert.ok(scenario.unitCoverage.includes('unit::help-command::slash-command-groups'));
    assert.ok(scenario.unitCoverage.includes('unit::command-dispatch::new-session'));
    assert.ok(scenario.unitCoverage.includes('unit::command-dispatch::clear-session-runtime-preservation'));
    assert.ok(scenario.unitCoverage.includes('unit::command-dispatch::shell-command'));
    assert.ok(scenario.unitCoverage.includes('unit::command-dispatch::thread-list-unbind-archive'));
    assert.ok(scenario.unitCoverage.includes('unit::bridge-command-e2e::history-commands'));
    assert.ok(scenario.e2eCoverage.includes('e2e::new-session-binding'));
    assert.ok(scenario.e2eCoverage.includes('e2e::clear-session-runtime-binding'));
    assert.ok(scenario.e2eCoverage.includes('e2e::shell-command-sandbox-reply'));
    assert.ok(scenario.e2eCoverage.includes('e2e::thread-list-card-response'));
    assert.ok(scenario.e2eCoverage.includes('e2e::thread-unbind-temporary-session'));
    assert.ok(scenario.e2eCoverage.includes('e2e::thread-archive-current-runtime-session'));
    assert.ok(scenario.e2eCoverage.includes('e2e::history-command-response'));
  });

  it('exposes command-state local file coverage through the shared runtime/provider matrix', () => {
    const output = runHarness(['--list-scenarios']);
    const parsed = JSON.parse(output) as {
      scenarios: Array<{
        scenario: string;
        testNamePattern: string;
        providerCoverage: string;
        providerMatrix: string[];
        requiresRuntimeOutput: boolean;
        unitCoverage: string[];
        e2eCoverage: string[];
      }>;
    };
    const scenario = parsed.scenarios.find((item) => item.scenario === 'command-state');

    assert.ok(scenario);
    assert.equal(scenario.testNamePattern, 'real-feishu::command-state::<runtime>-<provider>');
    assert.equal(scenario.providerCoverage, 'runtime-parameterized');
    assert.deepEqual(scenario.providerMatrix, expectedRuntimeProviderMatrix('real-feishu::command-state'));
    assert.ok(scenario.unitCoverage.includes('unit::bridge-command-e2e::file-command-local-file'));
    assert.ok(scenario.unitCoverage.includes('unit::bridge-command-e2e::large-file-upload-confirmation'));
    assert.ok(scenario.e2eCoverage.includes('e2e::file-command-feishu-file-reply'));
    assert.ok(scenario.e2eCoverage.includes('e2e::large-file-confirmation-card-reply'));
  });

  it('exposes history-boundaries as a dual runtime/provider real Feishu scenario', () => {
    const output = runHarness(['--list-scenarios']);
    const parsed = JSON.parse(output) as {
      scenarios: Array<{
        scenario: string;
        testNamePattern: string;
        providerCoverage: string;
        providerMatrix: string[];
        unitCoverage: string[];
        e2eCoverage: string[];
      }>;
    };
    const scenario = parsed.scenarios.find((item) => item.scenario === 'history-boundaries');

    assert.ok(scenario);
    assert.equal(scenario.testNamePattern, 'real-feishu::history-boundaries::<runtime>-<provider>');
    assert.equal(scenario.providerCoverage, 'runtime-parameterized');
    assert.deepEqual(scenario.providerMatrix, expectedRuntimeProviderMatrix('real-feishu::history-boundaries'));
    assert.ok(scenario.unitCoverage.includes('unit::bridge-command-e2e::history-commands'));
    assert.ok(scenario.e2eCoverage.includes('e2e::history-raw-response'));
    assert.ok(scenario.e2eCoverage.includes('e2e::history-limit-update'));
  });

  it('exposes history-empty-isolation as a dual runtime/provider real Feishu scenario', () => {
    const output = runHarness(['--list-scenarios']);
    const parsed = JSON.parse(output) as {
      scenarios: Array<{
        scenario: string;
        testNamePattern: string;
        providerCoverage: string;
        providerMatrix: string[];
        unitCoverage: string[];
        e2eCoverage: string[];
      }>;
    };
    const scenario = parsed.scenarios.find((item) => item.scenario === 'history-empty-isolation');

    assert.ok(scenario);
    assert.equal(scenario.testNamePattern, 'real-feishu::history-empty-isolation::<runtime>-<provider>');
    assert.equal(scenario.providerCoverage, 'runtime-parameterized');
    assert.deepEqual(scenario.providerMatrix, expectedRuntimeProviderMatrix('real-feishu::history-empty-isolation'));
    assert.ok(scenario.unitCoverage.includes('unit::bridge-command-e2e::history-commands'));
    assert.ok(scenario.e2eCoverage.includes('e2e::history-empty-response'));
    assert.ok(scenario.e2eCoverage.includes('e2e::history-cross-chat-isolation'));
  });

  it('exposes history-long-truncation as a dual runtime/provider real Feishu scenario', () => {
    const output = runHarness(['--list-scenarios']);
    const parsed = JSON.parse(output) as {
      scenarios: Array<{
        scenario: string;
        testNamePattern: string;
        providerCoverage: string;
        providerMatrix: string[];
        unitCoverage: string[];
        e2eCoverage: string[];
      }>;
    };
    const scenario = parsed.scenarios.find((item) => item.scenario === 'history-long-truncation');

    assert.ok(scenario);
    assert.equal(scenario.testNamePattern, 'real-feishu::history-long-truncation::<runtime>-<provider>');
    assert.equal(scenario.providerCoverage, 'runtime-parameterized');
    assert.deepEqual(scenario.providerMatrix, expectedRuntimeProviderMatrix('real-feishu::history-long-truncation'));
    assert.ok(scenario.unitCoverage.includes('unit::bridge-command-e2e::history-long-truncation'));
    assert.ok(scenario.e2eCoverage.includes('e2e::history-long-raw-truncation'));
    assert.ok(scenario.e2eCoverage.includes('e2e::history-forbidden-tail-marker'));
  });

  it('exposes history-suite as a dual runtime/provider real Feishu scenario', () => {
    const output = runHarness(['--list-scenarios']);
    const parsed = JSON.parse(output) as {
      scenarios: Array<{
        scenario: string;
        testNamePattern: string;
        providerCoverage: string;
        providerMatrix: string[];
        unitCoverage: string[];
        e2eCoverage: string[];
      }>;
    };
    const scenario = parsed.scenarios.find((item) => item.scenario === 'history-suite');

    assert.ok(scenario);
    assert.equal(scenario.testNamePattern, 'real-feishu::history-suite::<runtime>-<provider>');
    assert.equal(scenario.providerCoverage, 'runtime-parameterized');
    assert.deepEqual(scenario.providerMatrix, expectedRuntimeProviderMatrix('real-feishu::history-suite'));
    assert.ok(scenario.unitCoverage.includes('unit::bridge-command-e2e::history-json-attachment'));
    assert.ok(scenario.unitCoverage.includes('unit::bridge-command-e2e::history-long-truncation'));
    assert.ok(scenario.unitCoverage.includes('unit::store::session-message-isolation'));
    assert.ok(scenario.e2eCoverage.includes('e2e::history-json-file-reply'));
    assert.ok(scenario.e2eCoverage.includes('e2e::history-empty-response'));
    assert.ok(scenario.e2eCoverage.includes('e2e::history-cross-chat-isolation'));
  });

  it('exposes card-forms as a runtime-neutral real Feishu scenario', () => {
    const output = runHarness(['--list-scenarios']);
    const parsed = JSON.parse(output) as {
      scenarios: Array<{
        scenario: string;
        testNamePattern: string;
        providerCoverage: string;
        providerMatrix: string[];
        requiresRuntimeOutput: boolean;
        unitCoverage: string[];
        e2eCoverage: string[];
      }>;
    };
    const scenario = parsed.scenarios.find((item) => item.scenario === 'card-forms');

    assert.ok(scenario);
    assert.equal(scenario.testNamePattern, 'real-feishu::card-forms::<runtime>');
    assert.equal(scenario.providerCoverage, 'runtime-neutral');
    assert.equal(scenario.requiresRuntimeOutput, false);
    assert.deepEqual(scenario.providerMatrix, []);
    assert.ok(scenario.unitCoverage.includes('unit::bridge-command-e2e::new-session-form-card'));
    assert.ok(scenario.unitCoverage.includes('unit::bridge-command-e2e::every-card-form-callback-chain'));
    assert.ok(scenario.unitCoverage.includes('unit::command-dispatch::then-form-card'));
    assert.ok(scenario.e2eCoverage.includes('e2e::feishu-interactive-card-reply_to'));
    assert.ok(scenario.e2eCoverage.includes('e2e::card-form-visible-transcript'));
    assert.ok(scenario.e2eCoverage.includes('e2e::automation-form-visible-transcript'));
    assert.equal(scenario.e2eCoverage.includes('e2e::card-submit-callback-prefix'), false);
  });

  it('exposes agent-question-forms as a dual runtime/provider real Feishu scenario', () => {
    const output = runHarness(['--list-scenarios']);
    const parsed = JSON.parse(output) as {
      scenarios: Array<{
        scenario: string;
        testNamePattern: string;
        providerCoverage: string;
        providerMatrix: string[];
        unitCoverage: string[];
        e2eCoverage: string[];
      }>;
    };
    const scenario = parsed.scenarios.find((item) => item.scenario === 'agent-question-forms');

    assert.ok(scenario);
    assert.equal(scenario.testNamePattern, 'real-feishu::agent-question-forms::<runtime>-<provider>');
    assert.equal(scenario.providerCoverage, 'runtime-parameterized');
    assert.deepEqual(scenario.providerMatrix, expectedRuntimeProviderMatrix('real-feishu::agent-question-forms'));
    assert.ok(scenario.unitCoverage.includes('unit::feishu-adapter-card-e2e::sdk-clk-ask-form'));
    assert.ok(scenario.unitCoverage.includes('unit::feishu-adapter-card-e2e::mirror-clk-ask-form'));
    assert.ok(scenario.unitCoverage.includes('unit::feishu-adapter-card-e2e::kimi-mirror-markdown-ask-form'));
    assert.ok(scenario.e2eCoverage.includes('e2e::agent-question-form-visible-transcript'));
    assert.equal(scenario.e2eCoverage.includes('e2e::agent-question-form-fields'), false);
    assert.equal(scenario.e2eCoverage.includes('e2e::agent-question-callback-prefix'), false);
    assert.ok(scenario.e2eCoverage.includes('e2e::mock-app-kimi-mirror-clk-ask-form'));
    assert.ok(scenario.e2eCoverage.includes('e2e::mock-app-kimi-mirror-markdown-ask-split'));
  });

  it('exposes markdown-rendering as a dual runtime/provider real Feishu scenario', () => {
    const output = runHarness(['--list-scenarios']);
    const parsed = JSON.parse(output) as {
      scenarios: Array<{
        scenario: string;
        testNamePattern: string;
        providerCoverage: string;
        providerMatrix: string[];
        unitCoverage: string[];
        e2eCoverage: string[];
      }>;
    };
    const scenario = parsed.scenarios.find((item) => item.scenario === 'markdown-rendering');

    assert.ok(scenario);
    assert.equal(scenario.testNamePattern, 'real-feishu::markdown-rendering::<runtime>-<provider>');
    assert.equal(scenario.providerCoverage, 'runtime-parameterized');
    assert.deepEqual(scenario.providerMatrix, expectedRuntimeProviderMatrix('real-feishu::markdown-rendering'));
    assert.ok(scenario.unitCoverage.includes('unit::plain-markdown::tables-and-code-blocks'));
    assert.ok(scenario.unitCoverage.includes('unit::feishu-markdown::card-markdown-elements'));
    assert.ok(scenario.unitCoverage.includes('unit::feishu-adapter-card-e2e::kimi-mirror-markdown-ask-form'));
    assert.ok(scenario.e2eCoverage.includes('e2e::feishu-markdown-table'));
    assert.ok(scenario.e2eCoverage.includes('e2e::feishu-markdown-fenced-code'));
    assert.ok(scenario.e2eCoverage.includes('e2e::mock-app-kimi-mirror-markdown-ask-split'));
  });

  it('exposes doc-as-chat-from-scratch as a user-read verified real Feishu scenario', () => {
    const output = runHarness(['--list-scenarios']);
    const parsed = JSON.parse(output) as {
      scenarios: Array<{
        scenario: string;
        testNamePattern: string;
        providerCoverage: string;
        providerMatrix: string[];
        unitCoverage: string[];
        e2eCoverage: string[];
      }>;
    };
    const scenario = parsed.scenarios.find((item) => item.scenario === 'doc-as-chat-from-scratch');

    assert.ok(scenario);
    assert.equal(scenario.testNamePattern, 'real-feishu::doc-as-chat-from-scratch::<runtime>-<provider>');
    assert.equal(scenario.providerCoverage, 'representative-provider');
    assert.deepEqual(scenario.providerMatrix, ['real-feishu::doc-as-chat-from-scratch::codex-tmux']);
    assert.ok(scenario.unitCoverage.includes('unit::bridge-manager::cloud-document-chat-context'));
    assert.ok(scenario.unitCoverage.includes('unit::mirror-subscription-registry::skip-cloud-document-virtual-chat'));
    assert.ok(scenario.e2eCoverage.includes('e2e::lark-cli-user-doc-create'));
    assert.ok(scenario.e2eCoverage.includes('e2e::lark-cli-user-chat-read'));
    assert.ok(scenario.e2eCoverage.includes('e2e::doc-as-chat-context-file-token-marker'));
    assert.ok(scenario.e2eCoverage.includes('e2e::created-document-cleanup'));
  });

  it('exposes basic-dialogue-suite as one cross-provider real Feishu workflow', () => {
    const output = runHarness(['--list-scenarios']);
    const parsed = JSON.parse(output) as {
      scenarios: Array<{
        scenario: string;
        testNamePattern: string;
        providerCoverage: string;
        coverageTier: string;
        providerSequence?: string[];
        providerMatrix: string[];
        unitCoverage: string[];
        e2eCoverage: string[];
      }>;
    };
    const scenario = parsed.scenarios.find((item) => item.scenario === 'basic-dialogue-suite');

    assert.ok(scenario);
    assert.equal(scenario.testNamePattern, 'real-feishu::basic-dialogue-suite::cross-provider');
    assert.equal(scenario.providerCoverage, 'cross-provider-suite');
    assert.equal(scenario.coverageTier, 'mandatory-suite');
    assert.deepEqual(scenario.providerSequence, [
      'codex-sdk',
      'claude-sdk',
      'kimi-tmux',
      'codex-tmux',
    ]);
    assert.deepEqual(scenario.providerMatrix, ['real-feishu::basic-dialogue-suite::cross-provider']);
    assert.ok(scenario.unitCoverage.includes('unit::interactive-turn-runner::basic-dialogue-session-simulator'));
    assert.ok(scenario.unitCoverage.includes('unit::bridge-manager::kimi-thinking-status-only'));
    assert.ok(scenario.e2eCoverage.includes('e2e::same-chat-cross-provider-sequence'));
    assert.ok(scenario.e2eCoverage.includes('e2e::sdk-mirror-suppression-grace'));
  });

  it('prints a machine-readable coverage matrix with Kimi canonical evidence gaps', () => {
    const reportsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-real-feishu-reports-'));
    fs.writeFileSync(
      path.join(reportsDir, 'command-state-kimi.json'),
      JSON.stringify({
        runId: 'command-state-kimi-canonical',
        dryRun: false,
        coverage: { testName: 'real-feishu::command-state::kimi-tmux' },
        canonicalEligibility: { eligible: true, blockers: [] },
        checks: passingChecks(COMMAND_STATE_KIMI_CANONICAL_CHECKS),
      }),
    );
    const olderRuntimeFailure = path.join(reportsDir, 'runtime-message-kimi.failure.json');
    const newerRuntimeFailure = path.join(reportsDir, 'runtime-message-kimi-newer.failure.json');
    fs.writeFileSync(
      olderRuntimeFailure,
      JSON.stringify({
        runId: 'runtime-message-kimi-failure',
        dryRun: false,
        coverage: { testName: 'real-feishu::runtime-message::kimi-tmux' },
        failedChecks: [{ name: 'runtime_identity_bound', ok: false }],
      }),
    );
    fs.writeFileSync(
      newerRuntimeFailure,
      JSON.stringify({
        runId: 'runtime-message-kimi-newer-failure',
        dryRun: false,
        coverage: { testName: 'real-feishu::runtime-message::kimi-tmux' },
        failedChecks: [{ name: 'provider_output_path', ok: false }],
      }),
    );
    const oldMtime = new Date('2026-01-01T00:00:00Z');
    const newMtime = new Date('2026-01-02T00:00:00Z');
    fs.utimesSync(olderRuntimeFailure, oldMtime, oldMtime);
    fs.utimesSync(newerRuntimeFailure, newMtime, newMtime);
    fs.writeFileSync(
      path.join(reportsDir, 'basic-dialogue.dry-run.json'),
      JSON.stringify({
        runId: 'basic-dialogue-dry-run',
        dryRun: true,
        coverage: { testName: 'real-feishu::basic-dialogue-suite::cross-provider' },
      }),
    );
    fs.writeFileSync(
      path.join(reportsDir, 'kimi-test-app-auth-device.json'),
      JSON.stringify({
        device_code: 'dev_fake',
        verification_url: 'https://example.invalid/device',
        user_code: 'ABCD-EFGH',
      }),
    );

    const output = runHarness(['--coverage-matrix', '--reports-dir', reportsDir]);
    const parsed = JSON.parse(output) as {
      scenarios: number;
      summary: {
        matrixEntries: number;
        kimiEntries: number;
        kimiCurrentEntries: number;
        kimiCanonicalPass: number;
        kimiCurrentCanonicalPass: number;
        kimiDiagnosticFailure: number;
        kimiCurrentDiagnosticFailure: number;
        kimiDryRun: number;
        kimiCurrentDryRun: number;
        kimiPlannedOnly: number;
        kimiCurrentPlannedOnly: number;
        unmatchedReports: number;
      };
      coverageRates: Record<string, {
        total: number;
        canonicalPass: number;
        diagnosticFailure: number;
        dryRun: number;
        plannedOnly: number;
        executed: number;
        canonicalPercent: number;
        executedPercent: number;
      }>;
      entries: Array<{
        scenario: string;
        testName: string;
        includesKimi: boolean;
        evidence: {
          status: string;
          runId?: string;
          failedChecks?: string[];
          canonicalEligible?: boolean;
          canonicalReportCheck?: boolean | null;
          missingCanonicalChecks?: string[];
        };
      }>;
      kimiGaps: Array<{
        scenario: string;
        testName: string;
        evidenceStatus: string;
        reportPath?: string;
        runId?: string;
        failedChecks?: string[];
        missingCanonicalChecks?: string[];
      }>;
      kimiCurrentGaps: Array<{
        scenario: string;
        testName: string;
        evidenceStatus: string;
        reportPath?: string;
        runId?: string;
        failedChecks?: string[];
        missingCanonicalChecks?: string[];
      }>;
    };

    assert.equal(parsed.scenarios, 15);
    assert.equal(parsed.summary.matrixEntries, parsed.entries.length);
    assert.ok(parsed.entries.some((entry) => entry.testName === 'real-feishu::runtime-message::cursor-tmux'));
    assert.equal(parsed.summary.kimiEntries, 12);
    assert.equal(parsed.summary.kimiCurrentEntries, 8);
    assert.equal(parsed.summary.kimiCanonicalPass, 1);
    assert.equal(parsed.summary.kimiCurrentCanonicalPass, 1);
    assert.equal(parsed.summary.kimiDiagnosticFailure, 1);
    assert.equal(parsed.summary.kimiCurrentDiagnosticFailure, 1);
    assert.equal(parsed.summary.kimiDryRun, 1);
    assert.equal(parsed.summary.kimiCurrentDryRun, 1);
    assert.equal(parsed.summary.kimiPlannedOnly, 9);
    assert.equal(parsed.summary.kimiCurrentPlannedOnly, 5);
    assert.equal(parsed.summary.unmatchedReports, 0);
    assert.deepEqual(parsed.coverageRates.kimiCurrent, {
      total: 8,
      canonicalPass: 1,
      legacyPass: 0,
      diagnosticPass: 0,
      diagnosticFailure: 1,
      dryRun: 1,
      plannedOnly: 5,
      executed: 3,
      canonicalPercent: 12.5,
      executedPercent: 37.5,
    });
    assert.deepEqual(parsed.coverageRates.kimiCurrentTmux, {
      total: 7,
      canonicalPass: 1,
      legacyPass: 0,
      diagnosticPass: 0,
      diagnosticFailure: 1,
      dryRun: 0,
      plannedOnly: 5,
      executed: 2,
      canonicalPercent: 14.3,
      executedPercent: 28.6,
    });
    assert.deepEqual(parsed.coverageRates.cardFrontend, {
      total: 30,
      canonicalPass: 1,
      legacyPass: 0,
      diagnosticPass: 0,
      diagnosticFailure: 0,
      dryRun: 1,
      plannedOnly: 28,
      executed: 2,
      canonicalPercent: 3.3,
      executedPercent: 6.7,
    });
    assert.deepEqual(parsed.coverageRates.cardFrontendTmux, {
      total: 21,
      canonicalPass: 1,
      legacyPass: 0,
      diagnosticPass: 0,
      diagnosticFailure: 0,
      dryRun: 0,
      plannedOnly: 20,
      executed: 1,
      canonicalPercent: 4.8,
      executedPercent: 4.8,
    });
    const commandStateKimi = parsed.entries.find((entry) => entry.testName === 'real-feishu::command-state::kimi-tmux');
    assert.equal(commandStateKimi?.includesKimi, true);
    assert.equal(commandStateKimi?.evidence.status, 'canonical-pass');
    assert.equal(commandStateKimi?.evidence.canonicalEligible, true);
    assert.equal(commandStateKimi?.evidence.canonicalReportCheck, true);
    assert.equal(commandStateKimi?.evidence.missingCanonicalChecks, undefined);
    const runtimeKimi = parsed.entries.find((entry) => entry.testName === 'real-feishu::runtime-message::kimi-tmux');
    assert.equal(runtimeKimi?.evidence.status, 'diagnostic-failure');
    assert.equal(runtimeKimi?.evidence.runId, 'runtime-message-kimi-newer-failure');
    assert.deepEqual(runtimeKimi?.evidence.failedChecks, ['provider_output_path']);
    const basicDialogue = parsed.entries.find((entry) => entry.testName === 'real-feishu::basic-dialogue-suite::cross-provider');
    assert.equal(basicDialogue?.includesKimi, true);
    assert.equal(basicDialogue?.evidence.status, 'dry-run');
    assert.equal(
      parsed.kimiGaps.some((gap) => gap.testName === 'real-feishu::command-state::kimi-tmux'),
      false,
    );
    const runtimeGap = parsed.kimiGaps.find((gap) => gap.testName === 'real-feishu::runtime-message::kimi-tmux');
    assert.equal(runtimeGap?.evidenceStatus, 'diagnostic-failure');
    assert.equal(runtimeGap?.runId, 'runtime-message-kimi-newer-failure');
    assert.equal(runtimeGap?.reportPath?.endsWith('runtime-message-kimi-newer.failure.json'), true);
    assert.deepEqual(runtimeGap?.failedChecks, ['provider_output_path']);
    assert.ok(parsed.kimiGaps.some((gap) => (
      gap.testName === 'real-feishu::runtime-message::kimi-tmux'
      && gap.evidenceStatus === 'diagnostic-failure'
    )));
    assert.equal(
      parsed.kimiCurrentGaps.some((gap) => gap.testName === 'real-feishu::history-boundaries::kimi-tmux'),
      false,
    );
    assert.ok(parsed.kimiCurrentGaps.some((gap) => gap.testName === 'real-feishu::basic-dialogue-suite::cross-provider'));
    const plannedHistorySuiteGap = parsed.kimiCurrentGaps.find((gap) => gap.testName === 'real-feishu::history-suite::kimi-tmux');
    assert.equal(plannedHistorySuiteGap?.evidenceStatus, 'none');
    assert.ok(plannedHistorySuiteGap?.missingCanonicalChecks?.includes('runtime_prompt_final_transcript_marker'));
    assert.ok(plannedHistorySuiteGap?.missingCanonicalChecks?.includes('history_suite_transcript_contract'));
    assert.ok(plannedHistorySuiteGap?.missingCanonicalChecks?.includes('kimi_wire_jsonl_found'));
  });

  it('fails coverage matrix checks when required Kimi canonical reports are missing', () => {
    const reportsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-real-feishu-require-reports-'));
    fs.writeFileSync(
      path.join(reportsDir, 'command-state-kimi.json'),
      JSON.stringify({
        runId: 'command-state-kimi-canonical',
        dryRun: false,
        coverage: { testName: 'real-feishu::command-state::kimi-tmux' },
        canonicalEligibility: { eligible: true, blockers: [] },
        checks: passingChecks(COMMAND_STATE_KIMI_CANONICAL_CHECKS),
      }),
    );

    const output = runHarnessFailure([
      '--coverage-matrix',
      '--reports-dir',
      reportsDir,
      '--require-canonical',
      'kimi-current',
    ]);

    assert.match(output, /"kimiCurrentEntries": 8/);
    assert.match(output, /"kimiCurrentCanonicalPass": 1/);
    assert.match(output, /Kimi canonical coverage requirement failed for scope kimi-current/);
    assert.match(output, /real-feishu::basic-dialogue-suite::cross-provider:none/);
    assert.doesNotMatch(output, /real-feishu::history-boundaries::kimi-tmux:none/);
  });

  it('passes the current Kimi canonical gate when every current Kimi scenario has complete evidence', () => {
    const reportsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-real-feishu-current-kimi-reports-'));

    writeCanonicalReport(reportsDir, 'real-feishu::message-only::kimi-tmux', KIMI_TMUX_SMOKE_CANONICAL_CHECKS);
    writeCanonicalReport(reportsDir, 'real-feishu::runtime-message::kimi-tmux', KIMI_TMUX_SMOKE_CANONICAL_CHECKS);
    writeCanonicalReport(
      reportsDir,
      'real-feishu::basic-dialogue-suite::cross-provider',
      BASIC_DIALOGUE_KIMI_CANONICAL_CHECKS,
    );
    writeCanonicalReport(reportsDir, 'real-feishu::command-state::kimi-tmux', COMMAND_STATE_KIMI_CANONICAL_CHECKS);
    writeCanonicalReport(
      reportsDir,
      'real-feishu::session-management::kimi-tmux',
      SESSION_MANAGEMENT_KIMI_CANONICAL_CHECKS,
    );
    writeCanonicalReport(reportsDir, 'real-feishu::history-suite::kimi-tmux', HISTORY_SUITE_KIMI_CANONICAL_CHECKS);
    writeCanonicalReport(
      reportsDir,
      'real-feishu::agent-question-forms::kimi-tmux',
      AGENT_QUESTION_KIMI_CANONICAL_CHECKS,
    );
    writeCanonicalReport(reportsDir, 'real-feishu::markdown-rendering::kimi-tmux', MARKDOWN_KIMI_CANONICAL_CHECKS);

    const currentOutput = runHarness([
      '--coverage-matrix',
      '--reports-dir',
      reportsDir,
      '--require-canonical',
      'kimi-current',
    ]);
    const parsedCurrent = JSON.parse(currentOutput) as {
      summary: {
        kimiCurrentEntries: number;
        kimiCurrentCanonicalPass: number;
      };
      kimiCurrentGaps: Array<{ testName: string; evidenceStatus: string }>;
    };

    assert.equal(parsedCurrent.summary.kimiCurrentEntries, 8);
    assert.equal(parsedCurrent.summary.kimiCurrentCanonicalPass, 8);
    assert.deepEqual(parsedCurrent.kimiCurrentGaps, []);

    const fullOutput = runHarnessFailure([
      '--coverage-matrix',
      '--reports-dir',
      reportsDir,
      '--require-canonical',
      'kimi',
    ]);

    assert.match(fullOutput, /"kimiCurrentCanonicalPass": 8/);
    assert.match(fullOutput, /Kimi canonical coverage requirement failed for scope kimi/);
    assert.match(fullOutput, /real-feishu::history-boundaries::kimi-tmux:none/);
  });

  it('does not accept thin self-claimed Kimi canonical reports without Feishu transcript and wire evidence', () => {
    const reportsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-real-feishu-thin-reports-'));
    fs.writeFileSync(
      path.join(reportsDir, 'command-state-kimi-thin.json'),
      JSON.stringify({
        runId: 'command-state-kimi-thin',
        dryRun: false,
        coverage: { testName: 'real-feishu::command-state::kimi-tmux' },
        canonicalEligibility: { eligible: true, blockers: [] },
        checks: passingChecks(['canonical_report_eligible']),
      }),
    );

    const output = runHarness(['--coverage-matrix', '--reports-dir', reportsDir]);
    const parsed = JSON.parse(output) as {
      summary: { kimiCurrentCanonicalPass: number };
      entries: Array<{
        testName: string;
        evidence: {
          status: string;
          missingCanonicalChecks?: string[];
        };
      }>;
      kimiCurrentGaps: Array<{ testName: string; evidenceStatus: string }>;
    };
    const commandStateKimi = parsed.entries.find((entry) => entry.testName === 'real-feishu::command-state::kimi-tmux');

    assert.equal(parsed.summary.kimiCurrentCanonicalPass, 0);
    assert.equal(commandStateKimi?.evidence.status, 'diagnostic-pass');
    assert.ok(commandStateKimi?.evidence.missingCanonicalChecks?.includes('message_observations_passed'));
    assert.ok(commandStateKimi?.evidence.missingCanonicalChecks?.includes('final_feishu_transcript_present'));
    assert.ok(commandStateKimi?.evidence.missingCanonicalChecks?.includes('kimi_wire_jsonl_found'));
    assert.ok(commandStateKimi?.evidence.missingCanonicalChecks?.includes('command_state_runtime_settings_transcript'));
    assert.ok(parsed.kimiCurrentGaps.some((gap) => (
      gap.testName === 'real-feishu::command-state::kimi-tmux'
      && gap.evidenceStatus === 'diagnostic-pass'
    )));
  });
});

describe('unit::real-feishu-e2e-harness::session-management-command-plan', () => {
  it('dry-runs Kimi runtime-message with runtime/provider seed reply assertions', () => {
    const output = runHarness([
      '--dry-run',
      '--scenario',
      'runtime-message',
      '--runtime',
      'kimi',
      '--provider',
      'tmux',
      '--run-id',
      'unit-runtime-message-kimi-tmux',
      '--chat-id',
      'oc_unit',
      '--message',
      'CODELARK_UNIT_RUNTIME_MESSAGE_KIMI_TMUX',
    ]);
    const parsed = JSON.parse(output) as {
      coverage: {
        testName: string;
        dualProviderCompanion: string | null;
      };
      commands: string[];
      commandReplyExpectations: Array<{ command: string; expectedTexts: string[]; replyTimeoutMs: number; reason: string }>;
      waitsForMirrorFinalBeforeFollowup: boolean;
      finalMessageObservationMode: string;
      plannedSuccessCheckNames: string[];
    };

    assert.equal(parsed.coverage.testName, 'real-feishu::runtime-message::kimi-tmux');
    assert.equal(parsed.coverage.dualProviderCompanion, 'real-feishu::runtime-message::codex-tmux');
    assert.deepEqual(parsed.commands, ['/runtime kimi', '/p tmux']);
    assert.equal(parsed.waitsForMirrorFinalBeforeFollowup, true);
    assert.equal(parsed.finalMessageObservationMode, 'mirror-stream-evidence');
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/runtime kimi').expectedTexts, ['Runtime', 'kimi']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/p tmux').expectedTexts, ['Kimi Provider', 'tmux']);
    assert.ok(parsed.commandReplyExpectations.every((item) => item.reason === 'runtime/provider seed command must reach the selected runtime and provider before sending the prompt'));
    assert.ok(parsed.plannedSuccessCheckNames.includes('message_observations_passed'));
    assert.ok(parsed.plannedSuccessCheckNames.includes('final_feishu_transcript_present'));
    assert.ok(parsed.plannedSuccessCheckNames.includes('required_checks_passed'));
    assert.ok(parsed.plannedSuccessCheckNames.includes('provider_output_path'));
    assert.ok(parsed.plannedSuccessCheckNames.includes('mirror_final_not_duplicated_in_direct_reply'));
    assert.ok(parsed.plannedSuccessCheckNames.includes('runtime_prompt_final_transcript_marker'));
  });

  it('dry-runs Cursor through the shared runtime-message matrix as a direct transcript provider', () => {
    const output = runHarness([
      '--dry-run',
      '--scenario',
      'runtime-message',
      '--runtime',
      'cursor',
      '--provider',
      'tmux',
      '--cursor-model',
      'gpt-5.3-codex',
      '--run-id',
      'unit-runtime-message-cursor-tmux',
      '--chat-id',
      'oc_unit',
      '--message',
      'CODELARK_UNIT_RUNTIME_MESSAGE_CURSOR_TMUX',
    ]);
    const parsed = JSON.parse(output) as {
      coverage: { testName: string; dualProviderCompanion: string | null };
      commands: string[];
      cursorModel: string;
      commandReplyExpectations: Array<{ command: string; expectedTexts: string[]; replyTimeoutMs: number; reason: string }>;
      waitsForMirrorFinalBeforeFollowup: boolean;
      finalMessageObservationMode: string;
      plannedSuccessCheckNames: string[];
      runtimeEnvironment: {
        bridgeHome: string;
        cursorConfigDir: string;
        cursorDataDir: string;
        cursorExecutableSource: string;
      };
    };

    assert.equal(parsed.coverage.testName, 'real-feishu::runtime-message::cursor-tmux');
    assert.equal(parsed.coverage.dualProviderCompanion, 'real-feishu::runtime-message::codex-tmux');
    assert.deepEqual(parsed.commands, ['/runtime cursor', '/p tmux']);
    assert.equal(parsed.cursorModel, 'gpt-5.3-codex');
    assert.equal(parsed.waitsForMirrorFinalBeforeFollowup, true);
    assert.equal(parsed.finalMessageObservationMode, 'reply_to');
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/runtime cursor').expectedTexts, ['Runtime', 'cursor']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/p tmux').expectedTexts, ['Cursor Provider', 'tmux']);
    assert.equal(expectationAt(parsed.commandReplyExpectations, '/p tmux').replyTimeoutMs, 120_000);
    assert.ok(parsed.runtimeEnvironment.cursorConfigDir.includes('cursor-config'));
    assert.ok(parsed.runtimeEnvironment.cursorDataDir.includes('cursor-data'));
    assert.ok(parsed.runtimeEnvironment.cursorExecutableSource.length > 0);
    assert.ok(parsed.plannedSuccessCheckNames.includes('provider_output_path'));
    assert.ok(parsed.plannedSuccessCheckNames.includes('cursor_stream_card_unified_ui'));
    assert.equal(parsed.plannedSuccessCheckNames.includes('mirror_final_not_duplicated_in_direct_reply'), false);
  });

  it('dry-runs ZCode tmux through the shared runtime-message matrix as a direct SQLite stream provider', () => {
    const output = runHarness([
      '--dry-run',
      '--scenario',
      'runtime-message',
      '--runtime',
      'zcode',
      '--provider',
      'tmux',
      '--run-id',
      'unit-runtime-message-zcode-tmux',
      '--chat-id',
      'oc_unit',
      '--message',
      'CODELARK_UNIT_RUNTIME_MESSAGE_ZCODE_TMUX',
    ]);
    const parsed = JSON.parse(output) as {
      coverage: { testName: string; dualProviderCompanion: string | null };
      commands: string[];
      commandReplyExpectations: Array<{ command: string; expectedTexts: string[]; replyTimeoutMs: number; reason: string }>;
      waitsForMirrorFinalBeforeFollowup: boolean;
      finalMessageObservationMode: string;
      plannedSuccessCheckNames: string[];
      runtimeEnvironment: { zcodeStorageDir: string; zcodeSessionDbPath: string };
    };

    assert.equal(parsed.coverage.testName, 'real-feishu::runtime-message::zcode-tmux');
    assert.equal(parsed.coverage.dualProviderCompanion, 'real-feishu::runtime-message::codex-tmux');
    assert.deepEqual(parsed.commands, ['/runtime zcode', '/p tmux']);
    assert.equal(parsed.waitsForMirrorFinalBeforeFollowup, true);
    assert.equal(parsed.finalMessageObservationMode, 'reply_to');
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/runtime zcode').expectedTexts, ['Runtime', 'zcode']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/p tmux').expectedTexts, ['ZCode Provider', 'tmux']);
    assert.equal(expectationAt(parsed.commandReplyExpectations, '/p tmux').replyTimeoutMs, 120_000);
    assert.ok(parsed.runtimeEnvironment.zcodeStorageDir.includes('zcode-storage'));
    assert.ok(parsed.runtimeEnvironment.zcodeSessionDbPath.endsWith('sessions.sqlite'));
    assert.ok(parsed.plannedSuccessCheckNames.includes('provider_output_path'));
    assert.equal(parsed.plannedSuccessCheckNames.includes('mirror_final_not_duplicated_in_direct_reply'), false);
  });

  it('dry-runs a native ZCode slash command through the TUI without a CodeLark command adapter', () => {
    const output = runHarness([
      '--dry-run',
      '--scenario',
      'command-state',
      '--runtime',
      'zcode',
      '--provider',
      'tmux',
      '--run-id',
      'unit-zcode-native-slash',
      '--chat-id',
      'oc_unit',
    ]);
    const parsed = JSON.parse(output) as {
      commands: string[];
      commandReplyExpectations: Array<{ command: string; expectedTexts: string[] }>;
    };

    assert.ok(parsed.commands.includes('//goal'));
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '//goal').expectedTexts, [
      'No goal is set',
    ]);
  });

  it('plans a deterministic Kimi wire producer without bypassing the real bridge or Feishu card path', () => {
    const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-real-feishu-scripted-kimi-'));
    const output = runHarness([
      '--dry-run',
      '--launch-bridge',
      '--scripted-kimi',
      '--scenario',
      'runtime-message',
      '--runtime',
      'kimi',
      '--provider',
      'tmux',
      '--run-root',
      runRoot,
      '--run-id',
      'unit-scripted-kimi-tool-card',
      '--chat-id',
      'oc_unit',
      '--message',
      'CODELARK_UNIT_SCRIPTED_KIMI_TOOL_CARD',
    ]);
    const parsed = JSON.parse(output) as {
      scriptedKimi: boolean;
      runtimeEnvironment: {
        kimiAuthSource: string;
        kimiExecutableSource: string;
        kimiExecutablePath?: string;
      };
      plannedSuccessCheckNames: string[];
    };

    assert.equal(parsed.scriptedKimi, true);
    assert.equal(parsed.runtimeEnvironment.kimiAuthSource, 'not-needed');
    assert.equal(parsed.runtimeEnvironment.kimiExecutableSource, 'scripted-fake-executable');
    assert.equal(parsed.runtimeEnvironment.kimiExecutablePath, path.join(runRoot, 'bin', 'kimi'));
    assert.ok(parsed.plannedSuccessCheckNames.includes('runtime_message_scripted_kimi_tool_card'));
  });

  it('dry-runs Claude tmux runtime-message with mirror and JSONL evidence assertions', () => {
    const output = runHarness([
      '--dry-run',
      '--scenario',
      'runtime-message',
      '--runtime',
      'claude',
      '--provider',
      'tmux',
      '--run-id',
      'unit-runtime-message-claude-tmux',
      '--chat-id',
      'oc_unit',
      '--message',
      'CODELARK_UNIT_RUNTIME_MESSAGE_CLAUDE_TMUX',
    ]);
    const parsed = JSON.parse(output) as {
      coverage: {
        testName: string;
        dualProviderCompanion: string | null;
      };
      commands: string[];
      commandReplyExpectations: Array<{ command: string; expectedTexts: string[]; reason: string }>;
      finalMessageObservationMode: string;
      plannedSuccessCheckNames: string[];
    };

    assert.equal(parsed.coverage.testName, 'real-feishu::runtime-message::claude-tmux');
    assert.equal(parsed.coverage.dualProviderCompanion, 'real-feishu::runtime-message::codex-tmux');
    assert.deepEqual(parsed.commands, ['/runtime claude', '/p tmux']);
    assert.equal(parsed.finalMessageObservationMode, 'mirror-stream-evidence');
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/runtime claude').expectedTexts, ['Runtime', 'claude']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/p tmux').expectedTexts, ['Claude Provider', 'tmux']);
    assert.ok(parsed.commandReplyExpectations.every((item) => item.reason === 'runtime/provider seed command must reach the selected runtime and provider before sending the prompt'));
    assert.ok(parsed.plannedSuccessCheckNames.includes('message_observations_passed'));
    assert.ok(parsed.plannedSuccessCheckNames.includes('final_feishu_transcript_present'));
    assert.ok(parsed.plannedSuccessCheckNames.includes('required_checks_passed'));
    assert.ok(parsed.plannedSuccessCheckNames.includes('provider_output_path'));
    assert.ok(parsed.plannedSuccessCheckNames.includes('mirror_final_not_duplicated_in_direct_reply'));
    assert.ok(parsed.plannedSuccessCheckNames.includes('runtime_prompt_final_transcript_marker'));
  });

  it('derives Kimi home from the isolated runtime home without a dedicated Kimi E2E switch', () => {
    const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-real-feishu-kimi-home-'));
    const runtimeHome = path.join(runRoot, 'runtime-home');
    const output = runHarness([
      '--dry-run',
      '--launch-bridge',
      '--scenario',
      'runtime-message',
      '--runtime',
      'kimi',
      '--provider',
      'tmux',
      '--run-root',
      runRoot,
      '--runtime-home',
      runtimeHome,
      '--run-id',
      'unit-kimi-home-derived',
      '--chat-id',
      'oc_unit',
      '--message',
      'CODELARK_UNIT_KIMI_HOME_DERIVED',
    ]);
    const parsed = JSON.parse(output) as {
      runtimeEnvironment: {
        runtimeHome: string;
        kimiHome: string;
      };
    };
    const usage = runHarness(['--help']);

    assert.equal(parsed.runtimeEnvironment.runtimeHome, runtimeHome);
    assert.equal(parsed.runtimeEnvironment.kimiHome, path.join(runtimeHome, '.kimi-code'));
    assert.doesNotMatch(usage, /--kimi-home/);
  });

  it('cleans provider tmux sessions through the run-local server without inheriting the caller socket', () => {
    const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-real-feishu-cleanup-'));
    const codelarkHome = path.join(runRoot, 'codelark-home');
    const dataDir = path.join(codelarkHome, 'data');
    const logsDir = path.join(codelarkHome, 'logs');
    const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-real-feishu-fake-tmux-'));
    const tmuxLog = path.join(fakeBin, 'tmux.log');
    const fakeTmux = path.join(fakeBin, 'tmux');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(logsDir, { recursive: true });
    fs.mkdirSync(path.join(runRoot, 'tmux'), { recursive: true });
    fs.writeFileSync(fakeTmux, [
      '#!/usr/bin/env node',
      'const fs = require("node:fs");',
      'fs.appendFileSync(process.env.CLK_FAKE_TMUX_LOG, `${JSON.stringify({ args: process.argv.slice(2), tmux: process.env.TMUX || null, tmuxPane: process.env.TMUX_PANE || null, tmuxTmpdir: process.env.TMUX_TMPDIR || null })}\\n`);',
      'process.exit(0);',
      '',
    ].join('\n'), { mode: 0o755 });
    fs.writeFileSync(path.join(dataDir, 'sessions.json'), JSON.stringify({
      codex: {
        runtime: { general: { tmuxSessionName: 'codex_019e824e-10ef-7430-985d-4349ce6a15f9' } },
      },
      claude: {
        runtime: { general: { tmuxSessionName: 'claude_session_cleanup' } },
      },
      kimi: {
        runtime: { general: { tmuxSessionName: 'clk-kimi-session-kimi-cleanup' } },
      },
      cursor: {
        runtime: { general: { tmuxSessionName: 'clk-cursor-session-cursor-cleanup' } },
      },
      zcode: {
        runtime: { general: { tmuxSessionName: 'clk-zcode-session-zcode-cleanup' } },
      },
    }, null, 2));
    fs.writeFileSync(
      path.join(logsDir, 'bridge.log'),
      [
        'leftover claude_session_from_log',
        'leftover clk-kimi-session-from-log',
        'leftover clk-zcode-session-from-log',
      ].join('\n'),
    );

    try {
      const output = runHarness([
        '--stop-test-bridge',
        '--run-root',
        runRoot,
        '--clk-home',
        codelarkHome,
      ], {
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
        CLK_FAKE_TMUX_LOG: tmuxLog,
        TMUX: '/tmp/user-tmux/default,123,0',
        TMUX_PANE: '%9',
      });
      const parsed = JSON.parse(output) as {
        removedTmuxSessions: string[];
      };
      const tmuxCalls = fs.readFileSync(tmuxLog, 'utf-8').trim().split('\n').map((line) => JSON.parse(line) as {
        args: string[];
        tmux: string | null;
        tmuxPane: string | null;
        tmuxTmpdir: string | null;
      });

      assert.deepEqual(parsed.removedTmuxSessions, [
        'claude_session_cleanup',
        'claude_session_from_log',
        'clk-cursor-session-cursor-cleanup',
        'clk-kimi-session-from-log',
        'clk-kimi-session-kimi-cleanup',
        'clk-zcode-session-from-log',
        'clk-zcode-session-zcode-cleanup',
        'codex_019e824e-10ef-7430-985d-4349ce6a15f9',
      ]);
      for (const sessionName of parsed.removedTmuxSessions) {
        assert.ok(tmuxCalls.some((call) => call.args.join(' ') === `kill-session -t ${sessionName}`));
      }
      assert.ok(tmuxCalls.some((call) => call.args.join(' ') === 'kill-server'));
      assert.ok(tmuxCalls.every((call) => call.tmux === null && call.tmuxPane === null));
      assert.ok(tmuxCalls.every((call) => call.tmuxTmpdir === path.join(runRoot, 'tmux')));
      assert.equal(fs.existsSync(runRoot), false);
    } finally {
      fs.rmSync(runRoot, { recursive: true, force: true });
      fs.rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it('does not invoke tmux cleanup when dry-run never created a run-local tmux root', () => {
    const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-real-feishu-dry-run-tmux-'));
    const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-real-feishu-fake-tmux-'));
    const tmuxLog = path.join(fakeBin, 'tmux.log');
    const fakeTmux = path.join(fakeBin, 'tmux');
    fs.writeFileSync(fakeTmux, [
      '#!/usr/bin/env node',
      'const fs = require("node:fs");',
      'fs.appendFileSync(process.env.CLK_FAKE_TMUX_LOG, `${process.argv.slice(2).join(" ")}\\n`);',
      'process.exit(0);',
      '',
    ].join('\n'), { mode: 0o755 });

    try {
      runHarness([
        '--dry-run',
        '--run-root',
        runRoot,
        '--scenario',
        'message-only',
        '--chat-id',
        'oc_unit',
      ], {
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
        CLK_FAKE_TMUX_LOG: tmuxLog,
        TMUX: '/tmp/user-tmux/default,123,0',
        TMUX_PANE: '%9',
      });

      assert.equal(fs.existsSync(path.join(runRoot, 'tmux')), false);
      assert.equal(fs.existsSync(tmuxLog), false);
    } finally {
      fs.rmSync(runRoot, { recursive: true, force: true });
      fs.rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it('dry-runs product /new initial chat creation with a bot app id inferred from the configured clk-home', () => {
    const codelarkHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-real-feishu-harness-'));
    try {
      fs.writeFileSync(path.join(codelarkHome, 'config.json'), JSON.stringify({
        schemaVersion: 1,
        channels: [{
          provider: 'feishu',
          enabled: true,
          config: {
            appId: 'cli_configured_bot',
          },
        }],
      }));
      const output = runHarness([
        '--dry-run',
        '--clk-home',
        codelarkHome,
        '--scenario',
        'session-management',
        '--runtime',
        'codex',
        '--provider',
        'sdk',
        '--run-id',
        'unit-product-new-infer-bot',
        '--message',
        'CODELARK_UNIT_PRODUCT_NEW_INFER_BOT',
      ]);
      const parsed = JSON.parse(output) as {
        initialChatCreation: string;
        initialChatCreationBotAppId: string | null;
        initialChatCreationOwnerPolicy: string | null;
        plannedChatId: string;
      };

      assert.equal(parsed.initialChatCreation, 'product-new-session-use-case');
      assert.equal(parsed.initialChatCreationBotAppId, 'cli_configured_bot');
      assert.equal(parsed.initialChatCreationOwnerPolicy, 'product-new-session-use-case-ownerUserId');
      assert.equal(parsed.plannedChatId, '<created-chat-id>');
    } finally {
      fs.rmSync(codelarkHome, { recursive: true, force: true });
    }
  });

  it('dry-runs product /new initial chat creation with a bot app id inferred from legacy config.env', () => {
    const codelarkHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-real-feishu-harness-'));
    try {
      fs.writeFileSync(path.join(codelarkHome, 'config.env'), [
        '# legacy bridge config snapshot',
        'CODELARK_ENABLED_CHANNELS=feishu',
        'CODELARK_FEISHU_APP_ID=cli_env_bot',
      ].join('\n'));
      const output = runHarness([
        '--dry-run',
        '--clk-home',
        codelarkHome,
        '--scenario',
        'session-management',
        '--runtime',
        'codex',
        '--provider',
        'sdk',
        '--run-id',
        'unit-product-new-infer-env-bot',
        '--message',
        'CODELARK_UNIT_PRODUCT_NEW_INFER_ENV_BOT',
      ]);
      const parsed = JSON.parse(output) as {
        initialChatCreationBotAppId: string | null;
        initialChatCreationOwnerPolicy: string | null;
      };

      assert.equal(parsed.initialChatCreationBotAppId, 'cli_env_bot');
      assert.equal(parsed.initialChatCreationOwnerPolicy, 'product-new-session-use-case-ownerUserId');
    } finally {
      fs.rmSync(codelarkHome, { recursive: true, force: true });
    }
  });

  it('keeps an explicit test app id ahead of live clk-home inference', () => {
    const codelarkHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-real-feishu-harness-'));
    try {
      fs.writeFileSync(path.join(codelarkHome, 'config.json'), JSON.stringify({
        schemaVersion: 1,
        channels: [{
          provider: 'feishu',
          enabled: true,
          config: {
            appId: 'cli_configured_bot',
          },
        }],
      }));
      const output = runHarness([
        '--dry-run',
        '--clk-home',
        codelarkHome,
        '--test-feishu-app-id',
        'cli_explicit_bot',
        '--scenario',
        'session-management',
        '--runtime',
        'codex',
        '--provider',
        'sdk',
        '--run-id',
        'unit-product-new-explicit-bot',
        '--message',
        'CODELARK_UNIT_PRODUCT_NEW_EXPLICIT_BOT',
      ]);
      const parsed = JSON.parse(output) as {
        initialChatCreationBotAppId: string | null;
        initialChatCreationOwnerPolicy: string | null;
      };

      assert.equal(parsed.initialChatCreationBotAppId, 'cli_explicit_bot');
      assert.equal(parsed.initialChatCreationOwnerPolicy, 'product-new-session-use-case-ownerUserId');
    } finally {
      fs.rmSync(codelarkHome, { recursive: true, force: true });
    }
  });

  it('dry-runs command-state with semantic command reply assertions for codex-sdk', () => {
    const output = runHarness([
      '--dry-run',
      '--scenario',
      'command-state',
      '--runtime',
      'codex',
      '--provider',
      'sdk',
      '--run-id',
      'unit-command-state',
      '--chat-id',
      'oc_unit',
      '--message',
      'CODELARK_UNIT_COMMAND_STATE',
    ]);
    const parsed = JSON.parse(output) as {
      coverage: {
        testName: string;
      };
      commands: string[];
      plannedSuccessCheckNames: string[];
      commandReplyExpectations: Array<{
        command: string;
        expectedTexts: string[];
        expectedReplyMessageTypes: string[];
        expectedReplyContentKeys: string[];
        replyTimeoutMs: number;
        reason: string;
      }>;
    };
    const expectationByCommand = new Map(parsed.commandReplyExpectations.map((item) => [item.command, item]));
    const fileCommand = commandStateFixtureCommand('unit-command-state');
    const largeFileCommand = commandStateLargeFixtureCommand('unit-command-state');

    assert.equal(parsed.coverage.testName, 'real-feishu::command-state::codex-sdk');
    assert.ok(parsed.plannedSuccessCheckNames.includes('runtime_prompt_final_transcript_marker'));
    assert.ok(parsed.plannedSuccessCheckNames.includes('command_state_runtime_settings_transcript'));
    assert.ok(parsed.plannedSuccessCheckNames.includes('command_state_file_and_large_file_transcript'));
    assert.deepEqual(parsed.commands, [
      '/status',
      '/require-at off',
      '/runtime codex',
      '/p sdk',
      '/current',
      '/model',
      '/mode',
      '/provider',
      '/sandbox',
      '/network',
      '/reasoning',
      fileCommand,
      largeFileCommand,
      '/every 1h e2e seed unit-command-state',
      '/every',
      '/every no 1',
    ]);
    assert.equal(parsed.commandReplyExpectations.length, parsed.commands.length);
    assert.deepEqual(expectationByCommand.get('/status')?.expectedTexts, ['全局状态', 'Bridge', '当前聊天']);
    assert.deepEqual(expectationByCommand.get('/require-at off')?.expectedTexts, ['已更新群聊 @bot 设置', 'off']);
    assert.deepEqual(expectationByCommand.get('/runtime codex')?.expectedTexts, ['Runtime', 'codex']);
    assert.deepEqual(expectationByCommand.get('/p sdk')?.expectedTexts, ['Codex Provider', 'sdk']);
    assert.deepEqual(expectationByCommand.get('/current')?.expectedTexts, [
      'Codex',
      'Provider',
      '跟随上层配置（当前：',
      '当前 agent',
    ]);
    assert.deepEqual(expectationByCommand.get('/model')?.expectedTexts, ['当前模型']);
    assert.deepEqual(expectationByCommand.get('/mode')?.expectedTexts, ['当前模式', 'Runtime', 'codex']);
    assert.deepEqual(expectationByCommand.get('/provider')?.expectedTexts, ['当前 Codex Provider']);
    assert.deepEqual(expectationByCommand.get('/sandbox')?.expectedTexts, ['当前 Codex 沙箱']);
    assert.deepEqual(expectationByCommand.get('/network')?.expectedTexts, ['当前 Codex 网络']);
    assert.deepEqual(expectationByCommand.get('/reasoning')?.expectedTexts, ['当前思考级别']);
    assert.deepEqual(expectationByCommand.get(fileCommand)?.expectedTexts, []);
    assert.deepEqual(expectationByCommand.get(fileCommand)?.expectedReplyMessageTypes, ['file']);
    assert.deepEqual(expectationByCommand.get(fileCommand)?.expectedReplyContentKeys, ['file_key']);
    assert.equal(expectationByCommand.get(fileCommand)?.reason, 'file command must reply with a Feishu file message containing a Feishu file key');
    assert.deepEqual(expectationByCommand.get(largeFileCommand)?.expectedTexts, ['确认上传大文件', 'codelark-large-file-UNIT_COMMAND_STATE.bin', '超过 20 MB']);
    assert.deepEqual(expectationByCommand.get(largeFileCommand)?.expectedReplyMessageTypes, ['interactive']);
    assert.deepEqual(expectationByCommand.get(largeFileCommand)?.expectedReplyContentKeys, ['clk-command', '上传并发链接', '取消']);
    assert.equal(expectationByCommand.get(largeFileCommand)?.reason, 'large file command must reply with a Feishu interactive confirmation card and clk-command callback prefix');
    assert.deepEqual(expectationByCommand.get('/every 1h e2e seed unit-command-state')?.expectedTexts, ['已创建 /every 定时输入', 'e2e seed unit-command-state', 'session runtime-id']);
    assert.deepEqual(expectationByCommand.get('/every')?.expectedTexts, ['当前聊天 /every 定时输入', 'session runtime-id']);
    assert.deepEqual(expectationByCommand.get('/every no 1')?.expectedTexts, ['已取消 /every 定时输入']);
    assert.ok(parsed.commandReplyExpectations
      .filter((item) => item.command !== fileCommand && item.command !== largeFileCommand)
      .every((item) => item.reason === 'command-state reply must include the expected command-specific status text'));
  });

  it('dry-runs command-state with Claude-specific unsupported setting assertions', () => {
    const output = runHarness([
      '--dry-run',
      '--scenario',
      'command-state',
      '--runtime',
      'claude',
      '--provider',
      'sdk',
      '--run-id',
      'unit-command-state-claude',
      '--chat-id',
      'oc_unit',
      '--message',
      'CODELARK_UNIT_COMMAND_STATE_CLAUDE',
    ]);
    const parsed = JSON.parse(output) as {
      coverage: {
        testName: string;
        dualProviderCompanion: string | null;
      };
      commands: string[];
      plannedSuccessCheckNames: string[];
      commandReplyExpectations: Array<{ command: string; expectedTexts: string[]; expectedReplyMessageTypes: string[]; expectedReplyContentKeys: string[]; reason: string }>;
    };
    const expectationByCommand = new Map(parsed.commandReplyExpectations.map((item) => [item.command, item]));
    const fileCommand = commandStateFixtureCommand('unit-command-state-claude');
    const largeFileCommand = commandStateLargeFixtureCommand('unit-command-state-claude');

    assert.equal(parsed.coverage.testName, 'real-feishu::command-state::claude-sdk');
    assert.equal(parsed.coverage.dualProviderCompanion, 'real-feishu::command-state::codex-tmux');
    assert.ok(parsed.plannedSuccessCheckNames.includes('runtime_prompt_final_transcript_marker'));
    assert.ok(parsed.plannedSuccessCheckNames.includes('command_state_runtime_settings_transcript'));
    assert.ok(parsed.plannedSuccessCheckNames.includes('command_state_file_and_large_file_transcript'));
    assert.deepEqual(parsed.commands.slice(0, 4), [
      '/status',
      '/require-at off',
      '/runtime claude',
      '/p sdk',
    ]);
    assert.deepEqual(expectationByCommand.get('/runtime claude')?.expectedTexts, ['Runtime', 'claude']);
    assert.deepEqual(expectationByCommand.get('/p sdk')?.expectedTexts, ['Claude Provider', 'sdk']);
    assert.deepEqual(expectationByCommand.get('/model')?.expectedTexts, ['当前 Claude Code 模型']);
    assert.deepEqual(expectationByCommand.get('/mode')?.expectedTexts, ['当前模式', 'Runtime', 'claude']);
    assert.deepEqual(expectationByCommand.get('/provider')?.expectedTexts, ['当前 Claude Provider']);
    assert.deepEqual(expectationByCommand.get('/sandbox')?.expectedTexts, ['Claude Code 不支持 Bridge 沙箱设置']);
    assert.deepEqual(expectationByCommand.get('/network')?.expectedTexts, ['Claude Code 不支持 Bridge 网络开关']);
    assert.deepEqual(expectationByCommand.get('/reasoning')?.expectedTexts, ['当前 Claude Code 思考级别']);
    assert.deepEqual(expectationByCommand.get(fileCommand)?.expectedTexts, []);
    assert.deepEqual(expectationByCommand.get(fileCommand)?.expectedReplyMessageTypes, ['file']);
    assert.deepEqual(expectationByCommand.get(fileCommand)?.expectedReplyContentKeys, ['file_key']);
    assert.deepEqual(expectationByCommand.get(largeFileCommand)?.expectedTexts, ['确认上传大文件', 'codelark-large-file-UNIT_COMMAND_STATE_CLAUDE.bin', '超过 20 MB']);
    assert.deepEqual(expectationByCommand.get(largeFileCommand)?.expectedReplyMessageTypes, ['interactive']);
    assert.deepEqual(expectationByCommand.get(largeFileCommand)?.expectedReplyContentKeys, ['clk-command', '上传并发链接', '取消']);
    assert.equal(expectationByCommand.get(largeFileCommand)?.reason, 'large file command must reply with a Feishu interactive confirmation card and clk-command callback prefix');
    assert.deepEqual(expectationByCommand.get('/every 1h e2e seed unit-command-state-claude')?.expectedTexts, ['已创建 /every 定时输入', 'e2e seed unit-command-state-claude', 'session runtime-id']);
    assert.deepEqual(expectationByCommand.get('/every')?.expectedTexts, ['当前聊天 /every 定时输入', 'session runtime-id']);
  });

  it('dry-runs command-state with Kimi-specific unsupported setting assertions', () => {
    const output = runHarness([
      '--dry-run',
      '--scenario',
      'command-state',
      '--runtime',
      'kimi',
      '--provider',
      'tmux',
      '--run-id',
      'unit-command-state-kimi',
      '--chat-id',
      'oc_unit',
      '--message',
      'CODELARK_UNIT_COMMAND_STATE_KIMI',
    ]);
    const parsed = JSON.parse(output) as {
      coverage: {
        testName: string;
        dualProviderCompanion: string | null;
      };
      commands: string[];
      plannedSuccessCheckNames: string[];
      commandReplyExpectations: Array<{ command: string; expectedTexts: string[]; expectedReplyMessageTypes: string[]; expectedReplyContentKeys: string[]; reason: string }>;
    };
    const expectationByCommand = new Map(parsed.commandReplyExpectations.map((item) => [item.command, item]));
    const fileCommand = commandStateFixtureCommand('unit-command-state-kimi');
    const largeFileCommand = commandStateLargeFixtureCommand('unit-command-state-kimi');

    assert.equal(parsed.coverage.testName, 'real-feishu::command-state::kimi-tmux');
    assert.equal(parsed.coverage.dualProviderCompanion, 'real-feishu::command-state::codex-tmux');
    assert.ok(parsed.plannedSuccessCheckNames.includes('runtime_prompt_final_transcript_marker'));
    assert.ok(parsed.plannedSuccessCheckNames.includes('command_state_runtime_settings_transcript'));
    assert.ok(parsed.plannedSuccessCheckNames.includes('command_state_file_and_large_file_transcript'));
    assert.deepEqual(parsed.commands.slice(0, 4), [
      '/status',
      '/require-at off',
      '/runtime kimi',
      '/p tmux',
    ]);
    assert.deepEqual(expectationByCommand.get('/runtime kimi')?.expectedTexts, ['Runtime', 'kimi']);
    assert.deepEqual(expectationByCommand.get('/p tmux')?.expectedTexts, ['Kimi Provider', 'tmux']);
    assert.deepEqual(expectationByCommand.get('/model')?.expectedTexts, ['当前 Kimi Code 模型']);
    assert.deepEqual(expectationByCommand.get('/mode')?.expectedTexts, ['Kimi Code 模式固定']);
    assert.deepEqual(expectationByCommand.get('/provider')?.expectedTexts, ['当前 Kimi Provider']);
    assert.deepEqual(expectationByCommand.get('/sandbox')?.expectedTexts, ['Kimi Code 不支持 Bridge 沙箱设置']);
    assert.deepEqual(expectationByCommand.get('/network')?.expectedTexts, ['Kimi Code 不支持 Bridge 网络开关']);
    assert.deepEqual(expectationByCommand.get('/reasoning')?.expectedTexts, ['当前 Kimi Code Thinking 模式']);
    assert.deepEqual(expectationByCommand.get(fileCommand)?.expectedTexts, []);
    assert.deepEqual(expectationByCommand.get(fileCommand)?.expectedReplyMessageTypes, ['file']);
    assert.deepEqual(expectationByCommand.get(fileCommand)?.expectedReplyContentKeys, ['file_key']);
    assert.deepEqual(expectationByCommand.get(largeFileCommand)?.expectedTexts, ['确认上传大文件', 'codelark-large-file-UNIT_COMMAND_STATE_KIMI.bin', '超过 20 MB']);
    assert.deepEqual(expectationByCommand.get(largeFileCommand)?.expectedReplyMessageTypes, ['interactive']);
    assert.deepEqual(expectationByCommand.get(largeFileCommand)?.expectedReplyContentKeys, ['clk-command', '上传并发链接', '取消']);
    assert.equal(expectationByCommand.get(largeFileCommand)?.reason, 'large file command must reply with a Feishu interactive confirmation card and clk-command callback prefix');
    assert.deepEqual(expectationByCommand.get('/every 1h e2e seed unit-command-state-kimi')?.expectedTexts, ['已创建 /every 定时输入', 'e2e seed unit-command-state-kimi', 'session runtime-id']);
    assert.deepEqual(expectationByCommand.get('/every')?.expectedTexts, ['当前聊天 /every 定时输入', 'session runtime-id']);
  });

  it('dry-runs Feishu command coverage for codex-sdk with a claude-tmux companion', () => {
    const output = runHarness([
      '--dry-run',
      '--scenario',
      'session-management',
      '--runtime',
      'codex',
      '--provider',
      'sdk',
      '--run-id',
      'unit-session-management',
      '--chat-id',
      'oc_unit',
      '--message',
      'CODELARK_UNIT_SESSION_MANAGEMENT',
    ]);
    const parsed = JSON.parse(output) as {
      coverage: {
        testName: string;
        dualProviderCompanion: string | null;
        matrixCompanions: string[];
      };
      commands: string[];
      waitsForMirrorFinalBeforeFollowup: boolean;
      finalMessageObservationMode: string;
      plannedSuccessCheckNames: string[];
      commandReplyExpectations: Array<{ command: string; expectedTexts: string[]; reason: string }>;
    };
    const shellCommand = sessionManagementShellCommand('unit-session-management');

    assert.equal(parsed.coverage.testName, 'real-feishu::session-management::codex-sdk');
    assert.equal(parsed.waitsForMirrorFinalBeforeFollowup, false);
    assert.equal(parsed.finalMessageObservationMode, 'reply_to');
    assert.ok(parsed.plannedSuccessCheckNames.includes('runtime_prompt_final_transcript_marker'));
    assert.ok(parsed.plannedSuccessCheckNames.includes('session_management_runtime_identity_transcript'));
    assert.equal(parsed.coverage.dualProviderCompanion, 'real-feishu::session-management::claude-tmux');
    assert.ok(parsed.coverage.matrixCompanions.includes('real-feishu::session-management::claude-sdk'));
    assert.deepEqual(parsed.commands, [
      '/runtime codex',
      '/p sdk',
      '/help',
      '/set',
      '/set claudeProvider tmux',
      `/new mgmt-unit-session-management ${DEFAULT_WORKSPACE_ROOT}`,
      '/runtime codex',
      '/p sdk',
      `/clear clear-unit-session-management ${DEFAULT_WORKSPACE_ROOT}`,
      `/cd ${DEFAULT_WORKSPACE_ROOT}`,
      shellCommand,
      '/current',
      '/check',
      '/t',
      '/t n 50',
      '/t unbind',
      'CODELARK_UNIT_SESSION_MANAGEMENT',
      '/his 5',
      '/t archive',
    ]);
    assert.equal(parsed.commandReplyExpectations.length, parsed.commands.length);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/runtime codex', 0).expectedTexts, ['Runtime', 'codex']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/p sdk', 0).expectedTexts, ['Codex Provider', 'sdk']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/help').expectedTexts, ['命令速览', 'Bridge 控制', 'SessionRuntime 配置']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/set').expectedTexts, ['全局配置', '通用配置', '默认 agent', 'tmux 输出行数']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/set claudeProvider tmux').expectedTexts, ['已更新全局配置', 'runtime.claude.provider', 'tmux']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, `/new mgmt-unit-session-management ${DEFAULT_WORKSPACE_ROOT}`).expectedTexts, ['已创建群聊会话', 'mgmt-unit-session-management', DEFAULT_WORKSPACE_ROOT, 'Runtime', 'Codex']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/runtime codex', 1).expectedTexts, ['Runtime', 'codex']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/p sdk', 1).expectedTexts, ['Codex Provider', 'sdk']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, `/clear clear-unit-session-management ${DEFAULT_WORKSPACE_ROOT}`).expectedTexts, ['已清空当前聊天上下文', 'clear-unit-session-management', DEFAULT_WORKSPACE_ROOT, 'Provider', 'sdk']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, `/cd ${DEFAULT_WORKSPACE_ROOT}`).expectedTexts, ['已切换工作目录', DEFAULT_WORKSPACE_ROOT]);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, shellCommand).expectedTexts, ['/shell 执行完成', 'CODELARK_SHELL_UNIT_SESSION_MANAGEMENT', 'Codex sandbox', 'read-only', '退出码', '0']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/current').expectedTexts, ['Codex', 'clear-unit-session-management', 'Provider', 'sdk', '当前 agent']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/check').expectedTexts, ['当前会话健康检查', 'runtime', 'Codex', 'codex_thread_id']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/t').expectedTexts, ['本地会话']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/t n 50').expectedTexts, ['本地会话']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/t unbind').expectedTexts, ['当前聊天已解绑', '新的临时 BridgeSession']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, 'CODELARK_UNIT_SESSION_MANAGEMENT').expectedTexts, ['CODELARK_UNIT_SESSION_MANAGEMENT']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/his 5').expectedTexts, ['CODELARK_UNIT_SESSION_MANAGEMENT']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/t archive').expectedTexts, ['已归档本地 Codex 会话']);
    assert.equal(expectationAt(parsed.commandReplyExpectations, '/help').reason, 'session-management command reply must include the expected command-specific status text');
    assert.equal(expectationAt(parsed.commandReplyExpectations, shellCommand).reason, 'shell command must complete in Codex sandbox and include the stdout marker');
    assert.equal(expectationAt(parsed.commandReplyExpectations, 'CODELARK_UNIT_SESSION_MANAGEMENT').reason, 'direct final reply must include the expected model marker');
    assert.equal(expectationAt(parsed.commandReplyExpectations, '/his 5').reason, 'history reply must include the final chat marker');
    assert.equal(expectationAt(parsed.commandReplyExpectations, '/help').replyTimeoutMs, 15_000);
    assert.equal(expectationAt(parsed.commandReplyExpectations, shellCommand).replyTimeoutMs, 120_000);
    assert.equal(expectationAt(parsed.commandReplyExpectations, 'CODELARK_UNIT_SESSION_MANAGEMENT').replyTimeoutMs, 120_000);
    assert.equal(expectationAt(parsed.commandReplyExpectations, '/his 5').replyTimeoutMs, 120_000);
  });

  it('dry-runs Claude SDK command coverage without resetting Claude back to tmux', () => {
    const output = runHarness([
      '--dry-run',
      '--scenario',
      'session-management',
      '--runtime',
      'claude',
      '--provider',
      'sdk',
      '--run-id',
      'unit-session-management-claude-sdk',
      '--chat-id',
      'oc_unit',
      '--message',
      'CODELARK_UNIT_SESSION_MANAGEMENT_CLAUDE_SDK',
    ]);
    const parsed = JSON.parse(output) as {
      coverage: {
        testName: string;
        dualProviderCompanion: string | null;
      };
      commands: string[];
      plannedSuccessCheckNames: string[];
      commandReplyExpectations: Array<{ command: string; expectedTexts: string[]; replyTimeoutMs: number; reason: string }>;
    };

    assert.equal(parsed.coverage.testName, 'real-feishu::session-management::claude-sdk');
    assert.equal(parsed.coverage.dualProviderCompanion, 'real-feishu::session-management::codex-tmux');
    assert.ok(parsed.plannedSuccessCheckNames.includes('runtime_prompt_final_transcript_marker'));
    assert.ok(parsed.plannedSuccessCheckNames.includes('session_management_runtime_identity_transcript'));
    assert.deepEqual(parsed.commands.slice(0, 5), [
      '/runtime claude',
      '/p sdk',
      '/help',
      '/set',
      '/set claudeProvider sdk',
    ]);
    assert.ok(!parsed.commands.includes('/set claudeProvider tmux'));
    const newIndex = parsed.commands.findIndex((command) => command.startsWith('/new '));
    assert.deepEqual(parsed.commands.slice(newIndex + 1, newIndex + 3), [
      '/runtime claude',
      '/p sdk',
    ]);
    assert.equal(parsed.commandReplyExpectations.length, parsed.commands.length);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/runtime claude', 0).expectedTexts, ['Runtime', 'claude']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/p sdk', 0).expectedTexts, ['Claude Provider', 'sdk']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/set claudeProvider sdk').expectedTexts, ['已更新全局配置', 'runtime.claude.provider', 'sdk']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, `/new mgmt-unit-session-management-claude-sdk ${DEFAULT_WORKSPACE_ROOT}`).expectedTexts, ['已创建群聊会话', 'mgmt-unit-session-management-claude-sdk', DEFAULT_WORKSPACE_ROOT, 'Runtime', 'Claude Code']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/runtime claude', 1).expectedTexts, ['Runtime', 'claude']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/p sdk', 1).expectedTexts, ['Claude Provider', 'sdk']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, `/clear clear-unit-session-management-claude-sdk ${DEFAULT_WORKSPACE_ROOT}`).expectedTexts, ['已清空当前聊天上下文', 'clear-unit-session-management-claude-sdk', DEFAULT_WORKSPACE_ROOT, 'Provider', 'sdk']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, sessionManagementShellCommand('unit-session-management-claude-sdk')).expectedTexts, ['/shell 执行完成', 'CODELARK_SHELL_UNIT_SESSION_MANAGEMENT_CLAUDE_SDK', 'Codex sandbox', 'read-only', '退出码', '0']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/current').expectedTexts, ['Claude Code', 'clear-unit-session-management-claude-sdk', 'Provider', 'sdk', '当前 agent']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/check').expectedTexts, ['当前会话健康检查', 'runtime', 'Claude Code', 'claude_session_id', 'runtime_cwd']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/t').expectedTexts, ['本地会话']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/t n 50').expectedTexts, ['本地会话']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/t unbind').expectedTexts, ['当前聊天已解绑', '新的临时 BridgeSession']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, 'CODELARK_UNIT_SESSION_MANAGEMENT_CLAUDE_SDK').expectedTexts, ['CODELARK_UNIT_SESSION_MANAGEMENT_CLAUDE_SDK']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/his 5').expectedTexts, ['CODELARK_UNIT_SESSION_MANAGEMENT_CLAUDE_SDK']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/t archive').expectedTexts, ['已归档本地 Claude Code 会话']);
  });

  it('dry-runs history text assertions for mirror providers without requiring direct final text', () => {
    const output = runHarness([
      '--dry-run',
      '--scenario',
      'session-management',
      '--runtime',
      'codex',
      '--provider',
      'tmux',
      '--run-id',
      'unit-session-management-codex-tmux',
      '--chat-id',
      'oc_unit',
      '--message',
      'CODELARK_UNIT_SESSION_MANAGEMENT_CODEX_TMUX',
    ]);
    const parsed = JSON.parse(output) as {
      coverage: {
        testName: string;
      };
      commands: string[];
      waitsForMirrorFinalBeforeFollowup: boolean;
      finalMessageObservationMode: string;
      plannedSuccessCheckNames: string[];
      commandReplyExpectations: Array<{ command: string; expectedTexts: string[]; replyTimeoutMs: number; reason: string }>;
    };

    assert.equal(parsed.coverage.testName, 'real-feishu::session-management::codex-tmux');
    assert.equal(parsed.waitsForMirrorFinalBeforeFollowup, true);
    assert.equal(parsed.finalMessageObservationMode, 'mirror-stream-evidence');
    assert.ok(parsed.plannedSuccessCheckNames.includes('runtime_prompt_final_transcript_marker'));
    assert.ok(parsed.plannedSuccessCheckNames.includes('session_management_runtime_identity_transcript'));
    assert.equal(parsed.commandReplyExpectations.length, parsed.commands.length - 1);
    assert.ok(parsed.commands.includes('请只回复下面这个 marker，不要添加解释：\nCODELARK_UNIT_SESSION_MANAGEMENT_CODEX_TMUX'));
    assert.equal(parsed.commandReplyExpectations.some((item) => item.command.includes('CODELARK_UNIT_SESSION_MANAGEMENT_CODEX_TMUX')), false);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/p tmux', 0).expectedTexts, ['Codex Provider', 'tmux']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/p tmux', 1).expectedTexts, ['Codex Provider', 'tmux']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, `/clear clear-unit-session-management-codex-tmux ${DEFAULT_WORKSPACE_ROOT}`).expectedTexts, ['已清空当前聊天上下文', 'clear-unit-session-management-codex-tmux', DEFAULT_WORKSPACE_ROOT, 'Provider', 'tmux']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, sessionManagementShellCommand('unit-session-management-codex-tmux')).expectedTexts, ['/shell 执行完成', 'CODELARK_SHELL_UNIT_SESSION_MANAGEMENT_CODEX_TMUX', 'Codex sandbox', 'read-only', '退出码', '0']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/t n 50').expectedTexts, ['本地会话']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/t unbind').expectedTexts, ['当前聊天已解绑', '新的临时 BridgeSession']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/his 5').expectedTexts, ['CODELARK_UNIT_SESSION_MANAGEMENT_CODEX_TMUX']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/t archive').expectedTexts, ['已归档本地 Codex 会话']);
    assert.equal(expectationAt(parsed.commandReplyExpectations, '/p tmux', 0).replyTimeoutMs, 120_000);
    assert.equal(expectationAt(parsed.commandReplyExpectations, '/his 5').replyTimeoutMs, 120_000);
  });

  it('dry-runs Kimi tmux session-management with mirror history and Kimi archive assertions', () => {
    const output = runHarness([
      '--dry-run',
      '--scenario',
      'session-management',
      '--runtime',
      'kimi',
      '--provider',
      'tmux',
      '--fake-kimi',
      '--run-id',
      'unit-session-management-kimi-tmux',
      '--chat-id',
      'oc_unit',
    ]);
    const parsed = JSON.parse(output) as {
      coverage: {
        testName: string;
        dualProviderCompanion: string | null;
        matrixCompanions: string[];
      };
      commands: string[];
      waitsForMirrorFinalBeforeFollowup: boolean;
      finalMessageObservationMode: string;
      plannedSuccessCheckNames: string[];
      fakeKimi: boolean;
      fakeKimiResponseText: string;
      requiredCheckCheckpointCommand: string | null;
      runtimeEnvironment: {
        kimiAuthSource: string;
        kimiExecutableSource: string;
        fakeKimiProxyBaseUrl?: string;
      };
      commandReplyExpectations: Array<{ command: string; expectedTexts: string[]; replyTimeoutMs: number; reason: string }>;
    };

    assert.equal(parsed.coverage.testName, 'real-feishu::session-management::kimi-tmux');
    assert.equal(parsed.requiredCheckCheckpointCommand, '/t archive');
    assert.equal(parsed.coverage.dualProviderCompanion, 'real-feishu::session-management::codex-tmux');
    assert.ok(parsed.coverage.matrixCompanions.includes('real-feishu::session-management::claude-sdk'));
    assert.equal(parsed.waitsForMirrorFinalBeforeFollowup, true);
    assert.equal(parsed.finalMessageObservationMode, 'mirror-stream-evidence');
    assert.equal(parsed.fakeKimi, true);
    assert.equal(parsed.fakeKimiResponseText, 'CODELARK_REAL_FEISHU_UNIT_SESSION_MANAGEMENT_KIMI_TMUX');
    assert.equal(parsed.runtimeEnvironment.kimiAuthSource, 'not-needed');
    assert.notEqual(parsed.runtimeEnvironment.kimiExecutableSource, 'scripted-fake-executable');
    assert.equal(parsed.runtimeEnvironment.fakeKimiProxyBaseUrl, '<local-openai-chat-completions-backend>');
    assert.ok(parsed.plannedSuccessCheckNames.includes('fake_kimi_backend_used'));
    assert.ok(parsed.plannedSuccessCheckNames.includes('fake_kimi_real_executable_used'));
    assert.ok(parsed.plannedSuccessCheckNames.includes('runtime_prompt_final_transcript_marker'));
    assert.ok(parsed.plannedSuccessCheckNames.includes('session_management_runtime_identity_transcript'));
    assert.equal(parsed.commandReplyExpectations.length, parsed.commands.length - 1);
    assert.deepEqual(parsed.commands.slice(0, 5), [
      '/runtime kimi',
      '/p tmux',
      '/help',
      '/set',
      '/set kimiProvider tmux',
    ]);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/runtime kimi', 0).expectedTexts, ['Runtime', 'kimi']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/p tmux', 0).expectedTexts, ['Kimi Provider', 'tmux']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/set kimiProvider tmux').expectedTexts, ['已更新全局配置', 'runtime.kimi.provider', 'tmux']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, `/new mgmt-unit-session-management-kimi-tmux ${DEFAULT_WORKSPACE_ROOT}`).expectedTexts, ['已创建群聊会话', 'mgmt-unit-session-management-kimi-tmux', DEFAULT_WORKSPACE_ROOT, 'Runtime', 'Kimi Code']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/runtime kimi', 1).expectedTexts, ['Runtime', 'kimi']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/p tmux', 1).expectedTexts, ['Kimi Provider', 'tmux']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, `/clear clear-unit-session-management-kimi-tmux ${DEFAULT_WORKSPACE_ROOT}`).expectedTexts, ['已清空当前聊天上下文', 'clear-unit-session-management-kimi-tmux', DEFAULT_WORKSPACE_ROOT, 'Provider', 'tmux']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, sessionManagementShellCommand('unit-session-management-kimi-tmux')).expectedTexts, ['/shell 执行完成', 'CODELARK_SHELL_UNIT_SESSION_MANAGEMENT_KIMI_TMUX', 'Codex sandbox', 'read-only', '退出码', '0']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/current').expectedTexts, ['Kimi Code', 'clear-unit-session-management-kimi-tmux', 'Provider', 'tmux', '当前 agent']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/check').expectedTexts, ['当前会话健康检查', 'runtime', 'Kimi Code', 'kimi_session_id', 'runtime_cwd']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/t unbind').expectedTexts, ['当前聊天已解绑', '新的临时 BridgeSession']);
    assert.ok(parsed.commands.includes('请只回复下面这个 marker，不要添加解释：\nCODELARK_REAL_FEISHU_UNIT_SESSION_MANAGEMENT_KIMI_TMUX'));
    assert.equal(parsed.commandReplyExpectations.some((item) => item.command.includes('CODELARK_REAL_FEISHU_UNIT_SESSION_MANAGEMENT_KIMI_TMUX')), false);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/his 5').expectedTexts, ['CODELARK_REAL_FEISHU_UNIT_SESSION_MANAGEMENT_KIMI_TMUX']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/t archive').expectedTexts, ['已归档本地 Kimi Code 会话']);
  });

  it('matches a stable /new group-name prefix when Feishu truncates a long name', () => {
    const runId = 'unit-session-management-kimi-tmux-with-a-very-long-unique-suffix';
    const output = runHarness([
      '--dry-run',
      '--scenario',
      'session-management',
      '--runtime',
      'kimi',
      '--provider',
      'tmux',
      '--fake-kimi',
      '--run-id',
      runId,
      '--chat-id',
      'oc_unit',
    ]);
    const parsed = JSON.parse(output) as {
      commandReplyExpectations: Array<{ command: string; expectedTexts: string[] }>;
    };
    const command = `/new mgmt-${runId} ${DEFAULT_WORKSPACE_ROOT}`;
    assert.deepEqual(
      expectationAt(parsed.commandReplyExpectations, command).expectedTexts,
      ['已创建群聊会话', `mgmt-${runId}`.slice(0, 40), DEFAULT_WORKSPACE_ROOT, 'Runtime', 'Kimi Code'],
    );
  });

  it('dry-runs history-boundaries with semantic reply assertions', () => {
    const output = runHarness([
      '--dry-run',
      '--scenario',
      'history-boundaries',
      '--runtime',
      'codex',
      '--provider',
      'sdk',
      '--run-id',
      'unit-history-boundaries',
      '--chat-id',
      'oc_unit',
      '--message',
      'Please reply exactly with this marker and no other text: CODELARK_UNIT_HISTORY_BOUNDARIES',
    ]);
    const parsed = JSON.parse(output) as {
      coverage: {
        testName: string;
      };
      commands: string[];
      commandReplyExpectations: Array<{ command: string; expectedTexts: string[]; reason: string }>;
    };

    assert.equal(parsed.coverage.testName, 'real-feishu::history-boundaries::codex-sdk');
    assert.deepEqual(parsed.commands, [
      '/runtime codex',
      '/p sdk',
      `/new history-unit-history-boundaries ${DEFAULT_WORKSPACE_ROOT}`,
      '/runtime codex',
      '/p sdk',
      `/cd ${DEFAULT_WORKSPACE_ROOT}`,
      'Please reply exactly with this marker and no other text: CODELARK_UNIT_HISTORY_BOUNDARIES',
      '/his raw 1',
      '/his limit 3',
      '/his',
      '/his msg 1',
    ]);
    assert.deepEqual(parsed.commandReplyExpectations, [
      {
        command: '/runtime codex',
        expectedTexts: ['Runtime', 'codex'],
        expectedReplyMessageTypes: [],
        expectedReplyContentKeys: [],
        replyTimeoutMs: 15_000,
        reason: 'history-boundaries setup command must reach the expected session/provider state before history assertions',
      },
      {
        command: '/p sdk',
        expectedTexts: ['Codex Provider', 'sdk'],
        expectedReplyMessageTypes: [],
        expectedReplyContentKeys: [],
        replyTimeoutMs: 120_000,
        reason: 'history-boundaries setup command must reach the expected session/provider state before history assertions',
      },
      {
        command: `/new history-unit-history-boundaries ${DEFAULT_WORKSPACE_ROOT}`,
        expectedTexts: ['已创建群聊会话', 'history-unit-history-boundaries', DEFAULT_WORKSPACE_ROOT, 'Runtime', 'Codex'],
        expectedReplyMessageTypes: [],
        expectedReplyContentKeys: [],
        replyTimeoutMs: 15_000,
        reason: 'history-boundaries setup command must reach the expected session/provider state before history assertions',
      },
      {
        command: '/runtime codex',
        expectedTexts: ['Runtime', 'codex'],
        expectedReplyMessageTypes: [],
        expectedReplyContentKeys: [],
        replyTimeoutMs: 15_000,
        reason: 'history-boundaries setup command must reach the expected session/provider state before history assertions',
      },
      {
        command: '/p sdk',
        expectedTexts: ['Codex Provider', 'sdk'],
        expectedReplyMessageTypes: [],
        expectedReplyContentKeys: [],
        replyTimeoutMs: 120_000,
        reason: 'history-boundaries setup command must reach the expected session/provider state before history assertions',
      },
      {
        command: `/cd ${DEFAULT_WORKSPACE_ROOT}`,
        expectedTexts: ['已切换工作目录', DEFAULT_WORKSPACE_ROOT],
        expectedReplyMessageTypes: [],
        expectedReplyContentKeys: [],
        replyTimeoutMs: 15_000,
        reason: 'history-boundaries setup command must reach the expected session/provider state before history assertions',
      },
      {
        command: 'Please reply exactly with this marker and no other text: CODELARK_UNIT_HISTORY_BOUNDARIES',
        expectedTexts: ['CODELARK_UNIT_HISTORY_BOUNDARIES'],
        expectedReplyMessageTypes: [],
        expectedReplyContentKeys: [],
        replyTimeoutMs: 120_000,
        reason: 'direct final reply must include the expected model marker',
      },
      {
        command: '/his raw 1',
        expectedTexts: ['最近对话（解析文本）', '返回条数', '本次 1', 'CODELARK_UNIT_HISTORY_BOUNDARIES'],
        expectedReplyMessageTypes: [],
        expectedReplyContentKeys: [],
        replyTimeoutMs: 120_000,
        reason: 'history command reply must include the expected history title, limit, and final chat marker',
      },
      {
        command: '/his limit 3',
        expectedTexts: ['已将 /his msg 返回条数限制设置为 3'],
        expectedReplyMessageTypes: [],
        expectedReplyContentKeys: [],
        replyTimeoutMs: 120_000,
        reason: 'history command reply must include the expected history title, limit, and final chat marker',
      },
      {
        command: '/his',
        expectedTexts: ['最近对话', '返回条数', '配置 3', 'CODELARK_UNIT_HISTORY_BOUNDARIES'],
        expectedReplyMessageTypes: [],
        expectedReplyContentKeys: [],
        replyTimeoutMs: 120_000,
        reason: 'history command reply must include the expected history title, limit, and final chat marker',
      },
      {
        command: '/his msg 1',
        expectedTexts: ['最近对话', '本次 1', 'CODELARK_UNIT_HISTORY_BOUNDARIES'],
        expectedReplyMessageTypes: [],
        expectedReplyContentKeys: [],
        replyTimeoutMs: 120_000,
        reason: 'history command reply must include the expected history title, limit, and final chat marker',
      },
    ]);
  });

  it('dry-runs Kimi history-boundaries through mirror history assertions', () => {
    const output = runHarness([
      '--dry-run',
      '--scenario',
      'history-boundaries',
      '--runtime',
      'kimi',
      '--provider',
      'tmux',
      '--run-id',
      'unit-history-boundaries-kimi',
      '--chat-id',
      'oc_unit',
      '--message',
      'Please reply exactly with this marker and no other text: CODELARK_UNIT_HISTORY_BOUNDARIES_KIMI',
    ]);
    const parsed = JSON.parse(output) as {
      coverage: {
        testName: string;
        dualProviderCompanion: string | null;
        matrixCompanions: string[];
      };
      commands: string[];
      commandReplyExpectations: Array<{ command: string; expectedTexts: string[]; reason: string; replyTimeoutMs: number }>;
      finalMessageObservationMode: string;
      waitsForMirrorFinalBeforeFollowup: boolean;
      plannedSuccessCheckNames: string[];
    };

    assert.equal(parsed.coverage.testName, 'real-feishu::history-boundaries::kimi-tmux');
    assert.equal(parsed.coverage.dualProviderCompanion, 'real-feishu::history-boundaries::codex-tmux');
    assert.ok(parsed.coverage.matrixCompanions.includes('real-feishu::history-boundaries::claude-sdk'));
    assert.equal(parsed.finalMessageObservationMode, 'mirror-stream-evidence');
    assert.equal(parsed.waitsForMirrorFinalBeforeFollowup, true);
    assert.ok(parsed.plannedSuccessCheckNames.includes('provider_output_path'));
    assert.ok(parsed.plannedSuccessCheckNames.includes('mirror_final_not_duplicated_in_direct_reply'));
    assert.deepEqual(parsed.commands, [
      '/runtime kimi',
      '/p tmux',
      `/new history-unit-history-boundaries-kimi ${DEFAULT_WORKSPACE_ROOT}`,
      '/runtime kimi',
      '/p tmux',
      `/cd ${DEFAULT_WORKSPACE_ROOT}`,
      'Please reply exactly with this marker and no other text: CODELARK_UNIT_HISTORY_BOUNDARIES_KIMI',
      '/his raw 1',
      '/his limit 3',
      '/his',
      '/his msg 1',
    ]);
    assert.equal(parsed.commandReplyExpectations.length, parsed.commands.length - 1);
    assert.equal(
      parsed.commandReplyExpectations.some((item) => item.command.includes('Please reply exactly')),
      false,
    );
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/runtime kimi', 0).expectedTexts, ['Runtime', 'kimi']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/p tmux', 0).expectedTexts, ['Kimi Provider', 'tmux']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/runtime kimi', 1).expectedTexts, ['Runtime', 'kimi']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/p tmux', 1).expectedTexts, ['Kimi Provider', 'tmux']);
    assert.deepEqual(
      expectationAt(parsed.commandReplyExpectations, `/new history-unit-history-boundaries-kimi ${DEFAULT_WORKSPACE_ROOT}`).expectedTexts,
      ['已创建群聊会话', 'history-unit-history-boundaries-kimi', DEFAULT_WORKSPACE_ROOT, 'Runtime', 'Kimi Code'],
    );
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, `/cd ${DEFAULT_WORKSPACE_ROOT}`).expectedTexts, ['已切换工作目录', DEFAULT_WORKSPACE_ROOT]);
    assert.deepEqual(
      expectationAt(parsed.commandReplyExpectations, '/his raw 1').expectedTexts,
      ['最近对话（解析文本）', '返回条数', '本次 1', 'CODELARK_UNIT_HISTORY_BOUNDARIES_KIMI'],
    );
    assert.deepEqual(
      expectationAt(parsed.commandReplyExpectations, '/his limit 3').expectedTexts,
      ['已将 /his msg 返回条数限制设置为 3'],
    );
    assert.deepEqual(
      expectationAt(parsed.commandReplyExpectations, '/his').expectedTexts,
      ['最近对话', '返回条数', '配置 3', 'CODELARK_UNIT_HISTORY_BOUNDARIES_KIMI'],
    );
    assert.deepEqual(
      expectationAt(parsed.commandReplyExpectations, '/his msg 1').expectedTexts,
      ['最近对话', '本次 1', 'CODELARK_UNIT_HISTORY_BOUNDARIES_KIMI'],
    );
    assert.equal(expectationAt(parsed.commandReplyExpectations, '/his raw 1').replyTimeoutMs, 120_000);
  });

  it('exposes history-attachments as a dual runtime/provider real Feishu scenario', () => {
    const output = runHarness(['--list-scenarios']);
    const parsed = JSON.parse(output) as {
      scenarios: Array<{
        scenario: string;
        testNamePattern: string;
        providerCoverage: string;
        providerMatrix: string[];
        unitCoverage: string[];
        e2eCoverage: string[];
      }>;
    };
    const scenario = parsed.scenarios.find((item) => item.scenario === 'history-attachments');

    assert.ok(scenario);
    assert.equal(scenario.testNamePattern, 'real-feishu::history-attachments::<runtime>-<provider>');
    assert.equal(scenario.providerCoverage, 'runtime-parameterized');
    assert.deepEqual(scenario.providerMatrix, expectedRuntimeProviderMatrix('real-feishu::history-attachments'));
    assert.ok(scenario.unitCoverage.includes('unit::bridge-command-e2e::history-json-attachment'));
    assert.ok(scenario.e2eCoverage.includes('e2e::history-json-file-reply'));
    assert.ok(scenario.e2eCoverage.includes('e2e::feishu-file-message-reply_to'));
  });

  it('dry-runs history-attachments with Feishu file reply assertions', () => {
    const output = runHarness([
      '--dry-run',
      '--scenario',
      'history-attachments',
      '--runtime',
      'codex',
      '--provider',
      'tmux',
      '--run-id',
      'unit-history-attachments',
      '--chat-id',
      'oc_unit',
      '--message',
      'CODELARK_UNIT_HISTORY_ATTACHMENTS',
    ]);
    const parsed = JSON.parse(output) as {
      coverage: {
        testName: string;
        dualProviderCompanion: string | null;
        matrixCompanions: string[];
      };
      commands: string[];
      validationChatSwitchesAfterNew: boolean;
      finalMessageObservationMode: string;
      waitsForMirrorFinalBeforeFollowup: boolean;
      commandReplyExpectations: Array<{
        command: string;
        expectedTexts: string[];
        expectedReplyMessageTypes: string[];
        expectedReplyContentKeys: string[];
        replyTimeoutMs: number;
        reason: string;
      }>;
    };

    assert.equal(parsed.coverage.testName, 'real-feishu::history-attachments::codex-tmux');
    assert.equal(parsed.coverage.dualProviderCompanion, 'real-feishu::history-attachments::claude-tmux');
    assert.ok(parsed.coverage.matrixCompanions.includes('real-feishu::history-attachments::codex-sdk'));
    assert.equal(parsed.validationChatSwitchesAfterNew, true);
    assert.equal(parsed.finalMessageObservationMode, 'mirror-stream-evidence');
    assert.equal(parsed.waitsForMirrorFinalBeforeFollowup, true);
    assert.deepEqual(parsed.commands, [
      '/runtime codex',
      '/p tmux',
      `/new histfile-unit-history-attachments ${DEFAULT_WORKSPACE_ROOT}`,
      '/runtime codex',
      '/p tmux',
      `/cd ${DEFAULT_WORKSPACE_ROOT}`,
      'Please reply exactly with this marker and no other text: CODELARK_UNIT_HISTORY_ATTACHMENTS',
      '/his json',
      '/his file',
    ]);
    assert.equal(parsed.commandReplyExpectations.length, parsed.commands.length - 1);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/runtime codex', 0).expectedTexts, ['Runtime', 'codex']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/p tmux', 0).expectedTexts, ['Codex Provider', 'tmux']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/runtime codex', 1).expectedTexts, ['Runtime', 'codex']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/p tmux', 1).expectedTexts, ['Codex Provider', 'tmux']);
    for (const command of [
      '/runtime codex',
      '/p tmux',
      `/new histfile-unit-history-attachments ${DEFAULT_WORKSPACE_ROOT}`,
      `/cd ${DEFAULT_WORKSPACE_ROOT}`,
    ]) {
      assert.equal(
        expectationAt(parsed.commandReplyExpectations, command).reason,
        'history-attachments setup command must reach the expected session/provider state before attachment assertions',
      );
    }
    assert.equal(
      parsed.commandReplyExpectations.some((item) => item.command.includes('Please reply exactly')),
      false,
    );
    for (const command of ['/his json', '/his file']) {
      const expectation = expectationAt(parsed.commandReplyExpectations, command);
      assert.deepEqual(expectation.expectedReplyMessageTypes, ['file']);
      assert.deepEqual(expectation.expectedReplyContentKeys, ['file_key']);
      assert.equal(expectation.replyTimeoutMs, 120_000);
      assert.equal(
        expectation.reason,
        'history attachment command must reply with a Feishu file message containing a Feishu file key',
      );
    }
  });

  it('dry-runs Kimi history-attachments with mirror-backed Feishu file assertions', () => {
    const output = runHarness([
      '--dry-run',
      '--scenario',
      'history-attachments',
      '--runtime',
      'kimi',
      '--provider',
      'tmux',
      '--run-id',
      'unit-history-attachments-kimi',
      '--chat-id',
      'oc_unit',
      '--message',
      'CODELARK_UNIT_HISTORY_ATTACHMENTS_KIMI',
    ]);
    const parsed = JSON.parse(output) as {
      coverage: {
        testName: string;
        dualProviderCompanion: string | null;
        matrixCompanions: string[];
      };
      commands: string[];
      validationChatSwitchesAfterNew: boolean;
      finalMessageObservationMode: string;
      waitsForMirrorFinalBeforeFollowup: boolean;
      plannedSuccessCheckNames: string[];
      commandReplyExpectations: Array<{
        command: string;
        expectedTexts: string[];
        expectedReplyMessageTypes: string[];
        expectedReplyContentKeys: string[];
        replyTimeoutMs: number;
        reason: string;
      }>;
    };

    assert.equal(parsed.coverage.testName, 'real-feishu::history-attachments::kimi-tmux');
    assert.equal(parsed.coverage.dualProviderCompanion, 'real-feishu::history-attachments::codex-tmux');
    assert.ok(parsed.coverage.matrixCompanions.includes('real-feishu::history-attachments::claude-sdk'));
    assert.equal(parsed.validationChatSwitchesAfterNew, true);
    assert.equal(parsed.finalMessageObservationMode, 'mirror-stream-evidence');
    assert.equal(parsed.waitsForMirrorFinalBeforeFollowup, true);
    assert.ok(parsed.plannedSuccessCheckNames.includes('provider_output_path'));
    assert.ok(parsed.plannedSuccessCheckNames.includes('mirror_final_not_duplicated_in_direct_reply'));
    assert.deepEqual(parsed.commands, [
      '/runtime kimi',
      '/p tmux',
      `/new histfile-unit-history-attachments-kimi ${DEFAULT_WORKSPACE_ROOT}`,
      '/runtime kimi',
      '/p tmux',
      `/cd ${DEFAULT_WORKSPACE_ROOT}`,
      'Please reply exactly with this marker and no other text: CODELARK_UNIT_HISTORY_ATTACHMENTS_KIMI',
      '/his json',
      '/his file',
    ]);
    assert.equal(parsed.commandReplyExpectations.length, parsed.commands.length - 1);
    assert.equal(
      parsed.commandReplyExpectations.some((item) => item.command.includes('Please reply exactly')),
      false,
    );
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/runtime kimi', 0).expectedTexts, ['Runtime', 'kimi']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/p tmux', 0).expectedTexts, ['Kimi Provider', 'tmux']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/runtime kimi', 1).expectedTexts, ['Runtime', 'kimi']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/p tmux', 1).expectedTexts, ['Kimi Provider', 'tmux']);
    assert.deepEqual(
      expectationAt(parsed.commandReplyExpectations, `/new histfile-unit-history-attachments-kimi ${DEFAULT_WORKSPACE_ROOT}`).expectedTexts,
      ['已创建群聊会话', 'histfile-unit-history-attachments-kimi', DEFAULT_WORKSPACE_ROOT, 'Runtime', 'Kimi Code'],
    );
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, `/cd ${DEFAULT_WORKSPACE_ROOT}`).expectedTexts, ['已切换工作目录', DEFAULT_WORKSPACE_ROOT]);
    for (const command of ['/his json', '/his file']) {
      const expectation = expectationAt(parsed.commandReplyExpectations, command);
      assert.deepEqual(expectation.expectedTexts, []);
      assert.deepEqual(expectation.expectedReplyMessageTypes, ['file']);
      assert.deepEqual(expectation.expectedReplyContentKeys, ['file_key']);
      assert.equal(expectation.replyTimeoutMs, 120_000);
      assert.equal(
        expectation.reason,
        'history attachment command must reply with a Feishu file message containing a Feishu file key',
      );
    }
  });

  it('dry-runs history-empty-isolation with empty-history and forbidden marker assertions', () => {
    const output = runHarness([
      '--dry-run',
      '--scenario',
      'history-empty-isolation',
      '--runtime',
      'codex',
      '--provider',
      'tmux',
      '--run-id',
      'unit-history-isolation',
      '--chat-id',
      'oc_unit',
      '--message',
      'CODELARK_UNIT_HISTORY_ISOLATION',
    ]);
    const parsed = JSON.parse(output) as {
      coverage: {
        testName: string;
      };
      commands: string[];
      validationChatSwitchesAfterNew: boolean;
      waitsForMirrorFinalBeforeFollowup: boolean;
      commandReplyExpectations: Array<{
        command: string;
        expectedTexts: string[];
        expectedForbiddenTexts?: string[];
        expectedReplyMessageTypes: string[];
        expectedReplyContentKeys: string[];
        replyTimeoutMs: number;
        reason: string;
      }>;
    };

    assert.equal(parsed.coverage.testName, 'real-feishu::history-empty-isolation::codex-tmux');
    assert.equal(parsed.validationChatSwitchesAfterNew, true);
    assert.equal(parsed.waitsForMirrorFinalBeforeFollowup, true);
    assert.deepEqual(parsed.commands, [
      '/runtime codex',
      '/p tmux',
      `/new histiso-a-unit-history-isolation ${DEFAULT_WORKSPACE_ROOT}`,
      '/runtime codex',
      '/p tmux',
      `/cd ${DEFAULT_WORKSPACE_ROOT}`,
      'Please reply exactly with this marker and no other text: CODELARK_UNIT_HISTORY_ISOLATION',
      `/new histiso-b-unit-history-isolation ${DEFAULT_WORKSPACE_ROOT}`,
      '/his',
      '/his raw 1',
      '/his msg 1',
    ]);

    assert.equal(parsed.commandReplyExpectations.filter((item) => item.command === '/runtime codex').length, 2);
    assert.equal(parsed.commandReplyExpectations.filter((item) => item.command === '/p tmux').length, 2);
    assert.equal(parsed.commandReplyExpectations.filter((item) => item.command === `/cd ${DEFAULT_WORKSPACE_ROOT}`).length, 1);
    for (const command of ['/runtime codex', '/p tmux']) {
      const expectation = expectationAt(parsed.commandReplyExpectations, command);
      assert.ok(expectation.expectedTexts.length > 0);
      assert.equal(expectation.reason, 'history-empty-isolation setup command must reach the expected session/provider state before isolation assertions');
    }
    for (const command of [
      `/new histiso-a-unit-history-isolation ${DEFAULT_WORKSPACE_ROOT}`,
      `/new histiso-b-unit-history-isolation ${DEFAULT_WORKSPACE_ROOT}`,
      `/cd ${DEFAULT_WORKSPACE_ROOT}`,
    ]) {
      const expectation = expectationAt(parsed.commandReplyExpectations, command);
      assert.ok(expectation.expectedTexts.includes(DEFAULT_WORKSPACE_ROOT));
      assert.equal(expectation.reason, 'history-empty-isolation setup command must reach the expected session/provider state before isolation assertions');
    }
    const bGroupIndex = parsed.commands.indexOf(`/new histiso-b-unit-history-isolation ${DEFAULT_WORKSPACE_ROOT}`);
    assert.deepEqual(parsed.commands.slice(bGroupIndex + 1), ['/his', '/his raw 1', '/his msg 1']);

    const emptyHistoryCommands = ['/his', '/his raw 1', '/his msg 1'];
    for (const command of emptyHistoryCommands) {
      const expectation = expectationAt(parsed.commandReplyExpectations, command);
      assert.deepEqual(expectation.expectedTexts, ['当前会话还没有历史消息。']);
      assert.deepEqual(expectation.expectedForbiddenTexts, ['CODELARK_UNIT_HISTORY_ISOLATION']);
      assert.equal(expectation.replyTimeoutMs, 120_000);
      assert.equal(expectation.reason, 'empty history reply must include the empty-history text and must not contain another chat marker');
    }
  });

  it('dry-runs Kimi history-empty-isolation with forbidden marker assertions', () => {
    const output = runHarness([
      '--dry-run',
      '--scenario',
      'history-empty-isolation',
      '--runtime',
      'kimi',
      '--provider',
      'tmux',
      '--run-id',
      'unit-history-isolation-kimi',
      '--chat-id',
      'oc_unit',
      '--message',
      'CODELARK_UNIT_HISTORY_ISOLATION_KIMI',
    ]);
    const parsed = JSON.parse(output) as {
      coverage: {
        testName: string;
        dualProviderCompanion: string | null;
        matrixCompanions: string[];
      };
      commands: string[];
      validationChatSwitchesAfterNew: boolean;
      waitsForMirrorFinalBeforeFollowup: boolean;
      finalMessageObservationMode: string;
      plannedSuccessCheckNames: string[];
      commandReplyExpectations: Array<{
        command: string;
        expectedTexts: string[];
        expectedForbiddenTexts?: string[];
        expectedReplyMessageTypes: string[];
        expectedReplyContentKeys: string[];
        replyTimeoutMs: number;
        reason: string;
      }>;
    };

    assert.equal(parsed.coverage.testName, 'real-feishu::history-empty-isolation::kimi-tmux');
    assert.equal(parsed.coverage.dualProviderCompanion, 'real-feishu::history-empty-isolation::codex-tmux');
    assert.ok(parsed.coverage.matrixCompanions.includes('real-feishu::history-empty-isolation::claude-sdk'));
    assert.equal(parsed.validationChatSwitchesAfterNew, true);
    assert.equal(parsed.waitsForMirrorFinalBeforeFollowup, true);
    assert.equal(parsed.finalMessageObservationMode, 'mirror-stream-evidence');
    assert.ok(parsed.plannedSuccessCheckNames.includes('provider_output_path'));
    assert.ok(parsed.plannedSuccessCheckNames.includes('mirror_final_not_duplicated_in_direct_reply'));
    assert.deepEqual(parsed.commands, [
      '/runtime kimi',
      '/p tmux',
      `/new histiso-a-unit-history-isolation-kimi ${DEFAULT_WORKSPACE_ROOT}`,
      '/runtime kimi',
      '/p tmux',
      `/cd ${DEFAULT_WORKSPACE_ROOT}`,
      'Please reply exactly with this marker and no other text: CODELARK_UNIT_HISTORY_ISOLATION_KIMI',
      `/new histiso-b-unit-history-isolation-kimi ${DEFAULT_WORKSPACE_ROOT}`,
      '/his',
      '/his raw 1',
      '/his msg 1',
    ]);
    assert.equal(parsed.commandReplyExpectations.length, parsed.commands.length - 1);
    assert.equal(
      parsed.commandReplyExpectations.some((item) => item.command.includes('Please reply exactly')),
      false,
    );
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/runtime kimi', 0).expectedTexts, ['Runtime', 'kimi']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/p tmux', 0).expectedTexts, ['Kimi Provider', 'tmux']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/runtime kimi', 1).expectedTexts, ['Runtime', 'kimi']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/p tmux', 1).expectedTexts, ['Kimi Provider', 'tmux']);
    for (const command of [
      `/new histiso-a-unit-history-isolation-kimi ${DEFAULT_WORKSPACE_ROOT}`,
      `/new histiso-b-unit-history-isolation-kimi ${DEFAULT_WORKSPACE_ROOT}`,
    ]) {
      const expectation = expectationAt(parsed.commandReplyExpectations, command);
      assert.ok(expectation.expectedTexts.includes(DEFAULT_WORKSPACE_ROOT));
      assert.ok(expectation.expectedTexts.includes('Runtime'));
      assert.ok(expectation.expectedTexts.includes('Kimi Code'));
      assert.equal(expectation.reason, 'history-empty-isolation setup command must reach the expected session/provider state before isolation assertions');
    }
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, `/cd ${DEFAULT_WORKSPACE_ROOT}`).expectedTexts, ['已切换工作目录', DEFAULT_WORKSPACE_ROOT]);
    const bGroupIndex = parsed.commands.indexOf(`/new histiso-b-unit-history-isolation-kimi ${DEFAULT_WORKSPACE_ROOT}`);
    assert.deepEqual(parsed.commands.slice(bGroupIndex + 1), ['/his', '/his raw 1', '/his msg 1']);
    for (const command of ['/his', '/his raw 1', '/his msg 1']) {
      const expectation = expectationAt(parsed.commandReplyExpectations, command);
      assert.deepEqual(expectation.expectedTexts, ['当前会话还没有历史消息。']);
      assert.deepEqual(expectation.expectedForbiddenTexts, ['CODELARK_UNIT_HISTORY_ISOLATION_KIMI']);
      assert.equal(expectation.replyTimeoutMs, 120_000);
      assert.equal(expectation.reason, 'empty history reply must include the empty-history text and must not contain another chat marker');
    }
  });

  it('dry-runs history-long-truncation with head and forbidden tail assertions', () => {
    const output = runHarness([
      '--dry-run',
      '--scenario',
      'history-long-truncation',
      '--runtime',
      'codex',
      '--provider',
      'tmux',
      '--run-id',
      'unit-history-long',
      '--chat-id',
      'oc_unit',
      '--message',
      'CODELARK_UNIT_HISTORY_LONG',
    ]);
    const parsed = JSON.parse(output) as {
      coverage: {
        testName: string;
      };
      commands: string[];
      validationChatSwitchesAfterNew: boolean;
      waitsForMirrorFinalBeforeFollowup: boolean;
      commandReplyExpectations: Array<{
        command: string;
        expectedTexts: string[];
        expectedForbiddenTexts?: string[];
        expectedReplyMessageTypes: string[];
        expectedReplyContentKeys: string[];
        replyTimeoutMs: number;
        reason: string;
      }>;
    };

    assert.equal(parsed.coverage.testName, 'real-feishu::history-long-truncation::codex-tmux');
    assert.equal(parsed.validationChatSwitchesAfterNew, true);
    assert.equal(parsed.waitsForMirrorFinalBeforeFollowup, true);
    assert.deepEqual(parsed.commands.slice(0, 6), [
      '/runtime codex',
      '/p tmux',
      `/new histlong-unit-history-long ${DEFAULT_WORKSPACE_ROOT}`,
      '/runtime codex',
      '/p tmux',
      `/cd ${DEFAULT_WORKSPACE_ROOT}`,
    ]);
    assert.match(parsed.commands[6] || '', /^CODELARK_UNIT_HISTORY_LONG Reply exactly with CODELARK_UNIT_HISTORY_LONG\./);
    assert.match(parsed.commands[6] || '', /CODELARK_LONG_HISTORY_TAIL_UNIT_HISTORY_LONG$/);
    assert.deepEqual(parsed.commands.slice(7), ['/his raw 2', '/his msg 2']);
    assert.equal(parsed.commandReplyExpectations.length, parsed.commands.length - 1);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/runtime codex', 0).expectedTexts, ['Runtime', 'codex']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/p tmux', 0).expectedTexts, ['Codex Provider', 'tmux']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/runtime codex', 1).expectedTexts, ['Runtime', 'codex']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/p tmux', 1).expectedTexts, ['Codex Provider', 'tmux']);
    for (const command of [
      '/runtime codex',
      '/p tmux',
      `/new histlong-unit-history-long ${DEFAULT_WORKSPACE_ROOT}`,
      `/cd ${DEFAULT_WORKSPACE_ROOT}`,
    ]) {
      assert.equal(
        expectationAt(parsed.commandReplyExpectations, command).reason,
        'history-long-truncation setup command must reach the expected session/provider state before truncation assertions',
      );
    }

    for (const command of ['/his raw 2', '/his msg 2']) {
      const expectation = expectationAt(parsed.commandReplyExpectations, command);
      assert.ok(expectation.expectedTexts.includes('CODELARK_UNIT_HISTORY_LONG'));
      assert.ok(expectation.expectedTexts.includes('...'));
      assert.deepEqual(expectation.expectedForbiddenTexts, ['CODELARK_LONG_HISTORY_TAIL_UNIT_HISTORY_LONG']);
      assert.equal(expectation.replyTimeoutMs, 120_000);
      assert.equal(expectation.reason, 'long history reply must include the truncated head marker and must not contain the tail marker');
    }
  });

  it('dry-runs Kimi history-long-truncation with mirror truncation assertions', () => {
    const output = runHarness([
      '--dry-run',
      '--scenario',
      'history-long-truncation',
      '--runtime',
      'kimi',
      '--provider',
      'tmux',
      '--run-id',
      'unit-history-long-kimi',
      '--chat-id',
      'oc_unit',
      '--message',
      'CODELARK_UNIT_HISTORY_LONG_KIMI',
    ]);
    const parsed = JSON.parse(output) as {
      coverage: {
        testName: string;
        dualProviderCompanion: string | null;
        matrixCompanions: string[];
      };
      commands: string[];
      validationChatSwitchesAfterNew: boolean;
      waitsForMirrorFinalBeforeFollowup: boolean;
      finalMessageObservationMode: string;
      plannedSuccessCheckNames: string[];
      commandReplyExpectations: Array<{
        command: string;
        expectedTexts: string[];
        expectedForbiddenTexts?: string[];
        expectedReplyMessageTypes: string[];
        expectedReplyContentKeys: string[];
        replyTimeoutMs: number;
        reason: string;
      }>;
    };

    assert.equal(parsed.coverage.testName, 'real-feishu::history-long-truncation::kimi-tmux');
    assert.equal(parsed.coverage.dualProviderCompanion, 'real-feishu::history-long-truncation::codex-tmux');
    assert.ok(parsed.coverage.matrixCompanions.includes('real-feishu::history-long-truncation::claude-sdk'));
    assert.equal(parsed.validationChatSwitchesAfterNew, true);
    assert.equal(parsed.waitsForMirrorFinalBeforeFollowup, true);
    assert.equal(parsed.finalMessageObservationMode, 'mirror-stream-evidence');
    assert.ok(parsed.plannedSuccessCheckNames.includes('provider_output_path'));
    assert.ok(parsed.plannedSuccessCheckNames.includes('mirror_final_not_duplicated_in_direct_reply'));
    assert.deepEqual(parsed.commands.slice(0, 6), [
      '/runtime kimi',
      '/p tmux',
      `/new histlong-unit-history-long-kimi ${DEFAULT_WORKSPACE_ROOT}`,
      '/runtime kimi',
      '/p tmux',
      `/cd ${DEFAULT_WORKSPACE_ROOT}`,
    ]);
    assert.match(
      parsed.commands[6] || '',
      /^CODELARK_UNIT_HISTORY_LONG_KIMI Reply exactly with CODELARK_UNIT_HISTORY_LONG_KIMI\./,
    );
    assert.match(parsed.commands[6] || '', /CODELARK_LONG_HISTORY_TAIL_UNIT_HISTORY_LONG_KIMI$/);
    assert.deepEqual(parsed.commands.slice(7), ['/his raw 2', '/his msg 2']);
    assert.equal(parsed.commandReplyExpectations.length, parsed.commands.length - 1);
    assert.equal(
      parsed.commandReplyExpectations.some((item) => item.command.includes('CODELARK_UNIT_HISTORY_LONG_KIMI Reply exactly')),
      false,
    );
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/runtime kimi', 0).expectedTexts, ['Runtime', 'kimi']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/p tmux', 0).expectedTexts, ['Kimi Provider', 'tmux']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/runtime kimi', 1).expectedTexts, ['Runtime', 'kimi']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/p tmux', 1).expectedTexts, ['Kimi Provider', 'tmux']);
    for (const command of [
      `/new histlong-unit-history-long-kimi ${DEFAULT_WORKSPACE_ROOT}`,
    ]) {
      const expectation = expectationAt(parsed.commandReplyExpectations, command);
      assert.ok(expectation.expectedTexts.includes(DEFAULT_WORKSPACE_ROOT));
      assert.ok(expectation.expectedTexts.includes('Runtime'));
      assert.ok(expectation.expectedTexts.includes('Kimi Code'));
      assert.equal(
        expectation.reason,
        'history-long-truncation setup command must reach the expected session/provider state before truncation assertions',
      );
    }
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, `/cd ${DEFAULT_WORKSPACE_ROOT}`).expectedTexts, ['已切换工作目录', DEFAULT_WORKSPACE_ROOT]);

    for (const command of ['/his raw 2', '/his msg 2']) {
      const expectation = expectationAt(parsed.commandReplyExpectations, command);
      assert.ok(expectation.expectedTexts.includes('CODELARK_UNIT_HISTORY_LONG_KIMI'));
      assert.ok(expectation.expectedTexts.includes('...'));
      assert.deepEqual(expectation.expectedForbiddenTexts, ['CODELARK_LONG_HISTORY_TAIL_UNIT_HISTORY_LONG_KIMI']);
      assert.equal(expectation.replyTimeoutMs, 120_000);
      assert.equal(expectation.reason, 'long history reply must include the truncated head marker and must not contain the tail marker');
    }
  });

  it('dry-runs history-suite with staged A/B chat history assertions', () => {
    const output = runHarness([
      '--dry-run',
      '--scenario',
      'history-suite',
      '--runtime',
      'codex',
      '--provider',
      'tmux',
      '--run-id',
      'unit-history-suite',
      '--chat-id',
      'oc_unit',
      '--message',
      'CODELARK_UNIT_HISTORY_SUITE',
    ]);
    const parsed = JSON.parse(output) as {
      coverage: {
        testName: string;
        providerCoverage: string;
        matrix: string[];
        matrixCompanions: string[];
      };
      commands: string[];
      validationChatSwitchesAfterNew: boolean;
      waitsForMirrorFinalBeforeFollowup: boolean;
      finalMessageObservationMode: string;
      plannedSuccessCheckNames: string[];
      commandReplyExpectations: Array<{
        command: string;
        expectedTexts: string[];
        expectedForbiddenTexts?: string[];
        expectedReplyMessageTypes: string[];
        expectedReplyContentKeys: string[];
        replyTimeoutMs: number;
        reason: string;
      }>;
    };

    assert.equal(parsed.coverage.testName, 'real-feishu::history-suite::codex-tmux');
    assert.equal(parsed.coverage.providerCoverage, 'runtime-parameterized');
    assert.deepEqual(parsed.coverage.matrix, expectedRuntimeProviderMatrix('real-feishu::history-suite'));
    assert.ok(parsed.coverage.matrixCompanions.includes('real-feishu::history-suite::kimi-tmux'));
    assert.equal(parsed.validationChatSwitchesAfterNew, true);
    assert.equal(parsed.waitsForMirrorFinalBeforeFollowup, true);
    assert.equal(parsed.finalMessageObservationMode, 'mirror-stream-evidence');
    assert.ok(parsed.plannedSuccessCheckNames.includes('runtime_prompt_final_transcript_marker'));
    assert.ok(parsed.plannedSuccessCheckNames.includes('history_suite_transcript_contract'));
    assert.deepEqual(parsed.commands.slice(0, 6), [
      '/runtime codex',
      '/p tmux',
      `/new histsuite-a-unit-history-suite ${DEFAULT_WORKSPACE_ROOT}`,
      '/runtime codex',
      '/p tmux',
      `/cd ${DEFAULT_WORKSPACE_ROOT}`,
    ]);
    assert.equal(parsed.commands[6], 'Please reply exactly with this marker and no other text: CODELARK_UNIT_HISTORY_SUITE');
    assert.deepEqual(parsed.commands.slice(7, 13), [
      '/his raw 1',
      '/his limit 3',
      '/his',
      '/his msg 1',
      '/his json',
      '/his file',
    ]);
    assert.match(parsed.commands[13] || '', /^CODELARK_HISTORY_SUITE_LONG_HEAD_UNIT_HISTORY_SUITE Reply exactly with CODELARK_HISTORY_SUITE_LONG_HEAD_UNIT_HISTORY_SUITE\./);
    assert.match(parsed.commands[13] || '', /CODELARK_HISTORY_SUITE_LONG_TAIL_UNIT_HISTORY_SUITE$/);
    assert.deepEqual(parsed.commands.slice(14), [
      '/his raw 2',
      '/his msg 2',
      `/new histsuite-b-unit-history-suite ${DEFAULT_WORKSPACE_ROOT}`,
      '/his',
      '/his raw 1',
      '/his msg 1',
    ]);

    assert.equal(parsed.commandReplyExpectations.length, parsed.commands.length - 2);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/runtime codex', 0).expectedTexts, ['Runtime', 'codex']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/p tmux', 0).expectedTexts, ['Codex Provider', 'tmux']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/runtime codex', 1).expectedTexts, ['Runtime', 'codex']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/p tmux', 1).expectedTexts, ['Codex Provider', 'tmux']);
    for (const command of [
      '/runtime codex',
      '/p tmux',
      `/new histsuite-a-unit-history-suite ${DEFAULT_WORKSPACE_ROOT}`,
      `/new histsuite-b-unit-history-suite ${DEFAULT_WORKSPACE_ROOT}`,
      `/cd ${DEFAULT_WORKSPACE_ROOT}`,
    ]) {
      assert.equal(
        expectationAt(parsed.commandReplyExpectations, command).reason,
        'history-suite setup command must reach the expected session/provider state before history assertions',
      );
    }
    assert.equal(
      parsed.commandReplyExpectations.some((item) => item.command.includes('Please reply exactly')),
      false,
    );
    assert.equal(
      parsed.commandReplyExpectations.some((item) => item.command.includes('CODELARK_HISTORY_SUITE_LONG_HEAD')),
      false,
    );
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/his raw 1', 0).expectedTexts, [
      '最近对话（解析文本）',
      '返回条数',
      '本次 1',
      'CODELARK_UNIT_HISTORY_SUITE',
    ]);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/his limit 3').expectedTexts, ['已将 /his msg 返回条数限制设置为 3']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/his', 0).expectedTexts, [
      '最近对话',
      '返回条数',
      '配置 3',
      'CODELARK_UNIT_HISTORY_SUITE',
    ]);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/his msg 1', 0).expectedTexts, [
      '最近对话',
      '本次 1',
      'CODELARK_UNIT_HISTORY_SUITE',
    ]);
    for (const command of ['/his json', '/his file']) {
      const expectation = expectationAt(parsed.commandReplyExpectations, command);
      assert.deepEqual(expectation.expectedReplyMessageTypes, ['file']);
      assert.deepEqual(expectation.expectedReplyContentKeys, ['file_key']);
      assert.equal(expectation.reason, 'history attachment command must reply with a Feishu file message containing a Feishu file key');
    }
    for (const command of ['/his raw 2', '/his msg 2']) {
      const expectation = expectationAt(parsed.commandReplyExpectations, command);
      assert.ok(expectation.expectedTexts.includes('CODELARK_HISTORY_SUITE_LONG_HEAD_UNIT_HISTORY_SUITE'));
      assert.ok(expectation.expectedTexts.includes('...'));
      assert.deepEqual(expectation.expectedForbiddenTexts, ['CODELARK_HISTORY_SUITE_LONG_TAIL_UNIT_HISTORY_SUITE']);
      assert.equal(expectation.reason, 'history-suite long reply must include the truncated head marker and must not contain the tail marker');
    }
    for (const [command, occurrence] of [
      ['/his', 1],
      ['/his raw 1', 1],
      ['/his msg 1', 1],
    ] as const) {
      const expectation = expectationAt(parsed.commandReplyExpectations, command, occurrence);
      assert.deepEqual(expectation.expectedTexts, ['当前会话还没有历史消息。']);
      assert.deepEqual(expectation.expectedForbiddenTexts, [
        'CODELARK_UNIT_HISTORY_SUITE',
        'CODELARK_HISTORY_SUITE_LONG_HEAD_UNIT_HISTORY_SUITE',
        'CODELARK_HISTORY_SUITE_LONG_TAIL_UNIT_HISTORY_SUITE',
      ]);
      assert.equal(expectation.reason, 'history-suite empty chat reply must include the empty-history text and must not contain A chat markers');
    }
  });

  it('dry-runs Kimi history-suite through the shared Feishu history matrix', () => {
    const output = runHarness([
      '--dry-run',
      '--scenario',
      'history-suite',
      '--runtime',
      'kimi',
      '--provider',
      'tmux',
      '--run-id',
      'unit-history-suite-kimi',
      '--chat-id',
      'oc_unit',
      '--message',
      'CODELARK_UNIT_HISTORY_SUITE_KIMI',
    ]);
    const parsed = JSON.parse(output) as {
      coverage: {
        testName: string;
        providerCoverage: string;
        matrix: string[];
        matrixCompanions: string[];
        dualProviderCompanion: string | null;
      };
      commands: string[];
      validationChatSwitchesAfterNew: boolean;
      waitsForMirrorFinalBeforeFollowup: boolean;
      finalMessageObservationMode: string;
      plannedSuccessCheckNames: string[];
      commandReplyExpectations: Array<{
        command: string;
        expectedTexts: string[];
        expectedForbiddenTexts?: string[];
        expectedReplyMessageTypes: string[];
        expectedReplyContentKeys: string[];
        replyTimeoutMs: number;
        reason: string;
      }>;
    };

    assert.equal(parsed.coverage.testName, 'real-feishu::history-suite::kimi-tmux');
    assert.equal(parsed.coverage.providerCoverage, 'runtime-parameterized');
    assert.deepEqual(parsed.coverage.matrix, expectedRuntimeProviderMatrix('real-feishu::history-suite'));
    assert.equal(parsed.coverage.dualProviderCompanion, 'real-feishu::history-suite::codex-tmux');
    assert.ok(parsed.coverage.matrixCompanions.includes('real-feishu::history-suite::claude-sdk'));
    assert.equal(parsed.validationChatSwitchesAfterNew, true);
    assert.equal(parsed.waitsForMirrorFinalBeforeFollowup, true);
    assert.equal(parsed.finalMessageObservationMode, 'mirror-stream-evidence');
    assert.ok(parsed.plannedSuccessCheckNames.includes('provider_output_path'));
    assert.ok(parsed.plannedSuccessCheckNames.includes('mirror_final_not_duplicated_in_direct_reply'));
    assert.ok(parsed.plannedSuccessCheckNames.includes('runtime_prompt_final_transcript_marker'));
    assert.ok(parsed.plannedSuccessCheckNames.includes('history_suite_transcript_contract'));
    assert.deepEqual(parsed.commands.slice(0, 6), [
      '/runtime kimi',
      '/p tmux',
      `/new histsuite-a-unit-history-suite-kimi ${DEFAULT_WORKSPACE_ROOT}`,
      '/runtime kimi',
      '/p tmux',
      `/cd ${DEFAULT_WORKSPACE_ROOT}`,
    ]);
    assert.equal(parsed.commands[6], 'Please reply exactly with this marker and no other text: CODELARK_UNIT_HISTORY_SUITE_KIMI');
    assert.deepEqual(parsed.commands.slice(7, 13), [
      '/his raw 1',
      '/his limit 3',
      '/his',
      '/his msg 1',
      '/his json',
      '/his file',
    ]);
    assert.match(parsed.commands[13] || '', /^CODELARK_HISTORY_SUITE_LONG_HEAD_UNIT_HISTORY_SUITE_KIMI Reply exactly with CODELARK_HISTORY_SUITE_LONG_HEAD_UNIT_HISTORY_SUITE_KIMI\./);
    assert.match(parsed.commands[13] || '', /CODELARK_HISTORY_SUITE_LONG_TAIL_UNIT_HISTORY_SUITE_KIMI$/);
    assert.deepEqual(parsed.commands.slice(14), [
      '/his raw 2',
      '/his msg 2',
      `/new histsuite-b-unit-history-suite-kimi ${DEFAULT_WORKSPACE_ROOT}`,
      '/his',
      '/his raw 1',
      '/his msg 1',
    ]);

    assert.equal(parsed.commandReplyExpectations.length, parsed.commands.length - 2);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/runtime kimi', 0).expectedTexts, ['Runtime', 'kimi']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/p tmux', 0).expectedTexts, ['Kimi Provider', 'tmux']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/runtime kimi', 1).expectedTexts, ['Runtime', 'kimi']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/p tmux', 1).expectedTexts, ['Kimi Provider', 'tmux']);
    assert.equal(
      parsed.commandReplyExpectations.some((item) => item.command.includes('Please reply exactly')),
      false,
    );
    assert.equal(
      parsed.commandReplyExpectations.some((item) => item.command.includes('CODELARK_HISTORY_SUITE_LONG_HEAD')),
      false,
    );
    for (const command of [
      `/new histsuite-a-unit-history-suite-kimi ${DEFAULT_WORKSPACE_ROOT}`,
      `/new histsuite-b-unit-history-suite-kimi ${DEFAULT_WORKSPACE_ROOT}`,
    ]) {
      const expectation = expectationAt(parsed.commandReplyExpectations, command);
      assert.ok(expectation.expectedTexts.includes(DEFAULT_WORKSPACE_ROOT));
      assert.ok(expectation.expectedTexts.includes('Runtime'));
      assert.ok(expectation.expectedTexts.includes('Kimi Code'));
      assert.equal(expectation.reason, 'history-suite setup command must reach the expected session/provider state before history assertions');
    }

    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/his raw 1', 0).expectedTexts, [
      '最近对话（解析文本）',
      '返回条数',
      '本次 1',
      'CODELARK_UNIT_HISTORY_SUITE_KIMI',
    ]);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/his limit 3').expectedTexts, ['已将 /his msg 返回条数限制设置为 3']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/his', 0).expectedTexts, [
      '最近对话',
      '返回条数',
      '配置 3',
      'CODELARK_UNIT_HISTORY_SUITE_KIMI',
    ]);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/his msg 1', 0).expectedTexts, [
      '最近对话',
      '本次 1',
      'CODELARK_UNIT_HISTORY_SUITE_KIMI',
    ]);
    for (const command of ['/his json', '/his file']) {
      const expectation = expectationAt(parsed.commandReplyExpectations, command);
      assert.deepEqual(expectation.expectedReplyMessageTypes, ['file']);
      assert.deepEqual(expectation.expectedReplyContentKeys, ['file_key']);
      assert.equal(expectation.reason, 'history attachment command must reply with a Feishu file message containing a Feishu file key');
    }
    for (const command of ['/his raw 2', '/his msg 2']) {
      const expectation = expectationAt(parsed.commandReplyExpectations, command);
      assert.ok(expectation.expectedTexts.includes('CODELARK_HISTORY_SUITE_LONG_HEAD_UNIT_HISTORY_SUITE_KIMI'));
      assert.ok(expectation.expectedTexts.includes('...'));
      assert.deepEqual(expectation.expectedForbiddenTexts, ['CODELARK_HISTORY_SUITE_LONG_TAIL_UNIT_HISTORY_SUITE_KIMI']);
      assert.equal(expectation.reason, 'history-suite long reply must include the truncated head marker and must not contain the tail marker');
    }
    for (const [command, occurrence] of [
      ['/his', 1],
      ['/his raw 1', 1],
      ['/his msg 1', 1],
    ] as const) {
      const expectation = expectationAt(parsed.commandReplyExpectations, command, occurrence);
      assert.deepEqual(expectation.expectedTexts, ['当前会话还没有历史消息。']);
      assert.deepEqual(expectation.expectedForbiddenTexts, [
        'CODELARK_UNIT_HISTORY_SUITE_KIMI',
        'CODELARK_HISTORY_SUITE_LONG_HEAD_UNIT_HISTORY_SUITE_KIMI',
        'CODELARK_HISTORY_SUITE_LONG_TAIL_UNIT_HISTORY_SUITE_KIMI',
      ]);
      assert.equal(expectation.reason, 'history-suite empty chat reply must include the empty-history text and must not contain A chat markers');
    }
  });

  it('dry-runs card-forms with interactive CardKit form assertions', () => {
    const output = runHarness([
      '--dry-run',
      '--scenario',
      'card-forms',
      '--runtime',
      'codex',
      '--provider',
      'sdk',
      '--run-id',
      'unit-card-forms',
      '--chat-id',
      'oc_unit',
      '--message',
      'CODELARK_UNIT_CARD_FORMS',
    ]);
    const parsed = JSON.parse(output) as {
      coverage: {
        testName: string;
        providerCoverage: string;
      };
      commands: string[];
      validationChatSwitchesAfterNew: boolean;
      waitsForMirrorFinalBeforeFollowup: boolean;
      commandReplyExpectations: Array<{
        command: string;
        expectedTexts: string[];
        expectedReplyMessageTypes: string[];
        expectedReplyContentKeys: string[];
        replyTimeoutMs: number;
        reason: string;
      }>;
    };

    assert.equal(parsed.coverage.testName, 'real-feishu::card-forms::codex');
    assert.equal(parsed.coverage.providerCoverage, 'runtime-neutral');
    assert.deepEqual(parsed.commands, ['/new', '/every-form', '/then-form']);
    assert.equal(parsed.validationChatSwitchesAfterNew, false);
    assert.equal(parsed.waitsForMirrorFinalBeforeFollowup, false);

    const newExpectation = expectationAt(parsed.commandReplyExpectations, '/new');
    assert.deepEqual(newExpectation.expectedTexts, [
      '创建群聊会话',
      '<form>',
      '**群聊名称**',
      '**工作目录**',
      '[创建]',
      '提交后等同发送 `/new <名称> <目录>`。',
    ]);
    assert.deepEqual(newExpectation.expectedReplyMessageTypes, ['interactive']);
    assert.deepEqual(newExpectation.expectedReplyContentKeys, []);
    assert.equal(newExpectation.replyTimeoutMs, 15_000);
    assert.equal(newExpectation.reason, 'card form command must reply with a Feishu interactive form whose visible labels survive user-side transcript normalization');

    const everyExpectation = expectationAt(parsed.commandReplyExpectations, '/every-form');
    assert.deepEqual(everyExpectation.expectedTexts, [
      '新建 /every 定时输入',
      '<form>',
      '**间隔**',
      '**Prompt**',
      '[创建]',
      '提交后等同发送 `/every <数字><s|m|h|d> <prompt>`。',
    ]);
    assert.deepEqual(everyExpectation.expectedReplyMessageTypes, ['interactive']);
    assert.deepEqual(everyExpectation.expectedReplyContentKeys, []);
    assert.equal(everyExpectation.replyTimeoutMs, 15_000);
    assert.equal(everyExpectation.reason, 'card form command must reply with a Feishu interactive form whose visible labels survive user-side transcript normalization');

    const thenExpectation = expectationAt(parsed.commandReplyExpectations, '/then-form');
    assert.deepEqual(thenExpectation.expectedTexts, [
      '新建 /then 后续输入',
      '<form>',
      '**Prompt**',
      '[创建]',
      '提交后等同发送 `/then <prompt>`。',
    ]);
    assert.deepEqual(thenExpectation.expectedReplyMessageTypes, ['interactive']);
    assert.deepEqual(thenExpectation.expectedReplyContentKeys, []);
    assert.equal(thenExpectation.replyTimeoutMs, 15_000);
    assert.equal(thenExpectation.reason, 'card form command must reply with a Feishu interactive form whose visible labels survive user-side transcript normalization');
  });

  it('dry-runs agent-question-forms with model-generated CardKit form assertions', () => {
    const output = runHarness([
      '--dry-run',
      '--scenario',
      'agent-question-forms',
      '--runtime',
      'claude',
      '--provider',
      'sdk',
      '--fake-ccr',
      '--run-id',
      'unit-agent-question-form',
      '--chat-id',
      'oc_unit',
      '--message',
      'CODELARK_UNIT_AGENT_QUESTION_FORM_PROMPT',
    ]);
    const parsed = JSON.parse(output) as {
      coverage: {
        testName: string;
        providerCoverage: string;
        matrix: string[];
      };
      commands: string[];
      validationChatSwitchesAfterNew: boolean;
      waitsForMirrorFinalBeforeFollowup: boolean;
      plannedSuccessCheckNames: string[];
      commandReplyExpectations: Array<{
        command: string;
        expectedTexts: string[];
        expectedReplyMessageTypes: string[];
        expectedReplyContentKeys: string[];
        replyTimeoutMs: number;
        reason: string;
      }>;
    };

    assert.equal(parsed.coverage.testName, 'real-feishu::agent-question-forms::claude-sdk');
    assert.equal(parsed.coverage.providerCoverage, 'runtime-parameterized');
    assert.ok(parsed.coverage.matrix.includes('real-feishu::agent-question-forms::codex-tmux'));
    assert.deepEqual(parsed.commands, [
      '/runtime claude',
      '/p sdk',
      'CODELARK_UNIT_AGENT_QUESTION_FORM_PROMPT',
    ]);
    assert.ok(parsed.plannedSuccessCheckNames.includes('agent_question_form_interactive_transcript'));
    assert.equal(parsed.validationChatSwitchesAfterNew, false);
    assert.equal(parsed.waitsForMirrorFinalBeforeFollowup, false);

    const expectation = expectationAt(parsed.commandReplyExpectations, 'CODELARK_UNIT_AGENT_QUESTION_FORM_PROMPT');
    assert.deepEqual(expectation.expectedTexts, [
      '需要确认',
      '<form>',
      '请选择发布策略',
      '灰度',
      '全量',
      '补充说明',
      '[提交]',
    ]);
    assert.deepEqual(expectation.expectedReplyMessageTypes, ['interactive']);
    assert.deepEqual(expectation.expectedReplyContentKeys, []);
    assert.equal(expectation.replyTimeoutMs, 120_000);
    assert.equal(expectation.reason, 'agent question form must reply with a Feishu interactive form whose visible question and choices survive user-side transcript normalization');
  });

  it('dry-runs Kimi agent-question-forms with runtime/provider seed and mirror form assertions', () => {
    const output = runHarness([
      '--dry-run',
      '--scenario',
      'agent-question-forms',
      '--runtime',
      'kimi',
      '--provider',
      'tmux',
      '--run-id',
      'unit-agent-question-form-kimi',
      '--chat-id',
      'oc_unit',
      '--message',
      'CODELARK_UNIT_AGENT_QUESTION_FORM_KIMI_PROMPT',
    ]);
    const parsed = JSON.parse(output) as {
      coverage: {
        testName: string;
        matrix: string[];
      };
      commands: string[];
      waitsForMirrorFinalBeforeFollowup: boolean;
      finalMessageObservationMode: string;
      plannedSuccessCheckNames: string[];
      commandReplyExpectations: Array<{
        command: string;
        expectedTexts: string[];
        expectedReplyMessageTypes: string[];
        expectedReplyContentKeys: string[];
        replyTimeoutMs: number;
        reason: string;
      }>;
    };

    assert.equal(parsed.coverage.testName, 'real-feishu::agent-question-forms::kimi-tmux');
    assert.ok(parsed.coverage.matrix.includes('real-feishu::agent-question-forms::claude-sdk'));
    assert.deepEqual(parsed.commands, [
      '/runtime kimi',
      '/p tmux',
      'CODELARK_UNIT_AGENT_QUESTION_FORM_KIMI_PROMPT',
    ]);
    assert.equal(parsed.waitsForMirrorFinalBeforeFollowup, true);
    assert.equal(parsed.finalMessageObservationMode, 'mirror-stream-evidence');
    assert.ok(parsed.plannedSuccessCheckNames.includes('agent_question_form_interactive_transcript'));

    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/runtime kimi').expectedTexts, ['Runtime', 'kimi']);
    assert.equal(expectationAt(parsed.commandReplyExpectations, '/runtime kimi').reason, 'agent question runtime/provider seed must reach the final selected state before sending the model prompt');
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/p tmux').expectedTexts, ['Kimi Provider', 'tmux']);

    const formExpectation = expectationAt(parsed.commandReplyExpectations, 'CODELARK_UNIT_AGENT_QUESTION_FORM_KIMI_PROMPT');
    assert.deepEqual(formExpectation.expectedTexts, [
      '需要确认',
      '<form>',
      '请选择发布策略',
      '灰度',
      '全量',
      '补充说明',
      '[提交]',
    ]);
    assert.deepEqual(formExpectation.expectedReplyMessageTypes, ['interactive']);
    assert.deepEqual(formExpectation.expectedReplyContentKeys, []);
    assert.equal(formExpectation.replyTimeoutMs, 120_000);
    assert.equal(formExpectation.reason, 'agent question form must reply with a Feishu interactive form whose visible question and choices survive user-side transcript normalization');
  });

  it('rejects non-isolated real runs before creating Feishu state', () => {
    const output = runHarnessFailure([
      '--scenario',
      'history-empty-isolation',
      '--runtime',
      'claude',
      '--provider',
      'tmux',
      '--fake-ccr',
      '--chat-id',
      'oc_unit',
      '--clk-home',
      path.join(os.tmpdir(), 'clk-real-feishu-live-home'),
    ], { CODELARK_REAL_FEISHU_E2E: '1' });

    assert.match(output, /Refusing to run real Feishu E2E without --launch-bridge/);
    assert.match(output, /isolated bridge/);
  });

  it('dry-runs markdown-rendering with table and fenced-code assertions for mirror providers', () => {
    const output = runHarness([
      '--dry-run',
      '--scenario',
      'markdown-rendering',
      '--runtime',
      'codex',
      '--provider',
      'tmux',
      '--run-id',
      'unit-markdown-rendering',
      '--chat-id',
      'oc_unit',
    ]);
    const parsed = JSON.parse(output) as {
      coverage: {
        testName: string;
        providerCoverage: string;
        matrix: string[];
      };
      commands: string[];
      waitsForMirrorFinalBeforeFollowup: boolean;
      finalMessageObservationMode: string;
      plannedSuccessCheckNames: string[];
      commandReplyExpectations: Array<{
        command: string;
        expectedTexts: string[];
        expectedReplyMessageTypes: string[];
        expectedReplyContentKeys: string[];
        replyTimeoutMs: number;
        reason: string;
      }>;
    };

    assert.equal(parsed.coverage.testName, 'real-feishu::markdown-rendering::codex-tmux');
    assert.equal(parsed.coverage.providerCoverage, 'runtime-parameterized');
    assert.ok(parsed.coverage.matrix.includes('real-feishu::markdown-rendering::claude-sdk'));
    assert.equal(parsed.waitsForMirrorFinalBeforeFollowup, true);
    assert.equal(parsed.finalMessageObservationMode, 'mirror-stream-evidence');
    assert.ok(parsed.plannedSuccessCheckNames.includes('runtime_prompt_final_transcript_marker'));
    assert.ok(parsed.plannedSuccessCheckNames.includes('markdown_rendering_transcript_structure'));
    assert.equal(parsed.commands[0], '/runtime codex');
    assert.equal(parsed.commands[1], '/p tmux');
    assert.match(parsed.commands[2] || '', /请严格原样回复下面的 Markdown/);
    assert.match(parsed.commands[2] || '', /CODELARK_MARKDOWN_RENDERING_UNIT_MARKDOWN_RENDERING/);

    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/runtime codex').expectedTexts, ['Runtime', 'codex']);
    const providerExpectation = expectationAt(parsed.commandReplyExpectations, '/p tmux');
    assert.deepEqual(providerExpectation.expectedTexts, ['Codex Provider', 'tmux']);
    assert.equal(providerExpectation.reason, 'markdown rendering runtime/provider seed must reach the final selected state before sending the markdown prompt');

    const expectation = expectationAt(parsed.commandReplyExpectations, parsed.commands[2]);
    assert.deepEqual(expectation.expectedTexts, [
      'CODELARK_MARKDOWN_RENDERING_UNIT_MARKDOWN_RENDERING',
      '| 项目 | 状态 |',
      '| 表格行 | 通过 |',
      '```plain_text',
      'const ctiMarkdown = "ok";',
    ]);
    assert.deepEqual(expectation.expectedReplyMessageTypes, []);
    assert.deepEqual(expectation.expectedReplyContentKeys, []);
    assert.equal(expectation.replyTimeoutMs, 120_000);
    assert.equal(expectation.reason, 'markdown rendering final reply must include the expected marker, table, fenced code block, and language tag');
  });

  it('dry-runs Kimi markdown-rendering with table and fenced-code assertions', () => {
    const output = runHarness([
      '--dry-run',
      '--scenario',
      'markdown-rendering',
      '--runtime',
      'kimi',
      '--provider',
      'tmux',
      '--run-id',
      'unit-markdown-rendering-kimi',
      '--chat-id',
      'oc_unit',
      '--message',
      'CODELARK_MARKDOWN_RENDERING_KIMI',
    ]);
    const parsed = JSON.parse(output) as {
      coverage: {
        testName: string;
        providerCoverage: string;
        dualProviderCompanion: string | null;
        matrix: string[];
      };
      commands: string[];
      waitsForMirrorFinalBeforeFollowup: boolean;
      finalMessageObservationMode: string;
      plannedSuccessCheckNames: string[];
      commandReplyExpectations: Array<{
        command: string;
        expectedTexts: string[];
        expectedReplyMessageTypes: string[];
        expectedReplyContentKeys: string[];
        replyTimeoutMs: number;
        reason: string;
      }>;
    };

    assert.equal(parsed.coverage.testName, 'real-feishu::markdown-rendering::kimi-tmux');
    assert.equal(parsed.coverage.providerCoverage, 'runtime-parameterized');
    assert.equal(parsed.coverage.dualProviderCompanion, 'real-feishu::markdown-rendering::codex-tmux');
    assert.ok(parsed.coverage.matrix.includes('real-feishu::markdown-rendering::claude-sdk'));
    assert.ok(parsed.coverage.matrix.includes('real-feishu::markdown-rendering::codex-tmux'));
    assert.equal(parsed.waitsForMirrorFinalBeforeFollowup, true);
    assert.equal(parsed.finalMessageObservationMode, 'mirror-stream-evidence');
    assert.ok(parsed.plannedSuccessCheckNames.includes('provider_output_path'));
    assert.ok(parsed.plannedSuccessCheckNames.includes('mirror_final_not_duplicated_in_direct_reply'));
    assert.ok(parsed.plannedSuccessCheckNames.includes('runtime_prompt_final_transcript_marker'));
    assert.ok(parsed.plannedSuccessCheckNames.includes('markdown_rendering_transcript_structure'));
    assert.equal(parsed.commands[0], '/runtime kimi');
    assert.equal(parsed.commands[1], '/p tmux');
    assert.match(parsed.commands[2] || '', /请严格原样回复下面的 Markdown/);
    assert.match(parsed.commands[2] || '', /CODELARK_MARKDOWN_RENDERING_UNIT_MARKDOWN_RENDERING_KIMI/);

    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/runtime kimi').expectedTexts, ['Runtime', 'kimi']);
    const providerExpectation = expectationAt(parsed.commandReplyExpectations, '/p tmux');
    assert.deepEqual(providerExpectation.expectedTexts, ['Kimi Provider', 'tmux']);
    assert.equal(providerExpectation.reason, 'markdown rendering runtime/provider seed must reach the final selected state before sending the markdown prompt');

    const expectation = expectationAt(parsed.commandReplyExpectations, parsed.commands[2]);
    assert.deepEqual(expectation.expectedTexts, [
      'CODELARK_MARKDOWN_RENDERING_UNIT_MARKDOWN_RENDERING_KIMI',
      '| 项目 | 状态 |',
      '| 表格行 | 通过 |',
      '```plain_text',
      'const ctiMarkdown = "ok";',
    ]);
    assert.deepEqual(expectation.expectedReplyMessageTypes, []);
    assert.deepEqual(expectation.expectedReplyContentKeys, []);
    assert.equal(expectation.replyTimeoutMs, 120_000);
    assert.equal(expectation.reason, 'markdown rendering final reply must include the expected marker, table, fenced code block, and language tag');
  });

  it('dry-runs doc-as-chat-from-scratch with document and user-read context gates', () => {
    const output = runHarness([
      '--dry-run',
      '--scenario',
      'doc-as-chat-from-scratch',
      '--runtime',
      'codex',
      '--provider',
      'tmux',
      '--run-id',
      'unit-doc-as-chat',
    ]);
    const parsed = JSON.parse(output) as {
      plannedChatId: string;
      docAsChatScenario: {
        document: { fileType: string; token: string; marker: string };
        comment: { commentId: string };
        createdGroup: { chatId: string; name: string };
        binding: unknown;
      };
      coverage: {
        e2eCoverage: string[];
      };
    };

    assert.equal(parsed.plannedChatId, '<created-doc-chat-id>');
    assert.equal(parsed.docAsChatScenario.document.fileType, 'docx');
    assert.equal(parsed.docAsChatScenario.document.token, '<doc-token>');
    assert.equal(parsed.docAsChatScenario.comment.commentId, '<comment-id>');
    assert.equal(parsed.docAsChatScenario.createdGroup.chatId, '<created-doc-chat-id>');
    assert.match(parsed.docAsChatScenario.createdGroup.name, /clk-doc-chat-unit-doc-as-chat/);
    assert.ok(JSON.stringify(parsed.docAsChatScenario.binding).includes('commentId'));
    assert.ok(parsed.coverage.e2eCoverage.includes('e2e::lark-cli-user-chat-read'));
    assert.ok(parsed.coverage.e2eCoverage.includes('e2e::doc-as-chat-context-file-token-marker'));
    assert.ok(parsed.coverage.e2eCoverage.includes('e2e::created-document-cleanup'));
  });

  it('dry-runs basic-dialogue-suite as a single cross-provider conversation plan', () => {
    const output = runHarness([
      '--dry-run',
      '--scenario',
      'basic-dialogue-suite',
      '--run-id',
      'unit-basic-dialogue',
      '--chat-id',
      'oc_unit',
    ]);
    const parsed = JSON.parse(output) as {
      coverage: {
        testName: string;
        providerCoverage: string;
        coverageTier: string;
        providerSequence: string[];
        basicDialogueSuite: {
          scriptedBridgeModel: boolean;
          sdkMirrorSuppressionObservationWindowMs: number;
          queuedFollowupDelayMs: number;
          queuedFollowupProviderKeys: string[];
          appendInputProviderKeys: string[];
          followupSemantics: {
            codexSdk: string;
            claudeSdk: string;
            terminalRuntime: string;
          };
          phases: Array<{
            providerKey: string;
            runtime: string;
            provider: string;
            marker: string;
            outputObservationMode: string;
            followupInputSemantics: string;
            followupCommand?: string;
            appendInputGate?: string;
            mirrorSuppressionObservationWindowMs?: number;
            stopCommand?: string;
          }>;
        };
        matrix: string[];
        coverageNotes: string[];
      };
      commands: string[];
      waitsForMirrorFinalBeforeFollowup: boolean;
      finalMessageObservationMode: string;
      commandReplyExpectations: Array<{
        command: string;
        expectedTexts: string[];
        observationMode: string;
        replyTimeoutMs: number;
        reason: string;
      }>;
    };

    assert.equal(parsed.coverage.testName, 'real-feishu::basic-dialogue-suite::cross-provider');
    assert.equal(parsed.coverage.providerCoverage, 'cross-provider-suite');
    assert.equal(parsed.coverage.coverageTier, 'mandatory-suite');
    assert.deepEqual(parsed.coverage.providerSequence, [
      'codex-sdk',
      'claude-sdk',
      'kimi-tmux',
      'codex-tmux',
    ]);
    assert.deepEqual(parsed.coverage.matrix, ['real-feishu::basic-dialogue-suite::cross-provider']);
    assert.ok(parsed.coverage.coverageNotes.some((note) => note.includes('同一会话')));
    assert.ok(parsed.coverage.coverageNotes.some((note) => note.includes('mandatory-suite')));
    assert.equal(parsed.coverage.basicDialogueSuite.scriptedBridgeModel, false);
    assert.equal(parsed.coverage.basicDialogueSuite.sdkMirrorSuppressionObservationWindowMs, 10_000);
    assert.equal(parsed.coverage.basicDialogueSuite.queuedFollowupDelayMs, 250);
    assert.deepEqual(parsed.coverage.basicDialogueSuite.queuedFollowupProviderKeys, ['codex-sdk']);
    assert.deepEqual(parsed.coverage.basicDialogueSuite.appendInputProviderKeys, ['kimi-tmux', 'codex-tmux']);
    assert.deepEqual(parsed.coverage.basicDialogueSuite.followupSemantics, {
      codexSdk: 'queue-in-after-tool-turn',
      claudeSdk: 'no-runtime-append-channel',
      terminalRuntime: 'append-input-planned-not-yet-gated',
    });
    assert.deepEqual(parsed.coverage.basicDialogueSuite.phases.map((phase) => phase.providerKey), [
      'codex-sdk',
      'claude-sdk',
      'kimi-tmux',
      'codex-tmux',
    ]);
    assert.deepEqual(parsed.coverage.basicDialogueSuite.phases.map((phase) => phase.outputObservationMode), [
      'direct-im-reply_to',
      'direct-im-reply_to',
      'mirror-stream-evidence',
      'mirror-stream-evidence',
    ]);
    assert.equal(parsed.coverage.basicDialogueSuite.phases[0]?.followupInputSemantics, 'queue-in-after-tool-turn');
    assert.match(parsed.coverage.basicDialogueSuite.phases[0]?.followupCommand || '', /FOLLOWUP$/);
    assert.equal(parsed.coverage.basicDialogueSuite.phases[0]?.mirrorSuppressionObservationWindowMs, 10_000);
    assert.equal(parsed.coverage.basicDialogueSuite.phases[1]?.followupInputSemantics, 'no-runtime-append-channel');
    assert.equal(parsed.coverage.basicDialogueSuite.phases[1]?.followupCommand, undefined);
    assert.equal(parsed.coverage.basicDialogueSuite.phases[1]?.appendInputGate, undefined);
    for (const phase of parsed.coverage.basicDialogueSuite.phases.slice(2)) {
      assert.equal(phase.followupInputSemantics, 'append-input-planned-not-yet-gated');
      assert.equal(phase.followupCommand, undefined);
      assert.equal(phase.appendInputGate, 'planned-not-yet-gated');
    }
    assert.equal(parsed.coverage.basicDialogueSuite.phases[3]?.stopCommand, '/stop');
    assert.equal(parsed.waitsForMirrorFinalBeforeFollowup, true);
    assert.equal(parsed.finalMessageObservationMode, 'cross-provider-suite');
    assert.deepEqual(parsed.commands.slice(0, 4), [
      '/runtime codex',
      '/p sdk',
      [
        '请模拟 basic dialogue codex-sdk 阶段，只回复这个 marker：CODELARK_BASIC_DIALOGUE_UNIT_BASIC_DIALOGUE_CODEX_SDK',
        '同时在本阶段测试脚本里应覆盖 provider preload、代表性工具调用、context/goal 状态和权限/更新提示回传。',
      ].join('\n'),
      '追加输入 codex-sdk CODELARK_BASIC_DIALOGUE_UNIT_BASIC_DIALOGUE_CODEX_SDK FOLLOWUP',
    ]);
    assert.deepEqual(parsed.commands.slice(4, 7), [
      '/runtime claude',
      '/p sdk',
      [
        '请模拟 basic dialogue claude-sdk 阶段，只回复这个 marker：CODELARK_BASIC_DIALOGUE_UNIT_BASIC_DIALOGUE_CLAUDE_SDK',
        '同时在本阶段测试脚本里应覆盖 provider preload、代表性工具调用、context/goal 状态和权限/更新提示回传。',
      ].join('\n'),
    ]);
    assert.deepEqual(parsed.commands.slice(7, 10), [
      '/runtime kimi',
      '/p tmux',
      [
        '请模拟 basic dialogue kimi-tmux 阶段，只回复这个 marker：CODELARK_BASIC_DIALOGUE_UNIT_BASIC_DIALOGUE_KIMI_TMUX',
        '同时在本阶段测试脚本里应覆盖 provider preload、代表性工具调用、context/goal 状态和权限/更新提示回传。',
      ].join('\n'),
    ]);
    assert.deepEqual(parsed.commands.slice(-4), [
      '/runtime codex',
      '/p tmux',
      [
        '请模拟 basic dialogue codex-tmux 阶段，只回复这个 marker：CODELARK_BASIC_DIALOGUE_UNIT_BASIC_DIALOGUE_CODEX_TMUX',
        '同时在本阶段测试脚本里应覆盖 provider preload、代表性工具调用、context/goal 状态和权限/更新提示回传。',
      ].join('\n'),
      '/stop',
    ]);

    const codexSdkPrompt = parsed.commands[2] || '';
    const codexSdkExpectation = expectationAt(parsed.commandReplyExpectations, codexSdkPrompt);
    assert.deepEqual(codexSdkExpectation.expectedTexts, ['CODELARK_BASIC_DIALOGUE_UNIT_BASIC_DIALOGUE_CODEX_SDK']);
    assert.equal(codexSdkExpectation.observationMode, 'reply_to');
    assert.equal(codexSdkExpectation.reason, 'basic dialogue provider phase must produce the expected deterministic model marker without provider contamination');
    const codexSdkFollowup = parsed.commands[3] || '';
    assert.deepEqual(
      expectationAt(parsed.commandReplyExpectations, codexSdkFollowup).expectedTexts,
      ['CODELARK_BASIC_DIALOGUE_UNIT_BASIC_DIALOGUE_CODEX_SDK FOLLOWUP_ACK'],
    );
    const kimiTmuxPrompt = parsed.commands.find((command) => command.includes('basic dialogue kimi-tmux')) || '';
    assert.equal(expectationAt(parsed.commandReplyExpectations, kimiTmuxPrompt).observationMode, 'mirror-stream-evidence');
    const codexTmuxPrompt = parsed.commands.find((command) => command.includes('basic dialogue codex-tmux')) || '';
    assert.equal(expectationAt(parsed.commandReplyExpectations, codexTmuxPrompt).observationMode, 'mirror-stream-evidence');
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/runtime claude').expectedTexts, ['Runtime', 'claude']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/p tmux').expectedTexts, ['Kimi Provider', 'tmux']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/stop').expectedTexts, ['停止']);
  });

  it('dry-runs scripted basic-dialogue-suite as isolated proxy-backed provider mode', () => {
    const output = runHarness([
      '--dry-run',
      '--launch-bridge',
      '--scripted-basic-dialogue',
      '--scenario',
      'basic-dialogue-suite',
      '--run-id',
      'unit-basic-dialogue-scripted',
      '--chat-id',
      'oc_unit',
    ]);
    const parsed = JSON.parse(output) as {
      scriptedBasicDialogue: boolean;
      waitsForMirrorFinalBeforeFollowup: boolean;
      codexModel: string;
      runRoot: string;
      codelarkHome: string;
      canonicalEligibility: {
        eligible: boolean;
        blockers: string[];
        notes: string[];
      };
      plannedSuccessCheckNames: string[];
      runtimeEnvironment: {
        runtimeHome: string;
        codexHome: string;
        kimiExecutableSource: string;
        kimiExecutablePath?: string;
        kimiHome: string;
      };
      coverage: {
        basicDialogueSuite: {
          scriptedBridgeModel: boolean;
          proxyBackedProviders: boolean;
          providerBypassInjected: boolean;
          codexResponsesProxy: boolean;
          ccrProxy: boolean;
          modelProxyChunkDelayMs: number;
          modelProxyBoundary: string;
          appendInputProviderKeys: string[];
          followupSemantics: {
            codexSdk: string;
            claudeSdk: string;
            terminalRuntime: string;
          };
          phases: Array<{
            providerKey: string;
            outputObservationMode: string;
            modelProxyChunks: string[];
            streamCardRequiredTexts?: string[];
            followupCommand?: string;
            followupInputSemantics: string;
            appendInputGate?: string;
          }>;
        };
      };
      commands: string[];
      commandReplyExpectations: Array<{
        command: string;
        observationMode: string;
      }>;
    };
    const usage = runHarness(['--help']);
    const resolvedRunRoot = path.resolve(parsed.runRoot);
    const isolatedHomes = [
      parsed.codelarkHome,
      parsed.runtimeEnvironment.runtimeHome,
      parsed.runtimeEnvironment.codexHome,
      parsed.runtimeEnvironment.kimiHome,
    ].map((item) => path.resolve(item));

    assert.equal(parsed.scriptedBasicDialogue, true);
    assert.equal(parsed.codexModel, 'gpt-5.5');
    assert.deepEqual(parsed.canonicalEligibility.blockers, []);
    assert.equal(parsed.canonicalEligibility.eligible, true);
    assert.deepEqual(parsed.canonicalEligibility.notes, [
      'dry-run only describes the planned canonical eligibility; it is not execution evidence.',
    ]);
    for (const isolatedHome of isolatedHomes) {
      const relative = path.relative(resolvedRunRoot, isolatedHome);
      assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), `${isolatedHome} should live under ${resolvedRunRoot}`);
    }
    assert.notEqual(path.resolve(parsed.codelarkHome), path.join(os.homedir(), '.codelark'));
    assert.notEqual(path.resolve(parsed.runtimeEnvironment.codexHome), path.join(os.homedir(), '.codex'));
    assert.notEqual(path.resolve(parsed.runtimeEnvironment.kimiHome), path.join(os.homedir(), '.kimi-code'));
    assert.doesNotMatch(usage, /--kimi-(?:e2e|home|env|switch)/);
    assert.equal(parsed.runtimeEnvironment.kimiExecutableSource, 'scripted-fake-executable');
    assert.match(parsed.runtimeEnvironment.kimiExecutablePath || '', /\/bin\/kimi$/);
    assert.equal(
      path.relative(resolvedRunRoot, path.resolve(parsed.runtimeEnvironment.kimiExecutablePath || '')).startsWith('..'),
      false,
    );
    assert.match(parsed.runtimeEnvironment.kimiHome, /\/runtime-home\/\.kimi-code$/);
    assert.ok(parsed.plannedSuccessCheckNames.includes('canonical_report_eligible'));
    assert.ok(parsed.plannedSuccessCheckNames.includes('basic_dialogue_stream_card_checkpoints'));
    assert.ok(parsed.plannedSuccessCheckNames.includes('basic_dialogue_terminal_append_input_delivered'));
    assert.ok(parsed.plannedSuccessCheckNames.includes('basic_dialogue_scripted_kimi_lifecycle_and_ctrl_s'));
    assert.ok(parsed.plannedSuccessCheckNames.includes('basic_dialogue_kimi_runtime_slot_persisted'));
    assert.ok(parsed.plannedSuccessCheckNames.includes('basic_dialogue_kimi_wire_transcript_read'));
    assert.ok(parsed.plannedSuccessCheckNames.includes('basic_dialogue_kimi_history_transcript_excludes_thinking'));
    assert.ok(parsed.plannedSuccessCheckNames.includes('basic_dialogue_kimi_thinking_status_only'));
    assert.ok(parsed.plannedSuccessCheckNames.includes('basic_dialogue_kimi_tool_card'));
    assert.ok(parsed.plannedSuccessCheckNames.includes('codex_responses_proxy_used'));
    assert.ok(parsed.plannedSuccessCheckNames.includes('basic_dialogue_ccr_proxy_used'));
    assert.equal(parsed.coverage.basicDialogueSuite.scriptedBridgeModel, false);
    assert.equal(parsed.coverage.basicDialogueSuite.proxyBackedProviders, true);
    assert.equal(parsed.coverage.basicDialogueSuite.providerBypassInjected, false);
    assert.equal(parsed.coverage.basicDialogueSuite.codexResponsesProxy, true);
    assert.equal(parsed.coverage.basicDialogueSuite.ccrProxy, true);
    assert.equal(parsed.coverage.basicDialogueSuite.modelProxyChunkDelayMs, 120);
    assert.equal(parsed.coverage.basicDialogueSuite.modelProxyBoundary, 'codex-responses-and-ccr-chat-completions');
    assert.deepEqual(parsed.coverage.basicDialogueSuite.appendInputProviderKeys, ['kimi-tmux', 'codex-tmux']);
    assert.deepEqual(parsed.coverage.basicDialogueSuite.followupSemantics, {
      codexSdk: 'queue-in-after-tool-turn',
      claudeSdk: 'no-runtime-append-channel',
      terminalRuntime: 'append-input-message-delivered-no-direct-reply',
    });
    assert.deepEqual(
      parsed.coverage.basicDialogueSuite.phases.map((phase) => phase.outputObservationMode),
      [
        'scripted-interactive-stream-card',
        'scripted-interactive-stream-card',
        'scripted-interactive-stream-card',
        'scripted-interactive-stream-card',
      ],
    );
    assert.equal(parsed.coverage.basicDialogueSuite.phases[1]?.followupCommand, undefined);
    assert.deepEqual(parsed.coverage.basicDialogueSuite.phases[0]?.modelProxyChunks, [
      'CODELARK_BASIC_DIALOGUE_UNIT_BASIC_DIALOGUE_SCRIPTED_CODEX_SDK\n',
      'provider preload complete: codex-sdk\n',
      'codex-sdk partial text\n',
      'Goal Active: codex-sdk provider isolation\n',
      'running representative tool: codex-sdk\n',
      'Bash\n',
      'Context: 42%\n',
    ]);
    assert.deepEqual(parsed.coverage.basicDialogueSuite.phases[2]?.modelProxyChunks, [
      'CODELARK_BASIC_DIALOGUE_UNIT_BASIC_DIALOGUE_SCRIPTED_KIMI_TMUX\n',
      'provider preload complete: kimi-tmux\n',
      'kimi-tmux partial text\n',
      'Goal Active: kimi-tmux provider isolation\n',
      'running representative tool: kimi-tmux\n',
      'Bash\n',
      'Context: 42%\n',
    ]);
    assert.deepEqual(parsed.coverage.basicDialogueSuite.phases[2]?.streamCardRequiredTexts, [
      '当前思考',
      'scripted Kimi thinking for CODELARK_BASIC_DIALOGUE_UNIT_BASIC_DIALOGUE_SCRIPTED_KIMI_TMUX',
    ]);
    for (const phase of parsed.coverage.basicDialogueSuite.phases.filter((item) => (
      ['kimi-tmux', 'codex-tmux'].includes(item.providerKey)
    ))) {
      assert.match(phase.followupCommand || '', /FOLLOWUP$/);
      assert.equal(phase.followupInputSemantics, 'append-input-message-delivered-no-direct-reply');
      assert.equal(phase.appendInputGate, 'message-delivered-no-direct-reply');
    }
    assert.equal(parsed.waitsForMirrorFinalBeforeFollowup, false);
    assert.ok(parsed.commands.includes('追加输入 kimi-tmux CODELARK_BASIC_DIALOGUE_UNIT_BASIC_DIALOGUE_SCRIPTED_KIMI_TMUX FOLLOWUP'));
    assert.ok(parsed.commands.includes('追加输入 codex-tmux CODELARK_BASIC_DIALOGUE_UNIT_BASIC_DIALOGUE_SCRIPTED_CODEX_TMUX FOLLOWUP'));
    const codexTmuxPrompt = parsed.commandReplyExpectations.find((expectation) => (
      expectation.command.includes('basic dialogue codex-tmux')
    ));
    assert.equal(codexTmuxPrompt?.observationMode, 'reply_to');
    assert.equal(
      parsed.commandReplyExpectations.some((expectation) => expectation.command.includes('追加输入 codex-tmux')),
      false,
    );
  });

  it('closes scripted Codex Responses WebSocket streams after terminal events', async () => {
    const proxy = await startLocalCodexResponsesProxy('fallback');
    try {
      const wsUrl = proxy.baseUrl.replace(/^http/u, 'ws') + '/responses';
      const received: string[] = [];
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        const timeout = setTimeout(() => {
          ws.close();
          reject(new Error('scripted Codex Responses WebSocket stream did not close'));
        }, 3_000);
        ws.on('open', () => {
          ws.send(JSON.stringify({
            model: 'gpt-5',
            input: 'CODELARK_BASIC_DIALOGUE_UNIT_BASIC_DIALOGUE_CODEX_SDK',
          }));
        });
        ws.on('message', (data) => {
          received.push(data.toString());
        });
        ws.on('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        ws.on('close', () => {
          clearTimeout(timeout);
          resolve();
        });
      });

      const transcript = received.join('\n');
      assert.match(transcript, /CODELARK_BASIC_DIALOGUE_UNIT_BASIC_DIALOGUE_CODEX_SDK/);
      assert.match(transcript, /response\.completed/);
      assert.ok(proxy.requests.some((request) => request.method === 'WS'));
    } finally {
      await proxy.close();
    }
  });

  it('rejects scripted basic-dialogue injection outside the basic dialogue scenario', () => {
    const output = runHarnessFailure([
      '--dry-run',
      '--scripted-basic-dialogue',
      '--scenario',
      'message-only',
    ]);

    assert.match(output, /--scripted-basic-dialogue is only valid with --scenario basic-dialogue-suite/);
  });

  it('rejects scripted basic-dialogue injection for a non-isolated bridge run', () => {
    const output = runHarnessFailure([
      '--scripted-basic-dialogue',
      '--scenario',
      'basic-dialogue-suite',
      '--chat-id',
      'oc_unit',
    ], { CODELARK_REAL_FEISHU_E2E: '1' });

    assert.match(output, /Refusing to run real Feishu E2E without --launch-bridge/);
  });
});
