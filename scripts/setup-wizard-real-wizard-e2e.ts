#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { feishuSetupUserAuthScopeArgument } from '../src/channels/feishu/permissions.js';

type FeishuSite = 'feishu' | 'lark';

interface PtyProcess {
  write(data: string): void;
  kill(signal?: string): void;
  onData(callback: (data: string) => void): void;
  onExit(callback: (event: { exitCode: number; signal?: number }) => void): void;
}

interface PtyModule {
  spawn(
    command: string,
    args: string[],
    options: { name: string; cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv },
  ): PtyProcess;
}

const require = createRequire(import.meta.url);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function valueArg(args: string[], name: string, fallback = ''): string {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  return args[index + 1] || fallback;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function printUsage(): void {
  process.stdout.write([
    'Usage:',
    '  CODELARK_SETUP_WIZARD_REAL_E2E=1 npm run real:setup-wizard:wizard-e2e -- [options]',
    '',
    'Options:',
    '  --run-root <path>       Temporary root; default /tmp/clk-setup-wizard-wizard-e2e-<timestamp>',
    '  --timeout-ms <number>   Overall wizard timeout; default 600000',
    '  --keep-temp             Keep temporary root for diagnosis; default cleans it after success',
    '  --help                  Show this help',
    '',
    'The script starts the real setup wizard in a fresh mock HOME, accepts default',
    'answers, prints setup/login URLs for manual scanning, then writes the created',
    `app credentials to ${defaultRealFeishuTestEnvFile()}.`,
    '',
  ].join('\n'));
}

function assertInside(parentPath: string, childPath: string): void {
  const parent = path.resolve(parentPath);
  const child = path.resolve(childPath);
  const relative = path.relative(parent, child);
  if (relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative))) return;
  throw new Error(`Path escaped temp root: ${child}`);
}

function npxCommand(): string {
  return process.platform === 'win32' ? 'npx.cmd' : 'npx';
}

function defaultRealFeishuTestEnvFile(): string {
  const codelarkHome = process.env.CODELARK_HOME || path.join(os.homedir(), '.codelark');
  return path.join(codelarkHome, 'real-feishu-e2e', 'test.env');
}

async function loadPtyModule(): Promise<PtyModule> {
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<unknown>;
  const loaded = await dynamicImport('@homebridge/node-pty-prebuilt-multiarch') as { default?: unknown };
  return (loaded.default || loaded) as PtyModule;
}

function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`${command} ${args.join(' ')} timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
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

async function runWizardWithDefaults(options: {
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}): Promise<string> {
  const pty = await loadPtyModule();
  const child = pty.spawn(npxCommand(), ['tsx', 'src/entrypoints/cli.ts', 'setup'], {
    name: 'xterm-256color',
    cols: 120,
    rows: 40,
    cwd: packageRoot,
    env: options.env,
  });

  let output = '';
  const printedUrls = new Set<string>();
  let defaultConfirmCount = 0;
  const maxDefaultConfirms = 40;
  let exited = false;

  const defaultInput = setInterval(() => {
    if (exited || defaultConfirmCount >= maxDefaultConfirms) return;
    child.write('\r');
    defaultConfirmCount += 1;
  }, 900);

  return await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      clearInterval(defaultInput);
      child.kill('SIGTERM');
      reject(new Error(`setup wizard timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);

    child.onData((data) => {
      output += data;
      process.stdout.write(data);
      for (const match of output.matchAll(/https?:\/\/[^\s<>"'`]+/giu)) {
        const url = match[0].replace(/[),.;\]}，。；）】]+$/u, '');
        if (!url || printedUrls.has(url)) continue;
        printedUrls.add(url);
        process.stdout.write(`\n[setup-wizard-real-wizard-e2e] 授权链接：${url}\n`);
      }
      if (output.length > 80_000) output = output.slice(-40_000);
    });

    child.onExit((event) => {
      exited = true;
      clearInterval(defaultInput);
      clearTimeout(timeout);
      if (event.exitCode === 0) {
        resolve(output);
        return;
      }
      reject(new Error(`setup wizard exited with ${event.signal || event.exitCode}\n${output.slice(-4000)}`));
    });
  });
}

interface CreatedWizardCredentials {
  appId: string;
  appSecret: string;
  site: FeishuSite;
}

function buildLarkCliRuntimeEnv(codelarkHome: string): NodeJS.ProcessEnv {
  return {
    LARK_CHANNEL: '1',
    LARK_CHANNEL_HOME: codelarkHome,
    LARK_CHANNEL_CONFIG: path.join(codelarkHome, 'runtime', 'lark-cli-source', 'config.json'),
    LARKSUITE_CLI_CONFIG_DIR: path.join(codelarkHome, 'runtime', 'lark-cli'),
  };
}

async function assertLarkCliAuthorization(options: {
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}): Promise<void> {
  const larkCliScript = require.resolve('@larksuite/cli/scripts/run.js');
  const status = await runCommand(process.execPath, [larkCliScript, 'auth', 'status'], {
    cwd: packageRoot,
    env: options.env,
    timeoutMs: options.timeoutMs,
  });
  if (status.code !== 0) {
    throw new Error(`lark-cli auth status failed\n${status.stdout}\n${status.stderr}`);
  }

  const check = await runCommand(
    process.execPath,
    [larkCliScript, 'auth', 'check', '--scope', feishuSetupUserAuthScopeArgument()],
    {
      cwd: packageRoot,
      env: options.env,
      timeoutMs: options.timeoutMs,
    },
  );
  if (check.code !== 0) {
    throw new Error(`lark-cli auth check failed\n${check.stdout}\n${check.stderr}`);
  }
}

function assertCodeLarkConfig(options: {
  codelarkHome: string;
  workspaceRoot: string;
}): CreatedWizardCredentials {
  const configJsonPath = path.join(options.codelarkHome, 'config.json');
  const configEnvPath = path.join(options.codelarkHome, 'config.env');
  const larkCliRuntimeConfigPath = path.join(options.codelarkHome, 'runtime', 'lark-cli', 'lark-channel', 'config.json');
  const parsed = JSON.parse(fs.readFileSync(configJsonPath, 'utf-8')) as {
    runtime?: { provider?: string; bridge?: { defaultWorkspaceRoot?: string } };
    channels?: Array<{ provider?: string; enabled?: boolean; config?: { appId?: string; appSecret?: string; site?: string } }>;
  };
  const feishu = parsed.channels?.find((channel) => channel.provider === 'feishu');

  if (parsed.runtime?.provider !== 'codex') throw new Error(`runtime provider mismatch: ${parsed.runtime?.provider}`);
  if (parsed.runtime?.bridge?.defaultWorkspaceRoot !== options.workspaceRoot) {
    throw new Error(`workspace mismatch: ${parsed.runtime?.bridge?.defaultWorkspaceRoot}`);
  }
  if (feishu?.enabled !== true) throw new Error('Feishu channel is not enabled');
  const appId = feishu?.config?.appId?.trim();
  const appSecret = feishu?.config?.appSecret?.trim();
  const site = feishu?.config?.site === 'lark' ? 'lark' : 'feishu';
  if (!appId) throw new Error('CodeLark config appId missing');
  if (!appSecret) throw new Error('CodeLark config appSecret missing');
  if (!fs.existsSync(configEnvPath)) throw new Error('config.env missing');
  if (!fs.existsSync(larkCliRuntimeConfigPath)) throw new Error('CodeLark private lark-cli runtime config missing');
  return { appId, appSecret, site };
}

function writeDefaultRealFeishuTestEnvFile(filePath: string, credentials: CreatedWizardCredentials): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(
    tmpPath,
    [
      '# Generated by setup-wizard-real-wizard-e2e.ts',
      `CODELARK_REAL_FEISHU_TEST_APP_ID=${credentials.appId}`,
      `CODELARK_REAL_FEISHU_TEST_APP_SECRET=${credentials.appSecret}`,
      `CODELARK_REAL_FEISHU_TEST_SITE=${credentials.site}`,
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  fs.renameSync(tmpPath, filePath);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (hasFlag(argv, '--help')) {
    printUsage();
    return;
  }
  if (process.env.CODELARK_SETUP_WIZARD_REAL_E2E !== '1') {
    throw new Error('Refusing to run setup wizard real e2e without CODELARK_SETUP_WIZARD_REAL_E2E=1.');
  }

  const outputTestEnvFile = defaultRealFeishuTestEnvFile();
  const runRoot = path.resolve(valueArg(
    argv,
    '--run-root',
    path.join(os.tmpdir(), `clk-setup-wizard-wizard-e2e-${Date.now()}`),
  ));
  const keepTemp = hasFlag(argv, '--keep-temp');
  const timeoutMs = Number(valueArg(argv, '--timeout-ms', '600000'));

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`Invalid --timeout-ms: ${timeoutMs}`);
  }

  const runtimeHome = path.join(runRoot, 'home');
  const codelarkHome = path.join(runRoot, 'codelark-home');
  const workspaceRoot = path.join(runRoot, 'workspace');
  const codexHome = path.join(runtimeHome, '.codex');

  try {
    assertInside(os.tmpdir(), runRoot);
    fs.mkdirSync(runtimeHome, { recursive: true });
    fs.mkdirSync(codexHome, { recursive: true });
    fs.mkdirSync(workspaceRoot, { recursive: true });

    const env = {
      ...process.env,
      HOME: runtimeHome,
      USERPROFILE: runtimeHome,
      CODEX_HOME: codexHome,
      CODELARK_HOME: codelarkHome,
      FORCE_COLOR: '0',
      NO_COLOR: '1',
      TERM: 'xterm-256color',
    };
    delete env.CI;

    await runWizardWithDefaults({ env, timeoutMs });

    const larkCliEnv = {
      ...env,
      ...buildLarkCliRuntimeEnv(codelarkHome),
    };
    await assertLarkCliAuthorization({ env: larkCliEnv, timeoutMs: 60_000 });
    const credentials = assertCodeLarkConfig({ codelarkHome, workspaceRoot });
    writeDefaultRealFeishuTestEnvFile(outputTestEnvFile, credentials);

    const result = {
      ok: true,
      runRoot,
      runtimeHome,
      codelarkHome,
      workspaceRoot,
      testEnvFile: outputTestEnvFile,
      appId: credentials.appId,
      site: credentials.site,
      larkCliRuntimeDir: path.join(codelarkHome, 'runtime', 'lark-cli'),
      cleanedRunRoot: !keepTemp,
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    if (!keepTemp) {
      fs.rmSync(runRoot, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exit(1);
});
