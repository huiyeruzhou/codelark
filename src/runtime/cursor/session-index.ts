import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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

function cursorAssistantReplacementKey(turnId: string): string {
  return `cursor:${turnId}:assistant-text`;
}

const CURSOR_ASSISTANT_SNAPSHOT_STATE_PREFIX = 'cursor-assistant-snapshot:';

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
    if (value.startsWith(CURSOR_ASSISTANT_SNAPSHOT_STATE_PREFIX)) continue;
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
  let activeTurnId = options.currentTurnId || null;
  for (const entry of cursorTranscriptLines(rawText, options.baseOffset || 0)) {
    const line = entry.line.trim();
    if (!line) continue;
    const parsed = parseTranscriptLine(line);
    if (!parsed) continue;
    const timestamp = '';
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
        signature: stableLineSignature(line, entry.offset, 'turn-ended'),
        type: parsed.status === 'success' ? 'task_complete' : 'task_aborted',
        content: parsed.error || '',
        timestamp,
        ...(activeTurnId ? { turnId: activeTurnId } : {}),
      });
      if (activeTurnId) assistantSnapshots.delete(activeTurnId);
      activeTurnId = null;
      continue;
    }
    const role = parsed.role;
    const blocks = Array.isArray(parsed.message?.content) ? parsed.message!.content! : [];
    const assistantTextBlocks: string[] = [];
    // Cursor may compact a multi-turn transcript down to one final
    // turn_ended record. A new user row is therefore the reliable turn
    // boundary; do not let the missing intermediate terminal merge turns.
    if (role === 'user') {
      assistantSnapshots.clear();
      activeTurnId = stableLineSignature(line, entry.offset, 'turn-id');
      records.push({
        signature: stableLineSignature(line, entry.offset, 'turn-started'),
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
        records.push({
          signature: stableLineSignature(line, entry.offset, `text:${blockIndex}`),
          type: 'message',
          role: role === 'user' ? 'user' : 'commentary',
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
  return {
    runtime: 'cursor' as MirrorJsonlSource['runtime'],
    findByThreadId(threadId: string, cwd?: string): MirrorJsonlSourceSummary | null {
      const summary = findCursorSessionFileById(threadId, cwd);
      if (summary?.filePath) {
        storePathsByTranscript.set(summary.filePath, summary.storePath);
        return {
            threadId: summary.sessionId,
            filePath: summary.filePath,
            cwd: summary.cwd,
            updatedAt: summary.updatedAt,
          };
      }
      return null;
    },
    readDelta(filePath, startOffset, endOffset, trailingText, currentTurnId, currentSpecialCallIds) {
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
