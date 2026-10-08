import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const DESKTOP_BRIDGE_PROTOCOL_VERSION = 1;
const MAX_DISCOVERY_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;

interface CursorDesktopDiscovery {
  protocolVersion: number;
  pid: number;
  socketPath: string;
  token: string;
  appName: string;
  appVersion: string;
  userDataDir: string;
  createdAt: number;
}

interface CursorDesktopInstance {
  discovery: CursorDesktopDiscovery;
  label: string;
}

export interface CursorDesktopThread {
  id: string;
  title: string;
  source: 'local' | 'cloud' | 'draft' | 'claude-code';
  status: 'idle' | 'running' | 'completed' | 'error' | 'unknown';
  lastUpdatedAt: number;
  windowId: number;
}

export interface CursorDesktopSendResult {
  status: 'submitted' | 'queued';
  threadId: string;
  windowId: number;
  threadTitle: string;
}

type RawSendResult = CursorDesktopSendResult
  | { status: 'unknown-thread' | 'timeout' }
  | { status: 'not-sendable'; reason: string }
  | { status: 'error'; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function desktopBridgeDirectory(): string {
  const configured = process.env.CURSOR_DESKTOP_BRIDGE_DIR?.trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), '.cursor', 'desktop-bridge');
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function hasPrivateMode(stat: fs.Stats, expectedOwner = typeof process.getuid === 'function' ? process.getuid() : undefined): boolean {
  if (process.platform === 'win32') return true;
  return (expectedOwner === undefined || stat.uid === expectedOwner) && (stat.mode & 0o077) === 0;
}

function parseDiscovery(value: unknown): CursorDesktopDiscovery | null {
  if (!isRecord(value)) return null;
  if (
    value.protocolVersion !== DESKTOP_BRIDGE_PROTOCOL_VERSION
    || !Number.isInteger(value.pid)
    || Number(value.pid) <= 0
    || !isNonEmptyString(value.socketPath)
    || typeof value.token !== 'string'
    || !/^[0-9a-f]{64}$/i.test(value.token)
    || !isNonEmptyString(value.appName)
    || !isNonEmptyString(value.appVersion)
    || !isNonEmptyString(value.userDataDir)
    || typeof value.createdAt !== 'number'
    || !Number.isFinite(value.createdAt)
  ) return null;
  return value as unknown as CursorDesktopDiscovery;
}

function readLiveDesktopInstances(): CursorDesktopInstance[] {
  const directory = desktopBridgeDirectory();
  let directoryStat: fs.Stats;
  try {
    directoryStat = fs.statSync(directory);
  } catch {
    return [];
  }
  if (!directoryStat.isDirectory() || !hasPrivateMode(directoryStat)) {
    throw new Error(`Cursor Desktop Bridge discovery 目录权限不安全：${directory}`);
  }
  const instances: CursorDesktopInstance[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const discoveryPath = path.join(directory, entry.name);
    try {
      const stat = fs.statSync(discoveryPath);
      if (!hasPrivateMode(stat) || stat.size <= 0 || stat.size > MAX_DISCOVERY_BYTES) continue;
      const discovery = parseDiscovery(JSON.parse(fs.readFileSync(discoveryPath, 'utf8')));
      if (!discovery || !processIsAlive(discovery.pid)) continue;
      if (process.platform !== 'win32') {
        const socketStat = fs.statSync(discovery.socketPath);
        if (!socketStat.isSocket()) continue;
      }
      instances.push({ discovery, label: `${discovery.appName} ${discovery.appVersion}` });
    } catch {
      // Ignore stale, partial, or untrusted discovery files. If none remain,
      // callers receive one explicit unavailable error and never fall back.
    }
  }
  return instances.sort((left, right) => right.discovery.createdAt - left.discovery.createdAt);
}

function postBridge(instance: CursorDesktopInstance, payload: Record<string, unknown>): Promise<unknown> {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const request = http.request({
      socketPath: instance.discovery.socketPath,
      path: '/',
      method: 'POST',
      headers: {
        authorization: `Bearer ${instance.discovery.token}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      response.on('error', reject);
      response.on('end', () => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          reject(new Error(`${instance.label} Desktop Bridge 返回了无效 JSON。`));
          return;
        }
        if ((response.statusCode || 500) !== 200) {
          const detail = isRecord(parsed) && typeof parsed.error === 'string' ? `：${parsed.error}` : '';
          reject(new Error(`${instance.label} Desktop Bridge HTTP ${response.statusCode || 500}${detail}`));
          return;
        }
        resolve(parsed);
      });
    });
    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error(`${instance.label} Desktop Bridge 请求超时；消息可能已提交，请先检查 Cursor，避免重复发送。`));
    });
    request.on('error', reject);
    request.end(body);
  });
}

function parseThread(value: unknown): CursorDesktopThread | null {
  if (!isRecord(value)) return null;
  const sources = ['local', 'cloud', 'draft', 'claude-code'] as const;
  const statuses = ['idle', 'running', 'completed', 'error', 'unknown'] as const;
  if (
    !isNonEmptyString(value.id)
    || typeof value.title !== 'string'
    || !sources.includes(value.source as typeof sources[number])
    || !statuses.includes(value.status as typeof statuses[number])
    || typeof value.lastUpdatedAt !== 'number'
    || !Number.isInteger(value.windowId)
  ) return null;
  return value as unknown as CursorDesktopThread;
}

async function listInstanceThreads(instance: CursorDesktopInstance): Promise<CursorDesktopThread[]> {
  const response = await postBridge(instance, { type: 'listThreads' });
  if (!isRecord(response) || !Array.isArray(response.threads)) {
    throw new Error(`${instance.label} Desktop Bridge 返回了无效 thread 列表。`);
  }
  return response.threads.map(parseThread).filter((thread): thread is CursorDesktopThread => Boolean(thread));
}

export async function listCursorDesktopThreads(): Promise<CursorDesktopThread[]> {
  const instances = readLiveDesktopInstances();
  if (instances.length === 0) {
    throw new Error('Cursor Desktop Bridge 不可用：请确认 Cursor 已打开，并启用 “Allow CLI to access desktop agents”。');
  }
  const results = await Promise.allSettled(instances.map(listInstanceThreads));
  const threads = results.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
  if (threads.length === 0 && results.every((result) => result.status === 'rejected')) {
    throw new Error('所有 Cursor Desktop Bridge 实例都无法读取 thread；请重启 Cursor 后重试。');
  }
  const deduplicated = new Map<string, CursorDesktopThread>();
  for (const thread of threads.sort((left, right) => right.lastUpdatedAt - left.lastUpdatedAt)) {
    if (!deduplicated.has(thread.id)) deduplicated.set(thread.id, thread);
  }
  return [...deduplicated.values()];
}

function parseSendResult(value: unknown): RawSendResult | null {
  if (!isRecord(value) || typeof value.status !== 'string') return null;
  if (value.status === 'submitted' || value.status === 'queued') {
    return isNonEmptyString(value.threadId)
      && Number.isInteger(value.windowId)
      && typeof value.threadTitle === 'string'
      ? value as unknown as CursorDesktopSendResult
      : null;
  }
  if (value.status === 'unknown-thread' || value.status === 'timeout') return { status: value.status };
  if (value.status === 'not-sendable' && typeof value.reason === 'string') return { status: value.status, reason: value.reason };
  if (value.status === 'error' && typeof value.message === 'string') return { status: value.status, message: value.message };
  return null;
}

export async function sendCursorDesktopMessage(
  threadId: string,
  text: string,
  options: { force?: boolean } = {},
): Promise<CursorDesktopSendResult> {
  const normalizedThreadId = threadId.trim().toLowerCase();
  if (!normalizedThreadId || !text) throw new Error('Cursor Desktop thread ID 和消息正文不能为空。');
  const instances = readLiveDesktopInstances();
  if (instances.length === 0) {
    throw new Error('Cursor Desktop Bridge 不可用：不会降级到 tmux，以免写入另一条会话。');
  }
  const candidates: Array<{ instance: CursorDesktopInstance; thread: CursorDesktopThread }> = [];
  for (const instance of instances) {
    try {
      for (const thread of await listInstanceThreads(instance)) {
        if (thread.id.toLowerCase() === normalizedThreadId) candidates.push({ instance, thread });
      }
    } catch {
      // Try another live instance; failure is surfaced if no exact target remains.
    }
  }
  candidates.sort((left, right) => right.thread.lastUpdatedAt - left.thread.lastUpdatedAt);
  const target = candidates[0];
  if (!target) {
    throw new Error(`Cursor Desktop 当前没有 thread ${threadId}；不会降级到 tmux。请在 Cursor 中打开该对话后重试。`);
  }
  const response = parseSendResult(await postBridge(target.instance, {
    type: 'sendMessage',
    threadId: target.thread.id,
    text,
    force: options.force === true,
  }));
  if (!response) throw new Error(`${target.instance.label} Desktop Bridge 返回了无效发送结果。`);
  if (response.status === 'submitted' || response.status === 'queued') return response;
  if (response.status === 'timeout') {
    throw new Error('Cursor Desktop 未及时确认消息；消息可能已提交，请先检查 Cursor，避免重复发送。');
  }
  if (response.status === 'unknown-thread') throw new Error('Cursor Desktop 在发送前丢失了目标 thread；请重新打开对话后重试。');
  if (response.status === 'not-sendable') throw new Error(`Cursor Desktop 当前不能接收该消息：${response.reason}`);
  if (response.status === 'error') throw new Error(`Cursor Desktop 发送失败：${response.message}`);
  throw new Error('Cursor Desktop 返回了无法识别的发送状态。');
}
