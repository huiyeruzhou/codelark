import '../../setup/test-setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('a direct daemon cold start fails before connecting when local skills cannot be refreshed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-daemon-skills-'));
  const codexHome = path.join(root, 'codex');
  const bridgeHome = path.join(root, 'bridge');
  const lock = path.join(codexHome, 'skills', '.codelark.install.lock');
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }));
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/entrypoints/daemon.ts'], {
      cwd: process.cwd(),
      env: { ...process.env, CODEX_HOME: codexHome, CODELARK_HOME: bridgeHome },
      encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /skills could not be updated; startup is incomplete/u);
    const status = JSON.parse(fs.readFileSync(path.join(bridgeHome, 'runtime', 'status.json'), 'utf8'));
    assert.equal(status.running, false);
    assert.match(status.lastExitReason, /skills could not be updated/u);
    assert.doesNotMatch(result.stdout, /Service discovery|Starting bridge/u);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
