#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function globalExecutable(name) {
  const prefix = execFileSync('npm', ['prefix', '-g'], { encoding: 'utf-8' }).trim();
  return process.platform === 'win32'
    ? path.join(prefix, `${name}.cmd`)
    : path.join(prefix, 'bin', name);
}

function verify(name) {
  const executable = globalExecutable(name);
  if (!fs.existsSync(executable)) {
    throw new Error(`Global ${name} executable is missing: ${executable}`);
  }
  const result = spawnSync(executable, ['--version'], {
    encoding: 'utf-8',
    shell: process.platform === 'win32',
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`${name} --version failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  const version = (result.stdout || result.stderr || '').trim();
  if (!/\d+\.\d+\.\d+/u.test(version)) {
    throw new Error(`${name} returned no semantic version: ${version || '<empty>'}`);
  }
  process.stdout.write(`${name}: ${version} (${executable})\n`);
  return executable;
}

const codex = verify('codex');
const claude = verify('claude');
const kimi = verify('kimi');

if (process.env.GITHUB_ENV) {
  fs.appendFileSync(process.env.GITHUB_ENV, [
    `CODELARK_REAL_CODEX_E2E_EXECUTABLE=${codex}`,
    `CODELARK_REAL_CLAUDE_E2E_EXECUTABLE=${claude}`,
    `CODELARK_REAL_KIMI_E2E_EXECUTABLE=${kimi}`,
    '',
  ].join(os.EOL));
}
