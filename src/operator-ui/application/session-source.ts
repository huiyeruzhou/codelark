import { readConfiguredCodexModel } from '../../runtime/codex/models.js';
import {
  archiveClaudeSessionJsonl,
  getClaudeSessionJsonlById,
  listClaudeSessionJsonlSummaries,
  readClaudeSessionMirrorRecordStreamByFilePath,
  type ClaudeSessionJsonlSummary,
} from '../../runtime/claude/session-jsonl.js';
import type { LocalRuntimeSessionSummary } from '../../bridge/session/local-runtime-session.js';
import {
  archiveCodexSession,
  type CodexSessionJsonlHistoryEntry,
  type CodexSessionSummary,
  getCodexSessionByThreadId,
  getCodexSessionsRoot,
  listCodexSessions,
  readCodexSessionJsonlHistoryStreamByFilePath,
} from '../../runtime/codex/session-index.js';
import { SessionRegistryService } from '../../bridge/session/registry.js';
import type { JsonFileStore } from '../../storage/json-store.js';

export interface UiSessionCodexSource {
  listSessions(): CodexSessionSummary[];
  getSessionsRoot(): string;
  getThread(codexThreadId: string): CodexSessionSummary | null;
  readJsonlHistory(codexThreadId: string): CodexSessionJsonlHistoryEntry[];
  archiveThread(codexThreadId: string): boolean;
  readDefaultModel(): string | null | undefined;
  defaultWorkingDirectory(): string;
}

export interface UiSessionClaudeSource {
  listSessions(): ClaudeSessionJsonlSummary[];
  getThread(claudeSessionId: string, cwd: string): ClaudeSessionJsonlSummary | null;
  readJsonlHistory(claudeSessionId: string, cwd: string): CodexSessionJsonlHistoryEntry[];
  archiveThread(claudeSessionId: string, cwd: string): boolean;
}

export interface UiSessionRuntimeSource {
  listSessions(): LocalRuntimeSessionSummary[];
  getThread(runtime: 'codex' | 'claude', threadId: string, cwd?: string): LocalRuntimeSessionSummary | null;
  readJsonlHistory(runtime: 'codex' | 'claude', threadId: string, cwd?: string): CodexSessionJsonlHistoryEntry[];
  archiveThread(runtime: 'codex' | 'claude', threadId: string, cwd?: string): boolean;
  getSessionsRoot(): string;
  readDefaultModel(): string | null | undefined;
  defaultWorkingDirectory(): string;
}

export const defaultUiSessionCodexSource: UiSessionCodexSource = {
  listSessions: listCodexSessions,
  getSessionsRoot: getCodexSessionsRoot,
  getThread: getCodexSessionByThreadId,
  readJsonlHistory(codexThreadId) {
    const session = getCodexSessionByThreadId(codexThreadId);
    return session ? readCodexSessionJsonlHistoryStreamByFilePath(session.filePath) : [];
  },
  archiveThread(codexThreadId) {
    return Boolean(archiveCodexSession(codexThreadId));
  },
  readDefaultModel: readConfiguredCodexModel,
  defaultWorkingDirectory: () => process.cwd(),
};

export const defaultUiSessionClaudeSource: UiSessionClaudeSource = {
  listSessions: () => listClaudeSessionJsonlSummaries(),
  getThread: (claudeSessionId, cwd) => getClaudeSessionJsonlById(claudeSessionId, cwd),
  readJsonlHistory(claudeSessionId, cwd) {
    const session = getClaudeSessionJsonlById(claudeSessionId, cwd);
    if (!session) return [];
    return readClaudeSessionMirrorRecordStreamByFilePath(session.filePath)
      .filter((record) => record.type === 'message')
      .map((record) => ({
        signature: record.signature,
        role: record.role || 'assistant',
        kind: 'message',
        content: record.content,
        timestamp: record.timestamp,
        rawJsonl: JSON.stringify({
          runtime: 'claude',
          type: record.type,
          role: record.role || 'assistant',
          content: record.content,
          timestamp: record.timestamp,
        }),
      }));
  },
  archiveThread(claudeSessionId, cwd) {
    const session = getClaudeSessionJsonlById(claudeSessionId, cwd);
    return session ? archiveClaudeSessionJsonl(session) : false;
  },
};

function toRuntimeCodexSession(session: CodexSessionSummary): LocalRuntimeSessionSummary {
  return { ...session, runtime: 'codex' };
}

function toRuntimeClaudeSession(session: ClaudeSessionJsonlSummary): LocalRuntimeSessionSummary {
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
  };
}

export function createUiSessionRuntimeSource(
  codexSource: UiSessionCodexSource = defaultUiSessionCodexSource,
  claudeSource: UiSessionClaudeSource = defaultUiSessionClaudeSource,
): UiSessionRuntimeSource {
  return {
    listSessions() {
      return [
        ...codexSource.listSessions().map(toRuntimeCodexSession),
        ...claudeSource.listSessions().map(toRuntimeClaudeSession),
      ].sort((left, right) => right.lastEventAt.localeCompare(left.lastEventAt));
    },
    getThread(runtime, threadId, cwd) {
      if (runtime === 'codex') {
        const session = codexSource.getThread(threadId);
        return session ? toRuntimeCodexSession(session) : null;
      }
      if (!cwd) return null;
      const session = claudeSource.getThread(threadId, cwd);
      return session ? toRuntimeClaudeSession(session) : null;
    },
    readJsonlHistory(runtime, threadId, cwd) {
      if (runtime === 'codex') return codexSource.readJsonlHistory(threadId);
      return cwd ? claudeSource.readJsonlHistory(threadId, cwd) : [];
    },
    archiveThread(runtime, threadId, cwd) {
      if (runtime === 'codex') return codexSource.archiveThread(threadId);
      return cwd ? claudeSource.archiveThread(threadId, cwd) : false;
    },
    getSessionsRoot: codexSource.getSessionsRoot,
    readDefaultModel: codexSource.readDefaultModel,
    defaultWorkingDirectory: codexSource.defaultWorkingDirectory,
  };
}

export function createUiSessionRegistry(
  store: JsonFileStore,
  codexSource: UiSessionCodexSource = defaultUiSessionCodexSource,
  claudeSource: UiSessionClaudeSource = defaultUiSessionClaudeSource,
): SessionRegistryService {
  return new SessionRegistryService(store, {
    codexThreads: {
      getThread(codexThreadId) {
        const session = codexSource.getThread(codexThreadId);
        return session
          ? { codexThreadId: session.threadId, title: session.title, cwd: session.cwd }
          : null;
      },
      archiveThread: (codexThreadId) => codexSource.archiveThread(codexThreadId),
    },
    claudeThreads: {
      getThread(claudeSessionId, cwd) {
        const session = claudeSource.getThread(claudeSessionId, cwd);
        return session
          ? { claudeSessionId: session.sessionId, title: session.title, cwd: session.cwd }
          : null;
      },
      archiveThread: (claudeSessionId, cwd) => claudeSource.archiveThread(claudeSessionId, cwd),
    },
    readDefaultModel: () => codexSource.readDefaultModel(),
    defaultWorkingDirectory: () => codexSource.defaultWorkingDirectory(),
  });
}
