import fs from 'node:fs';
import path from 'node:path';
import type { BridgeMessage } from '../../../domain/message.js';
import {
  loadArchivedThreadIds,
  moveSessionFileToArchive,
} from './archive-store.js';
import { walkSessionFiles } from './discovery-scanner.js';
import {
  getCodexSessionsRoot,
  getSessionIndexPath,
} from './paths.js';
import {
  readFilePrefix,
  readFileUtf8Range,
  readFirstLine,
} from './file-readers.js';
import {
  isInternalSkillWorkspace,
} from './workspace-filter.js';
import {
  extractNormalizedFreeText,
  isSessionEventLine,
  trimTitle as trimTitleBase,
  type BridgeMirrorRecord,
  type BridgeMirrorRecordDelta,
  type CodexSessionEvent,
  type CodexSessionEventDelta,
  type CodexSessionJsonlHistoryEntry,
  type SessionMessageLine,
  type SessionMetaLine,
  type SessionEventLine,
} from './jsonl-types.js';
import {
  resolveCodexJsonlDisplayText,
} from './internal-control-events.js';
import {
  codexJsonlHistoryEntriesToBridgeMessages,
  parseCodexSessionJsonlHistoryText,
} from './history-parser.js';
import {
  parseCodexMirrorRecordText,
  parseCodexSessionEventText,
} from './event-mirror-parser.js';

export { getCodexSessionsRoot, parseCodexSessionJsonlHistoryText };

export interface CodexSessionSummary {
  threadId: string;
  filePath: string;
  cwd: string;
  originator: string;
  source?: string;
  cliVersion?: string;
  firstSeenAt: string;
  lastEventAt: string;
  title: string;
  activeEstimate: boolean;
}

export type {
  BridgeMirrorRecord,
  BridgeMirrorRecordDelta,
  CodexSessionEvent,
  CodexSessionEventDelta,
  CodexSessionJsonlHistoryEntry,
};

interface SessionIndexLine {
  id?: string;
  thread_name?: string;
  updated_at?: string;
}

interface ThreadIndexEntry {
  title: string;
  updatedAt: string;
}

const ACTIVE_WINDOW_MS = 15 * 60 * 1000;
const MAX_SESSION_META_BYTES = 4 * 1024 * 1024;
const MAX_SESSION_TITLE_SCAN_BYTES = 512 * 1024;
const MAX_SESSION_MODEL_SCAN_BYTES = 2 * 1024 * 1024;
const TITLE_MAX_CHARS = 72;
const sessionFileByThreadId = new Map<string, string>();

function sessionFileCacheKey(threadId: string): string {
  return `${getCodexSessionsRoot()}\0${threadId}`;
}

function isSelectableCodexSession(meta: SessionMetaLine['payload']): boolean {
  const rawSource = meta?.source;
  if (rawSource != null && typeof rawSource !== 'string') return false;

  return true;
}

function loadThreadIndexEntries(archivedThreadIds: Set<string>): Map<string, ThreadIndexEntry> {
  const indexPath = getSessionIndexPath();
  if (!fs.existsSync(indexPath)) return new Map();

  let content = '';
  try {
    content = fs.readFileSync(indexPath, 'utf-8');
  } catch {
    return new Map();
  }

  const titles = new Map<string, ThreadIndexEntry>();
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;

    let parsed: SessionIndexLine;
    try {
      parsed = JSON.parse(line) as SessionIndexLine;
    } catch {
      continue;
    }

    const threadId = parsed.id?.trim();
    const title = trimTitle(parsed.thread_name || '');
    if (!threadId || !title || archivedThreadIds.has(threadId)) continue;

    const updatedAt = parsed.updated_at || '';
    const existing = titles.get(threadId);
    if (!existing || updatedAt >= existing.updatedAt) {
      titles.set(threadId, { title, updatedAt });
    }
  }

  return titles;
}

function buildFallbackTitle(threadId: string, filePath: string, cwd: string): string {
  try {
    const content = readFilePrefix(filePath, MAX_SESSION_TITLE_SCAN_BYTES);
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;

      let parsed: SessionMessageLine | SessionEventLine;
      try {
        parsed = JSON.parse(line) as SessionMessageLine | SessionEventLine;
      } catch {
        continue;
      }

      if (!isSessionEventLine(parsed) || parsed.payload?.type !== 'user_message') continue;

      const firstUserMessage = extractNormalizedFreeText(parsed.payload.message);
      const display = resolveCodexJsonlDisplayText(firstUserMessage);
      if (display.kind !== 'text') continue;
      const title = trimTitle(display.content);
      if (title) return title;
    }
  } catch {
    // Best-effort fallback only.
  }

  const dirName = trimTitle(path.basename(cwd || ''));
  if (dirName) return dirName;
  return `Session ${threadId.slice(0, 8)}`;
}

function parseCodexSession(
  filePath: string,
  threadIndexEntries: Map<string, ThreadIndexEntry>,
  archivedThreadIds: Set<string>,
): CodexSessionSummary | null {
  const firstLine = readFirstLine(filePath, MAX_SESSION_META_BYTES);
  if (!firstLine) return null;

  let parsed: SessionMetaLine;
  try {
    parsed = JSON.parse(firstLine) as SessionMetaLine;
  } catch {
    return null;
  }

  if (parsed.type !== 'session_meta' || !parsed.payload?.id || !isSelectableCodexSession(parsed.payload)) {
    return null;
  }

  if (archivedThreadIds.has(parsed.payload.id)) {
    return null;
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }

  const cwd = parsed.payload.cwd || '';
  if (isInternalSkillWorkspace(cwd)) {
    return null;
  }
  const lastEventAt = stat.mtime.toISOString();
  const firstSeenAt = parsed.payload.timestamp || parsed.timestamp || stat.birthtime.toISOString();
  const threadId = parsed.payload.id;
  const title = threadIndexEntries.get(threadId)?.title || buildFallbackTitle(threadId, filePath, cwd);

  return {
    threadId,
    filePath,
    cwd,
    originator: typeof parsed.payload.originator === 'string' ? parsed.payload.originator : 'Codex Native',
    source: typeof parsed.payload.source === 'string' ? parsed.payload.source : undefined,
    cliVersion: typeof parsed.payload.cli_version === 'string' ? parsed.payload.cli_version : undefined,
    firstSeenAt,
    lastEventAt,
    title,
    activeEstimate: Date.now() - stat.mtimeMs < ACTIVE_WINDOW_MS,
  };
}

function trimTitle(text: string): string {
  return trimTitleBase(text, TITLE_MAX_CHARS);
}

export function listCodexSessions(limit?: number): CodexSessionSummary[] {
  const root = getCodexSessionsRoot();
  if (!fs.existsSync(root)) return [];
  const archivedThreadIds = loadArchivedThreadIds();
  const threadIndexEntries = loadThreadIndexEntries(archivedThreadIds);

  const files: string[] = [];
  walkSessionFiles(root, files);

  const allSessions = new Map<string, CodexSessionSummary>();
  for (const filePath of files) {
    const session = parseCodexSession(filePath, threadIndexEntries, archivedThreadIds);
    if (!session) continue;
    allSessions.set(session.threadId, session);
    sessionFileByThreadId.set(sessionFileCacheKey(session.threadId), session.filePath);
  }

  const sessions = Array.from(allSessions.values());
  return sessions
    .sort((a, b) => b.lastEventAt.localeCompare(a.lastEventAt))
    .slice(0, typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? Math.max(1, Math.floor(limit)) : undefined);
}

export function getCodexSessionByThreadId(threadId: string): CodexSessionSummary | null {
  const cacheKey = sessionFileCacheKey(threadId);
  const cachedFilePath = sessionFileByThreadId.get(cacheKey);
  if (cachedFilePath) {
    const archivedThreadIds = loadArchivedThreadIds();
    const cached = parseCodexSession(
      cachedFilePath,
      loadThreadIndexEntries(archivedThreadIds),
      archivedThreadIds,
    );
    if (cached?.threadId === threadId) return cached;
    sessionFileByThreadId.delete(cacheKey);
  }

  const sessions = listCodexSessions();
  return sessions.find((session) => session.threadId === threadId) || null;
}

export function readCodexSessionModel(threadId: string): string | undefined {
  const session = getCodexSessionByThreadId(threadId);
  if (!session) return undefined;
  try {
    const size = fs.statSync(session.filePath).size;
    const start = Math.max(0, size - MAX_SESSION_MODEL_SCAN_BYTES);
    const text = readFileUtf8Range(session.filePath, start, size);
    const lines = text.split(/\r?\n/u);
    // The first row can be partial when the bounded tail starts in a large
    // event. Reverse scanning naturally skips that unparsable fragment.
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]?.trim();
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as {
          type?: unknown;
          payload?: { model?: unknown };
        };
        const model = codexRecordedModel(parsed, threadId);
        if (model) return model;
      } catch {
        // Continue past partial or unrelated rows.
      }
    }
  } catch {
    // Display probing is best effort and must never break a turn.
  }
  return undefined;
}

function codexRecordedModel(parsed: { type?: unknown; payload?: { type?: unknown; thread_id?: unknown; model?: unknown; thread_settings?: { model?: unknown } } }, threadId: string): string | undefined {
  const payload = parsed.payload;
  const model = parsed.type === 'turn_context' ? payload?.model
    : parsed.type === 'event_msg' && payload?.type === 'thread_settings_applied' && payload.thread_id === threadId
      ? payload.thread_settings?.model : undefined;
  return typeof model === 'string' ? model.trim() || undefined : undefined;
}

export interface CodexResumeModelCheckpoint {
  threadId: string; filePath: string; offset: number; dev: number; ino: number; model: string;
}

/** Snapshot before an owned TUI resume; never infer the effective model from CLI arguments. */
export function captureCodexResumeModelCheckpoint(threadId: string): CodexResumeModelCheckpoint | undefined {
  const session = getCodexSessionByThreadId(threadId);
  if (!session) return;
  try {
    const stat = fs.statSync(session.filePath);
    const text = readFileUtf8Range(session.filePath, Math.max(0, stat.size - MAX_SESSION_MODEL_SCAN_BYTES), stat.size);
    for (const line of text.split(/\r?\n/).reverse()) {
      try {
        const parsed = JSON.parse(line);
        // Match core/session/rollout_reconstruction.rs: the warning compares
        // the previous turn's model, not later standalone settings changes.
        // Do not guess through a rollback/compaction boundary in a bounded tail.
        if (parsed.type === 'compacted' || parsed.payload?.type === 'thread_rolled_back') return;
        if (parsed.type !== 'turn_context') continue;
        const model = codexRecordedModel(parsed, threadId);
        if (model) return { threadId, filePath: session.filePath, offset: stat.size, dev: stat.dev, ino: stat.ino, model };
      } catch { /* A bounded tail can start in a partial JSON row. */ }
    }
  } catch { /* Diagnostics must not prevent a resume. */ }
}

export function readCodexResumeModelMismatch(checkpoint: CodexResumeModelCheckpoint | undefined): { recordedModel: string; resumingModel: string } | undefined {
  if (!checkpoint) return;
  try {
    const stat = fs.statSync(checkpoint.filePath);
    if (stat.dev !== checkpoint.dev || stat.ino !== checkpoint.ino || stat.size < checkpoint.offset) return;
    const text = readFileUtf8Range(checkpoint.filePath, Math.max(checkpoint.offset, stat.size - MAX_SESSION_MODEL_SCAN_BYTES), stat.size);
    for (const line of text.split(/\r?\n/)) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.type !== 'event_msg' || parsed.payload?.type !== 'thread_settings_applied') continue;
        const model = codexRecordedModel(parsed, checkpoint.threadId);
        if (!model) continue;
        return model === checkpoint.model ? undefined : { recordedModel: checkpoint.model, resumingModel: model };
      } catch { /* Incomplete append; the legacy terminal warning remains available. */ }
    }
  } catch { /* Missing/truncated histories are not evidence of a model change. */ }
}

export function archiveCodexSession(threadId: string): CodexSessionSummary | null {
  const session = getCodexSessionByThreadId(threadId);
  if (!session) return null;

  moveSessionFileToArchive(session.filePath);
  sessionFileByThreadId.delete(sessionFileCacheKey(threadId));
  return session;
}

export function isArchivedCodexThread(threadId: string): boolean {
  return loadArchivedThreadIds().has(threadId);
}

export function readCodexSessionJsonlHistoryStreamByFilePath(filePath: string): CodexSessionJsonlHistoryEntry[] {
  let content = '';
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }
  return parseCodexSessionJsonlHistoryText(content);
}

export function readCodexSessionMessagesByFilePath(filePath: string, limit = 8): BridgeMessage[] {
  return codexJsonlHistoryEntriesToBridgeMessages(
    readCodexSessionJsonlHistoryStreamByFilePath(filePath),
    limit,
  );
}

export function readCodexSessionMessages(threadId: string, limit = 8): BridgeMessage[] {
  const session = getCodexSessionByThreadId(threadId);
  return session ? readCodexSessionMessagesByFilePath(session.filePath, limit) : [];
}

export function readCodexSessionEventStreamByFilePath(filePath: string): CodexSessionEvent[] {
  let content = '';
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  return parseCodexSessionEventText(content, '', true).events;
}

export function readCodexSessionEventDeltaByFilePath(
  filePath: string,
  startOffset: number,
  endOffset: number,
  trailingText = '',
): CodexSessionEventDelta {
  let content = '';
  try {
    content = readFileUtf8Range(filePath, startOffset, endOffset);
  } catch {
    return {
      events: [],
      nextOffset: startOffset,
      trailingText,
    };
  }

  const parsed = parseCodexSessionEventText(content, trailingText);
  return {
    events: parsed.events,
    nextOffset: Math.max(startOffset, endOffset),
    trailingText: parsed.trailingText,
  };
}

export function readCodexSessionMirrorRecordStreamByFilePath(filePath: string): BridgeMirrorRecord[] {
  let content = '';
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  return parseCodexMirrorRecordText(content, '', true, null, []).records;
}

export function readCodexSessionMirrorRecordDeltaByFilePath(
  filePath: string,
  startOffset: number,
  endOffset: number,
  trailingText = '',
  currentTurnId: string | null = null,
  currentSpecialCallIds: Iterable<string> = [],
): BridgeMirrorRecordDelta {
  let content = '';
  try {
    content = readFileUtf8Range(filePath, startOffset, endOffset);
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

  const parsed = parseCodexMirrorRecordText(content, trailingText, false, currentTurnId, currentSpecialCallIds);
  return {
    records: parsed.records,
    nextOffset: Math.max(startOffset, endOffset),
    trailingText: parsed.trailingText,
    nextTurnId: parsed.nextTurnId,
    nextSpecialCallIds: parsed.nextSpecialCallIds,
    unknownKinds: parsed.unknownKinds,
  };
}

export function readCodexSessionEventStream(threadId: string): CodexSessionEvent[] {
  const session = getCodexSessionByThreadId(threadId);
  if (!session) return [];
  return readCodexSessionEventStreamByFilePath(session.filePath);
}
