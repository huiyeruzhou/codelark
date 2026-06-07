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

interface ClaudeJsonlLine {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  promptId?: string;
  interruptedMessageId?: string;
  timestamp?: string;
  cwd?: string;
  sessionId?: string;
  message?: {
    role?: string;
    content?: unknown;
    model?: string;
    stop_reason?: string | null;
  };
}

export interface ClaudeSessionJsonlSummary {
  sessionId: string;
  filePath: string;
  cwd: string;
  updatedAt: string;
  firstSeenAt: string;
  title: string;
}

interface ArchivedClaudeSessionEntry {
  sessionId: string;
  cwd: string;
  archivedAt: string;
  filePath?: string;
  title?: string;
}

function createSignature(rawLine: string): string {
  return crypto.createHash('sha256').update(rawLine).digest('hex').slice(0, 24);
}

function normalizeStructuredText(text: string): string {
  return text.replace(/\r\n/g, '\n').trim();
}

function collectText(value: unknown, parts: string[], depth = 0): void {
  if (value == null || depth > 6) return;
  if (typeof value === 'string') {
    parts.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, parts, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  if (typeof record.text === 'string') parts.push(record.text);
  if (typeof record.content === 'string') parts.push(record.content);
  if ('content' in record) collectText(record.content, parts, depth + 1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function contentBlocks(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

function collectClaudeVisibleText(value: unknown, parts: string[], depth = 0): void {
  if (value == null || depth > 6) return;
  if (typeof value === 'string') {
    parts.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectClaudeVisibleText(item, parts, depth + 1);
    return;
  }
  if (!isRecord(value)) return;
  if (value.type === 'tool_use' || value.type === 'tool_result') return;
  if (typeof value.text === 'string') parts.push(value.text);
  if (typeof value.content === 'string') parts.push(value.content);
  if ('content' in value) collectClaudeVisibleText(value.content, parts, depth + 1);
}

function extractClaudeMessageText(value: unknown): string {
  const parts: string[] = [];
  collectClaudeVisibleText(value, parts);
  return normalizeStructuredText(parts.join('\n\n'));
}

function extractClaudeToolResultText(value: unknown): string {
  const parts: string[] = [];
  collectText(value, parts);
  const text = normalizeStructuredText(parts.join('\n\n'));
  if (text) return text;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value ?? '');
  }
}

function parseClaudeJsonlLine(rawLine: string): ClaudeJsonlLine | null {
  if (!rawLine.trim()) return null;
  try {
    const parsed = JSON.parse(rawLine) as unknown;
    return typeof parsed === 'object' && parsed !== null ? parsed as ClaudeJsonlLine : null;
  } catch {
    return null;
  }
}

interface ClaudeMirrorParserState {
  activeTurnId: string | null;
  uuidToRootTurnId: Map<string, string>;
  promptIdToRootTurnId: Map<string, string>;
  toolUseIdToRootTurnId: Map<string, string>;
}

const CLAUDE_MIRROR_STATE_PREFIX = 'claude-root:';

function createClaudeMirrorParserState(
  activeTurnId: string | null,
  encodedState: Iterable<string> = [],
): ClaudeMirrorParserState {
  const state: ClaudeMirrorParserState = {
    activeTurnId,
    uuidToRootTurnId: new Map(),
    promptIdToRootTurnId: new Map(),
    toolUseIdToRootTurnId: new Map(),
  };
  for (const entry of encodedState) {
    if (!entry.startsWith(CLAUDE_MIRROR_STATE_PREFIX)) continue;
    const parts = entry.slice(CLAUDE_MIRROR_STATE_PREFIX.length).split(':');
    if (parts.length !== 3) continue;
    const [kind, encodedKey, encodedRoot] = parts;
    const key = decodeURIComponent(encodedKey || '');
    const root = decodeURIComponent(encodedRoot || '');
    if (!key || !root) continue;
    if (kind === 'uuid') state.uuidToRootTurnId.set(key, root);
    if (kind === 'prompt') state.promptIdToRootTurnId.set(key, root);
    if (kind === 'tool') state.toolUseIdToRootTurnId.set(key, root);
  }
  return state;
}

function encodeClaudeMirrorParserState(state: ClaudeMirrorParserState): string[] {
  const entries: string[] = [];
  const pushEntry = (kind: string, key: string, root: string): void => {
    entries.push(`${CLAUDE_MIRROR_STATE_PREFIX}${kind}:${encodeURIComponent(key)}:${encodeURIComponent(root)}`);
  };
  for (const [key, root] of state.uuidToRootTurnId) pushEntry('uuid', key, root);
  for (const [key, root] of state.promptIdToRootTurnId) pushEntry('prompt', key, root);
  for (const [key, root] of state.toolUseIdToRootTurnId) pushEntry('tool', key, root);
  return entries;
}

function rememberClaudeRoot(state: ClaudeMirrorParserState, parsed: ClaudeJsonlLine, rootTurnId: string | null | undefined): void {
  if (!rootTurnId) return;
  if (parsed.uuid) state.uuidToRootTurnId.set(parsed.uuid, rootTurnId);
  if (parsed.promptId) state.promptIdToRootTurnId.set(parsed.promptId, rootTurnId);
}

function findClaudeRootForLine(state: ClaudeMirrorParserState, parsed: ClaudeJsonlLine): string | null {
  if (parsed.uuid && state.uuidToRootTurnId.has(parsed.uuid)) return state.uuidToRootTurnId.get(parsed.uuid)!;
  if (parsed.parentUuid && state.uuidToRootTurnId.has(parsed.parentUuid)) return state.uuidToRootTurnId.get(parsed.parentUuid)!;
  if (parsed.promptId && state.promptIdToRootTurnId.has(parsed.promptId)) return state.promptIdToRootTurnId.get(parsed.promptId)!;
  return state.activeTurnId;
}

function findClaudeRootForToolResults(
  state: ClaudeMirrorParserState,
  blocks: unknown[],
  parsed: ClaudeJsonlLine,
): string | null {
  for (const block of blocks) {
    if (!isRecord(block) || block.type !== 'tool_result') continue;
    const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
    if (toolUseId && state.toolUseIdToRootTurnId.has(toolUseId)) {
      return state.toolUseIdToRootTurnId.get(toolUseId)!;
    }
  }
  return findClaudeRootForLine(state, parsed);
}

function claudeProjectDirName(cwd: string): string {
  return path.resolve(cwd).replace(/[\\/_.]/g, '-');
}

function legacyClaudeProjectDirName(cwd: string): string {
  return path.resolve(cwd).replace(/[\\/]/g, '-');
}

function realpathIfExists(cwd: string): string | null {
  try {
    return fs.realpathSync(cwd);
  } catch {
    return null;
  }
}

function symlinkTargetIfExists(cwd: string): string | null {
  try {
    const target = fs.readlinkSync(cwd);
    return path.resolve(path.dirname(cwd), target);
  } catch {
    return null;
  }
}

function claudeProjectDirNamesForCwd(cwd: string): string[] {
  const paths = [path.resolve(cwd)];
  const symlinkTarget = symlinkTargetIfExists(cwd);
  if (symlinkTarget) paths.push(symlinkTarget);
  const realpath = realpathIfExists(cwd);
  if (realpath) paths.push(realpath);
  return Array.from(new Set(paths.flatMap((candidate) => [
    claudeProjectDirName(candidate),
    legacyClaudeProjectDirName(candidate),
  ])));
}

function archiveKey(sessionId: string, cwd: string): string {
  return `${path.resolve(cwd)}\0${sessionId.trim()}`;
}

function archivedClaudeSessionsPath(): string {
  return path.join(CODELARK_HOME, 'data', 'archived-claude-sessions.json');
}

function readArchivedClaudeSessionEntries(): ArchivedClaudeSessionEntry[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(archivedClaudeSessionsPath(), 'utf-8')) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is ArchivedClaudeSessionEntry => (
      typeof entry === 'object'
      && entry !== null
      && typeof (entry as ArchivedClaudeSessionEntry).sessionId === 'string'
      && typeof (entry as ArchivedClaudeSessionEntry).cwd === 'string'
      && typeof (entry as ArchivedClaudeSessionEntry).archivedAt === 'string'
    ));
  } catch {
    return [];
  }
}

function writeArchivedClaudeSessionEntries(entries: ArchivedClaudeSessionEntry[]): void {
  const archivePath = archivedClaudeSessionsPath();
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  fs.writeFileSync(archivePath, JSON.stringify(entries, null, 2) + '\n', 'utf-8');
}

export function loadArchivedClaudeSessionKeys(): Set<string> {
  return new Set(readArchivedClaudeSessionEntries().map((entry) => archiveKey(entry.sessionId, entry.cwd)));
}

export function isArchivedClaudeSession(sessionId: string, cwd: string): boolean {
  return loadArchivedClaudeSessionKeys().has(archiveKey(sessionId, cwd));
}

export function archiveClaudeSessionJsonl(session: Pick<ClaudeSessionJsonlSummary, 'sessionId' | 'cwd' | 'filePath' | 'title'>): boolean {
  const sessionId = session.sessionId.trim();
  const cwd = session.cwd.trim();
  if (!sessionId || !cwd) return false;
  const entries = readArchivedClaudeSessionEntries();
  const key = archiveKey(sessionId, cwd);
  if (entries.some((entry) => archiveKey(entry.sessionId, entry.cwd) === key)) return true;
  entries.push({
    sessionId,
    cwd,
    archivedAt: new Date().toISOString(),
    ...(session.filePath ? { filePath: session.filePath } : {}),
    ...(session.title ? { title: session.title } : {}),
  });
  writeArchivedClaudeSessionEntries(entries);
  return true;
}

export function getClaudeProjectsRoot(homeDir = os.homedir()): string {
  return path.join(homeDir, '.claude', 'projects');
}

function getDefaultClaudeHome(): string {
  return process.env.CODELARK_CLAUDE_HOME || os.homedir();
}

export function getClaudeProjectDir(cwd: string, homeDir = getDefaultClaudeHome()): string {
  return path.join(getClaudeProjectsRoot(homeDir), claudeProjectDirName(cwd));
}

export function listClaudeSessionJsonlFiles(cwd: string, homeDir = getDefaultClaudeHome()): string[] {
  const projectsRoot = getClaudeProjectsRoot(homeDir);
  const projectDirNames = claudeProjectDirNamesForCwd(cwd);
  return projectDirNames
    .flatMap((projectDirName) => {
      const projectDir = path.join(projectsRoot, projectDirName);
      if (!fs.existsSync(projectDir)) return [];
      return fs.readdirSync(projectDir)
        .filter((name) => name.endsWith('.jsonl'))
        .map((name) => path.join(projectDir, name));
    })
    .filter((filePath) => {
      try {
        return fs.statSync(filePath).isFile();
      } catch {
        return false;
      }
    })
    .sort((a, b) => {
      const aMtime = fs.statSync(a).mtimeMs;
      const bMtime = fs.statSync(b).mtimeMs;
      return aMtime - bMtime;
    });
}

export function listClaudeSessionJsonlSummaries(homeDir = getDefaultClaudeHome(), limit?: number): ClaudeSessionJsonlSummary[] {
  const projectsRoot = getClaudeProjectsRoot(homeDir);
  if (!fs.existsSync(projectsRoot)) return [];
  const archived = loadArchivedClaudeSessionKeys();
  const files: string[] = [];
  for (const projectName of fs.readdirSync(projectsRoot)) {
    const projectDir = path.join(projectsRoot, projectName);
    try {
      if (!fs.statSync(projectDir).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const name of fs.readdirSync(projectDir)) {
      if (!name.endsWith('.jsonl')) continue;
      const filePath = path.join(projectDir, name);
      try {
        if (fs.statSync(filePath).isFile()) files.push(filePath);
      } catch {
        // Ignore files that disappear while scanning.
      }
    }
  }
  return files
    .map((filePath) => summarizeClaudeSessionJsonl(filePath))
    .filter((summary): summary is ClaudeSessionJsonlSummary => Boolean(summary && summary.cwd))
    .filter((summary) => !archived.has(archiveKey(summary.sessionId, summary.cwd)))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? Math.max(1, Math.floor(limit)) : undefined);
}

export function findLatestClaudeSessionJsonl(cwd: string, homeDir = getDefaultClaudeHome()): ClaudeSessionJsonlSummary | null {
  const files = listClaudeSessionJsonlFiles(cwd, homeDir);
  for (const filePath of files.slice().reverse()) {
    const summary = summarizeClaudeSessionJsonl(filePath);
    if (summary) return summary;
  }
  return null;
}

export function getClaudeSessionJsonlById(
  sessionId: string,
  cwd: string,
  homeDir = getDefaultClaudeHome(),
): ClaudeSessionJsonlSummary | null {
  const trimmedSessionId = sessionId.trim();
  if (!trimmedSessionId) return null;
  const directPath = path.join(getClaudeProjectDir(cwd, homeDir), `${trimmedSessionId}.jsonl`);
  if (fs.existsSync(directPath)) return summarizeClaudeSessionJsonl(directPath);
  return listClaudeSessionJsonlFiles(cwd, homeDir)
    .map((filePath) => summarizeClaudeSessionJsonl(filePath))
    .find((summary): summary is ClaudeSessionJsonlSummary => Boolean(summary && summary.sessionId === trimmedSessionId))
    || null;
}

export function summarizeClaudeSessionJsonl(filePath: string): ClaudeSessionJsonlSummary | null {
  let content = '';
  let stat: fs.Stats | null = null;
  try {
    stat = fs.statSync(filePath);
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }

  let sessionId = path.basename(filePath, '.jsonl');
  let cwd = '';
  let firstSeenAt = '';
  let updatedAt = stat.mtime.toISOString();
  let title = '';
  for (const line of content.split(/\r?\n/)) {
    const parsed = parseClaudeJsonlLine(line);
    if (!parsed) continue;
    if (parsed.sessionId) sessionId = parsed.sessionId;
    if (parsed.cwd) cwd = parsed.cwd;
    if (parsed.timestamp) {
      if (!firstSeenAt) firstSeenAt = parsed.timestamp;
      updatedAt = parsed.timestamp;
    }
    if (!title && parsed.type === 'user') {
      title = extractClaudeMessageText(parsed.message?.content).split(/\r?\n/)[0]?.trim() || '';
    }
  }
  if (!sessionId) return null;
  return {
    sessionId,
    filePath,
    cwd,
    firstSeenAt: firstSeenAt || stat.birthtime.toISOString(),
    updatedAt,
    title: title || sessionId.slice(0, 8),
  };
}

function parseClaudeSessionMirrorRecordDeltaText(
  content: string,
  leadingText = '',
  flushTrailingText = true,
  initialTurnId: string | null = null,
  initialState: Iterable<string> = [],
): BridgeMirrorRecordDelta {
  const combined = `${leadingText}${content}`;
  if (!combined) {
    return {
      records: [],
      nextOffset: 0,
      trailingText: '',
      nextTurnId: initialTurnId,
      nextSpecialCallIds: Array.from(initialState),
      unknownKinds: [],
    };
  }
  const hasTrailingNewline = combined.endsWith('\n') || combined.endsWith('\r');
  const rawLines = combined.split(/\r?\n/);
  let trailingText = hasTrailingNewline ? '' : (rawLines.pop() || '');
  if (flushTrailingText && trailingText) {
    rawLines.push(trailingText);
    trailingText = '';
  }
  const records: BridgeMirrorRecord[] = [];
  const state = createClaudeMirrorParserState(initialTurnId, initialState);

  for (const line of rawLines) {
    const parsed = parseClaudeJsonlLine(line);
    if (!parsed) continue;
    const signature = createSignature(line);
    const timestamp = parsed.timestamp || '';
    const blocks = contentBlocks(parsed.message?.content);

    if (parsed.type === 'attachment') {
      const inheritedRoot = findClaudeRootForLine(state, parsed);
      rememberClaudeRoot(state, parsed, inheritedRoot);
      continue;
    }

    if (parsed.type === 'user') {
      const contentText = extractClaudeMessageText(parsed.message?.content);
      const toolResults = blocks.filter((block) => isRecord(block) && block.type === 'tool_result');
      const knownRoot = findClaudeRootForToolResults(state, blocks, parsed);
      const startsUserTurn = !knownRoot && (contentText || toolResults.length === 0);
      const turnId = startsUserTurn
        ? parsed.promptId || parsed.uuid || parsed.parentUuid || parsed.sessionId || undefined
        : knownRoot || parsed.parentUuid || parsed.uuid || parsed.sessionId || undefined;
      rememberClaudeRoot(state, parsed, turnId);
      if (startsUserTurn && turnId) state.activeTurnId = turnId;
      for (const block of toolResults) {
        if (!isRecord(block)) continue;
        const toolId = typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined;
        records.push({
          signature: `claude:tool-finished:${signature}:${toolId || records.length}`,
          type: 'tool_finished',
          content: extractClaudeToolResultText(block.content),
          timestamp,
          ...(turnId ? { turnId } : {}),
          ...(toolId ? { toolId } : {}),
          isError: Boolean(block.is_error || block.isError),
        });
      }
      if (parsed.interruptedMessageId && turnId) {
        records.push({
          signature: `claude:aborted:${signature}`,
          type: 'task_aborted',
          content: contentText,
          timestamp,
          turnId,
        });
        if (!state.activeTurnId || state.activeTurnId === turnId) {
          state.activeTurnId = null;
        }
        continue;
      }
      if (startsUserTurn) {
        records.push({
          signature: `claude:start:${signature}`,
          type: 'task_started',
          content: '',
          timestamp,
          ...(turnId ? { turnId } : {}),
        });
      }
      if (contentText) {
        records.push({
          signature: `claude:user:${signature}`,
          type: 'message',
          role: 'user',
          content: contentText,
          timestamp,
          ...(turnId ? { turnId } : {}),
        });
      }
      continue;
    }

    if (parsed.type === 'assistant') {
      const turnId = findClaudeRootForLine(state, parsed) || parsed.parentUuid || parsed.uuid || parsed.sessionId || undefined;
      rememberClaudeRoot(state, parsed, turnId);
      let hasToolUse = false;
      for (const block of blocks) {
        if (!isRecord(block) || block.type !== 'tool_use') continue;
        hasToolUse = true;
        const toolId = typeof block.id === 'string' ? block.id : undefined;
        const toolName = typeof block.name === 'string' ? block.name : 'tool';
        if (toolId && turnId) state.toolUseIdToRootTurnId.set(toolId, turnId);
        records.push({
          signature: `claude:tool-started:${signature}:${toolId || records.length}`,
          type: 'tool_started',
          content: '',
          timestamp,
          ...(turnId ? { turnId } : {}),
          ...(toolId ? { toolId } : {}),
          toolName,
          toolInput: block.input,
        });
      }
      const contentText = extractClaudeMessageText(parsed.message?.content);
      if (!contentText) continue;
      records.push({
        signature: `claude:assistant:${signature}`,
        type: 'message',
        role: 'assistant',
        content: contentText,
        timestamp,
        ...(turnId ? { turnId } : {}),
      });
      if (!hasToolUse && parsed.message?.stop_reason !== 'tool_use') {
        records.push({
          signature: `claude:complete:${signature}`,
          type: 'task_complete',
          content: contentText,
          timestamp,
          ...(turnId ? { turnId } : {}),
        });
        if (!state.activeTurnId || state.activeTurnId === turnId) {
          state.activeTurnId = null;
        }
      }
    }
  }

  return {
    records,
    nextOffset: 0,
    trailingText,
    nextTurnId: state.activeTurnId,
    nextSpecialCallIds: encodeClaudeMirrorParserState(state),
    unknownKinds: [],
  };
}

export function parseClaudeSessionMirrorRecordText(content: string): BridgeMirrorRecord[] {
  return parseClaudeSessionMirrorRecordDeltaText(content).records;
}

export function readClaudeSessionMirrorRecordStreamByFilePath(filePath: string): BridgeMirrorRecord[] {
  try {
    return parseClaudeSessionMirrorRecordText(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return [];
  }
}

function readFileUtf8Range(filePath: string, startOffset: number, endOffset: number): string {
  if (endOffset <= startOffset) return '';
  const fd = fs.openSync(filePath, 'r');
  try {
    const length = endOffset - startOffset;
    const buffer = Buffer.alloc(length);
    const bytesRead = fs.readSync(fd, buffer, 0, length, startOffset);
    return buffer.subarray(0, bytesRead).toString('utf-8');
  } finally {
    fs.closeSync(fd);
  }
}

export function readClaudeSessionMirrorRecordDeltaByFilePath(
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

  const parsed = parseClaudeSessionMirrorRecordDeltaText(
    content,
    trailingText,
    false,
    currentTurnId,
    currentSpecialCallIds,
  );

  return {
    records: parsed.records,
    nextOffset: Math.max(startOffset, endOffset),
    trailingText: parsed.trailingText,
    nextTurnId: parsed.nextTurnId,
    nextSpecialCallIds: parsed.nextSpecialCallIds,
    unknownKinds: parsed.unknownKinds,
  };
}

export function createClaudeMirrorJsonlSource(homeDir = getDefaultClaudeHome()): MirrorJsonlSource {
  return {
    runtime: 'claude',
    findByThreadId(threadId: string, cwd?: string): MirrorJsonlSourceSummary | null {
      if (!cwd) return null;
      const summary = getClaudeSessionJsonlById(threadId, cwd, homeDir);
      return summary
        ? {
          threadId: summary.sessionId,
          filePath: summary.filePath,
          cwd: summary.cwd,
          updatedAt: summary.updatedAt,
        }
        : null;
    },
    readDelta(
      filePath: string,
      startOffset: number,
      endOffset: number,
      trailingText: string,
      currentTurnId: string | null,
      currentSpecialCallIds: Iterable<string>,
    ): BridgeMirrorRecordDelta {
      return readClaudeSessionMirrorRecordDeltaByFilePath(
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
