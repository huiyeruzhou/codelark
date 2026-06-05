#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type FeishuSite = 'feishu' | 'lark';

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
    '  --keep-temp             Keep temporary root for diagnosis; default cleans it in success and failure paths',
    '  --simulate-failure-after-sync  Test cleanup on a post-lark-cli failure',
    '  --help                  Show this help',
    '',
  ].join('\n'));
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

function envValue(envFile: Record<string, string>, key: string, legacyKey?: string): string {
  return process.env[key] || envFile[key] || (legacyKey ? process.env[legacyKey] || envFile[legacyKey] || '' : '');
}

function assertInside(parentPath: string, childPath: string): void {
  const parent = path.resolve(parentPath);
  const child = path.resolve(childPath);
  const relative = path.relative(parent, child);
  if (relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative))) return;
  throw new Error(`Path escaped temp root: ${child}`);
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
    envValue(envFile, 'CODELARK_REAL_FEISHU_TEST_APP_ID', 'CTI_REAL_FEISHU_TEST_APP_ID') || 'cli_setup_wizard_real_e2e',
  );
  const appSecret = valueArg(
    argv,
    '--app-secret',
    envValue(envFile, 'CODELARK_REAL_FEISHU_TEST_APP_SECRET', 'CTI_REAL_FEISHU_TEST_APP_SECRET') || 'setup-wizard-real-e2e-secret',
  );
  const siteArg = valueArg(
    argv,
    '--site',
    envValue(envFile, 'CODELARK_REAL_FEISHU_TEST_SITE', 'CTI_REAL_FEISHU_TEST_SITE') || 'feishu',
  );
  const site: FeishuSite = siteArg === 'lark' ? 'lark' : 'feishu';

  const runtimeHome = path.join(runRoot, 'home');
  const codelarkHome = path.join(runRoot, 'clk-home');
  const workspaceRoot = path.join(runRoot, 'workspace');
  const larkConfigPath = path.join(runtimeHome, '.lark-cli', 'config.json');
  const configEnvPath = path.join(codelarkHome, 'config.env');
  const configJsonPath = path.join(codelarkHome, 'config.json');

  try {
    assertInside(os.tmpdir(), runRoot);
    fs.mkdirSync(runtimeHome, { recursive: true });
    fs.mkdirSync(codelarkHome, { recursive: true });
    fs.mkdirSync(workspaceRoot, { recursive: true });
    fs.writeFileSync(configEnvPath, '# custom env survives setup\nCUSTOM_KEEP=1\n', { mode: 0o600 });

    process.env.HOME = runtimeHome;
    process.env.USERPROFILE = runtimeHome;
    process.env.CODELARK_HOME = codelarkHome;

    const configuration = await import('../src/configuration/index.js');
    const setupWizard = await import('../src/entrypoints/setup-wizard.js');

    const credentials = {
      appId,
      appSecret,
      site,
      alias: 'codelark',
    };

    await setupWizard.syncLarkCliCredentials(credentials, runtimeHome);
    const entriesAfterSync = setupWizard.readLarkCliAppEntries(larkConfigPath);
    const syncedEntry = entriesAfterSync.find((entry) => entry.appId === appId);
    if (!syncedEntry) throw new Error(`lark-cli config missing synced app ${appId}`);
    if (syncedEntry.brand !== site) throw new Error(`lark-cli brand mismatch: ${syncedEntry.brand}`);
    if (syncedEntry.appSecret) {
      throw new Error('real lark-cli e2e expected lark-cli to avoid plaintext appSecret in this environment');
    }
    if (syncedEntry.secretStorage !== 'keychain') {
      throw new Error(`expected keychain/local encrypted lark-cli secret storage, got ${syncedEntry.secretStorage}`);
    }
    const importableApps = setupWizard.readLarkCliApps(larkConfigPath);
    const importableApp = importableApps.find((entry) => entry.appId === appId);
    if (!importableApp) throw new Error(`CodeLark could not import synced lark-cli app ${appId}`);
    if (importableApp.appSecret !== appSecret) {
      throw new Error('CodeLark did not recover App Secret from lark-cli local encrypted storage');
    }
    if (hasFlag(argv, '--simulate-failure-after-sync')) {
      throw new Error('simulated setup wizard real e2e failure after lark-cli sync');
    }

    const current = configuration.loadConfig();
    configuration.saveConfig(setupWizard.buildSetupConfig(current, credentials, 'codex', workspaceRoot));

    const savedConfig = configuration.loadConfig();
    const savedFeishu = savedConfig.channels?.find((channel) => channel.provider === 'feishu');
    if (savedConfig.runtime !== 'codex') throw new Error(`runtime mismatch: ${savedConfig.runtime}`);
    if (savedConfig.defaultWorkspaceRoot !== workspaceRoot) {
      throw new Error(`workspace mismatch: ${savedConfig.defaultWorkspaceRoot}`);
    }
    if (savedFeishu?.config.appId !== appId) throw new Error('config.v1 appId mismatch');
    if (savedFeishu?.config.appSecret !== appSecret) throw new Error('config.v1 appSecret mismatch');
    if (savedFeishu?.config.site !== site) throw new Error('config.v1 site mismatch');

    const envContent = fs.readFileSync(configEnvPath, 'utf-8');
    if (!envContent.includes('CUSTOM_KEEP=1')) throw new Error('custom config.env line was not preserved');
    if (!envContent.includes(`CODELARK_FEISHU_APP_ID=${appId}`)) throw new Error('config.env appId missing');
    if (!envContent.includes(`CODELARK_FEISHU_APP_SECRET=${appSecret}`)) throw new Error('config.env appSecret missing');
    if (!fs.existsSync(configJsonPath)) throw new Error('config.json missing');

    const result = {
      ok: true,
      runRoot,
      runtimeHome,
      codelarkHome,
      larkConfigPath,
      configEnvPath,
      configJsonPath,
      larkSecretStorage: syncedEntry.secretStorage,
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
