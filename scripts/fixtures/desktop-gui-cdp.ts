import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import WebSocket from 'ws';
import { onboardingAction, type OnboardingScreen } from './desktop-gui-onboarding.js';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export async function until<T>(read: () => Promise<T | false>, label: string, timeoutMs = 45_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await read();
    if (value !== false) return value;
    await pause(300);
  }
  throw new Error(`真实 Desktop GUI 等待超时：${label}；检查截图、DOM 和 desktop.log`);
}

/** 只连接本次 open 启动的官方 Electron；不注入应用 API、不调用 renderer 内部函数。 */
export class Cdp {
  private sequence = 0;
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout; method: string; started: number }>();
  private constructor(private socket: WebSocket, private record: (entry: unknown) => void) {
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString());
      if (message.id === undefined) { record({ event: message }); return; }
      const request = this.pending.get(message.id);
      record({ response: { id: message.id, method: request?.method, durationMs: request ? Date.now() - request.started : undefined,
        lateOrUnknown: !request, error: message.error } });
      if (!request) return;
      clearTimeout(request.timer); this.pending.delete(message.id);
      if (message.error) request.reject(new Error(JSON.stringify(message.error)));
      else request.resolve(message.result);
    });
    socket.on('error', (error) => this.fail(error));
    socket.on('close', () => this.fail(new Error('Desktop CDP 已关闭')));
  }
  static async connect(url: string, record: (entry: unknown) => void) {
    const socket = new WebSocket(url, { handshakeTimeout: 10_000 });
    const client = new Cdp(socket, record);
    try {
      await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    } catch (error) { client.close(); throw error; }
    return client;
  }
  call<T = any>(method: string, params: object = {}): Promise<T> {
    assert.equal(this.socket.readyState, WebSocket.OPEN, 'CDP 连接必须已打开');
    const id = ++this.sequence;
    // 启动期间主线程可能短暂停顿；只读观察沿用 UI 的 45 秒预算，不在 10 秒处提前失败。
    // 每个操作只发送一次，尤其不能因未知执行结果而重发 Input 或 Browser.close。
    const timeoutMs = ['Runtime.evaluate', 'Accessibility.getFullAXTree', 'Page.captureScreenshot'].includes(method) ? 45_000 : 10_000;
    const started = Date.now();
    this.record({ command: { id, method, params, timeoutMs } });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.record({ timeout: { id, method, timeoutMs, durationMs: Date.now() - started } });
        reject(new Error(`CDP 超时：${method} (${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method, started });
      this.socket.send(JSON.stringify({ id, method, params }), (error) => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
      });
    });
  }
  private fail(error: Error) {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear();
  }
  close() { this.socket.terminate(); this.fail(new Error('验收已关闭 CDP')); }
}

// DOM 查询只读；用户操作通过 Chromium Input 域产生真实鼠标/键盘事件。
const visible = `(e) => { const r=e.getBoundingClientRect(); const s=getComputedStyle(e); return r.width>0 && r.height>0 && s.visibility!=='hidden' && s.display!=='none'; }`;
const composer = '[contenteditable="true"].ProseMirror, [contenteditable="true"][role="textbox"], textarea';

export class DesktopGui {
  private page?: Cdp;
  private browser?: Cdp;
  private opener?: ChildProcess;
  private openerError?: Error;
  private directory: string;
  readonly identity: Record<string, unknown> = {};
  constructor(private options: { app: string; root: string; evidence: string; env: NodeJS.ProcessEnv; name: string }) {
    this.directory = path.join(options.evidence, options.name);
    fs.mkdirSync(this.directory, { recursive: true });
  }
  async launch(threadId?: string) {
    const { app, root, env, name } = this.options;
    const userData = path.join(root, 'desktop-profile');
    fs.mkdirSync(userData, { recursive: true });
    // 由内核分配端口，不探测任何既有本机服务。
    const reservation = net.createServer();
    await new Promise<void>((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
    const address = reservation.address();
    assert(address && typeof address !== 'string' && address.port !== 8001);
    const port = address.port;
    await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
    const log = fs.openSync(path.join(this.directory, 'desktop.log'), 'w');
    // 不传 CODEX_APP_SERVER_WS_URL：必须由真实 LaunchServices 继承 launchd 的地址。
    assert.equal(env.CODEX_APP_SERVER_WS_URL, undefined);
    const args = ['-n', '-W', '--stdout', path.join(this.directory, 'app-stdout.log'), '--stderr', path.join(this.directory, 'app-stderr.log'),
      '--env', `CODEX_HOME=${env.CODEX_HOME}`, '--env', `CODEX_ELECTRON_USER_DATA_PATH=${userData}`,
      '--env', 'OPENAI_API_KEY=isolated-fixture-key', app, '--args',
      `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', `--user-data-dir=${userData}`, '--lang=en-US',
      ...(threadId ? [this.threadUrl(threadId)] : [])];
    this.identity.launch = { name, command: '/usr/bin/open', args, at: new Date().toISOString() };
    fs.writeFileSync(path.join(this.directory, 'identity.json'), JSON.stringify(this.identity, null, 2));
    this.opener = spawn('/usr/bin/open', args, { env, stdio: ['ignore', log, log] });
    fs.closeSync(log);
    this.opener.once('error', (error) => { this.openerError = error; });
    const get = async (suffix: string) => {
      if (this.openerError) throw this.openerError;
      assert(this.opener!.exitCode === null, `open 提前退出：${this.opener!.exitCode}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/${suffix}`, { signal: AbortSignal.timeout(1_000) });
        return response.ok ? await response.json() as any : false;
      } catch { return false; }
    };
    const version = await until(() => get('json/version'), '官方 App 的 CDP 端口');
    const record = (entry: unknown) => fs.appendFileSync(path.join(this.directory, 'cdp.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...entry as object }) + '\n');
    this.browser = await Cdp.connect(version.webSocketDebuggerUrl, record);
    this.identity.cdpVersion = version;
    this.identity.processes = await this.browser.call('SystemInfo.getProcessInfo');
    const target = await until(async () => {
      const targets = await get('json/list');
      if (!targets) return false;
      fs.writeFileSync(path.join(this.directory, 'targets.json'), JSON.stringify(targets, null, 2));
      for (const target of targets) {
        if (target.type !== 'page' || !target.webSocketDebuggerUrl || !/^(file:|app:|codex:)/.test(target.url)
          || target.url.includes('devtools')) continue;
        const candidate = await Cdp.connect(target.webSocketDebuggerUrl, record);
        try {
          const viewport = await candidate.call('Runtime.evaluate', {
            expression: '({visible:document.visibilityState === "visible",width:innerWidth,height:innerHeight})', returnByValue: true,
          });
          const size = viewport.result.value;
          if (size?.visible && size.width >= 500 && size.height >= 400) {
            this.page = candidate;
            this.identity.viewport = size;
            return target;
          }
        } finally { if (this.page !== candidate) candidate.close(); }
      }
      return false;
    }, '真实 Desktop renderer 页面');
    this.identity.target = target;
    await this.page!.call('Runtime.enable');
    await this.page!.call('Page.enable');
    await this.page!.call('Page.bringToFront');
    await until(async () => await this.evaluate('document.readyState') === 'complete', 'renderer DOM ready');
    await this.capture('launched');
  }
  private async evaluate(expression: string): Promise<any> {
    assert(this.page, 'Desktop 页面尚未连接');
    const reply = await this.page.call('Runtime.evaluate', { expression, returnByValue: true });
    assert(!reply.exceptionDetails, JSON.stringify(reply.exceptionDetails));
    return reply.result.value;
  }
  async text(): Promise<string> { return this.evaluate('document.body.innerText'); }
  private threadUrl(threadId: string) { return `codex://threads/${encodeURIComponent(threadId)}?hostId=local`; }
  private async onboardingScreen(): Promise<OnboardingScreen> {
    return this.evaluate(`(() => {
      const shown=${visible};
      const dialogs=Array.from(document.querySelectorAll('[role="dialog"],[role="alertdialog"]')).filter(shown);
      const dialog=dialogs.at(-1), scope=dialog || document;
      const progress=Array.from(document.querySelectorAll('[data-testid="onboarding-progress-bar"]')).find(shown);
      const role=Array.from(document.querySelectorAll('input[name="conversational-onboarding-inline-role"]'))
        .find(e=>shown(e.closest('label') || e));
      const engineering=document.querySelector('input[name="conversational-onboarding-inline-role"][value="engineering"]');
      const personalized=document.getElementById('personalized-suggestions');
      return {progress:progress ? progress.getAttribute('data-active-index') || 'unknown' : null,
        role:!!role,engineering:!!engineering?.checked,
        personalized:personalized && shown(personalized) ? personalized.getAttribute('aria-checked')==='true' : null,
        dialog:dialog ? dialog.innerText : null,
        buttons:Array.from(scope.querySelectorAll('button,[role="button"]')).filter(shown)
          .filter(e=>!e.disabled && e.getAttribute('aria-disabled')!=='true')
          .map(e=>(e.getAttribute('aria-label') || e.innerText || '').trim()),
        composer:Array.from(document.querySelectorAll(${JSON.stringify(composer)})).some(shown)};
    })()`);
  }
  async finishOnboarding(threadId: string, marker: string) {
    // 已完成向导的 profile 不重复设置；初始深链接可能被向导消费，完成后再用系统入口打开。
    if ((await this.text()).includes(marker)) return false;
    let acted = false;
    for (let step = 0; step < 10; step++) {
      const { screen, action } = await until(async () => {
        const screen = await this.onboardingScreen();
        const action = onboardingAction(screen);
        return action ? { screen, action } : false;
      }, '首次向导的已知可见控件，或主界面输入框');
      await this.capture(`onboarding-${String(step).padStart(2, '0')}`);
      const entry = { at: new Date().toISOString(), step, screen, action };
      fs.appendFileSync(path.join(this.directory, 'onboarding.jsonl'), JSON.stringify(entry) + '\n');
      if (action === 'done') {
        this.identity.onboarding = { completedThroughGui: acted, at: entry.at };
        const url = this.threadUrl(threadId);
        await promisify(execFile)('/usr/bin/open', ['-a', this.options.app, url], { env: this.options.env, timeout: 15_000 });
        this.identity.threadReopened = { url, at: new Date().toISOString() };
        await this.expectText(marker);
        await this.capture('onboarding-thread-reopened');
        return acted;
      }
      // 使用当前对话框的公开按钮；不按页面全局 Skip 名称穿过弹窗。
      await this.button([action], screen.dialog !== null);
      acted = true;
      await until(async () => {
        const next = await this.onboardingScreen();
        // 选中角色、取消勾选和页面跳转都必须产生可读状态变化后才能继续点击。
        return next.engineering !== screen.engineering || next.personalized !== screen.personalized
          || next.role !== screen.role || next.progress !== screen.progress || next.dialog !== screen.dialog
          || (onboardingAction(next) !== false && onboardingAction(next) !== action)
          || (!!next.composer && next.progress === null);
      }, `向导操作 ${action} 生效`);
    }
    throw new Error('首次向导超过 10 次已知操作；保留页面证据，不猜测点击未知控件');
  }
  async expectText(marker: string) {
    try {
      await until(async () => (await this.text()).includes(marker), `界面显示 ${marker}`);
    } catch (error) {
      const text = await this.text();
      if (/sign in|log in|continue with (?:google|apple|microsoft)|登录/i.test(text)) {
        throw new Error(`官方 Desktop 当前显示登录入口，尚未进入目标 thread；需要核实该版本的本地模型入口或提供隔离 GUI 账号。界面内容已保存；不自动登录。原错误：${String(error)}`);
      }
      throw error;
    }
  }
  startupDiagnostics() {
    // 原生启动错误对话框会阻塞 CDP；只能读取本次 open 显式指定的 App 日志。
    const log = path.join(this.directory, 'app-stderr.log');
    if (!fs.existsSync(log)) return { log, transportErrors: [] as string[] };
    const transportErrors = new Set<string>();
    for (const line of fs.readFileSync(log, 'utf8').split('\n')) {
      if (!/\[AppServerConnection\].*(?:websocket_error|connection_failed_before_ready)/.test(line)) continue;
      const encoded = line.match(/\b(?:errorMessage|message)=("(?:\\.|[^"\\])*")/)?.[1];
      if (encoded) transportErrors.add(JSON.parse(encoded));
    }
    return { log, transportErrors: [...transportErrors] };
  }
  async capture(name: string) {
    this.identity.startupDiagnostics = this.startupDiagnostics();
    fs.writeFileSync(path.join(this.directory, 'identity.json'), JSON.stringify(this.identity, null, 2));
    if (!this.page) return;
    fs.writeFileSync(path.join(this.directory, `${name}.txt`), await this.text());
    fs.writeFileSync(path.join(this.directory, `${name}.html`), await this.evaluate('document.documentElement.outerHTML'));
    fs.writeFileSync(path.join(this.directory, `${name}-accessibility.json`), JSON.stringify(await this.page.call('Accessibility.getFullAXTree'), null, 2));
    const screenshot = await this.page.call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(this.directory, `${name}.png`), Buffer.from(screenshot.data, 'base64'));
  }
  private async clickExpression(elements: string, label: string) {
    const point = await until(async () => this.evaluate(`(() => {
      const es=(${elements}).filter(${visible}).filter(e=>!e.disabled && e.getAttribute('aria-disabled')!=='true');
      if(es.length!==1) return false;
      const e=es[0]; e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect();
      const x=r.x+r.width/2,y=r.y+r.height/2; if(!e.contains(document.elementFromPoint(x,y))) return false;
      return {x,y}; })()`), label);
    await this.page!.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await this.page!.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  }
  async button(labels: string[], inDialog = false) {
    const names = JSON.stringify(labels);
    const scope = inDialog ? `Array.from(document.querySelectorAll('[role="dialog"],[role="alertdialog"]')).filter(${visible}).at(-1)` : 'document';
    await this.clickExpression(`Array.from((${scope}).querySelectorAll('button,[role="button"],[role="radio"],label')).filter(e =>
      ${names}.includes((e.getAttribute('aria-label') || e.innerText || '').trim()) ||
      Array.from(e.querySelectorAll('span')).some(s => ${names}.includes(s.textContent.trim())))
      .filter((e,_,es) => !es.some(other => other!==e && e.contains(other)))`, `唯一可用按钮 ${labels.join('/')}`);
  }
  async send(text: string) {
    await this.clickExpression(`Array.from(document.querySelectorAll(${JSON.stringify(composer)}))`, '消息输入框');
    await this.page!.call('Input.insertText', { text });
    await this.page!.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await this.page!.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  }
  async close() {
    // Browser.close 只关闭这次 CDP 连接对应的 App；不按全局进程名清理。
    try {
      if (this.browser) {
        await this.browser.call('Browser.close').catch((error) => {
          if (!/CDP 已关闭/.test(String(error))) throw error;
        });
        await until(async () => this.opener?.exitCode !== null || this.opener?.signalCode !== null, '本次 Desktop 实例退出', 15_000);
      } else if (this.opener && this.opener.exitCode === null) {
        throw new Error('CDP 建连前失败，无法确认 Desktop PID；保留实例供 disposable runner 清理，不按进程名终止');
      }
    } finally {
      this.page?.close(); this.browser?.close();
      // 放开本次 open 子进程对 Node 事件循环的引用，不停止归属未知的 Desktop。
      this.opener?.unref();
    }
  }
}
