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
import type { LocalRuntimeSessionSummary } from '../local-runtime-session.js';
import { validateSessionId } from '../../../shared/security/validators.js';

export type { CodexSessionSummary };
export type { LocalRuntimeSessionSummary };

export type LocalRuntimeFilter = 'codex' | 'claude';

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

function countCodexUserInputTurns(filePath: string): number | undefined {
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
      const payload = parsed?.payload;
      const isUserMessage = payload?.type === 'user_message'
        || (payload?.type === 'message' && payload?.role === 'user');
      if (!isUserMessage) continue;
      const text = textOf(payload?.user_prompt ?? payload?.userPrompt ?? payload?.message ?? payload?.content);
      if (!text || isInternalUserInput(text)) continue;
      count += 1;
    }
    return count;
  } catch {
    return undefined;
  }
}

function countClaudeUserInputTurns(filePath: string): number | undefined {
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
      if (parsed?.type !== 'user') continue;
      const blocks = Array.isArray(parsed?.message?.content)
        ? parsed.message.content
        : parsed?.message?.content == null
          ? []
          : [parsed.message.content];
      if (blocks.length > 0 && blocks.every((block: any) => block?.type === 'tool_result')) continue;
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
  return { ...session, runtime: 'codex', userInputTurns: countCodexUserInputTurns(session.filePath) };
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
    userInputTurns: countClaudeUserInputTurns(session.filePath),
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
    const codex = runtime === 'claude' ? [] : listCodexSessions(limit).map(toCodexRuntimeSession);
    const claude = runtime === 'codex' ? [] : listCommandClaudeThreads(limit);
    return sortRuntimeSessionsByActivity([...codex, ...claude])
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
      userInputTurns: countClaudeUserInputTurns(session.filePath),
    };
  } catch (error) {
    console.error(`[command-session-source] Failed to archive Claude thread ${threadId}:`, error);
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
  if (!validateSessionId(threadId)) return {};

  try {
    const codex = getCodexSessionByThreadId(threadId);
    if (codex) return { threadId, thread: toCodexRuntimeSession(codex) };
    if (cwd) {
      const claude = getClaudeSessionJsonlById(threadId, cwd);
      if (claude) {
        return { threadId, thread: toClaudeRuntimeSession(claude) };
      }
    }
    const claudeMatches = listClaudeSessionJsonlSummaries()
      .filter((session) => session.sessionId === threadId);
    if (claudeMatches.length === 1) {
      return { threadId, thread: toClaudeRuntimeSession(claudeMatches[0]) };
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
