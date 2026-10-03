import '../../setup/test-setup.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test, type TestContext } from 'node:test';
import type { ChildProcess } from 'node:child_process';

// scripts 不属于生产 tsc 的 rootDir；运行时加载实际 fixture 的公开启动入口。
const fixtureUrl = new URL('../../../../scripts/fixtures/codex-app-server-lifecycle.ts', import.meta.url);
const { startFixtureAppServer, fixtureEnvironment } = await import(fixtureUrl.href) as {
  startFixtureAppServer(executable: string, root: string, env: NodeJS.ProcessEnv): Promise<{ child: ChildProcess; close(): Promise<void> }>;
  fixtureEnvironment(root: string, baseUrl: string): NodeJS.ProcessEnv;
};
const require = createRequire(import.meta.url);
const posix = { skip: process.platform === 'win32', timeout: 15_000 };

function exists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}

function prepare(t: TestContext, mode: 'graceful' | 'stubborn' | 'startup-failure') {
  // Darwin 的 Unix socket 路径也保持简短。
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'clk-kill-'));
  const env = fixtureEnvironment(root, 'http://127.0.0.1:1/v1');
  const executable = path.join(root, 'wrapper.cjs');
  const pidsFile = path.join(root, 'pids.json');
  const termFile = path.join(root, 'child-term');
  const childScript = `
    const fs = require('node:fs');
    process.on('SIGTERM', () => {
      fs.writeFileSync(${JSON.stringify(termFile)}, 'received');
      if (${JSON.stringify(mode)} === 'graceful') setTimeout(() => process.exit(0), 300);
    });
    process.send('ready');
    setInterval(() => {}, 1000);
  `;
  fs.writeFileSync(executable, `#!/usr/bin/env node
    const fs = require('node:fs');
    const http = require('node:http');
    const { spawn } = require('node:child_process');
    const { WebSocketServer } = require(${JSON.stringify(require.resolve('ws'))});
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    process.on('SIGTERM', () => process.exit(0));
    child.once('message', () => {
      fs.writeFileSync(${JSON.stringify(pidsFile)}, JSON.stringify({ wrapper: process.pid, child: child.pid }));
      if (${JSON.stringify(mode)} === 'startup-failure') process.exit(23);
      const server = http.createServer();
      const ws = new WebSocketServer({ server });
      ws.on('connection', socket => socket.on('message', data => {
        const message = JSON.parse(data);
        if (message.method === 'initialize') socket.send(JSON.stringify({ id: message.id, result: {} }));
      }));
      server.listen(process.argv.at(-1).slice('unix://'.length));
    });
  `, { mode: 0o700 });
  t.after(() => {
    // 测试失败时也只清理本次启动记录的确切 PID。
    if (fs.existsSync(pidsFile)) {
      const pids = JSON.parse(fs.readFileSync(pidsFile, 'utf8')) as { wrapper: number; child: number };
      for (const pid of Object.values(pids)) {
        try { process.kill(pid, 'SIGKILL'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, env, executable, termFile, pids: () => JSON.parse(fs.readFileSync(pidsFile, 'utf8')) as { wrapper: number; child: number } };
}

test('fixture close 等待 wrapper 先退出后的同组子进程，并向整个独占组发送 TERM', posix, async (t) => {
  const fixture = prepare(t, 'graceful');
  const backend = await startFixtureAppServer(fixture.executable, fixture.root, fixture.env);
  const pids = fixture.pids();
  assert.equal(pids.wrapper, backend.child.pid);
  assert(exists(-pids.wrapper), '启动入口必须建立独占进程组');
  const first = backend.close();
  assert.equal(backend.close(), first, '并发关闭共享一次有界清理');
  await first;
  assert.equal(fs.readFileSync(fixture.termFile, 'utf8'), 'received');
  assert.equal(exists(pids.child), false, '不能在 wrapper 退出后留下尚未退出的子进程');
  assert.equal(exists(-pids.wrapper), false);
  await backend.close();
});

test('fixture close 在 wrapper 提前退出后仍对忽略 TERM 的子进程升级 KILL', posix, async (t) => {
  const fixture = prepare(t, 'stubborn');
  const backend = await startFixtureAppServer(fixture.executable, fixture.root, fixture.env);
  const pids = fixture.pids();
  await backend.close();
  assert.equal(fs.readFileSync(fixture.termFile, 'utf8'), 'received');
  assert.equal(exists(pids.child), false);
  assert.equal(exists(-pids.wrapper), false);
});

test('fixture 启动失败也回收已经退出的 wrapper 留下的同组子进程', posix, async (t) => {
  const fixture = prepare(t, 'startup-failure');
  await assert.rejects(startFixtureAppServer(fixture.executable, fixture.root, fixture.env), /app-server 提前退出/);
  const pids = fixture.pids();
  assert.equal(exists(pids.child), false);
  assert.equal(exists(-pids.wrapper), false);
});

test('fixture executable 不存在时立即报告 spawn 错误，不向未知进程组发送信号', posix, async (t) => {
  const fixture = prepare(t, 'graceful');
  await assert.rejects(startFixtureAppServer(path.join(fixture.root, 'missing'), fixture.root, fixture.env), /ENOENT/);
});
