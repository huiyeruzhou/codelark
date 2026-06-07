import '../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_WORKSPACE_ROOT } from '../../../configuration/paths.js';

function runHarness(args: string[]): string {
  return execFileSync(
    process.execPath,
    ['--import', 'tsx', 'scripts/real-feishu-e2e.ts', ...args],
    {
      cwd: process.cwd(),
      encoding: 'utf-8',
      env: {
        ...process.env,
        NODE_OPTIONS: '',
      },
    },
  );
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
      'const args = process.argv.slice(2);',
      'if (args[0] === "lark-cli" && args.includes("auth") && args.includes("status")) {',
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

describe('unit::real-feishu-e2e-harness::auth-preflight', () => {
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
    ], {
      CODELARK_REAL_FEISHU_E2E: '1',
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
      HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'clk-auth-preflight-home-')),
    });

    assert.match(output, /lark-cli user authorization preflight failed before running real Feishu E2E/);
    assert.match(output, /user_open_id=-/);
    assert.match(output, /lark-cli auth login --scope/);
  });
});

describe('unit::real-feishu-e2e-harness::scenario-coverage-metadata', () => {
  it('exposes session-management as a dual runtime/provider real Feishu scenario', () => {
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
    const scenario = parsed.scenarios.find((item) => item.scenario === 'session-management');

    assert.ok(scenario);
    assert.equal(scenario.testNamePattern, 'real-feishu::session-management::<runtime>-<provider>');
    assert.equal(scenario.providerCoverage, 'runtime-parameterized');
    assert.deepEqual(scenario.providerMatrix, [
      'real-feishu::session-management::codex-sdk',
      'real-feishu::session-management::codex-pty',
      'real-feishu::session-management::codex-tmux',
      'real-feishu::session-management::claude-pty',
      'real-feishu::session-management::claude-sdk',
    ]);
    assert.ok(scenario.unitCoverage.includes('unit::help-command::slash-command-groups'));
    assert.ok(scenario.unitCoverage.includes('unit::command-dispatch::new-session'));
    assert.ok(scenario.unitCoverage.includes('unit::command-dispatch::thread-list-unbind-archive'));
    assert.ok(scenario.unitCoverage.includes('unit::bridge-command-e2e::history-commands'));
    assert.ok(scenario.e2eCoverage.includes('e2e::new-session-binding'));
    assert.ok(scenario.e2eCoverage.includes('e2e::thread-list-card-response'));
    assert.ok(scenario.e2eCoverage.includes('e2e::thread-unbind-temporary-session'));
    assert.ok(scenario.e2eCoverage.includes('e2e::thread-archive-current-runtime-session'));
    assert.ok(scenario.e2eCoverage.includes('e2e::history-command-response'));
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
    assert.deepEqual(scenario.providerMatrix, [
      'real-feishu::history-boundaries::codex-sdk',
      'real-feishu::history-boundaries::codex-pty',
      'real-feishu::history-boundaries::codex-tmux',
      'real-feishu::history-boundaries::claude-pty',
      'real-feishu::history-boundaries::claude-sdk',
    ]);
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
    assert.deepEqual(scenario.providerMatrix, [
      'real-feishu::history-empty-isolation::codex-sdk',
      'real-feishu::history-empty-isolation::codex-pty',
      'real-feishu::history-empty-isolation::codex-tmux',
      'real-feishu::history-empty-isolation::claude-pty',
      'real-feishu::history-empty-isolation::claude-sdk',
    ]);
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
    assert.deepEqual(scenario.providerMatrix, [
      'real-feishu::history-long-truncation::codex-sdk',
      'real-feishu::history-long-truncation::codex-pty',
      'real-feishu::history-long-truncation::codex-tmux',
      'real-feishu::history-long-truncation::claude-pty',
      'real-feishu::history-long-truncation::claude-sdk',
    ]);
    assert.ok(scenario.unitCoverage.includes('unit::bridge-command-e2e::history-long-truncation'));
    assert.ok(scenario.e2eCoverage.includes('e2e::history-long-raw-truncation'));
    assert.ok(scenario.e2eCoverage.includes('e2e::history-forbidden-tail-marker'));
  });

  it('exposes history-suite as a representative-provider real Feishu scenario', () => {
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
    assert.equal(scenario.providerCoverage, 'representative-provider');
    assert.deepEqual(scenario.providerMatrix, ['real-feishu::history-suite::codex-tmux']);
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
        unitCoverage: string[];
        e2eCoverage: string[];
      }>;
    };
    const scenario = parsed.scenarios.find((item) => item.scenario === 'card-forms');

    assert.ok(scenario);
    assert.equal(scenario.testNamePattern, 'real-feishu::card-forms::<runtime>');
    assert.equal(scenario.providerCoverage, 'runtime-neutral');
    assert.deepEqual(scenario.providerMatrix, []);
    assert.ok(scenario.unitCoverage.includes('unit::bridge-command-e2e::new-session-form-card'));
    assert.ok(scenario.e2eCoverage.includes('e2e::feishu-interactive-card-reply_to'));
    assert.ok(scenario.e2eCoverage.includes('e2e::card-submit-callback-prefix'));
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
    assert.deepEqual(scenario.providerMatrix, [
      'real-feishu::agent-question-forms::codex-sdk',
      'real-feishu::agent-question-forms::codex-pty',
      'real-feishu::agent-question-forms::codex-tmux',
      'real-feishu::agent-question-forms::claude-pty',
      'real-feishu::agent-question-forms::claude-sdk',
    ]);
    assert.ok(scenario.unitCoverage.includes('unit::feishu-adapter-card-e2e::sdk-clk-ask-form'));
    assert.ok(scenario.unitCoverage.includes('unit::feishu-adapter-card-e2e::mirror-clk-ask-form'));
    assert.ok(scenario.e2eCoverage.includes('e2e::agent-question-form-fields'));
    assert.ok(scenario.e2eCoverage.includes('e2e::agent-question-callback-prefix'));
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
    assert.deepEqual(scenario.providerMatrix, [
      'real-feishu::markdown-rendering::codex-sdk',
      'real-feishu::markdown-rendering::codex-pty',
      'real-feishu::markdown-rendering::codex-tmux',
      'real-feishu::markdown-rendering::claude-pty',
      'real-feishu::markdown-rendering::claude-sdk',
    ]);
    assert.ok(scenario.unitCoverage.includes('unit::plain-markdown::tables-and-code-blocks'));
    assert.ok(scenario.unitCoverage.includes('unit::feishu-markdown::card-markdown-elements'));
    assert.ok(scenario.e2eCoverage.includes('e2e::feishu-markdown-table'));
    assert.ok(scenario.e2eCoverage.includes('e2e::feishu-markdown-fenced-code'));
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
      'codex-tmux',
      'claude-pty',
      'codex-pty',
    ]);
    assert.deepEqual(scenario.providerMatrix, ['real-feishu::basic-dialogue-suite::cross-provider']);
    assert.ok(scenario.unitCoverage.includes('unit::interactive-turn-runner::basic-dialogue-session-simulator'));
    assert.ok(scenario.e2eCoverage.includes('e2e::same-chat-cross-provider-sequence'));
    assert.ok(scenario.e2eCoverage.includes('e2e::sdk-mirror-suppression-grace'));
  });
});

describe('unit::real-feishu-e2e-harness::session-management-command-plan', () => {
  it('dry-runs created chats with a bot app id inferred from the live clk-home config', () => {
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
        '--create-chat',
        '--clk-home',
        codelarkHome,
        '--scenario',
        'session-management',
        '--runtime',
        'codex',
        '--provider',
        'sdk',
        '--run-id',
        'unit-create-chat-infer-bot',
        '--message',
        'CODELARK_UNIT_CREATE_CHAT_INFER_BOT',
      ]);
      const parsed = JSON.parse(output) as {
        createChat: boolean;
        createChatBotAppId: string | null;
        plannedChatId: string;
      };

      assert.equal(parsed.createChat, true);
      assert.equal(parsed.createChatBotAppId, 'cli_configured_bot');
      assert.equal(parsed.plannedChatId, '<created-chat-id>');
    } finally {
      fs.rmSync(codelarkHome, { recursive: true, force: true });
    }
  });

  it('dry-runs created chats with a bot app id inferred from legacy config.env', () => {
    const codelarkHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-real-feishu-harness-'));
    try {
      fs.writeFileSync(path.join(codelarkHome, 'config.env'), [
        '# legacy live bridge config snapshot',
        'CODELARK_ENABLED_CHANNELS=feishu',
        'CODELARK_FEISHU_APP_ID=cli_env_bot',
      ].join('\n'));
      const output = runHarness([
        '--dry-run',
        '--create-chat',
        '--clk-home',
        codelarkHome,
        '--scenario',
        'session-management',
        '--runtime',
        'codex',
        '--provider',
        'sdk',
        '--run-id',
        'unit-create-chat-infer-env-bot',
        '--message',
        'CODELARK_UNIT_CREATE_CHAT_INFER_ENV_BOT',
      ]);
      const parsed = JSON.parse(output) as {
        createChatBotAppId: string | null;
      };

      assert.equal(parsed.createChatBotAppId, 'cli_env_bot');
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
        '--create-chat',
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
        'unit-create-chat-explicit-bot',
        '--message',
        'CODELARK_UNIT_CREATE_CHAT_EXPLICIT_BOT',
      ]);
      const parsed = JSON.parse(output) as {
        createChatBotAppId: string | null;
      };

      assert.equal(parsed.createChatBotAppId, 'cli_explicit_bot');
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
      commandReplyExpectations: Array<{ command: string; expectedTexts: string[]; replyTimeoutMs: number; reason: string }>;
    };
    const expectationByCommand = new Map(parsed.commandReplyExpectations.map((item) => [item.command, item]));

    assert.equal(parsed.coverage.testName, 'real-feishu::command-state::codex-sdk');
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
      '/auto 3600 e2e seed unit-command-state',
      '/auto ls',
      '/auto rm 1',
    ]);
    assert.equal(parsed.commandReplyExpectations.length, parsed.commands.length);
    assert.deepEqual(expectationByCommand.get('/status')?.expectedTexts, ['全局状态', 'Bridge', '当前聊天']);
    assert.deepEqual(expectationByCommand.get('/require-at off')?.expectedTexts, ['已更新群聊 @bot 设置', 'off']);
    assert.deepEqual(expectationByCommand.get('/runtime codex')?.expectedTexts, ['Runtime', 'codex']);
    assert.deepEqual(expectationByCommand.get('/p sdk')?.expectedTexts, ['Codex Provider', 'sdk']);
    assert.deepEqual(expectationByCommand.get('/current')?.expectedTexts, ['当前会话']);
    assert.deepEqual(expectationByCommand.get('/model')?.expectedTexts, ['当前模型']);
    assert.deepEqual(expectationByCommand.get('/mode')?.expectedTexts, ['当前模式', 'Runtime', 'codex']);
    assert.deepEqual(expectationByCommand.get('/provider')?.expectedTexts, ['当前 Codex Provider']);
    assert.deepEqual(expectationByCommand.get('/sandbox')?.expectedTexts, ['当前 Codex 沙箱']);
    assert.deepEqual(expectationByCommand.get('/network')?.expectedTexts, ['当前 Codex 网络']);
    assert.deepEqual(expectationByCommand.get('/reasoning')?.expectedTexts, ['当前思考级别']);
    assert.deepEqual(expectationByCommand.get('/auto 3600 e2e seed unit-command-state')?.expectedTexts, ['已创建定时自动任务', 'e2e seed unit-command-state']);
    assert.deepEqual(expectationByCommand.get('/auto ls')?.expectedTexts, ['当前聊天自动化任务']);
    assert.deepEqual(expectationByCommand.get('/auto rm 1')?.expectedTexts, ['已删除自动化任务']);
    assert.ok(parsed.commandReplyExpectations.every((item) => item.reason === 'command-state reply must include the expected command-specific status text'));
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
      commandReplyExpectations: Array<{ command: string; expectedTexts: string[] }>;
    };
    const expectationByCommand = new Map(parsed.commandReplyExpectations.map((item) => [item.command, item]));

    assert.equal(parsed.coverage.testName, 'real-feishu::command-state::claude-sdk');
    assert.equal(parsed.coverage.dualProviderCompanion, 'real-feishu::command-state::codex-pty');
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
  });

  it('dry-runs Feishu command coverage for codex-sdk with a claude-pty companion', () => {
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
      commandReplyExpectations: Array<{ command: string; expectedTexts: string[]; reason: string }>;
    };

    assert.equal(parsed.coverage.testName, 'real-feishu::session-management::codex-sdk');
    assert.equal(parsed.waitsForMirrorFinalBeforeFollowup, false);
    assert.equal(parsed.finalMessageObservationMode, 'reply_to');
    assert.equal(parsed.coverage.dualProviderCompanion, 'real-feishu::session-management::claude-pty');
    assert.ok(parsed.coverage.matrixCompanions.includes('real-feishu::session-management::claude-sdk'));
    assert.deepEqual(parsed.commands, [
      '/runtime codex',
      '/p sdk',
      '/help',
      '/set',
      '/set claudeProvider pty',
      `/new mgmt-unit-session-management ${DEFAULT_WORKSPACE_ROOT}`,
      '/runtime codex',
      '/p sdk',
      `/cd ${DEFAULT_WORKSPACE_ROOT}`,
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
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/set').expectedTexts, ['全局配置', '[runtime.codex]', 'runtime.codex.provider']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/set claudeProvider pty').expectedTexts, ['已更新全局配置', 'runtime.claude.provider', 'pty']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, `/new mgmt-unit-session-management ${DEFAULT_WORKSPACE_ROOT}`).expectedTexts, ['已创建群聊会话', 'mgmt-unit-session-management', DEFAULT_WORKSPACE_ROOT]);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/runtime codex', 1).expectedTexts, ['Runtime', 'codex']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/p sdk', 1).expectedTexts, ['Codex Provider', 'sdk']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, `/cd ${DEFAULT_WORKSPACE_ROOT}`).expectedTexts, ['已切换工作目录', DEFAULT_WORKSPACE_ROOT]);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/current').expectedTexts, ['当前会话', 'runtime', 'Codex']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/check').expectedTexts, ['当前会话健康检查']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/t').expectedTexts, ['本地会话']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/t n 50').expectedTexts, ['本地会话']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/t unbind').expectedTexts, ['当前聊天已解绑', '新的临时 BridgeSession']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, 'CODELARK_UNIT_SESSION_MANAGEMENT').expectedTexts, ['CODELARK_UNIT_SESSION_MANAGEMENT']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/his 5').expectedTexts, ['CODELARK_UNIT_SESSION_MANAGEMENT']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/t archive').expectedTexts, ['已归档本地 Codex 会话']);
    assert.equal(expectationAt(parsed.commandReplyExpectations, '/help').reason, 'session-management command reply must include the expected command-specific status text');
    assert.equal(expectationAt(parsed.commandReplyExpectations, 'CODELARK_UNIT_SESSION_MANAGEMENT').reason, 'direct final reply must include the expected model marker');
    assert.equal(expectationAt(parsed.commandReplyExpectations, '/his 5').reason, 'history reply must include the final chat marker');
    assert.equal(expectationAt(parsed.commandReplyExpectations, '/help').replyTimeoutMs, 15_000);
    assert.equal(expectationAt(parsed.commandReplyExpectations, 'CODELARK_UNIT_SESSION_MANAGEMENT').replyTimeoutMs, 120_000);
    assert.equal(expectationAt(parsed.commandReplyExpectations, '/his 5').replyTimeoutMs, 120_000);
  });

  it('dry-runs Claude SDK command coverage without resetting Claude back to pty', () => {
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
      commandReplyExpectations: Array<{ command: string; expectedTexts: string[]; replyTimeoutMs: number; reason: string }>;
    };

    assert.equal(parsed.coverage.testName, 'real-feishu::session-management::claude-sdk');
    assert.equal(parsed.coverage.dualProviderCompanion, 'real-feishu::session-management::codex-pty');
    assert.deepEqual(parsed.commands.slice(0, 5), [
      '/runtime claude',
      '/p sdk',
      '/help',
      '/set',
      '/set claudeProvider sdk',
    ]);
    assert.ok(!parsed.commands.includes('/set claudeProvider pty'));
    const newIndex = parsed.commands.findIndex((command) => command.startsWith('/new '));
    assert.deepEqual(parsed.commands.slice(newIndex + 1, newIndex + 3), [
      '/runtime claude',
      '/p sdk',
    ]);
    assert.equal(parsed.commandReplyExpectations.length, parsed.commands.length);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/runtime claude', 0).expectedTexts, ['Runtime', 'claude']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/p sdk', 0).expectedTexts, ['Claude Provider', 'sdk']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/set claudeProvider sdk').expectedTexts, ['已更新全局配置', 'runtime.claude.provider', 'sdk']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, `/new mgmt-unit-session-management-claude-sdk ${DEFAULT_WORKSPACE_ROOT}`).expectedTexts, ['已创建群聊会话', 'mgmt-unit-session-management-claude-sdk', DEFAULT_WORKSPACE_ROOT]);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/runtime claude', 1).expectedTexts, ['Runtime', 'claude']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/p sdk', 1).expectedTexts, ['Claude Provider', 'sdk']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/current').expectedTexts, ['当前会话', 'runtime', 'Claude Code']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/check').expectedTexts, ['当前会话健康检查']);
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
      'pty',
      '--run-id',
      'unit-session-management-codex-pty',
      '--chat-id',
      'oc_unit',
      '--message',
      'CODELARK_UNIT_SESSION_MANAGEMENT_CODEX_PTY',
    ]);
    const parsed = JSON.parse(output) as {
      coverage: {
        testName: string;
      };
      commands: string[];
      waitsForMirrorFinalBeforeFollowup: boolean;
      finalMessageObservationMode: string;
      commandReplyExpectations: Array<{ command: string; expectedTexts: string[]; replyTimeoutMs: number; reason: string }>;
    };

    assert.equal(parsed.coverage.testName, 'real-feishu::session-management::codex-pty');
    assert.equal(parsed.waitsForMirrorFinalBeforeFollowup, true);
    assert.equal(parsed.finalMessageObservationMode, 'mirror-stream-evidence');
    assert.equal(parsed.commandReplyExpectations.length, parsed.commands.length - 1);
    assert.equal(parsed.commandReplyExpectations.some((item) => item.command === 'CODELARK_UNIT_SESSION_MANAGEMENT_CODEX_PTY'), false);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/p pty', 0).expectedTexts, ['Codex Provider', 'pty']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/p pty', 1).expectedTexts, ['Codex Provider', 'pty']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/t n 50').expectedTexts, ['本地会话']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/t unbind').expectedTexts, ['当前聊天已解绑', '新的临时 BridgeSession']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/his 5').expectedTexts, ['CODELARK_UNIT_SESSION_MANAGEMENT_CODEX_PTY']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/t archive').expectedTexts, ['已归档本地 Codex 会话']);
    assert.equal(expectationAt(parsed.commandReplyExpectations, '/p pty', 0).replyTimeoutMs, 15_000);
    assert.equal(expectationAt(parsed.commandReplyExpectations, '/his 5').replyTimeoutMs, 120_000);
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
        replyTimeoutMs: 15_000,
        reason: 'history-boundaries setup command must reach the expected session/provider state before history assertions',
      },
      {
        command: `/new history-unit-history-boundaries ${DEFAULT_WORKSPACE_ROOT}`,
        expectedTexts: ['已创建群聊会话', 'history-unit-history-boundaries', DEFAULT_WORKSPACE_ROOT],
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
        replyTimeoutMs: 15_000,
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
    assert.deepEqual(scenario.providerMatrix, [
      'real-feishu::history-attachments::codex-sdk',
      'real-feishu::history-attachments::codex-pty',
      'real-feishu::history-attachments::codex-tmux',
      'real-feishu::history-attachments::claude-pty',
      'real-feishu::history-attachments::claude-sdk',
    ]);
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
      'pty',
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

    assert.equal(parsed.coverage.testName, 'real-feishu::history-attachments::codex-pty');
    assert.equal(parsed.coverage.dualProviderCompanion, 'real-feishu::history-attachments::claude-pty');
    assert.ok(parsed.coverage.matrixCompanions.includes('real-feishu::history-attachments::codex-sdk'));
    assert.equal(parsed.validationChatSwitchesAfterNew, true);
    assert.equal(parsed.finalMessageObservationMode, 'mirror-stream-evidence');
    assert.equal(parsed.waitsForMirrorFinalBeforeFollowup, true);
    assert.deepEqual(parsed.commands, [
      '/runtime codex',
      '/p pty',
      `/new histfile-unit-history-attachments ${DEFAULT_WORKSPACE_ROOT}`,
      '/runtime codex',
      '/p pty',
      `/cd ${DEFAULT_WORKSPACE_ROOT}`,
      'Please reply exactly with this marker and no other text: CODELARK_UNIT_HISTORY_ATTACHMENTS',
      '/his json',
      '/his file',
    ]);
    assert.equal(parsed.commandReplyExpectations.length, parsed.commands.length - 1);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/runtime codex', 0).expectedTexts, ['Runtime', 'codex']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/p pty', 0).expectedTexts, ['Codex Provider', 'pty']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/runtime codex', 1).expectedTexts, ['Runtime', 'codex']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/p pty', 1).expectedTexts, ['Codex Provider', 'pty']);
    for (const command of [
      '/runtime codex',
      '/p pty',
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

  it('dry-runs history-empty-isolation with empty-history and forbidden marker assertions', () => {
    const output = runHarness([
      '--dry-run',
      '--scenario',
      'history-empty-isolation',
      '--runtime',
      'codex',
      '--provider',
      'pty',
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

    assert.equal(parsed.coverage.testName, 'real-feishu::history-empty-isolation::codex-pty');
    assert.equal(parsed.validationChatSwitchesAfterNew, true);
    assert.equal(parsed.waitsForMirrorFinalBeforeFollowup, true);
    assert.deepEqual(parsed.commands, [
      '/runtime codex',
      '/p pty',
      `/new histiso-a-unit-history-isolation ${DEFAULT_WORKSPACE_ROOT}`,
      '/runtime codex',
      '/p pty',
      `/cd ${DEFAULT_WORKSPACE_ROOT}`,
      'Please reply exactly with this marker and no other text: CODELARK_UNIT_HISTORY_ISOLATION',
      `/new histiso-b-unit-history-isolation ${DEFAULT_WORKSPACE_ROOT}`,
      '/his',
      '/his raw 1',
      '/his msg 1',
    ]);

    assert.equal(parsed.commandReplyExpectations.filter((item) => item.command === '/runtime codex').length, 2);
    assert.equal(parsed.commandReplyExpectations.filter((item) => item.command === '/p pty').length, 2);
    assert.equal(parsed.commandReplyExpectations.filter((item) => item.command === `/cd ${DEFAULT_WORKSPACE_ROOT}`).length, 1);
    for (const command of ['/runtime codex', '/p pty']) {
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

  it('dry-runs history-long-truncation with head and forbidden tail assertions', () => {
    const output = runHarness([
      '--dry-run',
      '--scenario',
      'history-long-truncation',
      '--runtime',
      'codex',
      '--provider',
      'pty',
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

    assert.equal(parsed.coverage.testName, 'real-feishu::history-long-truncation::codex-pty');
    assert.equal(parsed.validationChatSwitchesAfterNew, true);
    assert.equal(parsed.waitsForMirrorFinalBeforeFollowup, true);
    assert.deepEqual(parsed.commands.slice(0, 6), [
      '/runtime codex',
      '/p pty',
      `/new histlong-unit-history-long ${DEFAULT_WORKSPACE_ROOT}`,
      '/runtime codex',
      '/p pty',
      `/cd ${DEFAULT_WORKSPACE_ROOT}`,
    ]);
    assert.match(parsed.commands[6] || '', /^CODELARK_UNIT_HISTORY_LONG Reply exactly with CODELARK_UNIT_HISTORY_LONG\./);
    assert.match(parsed.commands[6] || '', /CODELARK_LONG_HISTORY_TAIL_UNIT_HISTORY_LONG$/);
    assert.deepEqual(parsed.commands.slice(7), ['/his raw 2', '/his msg 2']);
    assert.equal(parsed.commandReplyExpectations.length, parsed.commands.length - 1);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/runtime codex', 0).expectedTexts, ['Runtime', 'codex']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/p pty', 0).expectedTexts, ['Codex Provider', 'pty']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/runtime codex', 1).expectedTexts, ['Runtime', 'codex']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/p pty', 1).expectedTexts, ['Codex Provider', 'pty']);
    for (const command of [
      '/runtime codex',
      '/p pty',
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
    assert.equal(parsed.coverage.providerCoverage, 'representative-provider');
    assert.deepEqual(parsed.coverage.matrix, ['real-feishu::history-suite::codex-tmux']);
    assert.deepEqual(parsed.coverage.matrixCompanions, []);
    assert.equal(parsed.validationChatSwitchesAfterNew, true);
    assert.equal(parsed.waitsForMirrorFinalBeforeFollowup, true);
    assert.equal(parsed.finalMessageObservationMode, 'mirror-stream-evidence');
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
    assert.deepEqual(parsed.commands, ['/new']);
    assert.equal(parsed.validationChatSwitchesAfterNew, false);
    assert.equal(parsed.waitsForMirrorFinalBeforeFollowup, false);

    const expectation = expectationAt(parsed.commandReplyExpectations, '/new');
    assert.deepEqual(expectation.expectedTexts, ['创建群聊会话']);
    assert.deepEqual(expectation.expectedReplyMessageTypes, ['interactive']);
    assert.deepEqual(expectation.expectedReplyContentKeys, ['clk_form', 'clk_input', 'clk_path', 'submit_btn', 'clk-command']);
    assert.equal(expectation.replyTimeoutMs, 15_000);
    assert.equal(expectation.reason, 'card form command must reply with a Feishu interactive CardKit form and submit callback_data prefix');
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
    assert.equal(parsed.validationChatSwitchesAfterNew, false);
    assert.equal(parsed.waitsForMirrorFinalBeforeFollowup, false);

    const expectation = expectationAt(parsed.commandReplyExpectations, 'CODELARK_UNIT_AGENT_QUESTION_FORM_PROMPT');
    assert.deepEqual(expectation.expectedTexts, []);
    assert.deepEqual(expectation.expectedReplyMessageTypes, ['interactive']);
    assert.deepEqual(expectation.expectedReplyContentKeys, ['clk_form', 'clk_choice', 'clk_input', 'submit_btn', 'clk-agent-question']);
    assert.equal(expectation.replyTimeoutMs, 120_000);
    assert.equal(expectation.reason, 'agent question form must reply with a Feishu interactive CardKit form and clk-agent-question callback prefix');
  });

  it('rejects fake CCR live-bridge runs before creating Feishu state', () => {
    const output = runHarnessFailure([
      '--scenario',
      'history-empty-isolation',
      '--runtime',
      'claude',
      '--provider',
      'pty',
      '--fake-ccr',
      '--chat-id',
      'oc_unit',
      '--clk-home',
      path.join(os.tmpdir(), 'clk-real-feishu-live-home'),
    ], { CODELARK_REAL_FEISHU_E2E: '1' });

    assert.match(output, /Refusing to use fake CCR\/basic-dialogue proxy mode without --launch-bridge/);
    assert.match(output, /already running live bridge/);
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
            terminalAndClaude: string;
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
      'codex-tmux',
      'claude-pty',
      'codex-pty',
    ]);
    assert.deepEqual(parsed.coverage.matrix, ['real-feishu::basic-dialogue-suite::cross-provider']);
    assert.ok(parsed.coverage.coverageNotes.some((note) => note.includes('同一会话')));
    assert.ok(parsed.coverage.coverageNotes.some((note) => note.includes('mandatory-suite')));
    assert.equal(parsed.coverage.basicDialogueSuite.scriptedBridgeModel, false);
    assert.equal(parsed.coverage.basicDialogueSuite.sdkMirrorSuppressionObservationWindowMs, 10_000);
    assert.equal(parsed.coverage.basicDialogueSuite.queuedFollowupDelayMs, 250);
    assert.deepEqual(parsed.coverage.basicDialogueSuite.queuedFollowupProviderKeys, ['codex-sdk']);
    assert.deepEqual(parsed.coverage.basicDialogueSuite.appendInputProviderKeys, ['codex-tmux', 'claude-pty', 'codex-pty']);
    assert.deepEqual(parsed.coverage.basicDialogueSuite.followupSemantics, {
      codexSdk: 'queue-in-after-tool-turn',
      claudeSdk: 'no-runtime-append-channel',
      terminalAndClaude: 'append-input-planned-not-yet-gated',
    });
    assert.deepEqual(parsed.coverage.basicDialogueSuite.phases.map((phase) => phase.providerKey), [
      'codex-sdk',
      'claude-sdk',
      'codex-tmux',
      'claude-pty',
      'codex-pty',
    ]);
    assert.deepEqual(parsed.coverage.basicDialogueSuite.phases.map((phase) => phase.outputObservationMode), [
      'direct-im-reply_to',
      'direct-im-reply_to',
      'mirror-stream-evidence',
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
    assert.equal(parsed.coverage.basicDialogueSuite.phases[4]?.stopCommand, '/stop');
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
    assert.deepEqual(parsed.commands.slice(-4), [
      '/runtime codex',
      '/p pty',
      [
        '请模拟 basic dialogue codex-pty 阶段，只回复这个 marker：CODELARK_BASIC_DIALOGUE_UNIT_BASIC_DIALOGUE_CODEX_PTY',
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
    const codexTmuxPrompt = parsed.commands[9] || '';
    assert.equal(expectationAt(parsed.commandReplyExpectations, codexTmuxPrompt).observationMode, 'mirror-stream-evidence');
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/runtime claude').expectedTexts, ['Runtime', 'claude']);
    assert.deepEqual(expectationAt(parsed.commandReplyExpectations, '/p tmux').expectedTexts, ['Codex Provider', 'tmux']);
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
            terminalAndClaude: string;
          };
          phases: Array<{
            providerKey: string;
            outputObservationMode: string;
            modelProxyChunks: string[];
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

    assert.equal(parsed.scriptedBasicDialogue, true);
    assert.equal(parsed.codexModel, 'gpt-5.5');
    assert.equal(parsed.coverage.basicDialogueSuite.scriptedBridgeModel, false);
    assert.equal(parsed.coverage.basicDialogueSuite.proxyBackedProviders, true);
    assert.equal(parsed.coverage.basicDialogueSuite.providerBypassInjected, false);
    assert.equal(parsed.coverage.basicDialogueSuite.codexResponsesProxy, true);
    assert.equal(parsed.coverage.basicDialogueSuite.ccrProxy, true);
    assert.equal(parsed.coverage.basicDialogueSuite.modelProxyChunkDelayMs, 120);
    assert.equal(parsed.coverage.basicDialogueSuite.modelProxyBoundary, 'codex-responses-and-ccr-chat-completions');
    assert.deepEqual(parsed.coverage.basicDialogueSuite.appendInputProviderKeys, ['codex-tmux', 'claude-pty', 'codex-pty']);
    assert.deepEqual(parsed.coverage.basicDialogueSuite.followupSemantics, {
      codexSdk: 'queue-in-after-tool-turn',
      claudeSdk: 'no-runtime-append-channel',
      terminalAndClaude: 'append-input-message-delivered-no-direct-reply',
    });
    assert.deepEqual(
      parsed.coverage.basicDialogueSuite.phases.map((phase) => phase.outputObservationMode),
      [
        'scripted-interactive-stream-card',
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
    for (const phase of parsed.coverage.basicDialogueSuite.phases.filter((item) => (
      ['codex-tmux', 'claude-pty', 'codex-pty'].includes(item.providerKey)
    ))) {
      assert.match(phase.followupCommand || '', /FOLLOWUP$/);
      assert.equal(phase.followupInputSemantics, 'append-input-message-delivered-no-direct-reply');
      assert.equal(phase.appendInputGate, 'message-delivered-no-direct-reply');
    }
    assert.equal(parsed.waitsForMirrorFinalBeforeFollowup, false);
    assert.ok(parsed.commands.includes('追加输入 codex-tmux CODELARK_BASIC_DIALOGUE_UNIT_BASIC_DIALOGUE_SCRIPTED_CODEX_TMUX FOLLOWUP'));
    assert.ok(parsed.commands.includes('追加输入 claude-pty CODELARK_BASIC_DIALOGUE_UNIT_BASIC_DIALOGUE_SCRIPTED_CLAUDE_PTY FOLLOWUP'));
    assert.ok(parsed.commands.includes('追加输入 codex-pty CODELARK_BASIC_DIALOGUE_UNIT_BASIC_DIALOGUE_SCRIPTED_CODEX_PTY FOLLOWUP'));
    const codexTmuxPrompt = parsed.commandReplyExpectations.find((expectation) => (
      expectation.command.includes('basic dialogue codex-tmux')
    ));
    assert.equal(codexTmuxPrompt?.observationMode, 'reply_to');
    assert.equal(
      parsed.commandReplyExpectations.some((expectation) => expectation.command.includes('追加输入 codex-tmux')),
      false,
    );
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

  it('rejects scripted basic-dialogue injection for a non-isolated live bridge run', () => {
    const output = runHarnessFailure([
      '--scripted-basic-dialogue',
      '--scenario',
      'basic-dialogue-suite',
      '--chat-id',
      'oc_unit',
    ], { CODELARK_REAL_FEISHU_E2E: '1' });

    assert.match(output, /Refusing to use fake CCR\/basic-dialogue proxy mode without --launch-bridge/);
  });
});
