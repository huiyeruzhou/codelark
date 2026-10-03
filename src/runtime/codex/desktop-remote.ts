import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { appServerCliUrl, appServerWebSocketUrl, CodexAppServerClient } from './app-server-client.js';
import { buildShellSnapshotContent } from './shell-snapshot.js';

const execFileAsync = promisify(execFile);
const LABEL = 'dev.codelark.codex-app-server';
const DESKTOP_URL_ENV = 'CODEX_APP_SERVER_WS_URL';

export interface CodexDesktopRemote {
  endpoint: string;
  managed: boolean;
  desktopEnvironmentChanged: boolean;
}

export interface DesktopRemoteOptions {
  executable: string;
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  run?: (file: string, args: string[]) => Promise<string>;
  probe?: (endpoint: string, codexHome: string) => Promise<void>;
}

interface Installation {
  codexHome: string;
  executable: string;
}

function quote(value: string): string { return `'${value.replace(/'/g, "'\\''")}'`; }
function xml(value: string): string {
  return value.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);
}

function locations(home: string) {
  const root = path.join(home, '.codelark', 'codex-desktop');
  return {
    root,
    metadata: path.join(root, 'installation.json'),
    disabled: path.join(root, 'disabled'),
    script: path.join(root, 'start.sh'),
    snapshot: path.join(root, 'environment.sh'),
    socket: path.join(root, 'app-server.sock'),
    plist: path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`),
  };
}

async function probe(endpoint: string, codexHome: string): Promise<void> {
  const client = await CodexAppServerClient.connect(endpoint, 2_000);
  try {
    const actualHome = client.serverInfo.codexHome;
    const canonical = (value: string) => { try { return fs.realpathSync(value); } catch { return path.resolve(value); } };
    if (!actualHome || canonical(actualHome) !== canonical(codexHome)) {
      throw new Error('Desktop 后端的 CODEX_HOME 与当前 Bridge 不一致，无法共享本地会话记录。');
    }
    await client.request('thread/loaded/list');
  } finally { client.close(); }
}

function runner(env: NodeJS.ProcessEnv) {
  return async (file: string, args: string[]): Promise<string> => {
    const result = await execFileAsync(file, args, { env, timeout: 15_000, maxBuffer: 1024 * 1024 });
    return result.stdout.trim();
  };
}

async function launchctlValue(run: ReturnType<typeof runner>, name: string): Promise<string> {
  return run('/bin/launchctl', ['getenv', name]).catch(() => '');
}

async function findDesktop(home: string, run: ReturnType<typeof runner>): Promise<boolean> {
  const candidates = [
    '/Applications/Codex.app', path.join(home, 'Applications', 'Codex.app'),
    '/Applications/ChatGPT.app', path.join(home, 'Applications', 'ChatGPT.app'),
  ];
  const indexed = await run('/usr/bin/mdfind', ["kMDItemCFBundleIdentifier == 'com.openai.codex'"]).catch(() => '');
  candidates.push(...indexed.split('\n').filter(Boolean));
  for (const app of new Set(candidates)) {
    if (!fs.existsSync(path.join(app, 'Contents', 'Info.plist'))) continue;
    const id = await run('/usr/bin/plutil', [
      '-extract', 'CFBundleIdentifier', 'raw', '-o', '-', path.join(app, 'Contents', 'Info.plist'),
    ]).catch(() => '');
    if (id === 'com.openai.codex') return true;
  }
  return false;
}

export function validateLocalEndpoint(endpoint: string): void {
  if (endpoint.startsWith('ws+unix:///') || endpoint.startsWith('unix:///')) return;
  const url = new URL(endpoint);
  if (['ws:', 'wss:'].includes(url.protocol) && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) return;
  throw new Error('Desktop 的 app-server 地址不是本机地址，未自动连接。');
}

/** Persist only the backend's environment, without a particular Bridge/chat identity. */
function backendEnvironment(env: NodeJS.ProcessEnv, codexHome: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || /^(?:CODELARK_|LARK_|FEISHU_|TMUX(?:_|$)|CODEX_(?:THREAD|TURN|APP_SERVER)_|CODEX_INTERNAL_|PWD$|OLDPWD$|SHLVL$|_$)/.test(key)) continue;
    result[key] = value;
  }
  result.CODEX_HOME = codexHome;
  result.GIT_TERMINAL_PROMPT = '0';
  return result;
}

function installFiles(home: string, options: DesktopRemoteOptions, codexHome: string): Installation {
  const files = locations(home);
  if (fs.existsSync(files.metadata)) return JSON.parse(fs.readFileSync(files.metadata, 'utf8')) as Installation;
  // Rename publishes the complete private directory atomically, also across Bridge instances.
  fs.mkdirSync(path.dirname(files.root), { recursive: true });
  const stage = fs.mkdtempSync(`${files.root}-install-`);
  fs.chmodSync(stage, 0o700);
  const installation: Installation = { codexHome, executable: options.executable };
  const args = ['-c', 'features.code_mode_host=true'];
  if (options.env.CODELARK_CODEX_BASE_URL) args.push('-c', `openai_base_url=${JSON.stringify(options.env.CODELARK_CODEX_BASE_URL)}`);
  if (options.env.CODEX_API_KEY || options.env.OPENAI_API_KEY) args.push('-c', 'preferred_auth_method="apikey"');
  args.push('app-server', '--listen', `unix://${files.socket}`);
  try {
    fs.writeFileSync(path.join(stage, 'installation.json'), JSON.stringify(installation), { mode: 0o600 });
    fs.writeFileSync(path.join(stage, 'environment.sh'), buildShellSnapshotContent('sh', backendEnvironment(options.env, codexHome)), { mode: 0o600 });
    fs.writeFileSync(path.join(stage, 'start.sh'), [
      '#!/bin/sh', 'set -eu',
      `test ! -f ${quote(files.disabled)} || exit 0`,
      `. ${quote(files.snapshot)}`,
      // Re-established each login; no dependency on the Bridge or its temporary snapshot.
      `/bin/launchctl setenv ${DESKTOP_URL_ENV} ${quote(appServerWebSocketUrl(`unix://${files.socket}`))}`,
      `exec ${[options.executable, ...args].map(quote).join(' ')}`, '',
    ].join('\n'), { mode: 0o700 });
    try { fs.renameSync(stage, files.root); } catch (error) {
      if (!fs.existsSync(files.metadata)) throw error;
    }
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
  return JSON.parse(fs.readFileSync(files.metadata, 'utf8')) as Installation;
}

function installPlist(home: string): void {
  const files = locations(home);
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array><string>/bin/sh</string><string>${xml(files.script)}</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>
<key>WorkingDirectory</key><string>${xml(home)}</string>
<key>StandardOutPath</key><string>${xml(path.join(files.root, 'app-server.log'))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(files.root, 'app-server.log'))}</string>
</dict></plist>\n`;
  fs.mkdirSync(path.dirname(files.plist), { recursive: true });
  if (fs.existsSync(files.plist)) {
    if (fs.readFileSync(files.plist, 'utf8') !== content) throw new Error('已有同名 LaunchAgent 配置，未覆盖。');
    return;
  }
  try { fs.writeFileSync(files.plist, content, { flag: 'wx', mode: 0o600 }); } catch (error) {
    if (!fs.existsSync(files.plist) || fs.readFileSync(files.plist, 'utf8') !== content) throw error;
  }
}

export async function prepareCodexDesktopRemote(options: DesktopRemoteOptions): Promise<CodexDesktopRemote | undefined> {
  if ((options.platform ?? process.platform) !== 'darwin' || options.env.CODELARK_CODEX_DESKTOP_REMOTE === '0') return;
  const home = options.home ?? os.homedir();
  const files = locations(home);
  if (fs.existsSync(files.disabled)) return;
  const run = options.run ?? runner(options.env);
  const check = options.probe ?? probe;
  if (!await findDesktop(home, run)) return;
  if (options.env.CODEX_APP_SERVER_FORCE_CLI === '1' || await launchctlValue(run, 'CODEX_APP_SERVER_FORCE_CLI') === '1') return;
  const help = await run(options.executable, ['--help']);
  if (!help.includes('--remote')) return; // old installations retain the legacy execution adapter

  const ownEndpoint = `unix://${files.socket}`;
  const codexHome = path.resolve(options.env.CODEX_HOME || path.join(home, '.codex'));
  const desktopUrl = await launchctlValue(run, DESKTOP_URL_ENV);
  const inheritedUrl = options.env[DESKTOP_URL_ENV]?.trim();
  if (desktopUrl && inheritedUrl && appServerCliUrl(desktopUrl) !== appServerCliUrl(inheritedUrl)) {
    throw new Error('Bridge 与 macOS 的 Desktop app-server 地址不一致，未创建另一个后端。');
  }
  const configuredUrl = desktopUrl || inheritedUrl;
  if (configuredUrl && appServerCliUrl(configuredUrl) !== ownEndpoint) {
    validateLocalEndpoint(configuredUrl);
    await check(configuredUrl, codexHome);
    return { endpoint: appServerCliUrl(configuredUrl), managed: false, desktopEnvironmentChanged: false };
  }

  // ws+unix does not decode escaped socket names; macOS also caps Unix socket paths at 104 bytes.
  if (Buffer.byteLength(files.socket) >= 104 || /[\s%:?#]/.test(files.socket)) {
    throw new Error('当前用户目录无法用于 Codex Desktop 的 Unix socket（路径过长或含 URL 特殊字符）。');
  }
  const serverHelp = await run(options.executable, ['app-server', '--help']);
  if (!serverHelp.includes('unix://')) return;
  const installation = installFiles(home, options, codexHome);
  if (installation.codexHome !== codexHome) {
    throw new Error('共享 app-server 使用另一份 CODEX_HOME；未覆盖已有 Desktop 会话环境。');
  }
  installPlist(home);
  const domain = `gui/${os.userInfo().uid}`;
  try { await run('/bin/launchctl', ['print', `${domain}/${LABEL}`]); } catch {
    try { await run('/bin/launchctl', ['bootstrap', domain, files.plist]); } catch (error) {
      // A concurrent Bridge may have installed this same complete service.
      try { await run('/bin/launchctl', ['print', `${domain}/${LABEL}`]); } catch { throw error; }
    }
  }
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try { await check(ownEndpoint, codexHome); lastError = undefined; break; } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (lastError) throw new Error(`共享 Codex app-server 未就绪；请查看 ${path.join(files.root, 'app-server.log')}。`, { cause: lastError });
  const wsUrl = appServerWebSocketUrl(ownEndpoint);
  await run('/bin/launchctl', ['setenv', DESKTOP_URL_ENV, wsUrl]);
  if (await launchctlValue(run, DESKTOP_URL_ENV) !== wsUrl) throw new Error('macOS 未保存 Desktop app-server 地址。');
  return { endpoint: ownEndpoint, managed: true, desktopEnvironmentChanged: desktopUrl !== wsUrl };
}

export function codexDesktopRemoteNotice(remote: CodexDesktopRemote): string {
  return '已检测到 Codex Desktop，新 tmux 已使用 --remote 连接共享 app-server。'
    + (remote.desktopEnvironmentChanged ? '已自动配置 Desktop 连接地址；如果 Desktop 已在运行，请退出后重新打开一次。以后无需手动设置。' : 'Desktop 可连接同一后端恢复此会话。');
}

/** Explicit CLI action: disable auto setup first, then unload only our own service. */
export async function disableCodexDesktopRemote(options: Pick<DesktopRemoteOptions, 'platform' | 'home' | 'run'> = {}): Promise<void> {
  if ((options.platform ?? process.platform) !== 'darwin') throw new Error('此命令仅支持 macOS。');
  const home = options.home ?? os.homedir();
  const files = locations(home);
  fs.mkdirSync(files.root, { recursive: true, mode: 0o700 });
  fs.writeFileSync(files.disabled, '', { mode: 0o600 });
  if (!fs.existsSync(files.metadata)) return;
  // Validate our persisted plist before targeting its launchd label.
  if (fs.existsSync(files.plist)) installPlist(home);
  const run = options.run ?? runner(process.env);
  const target = `gui/${os.userInfo().uid}/${LABEL}`;
  let loaded = false;
  try { await run('/bin/launchctl', ['print', target]); loaded = true; } catch { /* already stopped */ }
  if (loaded) await run('/bin/launchctl', ['bootout', target]);
  if (await launchctlValue(run, DESKTOP_URL_ENV) === appServerWebSocketUrl(`unix://${files.socket}`)) {
    await run('/bin/launchctl', ['unsetenv', DESKTOP_URL_ENV]);
  }
  fs.rmSync(files.plist, { force: true });
}
