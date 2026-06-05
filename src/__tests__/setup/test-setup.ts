import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let createdTempHome: string | null = null;
const originalHome = process.env.HOME;
if (originalHome && !process.env.CODELARK_TEST_ORIGINAL_HOME) {
  process.env.CODELARK_TEST_ORIGINAL_HOME = originalHome;
}

function ensureDirEnv(name: string, value: string): void {
  fs.mkdirSync(value, { recursive: true });
  process.env[name] = value;
}

function isManagedTestHome(value: string | undefined): boolean {
  if (!value) return false;
  const resolved = path.resolve(value);
  const tmpRoot = path.resolve(os.tmpdir());
  const relative = path.relative(tmpRoot, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return false;
  return relative.split(path.sep)[0]?.startsWith('codelark-test-') === true;
}

if (
  !process.env.CODELARK_HOME
  || (
    process.env.CODELARK_TEST_ALLOW_EXTERNAL_HOME !== '1'
    && !isManagedTestHome(process.env.CODELARK_HOME)
  )
) {
  createdTempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codelark-test-'));
  process.env.CODELARK_HOME = createdTempHome;
} else if (process.env.CODELARK_HOME) {
  fs.mkdirSync(process.env.CODELARK_HOME, { recursive: true });
}

process.env.CODELARK_DISABLE_OUTBOUND_RATE_LIMIT = process.env.CODELARK_DISABLE_OUTBOUND_RATE_LIMIT || '1';

if (
  !process.env.HOME
  || (
    process.env.CODELARK_TEST_ALLOW_EXTERNAL_HOME !== '1'
    && !isManagedTestHome(process.env.HOME)
  )
) {
  ensureDirEnv('HOME', path.join(process.env.CODELARK_HOME!, 'runtime-home'));
}

if (
  !process.env.USERPROFILE
  || (
    process.env.CODELARK_TEST_ALLOW_EXTERNAL_HOME !== '1'
    && !isManagedTestHome(process.env.USERPROFILE)
  )
) {
  ensureDirEnv('USERPROFILE', process.env.HOME!);
}

if (
  !process.env.CODEX_HOME
  || (
    process.env.CODELARK_TEST_ALLOW_EXTERNAL_HOME !== '1'
    && !isManagedTestHome(process.env.CODEX_HOME)
  )
) {
  const codexHome = path.join(process.env.CODELARK_HOME!, 'codex-home');
  ensureDirEnv('CODEX_HOME', codexHome);
  try {
    fs.writeFileSync(path.join(codexHome, 'models_cache.json'), JSON.stringify({
      models: [
        { slug: 'gpt-5.4', display_name: 'gpt-5.4', visibility: 'list', supported_in_api: true },
        { slug: 'gpt-5.3-codex-spark', display_name: 'gpt-5.3-codex-spark', visibility: 'list', supported_in_api: false },
      ],
    }), 'utf-8');
  } catch {}
}


try {
  const modelsCachePath = path.join(process.env.CODEX_HOME!, 'models_cache.json');
  if (!fs.existsSync(modelsCachePath)) {
    fs.writeFileSync(modelsCachePath, JSON.stringify({
      models: [
        { slug: 'gpt-5.4', display_name: 'gpt-5.4', visibility: 'list', supported_in_api: true },
        { slug: 'gpt-5.3-codex-spark', display_name: 'gpt-5.3-codex-spark', visibility: 'list', supported_in_api: false },
      ],
    }), 'utf-8');
  }
} catch {}

if (
  !process.env.CODELARK_CLAUDE_HOME
  || (
    process.env.CODELARK_TEST_ALLOW_EXTERNAL_HOME !== '1'
    && !isManagedTestHome(process.env.CODELARK_CLAUDE_HOME)
  )
) {
  const claudeHome = path.join(process.env.CODELARK_HOME!, 'claude-home');
  ensureDirEnv('CODELARK_CLAUDE_HOME', claudeHome);
}

if (createdTempHome) {
  process.on('exit', () => {
    try {
      fs.rmSync(createdTempHome!, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures in tests
    }
  });
}
