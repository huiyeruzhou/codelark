import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CODELARK_HOME } from '../../configuration/paths.js';

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
  createdAt?: string;
  updatedAt?: string;
  sessionDir: string;
  storePath: string;
  filePath?: string;
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

function canonicalExistingPath(value: string): string {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
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

function isoFromMs(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? new Date(value).toISOString()
    : undefined;
}

function summarizeCursorSessionDir(sessionDir: string, fallbackCwd?: string): CursorSessionFileSummary | null {
  const sessionId = path.basename(sessionDir);
  const storePath = path.join(sessionDir, 'store.db');
  const meta = readCursorSessionMeta(sessionDir);
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
    ...(cwd ? { cwd } : {}),
    ...(meta?.title?.trim() ? { title: meta.title.trim() } : {}),
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
  const archived = new Set(readArchivedCursorSessions().map((entry) => cursorArchiveKey(entry.sessionId, entry.cwd)));
  const visible = sessions.filter((session) => !session.cwd || !archived.has(cursorArchiveKey(session.sessionId, session.cwd)));
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
    return summarizeCursorSessionDir(path.join(getCursorChatsRoot(cwd), sessionId), cwd);
  }
  return listCursorSessionFileSummaries().find((session) => session.sessionId === sessionId) || null;
}

function parseTranscriptLine(line: string): CursorTranscriptLine | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as CursorTranscriptLine : null;
  } catch {
    return null;
  }
}

function stableLineSignature(line: string, absoluteOffset: number, suffix: string): string {
  const digest = crypto.createHash('sha256').update(line).digest('hex').slice(0, 16);
  return `cursor:${absoluteOffset}:${digest}:${suffix}`;
}

function stableAssistantTextSignature(turnId: string, text: string): string {
  const digest = crypto.createHash('sha256').update(`${turnId}\0${text}`).digest('hex').slice(0, 16);
  return `cursor:${digest}:assistant-text`;
}

interface ParsedCursorTranscriptRecords {
  records: BridgeMirrorRecord[];
  nextTurnId: string | null;
  nextSpecialCallIds: string[];
}

function decodePendingCursorTools(values: Iterable<string>): Map<string, string[]> {
  const pending = new Map<string, string[]>();
  for (const value of values) {
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
  } = {},
): ParsedCursorTranscriptRecords {
  const records: BridgeMirrorRecord[] = [];
  const pendingToolIdsByName = decodePendingCursorTools(options.currentSpecialCallIds || []);
  let activeTurnId = options.currentTurnId || null;
  for (const entry of cursorTranscriptLines(rawText, options.baseOffset || 0)) {
    const line = entry.line.trim();
    if (!line) continue;
    const parsed = parseTranscriptLine(line);
    if (!parsed) continue;
    const timestamp = '';
    if (parsed.type === 'turn_ended') {
      records.push({
        signature: stableLineSignature(line, entry.offset, 'turn-ended'),
        type: parsed.status === 'success' ? 'task_complete' : 'task_aborted',
        content: parsed.error || '',
        timestamp,
        ...(activeTurnId ? { turnId: activeTurnId } : {}),
      });
      activeTurnId = null;
      continue;
    }
    const role = parsed.role;
    const blocks = Array.isArray(parsed.message?.content) ? parsed.message!.content! : [];
    // Cursor may compact a multi-turn transcript down to one final
    // turn_ended record. A new user row is therefore the reliable turn
    // boundary; do not let the missing intermediate terminal merge turns.
    if (role === 'user') {
      activeTurnId = stableLineSignature(line, entry.offset, 'turn-id');
      records.push({
        signature: stableLineSignature(line, entry.offset, 'turn-started'),
        type: 'task_started',
        content: '',
        timestamp,
        turnId: activeTurnId,
      });
    }
    for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
      const block = blocks[blockIndex]!;
      if (block.type === 'text' && block.text?.trim()) {
        if (block.text.trim() === '<|eos|>') continue;
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
            const toolId = pendingIds.shift() || stableLineSignature(line, entry.offset, `tool-result-id:${blockIndex}`);
            pendingToolIdsByName.set(toolName, pendingIds);
            const result = tool.tool_result;
            records.push({
              signature: stableLineSignature(line, entry.offset, `tool-result:${blockIndex}`),
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
        const signature = role === 'assistant' && activeTurnId
          ? stableAssistantTextSignature(activeTurnId, block.text)
          : stableLineSignature(line, entry.offset, `text:${blockIndex}`);
        if (role === 'assistant' && records.some((record) => record.signature === signature)) continue;
        records.push({
          signature,
          type: 'message',
          role: role === 'assistant' ? 'assistant' : role === 'user' ? 'user' : 'commentary',
          content: block.text,
          timestamp,
          ...(activeTurnId ? { turnId: activeTurnId } : {}),
        });
      } else if (block.type === 'tool_use') {
        const toolName = block.name || 'tool';
        const toolId = stableLineSignature(line, entry.offset, `tool-id:${blockIndex}`);
        const pendingIds = pendingToolIdsByName.get(toolName) || [];
        pendingIds.push(toolId);
        pendingToolIdsByName.set(toolName, pendingIds);
        records.push({
          signature: stableLineSignature(line, entry.offset, `tool:${blockIndex}`),
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
  }
  return {
    records,
    nextTurnId: activeTurnId,
    nextSpecialCallIds: encodePendingCursorTools(pendingToolIdsByName),
  };
}

export function parseCursorTranscriptRecords(rawText: string): BridgeMirrorRecord[] {
  return parseCursorTranscriptRecordState(rawText).records;
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
): Array<{ role: string; content: string }> {
  try {
    return parseCursorTranscriptRecords(fs.readFileSync(filePath, 'utf8'))
      .filter((record) => record.type === 'message' && record.role === 'assistant' && record.content.trim())
      .map((record) => ({ role: 'assistant', content: record.content }))
      .slice(-Math.max(0, Math.floor(limit)));
  } catch {
    return [];
  }
}

export function readCursorSessionMirrorRecordStreamByFilePath(filePath: string): BridgeMirrorRecord[] {
  try {
    return parseCursorTranscriptRecords(fs.readFileSync(filePath, 'utf8'));
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
): BridgeMirrorRecordDelta {
  try {
    const split = splitCompleteText(`${trailingText}${readFileRange(filePath, startOffset, endOffset)}`);
    const parsed = parseCursorTranscriptRecordState(split.completeText, {
      baseOffset: Math.max(0, startOffset - Buffer.byteLength(trailingText, 'utf8')),
      currentTurnId,
      currentSpecialCallIds,
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
  return {
    runtime: 'cursor' as MirrorJsonlSource['runtime'],
    findByThreadId(threadId: string, cwd?: string): MirrorJsonlSourceSummary | null {
      const summary = findCursorSessionFileById(threadId, cwd);
      return summary?.filePath
        ? {
            threadId: summary.sessionId,
            filePath: summary.filePath,
            cwd: summary.cwd,
            updatedAt: summary.updatedAt,
          }
        : null;
    },
    readDelta(filePath, startOffset, endOffset, trailingText, currentTurnId, currentSpecialCallIds) {
      return readCursorSessionMirrorRecordDeltaByFilePath(
        filePath,
        startOffset,
        endOffset,
        trailingText,
        currentTurnId,
        currentSpecialCallIds,
      );
    },
  };
}
