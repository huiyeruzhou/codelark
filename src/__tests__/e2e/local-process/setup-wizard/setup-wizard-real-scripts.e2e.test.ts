import '../../../setup/test-setup.js';

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runScript(options: {
  script: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', options.script, ...(options.args || [])], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...options.env,
        FORCE_COLOR: '0',
        NO_COLOR: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`${options.script} timed out after ${options.timeoutMs}ms\n${stdout}\n${stderr}`));
    }, options.timeoutMs || 60_000);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function runSetupWizardEval(options: {
  code: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--eval', options.code], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...options.env,
        FORCE_COLOR: '0',
        NO_COLOR: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`setup wizard eval timed out after ${options.timeoutMs}ms\n${stdout}\n${stderr}`));
    }, options.timeoutMs || 15_000);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

test('setup wizard tmux prerequisite check observes the isolated PATH', async () => {
  const runRoot = tempDir('clk-setup-wizard-tmux-check-local-e2e-');
  try {
    const fakeBin = path.join(runRoot, 'fake-bin');
    const emptyBin = path.join(runRoot, 'empty-bin');
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.mkdirSync(emptyBin, { recursive: true });
    const fakeTmuxPath = path.join(fakeBin, process.platform === 'win32' ? 'tmux.cmd' : 'tmux');
    fs.writeFileSync(
      fakeTmuxPath,
      process.platform === 'win32'
        ? '@echo off\r\necho tmux 3.4\r\nexit /b 0\r\n'
        : '#!/bin/sh\necho "tmux 3.4"\n',
    );
    fs.chmodSync(fakeTmuxPath, 0o755);

    const code = [
      "import { isTmuxCommandAvailable } from './src/entrypoints/setup-wizard.ts';",
      'const ok = await isTmuxCommandAvailable();',
      'console.log(JSON.stringify({ ok }));',
    ].join('\n');

    const available = await runSetupWizardEval({
      code,
      env: { PATH: fakeBin },
    });
    assert.equal(available.code, 0, available.stderr);
    assert.deepEqual(JSON.parse(available.stdout), { ok: true });

    const missing = await runSetupWizardEval({
      code,
      env: { PATH: emptyBin },
    });
    assert.equal(missing.code, 0, missing.stderr);
    assert.deepEqual(JSON.parse(missing.stdout), { ok: false });
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
});

test('setup wizard real script runs in an isolated local e2e home and cleans its run root', async () => {
  const runRoot = tempDir('clk-setup-wizard-real-local-e2e-');
  fs.rmSync(runRoot, { recursive: true, force: true });

  const result = await runScript({
    script: 'scripts/setup-wizard-real-e2e.ts',
    args: ['--run-root', runRoot, '--skip-lark-cli-bind'],
    env: {
      CODELARK_SETUP_WIZARD_REAL_E2E: '1',
      CODELARK_REAL_FEISHU_TEST_APP_ID: 'cli_setup_wizard_local_e2e',
      CODELARK_REAL_FEISHU_TEST_APP_SECRET: 'setup-wizard-local-e2e-secret',
      CODELARK_REAL_FEISHU_TEST_SITE: 'feishu',
    },
  });

  assert.equal(result.code, 0, result.stderr);
  const parsed = JSON.parse(result.stdout) as {
    ok?: boolean;
    cleanedRunRoot?: boolean;
    codelarkHome?: string;
    configTomlPath?: string;
    daemonLarkCliConfigDir?: string;
    daemonPathHead?: string;
    larkCliShimPath?: string;
  };
  assert.equal(parsed.ok, true);
  assert.equal(parsed.cleanedRunRoot, true);
  assert.equal(fs.existsSync(runRoot), false);
  assert.match(parsed.configTomlPath || '', /config\.toml$/);
  assert.equal(parsed.daemonLarkCliConfigDir, path.join(parsed.codelarkHome || '', 'runtime', 'lark-cli'));
  assert.equal(parsed.daemonPathHead, path.join(parsed.codelarkHome || '', 'runtime', 'bin'));
  assert.match(parsed.larkCliShimPath || '', /lark-cli(?:\.cmd)?$/);
});

test('setup wizard real script cleans its run root after a post-sync failure', async () => {
  const runRoot = tempDir('clk-setup-wizard-real-failure-local-e2e-');
  fs.rmSync(runRoot, { recursive: true, force: true });

  const result = await runScript({
    script: 'scripts/setup-wizard-real-e2e.ts',
    args: ['--run-root', runRoot, '--skip-lark-cli-bind', '--simulate-failure-after-sync'],
    env: {
      CODELARK_SETUP_WIZARD_REAL_E2E: '1',
      CODELARK_REAL_FEISHU_TEST_APP_ID: 'cli_setup_wizard_failure_local_e2e',
      CODELARK_REAL_FEISHU_TEST_APP_SECRET: 'setup-wizard-failure-local-e2e-secret',
      CODELARK_REAL_FEISHU_TEST_SITE: 'feishu',
    },
  });

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /simulated setup wizard real e2e failure after lark-cli sync/);
  assert.equal(fs.existsSync(runRoot), false);
});

test('interactive setup wizard e2e is registered under local e2e and remains explicitly gated', async (t) => {
  if (process.env.CODELARK_SETUP_WIZARD_INTERACTIVE_LOCAL_E2E !== '1') {
    t.skip('set CODELARK_SETUP_WIZARD_INTERACTIVE_LOCAL_E2E=1 to run the interactive QR-code setup wizard flow');
    return;
  }

  const runRoot = tempDir('clk-setup-wizard-interactive-local-e2e-');
  fs.rmSync(runRoot, { recursive: true, force: true });
  try {
    const result = await runScript({
      script: 'scripts/setup-wizard-real-wizard-e2e.ts',
      args: ['--run-root', runRoot],
      env: {
        CODELARK_SETUP_WIZARD_REAL_E2E: '1',
      },
      timeoutMs: 600_000,
    });

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /"ok": true/);
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
});
