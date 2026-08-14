#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

import { buildStandardLarkCliEnv } from '../src/shared/lark-cli-env.js';

const require = createRequire(import.meta.url);

type FeishuSite = 'feishu' | 'lark';
type SetupRuntimeChoice = 'codex' | 'ccr' | 'claude' | 'kimi' | 'cursor' | 'zcode';

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
    '  CODELARK_SETUP_WIZARD_REAL_E2E=1 npm run real:setup-wizard:e2e -- [options]',
    '',
    'Options:',
    '  --run-root <path>       Temporary root; default /tmp/clk-setup-wizard-real-e2e-<timestamp>',
    '  --test-env-file <path>  Load test app credentials from an env file; avoids npm argument echo',
    '  --app-id <cli_...>      App ID written to the isolated CodeLark test config',
    '  --app-secret <secret>   App Secret for the isolated smoke app; prefer env file/env vars to avoid npm echo',
    '  --site <feishu|lark>    Site brand; default feishu',
    '  --runtime <name>        Runtime choice to write: codex|ccr|claude|kimi|cursor|zcode; default codex',
    '  --keep-temp             Keep temporary root for diagnosis; default cleans it in success and failure paths',
    '  --simulate-failure-after-sync  Test cleanup on a post-setup failure',
    '  --help                  Show this help',
    '',
  ].join('\n'));
}

function runtimeChoiceArg(value: string): SetupRuntimeChoice {
  if (value === 'codex' || value === 'ccr' || value === 'claude' || value === 'kimi' || value === 'cursor' || value === 'zcode') return value;
  throw new Error(`Invalid --runtime "${value}". Expected codex, ccr, claude, kimi, cursor, or zcode.`);
}

function expectedRuntimeAgent(choice: SetupRuntimeChoice): 'codex' | 'claude' | 'kimi' | 'cursor' | 'zcode' {
  if (choice === 'ccr') return 'claude';
  return choice;
}

function parseEnvFile(filePath: string): Record<string, string> {
  if (!filePath) return {};
  const content = fs.readFileSync(filePath, 'utf-8');
  const values: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
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

function envValue(envFile: Record<string, string>, key: string): string {
  return process.env[key] || envFile[key] || '';
}

function assertInside(parentPath: string, childPath: string): void {
  const parent = path.resolve(parentPath);
  const child = path.resolve(childPath);
  const relative = path.relative(parent, child);
  if (relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative))) return;
  throw new Error(`Path escaped temp root: ${child}`);
}

function runCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    input?: string;
  } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      windowsHide: process.platform === 'win32',
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`${command} ${args.join(' ')} timed out after ${options.timeoutMs}ms\n${stdout}\n${stderr}`));
    }, options.timeoutMs || 15_000);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
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

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (hasFlag(argv, '--help')) {
    printUsage();
    return;
  }
  if (process.env.CODELARK_SETUP_WIZARD_REAL_E2E !== '1') {
    throw new Error('Refusing to run setup wizard real e2e without CODELARK_SETUP_WIZARD_REAL_E2E=1.');
  }
  const testEnvFile = valueArg(argv, '--test-env-file', '');
  const envFile = parseEnvFile(testEnvFile);

  const runRoot = path.resolve(valueArg(
    argv,
    '--run-root',
    path.join(os.tmpdir(), `clk-setup-wizard-real-e2e-${Date.now()}`),
  ));
  const keepTemp = hasFlag(argv, '--keep-temp');
  const appId = valueArg(
    argv,
    '--app-id',
    envValue(envFile, 'CODELARK_REAL_FEISHU_TEST_APP_ID') || 'cli_setup_wizard_real_e2e',
  );
  const appSecret = valueArg(
    argv,
    '--app-secret',
    envValue(envFile, 'CODELARK_REAL_FEISHU_TEST_APP_SECRET') || 'setup-wizard-real-e2e-secret',
  );
  const siteArg = valueArg(
    argv,
    '--site',
    envValue(envFile, 'CODELARK_REAL_FEISHU_TEST_SITE') || 'feishu',
  );
  const site: FeishuSite = siteArg === 'lark' ? 'lark' : 'feishu';
  const runtimeChoice = runtimeChoiceArg(valueArg(argv, '--runtime', 'codex'));
  const expectedAgent = expectedRuntimeAgent(runtimeChoice);

  const runtimeHome = path.join(runRoot, 'home');
  const codelarkHome = path.join(runRoot, 'clk-home');
  const workspaceRoot = path.join(runRoot, 'workspace');
  const larkSourceConfigPath = path.join(codelarkHome, 'runtime', 'lark-cli-source', 'config.json');
  const larkRuntimeConfigPath = path.join(codelarkHome, 'runtime', 'lark-cli', 'lark-channel', 'config.json');
  const globalLarkCliConfigPath = path.join(runtimeHome, '.lark-cli', 'config.json');
  const existingGlobalAppId = 'cli_existing_global_binding';
  const configEnvPath = path.join(codelarkHome, 'config.env');
  const configJsonPath = path.join(codelarkHome, 'config.json');
  const configTomlPath = path.join(codelarkHome, 'config.toml');

  try {
    assertInside(os.tmpdir(), runRoot);
    fs.mkdirSync(runtimeHome, { recursive: true });
    fs.mkdirSync(codelarkHome, { recursive: true });
    fs.mkdirSync(workspaceRoot, { recursive: true });

    const standardLarkCliEnv = buildStandardLarkCliEnv({
      ...process.env,
      HOME: runtimeHome,
      USERPROFILE: runtimeHome,
      XDG_DATA_HOME: path.join(runtimeHome, '.local', 'share'),
    });
    const larkCliScript = require.resolve('@larksuite/cli/scripts/run.js');
    const larkCliInit = await runCommand(
      process.execPath,
      [
        larkCliScript,
        'config',
        'init',
        '--app-id',
        existingGlobalAppId,
        '--app-secret-stdin',
        '--brand',
        'feishu',
      ],
      {
        cwd: workspaceRoot,
        env: standardLarkCliEnv,
        timeoutMs: 15_000,
        input: 'existing-global-secret\n',
      },
    );
    if (larkCliInit.code !== 0 || !fs.existsSync(globalLarkCliConfigPath)) {
      throw new Error(`real lark-cli failed to prepare the existing global binding: ${larkCliInit.stderr || larkCliInit.stdout}`);
    }
    const globalLarkCliConfig = fs.readFileSync(globalLarkCliConfigPath, 'utf-8');

    process.env.HOME = runtimeHome;
    process.env.USERPROFILE = runtimeHome;
    process.env.CODELARK_HOME = codelarkHome;

    const setupWizard = await import('../src/entrypoints/setup-wizard.js');

    const credentials = {
      appId,
      appSecret,
      site,
      alias: 'codelark',
    };

    const current = setupWizard.loadSetupConfig(codelarkHome);
    setupWizard.saveSetupConfigToHomeToml(
      setupWizard.buildSetupConfig(current, credentials, runtimeChoice, workspaceRoot),
      codelarkHome,
    );

    const savedConfig = setupWizard.loadSetupConfig(codelarkHome);
    const localService = await import('../src/local-service/manager.js');
    if (hasFlag(argv, '--simulate-failure-after-sync')) {
      throw new Error('simulated setup wizard real e2e failure after setup');
    }

    const savedFeishu = savedConfig.channels?.find((channel) => channel.provider === 'feishu');
    if (savedConfig.runtime.agent !== expectedAgent) throw new Error(`runtime mismatch: ${savedConfig.runtime.agent}`);
    if (runtimeChoice === 'kimi' && savedConfig.runtime.kimi.provider !== 'tmux') {
      throw new Error(`kimi provider mismatch: ${savedConfig.runtime.kimi.provider}`);
    }
    if (runtimeChoice === 'cursor' && savedConfig.runtime.cursor.provider !== 'tmux') {
      throw new Error(`cursor provider mismatch: ${savedConfig.runtime.cursor.provider}`);
    }
    if (runtimeChoice === 'zcode' && savedConfig.runtime.zcode.provider !== 'tmux') {
      throw new Error(`zcode provider mismatch: ${savedConfig.runtime.zcode.provider}`);
    }
    if (runtimeChoice === 'ccr' && savedConfig.runtime.claude.executable !== 'ccr') {
      throw new Error(`claude executable mismatch: ${savedConfig.runtime.claude.executable}`);
    }
    if (savedConfig.bridge.defaultWorkspace !== workspaceRoot) {
      throw new Error(`workspace mismatch: ${savedConfig.bridge.defaultWorkspace}`);
    }
    if (savedFeishu?.config.appId !== appId) throw new Error('config appId mismatch');
    if (savedFeishu?.config.appSecret !== appSecret) throw new Error('config appSecret mismatch');
    if (savedFeishu?.config.site !== site) throw new Error('config site mismatch');

    if (!fs.existsSync(configTomlPath)) throw new Error('config.toml missing');
    if (fs.existsSync(configEnvPath)) throw new Error('setup should not create config.env');
    if (fs.existsSync(configJsonPath)) throw new Error('setup should not create config.json');
    if (fs.existsSync(larkSourceConfigPath)) throw new Error('CodeLark should not create an isolated lark-cli source config');
    if (fs.existsSync(larkRuntimeConfigPath)) throw new Error('CodeLark should not create an isolated lark-cli runtime config');
    if (fs.readFileSync(globalLarkCliConfigPath, 'utf-8') !== globalLarkCliConfig) {
      throw new Error('CodeLark modified the existing global lark-cli app binding');
    }

    const daemonEnv = localService._testOnly.buildDaemonEnv();
    if (daemonEnv.LARK_CHANNEL || daemonEnv.LARK_CHANNEL_HOME || daemonEnv.LARK_CHANNEL_CONFIG) {
      throw new Error('daemon env should not contain LARK_CHANNEL* variables');
    }
    if (daemonEnv.LARKSUITE_CLI_CONFIG_DIR) {
      throw new Error(`daemon env should not contain LARKSUITE_CLI_CONFIG_DIR: ${daemonEnv.LARKSUITE_CLI_CONFIG_DIR}`);
    }
    const runtimeBinDir = path.join(codelarkHome, 'runtime', 'bin');
    const daemonPathEntries = (daemonEnv.PATH || '').split(path.delimiter).filter(Boolean);
    if (daemonPathEntries.includes(runtimeBinDir)) {
      throw new Error(`daemon env PATH should not contain ${runtimeBinDir}`);
    }
    const daemonPathHead = daemonPathEntries[0];
    const larkCliVersion = await runCommand(process.execPath, [larkCliScript, '--version'], {
      cwd: workspaceRoot,
      env: daemonEnv,
      timeoutMs: 15_000,
    });
    if (larkCliVersion.code !== 0) {
      throw new Error(`bundled lark-cli failed under daemon env: ${larkCliVersion.stderr || larkCliVersion.stdout}`);
    }

    const result = {
      ok: true,
      runRoot,
      runtimeHome,
      codelarkHome,
      larkSourceConfigPath,
      larkRuntimeConfigPath,
      globalLarkCliConfigPath,
      globalLarkCliConfigUnchanged: true,
      realLarkCliConfigInit: true,
      existingGlobalAppId,
      configEnvPath,
      configJsonPath,
      configTomlPath,
      runtimeChoice,
      runtimeAgent: savedConfig.runtime.agent,
      kimiProvider: savedConfig.runtime.kimi.provider,
      zcodeProvider: savedConfig.runtime.zcode.provider,
      claudeExecutable: savedConfig.runtime.claude.executable,
      daemonLarkCliConfigDir: daemonEnv.LARKSUITE_CLI_CONFIG_DIR ?? null,
      daemonLarkChannelHome: daemonEnv.LARK_CHANNEL_HOME ?? null,
      daemonPathHead,
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
