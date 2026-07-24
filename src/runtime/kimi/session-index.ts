import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { CODELARK_HOME } from '../../configuration/paths.js';
import type {
  BridgeMirrorRecord,
  BridgeMirrorRecordDelta,
  MirrorJsonlSource,
  MirrorJsonlSourceSummary,
} from '../contracts.js';
import {
  buildToolCallDetailFromInput,
} from '../../shared/progress/tool-call-details.js';

export interface KimiSessionFileSummary {
  sessionId: string;
  filePath: string;
  cwd?: string;
  title?: string;
  firstSeenAt?: string;
  updatedAt?: string;
}

interface KimiSessionIndexEntry {
  sessionId?: string;
  sessionDir?: string;
  workDir?: string;
}

interface KimiSessionState {
  createdAt?: string;
  updatedAt?: string;
  title?: string;
  lastPrompt?: string;
}

interface ArchivedKimiSessionEntry {
  sessionId: string;
  cwd: string;
  archivedAt: string;
  filePath?: string;
  title?: string;
}

function getKimiHome(): string {
  return process.env.KIMI_CODE_HOME
    || path.join(os.homedir(), '.kimi-code');
}

export function getKimiSessionsRoot(): string {
  return path.join(getKimiHome(), 'sessions');
}

function getKimiSessionIndexPath(): string {
  return path.join(getKimiHome(), 'session_index.jsonl');
}

function sha256Hex(value: string, length = 12): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, length);
}

function archiveKey(sessionId: string, cwd: string): string {
  return `${path.resolve(cwd)}\0${sessionId.trim()}`;
}

function archivedKimiSessionsPath(): string {
  return path.join(CODELARK_HOME, 'data', 'archived-kimi-sessions.json');
}

function readArchivedKimiSessionEntries(): ArchivedKimiSessionEntry[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(archivedKimiSessionsPath(), 'utf-8')) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is ArchivedKimiSessionEntry => (
      typeof entry === 'object'
      && entry !== null
      && typeof (entry as ArchivedKimiSessionEntry).sessionId === 'string'
      && typeof (entry as ArchivedKimiSessionEntry).cwd === 'string'
      && typeof (entry as ArchivedKimiSessionEntry).archivedAt === 'string'
    ));
  } catch {
    return [];
  }
}

function writeArchivedKimiSessionEntries(entries: ArchivedKimiSessionEntry[]): void {
  const archivePath = archivedKimiSessionsPath();
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  fs.writeFileSync(archivePath, JSON.stringify(entries, null, 2) + '\n', 'utf-8');
}

export function loadArchivedKimiSessionKeys(): Set<string> {
  return new Set(readArchivedKimiSessionEntries().map((entry) => archiveKey(entry.sessionId, entry.cwd)));
}

export function isArchivedKimiSession(sessionId: string, cwd: string): boolean {
  return loadArchivedKimiSessionKeys().has(archiveKey(sessionId, cwd));
}

export function archiveKimiSessionFile(session: Pick<KimiSessionFileSummary, 'sessionId' | 'cwd' | 'filePath' | 'title'>): boolean {
  const sessionId = session.sessionId.trim();
  const cwd = session.cwd?.trim();
  if (!sessionId || !cwd) return false;
  const entries = readArchivedKimiSessionEntries();
  const key = archiveKey(sessionId, cwd);
  if (entries.some((entry) => archiveKey(entry.sessionId, entry.cwd) === key)) return true;
  entries.push({
    sessionId,
    cwd,
    archivedAt: new Date().toISOString(),
    ...(session.filePath ? { filePath: session.filePath } : {}),
    ...(session.title ? { title: session.title } : {}),
  });
  writeArchivedKimiSessionEntries(entries);
  return true;
}

export function computeKimiWorkspaceDirName(cwd: string): string {
  const resolved = path.resolve(cwd || process.cwd());
  const basename = path.basename(resolved) || resolved;
  const hash = sha256Hex(resolved, 12);
  return `wd_${basename}_${hash}`;
}

function listWorkspaceDirs(): string[] {
  const root = getKimiSessionsRoot();
  try {
    return fs.readdirSync(root)
      .filter((name) => name.startsWith('wd_'))
      .map((name) => path.join(root, name));
  } catch {
    return [];
  }
}

function listSessionDirs(workspaceDir: string): string[] {
  try {
    return fs.readdirSync(workspaceDir)
      .filter((name) => name.startsWith('session_'))
      .map((name) => path.join(workspaceDir, name))
      .filter((dir) => fs.statSync(dir).isDirectory());
  } catch {
    return [];
  }
}

function getKimiWireJsonlPath(sessionDir: string): string {
  return path.join(sessionDir, 'agents', 'main', 'wire.jsonl');
}

function readKimiSessionIndexEntries(): KimiSessionIndexEntry[] {
  const indexPath = getKimiSessionIndexPath();
  try {
    return fs.readFileSync(indexPath, 'utf-8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as KimiSessionIndexEntry;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is KimiSessionIndexEntry => Boolean(entry?.sessionId && entry.sessionDir));
  } catch {
    return [];
  }
}

function readKimiSessionState(sessionDir: string): KimiSessionState {
  try {
    return JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8')) as KimiSessionState;
  } catch {
    return {};
  }
}

function readFileRange(filePath: string, startOffset: number, endOffset: number): string {
  const length = Math.max(0, endOffset - startOffset);
  if (length === 0) return '';
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = fs.readSync(fd, buffer, 0, length, startOffset);
    return buffer.subarray(0, bytesRead).toString('utf-8');
  } finally {
    fs.closeSync(fd);
  }
}

function summarizeKimiSessionDir(
  sessionDir: string,
  cwd?: string,
): KimiSessionFileSummary | null {
  const filePath = getKimiWireJsonlPath(sessionDir);
  if (!fs.existsSync(filePath)) return null;
  const sessionId = path.basename(sessionDir);
  const state = readKimiSessionState(sessionDir);
  let updatedAt = state.updatedAt;
  let firstSeenAt = state.createdAt;
  if (!updatedAt || !firstSeenAt) {
    try {
      const stat = fs.statSync(filePath);
      updatedAt ||= new Date(stat.mtimeMs).toISOString();
      firstSeenAt ||= new Date(stat.birthtimeMs || stat.ctimeMs).toISOString();
    } catch {
      // Keep absent timestamps absent.
    }
  }
  return {
    sessionId,
    filePath,
    ...(cwd ? { cwd } : {}),
    ...(state.title ? { title: state.title } : state.lastPrompt ? { title: state.lastPrompt } : {}),
    ...(firstSeenAt ? { firstSeenAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  };
}

export function findKimiSessionFileById(sessionId: string, cwd?: string): KimiSessionFileSummary | null {
  if (!sessionId) return null;
  const resolvedCwd = cwd ? path.resolve(cwd) : undefined;
  for (const entry of readKimiSessionIndexEntries()) {
    if (entry.sessionId !== sessionId || !entry.sessionDir) continue;
    if (resolvedCwd && entry.workDir && path.resolve(entry.workDir) !== resolvedCwd) continue;
    const summary = summarizeKimiSessionDir(entry.sessionDir, entry.workDir || cwd);
    if (summary) return summary;
  }
  for (const workspaceDir of listWorkspaceDirs()) {
    if (resolvedCwd && path.basename(workspaceDir) !== computeKimiWorkspaceDirName(resolvedCwd)) continue;
    for (const sessionDir of listSessionDirs(workspaceDir)) {
      const basename = path.basename(sessionDir);
      if (basename !== sessionId && !basename.endsWith(`-${sessionId}`)) continue;
      const summary = summarizeKimiSessionDir(sessionDir, cwd);
      if (summary) return summary;
    }
  }
  return null;
}

export function findLatestKimiSessionFile(cwd?: string): KimiSessionFileSummary | null {
  let candidates: Array<KimiSessionFileSummary & { mtimeMs: number }> = [];
  const expectedWorkspace = cwd ? computeKimiWorkspaceDirName(cwd) : undefined;

  for (const workspaceDir of listWorkspaceDirs()) {
    if (expectedWorkspace && path.basename(workspaceDir) !== expectedWorkspace) continue;
    for (const sessionDir of listSessionDirs(workspaceDir)) {
      const filePath = getKimiWireJsonlPath(sessionDir);
      try {
        const stat = fs.statSync(filePath);
        const summary = summarizeKimiSessionDir(sessionDir, cwd);
        if (summary) candidates.push({ ...summary, mtimeMs: stat.mtimeMs });
      } catch {
        // ignore races
      }
    }
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const latest = candidates[0];
  if (!latest) return null;
  const { mtimeMs: _mtimeMs, ...summary } = latest;
  return summary;
}

export function listKimiSessionFileSummaries(cwd?: string, limit?: number): KimiSessionFileSummary[] {
  const resolvedCwd = cwd ? path.resolve(cwd) : undefined;
  const archived = loadArchivedKimiSessionKeys();
  const bySessionDir = new Map<string, string | undefined>();
  for (const entry of readKimiSessionIndexEntries()) {
    if (!entry.sessionDir || !entry.sessionId) continue;
    if (resolvedCwd && entry.workDir && path.resolve(entry.workDir) !== resolvedCwd) continue;
    bySessionDir.set(path.resolve(entry.sessionDir), entry.workDir);
  }
  for (const workspaceDir of listWorkspaceDirs()) {
    if (resolvedCwd && path.basename(workspaceDir) !== computeKimiWorkspaceDirName(resolvedCwd)) continue;
    for (const sessionDir of listSessionDirs(workspaceDir)) {
      const resolvedSessionDir = path.resolve(sessionDir);
      if (!bySessionDir.has(resolvedSessionDir)) {
        bySessionDir.set(resolvedSessionDir, cwd);
      }
    }
  }

  const sessions: Array<KimiSessionFileSummary & { sortTime: string }> = [];
  for (const [sessionDir, workDir] of bySessionDir) {
    const summary = summarizeKimiSessionDir(sessionDir, workDir);
    if (!summary) continue;
    if (summary.cwd && archived.has(archiveKey(summary.sessionId, summary.cwd))) continue;
    sessions.push({
      ...summary,
      sortTime: summary.updatedAt || summary.firstSeenAt || '',
    });
  }

  sessions.sort((left, right) => right.sortTime.localeCompare(left.sortTime));
  return sessions
    .slice(0, typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? Math.max(1, Math.floor(limit)) : undefined)
    .map(({ sortTime: _sortTime, ...summary }) => summary);
}

function textContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (part && typeof part === 'object') {
          return typeof (part as { text?: unknown }).text === 'string'
            ? (part as { text: string }).text
            : '';
        }
        return '';
      })
      .join('');
  }
  return '';
}

interface KimiLoopEvent {
  type?: string;
  uuid?: string;
  turnId?: string;
  step?: number;
  stepUuid?: string;
  toolCallId?: string;
  parentUuid?: string;
  name?: string;
  description?: string;
  args?: unknown;
  result?: { output?: unknown; error?: unknown; isError?: boolean };
  part?: { type?: string; think?: string; text?: string };
  usage?: {
    inputOther?: number;
    output?: number;
    inputCacheRead?: number;
    inputCacheCreation?: number;
  };
  finishReason?: string;
}

interface KimiWireLine {
  type?: string;
  time?: number;
  event?: KimiLoopEvent;
  message?: {
    role?: string;
    content?: unknown;
    toolCalls?: unknown[];
  };
  goalId?: string;
  objective?: string;
  turnsUsed?: number;
  tokensUsed?: number;
  usage?: KimiLoopEvent['usage'];
}

function toIsoTimestamp(time?: number): string {
  if (typeof time === 'number') {
    return new Date(time).toISOString();
  }
  return new Date().toISOString();
}

function parseKimiWireLine(line: string): KimiWireLine | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as KimiWireLine;
  } catch {
    return null;
  }
}

function splitCompleteKimiWireText(rawText: string): { completeText: string; trailingText: string } {
  if (!rawText || /\r?\n$/.test(rawText)) return { completeText: rawText, trailingText: '' };
  const lines = rawText.split(/\r?\n/);
  const lastLine = lines.at(-1) || '';
  if (!lastLine.trim() || parseKimiWireLine(lastLine)) return { completeText: rawText, trailingText: '' };
  lines.pop();
  return { completeText: lines.join('\n'), trailingText: lastLine };
}

export function parseKimiWireRecords(
  rawText: string,
  emittedSignatures: Set<string>,
): BridgeMirrorRecord[] {
  const records: BridgeMirrorRecord[] = [];
  const lines = rawText.split(/\r?\n/);

  for (const line of lines) {
    const parsed = parseKimiWireLine(line);
    if (!parsed) continue;

    const baseSignature = `${parsed.type}:${parsed.time || Date.now()}`;
    const ensureUnique = (suffix: string): string => {
      let signature = `${baseSignature}:${suffix}`;
      let counter = 0;
      while (emittedSignatures.has(signature)) {
        counter += 1;
        signature = `${baseSignature}:${suffix}:${counter}`;
      }
      emittedSignatures.add(signature);
      return signature;
    };

    switch (parsed.type) {
      case 'context.append_message': {
        const role = parsed.message?.role;
        const content = textContent(parsed.message?.content);
        if (!content) continue;
        records.push({
          signature: ensureUnique(`msg:${role}`),
          type: 'message',
          role: role === 'assistant' ? 'assistant' : role === 'user' ? 'user' : 'commentary',
          content,
          timestamp: toIsoTimestamp(parsed.time),
        });
        break;
      }

      case 'context.append_loop_event': {
        const ev = parsed.event;
        if (!ev) continue;

        switch (ev.type) {
          case 'step.begin': {
            records.push({
              signature: ensureUnique(`step.begin:${ev.stepUuid || ev.uuid}`),
              type: 'task_started',
              content: '',
              timestamp: toIsoTimestamp(parsed.time),
              turnId: ev.turnId,
            });
            break;
          }

          case 'content.part': {
            const part = ev.part;
            if (!part) continue;
            if (part.type === 'think' && part.think) {
              records.push({
                signature: ensureUnique(`think:${part.think.slice(0, 40)}`),
                type: 'reasoning',
                reasoningKind: 'thinking',
                reasoningLabel: '思考',
                content: part.think,
                timestamp: toIsoTimestamp(parsed.time),
                turnId: ev.turnId,
              });
              break;
            }
            if (part.type === 'text' && part.text) {
              records.push({
                signature: ensureUnique(`text:${part.text.slice(0, 40)}`),
                type: 'message',
                role: 'assistant',
                content: part.text,
                timestamp: toIsoTimestamp(parsed.time),
                turnId: ev.turnId,
              });
            }
            break;
          }

          case 'tool.call': {
            if (!ev.toolCallId) continue;
            const toolName = ev.name || 'tool';
            records.push({
              signature: ensureUnique(`tool.call:${ev.toolCallId}`),
              type: 'tool_started',
              content: ev.description || '',
              timestamp: toIsoTimestamp(parsed.time),
              turnId: ev.turnId,
              toolId: ev.toolCallId,
              toolName,
              toolInput: ev.args,
              toolDetail: buildToolCallDetailFromInput(toolName, ev.args) || undefined,
            });
            break;
          }

          case 'tool.result': {
            if (!ev.toolCallId) continue;
            const rawOutput = typeof ev.result?.output !== 'undefined'
              ? ev.result.output
              : ev.result?.error ?? '';
            const output = typeof rawOutput === 'string'
              ? rawOutput
              : JSON.stringify(rawOutput);
            records.push({
              signature: ensureUnique(`tool.result:${ev.toolCallId}`),
              type: 'tool_finished',
              content: output,
              timestamp: toIsoTimestamp(parsed.time),
              turnId: ev.turnId,
              toolId: ev.toolCallId,
              isError: ev.result?.isError === true || typeof ev.result?.error !== 'undefined',
            });
            break;
          }

          case 'step.end': {
            // Kimi 每个 agentic loop step 都会写 step.end；只有终态 step 才代表 turn 结束。
            // finishReason "tool_use" 表示 step 为了调用工具而结束，turn 仍在继续。
            const finishReason = typeof ev.finishReason === 'string' ? ev.finishReason : '';
            if (finishReason === 'tool_use') break;
            records.push({
              signature: ensureUnique(`step.end:${ev.stepUuid || ev.uuid}`),
              type: finishReason && finishReason !== 'end_turn' ? 'task_aborted' : 'task_complete',
              content: '',
              timestamp: toIsoTimestamp(parsed.time),
              turnId: ev.turnId,
            });
            break;
          }
        }
        break;
      }

      case 'turn.cancel': {
        // 用户取消当前 turn；turn.cancel 不带 turnId，终止当前 pending turn 即可。
        records.push({
          signature: ensureUnique('turn.cancel'),
          type: 'task_aborted',
          content: '',
          timestamp: toIsoTimestamp(parsed.time),
        });
        break;
      }

      case 'usage.record': {
        const usage = parsed.usage;
        if (!usage) continue;
        records.push({
          signature: ensureUnique('usage'),
          type: 'context_usage',
          content: '',
          timestamp: toIsoTimestamp(parsed.time),
          contextUsage: {
            lastTokenUsage: {
              inputTokens: (usage.inputOther ?? 0) + (usage.inputCacheCreation ?? 0),
              outputTokens: usage.output ?? 0,
              cachedInputTokens: usage.inputCacheRead ?? 0,
            },
          },
        });
        break;
      }

      case 'goal.create': {
        if (parsed.objective) {
          records.push({
            signature: ensureUnique('goal.create'),
            type: 'goal_status',
            content: parsed.objective,
            timestamp: toIsoTimestamp(parsed.time),
            goalObjective: parsed.objective,
            goalStatus: 'created',
          });
        }
        break;
      }

      case 'goal.update': {
        records.push({
          signature: ensureUnique('goal.update'),
          type: 'goal_status',
          content: `turns used: ${parsed.turnsUsed ?? '?'}`,
          timestamp: toIsoTimestamp(parsed.time),
          goalStatus: 'active',
        });
        break;
      }

      case 'goal.clear': {
        records.push({
          signature: ensureUnique('goal.clear'),
          type: 'goal_status',
          content: '',
          timestamp: toIsoTimestamp(parsed.time),
          goalStatus: 'cleared',
        });
        break;
      }
    }
  }

  return records;
}

export function readKimiSessionMirrorRecordStreamByFilePath(filePath: string): BridgeMirrorRecord[] {
  const emittedSignatures = new Set<string>();
  try {
    return parseKimiWireRecords(fs.readFileSync(filePath, 'utf-8'), emittedSignatures);
  } catch {
    return [];
  }
}

export function readKimiSessionMessagesByFilePath(
  filePath: string,
  limit: number,
): Array<{ role: string; content: string }> {
  return readKimiSessionMirrorRecordStreamByFilePath(filePath)
    .filter((record) => record.type === 'message' && record.role !== 'user' && record.content.trim())
    .map((record) => ({
      role: record.role || 'assistant',
      content: record.content,
    }))
    .slice(-Math.max(0, Math.floor(limit)));
}

function nextKimiDeltaTurnId(records: BridgeMirrorRecord[], currentTurnId: string | null): string | null {
  let activeTurnId = currentTurnId;
  for (const record of records) {
    if (record.type === 'task_complete' || record.type === 'task_aborted') {
      const completedTurnId = record.turnId || activeTurnId;
      if (!completedTurnId || completedTurnId === activeTurnId) {
        activeTurnId = null;
      }
      continue;
    }
    if (record.turnId) activeTurnId = record.turnId;
  }
  return activeTurnId;
}

export function readKimiSessionMirrorRecordDeltaByFilePath(
  filePath: string,
  startOffset: number,
  endOffset: number,
  trailingText: string,
  currentTurnId: string | null,
  currentSpecialCallIds: Iterable<string>,
): BridgeMirrorRecordDelta {
  let chunk = '';
  try {
    chunk = readFileRange(filePath, startOffset, endOffset);
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
  const split = splitCompleteKimiWireText(`${trailingText || ''}${chunk}`);
  const emittedSignatures = new Set<string>();
  const records = parseKimiWireRecords(split.completeText, emittedSignatures);

  return {
    records,
    nextOffset: Math.max(startOffset, endOffset),
    trailingText: split.trailingText,
    nextTurnId: nextKimiDeltaTurnId(records, currentTurnId),
    nextSpecialCallIds: Array.from(currentSpecialCallIds),
    unknownKinds: [],
  };
}

export function createKimiMirrorJsonlSource(): MirrorJsonlSource {
  return {
    runtime: 'kimi',
    findByThreadId(threadId: string, cwd?: string): MirrorJsonlSourceSummary | null {
      const summary = findKimiSessionFileById(threadId, cwd);
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
      return readKimiSessionMirrorRecordDeltaByFilePath(
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
