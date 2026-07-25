import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import './check-async-bridge-side-effects.js';

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codelark-test-'));
const runtimeHome = path.join(tempHome, 'runtime-home');
const codexHome = path.join(tempHome, 'codex-home');
const claudeHome = path.join(tempHome, 'claude-home');
const kimiHome = path.join(tempHome, 'kimi-home');
const tmuxTempDir = path.join(tempHome, 'tmux');
fs.mkdirSync(runtimeHome, { recursive: true });
fs.mkdirSync(codexHome, { recursive: true });
fs.mkdirSync(claudeHome, { recursive: true });
fs.mkdirSync(kimiHome, { recursive: true });
fs.mkdirSync(tmuxTempDir, { recursive: true });

const testsDir = path.join(process.cwd(), 'src', '__tests__');

function discoverTestFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return discoverTestFiles(fullPath);
    }
    if (!entry.isFile() || !entry.name.endsWith('.test.ts')) {
      return [];
    }
    return [path.relative(process.cwd(), fullPath)];
  });
}

const layerFilters = new Map([
  ['--unit', path.join('src', '__tests__', 'unit') + path.sep],
  ['--workflow', path.join('src', '__tests__', 'workflow') + path.sep],
  ['--mock-e2e', path.join('src', '__tests__', 'e2e', 'mock-app') + path.sep],
  ['--local-e2e', path.join('src', '__tests__', 'e2e', 'local-process') + path.sep],
  ['--harness', path.join('src', '__tests__', 'harness') + path.sep],
]);
const windowsRuntimeFiles = new Set([
  'src/__tests__/workflow/local-service/global-version-update-worker.test.ts',
  'src/__tests__/workflow/local-service/service-manager.test.ts',
  'src/__tests__/workflow/runtime/claude/claude-pty-provider.test.ts',
  'src/__tests__/workflow/runtime/claude/claude-sdk-provider.test.ts',
  'src/__tests__/workflow/runtime/claude/claude-tmux-provider.test.ts',
  'src/__tests__/workflow/runtime/codex/codex-provider.test.ts',
  'src/__tests__/workflow/runtime/codex/codex-pty-provider.test.ts',
  'src/__tests__/workflow/runtime/codex/codex-tmux-provider.test.ts',
  'src/__tests__/workflow/runtime/kimi/kimi-tmux-provider.test.ts',
]);

const requestedLayers = process.argv.slice(2).filter((arg) => layerFilters.has(arg) || arg === '--windows-runtime');
const shardArgs = process.argv.slice(2).filter((arg) => arg === '--test-shard' || arg.startsWith('--test-shard='));
if (shardArgs.length > 1) {
  console.error(`Expected one test shard, received: ${shardArgs.join(', ')}`);
  process.exit(1);
}
const requestedShard = shardArgs[0];
const shardMatch = requestedShard?.match(/^--test-shard=(\d+)\/(\d+)$/u);
const shardIndex = Number(shardMatch?.[1] || 0);
const shardTotal = Number(shardMatch?.[2] || 0);
if (requestedShard && (!shardMatch || shardIndex < 1 || shardTotal < 1 || shardIndex > shardTotal)) {
  console.error(`Invalid test shard: ${requestedShard}. Expected --test-shard=N/M with 1 <= N <= M.`);
  process.exit(1);
}
const testFiles = discoverTestFiles(testsDir)
  .sort()
  .filter((file) => requestedLayers.length === 0 || requestedLayers.some((arg) => (
    arg === '--windows-runtime'
      ? windowsRuntimeFiles.has(file.split(path.sep).join('/'))
      : file.startsWith(layerFilters.get(arg))
  )));

if (testFiles.length === 0) {
  console.error(`No test files matched ${requestedLayers.join(', ') || 'the current test discovery pattern'}.`);
  process.exit(1);
}

let child;
let cleaned = false;

function cleanup() {
  if (cleaned) return;
  cleaned = true;
  try {
    fs.rmSync(tempHome, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function terminateChild(signal = 'SIGTERM') {
  if (!child?.pid) return;
  try {
    if (process.platform !== 'win32') {
      process.kill(-child.pid, signal);
      return;
    }
  } catch {
    // fall back to killing the direct child below
  }
  try {
    child.kill(signal);
  } catch {
    // ignore
  }
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    terminateChild(signal);
    cleanup();
    process.exit(1);
  });
}

child = spawn(
  process.execPath,
  [
    '--test',
    '--test-concurrency=1',
    '--import',
    'tsx',
    '--test-timeout=15000',
    ...(requestedShard ? [requestedShard] : []),
    ...testFiles,
  ],
  {
    stdio: 'inherit',
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      HOME: runtimeHome,
      USERPROFILE: runtimeHome,
      CODELARK_HOME: tempHome,
      CODEX_HOME: codexHome,
      CODELARK_CLAUDE_HOME: claudeHome,
      KIMI_CODE_HOME: kimiHome,
      TMUX_TMPDIR: tmuxTempDir,
      CODELARK_DISABLE_DAILY_VERSION_CHECK: '1',
    },
  },
);

child.on('exit', (code, signal) => {
  terminateChild('SIGTERM');
  cleanup();

  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});
