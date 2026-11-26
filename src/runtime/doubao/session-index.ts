import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { AcpClient } from '../acp/client.js';
import { resolveDoubaoExecutable } from './models.js';

export interface DoubaoSessionSummary {
  sessionId: string;
  cwd: string;
  title: string;
  firstSeenAt: string;
  lastEventAt: string;
  source: 'doubao';
  originator: 'Doubao CLI';
  activeEstimate: boolean;
}

const SESSION_LIST_TTL_MS = 15_000;
let cachedSessions: { expiresAt: number; key: string; sessions: DoubaoSessionSummary[] } | null = null;
let inflightList: Promise<DoubaoSessionSummary[]> | null = null;

export function clearDoubaoSessionListCacheForTests(): void {
  cachedSessions = null;
  inflightList = null;
}

export function seedDoubaoSessionListCacheForTests(sessions: DoubaoSessionSummary[], ttlMs = SESSION_LIST_TTL_MS): void {
  cachedSessions = {
    key: `${resolveDoubaoExecutable()}|`,
    sessions: [...sessions].sort((a, b) => b.lastEventAt.localeCompare(a.lastEventAt)),
    expiresAt: Date.now() + ttlMs,
  };
}

export function getCachedDoubaoSessions(limit?: number): DoubaoSessionSummary[] {
  const list = cachedSessions?.sessions || [];
  if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) {
    return list.slice(0, Math.floor(limit));
  }
  return [...list];
}

export function findCachedDoubaoSessionById(sessionId: string, cwd?: string): DoubaoSessionSummary | null {
  const normalized = sessionId.trim();
  if (!normalized) return null;
  const list = cachedSessions?.sessions || [];
  return list.find((item) => item.sessionId === normalized && (!cwd || item.cwd === cwd))
    || list.find((item) => item.sessionId === normalized)
    || null;
}

function resolveNumericDoubaoDeleteId(
  sessionId: string,
  executable: string,
  env: NodeJS.ProcessEnv,
): string | null {
  const normalized = sessionId.trim();
  if (!normalized) return null;
  if (/^\d+$/u.test(normalized)) return normalized;
  const prefixed = normalized.match(/^conversation-(\d+)$/iu);
  if (prefixed?.[1]) return prefixed[1];

  // ACP session/new returns a local UUID while `doubao delete` requires the numeric cloud session_id.
  // Resolve via cached ACP summary (cwd + updatedAt/title) against `doubao --list --limit 50 --json`.
  const cached = cachedSessions?.sessions.find((item) => item.sessionId === normalized);
  if (!cached) return null;
  try {
    const out = execFileSync(executable, ['--list', '--limit', '50', '--json'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 20_000,
      env,
    });
    const lines = out.replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i]!.startsWith('{')) continue;
      const parsed = JSON.parse(lines[i]!) as { result?: { sessions?: Array<Record<string, unknown>> } };
      const list = parsed?.result?.sessions;
      if (!Array.isArray(list)) continue;
      const byCwdAndTime = list.find((entry) => (
        typeof entry.session_id === 'string'
        && /^\d+$/u.test(entry.session_id)
        && (!cached.cwd || entry.cwd === cached.cwd)
        && (
          (cached.lastEventAt && typeof entry.updated_at === 'string'
            && Math.abs(Date.parse(entry.updated_at) - Date.parse(cached.lastEventAt)) <= 5_000)
          || (cached.title && entry.title === cached.title)
        )
      ));
      if (byCwdAndTime && typeof byCwdAndTime.session_id === 'string') return byCwdAndTime.session_id;
      const byCwdOnly = cached.cwd
        ? list.filter((entry) => typeof entry.session_id === 'string' && /^\d+$/u.test(entry.session_id) && entry.cwd === cached.cwd)
        : [];
      if (byCwdOnly.length === 1 && typeof byCwdOnly[0]!.session_id === 'string') {
        return byCwdOnly[0]!.session_id;
      }
      break;
    }
  } catch {
    return null;
  }
  return null;
}

export function archiveDoubaoSession(
  sessionId: string,
  options: { executable?: string; env?: NodeJS.ProcessEnv } = {},
): boolean {
  const normalized = sessionId.trim();
  if (!normalized) return false;
  try {
    const env = options.env || process.env;
    const executable = options.executable || resolveDoubaoExecutable(env);
    const deleteId = resolveNumericDoubaoDeleteId(normalized, executable, env) || normalized;
    execFileSync(executable, ['delete', deleteId, '--yes'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 20_000,
      env,
    });
    if (cachedSessions) {
      cachedSessions = {
        ...cachedSessions,
        sessions: cachedSessions.sessions.filter((item) => item.sessionId !== normalized && item.sessionId !== `conversation-${deleteId}`),
      };
    }
    return true;
  } catch {
    return false;
  }
}

export function parseDoubaoAcpSessionList(result: unknown): DoubaoSessionSummary[] {
  const raw = result && typeof result === 'object' && Array.isArray((result as { sessions?: unknown[] }).sessions)
    ? (result as { sessions: Array<Record<string, unknown>> }).sessions
    : [];
  const items: DoubaoSessionSummary[] = [];
  for (const entry of raw) {
    const sessionId = typeof entry?.sessionId === 'string' ? entry.sessionId.trim() : '';
    if (!sessionId) continue;
    const cwd = typeof entry.cwd === 'string' && entry.cwd.trim() ? entry.cwd.trim() : os.homedir();
    const updatedAt = typeof entry.updatedAt === 'string' && entry.updatedAt.trim()
      ? entry.updatedAt.trim()
      : new Date().toISOString();
    const title = typeof entry.title === 'string' && entry.title.trim()
      ? entry.title.trim()
      : `Doubao ${sessionId.slice(0, 8)}`;
    items.push({
      sessionId,
      cwd,
      title,
      firstSeenAt: updatedAt,
      lastEventAt: updatedAt,
      source: 'doubao',
      originator: 'Doubao CLI',
      activeEstimate: false,
    });
  }
  return items.sort((a, b) => b.lastEventAt.localeCompare(a.lastEventAt));
}

export async function listDoubaoSessions(options: {
  executable?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  forceRefresh?: boolean;
} = {}): Promise<DoubaoSessionSummary[]> {
  const executable = options.executable || resolveDoubaoExecutable(options.env);
  const key = `${executable}|${options.cwd || ''}`;
  if (!options.forceRefresh && cachedSessions && cachedSessions.key === key && cachedSessions.expiresAt > Date.now()) {
    return cachedSessions.sessions;
  }
  if (inflightList && !options.forceRefresh) return inflightList;

  const task = (async () => {
    let client: AcpClient | undefined;
    try {
      const timeoutMs = options.timeoutMs ?? 20_000;
      const launchCwd = options.cwd || os.homedir();
      client = await AcpClient.start({
        executable,
        args: ['acp', 'serve', '-C', launchCwd],
        cwd: launchCwd,
        env: options.env,
        requestTimeoutMs: timeoutMs,
        label: 'Doubao ACP',
        stdinPipe: true,
      });
      await client.request('initialize', {
        protocolVersion: 1,
        clientInfo: { name: 'codelark', version: '0.5.1' },
        clientCapabilities: {},
      }, timeoutMs);
      const listResult = await client.request('session/list', {}, timeoutMs);
      const allSessions = parseDoubaoAcpSessionList(listResult);
      const sessions = options.cwd
        ? allSessions.filter((item) => !item.cwd || item.cwd === options.cwd)
        : allSessions;
      cachedSessions = { key, sessions, expiresAt: Date.now() + SESSION_LIST_TTL_MS };
      return sessions;
    } catch {
      return cachedSessions?.key === key ? cachedSessions.sessions : [];
    } finally {
      if (client) await client.close().catch(() => {});
    }
  })();

  inflightList = task;
  try {
    return await task;
  } finally {
    if (inflightList === task) inflightList = null;
  }
}

export async function findDoubaoSessionById(
  sessionId: string,
  options: { executable?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<DoubaoSessionSummary | null> {
  const normalized = sessionId.trim();
  if (!normalized) return null;
  const sessions = await listDoubaoSessions(options);
  return sessions.find((item) => item.sessionId === normalized) || null;
}
