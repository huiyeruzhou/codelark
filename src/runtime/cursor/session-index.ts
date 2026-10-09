import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { CODELARK_HOME } from '../../configuration/paths.js';
import { CursorDesktopSessionSource, statCursorDesktopStore } from './desktop-session-source.js';

import type {
  BridgeMirrorRecord,
  BridgeMirrorRecordDelta,
  MirrorJsonlSource,
  MirrorJsonlSourceSummary,
} from '../contracts.js';

export interface CursorSessionFileSummary {
  sessionId: string;
  cwd?: string;
  title?: string;
  model?: string;
  createdAt?: string;
  updatedAt?: string;
  sessionDir: string;
  storePath?: string;
  filePath?: string;
  transport: 'cli' | 'desktop';
}

export interface CursorTranscriptTailStatus {
  size: number;
  updatedAt: string;
  recordType: string;
  role?: string;
  status?: string;
  error?: string;
}

interface CursorSessionMeta {
  schemaVersion?: number;
  title?: string;
  createdAtMs?: number;
  updatedAtMs?: number;
  hasConversation?: boolean;
  isSubagent?: boolean;
  cwd?: string;
}

interface CursorStoreMeta {
  lastUsedModel?: string;
}

interface CursorDesktopConversationRow {
  id?: unknown;
  title?: unknown;
  updated_at?: unknown;
  is_archived?: unknown;
}

interface CursorDesktopComposerHeaderRow {
  composerId?: unknown;
  workspaceId?: unknown;
  createdAt?: unknown;
  lastUpdatedAt?: unknown;
  value?: unknown;
}

interface CursorDesktopConversationLocation {
  cwd: string;
  createdAt?: string;
  title?: string;
}

interface ArchivedCursorSessionEntry {
  sessionId: string;
  cwd: string;
  archivedAt: string;
  filePath?: string;
  title?: string;
}

interface CursorTranscriptContentBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: unknown;
}

interface CursorTranscriptLine {
  type?: string;
  status?: string;
  error?: string;
  role?: string;
  message?: {
    content?: CursorTranscriptContentBlock[];
  };
}

function cursorConfigRoot(): string {
  const explicit = process.env.CURSOR_CONFIG_DIR?.trim();
  if (explicit) return path.resolve(explicit);
  return path.join(os.homedir(), '.cursor');
}

function cursorDataRoot(): string {
  const explicit = process.env.CURSOR_DATA_DIR?.trim();
  return explicit ? path.resolve(explicit) : path.join(os.homedir(), '.cursor');
}

function cursorDesktopUserRoot(): string {
  const explicit = process.env.CURSOR_DESKTOP_USER_DIR?.trim();
  if (explicit) return path.resolve(explicit);
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Cursor', 'User');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Cursor', 'User');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Cursor', 'User');
}

export function cursorDesktopGlobalStorageRoot(): string {
  return path.join(cursorDesktopUserRoot(), 'globalStorage');
}

function cursorDesktopWorkspaceStorageRoot(): string {
  return path.join(cursorDesktopUserRoot(), 'workspaceStorage');
}

function canonicalExistingPath(value: string): string {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function isExistingDirectory(value: string): boolean {
  try {
    return fs.statSync(value).isDirectory();
  } catch {
    return false;
  }
}

function archivedCursorSessionsPath(): string {
  return path.join(CODELARK_HOME, 'data', 'archived-cursor-sessions.json');
}

function cursorArchiveKey(sessionId: string, cwd: string): string {
  return `${canonicalExistingPath(cwd)}\0${sessionId.trim()}`;
}

function readArchivedCursorSessions(): ArchivedCursorSessionEntry[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(archivedCursorSessionsPath(), 'utf8')) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is ArchivedCursorSessionEntry => (
          typeof entry === 'object'
          && entry !== null
          && typeof (entry as ArchivedCursorSessionEntry).sessionId === 'string'
          && typeof (entry as ArchivedCursorSessionEntry).cwd === 'string'
          && typeof (entry as ArchivedCursorSessionEntry).archivedAt === 'string'
        ))
      : [];
  } catch {
    return [];
  }
}

export function archiveCursorSessionFile(
  session: Pick<CursorSessionFileSummary, 'sessionId' | 'cwd' | 'filePath' | 'title'>,
): boolean {
  const sessionId = session.sessionId.trim();
  const cwd = session.cwd?.trim();
  if (!sessionId || !cwd) return false;
  const entries = readArchivedCursorSessions();
  const key = cursorArchiveKey(sessionId, cwd);
  if (!entries.some((entry) => cursorArchiveKey(entry.sessionId, entry.cwd) === key)) {
    entries.push({
      sessionId,
      cwd,
      archivedAt: new Date().toISOString(),
      ...(session.filePath ? { filePath: session.filePath } : {}),
      ...(session.title ? { title: session.title } : {}),
    });
    const archivePath = archivedCursorSessionsPath();
    fs.mkdirSync(path.dirname(archivePath), { recursive: true });
    fs.writeFileSync(archivePath, JSON.stringify(entries, null, 2) + '\n', 'utf8');
  }
  return true;
}

export function isArchivedCursorSession(sessionId: string, cwd: string): boolean {
  const key = cursorArchiveKey(sessionId, cwd);
  return readArchivedCursorSessions().some((entry) => cursorArchiveKey(entry.sessionId, entry.cwd) === key);
}

export function cursorWorkspaceHash(cwd: string): string {
  return crypto.createHash('md5').update(canonicalExistingPath(cwd)).digest('hex');
}

export function cursorWorkspaceSlug(cwd: string): string {
  return canonicalExistingPath(cwd)
    .replace(/[^a-zA-Z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function encodeCursorConversationId(sessionId: string): string {
  return encodeURIComponent(sessionId).replace(/%/g, '_').slice(0, 200);
}

export function getCursorChatsRoot(cwd?: string): string {
  const root = path.join(cursorConfigRoot(), 'chats');
  return cwd ? path.join(root, cursorWorkspaceHash(cwd)) : root;
}

export function getCursorTranscriptCandidates(sessionId: string, cwd: string): string[] {
  const encoded = encodeCursorConversationId(sessionId);
  const root = path.join(cursorDataRoot(), 'projects', cursorWorkspaceSlug(cwd), 'agent-transcripts');
  return [
    path.join(root, encoded, `${encoded}.jsonl`),
    path.join(root, `${encoded}.jsonl`),
  ];
}

function readCursorSessionMeta(sessionDir: string): CursorSessionMeta | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(sessionDir, 'meta.json'), 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as CursorSessionMeta : null;
  } catch {
    return null;
  }
}

function readCursorStoreMeta(storePath: string): CursorStoreMeta | null {
  if (!fs.existsSync(storePath)) return null;
  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(storePath, { readOnly: true });
    const row = database.prepare("SELECT value FROM meta WHERE key = '0'").get() as { value?: unknown } | undefined;
    if (typeof row?.value !== 'string' || !/^[0-9a-f]+$/iu.test(row.value) || row.value.length % 2 !== 0) return null;
    const parsed = JSON.parse(Buffer.from(row.value, 'hex').toString('utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as CursorStoreMeta : null;
  } catch {
    return null;
  } finally {
    database?.close();
  }
}

function isoFromMs(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? new Date(value).toISOString()
    : undefined;
}

function readJsonObject(value: unknown): Record<string, any> | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, any>
      : null;
  } catch {
    return null;
  }
}

function cursorDesktopPathFromUri(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const uri = value as Record<string, unknown>;
  const direct = typeof uri.fsPath === 'string'
    ? uri.fsPath
    : typeof uri.path === 'string'
      ? uri.path
      : undefined;
  if (direct?.trim()) return path.resolve(direct.trim());
  if (typeof uri.external === 'string' && uri.external.startsWith('file:')) {
    try {
      return path.resolve(fileURLToPath(uri.external));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function cursorDesktopCwdFromHeader(value: unknown): string | undefined {
  const header = readJsonObject(value);
  if (!header) return undefined;
  const candidates = [
    cursorDesktopPathFromUri(header.workspaceIdentifier?.uri),
    cursorDesktopPathFromUri(header.agentLocation?.environment?.uri),
    ...(Array.isArray(header.trackedGitRepos)
      ? header.trackedGitRepos.map((repo: any) => typeof repo?.repoPath === 'string' ? path.resolve(repo.repoPath) : undefined)
      : []),
  ];
  return candidates.find((candidate): candidate is string => Boolean(candidate));
}

function readCursorDesktopWorkspaceFolder(workspaceDir: string): string | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(workspaceDir, 'workspace.json'), 'utf8')) as Record<string, unknown>;
    const raw = typeof parsed.folder === 'string'
      ? parsed.folder
      : typeof parsed.workspace === 'string'
        ? parsed.workspace
        : undefined;
    if (!raw) return undefined;
    return raw.startsWith('file:') ? path.resolve(fileURLToPath(raw)) : path.resolve(raw);
  } catch {
    return undefined;
  }
}

function readCursorDesktopComposerLocations(): Map<string, CursorDesktopConversationLocation> {
  const locations = new Map<string, CursorDesktopConversationLocation>();
  const statePath = path.join(cursorDesktopGlobalStorageRoot(), 'state.vscdb');
  let state: DatabaseSync | null = null;
  try {
    state = new DatabaseSync(statePath, { readOnly: true });
    const headers = state.prepare([
      'SELECT composerId, workspaceId, createdAt, lastUpdatedAt, value',
      'FROM composerHeaders',
      'WHERE isArchived = 0 AND isSubagent = 0',
    ].join(' ')).all() as CursorDesktopComposerHeaderRow[];
    for (const row of headers) {
      if (typeof row.composerId !== 'string') continue;
      const cwd = cursorDesktopCwdFromHeader(row.value);
      if (!cwd) continue;
      const header = readJsonObject(row.value);
      locations.set(row.composerId, {
        cwd,
        ...(isoFromMs(row.createdAt) ? { createdAt: isoFromMs(row.createdAt) } : {}),
        ...(typeof header?.name === 'string' && header.name.trim() ? { title: header.name.trim() } : {}),
      });
    }
  } catch {
    // Older Cursor versions do not have composerHeaders; workspace storage below is authoritative there.
  } finally {
    state?.close();
  }

  for (const workspaceDir of listDirectories(cursorDesktopWorkspaceStorageRoot())) {
    const cwd = readCursorDesktopWorkspaceFolder(workspaceDir);
    if (!cwd) continue;
    let database: DatabaseSync | null = null;
    try {
      database = new DatabaseSync(path.join(workspaceDir, 'state.vscdb'), { readOnly: true });
      const row = database.prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerData'").get() as { value?: unknown } | undefined;
      const data = readJsonObject(row?.value);
      const composers = Array.isArray(data?.allComposers) ? data.allComposers : [];
      for (const composer of composers) {
        if (!composer || typeof composer !== 'object' || typeof composer.composerId !== 'string') continue;
        if (composer.isArchived === true || composer.isDraft === true || locations.has(composer.composerId)) continue;
        locations.set(composer.composerId, {
          cwd,
          ...(isoFromMs(composer.createdAt) ? { createdAt: isoFromMs(composer.createdAt) } : {}),
          ...(typeof composer.name === 'string' && composer.name.trim() ? { title: composer.name.trim() } : {}),
        });
      }
    } catch {
      // Workspace state can disappear while Cursor prunes old workspaces.
    } finally {
      database?.close();
    }
  }
  return locations;
}

function listCursorDesktopSessionSummaries(cwd?: string): CursorSessionFileSummary[] {
  const indexPath = path.join(cursorDesktopGlobalStorageRoot(), 'conversation-search.db');
  if (!fs.existsSync(indexPath)) return [];
  let database: DatabaseSync | null = null;
  try {
    const locations = readCursorDesktopComposerLocations();
    database = new DatabaseSync(indexPath, { readOnly: true });
    const rows = database.prepare([
      'SELECT id, title, updated_at, is_archived',
      'FROM conversations',
      "WHERE source = 'local' AND is_archived = 0",
      'ORDER BY updated_at DESC',
    ].join(' ')).all() as CursorDesktopConversationRow[];
    const requestedCwd = cwd ? canonicalExistingPath(cwd) : undefined;
    return rows.flatMap((row): CursorSessionFileSummary[] => {
      if (typeof row.id !== 'string' || !row.id.trim()) return [];
      const location = locations.get(row.id);
      if (!location || !isExistingDirectory(location.cwd)) return [];
      const sessionCwd = canonicalExistingPath(location.cwd);
      if (requestedCwd && sessionCwd !== requestedCwd) return [];
      const filePath = getCursorTranscriptCandidates(row.id, sessionCwd)
        .find((candidate) => fs.existsSync(candidate));
      const updatedAt = isoFromMs(row.updated_at);
      const title = typeof row.title === 'string' && row.title.trim()
        ? row.title.trim()
        : location.title;
      return [{
        sessionId: row.id,
        sessionDir: cursorDesktopGlobalStorageRoot(),
        transport: 'desktop',
        cwd: sessionCwd,
        ...(title ? { title } : {}),
        ...(location.createdAt ? { createdAt: location.createdAt } : {}),
        ...(updatedAt ? { updatedAt } : {}),
        ...(filePath ? { filePath } : {}),
      }];
    });
  } catch {
    return [];
  } finally {
    database?.close();
  }
}

function summarizeCursorSessionDir(sessionDir: string, fallbackCwd?: string): CursorSessionFileSummary | null {
  const sessionId = path.basename(sessionDir);
  const storePath = path.join(sessionDir, 'store.db');
  const meta = readCursorSessionMeta(sessionDir);
  const storeMeta = readCursorStoreMeta(storePath);
  if (!fs.existsSync(storePath) && !meta) return null;
  if (meta?.isSubagent || meta?.hasConversation === false) return null;
  const cwd = meta?.cwd?.trim() || fallbackCwd?.trim() || undefined;
  const filePath = cwd
    ? getCursorTranscriptCandidates(sessionId, cwd).find((candidate) => fs.existsSync(candidate))
    : undefined;
  let stat: fs.Stats | undefined;
  try {
    stat = fs.statSync(filePath || storePath || sessionDir);
  } catch {
    // Preserve metadata-only sessions during file replacement races.
  }
  return {
    sessionId,
    sessionDir,
    storePath,
    transport: 'cli',
    ...(cwd ? { cwd } : {}),
    ...(meta?.title?.trim() ? { title: meta.title.trim() } : {}),
    ...(storeMeta?.lastUsedModel?.trim() ? { model: storeMeta.lastUsedModel.trim() } : {}),
    ...(isoFromMs(meta?.createdAtMs) || stat ? {
      createdAt: isoFromMs(meta?.createdAtMs) || new Date(stat!.birthtimeMs || stat!.ctimeMs).toISOString(),
    } : {}),
    ...(isoFromMs(meta?.updatedAtMs) || stat ? {
      updatedAt: isoFromMs(meta?.updatedAtMs) || new Date(stat!.mtimeMs).toISOString(),
    } : {}),
    ...(filePath ? { filePath } : {}),
  };
}

function listDirectories(root: string): string[] {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name));
  } catch {
    return [];
  }
}

export function listCursorSessionFileSummaries(cwd?: string, limit?: number): CursorSessionFileSummary[] {
  const workspaceDirs = cwd ? [getCursorChatsRoot(cwd)] : listDirectories(getCursorChatsRoot());
  const sessions: CursorSessionFileSummary[] = [];
  for (const workspaceDir of workspaceDirs) {
    for (const sessionDir of listDirectories(workspaceDir)) {
      const summary = summarizeCursorSessionDir(sessionDir, cwd);
      if (summary) sessions.push(summary);
    }
  }
  const combined = new Map<string, CursorSessionFileSummary>();
  for (const session of [...sessions, ...listCursorDesktopSessionSummaries(cwd)]) {
    const previous = combined.get(session.sessionId);
    if (previous) {
      const desktop = previous.transport === 'desktop'
        ? previous
        : session.transport === 'desktop' ? session : undefined;
      combined.set(session.sessionId, {
          ...session,
          ...previous,
          title: desktop?.title || previous.title || session.title,
          cwd: desktop?.cwd || previous.cwd || session.cwd,
          createdAt: previous.createdAt || session.createdAt,
          updatedAt: [previous.updatedAt, session.updatedAt].filter(Boolean).sort().at(-1),
          filePath: previous.filePath || session.filePath,
          model: previous.model || session.model,
          transport: previous.transport === 'desktop' || session.transport === 'desktop' ? 'desktop' : 'cli',
        });
    } else {
      combined.set(session.sessionId, session);
    }
  }
  const archived = new Set(readArchivedCursorSessions().map((entry) => cursorArchiveKey(entry.sessionId, entry.cwd)));
  const visible = [...combined.values()].filter((session) => !session.cwd || !archived.has(cursorArchiveKey(session.sessionId, session.cwd)));
  visible.sort((left, right) => (right.updatedAt || '').localeCompare(left.updatedAt || ''));
  const bounded = typeof limit === 'number' && Number.isFinite(limit) && limit > 0
    ? Math.max(1, Math.floor(limit))
    : undefined;
  return visible.slice(0, bounded);
}

export function findCursorSessionFileById(sessionId: string, cwd?: string): CursorSessionFileSummary | null {
  if (!sessionId.trim()) return null;
  if (cwd) {
    if (isArchivedCursorSession(sessionId, cwd)) return null;
    return listCursorSessionFileSummaries(cwd).find((session) => session.sessionId === sessionId) || null;
  }
  return listCursorSessionFileSummaries().find((session) => session.sessionId === sessionId) || null;
}

export function inspectCursorTranscriptTail(filePath: string): CursorTranscriptTailStatus | null {
  try {
    const stat = fs.statSync(filePath);
    const maxBytes = 256 * 1024;
    const start = Math.max(0, stat.size - maxBytes);
    const text = readFileRange(filePath, start, stat.size);
    const lines = text.split(/\r?\n/u);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]?.trim();
      if (!line) continue;
      const parsed = parseTranscriptLine(line);
      if (!parsed) continue;
      return {
        size: stat.size,
        updatedAt: stat.mtime.toISOString(),
        recordType: parsed.type || (parsed.role ? `${parsed.role}_message` : 'unknown'),
        ...(parsed.role ? { role: parsed.role } : {}),
        ...(parsed.status ? { status: parsed.status } : {}),
        ...(parsed.error ? { error: parsed.error } : {}),
      };
    }
    return {
      size: stat.size,
      updatedAt: stat.mtime.toISOString(),
      recordType: 'empty',
    };
  } catch {
    return null;
  }
}

function parseTranscriptLine(line: string): CursorTranscriptLine | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as CursorTranscriptLine : null;
  } catch {
    return null;
  }
}

function stableLineSignature(
  line: string,
  _absoluteOffset: number,
  suffix: string,
  turnId = '',
  occurrence = 1,
): string {
  const digest = crypto.createHash('sha256')
    .update(`${turnId}\0${line}\0${occurrence}\0${suffix}`)
    .digest('hex')
    .slice(0, 16);
  return `cursor:${digest}:${suffix}`;
}

function cursorTurnId(line: string, occurrence: number, timestamp: string): string {
  const digest = crypto.createHash('sha256').update(line).digest('hex').slice(0, 16);
  return `cursor:${digest}:${occurrence}:turn-id${timestamp ? `:at:${timestamp}` : ''}`;
}

function cursorTurnTimestamp(turnId: string | null): string {
  const marker = ':turn-id:at:';
  const markerIndex = turnId?.indexOf(marker) ?? -1;
  return markerIndex >= 0 ? turnId!.slice(markerIndex + marker.length) : '';
}

function parseCursorUserTimestamp(blocks: CursorTranscriptContentBlock[]): string {
  const tagged = blocks
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text || '')
    .join('\n')
    .match(/<timestamp>([^<]+)<\/timestamp>/u)?.[1]
    ?.trim();
  if (!tagged) return '';
  const zone = tagged.match(/\s*\(UTC(?:(?<sign>[+-])(?<hours>\d{1,2})(?::?(?<minutes>\d{2}))?)?\)\s*$/u);
  if (zone?.index === undefined) return '';
  const wallClock = tagged.slice(0, zone.index).replace(/^[A-Za-z]+,\s*/u, '').trim();
  const wallClockMs = Date.parse(`${wallClock} UTC`);
  if (!Number.isFinite(wallClockMs)) return '';
  const hours = Number(zone.groups?.hours || 0);
  const minutes = Number(zone.groups?.minutes || 0);
  const direction = zone.groups?.sign === '-' ? -1 : 1;
  const offsetMs = direction * (hours * 60 + minutes) * 60_000;
  return new Date(wallClockMs - offsetMs).toISOString();
}

function isCursorMetadataOnlyUserRow(blocks: CursorTranscriptContentBlock[]): boolean {
  return blocks.length > 0 && blocks.every((block) => (
    block.type === 'text'
    && typeof block.text === 'string'
    && !block.text.replace(/<timestamp>[^<]*<\/timestamp>/gu, '').replace(/<\|eos\|>/gu, '').trim()
  ));
}

function stableAssistantTextSignature(turnId: string, text: string): string {
  const digest = crypto.createHash('sha256').update(`${turnId}\0${text}`).digest('hex').slice(0, 16);
  return `cursor:${digest}:assistant-text`;
}

function cursorAssistantReplacementKey(turnId: string): string {
  return `cursor:${turnId}:assistant-text`;
}

const CURSOR_ASSISTANT_SNAPSHOT_STATE_PREFIX = 'cursor-assistant-snapshot:';
const CURSOR_OCCURRENCE_STATE_PREFIX = 'cursor-occurrence:';

interface CursorAssistantSnapshotState {
  lastContent: string;
  canonicalContent?: string;
  thinkingSummary?: string;
}

interface CursorStructuredAssistantSnapshot {
  canonicalContent: string;
  thinkingSummary: string;
}

function decodeCursorAssistantSnapshots(values: Iterable<string>): Map<string, CursorAssistantSnapshotState> {
  const snapshots = new Map<string, CursorAssistantSnapshotState>();
  for (const value of values) {
    if (!value.startsWith(CURSOR_ASSISTANT_SNAPSHOT_STATE_PREFIX)) continue;
    try {
      const decoded = Buffer.from(
        value.slice(CURSOR_ASSISTANT_SNAPSHOT_STATE_PREFIX.length),
        'base64url',
      ).toString('utf8');
      const parsed = JSON.parse(decoded) as unknown;
      if (
        Array.isArray(parsed)
        && typeof parsed[0] === 'string'
        && typeof parsed[1] === 'string'
        && parsed[0]
      ) {
        snapshots.set(parsed[0], {
          lastContent: parsed[1],
          ...(typeof parsed[2] === 'string' && parsed[2] ? { canonicalContent: parsed[2] } : {}),
          ...(typeof parsed[3] === 'string' && normalizeCursorThinkingSummary(parsed[3])
            ? { thinkingSummary: normalizeCursorThinkingSummary(parsed[3]) }
            : {}),
        });
      }
    } catch {
      // Ignore malformed opaque parser state from an older or partial run.
    }
  }
  return snapshots;
}

function decodeCursorOccurrences(values: Iterable<string>): Map<string, number> {
  for (const value of values) {
    if (!value.startsWith(CURSOR_OCCURRENCE_STATE_PREFIX)) continue;
    try {
      const decoded = Buffer.from(
        value.slice(CURSOR_OCCURRENCE_STATE_PREFIX.length),
        'base64url',
      ).toString('utf8');
      const parsed = JSON.parse(decoded) as unknown;
      if (!Array.isArray(parsed)) return new Map();
      return new Map(parsed.filter((entry): entry is [string, number] => (
        Array.isArray(entry)
        && typeof entry[0] === 'string'
        && typeof entry[1] === 'number'
        && Number.isSafeInteger(entry[1])
        && entry[1] > 0
      )));
    } catch {
      return new Map();
    }
  }
  return new Map();
}

function encodeCursorOccurrences(occurrences: Map<string, number>): string {
  return `${CURSOR_OCCURRENCE_STATE_PREFIX}${Buffer.from(
    JSON.stringify(Array.from(occurrences.entries())),
  ).toString('base64url')}`;
}

function nextCursorOccurrence(occurrences: Map<string, number>, key: string): number {
  const occurrence = (occurrences.get(key) || 0) + 1;
  occurrences.set(key, occurrence);
  return occurrence;
}

function clearCursorTurnOccurrences(occurrences: Map<string, number>, turnId: string | null): void {
  if (!turnId) return;
  const prefix = `event:${turnId}:`;
  for (const key of occurrences.keys()) {
    if (key.startsWith(prefix)) occurrences.delete(key);
  }
}

function encodeCursorAssistantSnapshots(snapshots: Map<string, CursorAssistantSnapshotState>): string[] {
  return Array.from(snapshots, ([turnId, snapshot]) => (
    `${CURSOR_ASSISTANT_SNAPSHOT_STATE_PREFIX}${Buffer.from(JSON.stringify([
      turnId,
      snapshot.lastContent,
      snapshot.canonicalContent || '',
      snapshot.thinkingSummary || '',
    ])).toString('base64url')}`
  ));
}

function normalizeCursorThinkingSummary(content: string): string {
  const trimmed = content.trim();
  return trimmed.match(/^\*\*([^\r\n]+)\*\*$/u)?.[1]?.trim() || trimmed;
}

function parseCursorBoldThinkingSummary(content: string): string {
  return content.trim().match(/^\*\*([^\r\n]+)\*\*$/u)?.[1]?.trim() || '';
}

function normalizeCursorSnapshotText(content: string): string {
  return content.replace(/\r\n?/gu, '\n').trim();
}

function resolveCursorAssistantSnapshotFromStore(
  storePath: string,
  transcriptContent: string,
): CursorStructuredAssistantSnapshot | null {
  const normalizedTranscript = normalizeCursorSnapshotText(transcriptContent);
  if (!storePath || !normalizedTranscript) return null;
  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(storePath, { readOnly: true });
    const rows = database.prepare([
      'SELECT data FROM blobs',
      'WHERE length(data) BETWEEN 2 AND 2097152',
      "AND hex(substr(data, 1, 1)) = '7B'",
    ].join(' ')).all() as Array<{ data?: string | Uint8Array }>;
    for (const row of rows) {
      const raw = typeof row.data === 'string'
        ? row.data
        : row.data instanceof Uint8Array
          ? Buffer.from(row.data).toString('utf8')
          : '';
      if (!raw) continue;
      let message: {
        role?: unknown;
        content?: Array<{ type?: unknown; text?: unknown }>;
      };
      try {
        message = JSON.parse(raw) as typeof message;
      } catch {
        continue;
      }
      if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
      const textParts = message.content
        .filter((block) => block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '<|eos|>')
        .map((block) => String(block.text));
      const reasoningParts = message.content
        .filter((block) => block.type === 'reasoning' && typeof block.text === 'string')
        .map((block) => String(block.text));
      if (textParts.length === 0 || reasoningParts.length === 0) continue;
      const canonicalContent = normalizeCursorSnapshotText(textParts.join('\n'));
      const rawSummary = normalizeCursorSnapshotText(reasoningParts.join('\n'));
      if (!canonicalContent || !rawSummary) continue;
      const flattenedCandidates = [
        `${canonicalContent}\n\n${rawSummary}`,
        `${canonicalContent}\n${rawSummary}`,
      ];
      if (!flattenedCandidates.some((candidate) => normalizeCursorSnapshotText(candidate) === normalizedTranscript)) {
        continue;
      }
      return {
        canonicalContent,
        thinkingSummary: normalizeCursorThinkingSummary(rawSummary),
      };
    }
  } catch {
    return null;
  } finally {
    try {
      database?.close();
    } catch {
      // Best-effort read-only evidence lookup.
    }
  }
  return null;
}

function splitCursorThinkingSummarySuffix(
  content: string,
): { canonicalContent: string; thinkingSummary: string } | null {
  const boundaries = Array.from(content.matchAll(/(?:\r?\n){2,}/gu));
  const boundary = boundaries.at(-1);
  if (boundary?.index === undefined) return null;
  const canonicalContent = content.slice(0, boundary.index).trimEnd();
  const thinkingSummary = parseCursorBoldThinkingSummary(
    content.slice(boundary.index + boundary[0].length),
  );
  if (!canonicalContent || !thinkingSummary) return null;
  return { canonicalContent, thinkingSummary };
}

function splitCursorAssistantRevision(
  previous: string,
  next: string,
): { canonicalContent: string; thinkingSummary: string } | null {
  if (previous === next) return null;
  if (previous.startsWith(next)) {
    const removedSuffix = previous.slice(next.length).match(/^(?:\r?\n){2,}([\s\S]+)$/u)?.[1] || '';
    const thinkingSummary = parseCursorBoldThinkingSummary(removedSuffix);
    if (thinkingSummary && next.trim()) {
      return { canonicalContent: next.trim(), thinkingSummary };
    }
  }

  const previousParts = splitCursorThinkingSummarySuffix(previous);
  const nextParts = splitCursorThinkingSummarySuffix(next);
  if (!previousParts || !nextParts) return null;
  return nextParts;
}

function pushCursorRecord(records: BridgeMirrorRecord[], record: BridgeMirrorRecord): void {
  if (!record.replacementKey) {
    records.push(record);
    return;
  }
  const previousIndex = records.findIndex((candidate) => (
    candidate.replacementKey === record.replacementKey
  ));
  if (previousIndex >= 0) records.splice(previousIndex, 1);
  records.push(record);
}

interface ParsedCursorTranscriptRecords {
  records: BridgeMirrorRecord[];
  nextTurnId: string | null;
  nextSpecialCallIds: string[];
}

function decodePendingCursorTools(values: Iterable<string>): Map<string, string[]> {
  const pending = new Map<string, string[]>();
  for (const value of values) {
    if (
      value.startsWith(CURSOR_ASSISTANT_SNAPSHOT_STATE_PREFIX)
      || value.startsWith(CURSOR_OCCURRENCE_STATE_PREFIX)
    ) continue;
    const separator = value.indexOf('\0');
    if (separator <= 0) continue;
    const name = value.slice(0, separator);
    const id = value.slice(separator + 1);
    if (!id) continue;
    pending.set(name, [...(pending.get(name) || []), id]);
  }
  return pending;
}

function encodePendingCursorTools(pending: Map<string, string[]>): string[] {
  return Array.from(pending.entries()).flatMap(([name, ids]) => ids.map((id) => `${name}\0${id}`));
}

function cursorTranscriptLines(rawText: string, baseOffset: number): Array<{ line: string; offset: number }> {
  const result: Array<{ line: string; offset: number }> = [];
  const pattern = /([^\r\n]*)(\r\n|\n|\r|$)/g;
  let byteOffset = baseOffset;
  for (;;) {
    const match = pattern.exec(rawText);
    if (!match || !match[0]) break;
    result.push({ line: match[1] || '', offset: byteOffset });
    byteOffset += Buffer.byteLength(match[0], 'utf8');
  }
  return result;
}

function parseCursorTranscriptRecordState(
  rawText: string,
  options: {
    baseOffset?: number;
    currentTurnId?: string | null;
    currentSpecialCallIds?: Iterable<string>;
    resolveAssistantSnapshot?: (content: string) => CursorStructuredAssistantSnapshot | null;
  } = {},
): ParsedCursorTranscriptRecords {
  const records: BridgeMirrorRecord[] = [];
  const encodedState = Array.from(options.currentSpecialCallIds || []);
  const pendingToolIdsByName = decodePendingCursorTools(encodedState);
  const assistantSnapshots = decodeCursorAssistantSnapshots(encodedState);
  const occurrences = decodeCursorOccurrences(encodedState);
  let activeTurnId = options.currentTurnId || null;
  let activeTurnTimestamp = cursorTurnTimestamp(activeTurnId);
  for (const entry of cursorTranscriptLines(rawText, options.baseOffset || 0)) {
    const line = entry.line.trim();
    if (!line) continue;
    const parsed = parseTranscriptLine(line);
    if (!parsed) continue;
    const role = parsed.role;
    const blocks = Array.isArray(parsed.message?.content) ? parsed.message!.content! : [];
    // Cursor can emit repeated timestamp-only user rows around background
    // activity. They carry no input and must not open cards or reset the
    // active turn's tool/snapshot/occurrence state. Keep non-text inputs.
    if (role === 'user' && isCursorMetadataOnlyUserRow(blocks)) continue;
    const lineDigest = crypto.createHash('sha256').update(line).digest('hex').slice(0, 16);
    let lineOccurrence = activeTurnId
      ? nextCursorOccurrence(occurrences, `event:${activeTurnId}:${lineDigest}`)
      : 1;
    let timestamp = activeTurnTimestamp;
    if (parsed.type === 'turn_ended') {
      if (activeTurnId) {
        const finalSnapshot = assistantSnapshots.get(activeTurnId);
        const structuredSnapshot = finalSnapshot?.canonicalContent && finalSnapshot.thinkingSummary
          ? {
            canonicalContent: finalSnapshot.canonicalContent,
            thinkingSummary: finalSnapshot.thinkingSummary,
          }
          : finalSnapshot?.lastContent
            ? options.resolveAssistantSnapshot?.(finalSnapshot.lastContent) || null
            : null;
        if (structuredSnapshot) {
          const assistantReplacementKey = cursorAssistantReplacementKey(activeTurnId);
          for (let index = records.length - 1; index >= 0; index -= 1) {
            if (records[index]?.replacementKey === assistantReplacementKey) records.splice(index, 1);
          }
          records.push({
            signature: stableAssistantTextSignature(
              activeTurnId,
              `thinking-summary\0${structuredSnapshot.thinkingSummary}`,
            ),
            type: 'reasoning',
            content: structuredSnapshot.thinkingSummary,
            reasoningKind: 'summary',
            reasoningLabel: '思考摘要',
            timestamp,
            turnId: activeTurnId,
          });
          pushCursorRecord(records, {
            signature: stableAssistantTextSignature(activeTurnId, structuredSnapshot.canonicalContent),
            type: 'message',
            role: 'assistant',
            content: structuredSnapshot.canonicalContent,
            timestamp,
            turnId: activeTurnId,
            replacementKey: assistantReplacementKey,
          });
        }
      }
      records.push({
        signature: stableLineSignature(
          line,
          entry.offset,
          'turn-ended',
          activeTurnId || '',
          lineOccurrence,
        ),
        type: parsed.status === 'success' ? 'task_complete' : 'task_aborted',
        content: parsed.error || '',
        timestamp,
        ...(activeTurnId ? { turnId: activeTurnId } : {}),
      });
      if (activeTurnId) assistantSnapshots.delete(activeTurnId);
      clearCursorTurnOccurrences(occurrences, activeTurnId);
      activeTurnId = null;
      activeTurnTimestamp = '';
      continue;
    }
    const assistantTextBlocks: string[] = [];
    // Cursor may compact a multi-turn transcript down to one final
    // turn_ended record. A new user row is therefore the reliable turn
    // boundary; do not let the missing intermediate terminal merge turns.
    if (role === 'user') {
      assistantSnapshots.clear();
      clearCursorTurnOccurrences(occurrences, activeTurnId);
      activeTurnTimestamp = parseCursorUserTimestamp(blocks);
      timestamp = activeTurnTimestamp;
      const userOccurrence = nextCursorOccurrence(occurrences, `user:${lineDigest}`);
      activeTurnId = cursorTurnId(line, userOccurrence, activeTurnTimestamp);
      lineOccurrence = nextCursorOccurrence(occurrences, `event:${activeTurnId}:${lineDigest}`);
      records.push({
        signature: stableLineSignature(line, entry.offset, 'turn-started', activeTurnId, lineOccurrence),
        type: 'task_started',
        content: '',
        timestamp,
        turnId: activeTurnId,
      });
    }
    // Cursor rewrites its transcript snapshot between turns, removing the
    // previous EOF turn_ended row. An append cursor can therefore land in the
    // middle of the new user row and next encounter a complete assistant row.
    // Treat that first complete row as the recoverable boundary for this turn.
    if (role === 'assistant' && !activeTurnId) {
      activeTurnId = stableLineSignature(line, entry.offset, 'implicit-turn-id');
      activeTurnTimestamp = '';
      lineOccurrence = nextCursorOccurrence(occurrences, `event:${activeTurnId}:${lineDigest}`);
    }
    for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
      const block = blocks[blockIndex]!;
      if (block.type === 'text' && block.text?.trim()) {
        if (block.text.trim() === '<|eos|>') continue;
        if (role === 'assistant') {
          assistantTextBlocks.push(block.text);
          continue;
        }
        if (role === 'tool') {
          try {
            const tool = JSON.parse(block.text) as {
              tool_name?: unknown;
              tool_result?: unknown;
            };
            const toolName = typeof tool.tool_name === 'string' && tool.tool_name.trim()
              ? tool.tool_name.trim()
              : 'tool';
            const pendingIds = pendingToolIdsByName.get(toolName) || [];
            const toolId = pendingIds.shift() || stableLineSignature(
              line,
              entry.offset,
              `tool-result-id:${blockIndex}`,
              activeTurnId || '',
              lineOccurrence,
            );
            pendingToolIdsByName.set(toolName, pendingIds);
            const result = tool.tool_result;
            records.push({
              signature: stableLineSignature(
                line,
                entry.offset,
                `tool-result:${blockIndex}`,
                activeTurnId || '',
                lineOccurrence,
              ),
              type: 'tool_finished',
              content: typeof result === 'string' ? result : JSON.stringify(result ?? ''),
              timestamp,
              toolId,
              toolName,
              isError: false,
              ...(activeTurnId ? { turnId: activeTurnId } : {}),
            });
            continue;
          } catch {
            // Preserve non-JSON tool text as commentary below.
          }
        }
        records.push({
          signature: stableLineSignature(
            line,
            entry.offset,
            `text:${blockIndex}`,
            activeTurnId || '',
            lineOccurrence,
          ),
          type: 'message',
          role: role === 'user' ? 'user' : 'commentary',
          content: block.text,
          timestamp,
          ...(activeTurnId ? { turnId: activeTurnId } : {}),
        });
      } else if (block.type === 'tool_use') {
        const toolName = block.name || 'tool';
        const toolId = stableLineSignature(
          line,
          entry.offset,
          `tool-id:${blockIndex}`,
          activeTurnId || '',
          lineOccurrence,
        );
        const pendingIds = pendingToolIdsByName.get(toolName) || [];
        pendingIds.push(toolId);
        pendingToolIdsByName.set(toolName, pendingIds);
        records.push({
          signature: stableLineSignature(
            line,
            entry.offset,
            `tool:${blockIndex}`,
            activeTurnId || '',
            lineOccurrence,
          ),
          type: 'tool_started',
          content: '',
          timestamp,
          toolId,
          toolName,
          toolInput: block.input,
          ...(activeTurnId ? { turnId: activeTurnId } : {}),
        });
      }
    }
    if (role === 'assistant' && activeTurnId && assistantTextBlocks.length > 0) {
      const content = assistantTextBlocks.join('\n\n');
      const previousSnapshot = assistantSnapshots.get(activeTurnId);
      const revision = previousSnapshot
        ? splitCursorAssistantRevision(previousSnapshot.lastContent, content)
        : null;
      // Cursor may first persist `text + reasoning`, then rewrite both the
      // answer and the transcript row to text-only. In that shape the two
      // flattened revisions have no stable textual prefix, so revision
      // comparison alone cannot recover the summary. Preserve it as soon as
      // the structured store proves the current flattened snapshot.
      const structuredSnapshot = revision || (
        splitCursorThinkingSummarySuffix(content)
          ? options.resolveAssistantSnapshot?.(content) || null
          : null
      );
      const visibleContent = structuredSnapshot?.canonicalContent || content;
      assistantSnapshots.set(activeTurnId, {
        lastContent: content,
        ...(structuredSnapshot || (
          previousSnapshot?.canonicalContent && previousSnapshot.thinkingSummary
            ? {
              canonicalContent: content,
              thinkingSummary: previousSnapshot.thinkingSummary,
            }
            : {}
        )),
      });
      const signature = stableAssistantTextSignature(activeTurnId, visibleContent);
      if (!records.some((record) => record.signature === signature)) {
        pushCursorRecord(records, {
          signature,
          type: 'message',
          role: 'assistant',
          content: visibleContent,
          timestamp,
          turnId: activeTurnId,
          replacementKey: cursorAssistantReplacementKey(activeTurnId),
        });
      }
    }
  }
  return {
    records,
    nextTurnId: activeTurnId,
    nextSpecialCallIds: [
      ...encodePendingCursorTools(pendingToolIdsByName),
      ...encodeCursorAssistantSnapshots(assistantSnapshots),
      encodeCursorOccurrences(occurrences),
    ],
  };
}

export function parseCursorTranscriptRecords(rawText: string, storePath?: string): BridgeMirrorRecord[] {
  return parseCursorTranscriptRecordState(rawText, {
    ...(storePath ? {
      resolveAssistantSnapshot: (content) => resolveCursorAssistantSnapshotFromStore(storePath, content),
    } : {}),
  }).records;
}

function readFileRange(filePath: string, startOffset: number, endOffset: number): string {
  const length = Math.max(0, endOffset - startOffset);
  if (length === 0) return '';
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = fs.readSync(fd, buffer, 0, length, startOffset);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function splitCompleteText(rawText: string): { completeText: string; trailingText: string } {
  if (!rawText || /\r?\n$/.test(rawText)) return { completeText: rawText, trailingText: '' };
  const lines = rawText.split(/\r?\n/);
  const finalLine = lines.at(-1) || '';
  if (!finalLine.trim() || parseTranscriptLine(finalLine)) return { completeText: rawText, trailingText: '' };
  lines.pop();
  return { completeText: lines.join('\n'), trailingText: finalLine };
}

export function readCursorSessionMessagesByFilePath(
  filePath: string,
  limit: number,
  storePath?: string,
): Array<{ role: string; content: string }> {
  try {
    return parseCursorTranscriptRecords(fs.readFileSync(filePath, 'utf8'), storePath)
      .filter((record) => record.type === 'message' && record.role === 'assistant' && record.content.trim())
      .map((record) => ({ role: 'assistant', content: record.content }))
      .slice(-Math.max(0, Math.floor(limit)));
  } catch {
    return [];
  }
}

export function readCursorSessionMirrorRecordStreamByFilePath(
  filePath: string,
  storePath?: string,
): BridgeMirrorRecord[] {
  try {
    return parseCursorTranscriptRecords(fs.readFileSync(filePath, 'utf8'), storePath);
  } catch {
    return [];
  }
}

export function readCursorSessionMirrorRecordDeltaByFilePath(
  filePath: string,
  startOffset: number,
  endOffset: number,
  trailingText: string,
  currentTurnId: string | null,
  currentSpecialCallIds: Iterable<string>,
  storePath?: string,
): BridgeMirrorRecordDelta {
  try {
    const split = splitCompleteText(`${trailingText}${readFileRange(filePath, startOffset, endOffset)}`);
    const parsed = parseCursorTranscriptRecordState(split.completeText, {
      baseOffset: Math.max(0, startOffset - Buffer.byteLength(trailingText, 'utf8')),
      currentTurnId,
      currentSpecialCallIds,
      ...(storePath ? {
        resolveAssistantSnapshot: (content) => resolveCursorAssistantSnapshotFromStore(storePath, content),
      } : {}),
    });
    return {
      records: parsed.records,
      nextOffset: Math.max(startOffset, endOffset),
      trailingText: split.trailingText,
      nextTurnId: parsed.nextTurnId,
      nextSpecialCallIds: parsed.nextSpecialCallIds,
      unknownKinds: [],
    };
  } catch {
    return {
      records: [],
      nextOffset: startOffset,
      trailingText,
      nextTurnId: currentTurnId,
      nextSpecialCallIds: Array.from(currentSpecialCallIds),
      unknownKinds: [],
    };
  }
}

export function createCursorMirrorJsonlSource(): MirrorJsonlSource {
  const storePathsByTranscript = new Map<string, string>();
  const desktopPath = path.join(cursorDesktopGlobalStorageRoot(), 'state.vscdb');
  const desktop = new CursorDesktopSessionSource(desktopPath);
  return {
    runtime: 'cursor' as MirrorJsonlSource['runtime'],
    refresh: (threadId, filePath) => filePath === desktopPath ? desktop.refresh(threadId) : Promise.resolve(false),
    readModeForPath: (filePath) => filePath === desktopPath ? 'snapshot' : 'append',
    statSnapshot(filePath) {
      if (filePath === desktopPath) return statCursorDesktopStore(filePath);
      try {
        const stat = fs.statSync(filePath);
        return { size: stat.size, mtimeMs: stat.mtimeMs, identity: `${stat.dev}:${stat.ino}` };
      } catch { return null; }
    },
    // Cursor rewrites transcript snapshots with atomic file replacement. A
    // watcher attached to the old inode stops receiving later updates, while
    // the containing directory remains stable across every replacement.
    watchPath(filePath: string): string {
      return path.dirname(filePath);
    },
    findByThreadId(threadId: string, cwd?: string): MirrorJsonlSourceSummary | null {
      const summary = findCursorSessionFileById(threadId, cwd);
      if (summary?.transport === 'desktop') {
        // A native store is authoritative for Desktop tools. CLI transcripts
        // remain append logs and retain their existing parser and identity.
        try {
          if (desktop.read(threadId)) return {
            threadId, filePath: desktopPath, cwd: summary.cwd, updatedAt: summary.updatedAt,
          };
        } catch { /* Older Cursor builds may only expose transcript export. */ }
      }
      if (summary?.filePath) {
        if (summary.storePath) storePathsByTranscript.set(summary.filePath, summary.storePath);
        return {
            threadId: summary.sessionId,
            filePath: summary.filePath,
            cwd: summary.cwd,
            updatedAt: summary.updatedAt,
          };
      }
      return null;
    },
    readDelta(filePath, startOffset, endOffset, trailingText, currentTurnId, currentSpecialCallIds, threadId) {
      if (filePath === desktopPath) {
        if (!threadId) throw new Error('Cursor Desktop mirror requires a thread ID');
        const snapshot = desktop.read(threadId);
        if (!snapshot) throw new Error('Cursor Desktop conversation is unavailable in its native store');
        return { revisionLedger: true, records: snapshot.records, nextOffset: endOffset, trailingText: '',
          nextTurnId: snapshot.nextTurnId, nextSpecialCallIds: [], unknownKinds: [] };
      }
      return readCursorSessionMirrorRecordDeltaByFilePath(
        filePath,
        startOffset,
        endOffset,
        trailingText,
        currentTurnId,
        currentSpecialCallIds,
        storePathsByTranscript.get(filePath),
      );
    },
  };
}
