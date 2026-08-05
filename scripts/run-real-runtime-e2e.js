#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRuntimeShardIsolation } from './real-runtime-e2e-isolation.js';

const codexExecutable = process.env.CODELARK_REAL_CODEX_E2E_EXECUTABLE;
const claudeExecutable = process.env.CODELARK_REAL_CLAUDE_E2E_EXECUTABLE;
const kimiExecutable = process.env.CODELARK_REAL_KIMI_E2E_EXECUTABLE;
if (!codexExecutable || !claudeExecutable || !kimiExecutable) {
  throw new Error('Real runtime executable paths were not exported by verify-ci-runtime-clis.js.');
}

const shardTimeoutOverrideMs = Number.parseInt(process.env.CODELARK_RUNTIME_E2E_SHARD_TIMEOUT_MS || '', 10);
const slowShardTargetMs = 60_000;
const logDir = process.env.CODELARK_RUNTIME_E2E_LOG_DIR
  || path.join(os.tmpdir(), 'codelark-real-runtime-e2e');
fs.mkdirSync(logDir, { recursive: true });

const shards = [
  {
    name: 'codex',
    timeoutMs: 120_000,
    files: ['src/__tests__/e2e/local-process/codex/real-codex-tmux-provider.e2e.test.ts'],
    env: { CODELARK_CODEX_CLI_PATH: codexExecutable },
  },
  {
    name: 'claude',
    timeoutMs: 90_000,
    files: ['src/__tests__/e2e/local-process/claude/real-claude-tmux-provider.e2e.test.ts'],
    env: { CODELARK_REAL_CLAUDE_E2E_EXECUTABLE: claudeExecutable },
  },
  {
    name: 'kimi-provider',
    timeoutMs: 120_000,
    files: ['src/__tests__/e2e/local-process/kimi/real-kimi-code-tmux-provider.e2e.test.ts'],
    env: { CODELARK_REAL_KIMI_E2E_EXECUTABLE: kimiExecutable },
  },
  {
    name: 'kimi-bridge',
    timeoutMs: 120_000,
    files: ['src/__tests__/e2e/local-process/kimi/real-kimi-code-bridge.e2e.test.ts'],
    env: { CODELARK_REAL_KIMI_E2E_EXECUTABLE: kimiExecutable },
  },
];

function tailText(filePath, maxLines = 80, maxChars = 12_000) {
  const text = fs.readFileSync(filePath, 'utf-8');
  return text.split(/\r?\n/u).slice(-maxLines).join('\n').slice(-maxChars);
}

function stopProcessTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
}

function runShard(shard) {
  const timeoutMs = Number.isFinite(shardTimeoutOverrideMs) && shardTimeoutOverrideMs > 0
    ? shardTimeoutOverrideMs
    : shard.timeoutMs;
  const logPath = path.join(logDir, `${shard.name}.log`);
  const output = fs.createWriteStream(logPath, { flags: 'w' });
  const isolation = createRuntimeShardIsolation(shard.name, shard.env);
  const startedAt = Date.now();
  const child = spawn(process.execPath, [
    '--import',
    'tsx',
    '--test',
    '--test-concurrency=1',
    ...shard.files,
  ], {
    cwd: process.cwd(),
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: isolation.env,
  });
  child.stdout.pipe(output, { end: false });
  child.stderr.pipe(output, { end: false });

  return new Promise((resolve) => {
    let timedOut = false;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      output.end(() => {
        isolation.cleanup();
        resolve(result);
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stopProcessTree(child);
    }, timeoutMs);
    child.once('error', (error) => {
      finish({
        ...shard,
        durationMs: Date.now() - startedAt,
        error,
        logPath,
        timedOut,
        timeoutMs,
      });
    });
    child.once('close', (code, signal) => {
      finish({
        ...shard,
        durationMs: Date.now() - startedAt,
        code,
        signal,
        logPath,
        timedOut,
        timeoutMs,
      });
    });
  });
}

const parallelShards = shards.filter((shard) => !shard.name.startsWith('kimi-'));
const kimiShards = shards.filter((shard) => shard.name.startsWith('kimi-'));
const [parallelResults, kimiResults] = await Promise.all([
  Promise.all(parallelShards.map(runShard)),
  (async () => {
    const results = [];
    for (const shard of kimiShards) results.push(await runShard(shard));
    return results;
  })(),
]);
const results = [...parallelResults, ...kimiResults];
let failed = false;
for (const result of results) {
  const seconds = (result.durationMs / 1000).toFixed(1);
  if (!result.timedOut && !result.error && result.code === 0) {
    const status = result.durationMs > slowShardTargetMs ? 'PASS-SLOW' : 'PASS';
    console.log(`${status} ${result.name} ${seconds}s ${result.logPath}`);
    continue;
  }
  failed = true;
  const reason = result.timedOut
    ? `timeout after ${result.timeoutMs}ms`
    : result.error?.message || `exit=${result.code} signal=${result.signal || 'none'}`;
  console.error(`FAIL ${result.name} ${seconds}s ${reason} ${result.logPath}`);
  console.error(tailText(result.logPath));
}

process.exitCode = failed ? 1 : 0;
