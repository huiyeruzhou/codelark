import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import type { ManualInputTargetSelector } from '../../domain/index.js';
import type { AgentMessageSource, DiscoveredBridgeSession, ManualInputRequest } from './contracts.js';

export interface BridgeServiceDescriptor {
  version: 1;
  codelarkHome: string;
  pid: number;
  runId: string;
  endpoint: string;
  token: string;
  startedAt: string;
}

export interface BridgeControlService {
  descriptor: BridgeServiceDescriptor;
  discoveryDirectory: string;
  close(): Promise<void>;
}

export interface BridgeControlHandlers {
  listSessions(query?: string): DiscoveredBridgeSession[];
  receiveInput(request: ManualInputRequest): Promise<void> | void;
}

function userKey(): string {
  let identity = `${os.homedir()}\0${os.userInfo().username}`;
  try { identity += `\0${os.userInfo().uid}`; } catch { /* Windows may not expose uid. */ }
  return crypto.createHash('sha256').update(identity).digest('hex').slice(0, 16);
}

function canonicalHome(codelarkHome: string): string {
  const resolved = path.resolve(codelarkHome);
  return process.platform === 'win32' ? resolved.toLocaleLowerCase() : resolved;
}

export function getBridgeDiscoveryDirectory(tempDirectory = os.tmpdir()): string {
  return path.join(tempDirectory, `codelark-bridge-discovery-${userKey()}`, 'v1');
}

function descriptorPath(codelarkHome: string, directory: string): string {
  const key = crypto.createHash('sha256').update(canonicalHome(codelarkHome)).digest('hex');
  return path.join(directory, `${key}.json`);
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function removeDescriptorIfStale(
  descriptor: BridgeServiceDescriptor,
  directory: string,
): void {
  if (isProcessAlive(descriptor.pid)) return;
  const filePath = descriptorPath(descriptor.codelarkHome, directory);
  try {
    const current = JSON.parse(fs.readFileSync(filePath, 'utf8')) as BridgeServiceDescriptor;
    if (current.runId === descriptor.runId) fs.rmSync(filePath, { force: true });
  } catch { /* already removed or replaced */ }
}

function writeDescriptor(filePath: string, descriptor: BridgeServiceDescriptor): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(descriptor), { encoding: 'utf8', mode: 0o600 });
  try {
    fs.renameSync(temporary, filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!fs.existsSync(filePath) || !['EEXIST', 'EPERM', 'EACCES'].includes(code || '')) {
      fs.rmSync(temporary, { force: true });
      throw error;
    }
    const backup = `${filePath}.${process.pid}.${crypto.randomUUID()}.backup`;
    try {
      fs.renameSync(filePath, backup);
      fs.renameSync(temporary, filePath);
      fs.rmSync(backup, { force: true });
    } catch (replacementError) {
      if (!fs.existsSync(filePath) && fs.existsSync(backup)) fs.renameSync(backup, filePath);
      fs.rmSync(temporary, { force: true });
      throw replacementError;
    }
  }
}

function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error('request body is too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(new Error('request body is not valid JSON')); }
    });
    request.on('error', reject);
  });
}

function respond(response: http.ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

function isManualInputRequest(value: unknown): value is ManualInputRequest {
  if (!value || typeof value !== 'object') return false;
  const request = value as Partial<ManualInputRequest>;
  const source = request.source as Partial<AgentMessageSource> | undefined;
  return typeof request.targetInternalChatId === 'string'
    && Boolean(request.targetInternalChatId.trim())
    && typeof request.text === 'string'
    && Boolean(request.text.trim())
    && Boolean(source)
    && ['codelarkHome', 'internalChatId', 'platformChatId', 'bridgeSessionId', 'chatName', 'botName']
      .every((key) => typeof source?.[key as keyof AgentMessageSource] === 'string');
}

export async function startBridgeControlService(options: {
  codelarkHome: string;
  runId: string;
  handlers: BridgeControlHandlers;
  discoveryDirectory?: string;
}): Promise<BridgeControlService> {
  const token = crypto.randomBytes(32).toString('base64url');
  const server = http.createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      respond(response, 401, { ok: false, error: 'unauthorized' });
      return;
    }
    try {
      const url = new URL(request.url || '/', 'http://127.0.0.1');
      if (request.method === 'GET' && url.pathname === '/v1/health') {
        respond(response, 200, { ok: true, runId: options.runId });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/v1/sessions') {
        respond(response, 200, { ok: true, sessions: options.handlers.listSessions(url.searchParams.get('query') || undefined) });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/input') {
        const body = await readJsonBody(request);
        if (!isManualInputRequest(body)) {
          respond(response, 400, { ok: false, error: 'invalid manual input request' });
          return;
        }
        await options.handlers.receiveInput(body);
        respond(response, 202, { ok: true, accepted: true });
        return;
      }
      respond(response, 404, { ok: false, error: 'not found' });
    } catch (error) {
      respond(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('bridge control service did not bind a TCP port');
  const descriptor: BridgeServiceDescriptor = {
    version: 1,
    codelarkHome: canonicalHome(options.codelarkHome),
    pid: process.pid,
    runId: options.runId,
    endpoint: `http://127.0.0.1:${address.port}`,
    token,
    startedAt: new Date().toISOString(),
  };
  const discoveryDirectory = options.discoveryDirectory || getBridgeDiscoveryDirectory();
  const filePath = descriptorPath(descriptor.codelarkHome, discoveryDirectory);
  writeDescriptor(filePath, descriptor);
  return {
    descriptor,
    discoveryDirectory,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try {
        const current = JSON.parse(fs.readFileSync(filePath, 'utf8')) as BridgeServiceDescriptor;
        if (current.runId === descriptor.runId) fs.rmSync(filePath, { force: true });
      } catch { /* already removed or replaced */ }
    },
  };
}

export function readBridgeServiceDescriptors(directory = getBridgeDiscoveryDirectory()): BridgeServiceDescriptor[] {
  let names: string[];
  try { names = fs.readdirSync(directory).filter((name) => name.endsWith('.json')); }
  catch { return []; }
  return names.flatMap((name) => {
    try {
      const descriptor = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')) as BridgeServiceDescriptor;
      return descriptor.version === 1 && descriptor.endpoint.startsWith('http://127.0.0.1:') ? [descriptor] : [];
    } catch { return []; }
  });
}

async function requestDescriptor<T>(
  descriptor: BridgeServiceDescriptor,
  route: string,
  init?: RequestInit,
  timeoutMs = 3_000,
): Promise<T> {
  const response = await fetch(`${descriptor.endpoint}${route}`, {
    ...init,
    headers: { ...init?.headers, authorization: `Bearer ${descriptor.token}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || `bridge control request failed (${response.status})`);
  return payload;
}

export async function discoverBridgeSessions(options: {
  query?: string;
  codelarkHome?: string;
  chatId?: string;
  chatName?: string;
  botName?: string;
  runtime?: string;
  runtimeStatus?: string;
  discoveryDirectory?: string;
} = {}): Promise<DiscoveredBridgeSession[]> {
  return (await discoverBridgeSessionsDetailed(options)).sessions;
}

async function discoverBridgeSessionsDetailed(options: {
  query?: string;
  codelarkHome?: string;
  chatId?: string;
  chatName?: string;
  botName?: string;
  runtime?: string;
  runtimeStatus?: string;
  discoveryDirectory?: string;
} = {}): Promise<{
  sessions: DiscoveredBridgeSession[];
  failures: Array<{ codelarkHome: string; error: string }>;
}> {
  const requestedHome = options.codelarkHome ? canonicalHome(options.codelarkHome) : '';
  const descriptors = readBridgeServiceDescriptors(options.discoveryDirectory)
    .filter((descriptor) => !requestedHome || canonicalHome(descriptor.codelarkHome) === requestedHome);
  const results = await Promise.all(descriptors.map(async (descriptor) => {
    try {
      const query = options.query ? `?query=${encodeURIComponent(options.query)}` : '';
      const payload = await requestDescriptor<{ sessions: DiscoveredBridgeSession[] }>(descriptor, `/v1/sessions${query}`, undefined, 500);
      return { sessions: payload.sessions, failure: null };
    } catch (error) {
      const directory = options.discoveryDirectory || getBridgeDiscoveryDirectory();
      removeDescriptorIfStale(descriptor, directory);
      return {
        sessions: [],
        failure: {
          codelarkHome: descriptor.codelarkHome,
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }));
  const exact = (actual: string | undefined, expected: string | undefined) => !expected
    || (actual || '').toLocaleLowerCase() === expected.toLocaleLowerCase();
  return {
    sessions: results.flatMap((result) => result.sessions).filter((session) => (
      (!options.chatId
        || exact(session.bridgeSessionId, options.chatId)
        || exact(session.internalChatId, options.chatId)
        || exact(session.platformChatId, options.chatId))
      && exact(session.chatName, options.chatName)
      && exact(session.agentName, options.botName)
      && exact(session.runtime, options.runtime)
      && exact(session.runtimeStatus, options.runtimeStatus)
    )),
    failures: results.flatMap((result) => result.failure ? [result.failure] : []),
  };
}

export async function deliverManualInput(options: {
  target: string | ManualInputTargetSelector;
  text: string;
  source: AgentMessageSource;
  codelarkHome?: string;
  discoveryDirectory?: string;
}): Promise<DiscoveredBridgeSession> {
  if (typeof options.target !== 'string'
    && !Object.values(options.target).some((value) => typeof value === 'string' && value.trim())) {
    throw new Error('目标筛选条件不能为空');
  }
  const legacyTarget = typeof options.target === 'string' ? options.target.trim() : '';
  const selector = typeof options.target === 'string'
    ? { query: legacyTarget, codelarkHome: options.codelarkHome }
    : {
        ...options.target,
        codelarkHome: options.target.codelarkHome || options.codelarkHome,
      };
  const discovery = await discoverBridgeSessionsDetailed({
    ...selector,
    discoveryDirectory: options.discoveryDirectory,
  });
  const candidates = discovery.sessions;
  const normalized = legacyTarget.toLocaleLowerCase();
  const legacyExact = legacyTarget
    ? candidates.filter((item) => [
        item.bridgeSessionId,
        item.internalChatId,
        item.platformChatId,
        item.chatName,
        item.agentName,
      ]
        .some((value) => value.toLocaleLowerCase() === normalized))
    : [];
  const matched = legacyExact.length > 0 ? legacyExact : candidates;
  const selectorLabel = typeof options.target === 'string'
    ? options.target
    : [
        options.target.chatId ? `目标=${options.target.chatId}` : '',
        options.target.chatName ? `群聊=${options.target.chatName}` : '',
        options.target.botName ? `Bot=${options.target.botName}` : '',
        selector.codelarkHome ? `Home=${selector.codelarkHome}` : '',
        options.target.runtime ? `Runtime=${options.target.runtime}` : '',
        options.target.runtimeStatus ? `状态=${options.target.runtimeStatus}` : '',
        options.target.query ? `关键词=${options.target.query}` : '',
      ].filter(Boolean).join('，');
  if (matched.length === 0 && discovery.failures.length > 0) {
    const detail = discovery.failures
      .map((failure) => `${failure.codelarkHome} (${failure.error})`)
      .join(', ');
    throw new Error(`目标 Bridge 暂时无法访问：${detail}`);
  }
  if (matched.length === 0) throw new Error(`没有找到目标：${selectorLabel}`);
  if (matched.length > 1) {
    const candidatesLabel = matched
      .map((item) => `${item.chatName} (${item.agentName}, target=${item.bridgeSessionId}, ${item.codelarkHome})`)
      .join('；');
    throw new Error(`目标群聊不唯一：${selectorLabel}。候选：${candidatesLabel}`);
  }
  const target = matched[0];
  const descriptor = readBridgeServiceDescriptors(options.discoveryDirectory)
    .find((item) => canonicalHome(item.codelarkHome) === canonicalHome(target.codelarkHome));
  if (!descriptor) throw new Error(`目标 Bridge 已离线：${target.codelarkHome}`);
  await requestDescriptor(descriptor, '/v1/input', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ targetInternalChatId: target.internalChatId, text: options.text, source: options.source }),
  });
  return target;
}
