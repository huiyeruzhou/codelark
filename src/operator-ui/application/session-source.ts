import { readConfiguredCodexModel } from '../../runtime/codex/models.js';
import {
  archiveCursorSessionFile,
  findCursorSessionFileById,
  listCursorSessionFileSummaries,
  readCursorSessionMirrorRecordStreamByFilePath,
  type CursorSessionFileSummary,
} from '../../runtime/cursor/session-index.js';
import {
  archiveClaudeSessionJsonl,
  getClaudeSessionJsonlById,
  listClaudeSessionJsonlSummaries,
  readClaudeSessionMirrorRecordStreamByFilePath,
  type ClaudeSessionJsonlSummary,
} from '../../runtime/claude/session-jsonl.js';
import {
  archiveKimiSessionFile,
  findKimiSessionFileById,
  listKimiSessionFileSummaries,
  readKimiSessionMirrorRecordStreamByFilePath,
  type KimiSessionFileSummary,
} from '../../runtime/kimi/session-index.js';
import type { LocalRuntimeSessionSummary } from '../../bridge/session/local-runtime-session.js';
import type { RuntimeAgent } from '../../domain/session.js';
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

export interface UiSessionKimiSource {
  listSessions(): KimiSessionFileSummary[];
  getThread(kimiSessionId: string, cwd: string): KimiSessionFileSummary | null;
  readJsonlHistory(kimiSessionId: string, cwd: string): CodexSessionJsonlHistoryEntry[];
  archiveThread(kimiSessionId: string, cwd: string): boolean;
}

export interface UiSessionCursorSource {
  listSessions(): CursorSessionFileSummary[];
  getThread(cursorSessionId: string, cwd: string): CursorSessionFileSummary | null;
  readJsonlHistory(cursorSessionId: string, cwd: string): CodexSessionJsonlHistoryEntry[];
  archiveThread(cursorSessionId: string, cwd: string): boolean;
}

export interface UiSessionRuntimeSource {
  listSessions(): LocalRuntimeSessionSummary[];
  getThread(runtime: RuntimeAgent, threadId: string, cwd?: string): LocalRuntimeSessionSummary | null;
  readJsonlHistory(runtime: RuntimeAgent, threadId: string, cwd?: string): CodexSessionJsonlHistoryEntry[];
  archiveThread(runtime: RuntimeAgent, threadId: string, cwd?: string): boolean;
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

export const defaultUiSessionKimiSource: UiSessionKimiSource = {
  listSessions: () => listKimiSessionFileSummaries(),
  getThread: (kimiSessionId, cwd) => findKimiSessionFileById(kimiSessionId, cwd),
  readJsonlHistory(kimiSessionId, cwd) {
    const session = findKimiSessionFileById(kimiSessionId, cwd);
    if (!session) return [];
    return readKimiSessionMirrorRecordStreamByFilePath(session.filePath)
      .filter((record) => record.type === 'message')
      .map((record) => ({
        signature: record.signature,
        role: record.role || 'assistant',
        kind: 'message',
        content: record.content,
        timestamp: record.timestamp,
        rawJsonl: JSON.stringify({
          runtime: 'kimi',
          type: record.type,
          role: record.role || 'assistant',
          content: record.content,
          timestamp: record.timestamp,
        }),
      }));
  },
  archiveThread(kimiSessionId, cwd) {
    const session = findKimiSessionFileById(kimiSessionId, cwd);
    return session ? archiveKimiSessionFile(session) : false;
  },
};

export const defaultUiSessionCursorSource: UiSessionCursorSource = {
  listSessions: () => listCursorSessionFileSummaries(),
  getThread: (cursorSessionId, cwd) => findCursorSessionFileById(cursorSessionId, cwd),
  readJsonlHistory(cursorSessionId, cwd) {
    const session = findCursorSessionFileById(cursorSessionId, cwd);
    if (!session?.filePath) return [];
    return readCursorSessionMirrorRecordStreamByFilePath(session.filePath, session.storePath)
      .filter((record) => record.type === 'message')
      .map((record) => ({
        signature: record.signature,
        role: record.role || 'assistant',
        kind: 'message',
        content: record.content,
        timestamp: record.timestamp,
        rawJsonl: JSON.stringify({
          runtime: 'cursor',
          type: record.type,
          role: record.role || 'assistant',
          content: record.content,
          timestamp: record.timestamp,
        }),
      }));
  },
  archiveThread(cursorSessionId, cwd) {
    const session = findCursorSessionFileById(cursorSessionId, cwd);
    return session ? archiveCursorSessionFile(session) : false;
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

function toRuntimeKimiSession(session: KimiSessionFileSummary): LocalRuntimeSessionSummary {
  return {
    runtime: 'kimi',
    threadId: session.sessionId,
    filePath: session.filePath,
    cwd: session.cwd || '',
    originator: 'Kimi Code',
    source: 'kimi',
    firstSeenAt: session.firstSeenAt || session.updatedAt || '',
    lastEventAt: session.updatedAt || session.firstSeenAt || '',
    title: session.title || session.sessionId.slice(0, 8),
    activeEstimate: false,
  };
}

function toRuntimeCursorSession(session: CursorSessionFileSummary): LocalRuntimeSessionSummary {
  return {
    runtime: 'cursor',
    threadId: session.sessionId,
    filePath: session.filePath || session.storePath,
    cwd: session.cwd || '',
    originator: 'Cursor Agent',
    source: 'cursor',
    firstSeenAt: session.createdAt || session.updatedAt || '',
    lastEventAt: session.updatedAt || session.createdAt || '',
    title: session.title || session.sessionId.slice(0, 8),
    activeEstimate: false,
  };
}

export function createUiSessionRuntimeSource(
  codexSource: UiSessionCodexSource = defaultUiSessionCodexSource,
  claudeSource: UiSessionClaudeSource = defaultUiSessionClaudeSource,
  kimiSource: UiSessionKimiSource = defaultUiSessionKimiSource,
  cursorSource: UiSessionCursorSource = defaultUiSessionCursorSource,
): UiSessionRuntimeSource {
  return {
    listSessions() {
      return [
        ...codexSource.listSessions().map(toRuntimeCodexSession),
        ...claudeSource.listSessions().map(toRuntimeClaudeSession),
        ...kimiSource.listSessions().map(toRuntimeKimiSession),
        ...cursorSource.listSessions().map(toRuntimeCursorSession),
      ].sort((left, right) => right.lastEventAt.localeCompare(left.lastEventAt));
    },
    getThread(runtime, threadId, cwd) {
      if (runtime === 'codex') {
        const session = codexSource.getThread(threadId);
        return session ? toRuntimeCodexSession(session) : null;
      }
      if (!cwd) return null;
      if (runtime === 'kimi') {
        const session = kimiSource.getThread(threadId, cwd);
        return session ? toRuntimeKimiSession(session) : null;
      }
      if (runtime === 'cursor') {
        const session = cursorSource.getThread(threadId, cwd);
        return session ? toRuntimeCursorSession(session) : null;
      }
      const session = claudeSource.getThread(threadId, cwd);
      return session ? toRuntimeClaudeSession(session) : null;
    },
    readJsonlHistory(runtime, threadId, cwd) {
      if (runtime === 'codex') return codexSource.readJsonlHistory(threadId);
      if (runtime === 'kimi') return cwd ? kimiSource.readJsonlHistory(threadId, cwd) : [];
      if (runtime === 'cursor') return cwd ? cursorSource.readJsonlHistory(threadId, cwd) : [];
      return cwd ? claudeSource.readJsonlHistory(threadId, cwd) : [];
    },
    archiveThread(runtime, threadId, cwd) {
      if (runtime === 'codex') return codexSource.archiveThread(threadId);
      if (runtime === 'kimi') return cwd ? kimiSource.archiveThread(threadId, cwd) : false;
      if (runtime === 'cursor') return cwd ? cursorSource.archiveThread(threadId, cwd) : false;
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
  kimiSource: UiSessionKimiSource = defaultUiSessionKimiSource,
  cursorSource: UiSessionCursorSource = defaultUiSessionCursorSource,
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
    kimiThreads: {
      getThread(kimiSessionId, cwd) {
        const session = kimiSource.getThread(kimiSessionId, cwd);
        return session
          ? { kimiSessionId: session.sessionId, title: session.title || session.sessionId.slice(0, 8), cwd: session.cwd || cwd }
          : null;
      },
      archiveThread: (kimiSessionId, cwd) => kimiSource.archiveThread(kimiSessionId, cwd),
    },
    cursorThreads: {
      getThread(cursorSessionId, cwd) {
        const session = cursorSource.getThread(cursorSessionId, cwd);
        return session
          ? { cursorSessionId: session.sessionId, title: session.title || session.sessionId.slice(0, 8), cwd: session.cwd || cwd }
          : null;
      },
      archiveThread: (cursorSessionId, cwd) => cursorSource.archiveThread(cursorSessionId, cwd),
    },
    readDefaultModel: () => codexSource.readDefaultModel(),
    defaultWorkingDirectory: () => codexSource.defaultWorkingDirectory(),
  });
}
