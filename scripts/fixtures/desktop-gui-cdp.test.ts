import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DesktopGui } from './desktop-gui-cdp.js';

test('GUI 退出 RPC 失败也释放观察连接和本次 open 等待句柄', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-gui-cleanup-'));
  const closed: string[] = [];
  const gui = new DesktopGui({ app: '/unused/Codex.app', root, evidence: root, env: {}, name: 'cleanup' });
  // 只测试失败路径资源释放，未启动 App，也不作为 GUI 验收。
  Object.assign(gui, {
    page: { close: () => closed.push('page') },
    browser: { call: async () => { throw new Error('Browser.close unavailable'); }, close: () => closed.push('browser') },
    opener: { exitCode: null, signalCode: null, unref: () => closed.push('open') },
  });
  try {
    await assert.rejects(gui.close(), /Browser.close unavailable/);
    assert.deepEqual(closed, ['page', 'browser', 'open']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('CDP 建连前失败不终止未知 App，但释放自己的 open 等待句柄', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-gui-cleanup-'));
  const gui = new DesktopGui({ app: '/unused/Codex.app', root, evidence: root, env: {}, name: 'no-cdp' });
  let released = false;
  Object.assign(gui, { opener: { exitCode: null, signalCode: null, unref: () => { released = true; } } });
  try {
    await assert.rejects(gui.close(), /无法确认 Desktop PID/);
    assert.equal(released, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
