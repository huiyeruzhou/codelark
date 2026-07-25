import fs from 'node:fs';

import {
  archiveCodexSession,
  getCodexSessionByThreadId,
  listCodexSessions,
  type CodexSessionSummary,
} from '../../../runtime/codex/session-index.js';
import { resolveCodexJsonlDisplayText } from '../../../runtime/codex/session-index/internal-control-events.js';
import {
  archiveClaudeSessionJsonl,
  getClaudeSessionJsonlById,
  listClaudeSessionJsonlSummaries,
} from '../../../runtime/claude/session-jsonl.js';
import {
  archiveKimiSessionFile,
  findKimiSessionFileById,
  listKimiSessionFileSummaries,
} from '../../../runtime/kimi/session-index.js';
import {
  archiveCursorSessionFile,
  findCursorSessionFileById,
  listCursorSessionFileSummaries,
} from '../../../runtime/cursor/session-index.js';
import type { LocalRuntimeSessionSummary } from '../local-runtime-session.js';
import { validateSessionId } from '../../../shared/security/validators.js';
import { userInputTurnCountCache } from './user-input-turn-cache.js';

export type { CodexSessionSummary };
export type { LocalRuntimeSessionSummary };

export type LocalRuntimeFilter = 'codex' | 'claude' | 'kimi' | 'cursor';

function isSafeLocalRuntimeThreadId(id: string): boolean {
  const trimmed = id.trim();
  return validateSessionId(trimmed)
    || /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(trimmed);
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
  if ('message' in record) collectText(record.message, parts, depth + 1);
}

function textOf(value: unknown): string {
  const parts: string[] = [];
  collectText(value, parts);
  return parts.join('\n').trim();
}

function isInternalUserInput(text: string): boolean {
  return resolveCodexJsonlDisplayText(text).kind !== 'text'
    || /<codex_internal_context\b|source="goal"|source='goal'|Codex context/i.test(text);
}

function isCodexUserInputLine(line: string): boolean {
  try {
    const parsed = JSON.parse(line) as any;
    const payload = parsed?.payload;
    const isUserMessage = payload?.type === 'user_message'
      || (payload?.type === 'message' && payload?.role === 'user');
    if (!isUserMessage) return false;
    const text = textOf(payload?.user_prompt ?? payload?.userPrompt ?? payload?.message ?? payload?.content);
    return Boolean(text && !isInternalUserInput(text));
  } catch {
    return false;
  }
}

function isClaudeUserInputLine(line: string): boolean {
  try {
    const parsed = JSON.parse(line) as any;
    if (parsed?.type !== 'user') return false;
    const blocks = Array.isArray(parsed?.message?.content)
      ? parsed.message.content
      : parsed?.message?.content == null
        ? []
        : [parsed.message.content];
    if (blocks.length > 0 && blocks.every((block: any) => block?.type === 'tool_result')) return false;
    const text = textOf(parsed?.message?.content);
    return Boolean(text && !isInternalUserInput(text));
  } catch {
    return false;
  }
}

function isKimiUserInputLine(line: string): boolean {
  try {
    const parsed = JSON.parse(line) as any;
    if (parsed?.type !== 'context.append_message' || parsed?.message?.role !== 'user') return false;
    const text = textOf(parsed?.message?.content);
    return Boolean(text && !isInternalUserInput(text));
  } catch {
    return false;
  }
}

function countCursorUserInputTurns(filePath: string): number | undefined {
  try {
    let count = 0;
    for (const line of fs.readFileSync(filePath, 'utf-8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (parsed?.role !== 'user') continue;
      const text = textOf(parsed?.message?.content);
      if (!text || isInternalUserInput(text)) continue;
      count += 1;
    }
    return count;
  } catch {
    return undefined;
  }
}

function toCodexRuntimeSession(session: CodexSessionSummary): LocalRuntimeSessionSummary {
  return {
    ...session,
    runtime: 'codex',
    userInputTurns: userInputTurnCountCache.get('codex', session.filePath, isCodexUserInputLine),
  };
}

function listCommandClaudeThreads(limit?: number): LocalRuntimeSessionSummary[] {
  return listClaudeSessionJsonlSummaries(undefined, limit).map(toClaudeRuntimeSession);
}

function toClaudeRuntimeSession(session: ReturnType<typeof listClaudeSessionJsonlSummaries>[number]): LocalRuntimeSessionSummary {
  return {
    runtime: 'claude',
    threadId: session.sessionId,
    filePath: session.filePath,
    cwd: session.cwd,
    originator: 'Claude Code',
    source: 'claude',
    firstSeenAt: session.firstSeenAt,
    lastEventAt: session.updatedAt,
    title: session.title || session.sessionId.slice(0, 8),
    activeEstimate: false,
    userInputTurns: userInputTurnCountCache.get('claude', session.filePath, isClaudeUserInputLine),
  };
}

function listCommandKimiThreads(limit?: number): LocalRuntimeSessionSummary[] {
  return listKimiSessionFileSummaries(undefined, limit).map(toKimiRuntimeSession);
}

function toKimiRuntimeSession(session: ReturnType<typeof listKimiSessionFileSummaries>[number]): LocalRuntimeSessionSummary {
  return {
    runtime: 'kimi',
    threadId: session.sessionId,
    filePath: session.filePath,
    cwd: session.cwd || '',
    originator: 'Kimi Code',
    source: 'kimi',
    firstSeenAt: session.firstSeenAt || session.updatedAt || new Date(0).toISOString(),
    lastEventAt: session.updatedAt || session.firstSeenAt || new Date(0).toISOString(),
    title: session.title || session.sessionId.slice(0, 8),
    activeEstimate: false,
    userInputTurns: userInputTurnCountCache.get('kimi', session.filePath, isKimiUserInputLine),
  };
}

function listCommandCursorThreads(limit?: number): LocalRuntimeSessionSummary[] {
  return listCursorSessionFileSummaries(undefined, limit).map(toCursorRuntimeSession);
}

function toCursorRuntimeSession(session: ReturnType<typeof listCursorSessionFileSummaries>[number]): LocalRuntimeSessionSummary {
  return {
    runtime: 'cursor',
    threadId: session.sessionId,
    filePath: session.filePath || session.storePath,
    cwd: session.cwd || '',
    originator: 'Cursor Agent',
    source: 'cursor',
    firstSeenAt: session.createdAt || session.updatedAt || new Date(0).toISOString(),
    lastEventAt: session.updatedAt || session.createdAt || new Date(0).toISOString(),
    title: session.title || session.sessionId.slice(0, 8),
    activeEstimate: false,
    userInputTurns: session.filePath ? countCursorUserInputTurns(session.filePath) : undefined,
  };
}

function sortRuntimeSessionsByActivity(sessions: LocalRuntimeSessionSummary[]): LocalRuntimeSessionSummary[] {
  return sessions.sort((left, right) => right.lastEventAt.localeCompare(left.lastEventAt));
}

export function listCommandCodexThreads(limit?: number): CodexSessionSummary[] | null {
  try {
    return listCodexSessions(limit);
  } catch (error) {
    console.error('[command-session-source] Failed to list Codex sessions:', error);
    return null;
  }
}

export function listCommandLocalRuntimeSessions(limit?: number, runtime?: LocalRuntimeFilter): LocalRuntimeSessionSummary[] | null {
  try {
    const codex = runtime && runtime !== 'codex' ? [] : listCodexSessions(limit).map(toCodexRuntimeSession);
    const claude = runtime && runtime !== 'claude' ? [] : listCommandClaudeThreads(limit);
    const kimi = runtime && runtime !== 'kimi' ? [] : listCommandKimiThreads(limit);
    const cursor = runtime && runtime !== 'cursor' ? [] : listCommandCursorThreads(limit);
    return sortRuntimeSessionsByActivity([...codex, ...claude, ...kimi, ...cursor])
      .slice(0, typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? Math.max(1, Math.floor(limit)) : undefined);
  } catch (error) {
    console.error('[command-session-source] Failed to list local runtime sessions:', error);
    return null;
  }
}

export function archiveCommandCodexThread(threadId: string): CodexSessionSummary | null {
  try {
    return archiveCodexSession(threadId);
  } catch (error) {
    console.error(`[command-session-source] Failed to archive Codex thread ${threadId}:`, error);
    return null;
  }
}

export function archiveCommandClaudeThread(threadId: string, cwd: string | undefined): LocalRuntimeSessionSummary | null {
  if (!cwd) return null;
  try {
    const session = getClaudeSessionJsonlById(threadId, cwd);
    if (!session) return null;
    archiveClaudeSessionJsonl(session);
    return {
      runtime: 'claude',
      threadId: session.sessionId,
      filePath: session.filePath,
      cwd: session.cwd,
      originator: 'Claude Code',
      source: 'claude',
      firstSeenAt: session.firstSeenAt,
      lastEventAt: session.updatedAt,
      title: session.title || session.sessionId.slice(0, 8),
      activeEstimate: false,
      userInputTurns: userInputTurnCountCache.get('claude', session.filePath, isClaudeUserInputLine),
    };
  } catch (error) {
    console.error(`[command-session-source] Failed to archive Claude thread ${threadId}:`, error);
    return null;
  }
}

export function archiveCommandKimiThread(threadId: string, cwd: string | undefined): LocalRuntimeSessionSummary | null {
  if (!cwd) return null;
  try {
    const session = findKimiSessionFileById(threadId, cwd);
    if (!session) return null;
    archiveKimiSessionFile(session);
    return toKimiRuntimeSession(session);
  } catch (error) {
    console.error(`[command-session-source] Failed to archive Kimi thread ${threadId}:`, error);
    return null;
  }
}

export function archiveCommandCursorThread(threadId: string, cwd: string | undefined): LocalRuntimeSessionSummary | null {
  if (!cwd) return null;
  try {
    const session = findCursorSessionFileById(threadId, cwd);
    if (!session || !archiveCursorSessionFile(session)) return null;
    return toCursorRuntimeSession(session);
  } catch (error) {
    console.error(`[command-session-source] Failed to archive Cursor thread ${threadId}:`, error);
    return null;
  }
}

export function getCommandCodexThreadByIdSafe(
  rawThreadId: string,
  context: string,
): { threadId?: string; thread?: CodexSessionSummary } {
  const threadId = rawThreadId.trim();
  if (!validateSessionId(threadId)) return {};

  try {
    return {
      threadId,
      thread: getCodexSessionByThreadId(threadId) || undefined,
    };
  } catch (error) {
    console.error(
      `[command-session-source] Failed to load Codex thread ${threadId} during ${context}:`,
      error,
    );
    return { threadId };
  }
}

export function getCommandLocalRuntimeThreadByIdSafe(
  rawThreadId: string,
  cwd: string | undefined,
  context: string,
): { threadId?: string; thread?: LocalRuntimeSessionSummary } {
  const threadId = rawThreadId.trim();
  if (!isSafeLocalRuntimeThreadId(threadId)) return {};

  try {
    const codex = getCodexSessionByThreadId(threadId);
    if (codex) return { threadId, thread: toCodexRuntimeSession(codex) };
    if (cwd) {
      const claude = getClaudeSessionJsonlById(threadId, cwd);
      if (claude) {
        return { threadId, thread: toClaudeRuntimeSession(claude) };
      }
      const kimi = findKimiSessionFileById(threadId, cwd);
      if (kimi) {
        return { threadId, thread: toKimiRuntimeSession(kimi) };
      }
      const cursor = findCursorSessionFileById(threadId, cwd);
      if (cursor) {
        return { threadId, thread: toCursorRuntimeSession(cursor) };
      }
    }
    const claudeMatches = listClaudeSessionJsonlSummaries()
      .filter((session) => session.sessionId === threadId);
    if (claudeMatches.length === 1) {
      return { threadId, thread: toClaudeRuntimeSession(claudeMatches[0]) };
    }
    const kimi = findKimiSessionFileById(threadId);
    if (kimi) {
      return { threadId, thread: toKimiRuntimeSession(kimi) };
    }
    const cursor = findCursorSessionFileById(threadId);
    if (cursor) {
      return { threadId, thread: toCursorRuntimeSession(cursor) };
    }
    return { threadId };
  } catch (error) {
    console.error(
      `[command-session-source] Failed to load runtime session ${threadId} during ${context}:`,
      error,
    );
    return { threadId };
  }
}
