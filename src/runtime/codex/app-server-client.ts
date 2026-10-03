import WebSocket from 'ws';

export interface AppServerMessage {
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** A server rejection is definitive; a lost reply or timeout is not. */
export class AppServerRpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(`app-server (${code}): ${message}`);
  }
}

export function isUnsupportedAppServerMethod(error: unknown, method?: string): boolean {
  return error instanceof AppServerRpcError && (error.code === -32601
    || (error.code === -32600 && !!method
      && error.message.startsWith(`app-server (-32600): Invalid request: unknown variant \`${method}\`, expected `)));
}

function unixSocketPath(endpoint: string): string | undefined {
  if (!endpoint.startsWith('unix://') && !endpoint.startsWith('ws+unix://')) return undefined;
  const url = new URL(endpoint);
  if (!['', 'localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.port || url.search || url.hash) {
    throw new Error('Codex Unix socket 地址不是本机地址或包含不支持的 URL 字段。');
  }
  const socket = url.pathname.split(':')[0]!;
  if (!socket.startsWith('/') || socket === '/') throw new Error('Codex Unix socket 必须使用绝对文件路径。');
  return socket;
}

/** Desktop's transport selector needs a local hostname even for ws's Unix transport. */
export function appServerWebSocketUrl(endpoint: string): string {
  const socket = unixSocketPath(endpoint);
  return socket ? `ws+unix://localhost${socket}:/` : endpoint;
}

export function appServerCliUrl(endpoint: string): string {
  const socket = unixSocketPath(endpoint);
  return socket ? `unix://${socket}` : endpoint;
}

/** A connection owns subscriptions, never the server process or its thread writer locks. */
export class CodexAppServerClient {
  serverInfo: { codexHome?: string; userAgent?: string } = {};
  private sequence = 0;
  private pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private listeners = new Set<(message: AppServerMessage) => void>();
  private disconnectListeners = new Set<(error: Error) => void>();
  private disconnected = false;

  private constructor(private socket: WebSocket, private timeoutMs: number) {
    socket.on('message', (data) => {
      let message: AppServerMessage;
      try { message = JSON.parse(data.toString()); } catch { return; }
      if (!message || typeof message !== 'object') return;
      if (typeof message.id === 'number' && !message.method) {
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error) request.reject(new AppServerRpcError(message.error.code, message.error.message, message.error.data));
        else request.resolve(message.result);
      } else {
        // Server requests (approval/input) retain their id. Consumers must explicitly reply;
        // a connection used only for readiness never accepts or denies another client's request.
        for (const listener of this.listeners) listener(message);
      }
    });
    socket.on('close', () => this.disconnect(new Error('Codex app-server disconnected')));
    socket.on('error', (error) => this.disconnect(error));
  }

  static async connect(endpoint: string, timeoutMs = 5_000): Promise<CodexAppServerClient> {
    // Older Codex Unix transports reject the permessage-deflate extension header.
    // JSON-RPC does not require compression; the common uncompressed transport works across versions.
    const socket = new WebSocket(appServerWebSocketUrl(endpoint), { handshakeTimeout: timeoutMs, perMessageDeflate: false });
    const client = new CodexAppServerClient(socket, timeoutMs);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
        socket.once('close', () => reject(new Error('Codex app-server closed before initialization')));
      });
      client.serverInfo = await client.request('initialize', {
        clientInfo: { name: 'codelark', version: '0.3.0' },
        capabilities: { experimentalApi: true },
      });
      client.send({ method: 'initialized' });
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }

  request<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      try { this.send({ id, method, params }); } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  onMessage(listener: (message: AppServerMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onDisconnect(listener: (error: Error) => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  send(message: AppServerMessage): void {
    if (this.socket.readyState !== WebSocket.OPEN) throw new Error('Codex app-server is not connected');
    this.socket.send(JSON.stringify(message));
  }

  close(): void {
    this.disconnect(new Error('Codex app-server connection closed'));
    this.listeners.clear();
    this.disconnectListeners.clear();
    this.socket.terminate();
  }

  private disconnect(error: Error): void {
    this.rejectPending(error);
    if (this.disconnected) return;
    this.disconnected = true;
    for (const listener of this.disconnectListeners) listener(error);
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }
}
