import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface CursorAcpMessage {
  jsonrpc?: '2.0';
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface CursorAcpClientOptions {
  executable?: string;
  args?: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
}

export class CursorAcpRpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(`Cursor ACP (${code}): ${message}`);
  }
}

function executable(): string {
  const configured = process.env.CURSOR_AGENT_EXECUTABLE || process.env.CODELARK_CURSOR_EXECUTABLE;
  if (configured?.trim()) return configured.trim();
  const local = path.join(os.homedir(), '.local', 'bin', 'agent');
  return fs.existsSync(local) ? local : 'agent';
}

/** This client owns only the process it starts. It never attaches to or signals a TUI. */
export class CursorAcpClient {
  private sequence = 0;
  private pending = new Map<number, {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer?: ReturnType<typeof setTimeout>;
  }>();
  private listeners = new Set<(message: CursorAcpMessage) => void>();
  private disconnectListeners = new Set<(error: Error) => void>();
  private failure?: Error;
  private buffer = '';
  private closing?: Promise<void>;
  private readonly exited: Promise<void>;
  private didExit = false;

  private constructor(private child: ChildProcessWithoutNullStreams, private requestTimeoutMs: number) {
    this.exited = new Promise<void>(resolve => {
      child.once('exit', () => { this.didExit = true; resolve(); });
      child.once('error', () => { if (!child.pid) { this.didExit = true; resolve(); } });
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.receive(chunk));
    // Drain stderr without mixing diagnostic output (which may contain credentials) into JSON-RPC.
    child.stderr.resume();
    child.on('error', error => this.disconnect(new Error(`Cursor ACP 启动失败：${error.message}`)));
    child.on('exit', (code, signal) => this.disconnect(new Error(`Cursor ACP 进程已退出（code=${code}, signal=${signal || 'none'}）。`)));
    child.stdin.on('error', () => this.disconnect(new Error('Cursor ACP 输入通道已关闭。')));
  }

  static async start(options: CursorAcpClientOptions): Promise<CursorAcpClient> {
    const child = spawn(options.executable || executable(), options.args || ['acp'], {
      cwd: options.cwd, env: options.env || process.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    const client = new CursorAcpClient(child, options.requestTimeoutMs ?? 30_000);
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    return client;
  }

  get connected(): boolean { return !this.failure; }

  request<T = unknown>(method: string, params: unknown = {}, timeoutMs = this.requestTimeoutMs): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Cursor ACP 请求超时：${method}`));
      }, timeoutMs) : undefined;
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
      try { this.send({ id, method, params }); } catch (error) {
        if (timer) clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method: string, params: unknown = {}): void { this.send({ method, params }); }
  respond(id: string | number, result: unknown): void { this.send({ id, result }); }
  reject(id: string | number, code: number, message: string): void { this.send({ id, error: { code, message } }); }

  onMessage(listener: (message: CursorAcpMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onDisconnect(listener: (error: Error) => void): () => void {
    this.disconnectListeners.add(listener);
    if (this.failure) queueMicrotask(() => { if (this.disconnectListeners.has(listener)) listener(this.failure!); });
    return () => this.disconnectListeners.delete(listener);
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.disconnect(new Error('Cursor ACP 连接已关闭。'));
    this.closing = (async () => {
      this.child.stdin.end();
      if (this.didExit) return;
      this.child.kill('SIGTERM');
      if (await this.waitForExit(2_000)) return;
      this.child.kill('SIGKILL');
      if (!await this.waitForExit(2_000)) throw new Error('Cursor ACP 进程退出尚未确认，不能启动另一个执行者。');
    })();
    return this.closing;
  }

  private async waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.didExit) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([this.exited.then(() => true), new Promise<boolean>(resolve => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }

  private send(message: CursorAcpMessage): void {
    if (this.failure) throw this.failure;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  }

  private receive(chunk: string): void {
    if (this.failure) return;
    this.buffer += chunk;
    // Tool diffs can be large; an unbounded unterminated line must not exhaust bridge memory.
    if (this.buffer.length > 32 * 1024 * 1024) {
      this.disconnect(new Error('Cursor ACP 返回了超过 32 MiB 的未处理消息。')); void this.close().catch(() => {}); return;
    }
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message: CursorAcpMessage;
      try { message = JSON.parse(line); } catch {
        this.disconnect(new Error('Cursor ACP 输出不是有效的 JSON-RPC 消息。')); void this.close().catch(() => {}); return;
      }
      if (!message || typeof message !== 'object') continue;
      if (typeof message.id === 'number' && !message.method) {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        if (pending.timer) clearTimeout(pending.timer);
        if (message.error) pending.reject(new CursorAcpRpcError(message.error.code, message.error.message, message.error.data));
        else pending.resolve(message.result);
      } else {
        for (const listener of this.listeners) listener(message);
      }
    }
  }

  private disconnect(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const listener of this.disconnectListeners) listener(error);
  }
}
