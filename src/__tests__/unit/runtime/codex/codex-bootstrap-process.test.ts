import '../../../setup/test-setup.js';
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

for (const mode of ['ready', 'missing', 'config-error']) {
  const sessionReady = mode === 'ready';
  test(`bootstrap stops its processes when ${mode}`, {
    timeout: 25_000,
  }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-bootstrap-process-'));
    const oldEnv = { CODEX_HOME: process.env.CODEX_HOME, CODELARK_CODEX_CLI_PATH: process.env.CODELARK_CODEX_CLI_PATH };
    const threadId = randomUUID();
    const pidsFile = path.join(root, 'owned-pids.txt');
    const writer = path.join(root, 'writer.cjs');
    const wrapper = path.join(root, 'wrapper.cjs');
    const executable = process.platform === 'win32' ? path.join(root, 'fake codex.cmd') : writer;
    const sessionFile = path.join(root, 'sessions', `rollout-${threadId}.jsonl`);
    const readPids = () => fs.existsSync(pidsFile)
      ? fs.readFileSync(pidsFile, 'utf8').trim().split(/\s+/).map(Number)
      : [];
    try {
      fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
      fs.writeFileSync(writer, `#!/usr/bin/env node
        const fs = require('node:fs');
        fs.appendFileSync(${JSON.stringify(pidsFile)}, process.pid + '\\n');
        if (process.argv.includes('app-server')) {
          require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
            const message = JSON.parse(line);
            if (${mode === 'config-error'} && message.method === 'config/read') {
              console.log(JSON.stringify({ id: message.id, error: { code: -32603, message: 'fixture config failure' } }));
              return;
            }
            if (message.id) console.log(JSON.stringify({ id: message.id, result: message.method === 'config/read' ? { config: { model_provider: 'custom' } } : {} }));
          });
        } else {
        if (!process.argv.includes('model_provider="custom"')) throw new Error('bootstrap lost the effective provider');
        if (!process.argv.some(arg => arg.startsWith('model_providers={') && arg.includes('base_url="http://127.0.0.1:9/v1"'))) throw new Error('bootstrap did not redirect the custom provider');
        if (${sessionReady}) fs.writeFileSync(${JSON.stringify(sessionFile)}, JSON.stringify({ type: 'session_meta', payload: { id: ${JSON.stringify(threadId)} } }) + '\\n');
        console.log(JSON.stringify({ type: 'thread.started', thread_id: ${JSON.stringify(threadId)} }));
        }
        if (process.platform !== 'win32') process.on('SIGTERM', () => {});
        setInterval(() => {}, 1000);
      `);
      fs.writeFileSync(wrapper, `
        require('node:fs').appendFileSync(${JSON.stringify(pidsFile)}, process.pid + '\\n');
        require('node:child_process').spawn(process.execPath, [${JSON.stringify(writer)}, ...process.argv.slice(2)], { stdio: 'inherit' });
      `);
      if (process.platform === 'win32') {
        fs.writeFileSync(executable, `@echo off\r\n"${process.execPath}" "${wrapper}" %*\r\n`);
      } else {
        fs.chmodSync(writer, 0o755);
      }
      process.env.CODEX_HOME = root;
      process.env.CODELARK_CODEX_CLI_PATH = executable;
      const bootstrap = bootstrapLocalCodexThread({ mode: 'yolo', workingDirectory: root });
      if (sessionReady) assert.equal(await bootstrap, threadId);
      else if (mode === 'config-error') await assert.rejects(bootstrap, /fixture config failure/);
      else await assert.rejects(bootstrap, /未找到可用 session JSONL/);
      const pids = readPids();
      assert.equal(pids.length, (process.platform === 'win32' ? 2 : 1) * (mode === 'config-error' ? 1 : 2),
        'failed config lookup must not start exec; all started processes remain owned');
      assert.deepEqual(pids.filter(isAlive), [], 'bootstrap must terminate the entire owned process tree before returning');
      if (sessionReady) {
        assert.equal(fs.readFileSync(sessionFile, 'utf8').trim().split('\n').length, 1);
      }
    } finally {
      // Only these fixture-owned PIDs may be cleaned up, including on the old implementation.
      for (const pid of readPids()) {
        if (!isAlive(pid)) continue;
        try {
          if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 5000 });
          else process.kill(pid, 'SIGKILL');
        } catch { /* already exited */ }
      }
      for (const [key, value] of Object.entries(oldEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
}
