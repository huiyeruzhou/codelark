import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DesktopGui } from './desktop-gui-cdp.js';
import { onboardingAction, type OnboardingScreen } from './desktop-gui-onboarding.js';

// 根据 37139666898 的实际角色页和同版公开控件构造决策输入；这是驱动逻辑单测，不是 GUI 验收。
const roleScreen: OnboardingScreen = {
  progress: '0', role: true, engineering: false, personalized: true, dialog: null, buttons: [], composer: false,
};

test('隔离 profile 角色页必须完成选择和取消个性化，才能继续及确认跳过', () => {
  assert.equal(onboardingAction(roleScreen), 'Engineering');
  const selected = { ...roleScreen, engineering: true, buttons: ['Continue'] };
  assert.equal(onboardingAction(selected), 'Suggest personalized tasks');
  assert.equal(onboardingAction({ ...selected, personalized: null }), false);
  assert.equal(onboardingAction({ ...selected, personalized: false, buttons: [] }), false);
  assert.equal(onboardingAction({ ...selected, personalized: false }), 'Continue');
  const task = { ...selected, role: false, progress: '1', personalized: null, buttons: ['Skip'], composer: true };
  assert.equal(onboardingAction(task), 'Skip', '向导内的任务输入框不能被当成已进入主界面');
  assert.equal(onboardingAction({ ...task, dialog: 'Skip setup? You’ll go straight to ChatGPT', buttons: ['Keep setting up', 'Go to ChatGPT'] }), 'Go to ChatGPT');
  assert.equal(onboardingAction({ ...task, dialog: 'Finish set up and get 5 credits', buttons: ['Finish set up', 'Skip'] }), 'Skip');
  assert.equal(onboardingAction({ ...task, progress: null, buttons: [] }), 'done');
});

test('未知对话框阻止向导点击，过渡空页不能当成成功', () => {
  assert.equal(onboardingAction({ ...roleScreen, dialog: 'Sign in', buttons: ['Skip'] }), false);
  assert.equal(onboardingAction({ ...roleScreen, role: false, progress: null }), false);
  assert.equal(onboardingAction({ ...roleScreen, role: false, buttons: ['Allow access', 'Not now'] }), 'Not now');
  assert.equal(onboardingAction({ ...roleScreen, role: false, buttons: ['Allow access', 'Continue'] }), false);
});

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

test('CDP 被原生启动对话框阻塞时仍保留真实 App transport 错误', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-gui-diagnostics-'));
  const gui = new DesktopGui({ app: '/unused/Codex.app', root, evidence: root, env: {}, name: 'startup' });
  try {
    const message = 'connect ECONNREFUSED 127.0.0.1:1080';
    fs.writeFileSync(path.join(root, 'startup', 'app-stderr.log'), [
      `[AppServerConnection] app_server_connection.websocket_error message=${JSON.stringify(message)}`,
      `[AppServerConnection] app_server_connection.connection_failed_before_ready errorMessage=${JSON.stringify(message)} errorStack="irrelevant"`,
      '[other-service] message="不应当成为 app-server 错误"',
    ].join('\n'));
    assert.deepEqual(gui.startupDiagnostics().transportErrors, [message]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
