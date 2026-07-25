import fs from 'node:fs';
import path from 'node:path';

import {
  readCodexSessionJsonlHistoryStreamByFilePath,
  readCodexSessionMessagesByFilePath,
} from '../../runtime/codex/session-index.js';
import {
  getClaudeSessionJsonlById,
  readClaudeSessionMirrorRecordStreamByFilePath,
} from '../../runtime/claude/session-jsonl.js';
import {
  findKimiSessionFileById,
  readKimiSessionMessagesByFilePath,
  readKimiSessionMirrorRecordStreamByFilePath,
} from '../../runtime/kimi/session-index.js';
import {
  findCursorSessionFileById,
  readCursorSessionMessagesByFilePath,
  readCursorSessionMirrorRecordStreamByFilePath,
} from '../../runtime/cursor/session-index.js';
import { getCodexSessionByThreadIdSafe } from './support.js';
import type { ChannelChat } from '../../domain/channel.js';
import type { BridgeSession } from '../../domain/session.js';
import {
  getSessionActiveRuntime,
  getSessionClaudeCwd,
  getSessionClaudeSessionId,
  getSessionCodexTitle,
  getSessionCursorCwd,
  getSessionCursorSessionId,
  getSessionKimiCwd,
  getSessionKimiSessionId,
  getSessionWorkingDirectory,
} from '../../domain/session-runtime.js';
import { getCodexThreadId } from '../turn/turn-classifier.js';

export interface SessionTranscriptFile {
  runtime: 'codex' | 'claude' | 'kimi' | 'cursor';
  filePath: string;
  fileName: string;
  threadId: string;
  title: string | null;
  sourceLabel: string;
}

export interface SessionTranscriptMessage {
  role: string;
  content: string;
}

export interface SessionTranscriptHistoryEntry {
  role: string;
  kind: string;
  content: string;
  timestamp: string;
  rawJsonl: string;
}

export interface SessionTranscriptSource {
  readonly runtime: 'codex' | 'claude' | 'kimi' | 'cursor';
  resolve(session: BridgeSession | null, binding: ChannelChat): SessionTranscriptFile | null;
  readMessages(transcript: SessionTranscriptFile, limit: number): SessionTranscriptMessage[];
  readHistory(transcript: SessionTranscriptFile): SessionTranscriptHistoryEntry[];
}

function isReadableFile(filePath: string | undefined): filePath is string {
  if (!filePath) return false;
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export class CodexSessionTranscriptSource implements SessionTranscriptSource {
  readonly runtime = 'codex' as const;

  resolve(session: BridgeSession | null, binding: ChannelChat): SessionTranscriptFile | null {
    const threadIds = Array.from(new Set([
      getCodexThreadId(session, binding),
    ].filter((value): value is string => Boolean(value?.trim()))));

    for (const threadId of threadIds) {
      const codexSession = getCodexSessionByThreadIdSafe(threadId, 'transcript lookup');
      if (!codexSession || !isReadableFile(codexSession.filePath)) continue;
      return {
        runtime: this.runtime,
        filePath: codexSession.filePath,
        fileName: path.basename(codexSession.filePath),
        threadId,
        title: getSessionCodexTitle(session) || codexSession.title || null,
        sourceLabel: 'Codex session JSONL',
      };
    }

    return null;
  }

  readMessages(transcript: SessionTranscriptFile, limit: number): SessionTranscriptMessage[] {
    return readCodexSessionMessagesByFilePath(transcript.filePath, limit);
  }

  readHistory(transcript: SessionTranscriptFile): SessionTranscriptHistoryEntry[] {
    return readCodexSessionJsonlHistoryStreamByFilePath(transcript.filePath);
  }
}

export class ClaudeSessionTranscriptSource implements SessionTranscriptSource {
  readonly runtime = 'claude' as const;

  resolve(session: BridgeSession | null): SessionTranscriptFile | null {
    const sessionId = getSessionClaudeSessionId(session);
    const cwd = getSessionClaudeCwd(session) || getSessionWorkingDirectory(session);
    if (!sessionId || !cwd) return null;

    const claudeSession = getClaudeSessionJsonlById(sessionId, cwd);
    if (!claudeSession || !isReadableFile(claudeSession.filePath)) return null;
    return {
      runtime: this.runtime,
      filePath: claudeSession.filePath,
      fileName: path.basename(claudeSession.filePath),
      threadId: claudeSession.sessionId,
      title: session?.name || claudeSession.sessionId,
      sourceLabel: 'Claude Code session JSONL',
    };
  }

  readMessages(transcript: SessionTranscriptFile, limit: number): SessionTranscriptMessage[] {
    return this.readHistory(transcript)
      .filter((entry) => entry.kind === 'message')
      .map((entry) => ({ role: entry.role, content: entry.content }))
      .slice(-limit);
  }

  readHistory(transcript: SessionTranscriptFile): SessionTranscriptHistoryEntry[] {
    return readClaudeSessionMirrorRecordStreamByFilePath(transcript.filePath)
      .filter((record) => record.type === 'message' && record.role !== 'user')
      .map((record) => ({
        role: record.role || 'assistant',
        kind: 'message',
        content: record.content,
        timestamp: record.timestamp,
        rawJsonl: JSON.stringify({
          runtime: this.runtime,
          type: record.type,
          role: record.role || 'assistant',
          content: record.content,
          timestamp: record.timestamp,
        }),
      }));
  }
}

export class KimiSessionTranscriptSource implements SessionTranscriptSource {
  readonly runtime = 'kimi' as const;

  resolve(session: BridgeSession | null): SessionTranscriptFile | null {
    const sessionId = getSessionKimiSessionId(session);
    const cwd = getSessionKimiCwd(session) || getSessionWorkingDirectory(session);
    if (!sessionId) return null;

    const kimiSession = findKimiSessionFileById(sessionId, cwd || undefined);
    if (!kimiSession || !isReadableFile(kimiSession.filePath)) return null;
    return {
      runtime: this.runtime,
      filePath: kimiSession.filePath,
      fileName: path.basename(kimiSession.filePath),
      threadId: kimiSession.sessionId,
      title: session?.name || kimiSession.title || kimiSession.sessionId,
      sourceLabel: 'Kimi Code wire JSONL',
    };
  }

  readMessages(transcript: SessionTranscriptFile, limit: number): SessionTranscriptMessage[] {
    return readKimiSessionMessagesByFilePath(transcript.filePath, limit);
  }

  readHistory(transcript: SessionTranscriptFile): SessionTranscriptHistoryEntry[] {
    return readKimiSessionMirrorRecordStreamByFilePath(transcript.filePath)
      .filter((record) => record.type === 'message' && record.role !== 'user')
      .map((record) => ({
        role: record.role || 'assistant',
        kind: 'message',
        content: record.content,
        timestamp: record.timestamp,
        rawJsonl: JSON.stringify({
          runtime: this.runtime,
          type: record.type,
          role: record.role || 'assistant',
          content: record.content,
          timestamp: record.timestamp,
        }),
      }));
  }
}

export class CursorSessionTranscriptSource implements SessionTranscriptSource {
  readonly runtime = 'cursor' as const;

  resolve(session: BridgeSession | null): SessionTranscriptFile | null {
    const sessionId = getSessionCursorSessionId(session);
    const cwd = getSessionCursorCwd(session) || getSessionWorkingDirectory(session);
    if (!sessionId) return null;

    const cursorSession = findCursorSessionFileById(sessionId, cwd || undefined);
    if (!cursorSession || !isReadableFile(cursorSession.filePath)) return null;
    return {
      runtime: this.runtime,
      filePath: cursorSession.filePath,
      fileName: path.basename(cursorSession.filePath),
      threadId: cursorSession.sessionId,
      title: session?.name || cursorSession.title || cursorSession.sessionId,
      sourceLabel: 'Cursor Agent transcript JSONL',
    };
  }

  readMessages(transcript: SessionTranscriptFile, limit: number): SessionTranscriptMessage[] {
    return readCursorSessionMessagesByFilePath(transcript.filePath, limit);
  }

  readHistory(transcript: SessionTranscriptFile): SessionTranscriptHistoryEntry[] {
    return readCursorSessionMirrorRecordStreamByFilePath(transcript.filePath)
      .filter((record) => record.type === 'message' && record.role !== 'user')
      .map((record) => ({
        role: record.role || 'assistant',
        kind: 'message',
        content: record.content,
        timestamp: record.timestamp,
        rawJsonl: JSON.stringify({
          runtime: this.runtime,
          type: record.type,
          role: record.role || 'assistant',
          content: record.content,
          timestamp: record.timestamp,
        }),
      }));
  }
}

export const defaultSessionTranscriptSources: readonly SessionTranscriptSource[] = [
  new CodexSessionTranscriptSource(),
  new ClaudeSessionTranscriptSource(),
  new KimiSessionTranscriptSource(),
  new CursorSessionTranscriptSource(),
];

export function resolveSessionTranscriptFile(
  session: BridgeSession | null,
  binding: ChannelChat,
  sources: readonly SessionTranscriptSource[] = defaultSessionTranscriptSources,
): { transcript: SessionTranscriptFile; source: SessionTranscriptSource } | null {
  const activeRuntime = getSessionActiveRuntime(session);
  const ordered = activeRuntime
    ? [
        ...sources.filter((source) => source.runtime === activeRuntime),
        ...sources.filter((source) => source.runtime !== activeRuntime),
      ]
    : sources;

  for (const source of ordered) {
    const transcript = source.resolve(session, binding);
    if (transcript) return { transcript, source };
  }
  return null;
}
