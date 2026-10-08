/** Real Chromium rendering against the production UI and authenticated Bridge status route. */
import '../src/__tests__/setup/test-setup.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { CODELARK_HOME } from '../src/configuration/paths.js';
import { renderUiShellHtml } from '../src/operator-ui/shell.js';
import { handleUiServiceRoute } from '../src/operator-ui/routes/service.js';
import { startBridgeControlService } from '../src/bridge/control/service-discovery.js';
import { projectCodexBackendStatus } from '../src/bridge/session/display/codex-backend-status.js';

const evidenceIndex = process.argv.indexOf('--evidence');
const evidence = path.resolve(evidenceIndex >= 0 ? process.argv[evidenceIndex + 1] : '/tmp/codelark-ui-status');
fs.mkdirSync(evidence, { recursive: true });
for (const name of ['failure.json', 'failure.png', 'result.json']) fs.rmSync(path.join(evidence, name), { force: true });
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const endpoint = 'unix:///tmp/codelark-ui-fixture/rpc.sock';
const session = {
  id: 'shared', active_runtime: 'codex' as const,
  runtime: { codex: { threadId: 'thread-shared', appServerEndpoint: endpoint }, general: { tmuxSessionName: 'codex_thread-shared-view' } },
};
const legacy = { id: 'legacy', runtime: { codex: { threadId: 'thread-legacy' }, general: { tmuxSessionName: 'codex_thread-legacy' } } };
let current: any = { codexDefault: 'app-server-auto', appServers: [{ id: 'default', owner: 'unknown', state: 'not-started', connection: 'unknown', sessionIds: [] }], sessions: {} };
let reads = 0;
let oldBridge = false;
let unavailable = false;
let sideEffects = 0;
const handlers = {
  listSessions: () => { sideEffects++; return []; },
  receiveInput: () => { sideEffects++; },
  runtimeStatus: () => { reads++; return current; },
};
let control = await startBridgeControlService({ codelarkHome: CODELARK_HOME, runId: 'ui-status-fixture', handlers });
const runtimeDirectory = path.join(CODELARK_HOME, 'runtime');
fs.mkdirSync(runtimeDirectory, { recursive: true });
fs.writeFileSync(path.join(runtimeDirectory, 'status.json'), JSON.stringify({ running: true, pid: process.pid }));
const row = (value: typeof session | typeof legacy, title: string) => ({
  kind: 'bridge', sessionId: value.id, bridgeSessionId: value.id, runtime: 'codex',
  threadId: value.runtime.codex.threadId, codexThreadId: value.runtime.codex.threadId,
  title, displayTitle: title, cwd: '/fixture/project', creatorKind: 'bridge', creatorLabel: 'Bridge',
  executionProvider: 'tmux', mode: 'normal', codexBackend: projectCodexBackendStatus(value),
});
const rows = [row(session, '共享协议会话'), row(legacy, '旧版会话')];
const bindings = rows.map((item) => ({
  id: 'binding-' + item.sessionId, currentRuntime: 'codex', currentSessionId: item.sessionId,
  bridgeSessionId: item.sessionId, currentThreadId: item.threadId, channelType: 'fixture',
  chatId: item.sessionId, chatDisplayName: item.title, currentSessionName: item.title,
  runtimeStatus: 'running', codexBackend: item.codexBackend, executionProvider: 'tmux',
}));
const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', 'http://localhost');
    if (url.pathname === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(renderUiShellHtml()); return;
    }
    if (request.method !== 'GET') { sideEffects++; response.writeHead(405); response.end(); return; }
    if (url.pathname === '/api/status') {
      if (unavailable) { response.writeHead(503); response.end('{"error":"fixture offline"}'); return; }
      await handleUiServiceRoute({ request, response, url, statusContext: {
        home: CODELARK_HOME, startedAt: new Date().toISOString(), timeZone: 'UTC', getUiAccess: () => ({ local: true }),
      } }); return;
    }
    const fixtures: Record<string, unknown> = {
      '/api/config': { runtime: 'codex', defaultProvider: 'tmux', channels: [] },
      '/api/bindings': { bindings, options: rows },
      '/api/codex-sessions': { sessions: rows, counts: { totalDisplayable: rows.length }, root: '/fixture' },
      '/api/session-config': { config: { runtime: 'codex', provider: 'tmux', model: 'fixture-model' } },
      '/api/logs': { logs: '' },
    };
    response.writeHead(url.pathname in fixtures ? 200 : 404, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(fixtures[url.pathname] || {}));
  } catch (error) { response.writeHead(500); response.end(JSON.stringify({ error: String(error) })); }
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address() as { port: number };
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) }).catch(async (error) => {
  await control.close(); server.close(); throw error;
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors: string[] = [];
page.on('pageerror', (error: Error) => errors.push(error.message));
const checks: string[] = [];
async function expectText(selector: string, text: string) {
  await page.waitForFunction(({ selector, text }) => document.querySelector(selector)?.textContent?.includes(text), { selector, text }, { timeout: 12_000 });
}
async function refresh() { await page.locator('#refreshAppServersBtn').click(); }
try {
  await page.goto(`http://127.0.0.1:${address.port}/#app-server`);
  await expectText('#appServerNotice', '尚未记录');
  await expectText('#appServerSummary', '尚未启动');
  assert.equal(await page.locator('#appServerList').textContent(), '');
  checks.push('default policy does not claim a service is running');
  current.appServers = [{ id: 'private', endpoint, owner: 'bridge', state: 'starting', connection: 'connecting', sessionIds: [] }];
  await refresh(); await expectText('#appServerList', '正在启动');
  current.sessions.shared = projectCodexBackendStatus(session, { threadId: 'thread-shared', connection: 'ready', activity: 'idle' });
  current.appServers[0] = { ...current.appServers[0], state: 'running', connection: 'ready', pid: 12345, startedAt: new Date().toISOString(), sessionIds: ['shared'] };
  // The automatic five-second refresh must update the same visible page.
  await expectText('#appServerList', '已启动');
  await expectText('#appServerList', '12345');
  checks.push('starting to ready is visible through automatic polling');
  await page.screenshot({ path: path.join(evidence, 'app-server-desktop.png'), fullPage: true });
  await page.locator('.nav-link[data-page="sessions"]').click();
  await expectText('.page[data-page="sessions"]', 'app-server');
  await expectText('.page[data-page="sessions"]', '已连接');
  await expectText('.page[data-page="sessions"]', '旧版执行路径');
  await expectText('.page[data-page="sessions"]', 'tmux 查看入口');
  const settings = page.locator('[data-page="sessions"] button[data-action="open-session-config-modal"]').first();
  await settings.click();
  await page.waitForSelector('#sessionConfigModal:not([hidden])');
  assert.ok(await page.locator('#sessionConfigBackendStatus').textContent());
  await page.locator('#sessionConfigModal button[aria-label="关闭"]').click();
  checks.push('session backend, terminal and config details render independently');
  current.sessions.shared = projectCodexBackendStatus(session, { threadId: 'thread-shared', connection: 'disconnected', activity: 'idle' });
  await expectText('.page[data-page="sessions"]', '连接已断开');
  checks.push('disconnection replaces the prior idle observation');
  await page.locator('.nav-link[data-page="app-server"]').click();
  current.appServers[0] = { ...current.appServers[0], owner: 'launchd', state: 'unknown', connection: 'ready', pid: undefined };
  await refresh(); await expectText('#appServerList', '服务可用（进程状态未确认）');
  await expectText('#appServerList', '已连接');
  checks.push('external availability does not invent a process state or PID');
  current.appServers[0] = { ...current.appServers[0], state: 'failed', connection: 'disconnected', error: '启动失败 <img src=x onerror="window.fixtureInjected=1"> ' + '可读错误信息。'.repeat(30) };
  await refresh(); await expectText('#appServerList', '启动失败');
  assert.equal(await page.evaluate(() => (window as any).fixtureInjected), undefined);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(evidence, 'app-server-mobile-error.png'), fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'mobile status must not overflow');
  assert.ok(await page.evaluate(() => {
    const list = document.getElementById('appServerList')!.getBoundingClientRect();
    return [...document.querySelectorAll('#appServerList .binding-item')].every((card) => card.getBoundingClientRect().right <= list.right + 1);
  }), 'service cards must remain inside their panel');
  checks.push('startup errors are escaped and readable on narrow screens');
  await control.close();
  control = await startBridgeControlService({ codelarkHome: CODELARK_HOME, runId: 'old-ui-fixture', handlers: { listSessions: handlers.listSessions, receiveInput: handlers.receiveInput } });
  oldBridge = true;
  await refresh(); await expectText('#appServerSummary', '状态不可用');
  assert.equal(await page.locator('#appServerList').textContent(), '');
  checks.push('older Bridge does not leave cached service state on screen');
  unavailable = true;
  await refresh(); await expectText('#appServerObservedAt', '等待取得新的状态');
  assert.equal(sideEffects, 0, 'viewing status must not call input, discovery or mutation handlers');
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ ok: true, checks, statusReads: reads, sideEffects, oldBridge, browser: browser.version() }, null, 2));
  console.log(JSON.stringify({ ok: true, checks: checks.length, evidence }));
} catch (error) {
  await page.screenshot({ path: path.join(evidence, 'failure.png'), fullPage: true }).catch(() => undefined);
  fs.writeFileSync(path.join(evidence, 'failure.json'), JSON.stringify({ error: String(error), errors, checks }, null, 2));
  throw error;
} finally {
  await browser.close(); await control.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
