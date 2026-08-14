import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

import { CODELARK_HOME } from '../../configuration/paths.js';
import type {
  BridgeMirrorRecord,
  BridgeMirrorRecordDelta,
  MirrorJsonlSource,
} from '../contracts.js';

export interface ZcodeSessionSummary {
  sessionId: string;
  dbPath: string;
  cwd: string;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
}

interface ArchivedZcodeSession {
  sessionId: string;
  cwd: string;
  archivedAt: string;
  title?: string;
}

interface ZcodeMessageData {
  role?: string;
  time?: { created?: number; completed?: number };
  error?: unknown;
  anchor?: { turnId?: string };
}

interface ZcodePartData {
  type?: string;
  text?: string;
  content?: string;
  callID?: string;
  callId?: string;
  toolCallId?: string;
  tool?: string;
  name?: string;
  state?: Record<string, unknown>;
}

interface ZcodeMessageRow {
  id: string;
  time_created: number;
  time_updated: number;
  data: string;
  sequence: number | null;
}

interface ZcodePartRow {
  id: string;
  message_id: string;
  time_created: number;
  time_updated: number;
  data: string;
  sequence: number | null;
}

interface ZcodeTurnUsageRow {
  turn_id: string;
  status: string;
  started_at: number;
  completed_at: number | null;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  computed_total_tokens: number;
  error_type: string | null;
  error_code: string | null;
}

interface ZcodeModelErrorRow {
  turn_id: string | null;
  error_message: string | null;
}

function parseJson<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function canonicalPath(value: string): string {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function expandHome(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '~') return os.homedir();
  if (trimmed.startsWith(`~${path.sep}`) || trimmed.startsWith('~/')) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return trimmed;
}

export function resolveZcodeSessionDbPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const direct = env.CODELARK_ZCODE_SESSION_DB_PATH?.trim()
    || env.ZCODE_SESSION_DB_PATH?.trim();
  if (direct) return path.resolve(expandHome(direct));
  const settingsPath = path.join(os.homedir(), '.zcode', 'cli', 'config.json');
  try {
    const config = parseJson<{ storage?: { sessionDbPath?: unknown } }>(fs.readFileSync(settingsPath, 'utf8'));
    const configured = config?.storage?.sessionDbPath;
    if (typeof configured === 'string' && configured.trim()) {
      const expanded = expandHome(configured);
      return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(path.dirname(settingsPath), expanded);
    }
  } catch {
    // The CLI owns settings validation. Session discovery simply falls back to its documented default.
  }
  return path.join(os.homedir(), '.zcode', 'cli', 'db', 'db.sqlite');
}

function archivedSessionsPath(): string {
  return path.join(CODELARK_HOME, 'data', 'archived-zcode-sessions.json');
}

function archiveKey(sessionId: string, cwd: string): string {
  return `${canonicalPath(cwd)}\0${sessionId.trim()}`;
}

function readArchivedSessions(): ArchivedZcodeSession[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(archivedSessionsPath(), 'utf8')) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is ArchivedZcodeSession => {
      if (!value || typeof value !== 'object') return false;
      const entry = value as Partial<ArchivedZcodeSession>;
      return typeof entry.sessionId === 'string'
        && typeof entry.cwd === 'string'
        && typeof entry.archivedAt === 'string';
    });
  } catch {
    return [];
  }
}

function writeArchivedSessions(entries: ArchivedZcodeSession[]): void {
  const filePath = archivedSessionsPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
}

export function archiveZcodeSession(
  session: Pick<ZcodeSessionSummary, 'sessionId' | 'cwd' | 'title'>,
): boolean {
  const sessionId = session.sessionId.trim();
  const cwd = session.cwd.trim();
  if (!sessionId || !cwd) return false;
  const entries = readArchivedSessions();
  const key = archiveKey(sessionId, cwd);
  if (entries.some((entry) => archiveKey(entry.sessionId, entry.cwd) === key)) return true;
  entries.push({
    sessionId,
    cwd,
    archivedAt: new Date().toISOString(),
    ...(session.title ? { title: session.title } : {}),
  });
  writeArchivedSessions(entries);
  return true;
}

function withReadOnlyDatabase<T>(dbPath: string, read: (db: DatabaseSync) => T): T | null {
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      return read(db);
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function timestamp(value: number | null | undefined): string {
  return new Date(typeof value === 'number' ? value : 0).toISOString();
}

export function listZcodeSessionSummaries(
  cwd?: string,
  options: { dbPath?: string; includeArchived?: boolean } = {},
): ZcodeSessionSummary[] {
  const dbPath = options.dbPath || resolveZcodeSessionDbPath();
  const rows = withReadOnlyDatabase(dbPath, (db) => db.prepare(`
    SELECT id, directory, path, title, time_created, time_updated
    FROM session
    WHERE time_archived IS NULL
    ORDER BY time_updated DESC, time_created DESC
  `).all() as Array<Record<string, SQLInputValue>>) || [];
  const requestedCwd = cwd ? canonicalPath(cwd) : '';
  const archived = options.includeArchived
    ? new Set<string>()
    : new Set(readArchivedSessions().map((entry) => archiveKey(entry.sessionId, entry.cwd)));
  return rows.flatMap((row): ZcodeSessionSummary[] => {
    const sessionId = typeof row.id === 'string' ? row.id.trim() : '';
    const rowCwd = typeof row.directory === 'string'
      ? row.directory
      : typeof row.path === 'string' ? row.path : '';
    if (!sessionId || !rowCwd) return [];
    const canonicalCwd = canonicalPath(rowCwd);
    if (requestedCwd && canonicalCwd !== requestedCwd) return [];
    if (archived.has(archiveKey(sessionId, canonicalCwd))) return [];
    const created = typeof row.time_created === 'number' ? row.time_created : undefined;
    const updated = typeof row.time_updated === 'number' ? row.time_updated : undefined;
    return [{
      sessionId,
      dbPath,
      cwd: canonicalCwd,
      ...(typeof row.title === 'string' && row.title.trim() ? { title: row.title.trim() } : {}),
      ...(created !== undefined ? { createdAt: timestamp(created) } : {}),
      ...(updated !== undefined ? { updatedAt: timestamp(updated) } : {}),
    }];
  });
}

export function findZcodeSessionById(
  sessionId: string,
  cwd?: string,
  options: { dbPath?: string; includeArchived?: boolean } = {},
): ZcodeSessionSummary | null {
  const wanted = sessionId.trim();
  if (!wanted) return null;
  return listZcodeSessionSummaries(cwd, options).find((session) => session.sessionId === wanted) || null;
}

function stableSignature(...values: unknown[]): string {
  return crypto.createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0, 24);
}

function unknownRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function errorMessage(value: unknown): string {
  const root = unknownRecord(value);
  const data = unknownRecord(root.data);
  for (const candidate of [data.message, root.message, root.name]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return '';
}

function toolStateText(state: Record<string, unknown>): string {
  for (const candidate of [state.output, state.result, state.error, state.message]) {
    if (typeof candidate === 'string') return candidate;
    if (candidate !== undefined) {
      try {
        return JSON.stringify(candidate);
      } catch {
        return String(candidate);
      }
    }
  }
  return '';
}

function parsePartRecord(
  row: ZcodePartRow,
  role: string,
  turnId: string | undefined,
): BridgeMirrorRecord[] {
  const part = parseJson<ZcodePartData>(row.data);
  if (!part?.type) return [];
  const at = timestamp(row.time_updated || row.time_created);
  const signature = stableSignature('zcode-part', row.id, row.time_updated, row.data);
  if (part.type === 'text' && role === 'assistant' && typeof part.text === 'string' && part.text) {
    return [{
      signature,
      type: 'message',
      role: 'assistant',
      content: part.text,
      timestamp: at,
      ...(turnId ? { turnId } : {}),
      replacementKey: `zcode-part:${row.id}`,
    }];
  }
  if ((part.type === 'reasoning' || part.type === 'thinking') && (part.text || part.content)) {
    return [{
      signature,
      type: 'reasoning',
      role: 'assistant',
      content: part.text || part.content || '',
      reasoningKind: 'thinking',
      timestamp: at,
      ...(turnId ? { turnId } : {}),
      replacementKey: `zcode-part:${row.id}`,
    }];
  }
  if (part.type !== 'tool') return [];
  const state = unknownRecord(part.state);
  const status = typeof state.status === 'string' ? state.status : '';
  const toolId = part.callID || part.callId || part.toolCallId || row.id;
  const toolName = part.tool || part.name || 'tool';
  const input = state.input ?? state.parameters ?? {};
  const common = {
    signature,
    toolId,
    toolName,
    timestamp: at,
    ...(turnId ? { turnId } : {}),
  };
  if (status === 'completed' || status === 'success' || status === 'error' || status === 'failed') {
    return [{
      ...common,
      type: 'tool_finished',
      content: toolStateText(state),
      isError: status === 'error' || status === 'failed',
    }];
  }
  return [{
    ...common,
    type: 'tool_started',
    content: '',
    toolInput: input,
  }];
}

export function readZcodeSessionMirrorRecords(
  dbPath: string,
  sessionId: string,
  options: { turnId?: string } = {},
): BridgeMirrorRecord[] {
  return withReadOnlyDatabase(dbPath, (db) => {
    const messages = db.prepare(`
      SELECT id, time_created, time_updated, data, sequence
      FROM message WHERE session_id = ? ORDER BY sequence, time_created, id
    `).all(sessionId) as unknown as ZcodeMessageRow[];
    const parts = db.prepare(`
      SELECT id, message_id, time_created, time_updated, data, sequence
      FROM part WHERE session_id = ? ORDER BY time_created, sequence, id
    `).all(sessionId) as unknown as ZcodePartRow[];
    const turnUsage = db.prepare(`
      SELECT turn_id, status, started_at, completed_at,
             input_tokens, output_tokens, reasoning_tokens,
             cache_creation_input_tokens, cache_read_input_tokens,
             computed_total_tokens, error_type, error_code
      FROM turn_usage WHERE session_id = ? ORDER BY started_at, turn_id
    `).all(sessionId) as unknown as ZcodeTurnUsageRow[];
    const modelErrors = db.prepare(`
      SELECT turn_id, error_message FROM model_usage
      WHERE session_id = ? AND error_message IS NOT NULL
      ORDER BY started_at, attempt_index
    `).all(sessionId) as unknown as ZcodeModelErrorRow[];
    const partsByMessage = new Map<string, ZcodePartRow[]>();
    for (const part of parts) {
      const group = partsByMessage.get(part.message_id) || [];
      group.push(part);
      partsByMessage.set(part.message_id, group);
    }
    const records: BridgeMirrorRecord[] = [];
    for (const message of messages) {
      const data = parseJson<ZcodeMessageData>(message.data);
      if (!data) continue;
      const turnId = data.anchor?.turnId;
      if (options.turnId && turnId !== options.turnId) continue;
      for (const part of partsByMessage.get(message.id) || []) {
        records.push(...parsePartRecord(part, data.role || '', turnId));
      }
    }
    const errorByTurn = new Map<string, string>();
    for (const row of modelErrors) {
      if (row.turn_id && row.error_message) errorByTurn.set(row.turn_id, row.error_message);
    }
    for (const usage of turnUsage) {
      if (options.turnId && usage.turn_id !== options.turnId) continue;
      if (usage.status === 'running') continue;
      const at = timestamp(usage.completed_at || usage.started_at);
      if (usage.status === 'completed') {
        records.push({
          signature: stableSignature('zcode-turn', usage.turn_id, usage.status, usage.completed_at),
          type: 'task_complete',
          role: 'assistant',
          content: '',
          timestamp: at,
          turnId: usage.turn_id,
          contextUsage: {
            lastTokenUsage: {
              inputTokens: usage.input_tokens,
              outputTokens: usage.output_tokens,
              reasoningOutputTokens: usage.reasoning_tokens,
              cachedInputTokens: usage.cache_read_input_tokens,
              totalTokens: usage.computed_total_tokens,
            },
          },
        });
      } else {
        const detail = errorByTurn.get(usage.turn_id)
          || usage.error_code
          || usage.error_type
          || `ZCode turn ${usage.status}`;
        records.push({
          signature: stableSignature('zcode-turn', usage.turn_id, usage.status, usage.completed_at, detail),
          type: 'task_aborted',
          role: 'assistant',
          content: detail,
          isError: usage.status === 'error',
          timestamp: at,
          turnId: usage.turn_id,
        });
      }
    }
    return records.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  }) || [];
}

export function findLatestZcodeTurnId(
  dbPath: string,
  sessionId: string,
  afterMs = 0,
): string | null {
  return withReadOnlyDatabase(dbPath, (db) => {
    const row = db.prepare(`
      SELECT turn_id FROM turn_usage
      WHERE session_id = ? AND started_at >= ?
      ORDER BY started_at DESC LIMIT 1
    `).get(sessionId, afterMs) as { turn_id?: unknown } | undefined;
    return typeof row?.turn_id === 'string' ? row.turn_id : null;
  }) || null;
}

export function readZcodeSessionMessages(
  dbPath: string,
  sessionId: string,
  limit: number,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const messages = withReadOnlyDatabase(dbPath, (db) => {
    const rows = db.prepare(`
      SELECT m.data AS message_data, p.data AS part_data
      FROM message m JOIN part p ON p.message_id = m.id
      WHERE m.session_id = ?
      ORDER BY m.sequence, m.time_created, p.sequence, p.time_created, p.id
    `).all(sessionId) as unknown as Array<{ message_data: string; part_data: string }>;
    return rows.flatMap((row): Array<{ role: 'user' | 'assistant'; content: string }> => {
      const message = parseJson<ZcodeMessageData>(row.message_data);
      const part = parseJson<ZcodePartData>(row.part_data);
      const role = message?.role;
      const content = part?.type === 'text' ? part.text || part.content : undefined;
      return (role === 'user' || role === 'assistant') && content
        ? [{ role, content }]
        : [];
    });
  }) || [];
  return messages.slice(-Math.max(0, limit));
}

export function createZcodeMirrorSqliteSource(): MirrorJsonlSource {
  return {
    runtime: 'zcode',
    readMode: 'snapshot',
    statSnapshot(filePath) {
      const paths = [filePath, `${filePath}-wal`];
      const stats = paths.flatMap((candidate) => {
        try {
          const stat = fs.statSync(candidate);
          return stat.isFile() ? [{ path: candidate, stat }] : [];
        } catch {
          return [];
        }
      });
      if (stats.length === 0 || stats[0]?.path !== filePath) return null;
      return {
        size: stats.reduce((total, entry) => total + entry.stat.size, 0),
        mtimeMs: Math.max(...stats.map((entry) => entry.stat.mtimeMs)),
        identity: stats.map((entry) => `${entry.path}:${entry.stat.dev}:${entry.stat.ino}`).join('|'),
      };
    },
    watchPath(filePath) {
      return path.dirname(filePath);
    },
    findByThreadId(threadId, cwd) {
      const session = findZcodeSessionById(threadId, cwd);
      if (!session) return null;
      return {
        threadId: session.sessionId,
        filePath: session.dbPath,
        cwd: session.cwd,
        updatedAt: session.updatedAt,
      };
    },
    readDelta(
      filePath,
      _startOffset,
      endOffset,
      _trailingText,
      currentTurnId,
      _currentSpecialCallIds,
      threadId,
    ): BridgeMirrorRecordDelta {
      if (!threadId) {
        return {
          records: [],
          nextOffset: endOffset,
          trailingText: '',
          nextTurnId: currentTurnId,
          nextSpecialCallIds: [],
          unknownKinds: [],
        };
      }
      const records = readZcodeSessionMirrorRecords(filePath, threadId);
      return {
        records,
        nextOffset: endOffset,
        trailingText: '',
        nextTurnId: records.map((record) => record.turnId).filter(Boolean).at(-1) || currentTurnId,
        nextSpecialCallIds: [],
        unknownKinds: [],
      };
    },
  };
}
