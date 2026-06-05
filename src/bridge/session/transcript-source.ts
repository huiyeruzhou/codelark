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
import { getCodexSessionByThreadIdSafe } from './support.js';
import type { ChannelChat } from '../../domain/channel.js';
import type { BridgeSession } from '../../domain/session.js';
import {
  getSessionActiveRuntime,
  getSessionClaudeCwd,
  getSessionClaudeSessionId,
  getSessionCodexTitle,
  getSessionWorkingDirectory,
} from '../../domain/session-runtime.js';
import { getCodexThreadId } from '../turn/turn-classifier.js';

export interface SessionTranscriptFile {
  runtime: 'codex' | 'claude';
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
  readonly runtime: 'codex' | 'claude';
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

export const defaultSessionTranscriptSources: readonly SessionTranscriptSource[] = [
  new CodexSessionTranscriptSource(),
  new ClaudeSessionTranscriptSource(),
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
