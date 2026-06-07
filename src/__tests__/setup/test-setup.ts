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

const configEnvKeys = [
  'CODELARK_AGENT',
  'CODELARK_RUNTIME',
  'CODELARK_DEFAULT_WORKSPACE_ROOT',
  'CODELARK_UI_ALLOW_LAN',
  'CODELARK_UI_ACCESS_TOKEN',
  'CODELARK_CODEX_MODEL',
  'CODELARK_CODEX_DEFAULT_MODEL',
  'CODELARK_CODEX_YOLO_MODE',
  'CODELARK_CODEX_DEFAULT_MODE',
  'CODELARK_CODEX_PROVIDER',
  'CODELARK_DEFAULT_CODEX_PROVIDER',
  'CODELARK_CODEX_SKIP_GIT_REPO_CHECK',
  'CODELARK_CODEX_SANDBOX_MODE',
  'CODELARK_CODEX_NETWORK_ACCESS',
  'CODELARK_CODEX_REASONING_EFFORT',
  'CODELARK_CLAUDE_MODEL',
  'CODELARK_CLAUDE_DEFAULT_MODEL',
  'CODELARK_CLAUDE_YOLO_MODE',
  'CODELARK_CLAUDE_PERMISSION_MODE',
  'CODELARK_CLAUDE_PROVIDER',
  'CODELARK_CLAUDE_EXECUTABLE',
  'CODELARK_CLAUDE_REASONING_EFFORT',
  'CODELARK_CLAUDE_IDLE_TIMEOUT_MINUTES',
  'CODELARK_ENABLED_CHANNELS',
  'CODELARK_HISTORY_MESSAGE_LIMIT',
  'CODELARK_STREAM_STATUS_IDLE_START_SECONDS',
  'CODELARK_STREAM_STATUS_CHECK_INTERVAL_SECONDS',
  'CODELARK_FEISHU_APP_ID',
  'CODELARK_FEISHU_APP_SECRET',
  'CODELARK_FEISHU_SITE',
  'CODELARK_FEISHU_DOMAIN',
  'CODELARK_FEISHU_ALLOWED_USERS',
  'CODELARK_FEISHU_STREAMING_ENABLED',
  'CODELARK_FEISHU_COMMAND_MARKDOWN_ENABLED',
  'CODELARK_FEISHU_REQUIRE_MENTION',
];

for (const key of configEnvKeys) {
  delete process.env[key];
}

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
