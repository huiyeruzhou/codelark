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
fs.mkdirSync(runtimeHome, { recursive: true });
fs.mkdirSync(codexHome, { recursive: true });
fs.mkdirSync(claudeHome, { recursive: true });
fs.mkdirSync(kimiHome, { recursive: true });

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

const requestedLayers = process.argv.slice(2).filter((arg) => layerFilters.has(arg));
const testFiles = discoverTestFiles(testsDir)
  .sort()
  .filter((file) => requestedLayers.length === 0 || requestedLayers.some((arg) => file.startsWith(layerFilters.get(arg))));

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
