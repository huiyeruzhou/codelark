#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const selfPath = fileURLToPath(import.meta.url);

function runFakeCodex() {
  const args = process.argv.slice(2);
  const logPath = process.env.CODELARK_FAKE_CODEX_LOG;
  if (logPath) fs.appendFileSync(logPath, `${args.join(' ')}\n`);
  if (args[0] !== 'exec' || !args.includes('--json')) return;

  const randomHex = (size) => crypto.randomBytes(size).toString('hex');
  const threadId = process.env.TMUX_FAKE_BOOTSTRAP_THREAD_ID
    || `019e${randomHex(2)}-${randomHex(2)}-7${randomHex(2).slice(0, 3)}-9${randomHex(2).slice(0, 3)}-${randomHex(6)}`;
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const cdIndex = args.indexOf('--cd');
  const cwd = cdIndex >= 0 ? args[cdIndex + 1] : process.cwd();
  const now = new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const sessionDir = path.join(codexHome, 'sessions', yyyy, mm, dd);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, `rollout-ci-${threadId}.jsonl`),
    `${JSON.stringify({
      type: 'session_meta',
      payload: {
        id: threadId,
        cwd,
        originator: 'codelark-ci',
        source: 'exec',
      },
    })}\n`,
    'utf-8',
  );
  process.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: threadId })}\n`);
}

function installShims() {
  const runnerTemp = process.env.RUNNER_TEMP;
  const githubPath = process.env.GITHUB_PATH;
  if (!runnerTemp || !githubPath) {
    throw new Error('RUNNER_TEMP and GITHUB_PATH are required in CI');
  }
  const binDir = path.join(runnerTemp, 'codelark-ci-bin');
  fs.mkdirSync(binDir, { recursive: true });
  const unixShim = path.join(binDir, 'codex');
  fs.copyFileSync(selfPath, unixShim);
  fs.chmodSync(unixShim, 0o755);
  fs.writeFileSync(
    path.join(binDir, 'codex.cmd'),
    '@echo off\r\nnode "%~dp0codex" %*\r\n',
    'utf-8',
  );
  fs.appendFileSync(githubPath, `${binDir}${os.EOL}`);
  process.stdout.write(`Installed CI tool shims in ${binDir}\n`);
}

if (path.basename(selfPath).toLowerCase() === 'codex') {
  runFakeCodex();
} else {
  installShims();
}
