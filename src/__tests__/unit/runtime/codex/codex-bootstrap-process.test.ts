import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { bootstrapLocalCodexThread } from '../../../../runtime/codex/thread-bootstrap.js';

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

for (const sessionReady of [true, false]) {
  test(`Windows bootstrap closes wrapper descendants when session is ${sessionReady ? 'ready' : 'missing'}`, {
    skip: process.platform !== 'win32',
    timeout: 25_000,
  }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-bootstrap-process-'));
    const oldEnv = { CODEX_HOME: process.env.CODEX_HOME, CODELARK_CODEX_CLI_PATH: process.env.CODELARK_CODEX_CLI_PATH };
    const threadId = randomUUID();
    const pidsFile = path.join(root, 'owned-pids.txt');
    const writer = path.join(root, 'writer.cjs');
    const wrapper = path.join(root, 'wrapper.cjs');
    const executable = path.join(root, 'fake codex.cmd');
    const sessionFile = path.join(root, 'sessions', `rollout-${threadId}.jsonl`);
    const readPids = () => fs.existsSync(pidsFile)
      ? fs.readFileSync(pidsFile, 'utf8').trim().split(/\s+/).map(Number)
      : [];
    try {
      fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
      fs.writeFileSync(writer, `
        const fs = require('node:fs');
        fs.appendFileSync(${JSON.stringify(pidsFile)}, process.pid + '\\n');
        if (${sessionReady}) fs.writeFileSync(${JSON.stringify(sessionFile)}, JSON.stringify({ type: 'session_meta', payload: { id: ${JSON.stringify(threadId)} } }) + '\\n');
        console.log(JSON.stringify({ type: 'thread.started', thread_id: ${JSON.stringify(threadId)} }));
        setInterval(() => {}, 1000);
      `);
      fs.writeFileSync(wrapper, `
        require('node:fs').appendFileSync(${JSON.stringify(pidsFile)}, process.pid + '\\n');
        require('node:child_process').spawn(process.execPath, [${JSON.stringify(writer)}], { stdio: 'inherit' });
      `);
      fs.writeFileSync(executable, `@echo off\r\n"${process.execPath}" "${wrapper}" %*\r\n`);
      process.env.CODEX_HOME = root;
      process.env.CODELARK_CODEX_CLI_PATH = executable;
      const bootstrap = bootstrapLocalCodexThread({ mode: 'yolo', workingDirectory: root });
      if (sessionReady) assert.equal(await bootstrap, threadId);
      else await assert.rejects(bootstrap, /未找到可用 session JSONL/);
      const pids = readPids();
      assert.equal(pids.length, 2, 'both wrapper and writer started');
      assert.deepEqual(pids.filter(isAlive), [], 'bootstrap must terminate the entire owned process tree before returning');
      if (sessionReady) {
        assert.equal(fs.readFileSync(sessionFile, 'utf8').trim().split('\n').length, 1);
      }
    } finally {
      // Only these fixture-owned PIDs may be cleaned up, including on the old implementation.
      for (const pid of readPids()) {
        if (!isAlive(pid)) continue;
        try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 5000 }); } catch { /* already exited */ }
      }
      for (const [key, value] of Object.entries(oldEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
}
