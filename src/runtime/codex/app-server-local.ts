import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { CODELARK_HOME } from '../../configuration/paths.js';
import { CodexAppServerClient, isCodexActiveWriterError } from './app-server-client.js';

const execFileAsync = promisify(execFile);
function canonical(value: string): string {
  let existing = path.resolve(value);
  const suffix: string[] = [];
  for (;;) {
    try { return path.join(fs.realpathSync(existing), ...suffix); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      suffix.unshift(path.basename(existing)); existing = parent;
    }
  }
}

/** Stable across Bridge restarts; never publish this private address to Desktop. */
export function codexLocalAppServerEndpoint(home = CODELARK_HOME, platform = process.platform): string {
  const identity = canonical(home);
  const hash = createHash('sha256').update(platform === 'win32' ? identity.toLowerCase() : identity).digest();
  return platform === 'win32'
    ? `ws://127.0.0.1:${40_000 + hash.readUInt32BE(0) % 20_000}`
    : `unix:///tmp/codelark-codex-${hash.toString('hex').slice(0, 24)}/rpc.sock`;
}

/** Own the npm installation's native backend, not its command/Node wrapper. */
export function localAppServerInvocation(executable: string, platform = process.platform): { command: string; args: string[] } {
  const windowsShim = platform === 'win32' && /\.(cmd|bat)$/i.test(executable);
  const entry = windowsShim ? path.join(path.dirname(executable), 'node_modules', '@openai', 'codex', 'bin', 'codex.js') : canonical(executable);
  let npm = windowsShim && fs.existsSync(entry);
  if (!npm && path.basename(entry) === 'codex.js') {
    try { npm = JSON.parse(fs.readFileSync(path.resolve(path.dirname(entry), '..', 'package.json'), 'utf8')).name === '@openai/codex'; }
    catch { /* User-provided scripts remain executable entrypoints. */ }
  }
  if (!npm) {
    if (windowsShim) throw new Error('无法解析此 Codex Windows 包装命令；请指定安装中的 codex.exe。');
    return /\.[cm]?js$/i.test(executable) ? { command: process.execPath, args: [executable] } : { command: executable, args: [] };
  }
  const target = platform === 'win32' ? 'pc-windows-msvc' : platform === 'darwin' ? 'apple-darwin' : 'unknown-linux-musl';
  const triple = `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-${target}`;
  let vendor = path.resolve(path.dirname(entry), '..', 'vendor');
  try {
    vendor = path.join(path.dirname(createRequire(entry).resolve(`@openai/codex-${platform}-${process.arch}/package.json`)), 'vendor');
  } catch { /* Older npm releases bundle vendor inside @openai/codex. */ }
  for (const directory of ['bin', 'codex']) {
    const binary = path.join(vendor, triple, directory, platform === 'win32' ? 'codex.exe' : 'codex');
    if (fs.existsSync(binary)) return { command: binary, args: [] };
  }
  throw new Error('Codex npm 安装缺少原生 Codex 可执行文件；未启动其他后端。');
}

interface OwnedBackend {
  child: ChildProcess;
  status: CodexLocalAppServerStatus;
  exited: Promise<void>;
  stop?: Promise<void>;
  socket?: { path: string; dev: number; ino: number };
}
const owned = new Map<string, OwnedBackend>();
export interface CodexLocalAppServerStatus {
  endpoint: string;
  owner: 'bridge' | 'external' | 'unknown';
  state: 'not-started' | 'starting' | 'running' | 'stopped' | 'failed' | 'unsupported' | 'unknown';
  pid?: number;
  startedAt?: string;
  updatedAt?: string;
  error?: string;
}
// Observations survive child cleanup; they are not a PID registry or a liveness probe.
const observations = new Map<string, CodexLocalAppServerStatus>();
export function getCodexLocalAppServerStatuses(): CodexLocalAppServerStatus[] {
  return [...observations.values()].map((status) => ({ ...status }));
}

/** Classify known failures without publishing raw stderr, URLs, arguments or credentials. */
export function describeCodexAppServerError(error: unknown, phase = 'app-server 准备'): string {
  const detail = error as { code?: string | number; syscall?: string; message?: string; stderr?: string; cause?: { message?: string; code?: string } } | undefined;
  const code = detail?.code ?? detail?.cause?.code;
  const message = [detail?.message, detail?.stderr, detail?.cause?.message].filter(Boolean).join('\n');
  let reason: string;
  if (code === 'ENOENT' && detail?.syscall === 'connect') reason = '本机服务尚未建立监听 socket。';
  else if (code === 'ENOENT' || /executable .*not found|缺少原生.*可执行文件|无法解析.*包装命令/i.test(message)) reason = '找不到可用的 Codex CLI，请检查安装与可执行文件路径。';
  else if (/CODEX_HOME/.test(message)) reason = '服务的 CODEX_HOME 与当前 Bridge 不一致，未接管。';
  else if (code === 'EADDRINUSE' || code === 'ENOTSOCK' || /socket.*(?:已存在|已被占用)|地址已被/.test(message)) reason = '本机地址已被占用或不是 socket，未替换已有资源。';
  else if (code === 'EACCES' || code === 'EPERM' || /permission denied|access denied|不是当前用户的私有目录/i.test(message)) reason = '权限不足，请检查可执行文件及 socket 目录权限。';
  else if (isCodexActiveWriterError(error)) reason = '线程仍由另一 Codex 进程持有；未发送输入，也未回退旧执行路径。';
  else if (code === -32601 || /unrecognized subcommand|不支持.*--listen|无法确认.*--listen|unknown variant/i.test(message)) reason = '当前 Codex CLI 或服务不支持所需 app-server 协议。';
  else if (code === 'ETIMEDOUT' || /timed?\s*out|timeout|超时/i.test(message)) reason = '连接或协议请求超时，请检查服务是否可用。';
  else if (/401|403|unauthori[sz]ed|authentication|login|认证|凭据/i.test(message)) reason = '认证失败，请检查此后端的 Codex 登录或 API key 配置。';
  else if (code === 'ECONNREFUSED') reason = '本机服务拒绝连接，监听端点尚不可用。';
  else if (/closed|disconnect|连接.*结束|客户端已关闭/i.test(message)) reason = '服务连接已断开。';
  else if (/configuration|配置/i.test(message)) reason = 'Codex 配置无效或与当前服务不兼容。';
  else if (typeof code === 'number' && code < 0) reason = 'Codex 服务拒绝了此协议请求。';
  else reason = 'Codex 未能完成请求，请查看 Bridge 日志中的具体错误。';
  return `${phase}失败：${reason}`;
}
const preparing = new Map<string, { codexHome: string; promise: Promise<string | undefined> }>();
let generation = 0;

function unavailable(error: unknown): boolean {
  return ['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException)?.code || '');
}

async function probe(endpoint: string, codexHome: string): Promise<void> {
  const client = await CodexAppServerClient.connect(endpoint, { connectTimeoutMs: 2_000 });
  try {
    if (!client.serverInfo.codexHome || canonical(client.serverInfo.codexHome) !== canonical(codexHome)) {
      throw new Error('本地 app-server 地址已被另一份 CODEX_HOME 使用，未启动或接管后端。');
    }
    await client.request('thread/loaded/list');
  } finally { client.close(); }
}

function privateSocketDirectory(endpoint: string): string | undefined {
  if (!endpoint.startsWith('unix://')) return;
  const socket = endpoint.slice('unix://'.length);
  const directory = path.dirname(socket);
  fs.mkdirSync(directory, { mode: 0o700, recursive: true });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
    || (process.getuid && stat.uid !== process.getuid())) throw new Error('app-server socket 目录不是当前用户的私有目录，未使用。');
  return socket;
}

function socketExists(socket: string): boolean {
  try { fs.lstatSync(socket); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

async function releaseOwnedSocket(backend: OwnedBackend, endpoint: string, codexHome: string): Promise<void> {
  const identity = backend.socket;
  if (!identity) return;
  const unchanged = () => {
    try {
      const stat = fs.lstatSync(identity.path);
      return stat.isSocket() && stat.dev === identity.dev && stat.ino === identity.ino;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  };
  if (!unchanged()) return;
  // A concurrent owner may have won the bind race. A live listener is never ours
  // to unlink after our own child exited, even if it passed the readiness probe.
  try { await probe(endpoint, codexHome); return; }
  catch (error) { if (!unavailable(error)) return; }
  if (unchanged()) fs.unlinkSync(identity.path);
}

function stopOwned(backend: OwnedBackend): Promise<void> {
  if (backend.stop) return backend.stop;
  const running = () => backend.child.exitCode === null && backend.child.signalCode === null;
  if (running()) backend.child.kill('SIGTERM');
  const timer = setTimeout(() => { if (running()) backend.child.kill('SIGKILL'); }, 5_000);
  timer.unref();
  backend.stop = backend.exited.finally(() => clearTimeout(timer));
  return backend.stop;
}

/** Close only children actually spawned by this Bridge, never a reused listener. */
export function closeCodexLocalAppServers(): Promise<void> {
  generation++;
  const closing = [...owned.values()].map(stopOwned);
  return Promise.all([...closing, ...[...preparing.values()].map((entry) => entry.promise.catch(() => undefined))]).then(() => undefined);
}

export function prepareCodexLocalAppServer(options: {
  executable: string;
  env: NodeJS.ProcessEnv;
  codelarkHome?: string;
}): Promise<string | undefined> {
  const endpoint = codexLocalAppServerEndpoint(options.codelarkHome);
  const codexHome = canonical(options.env.CODEX_HOME || path.join(options.env.HOME || options.env.USERPROFILE || os.homedir(), '.codex'));
  const pending = preparing.get(endpoint);
  if (pending) return pending.codexHome === codexHome ? pending.promise
    : Promise.reject(new Error('同一私有地址正在准备另一份 CODEX_HOME，未接管。'));
  const epoch = generation;
  const status: CodexLocalAppServerStatus = owned.get(endpoint)?.status
    ?? { endpoint, owner: 'unknown', state: 'starting' };
  const previousState = status.state;
  status.updatedAt = new Date().toISOString();
  status.error = undefined;
  observations.set(endpoint, status);
  const reused = () => {
    if (!owned.has(endpoint)) {
      status.owner = 'external'; status.state = 'unknown';
      delete status.pid; delete status.startedAt;
    } else status.state = 'running';
    status.updatedAt = new Date().toISOString();
    return endpoint;
  };
  const assertCurrent = () => { if (epoch !== generation) throw new Error('Bridge 已关闭，未继续启动私有 app-server。'); };
  const operation = (async () => {
    const previous = owned.get(endpoint);
    if (previous?.stop || (previous && (previous.child.exitCode !== null || previous.child.signalCode !== null))) await previous.exited;
    assertCurrent();
    const socket = privateSocketDirectory(endpoint);
    try { await probe(endpoint, codexHome); assertCurrent(); return reused(); }
    catch (error) { if (!unavailable(error)) throw error; }
    if (previous) {
      // Socket close can arrive before ChildProcess.exit. Wait for that known
      // child and its inode cleanup; never launch a second writer beside it.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([previous.exited, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('自有 app-server 不可连接且尚未退出，未启动第二个后端。')), 5_000);
        })]);
      } finally { clearTimeout(timer); }
    }
    assertCurrent();
    // A refused connection does not authorize deleting a stale socket or another file.
    if (socket && socketExists(socket)) throw new Error(`app-server socket 已存在但不可连接，未删除或替换：${socket}`);
    const invocation = localAppServerInvocation(options.executable);
    let help: string;
    try {
      const result = await execFileAsync(invocation.command, [...invocation.args, 'app-server', '--help'], {
        env: options.env, timeout: 15_000, maxBuffer: 1024 * 1024, windowsHide: true,
      });
      help = result.stdout;
    } catch (error) {
      const stderr = String((error as { stderr?: string }).stderr || '');
      if (/unrecognized subcommand ['`]app-server['`]/i.test(stderr)) { status.state = 'unsupported'; return; }
      throw error;
    }
    assertCurrent();
    if (!/--listen\b/.test(help)) {
      if (/Usage:[\s\S]*app-server\b/.test(help)) { status.state = 'unsupported'; return; }
      throw new Error('无法确认 Codex app-server --listen 能力，未回退旧执行路径。');
    }
    // Check again after the CLI capability query; another owner may have started it.
    try { await probe(endpoint, codexHome); assertCurrent(); return reused(); }
    catch (error) { if (!unavailable(error)) throw error; }
    assertCurrent();
    if (socket && socketExists(socket)) throw new Error(`app-server socket 已被占用，未替换：${socket}`);
    const env: NodeJS.ProcessEnv = { ...options.env, CODEX_HOME: codexHome };
    const apiKey = env.CODELARK_CODEX_API_KEY || env.CODEX_API_KEY || env.OPENAI_API_KEY;
    if (apiKey) { env.CODEX_API_KEY = apiKey; env.OPENAI_API_KEY = apiKey; }
    const args = [...invocation.args, '-c', 'features.code_mode_host=true'];
    if (env.CODELARK_CODEX_BASE_URL) args.push('-c', `openai_base_url=${JSON.stringify(env.CODELARK_CODEX_BASE_URL)}`);
    // app-server intentionally ignores environment login keys. Authenticate only
    // this owned process through the public API, with a memory-only auth store.
    if (apiKey) args.push('-c', 'preferred_auth_method="apikey"', '-c', 'cli_auth_credentials_store="ephemeral"');
    args.push('app-server', '--listen', endpoint);
    const child = spawn(invocation.command, args, {
      env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
    });
    status.owner = 'bridge'; status.state = 'starting';
    delete status.pid; delete status.startedAt;
    child.once('spawn', () => {
      status.pid = child.pid; status.startedAt = new Date().toISOString(); status.updatedAt = status.startedAt;
    });
    let failure: Error | undefined;
    let stderr = '';
    child.stderr!.on('data', (data: Buffer) => { stderr = (stderr + data.toString()).slice(-8_000); });
    const backend: OwnedBackend = { child, status, exited: new Promise<void>((resolve) => {
      child.once('exit', (code, signal) => {
        status.state = backend.stop || code === 0 ? 'stopped' : 'failed';
        status.updatedAt = new Date().toISOString();
        status.error = status.state === 'failed' ? `私有 app-server 已退出（${code ?? signal}）。` : undefined;
        void releaseOwnedSocket(backend, endpoint, codexHome).catch((error) => {
          console.warn('[codex-app-server] 自有 socket 清理未完成:', error);
        }).finally(resolve);
      });
      child.once('error', (error) => {
        failure = error; status.state = 'failed'; status.updatedAt = new Date().toISOString();
        status.error = '私有 app-server 子进程启动失败。'; resolve();
      });
    }) };
    owned.set(endpoint, backend);
    void backend.exited.then(() => { if (owned.get(endpoint) === backend) owned.delete(endpoint); });
    try {
      const deadline = Date.now() + 15_000;
      for (;;) {
        assertCurrent();
        if (failure) throw failure;
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Codex app-server 启动失败（${child.exitCode ?? child.signalCode}）：${stderr}`);
        try {
          await probe(endpoint, codexHome); assertCurrent();
          if (child.exitCode !== null || child.signalCode !== null) throw new Error('私有 app-server 在准备期间退出，未认领监听地址。');
          if (socket) {
            const stat = fs.lstatSync(socket);
            if (!stat.isSocket()) throw new Error('app-server 未创建预期的 Unix socket。');
            backend.socket = { path: socket, dev: stat.dev, ino: stat.ino };
          }
          if (apiKey) {
            const client = await CodexAppServerClient.connect(endpoint);
            try {
              const { config } = await client.request<{ config: { cli_auth_credentials_store?: string } }>('config/read');
              if (config.cli_auth_credentials_store !== 'ephemeral') throw new Error('私有 app-server 未启用内存认证，未修改已有凭据。');
              await client.request('account/login/start', { type: 'apiKey', apiKey });
            }
            finally { client.close(); }
            assertCurrent();
          }
          status.state = 'running'; status.updatedAt = new Date().toISOString(); status.error = undefined;
          return endpoint;
        }
        catch (error) { if (!unavailable(error) || Date.now() >= deadline) throw error; }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } catch (error) {
      await stopOwned(backend);
      throw error;
    }
  })().catch((error) => {
    const child = owned.get(endpoint)?.child;
    const stillRunning = child && child.exitCode === null && child.signalCode === null;
    if (epoch === generation) {
      // A failed connection attempt is not evidence that an already running child exited.
      status.state = stillRunning ? previousState : 'failed';
      status.error = describeCodexAppServerError(error, stillRunning ? '服务连接' : '私有 app-server 准备');
    } else if (status.state === 'starting') status.state = 'stopped';
    status.updatedAt = new Date().toISOString();
    throw error;
  }).finally(() => { if (preparing.get(endpoint)?.promise === operation) preparing.delete(endpoint); });
  preparing.set(endpoint, { codexHome, promise: operation });
  return operation;
}
