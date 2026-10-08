import fs from 'node:fs';

import type { LLMProvider, StreamChatParams } from '../contracts.js';
import { sseEvent } from '../sse.js';
import { sendCursorDesktopMessage } from './desktop-bridge-client.js';
import {
  findCursorSessionFileById,
  getCursorTranscriptCandidates,
  readCursorSessionMirrorRecordDeltaByFilePath,
} from './session-index.js';
import { enqueueCursorRecord, type CursorTurnContext } from './tmux-provider.js';

const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_TRANSCRIPT_TIMEOUT_MS = 30_000;
const DEFAULT_OUTPUT_IDLE_TIMEOUT_MS = 120_000;
const DEFAULT_QUEUED_IDLE_TIMEOUT_MS = 600_000;

interface TranscriptSnapshot {
  size: number;
  mtimeMs: number;
  identity: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function positiveIntEnv(name: string, fallback: number, minimum: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= minimum ? Math.floor(value) : fallback;
}

function transcriptSnapshot(filePath: string | undefined): TranscriptSnapshot | null {
  if (!filePath) return null;
  try {
    const stat = fs.statSync(filePath);
    return {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      identity: `${stat.dev}:${stat.ino}`,
    };
  } catch {
    return null;
  }
}

function promptAppearsInUserRecord(content: string, prompt: string): boolean {
  const expected = prompt.trim();
  return Boolean(expected && content.includes(expected));
}

async function waitForTranscriptPath(
  sessionId: string,
  cwd: string | undefined,
  abortSignal: AbortSignal | undefined,
): Promise<{ filePath: string; storePath?: string; cwd?: string }> {
  const timeoutMs = positiveIntEnv(
    'CODELARK_CURSOR_DESKTOP_TRANSCRIPT_TIMEOUT_MS',
    DEFAULT_TRANSCRIPT_TIMEOUT_MS,
    1_000,
  );
  const pollIntervalMs = positiveIntEnv(
    'CODELARK_CURSOR_DESKTOP_POLL_INTERVAL_MS',
    DEFAULT_POLL_INTERVAL_MS,
    50,
  );
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    if (abortSignal?.aborted) throw new Error('已停止等待；Cursor Desktop 中已提交的 turn 仍可能继续运行。');
    const summary = findCursorSessionFileById(sessionId, cwd);
    const filePath = summary?.filePath || (cwd
      ? getCursorTranscriptCandidates(sessionId, cwd).find((candidate) => fs.existsSync(candidate))
      : undefined);
    if (filePath) return { filePath, storePath: summary?.storePath, cwd: summary?.cwd || cwd };
    await sleep(pollIntervalMs);
  }
  throw new Error('Cursor Desktop 已接收消息，但未在规定时间内创建 transcript；不会切换到另一条会话。');
}

async function pollDesktopTranscript(
  controller: ReadableStreamDefaultController<string>,
  context: CursorTurnContext,
  prompt: string,
  abortSignal: AbortSignal | undefined,
  initialSnapshot: TranscriptSnapshot | null,
  queued: boolean,
): Promise<void> {
  const pollIntervalMs = positiveIntEnv(
    'CODELARK_CURSOR_DESKTOP_POLL_INTERVAL_MS',
    DEFAULT_POLL_INTERVAL_MS,
    50,
  );
  const idleTimeoutMs = positiveIntEnv(
    queued
      ? 'CODELARK_CURSOR_DESKTOP_QUEUED_IDLE_TIMEOUT_MS'
      : 'CODELARK_CURSOR_DESKTOP_OUTPUT_IDLE_TIMEOUT_MS',
    queued ? DEFAULT_QUEUED_IDLE_TIMEOUT_MS : DEFAULT_OUTPUT_IDLE_TIMEOUT_MS,
    1_000,
  );
  let lastActivityAt = Date.now();
  let targetTurnSeen = false;
  let previousSnapshot = initialSnapshot;
  while (!context.terminalSeen) {
    if (abortSignal?.aborted) throw new Error('已停止等待；Cursor Desktop 中已提交的 turn 仍可能继续运行。');
    if (!context.sessionFilePath) throw new Error('Cursor Desktop transcript 路径尚未解析。');
    const snapshot = transcriptSnapshot(context.sessionFilePath);
    const endOffset = snapshot?.size ?? context.nextOffset;
    const replaced = Boolean(snapshot && previousSnapshot && (
      snapshot.identity !== previousSnapshot.identity
      || snapshot.size < context.nextOffset
      || (snapshot.size === context.nextOffset && snapshot.mtimeMs !== previousSnapshot.mtimeMs)
    ));
    if (replaced) {
      context.nextOffset = 0;
      context.trailingText = '';
      context.nextTurnId = null;
      context.nextSpecialCallIds = [];
      targetTurnSeen = false;
      lastActivityAt = Date.now();
    }
    if (snapshot) previousSnapshot = snapshot;
    const previousOffset = context.nextOffset;
    const delta = readCursorSessionMirrorRecordDeltaByFilePath(
      context.sessionFilePath,
      context.nextOffset,
      endOffset,
      context.trailingText,
      context.nextTurnId,
      context.nextSpecialCallIds,
      context.sessionStorePath,
    );
    context.nextOffset = delta.nextOffset;
    context.trailingText = delta.trailingText;
    context.nextTurnId = delta.nextTurnId;
    context.nextSpecialCallIds = delta.nextSpecialCallIds;
    for (const record of delta.records) {
      if (!targetTurnSeen) {
        if (record.type === 'message' && record.role === 'user' && promptAppearsInUserRecord(record.content, prompt)) {
          targetTurnSeen = true;
        }
        continue;
      }
      enqueueCursorRecord(controller, context, record);
    }
    if (context.nextOffset > previousOffset) lastActivityAt = Date.now();
    if (context.terminalSeen) return;
    if (Date.now() - lastActivityAt > idleTimeoutMs) {
      throw new Error(targetTurnSeen
        ? `Cursor Desktop transcript 已 ${idleTimeoutMs}ms 没有活动。`
        : `Cursor Desktop 已接收消息，但 transcript 中未出现本次用户消息（等待 ${idleTimeoutMs}ms）。`);
    }
    await sleep(pollIntervalMs);
  }
}

export function streamCursorDesktop(params: StreamChatParams): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      void (async () => {
        const sessionId = params.cursorSessionId?.trim();
        if (!sessionId) throw new Error('Cursor Desktop provider 只能用于已绑定的 Desktop thread。');
        const known = findCursorSessionFileById(sessionId, params.workingDirectory);
        const baselineSnapshot = transcriptSnapshot(known?.filePath);
        const context: CursorTurnContext = {
          sessionName: `cursor-desktop:${sessionId}`,
          sessionId,
          cwd: known?.cwd || params.workingDirectory,
          sessionFilePath: known?.filePath,
          sessionStorePath: known?.storePath,
          nextOffset: baselineSnapshot?.size || 0,
          trailingText: '',
          nextTurnId: null,
          nextSpecialCallIds: [],
          emittedSignatures: new Set(),
          emittedToolStarts: new Set(),
          terminalSeen: false,
        };
        controller.enqueue(sseEvent('status', {
          reasoning: '正在向已绑定的 Cursor Desktop 对话提交消息。',
          session_id: sessionId,
          ...(context.cwd ? { cwd: context.cwd } : {}),
        }));
        const sent = await sendCursorDesktopMessage(sessionId, params.prompt, { force: params.cursorForce });
        controller.enqueue(sseEvent('status', {
          reasoning: sent.status === 'queued'
            ? 'Cursor Desktop 当前 turn 尚未结束；消息已排队，将在同一对话继续。'
            : 'Cursor Desktop 已接收消息，正在同一对话中运行。',
        }));
        if (!context.sessionFilePath) {
          const transcript = await waitForTranscriptPath(sessionId, context.cwd, params.abortController?.signal);
          context.sessionFilePath = transcript.filePath;
          context.sessionStorePath = transcript.storePath;
          context.cwd = transcript.cwd || context.cwd;
          context.nextOffset = 0;
        }
        await pollDesktopTranscript(
          controller,
          context,
          params.prompt,
          params.abortController?.signal,
          context.sessionFilePath === known?.filePath ? baselineSnapshot : null,
          sent.status === 'queued',
        );
        controller.close();
      })().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[cursor-desktop] Error:', error instanceof Error ? error.stack || error.message : error);
        try {
          controller.enqueue(sseEvent('error', message || 'Cursor Desktop 执行失败。'));
          controller.close();
        } catch {
          // The stream may already be closed by its consumer.
        }
      });
    },
  });
}

export class CursorDesktopProvider implements LLMProvider {
  streamChat(params: StreamChatParams): ReadableStream<string> {
    return streamCursorDesktop(params);
  }
}
