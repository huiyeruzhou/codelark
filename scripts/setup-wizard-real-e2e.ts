#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

type FeishuSite = 'feishu' | 'lark';
type SetupRuntimeChoice = 'codex' | 'ccr' | 'claude' | 'kimi' | 'cursor';

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
    '  --app-id <cli_...>      App ID written to isolated lark-cli/CodeLark config',
    '  --app-secret <secret>   App Secret for the isolated smoke app; prefer env file/env vars to avoid npm echo',
    '  --site <feishu|lark>    Site brand; default feishu',
    '  --runtime <name>        Runtime choice to write: codex|ccr|claude|kimi|cursor; default codex',
    '  --keep-temp             Keep temporary root for diagnosis; default cleans it in success and failure paths',
    '  --skip-lark-cli-bind    Test-only: write the private lark-cli runtime projection without invoking macOS Keychain',
    '  --simulate-failure-after-sync  Test cleanup on a post-lark-cli failure',
    '  --help                  Show this help',
    '',
  ].join('\n'));
}

function runtimeChoiceArg(value: string): SetupRuntimeChoice {
  if (value === 'codex' || value === 'ccr' || value === 'claude' || value === 'kimi' || value === 'cursor') return value;
  throw new Error(`Invalid --runtime "${value}". Expected codex, ccr, claude, kimi, or cursor.`);
}

function expectedRuntimeAgent(choice: SetupRuntimeChoice): 'codex' | 'claude' | 'kimi' | 'cursor' {
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

function writeJsonFile(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
}

function runCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
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

function writeTestLarkCliRuntimeProjection(options: {
  sourcePath: string;
  runtimePath: string;
  appId: string;
  appSecret: string;
  site: FeishuSite;
}): void {
  writeJsonFile(options.sourcePath, {
    accounts: {
      app: {
        id: options.appId,
        secret: options.appSecret,
        tenant: options.site,
      },
    },
  });
  writeJsonFile(options.runtimePath, {
    apps: [{
      appId: options.appId,
      appSecret: options.appSecret,
      brand: options.site,
    }],
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
  const skipLarkCliBind = hasFlag(argv, '--skip-lark-cli-bind');
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
  const configEnvPath = path.join(codelarkHome, 'config.env');
  const configJsonPath = path.join(codelarkHome, 'config.json');
  const configTomlPath = path.join(codelarkHome, 'config.toml');

  try {
    assertInside(os.tmpdir(), runRoot);
    fs.mkdirSync(runtimeHome, { recursive: true });
    fs.mkdirSync(codelarkHome, { recursive: true });
    fs.mkdirSync(workspaceRoot, { recursive: true });

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
    if (skipLarkCliBind) {
      writeTestLarkCliRuntimeProjection({
        sourcePath: larkSourceConfigPath,
        runtimePath: larkRuntimeConfigPath,
        appId,
        appSecret,
        site,
      });
    } else {
      const larkRuntime = await localService.ensureLarkCliRuntimeConfig(savedConfig, { allowUserAuthorization: true });
      if (larkRuntime.warning) throw new Error(larkRuntime.warning);
      if (!larkRuntime.ready) throw new Error('CodeLark private lark-cli runtime was not initialized');
    }
    const policyWarning = await localService.applyLarkCliRuntimeIdentityPolicy(true);
    if (policyWarning) throw new Error(policyWarning);
    if (hasFlag(argv, '--simulate-failure-after-sync')) {
      throw new Error('simulated setup wizard real e2e failure after lark-cli sync');
    }

    const savedFeishu = savedConfig.channels?.find((channel) => channel.provider === 'feishu');
    if (savedConfig.runtime.agent !== expectedAgent) throw new Error(`runtime mismatch: ${savedConfig.runtime.agent}`);
    if (runtimeChoice === 'kimi' && savedConfig.runtime.kimi.provider !== 'tmux') {
      throw new Error(`kimi provider mismatch: ${savedConfig.runtime.kimi.provider}`);
    }
    if (runtimeChoice === 'cursor' && savedConfig.runtime.cursor.provider !== 'tmux') {
      throw new Error(`cursor provider mismatch: ${savedConfig.runtime.cursor.provider}`);
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
    if (!fs.existsSync(larkSourceConfigPath)) throw new Error('CodeLark lark-cli source config missing');
    if (!fs.existsSync(larkRuntimeConfigPath)) throw new Error('CodeLark private lark-cli runtime config missing');

    const daemonEnv = localService._testOnly.buildDaemonEnv();
    const expectedLarkConfigDir = path.join(codelarkHome, 'runtime', 'lark-cli');
    const expectedLarkConfig = path.join(codelarkHome, 'runtime', 'lark-cli-source', 'config.json');
    const expectedShimDir = path.join(codelarkHome, 'runtime', 'bin');
    const expectedShimPath = path.join(expectedShimDir, process.platform === 'win32' ? 'lark-cli.cmd' : 'lark-cli');
    if (daemonEnv.LARK_CHANNEL_HOME !== codelarkHome) {
      throw new Error(`daemon env LARK_CHANNEL_HOME mismatch: ${daemonEnv.LARK_CHANNEL_HOME}`);
    }
    if (daemonEnv.LARK_CHANNEL_CONFIG !== expectedLarkConfig) {
      throw new Error(`daemon env LARK_CHANNEL_CONFIG mismatch: ${daemonEnv.LARK_CHANNEL_CONFIG}`);
    }
    if (daemonEnv.LARKSUITE_CLI_CONFIG_DIR !== expectedLarkConfigDir) {
      throw new Error(`daemon env LARKSUITE_CLI_CONFIG_DIR mismatch: ${daemonEnv.LARKSUITE_CLI_CONFIG_DIR}`);
    }
    const daemonPathHead = (daemonEnv.PATH || '').split(path.delimiter).filter(Boolean)[0];
    if (daemonPathHead !== expectedShimDir) {
      throw new Error(`daemon env PATH should start with ${expectedShimDir}, got ${daemonPathHead || '<empty>'}`);
    }
    if (!fs.existsSync(expectedShimPath)) {
      throw new Error(`CodeLark lark-cli shim missing: ${expectedShimPath}`);
    }
    const larkCliVersion = await runCommand('lark-cli', ['--version'], {
      cwd: workspaceRoot,
      env: daemonEnv,
      timeoutMs: 15_000,
    });
    if (larkCliVersion.code !== 0) {
      throw new Error(`CodeLark lark-cli shim failed: ${larkCliVersion.stderr || larkCliVersion.stdout}`);
    }
    const targetRuntime = JSON.parse(fs.readFileSync(larkRuntimeConfigPath, 'utf-8'));
    const targetApp = Array.isArray(targetRuntime.apps)
      ? targetRuntime.apps.find((app: { appId?: unknown; brand?: unknown }) => app.appId === appId && app.brand === site)
      : null;
    if (targetApp?.strictMode === 'bot' || targetApp?.defaultAs === 'bot') {
      throw new Error(`CodeLark private lark-cli runtime is still bot-only: ${JSON.stringify(targetApp)}`);
    }

    const result = {
      ok: true,
      runRoot,
      runtimeHome,
      codelarkHome,
      larkSourceConfigPath,
      larkRuntimeConfigPath,
      configEnvPath,
      configJsonPath,
      configTomlPath,
      runtimeChoice,
      runtimeAgent: savedConfig.runtime.agent,
      kimiProvider: savedConfig.runtime.kimi.provider,
      claudeExecutable: savedConfig.runtime.claude.executable,
      daemonLarkCliConfigDir: daemonEnv.LARKSUITE_CLI_CONFIG_DIR,
      daemonPathHead,
      larkCliShimPath: expectedShimPath,
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
