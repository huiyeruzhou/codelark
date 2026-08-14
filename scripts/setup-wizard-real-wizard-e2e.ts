#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'smol-toml';
import { feishuSetupUserAuthScopeArgument } from '../src/channels/feishu/permissions.js';
import { buildStandardLarkCliEnv } from '../src/shared/lark-cli-env.js';
import { SetupWizardDefaultDriver } from '../src/testing/setup-wizard-default-driver.js';

type FeishuSite = 'feishu' | 'lark';
type RuntimeAgent = 'codex' | 'claude' | 'kimi' | 'cursor' | 'zcode';
type HomeMarker = 'codex' | 'ccr' | 'claude' | 'kimi' | 'cursor' | 'zcode' | 'none';

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

function parseHomeMarker(value: string): HomeMarker {
  if (value === 'codex' || value === 'ccr' || value === 'claude' || value === 'kimi' || value === 'cursor' || value === 'zcode' || value === 'none') return value;
  throw new Error(`Invalid --home-marker "${value}". Expected codex, ccr, claude, kimi, cursor, zcode, or none.`);
}

function expectedAgentForHomeMarker(marker: HomeMarker): RuntimeAgent {
  if (marker === 'codex') return 'codex';
  if (marker === 'kimi') return 'kimi';
  if (marker === 'cursor') return 'cursor';
  if (marker === 'zcode') return 'zcode';
  return 'claude';
}

function expectedClaudeExecutableForHomeMarker(marker: HomeMarker): 'ccr' | 'claude' | undefined {
  if (marker === 'ccr') return 'ccr';
  if (marker === 'claude' || marker === 'none') return 'claude';
  return undefined;
}

function printUsage(): void {
  process.stdout.write([
    'Usage:',
    '  CODELARK_SETUP_WIZARD_REAL_E2E=1 npm run real:setup-wizard:wizard-e2e -- [options]',
    '',
    'Options:',
    '  --run-root <path>       Temporary root; default /tmp/clk-setup-wizard-wizard-e2e-<timestamp>',
    '  --lark-cli-test-env-file <path>  Existing test App credentials used only to prepare the isolated global ~/.lark-cli binding',
    '  --home-marker <name>    Runtime marker for default answers: codex|ccr|claude|kimi|cursor|zcode|none; default codex',
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

function parseEnvFile(filePath: string): Record<string, string> {
  const values: Record<string, string> = {};
  const content = fs.readFileSync(filePath, 'utf-8');
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
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
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; input?: string },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
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
    if (options.input !== undefined) child.stdin?.end(options.input);
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

async function prepareStandardLarkCliBinding(options: {
  env: NodeJS.ProcessEnv;
  appId: string;
  appSecret: string;
  site: FeishuSite;
  timeoutMs: number;
}): Promise<void> {
  const larkCliScript = require.resolve('@larksuite/cli/scripts/run.js');
  const result = await runCommand(
    process.execPath,
    [
      larkCliScript,
      'config',
      'init',
      '--app-id',
      options.appId,
      '--app-secret-stdin',
      '--brand',
      options.site,
    ],
    {
      cwd: packageRoot,
      env: options.env,
      timeoutMs: options.timeoutMs,
      input: `${options.appSecret}\n`,
    },
  );
  if (result.code !== 0) {
    throw new Error(`test harness failed to prepare standard ~/.lark-cli binding\n${result.stdout}\n${result.stderr}`);
  }
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
  const defaultDriver = new SetupWizardDefaultDriver();
  let exited = false;

  return await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
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
      if (!exited && defaultDriver.shouldSubmit(output)) child.write('\r');
    });

    child.onExit((event) => {
      exited = true;
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
  runtimeAgent: RuntimeAgent;
  kimiProvider?: string;
  cursorProvider?: string;
  zcodeProvider?: string;
  claudeExecutable?: string;
}

function createRuntimeHomeMarker(runtimeHome: string, marker: HomeMarker): void {
  const markerDir = marker === 'codex'
    ? '.codex'
    : marker === 'ccr'
      ? '.claude-code-router'
      : marker === 'claude'
        ? '.claude-code'
        : marker === 'kimi'
          ? '.kimi-code'
          : marker === 'cursor'
            ? '.cursor'
            : marker === 'zcode'
              ? '.zcode'
          : '';
  if (!markerDir) return;
  fs.mkdirSync(path.join(runtimeHome, markerDir), { recursive: true });
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
  expectedAgent: RuntimeAgent;
  expectedClaudeExecutable?: 'ccr' | 'claude';
}): CreatedWizardCredentials {
  const configTomlPath = path.join(options.codelarkHome, 'config.toml');
  const configJsonPath = path.join(options.codelarkHome, 'config.json');
  const configEnvPath = path.join(options.codelarkHome, 'config.env');
  const larkCliRuntimeConfigPath = path.join(options.codelarkHome, 'runtime', 'lark-cli', 'lark-channel', 'config.json');
  const parsed = parse(fs.readFileSync(configTomlPath, 'utf-8')) as {
    runtime?: {
      agent?: string;
      claude?: { executable?: string; provider?: string };
      kimi?: { provider?: string };
      cursor?: { provider?: string };
      zcode?: { provider?: string };
    };
    bridge?: { default_workspace?: string };
    channels?: Array<{ provider?: string; enabled?: boolean; config?: { app_id?: string; app_secret?: string; site?: string } }>;
  };
  const feishu = parsed.channels?.find((channel) => channel.provider === 'feishu');

  if (parsed.runtime?.agent !== options.expectedAgent) {
    throw new Error(`runtime agent mismatch: ${parsed.runtime?.agent}`);
  }
  if (options.expectedAgent === 'kimi' && parsed.runtime?.kimi?.provider !== 'tmux') {
    throw new Error(`kimi provider mismatch: ${parsed.runtime?.kimi?.provider}`);
  }
  if (options.expectedAgent === 'cursor' && parsed.runtime?.cursor?.provider !== 'tmux') {
    throw new Error(`cursor provider mismatch: ${parsed.runtime?.cursor?.provider}`);
  }
  if (options.expectedAgent === 'zcode' && parsed.runtime?.zcode?.provider !== 'tmux') {
    throw new Error(`zcode provider mismatch: ${parsed.runtime?.zcode?.provider}`);
  }
  if (options.expectedClaudeExecutable && parsed.runtime?.claude?.executable !== options.expectedClaudeExecutable) {
    throw new Error(`claude executable mismatch: ${parsed.runtime?.claude?.executable}`);
  }
  if (parsed.bridge?.default_workspace !== options.workspaceRoot) {
    throw new Error(`workspace mismatch: ${parsed.bridge?.default_workspace}`);
  }
  if (feishu?.enabled !== true) throw new Error('Feishu channel is not enabled');
  const appId = feishu?.config?.app_id?.trim();
  const appSecret = feishu?.config?.app_secret?.trim();
  const site = feishu?.config?.site === 'lark' ? 'lark' : 'feishu';
  if (!appId) throw new Error('CodeLark config appId missing');
  if (!appSecret) throw new Error('CodeLark config appSecret missing');
  if (fs.existsSync(configEnvPath)) throw new Error('setup should not create config.env');
  if (fs.existsSync(configJsonPath)) throw new Error('setup should not create config.json');
  // CodeLark 不再维护私有 lark-cli runtime：setup 不应写出隔离目录。
  if (fs.existsSync(larkCliRuntimeConfigPath)) throw new Error('CodeLark should not create an isolated lark-cli runtime config');
  return {
    appId,
    appSecret,
    site,
    runtimeAgent: parsed.runtime!.agent as RuntimeAgent,
    kimiProvider: parsed.runtime?.kimi?.provider,
    cursorProvider: parsed.runtime?.cursor?.provider,
    zcodeProvider: parsed.runtime?.zcode?.provider,
    claudeExecutable: parsed.runtime?.claude?.executable,
  };
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
  const homeMarker = parseHomeMarker(valueArg(argv, '--home-marker', 'codex'));
  const expectedAgent = expectedAgentForHomeMarker(homeMarker);
  const expectedClaudeExecutable = expectedClaudeExecutableForHomeMarker(homeMarker);

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`Invalid --timeout-ms: ${timeoutMs}`);
  }

  const runtimeHome = path.join(runRoot, 'home');
  const codelarkHome = path.join(runRoot, 'codelark-home');
  const workspaceRoot = path.join(runRoot, 'workspace');
  const codexHome = path.join(runtimeHome, '.codex');
  const larkCliTestEnvFile = path.resolve(valueArg(
    argv,
    '--lark-cli-test-env-file',
    defaultRealFeishuTestEnvFile(),
  ));
  if (!fs.existsSync(larkCliTestEnvFile)) {
    throw new Error(`Missing lark-cli test App env file: ${larkCliTestEnvFile}`);
  }
  const larkCliTestEnv = parseEnvFile(larkCliTestEnvFile);
  const larkCliAppId = larkCliTestEnv.CODELARK_REAL_FEISHU_TEST_APP_ID?.trim();
  const larkCliAppSecret = larkCliTestEnv.CODELARK_REAL_FEISHU_TEST_APP_SECRET?.trim();
  const larkCliSite: FeishuSite = larkCliTestEnv.CODELARK_REAL_FEISHU_TEST_SITE === 'lark' ? 'lark' : 'feishu';
  if (!larkCliAppId || !larkCliAppSecret) {
    throw new Error(`Missing test App ID/secret in ${larkCliTestEnvFile}`);
  }

  try {
    assertInside(os.tmpdir(), runRoot);
    fs.mkdirSync(runtimeHome, { recursive: true });
    createRuntimeHomeMarker(runtimeHome, homeMarker);
    fs.mkdirSync(workspaceRoot, { recursive: true });

    const env = buildStandardLarkCliEnv({
      ...process.env,
      HOME: runtimeHome,
      USERPROFILE: runtimeHome,
      CODEX_HOME: codexHome,
      CODELARK_HOME: codelarkHome,
      FORCE_COLOR: '0',
      NO_COLOR: '1',
      TERM: 'xterm-256color',
    });
    delete env.CI;

    // The product must never own `config init`. The E2E harness prepares the
    // real user's pre-existing global binding inside the isolated HOME before
    // launching CodeLark, then the wizard may only check/login/check it.
    await prepareStandardLarkCliBinding({
      env,
      appId: larkCliAppId,
      appSecret: larkCliAppSecret,
      site: larkCliSite,
      timeoutMs: 60_000,
    });

    await runWizardWithDefaults({ env, timeoutMs });

    // wizard 的用户授权写入 mock HOME 下的全局 ~/.lark-cli，不做任何 env 覆盖。
    await assertLarkCliAuthorization({ env, timeoutMs: 60_000 });
    const credentials = assertCodeLarkConfig({
      codelarkHome,
      workspaceRoot,
      expectedAgent,
      expectedClaudeExecutable,
    });
    writeDefaultRealFeishuTestEnvFile(outputTestEnvFile, credentials);

    const result = {
      ok: true,
      runRoot,
      runtimeHome,
      codelarkHome,
      workspaceRoot,
      homeMarker,
      runtimeAgent: credentials.runtimeAgent,
      kimiProvider: credentials.kimiProvider,
      cursorProvider: credentials.cursorProvider,
      zcodeProvider: credentials.zcodeProvider,
      claudeExecutable: credentials.claudeExecutable,
      testEnvFile: outputTestEnvFile,
      appId: credentials.appId,
      site: credentials.site,
      larkCliBindingAppId: larkCliAppId,
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
