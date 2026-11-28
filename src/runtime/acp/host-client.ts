import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODELARK_HOME } from '../../configuration/paths.js';
import { AcpRpcError } from './client.js';
import {
  ACP_HOST_PROTOCOL_VERSION,
  acpHostEndpoint,
  type AcpCardCheckpoint,
  type AcpHostHelloResult,
  type AcpHostPushEnvelope,
  type AcpHostRequestEnvelope,
  type AcpHostResponseEnvelope,
  type AcpSessionEnsureParams,
  type AcpSessionEnsureResult,
  type AcpSessionRpcParams,
  type AcpSessionRpcResult,
  type AcpSessionSnapshot,
  type AcpTurnCancelParams,
  type AcpTurnEvent,
  type AcpTurnMeta,
  type AcpTurnRespondParams,
  type AcpTurnSnapshot,
  type AcpTurnStartParams,
  type AcpTurnStartResult,
  type AcpTurnSubscribeParams,
  type AcpTurnSubscribeResult,
} from './host-protocol.js';

function resolveAcpHostEntrypoint(): { command: string; args: string[]; codeHash: string } {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, 'acp-host.mjs'),
    path.resolve(here, '..', '..', '..', 'dist', 'acp-host.mjs'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      const stat = fs.statSync(candidate);
      const hash = createHash('sha256')
        .update(candidate)
        .update(':')
        .update(String(stat.size))
        .update(':')
        .update(String(Math.floor(stat.mtimeMs)))
        .digest('hex')
        .slice(0, 16);
      return { command: process.execPath, args: [candidate], codeHash: hash };
    }
  }
  // Dev/tsx fallback when running directly from src/ without dist/
  const tsEntry = path.resolve(here, '..', '..', 'entrypoints', 'acp-host.ts');
  const hash = createHash('sha256').update(tsEntry).digest('hex').slice(0, 16);
  const tsxBin = path.resolve(here, '..', '..', '..', 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
  if (fs.existsSync(tsxBin)) {
    return { command: tsxBin, args: [tsEntry], codeHash: hash };
  }
  return { command: process.execPath, args: ['--import', 'tsx', tsEntry], codeHash: hash };
}

function connectSocket(socketPath: string, timeoutMs = 2_000): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`连接 ACP Host 超时：${socketPath}`));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    });
  });
}

export class AcpHostClient {
  private sequence = 0;
  private pending = new Map<number, {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer?: ReturnType<typeof setTimeout>;
  }>();
  private turnListeners = new Map<string, Set<(item: AcpTurnEvent) => void>>();
  private sessionStateListeners = new Set<(session: AcpSessionSnapshot) => void>();
  private disconnectListeners = new Set<(error: Error) => void>();
  private sessionCache = new Map<string, AcpSessionSnapshot>();
  private buffer = '';
  private failure?: Error;

  constructor(private readonly socket: net.Socket, readonly socketPath: string) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.receive(chunk));
    socket.on('error', (error) => this.handleDisconnect(error instanceof Error ? error : new Error(String(error))));
    socket.on('close', () => this.handleDisconnect(new Error('ACP Host 连接已关闭。')));
  }

  get connected(): boolean {
    return !this.failure && !this.socket.destroyed;
  }

  getCachedSession(sessionKey: string): AcpSessionSnapshot | undefined {
    return this.sessionCache.get(sessionKey);
  }

  onSessionState(listener: (session: AcpSessionSnapshot) => void): () => void {
    this.sessionStateListeners.add(listener);
    return () => this.sessionStateListeners.delete(listener);
  }

  onTurnEvent(turnId: string, listener: (item: AcpTurnEvent) => void): () => void {
    let set = this.turnListeners.get(turnId);
    if (!set) {
      set = new Set();
      this.turnListeners.set(turnId, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
      if (set && set.size === 0) this.turnListeners.delete(turnId);
    };
  }

  onDisconnect(listener: (error: Error) => void): () => void {
    this.disconnectListeners.add(listener);
    if (this.failure) queueMicrotask(() => { if (this.disconnectListeners.has(listener)) listener(this.failure!); });
    return () => this.disconnectListeners.delete(listener);
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = 30_000): Promise<T> {
    if (this.failure || this.socket.destroyed) {
      return Promise.reject(this.failure || new Error('ACP Host 连接已关闭。'));
    }
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`ACP Host 请求超时：${method}`));
        }, timeoutMs)
        : undefined;
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      const payload: AcpHostRequestEnvelope = { id, method, ...(params !== undefined ? { params } : {}) };
      try {
        this.socket.write(`${JSON.stringify(payload)}\n`);
      } catch (error) {
        if (timer) clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  hello(): Promise<AcpHostHelloResult> {
    return this.request<AcpHostHelloResult>('host/hello', undefined, 5_000);
  }

  shutdownHost(force = false): Promise<{ ok: boolean; activeTurnCount?: number; unackedTurnCount?: number }> {
    return this.request('host/shutdown', { force }, 10_000);
  }

  async ensureSession(params: AcpSessionEnsureParams): Promise<AcpSessionEnsureResult> {
    const result = await this.request<AcpSessionEnsureResult>('session/ensure', params, 150_000);
    this.sessionCache.set(result.session.sessionKey, result.session);
    return result;
  }

  async sessionRpc(params: AcpSessionRpcParams): Promise<AcpSessionRpcResult> {
    const result = await this.request<AcpSessionRpcResult>('session/rpc', params, params.timeoutMs ?? 30_000);
    this.sessionCache.set(result.session.sessionKey, result.session);
    return result;
  }

  async getSessionStatus(sessionKey: string): Promise<AcpSessionSnapshot | null> {
    const res = await this.request<{ session: AcpSessionSnapshot | null }>('session/status', { sessionKey }, 5_000);
    if (res.session) this.sessionCache.set(res.session.sessionKey, res.session);
    else this.sessionCache.delete(sessionKey);
    return res.session;
  }

  async listSessions(): Promise<AcpSessionSnapshot[]> {
    const res = await this.request<{ sessions: AcpSessionSnapshot[] }>('session/list', undefined, 5_000);
    this.sessionCache.clear();
    for (const session of res.sessions) this.sessionCache.set(session.sessionKey, session);
    return res.sessions;
  }

  async closeSession(sessionKey: string): Promise<{ closed: boolean }> {
    const res = await this.request<{ closed: boolean }>('session/close', { sessionKey }, 25_000);
    this.sessionCache.delete(sessionKey);
    return res;
  }

  startTurn(params: AcpTurnStartParams): Promise<AcpTurnStartResult> {
    return this.request<AcpTurnStartResult>('turn/start', params, 30_000);
  }

  subscribeTurn(params: AcpTurnSubscribeParams): Promise<AcpTurnSubscribeResult> {
    return this.request<AcpTurnSubscribeResult>('turn/subscribe', params, 15_000);
  }

  unsubscribeTurn(turnId: string): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>('turn/unsubscribe', { turnId }, 5_000).catch(() => ({ ok: false }));
  }

  respondTurnRequest(params: AcpTurnRespondParams): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>('turn/respond', params, 10_000);
  }

  cancelTurn(params: AcpTurnCancelParams): Promise<{ cancelled: boolean; turn?: AcpTurnSnapshot }> {
    return this.request('turn/cancel', params, (params.cancelTimeoutMs ?? 15_000) + 5_000);
  }

  updateTurnMeta(turnId: string, update: { card?: AcpCardCheckpoint; metaPatch?: Partial<Omit<AcpTurnMeta, 'runtime' | 'bridgeSessionId'>> }): Promise<{ ok: boolean; turn?: AcpTurnSnapshot }> {
    return this.request('turn/update_meta', { turnId, ...update }, 5_000);
  }

  async listUnackedTurns(): Promise<AcpTurnSnapshot[]> {
    const res = await this.request<{ turns: AcpTurnSnapshot[] }>('turn/list_unacked', undefined, 10_000);
    return res.turns;
  }

  async getTurn(turnId: string): Promise<AcpTurnSnapshot | null> {
    const res = await this.request<{ turn: AcpTurnSnapshot | null }>('turn/get', { turnId }, 5_000);
    return res.turn;
  }

  ackTurn(turnId: string): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>('turn/ack', { turnId }, 5_000);
  }

  /** Detach this bridge socket without terminating acp-host or any running ACP turns. */
  detach(): void {
    this.handleDisconnect(new Error('Bridge detached from ACP Host.'));
    try {
      this.socket.destroy();
    } catch {
      // ignore
    }
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (typeof frame.id === 'number') {
        const resp = frame as unknown as AcpHostResponseEnvelope;
        const pending = this.pending.get(resp.id);
        if (!pending) continue;
        this.pending.delete(resp.id);
        if (pending.timer) clearTimeout(pending.timer);
        if (resp.error) {
          pending.reject(new AcpRpcError(resp.error.code, resp.error.message, resp.error.data, 'ACP Host'));
        } else {
          pending.resolve(resp.result);
        }
      } else if (typeof frame.event === 'string') {
        const push = frame as unknown as AcpHostPushEnvelope;
        if (push.event === 'session/state' && push.session) {
          this.sessionCache.set(push.session.sessionKey, push.session);
          for (const listener of this.sessionStateListeners) listener(push.session);
        } else if (push.event === 'turn/event' && push.turnId && push.item) {
          const listeners = this.turnListeners.get(push.turnId);
          if (listeners) {
            for (const listener of listeners) listener(push.item);
          }
        }
      }
    }
  }

  private handleDisconnect(error: Error): void {
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

export async function connectAcpHostAt(socketPath: string, timeoutMs = 2_000): Promise<AcpHostClient> {
  const socket = await connectSocket(socketPath, timeoutMs);
  const client = new AcpHostClient(socket, socketPath);
  await client.hello();
  await client.listSessions().catch(() => {});
  return client;
}

let sharedClient: AcpHostClient | null = null;
let sharedConnecting: Promise<AcpHostClient> | null = null;

function currentHome(): string {
  return process.env.CODELARK_HOME || CODELARK_HOME;
}

function buildHostChildEnv(home: string, socketPath: string, codeHash: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_OPTIONS;
  env.CODELARK_HOME = home;
  env.CODELARK_ACP_HOST_SOCKET = socketPath;
  env.CODELARK_ACP_HOST_CODE_HASH = codeHash;
  return env;
}

async function spawnDetachedAcpHost(home: string, socketPath: string): Promise<AcpHostClient> {
  const entry = resolveAcpHostEntrypoint();
  const logsDir = path.join(home, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const logPath = path.join(logsDir, 'acp-host.log');
  const logFd = fs.openSync(logPath, 'a');
  try {
    const child = spawn(entry.command, entry.args, {
      cwd: os.homedir(),
      detached: true,
      env: buildHostChildEnv(home, socketPath, entry.codeHash),
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
    });
    child.unref();
  } finally {
    fs.closeSync(logFd);
  }

  const deadline = Date.now() + 10_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await connectAcpHostAt(socketPath, 1_000);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`启动独立 ACP Host 失败：${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

/**
 * Connect to an already-running ACP Host without spawning one.
 * Used at Bridge startup to check for active/unacked turns to re-attach.
 */
export async function tryConnectExistingAcpHost(home = currentHome()): Promise<AcpHostClient | null> {
  if (sharedClient?.connected) return sharedClient;
  const socketPath = acpHostEndpoint(home);
  try {
    const client = await connectAcpHostAt(socketPath, 1_500);
    sharedClient = client;
    client.onDisconnect(() => {
      if (sharedClient === client) sharedClient = null;
    });
    return client;
  } catch {
    return null;
  }
}

/**
 * Get or lazily spawn the detached persistent ACP Host for this CODELARK_HOME.
 * If an idle host is running an older build, transparently upgrades it; if active
 * or unacked turns exist, stays seamlessly connected without interrupting them.
 */
export async function getSharedAcpHostClient(home = currentHome()): Promise<AcpHostClient> {
  if (sharedConnecting) return sharedConnecting;

  sharedConnecting = (async () => {
    const socketPath = acpHostEndpoint(home);
    const entry = resolveAcpHostEntrypoint();
    try {
      const existing = sharedClient?.connected ? sharedClient : await connectAcpHostAt(socketPath, 1_500);
      const hello = await existing.hello();
      if (
        hello.protocolVersion === ACP_HOST_PROTOCOL_VERSION
        && (hello.codeHash === entry.codeHash || hello.activeTurnCount > 0 || hello.unackedTurnCount > 0)
      ) {
        if (sharedClient !== existing) {
          sharedClient = existing;
          existing.onDisconnect(() => {
            if (sharedClient === existing) sharedClient = null;
          });
        }
        return existing;
      }
      // Host is idle and outdated; recycle cleanly to pick up the new acp-host build.
      const shut = await existing.shutdownHost(false).catch(() => ({ ok: false }));
      if (!shut.ok) {
        if (sharedClient !== existing) {
          sharedClient = existing;
          existing.onDisconnect(() => {
            if (sharedClient === existing) sharedClient = null;
          });
        }
        return existing;
      }
      existing.detach();
      await new Promise((resolve) => setTimeout(resolve, 150));
    } catch {
      // Host is not running yet (or stale socket); spawn fresh detached host below.
    }

    const client = await spawnDetachedAcpHost(home, socketPath);
    sharedClient = client;
    client.onDisconnect(() => {
      if (sharedClient === client) sharedClient = null;
    });
    return client;
  })();

  try {
    return await sharedConnecting;
  } finally {
    sharedConnecting = null;
  }
}

export function peekSharedAcpHostClient(): AcpHostClient | null {
  return sharedClient?.connected ? sharedClient : null;
}

/** Disconnect Bridge from ACP Host without cancelling or killing live ACP turns. */
export function detachSharedAcpHostClient(): void {
  const client = sharedClient;
  sharedClient = null;
  client?.detach();
}
