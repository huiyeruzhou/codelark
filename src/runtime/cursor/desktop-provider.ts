import fs from 'node:fs';

import type { LLMProvider, StreamChatParams } from '../contracts.js';
import { sseEvent } from '../sse.js';
import {
  listCursorDesktopThreads,
  readCursorDesktopEvents,
  sendCursorDesktopMessage,
} from './desktop-bridge-client.js';
import {
  subscribeCursorDesktopHookActivities,
  type CursorDesktopHookActivity,
  type CursorDesktopHookSubscription,
} from './desktop-diagnostics.js';
import {
  findCursorSessionFileById,
  getCursorTranscriptCandidates,
  readCursorSessionMirrorRecordDeltaByFilePath,
  readCursorSessionMirrorRecordStreamByFilePath,
} from './session-index.js';
import {
  cursorToolFingerprint,
  enqueueCursorRecord,
  type CursorTurnContext,
} from './tmux-provider.js';

const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_TRANSCRIPT_TIMEOUT_MS = 30_000;
const DEFAULT_OUTPUT_IDLE_TIMEOUT_MS = 120_000;
const DEFAULT_QUEUED_IDLE_TIMEOUT_MS = 600_000;
const DESKTOP_STATUS_POLL_INTERVAL_MS = 5_000;
const DESKTOP_REALTIME_POLL_INTERVAL_MS = 1_000;
const HOOK_REALTIME_OUTPUT_MAX_CHARS = 32_000;
const HOOK_REALTIME_THOUGHT_COLLAPSE_THRESHOLD = 2_000;

interface TranscriptSnapshot {
  size: number;
  mtimeMs: number;
  identity: string;
  anchorStart: number;
  anchor: Buffer;
}

const TRANSCRIPT_REWRITE_ANCHOR_BYTES = 1024;

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
    const anchorStart = Math.max(0, stat.size - TRANSCRIPT_REWRITE_ANCHOR_BYTES);
    const anchor = Buffer.alloc(stat.size - anchorStart);
    const fd = fs.openSync(filePath, 'r');
    try {
      const bytesRead = fs.readSync(fd, anchor, 0, anchor.length, anchorStart);
      return {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        identity: `${stat.dev}:${stat.ino}`,
        anchorStart,
        anchor: anchor.subarray(0, bytesRead),
      };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function transcriptPrefixWasRewritten(filePath: string, previous: TranscriptSnapshot): boolean {
  if (previous.anchor.length === 0) return false;
  try {
    const actual = Buffer.alloc(previous.anchor.length);
    const fd = fs.openSync(filePath, 'r');
    try {
      const bytesRead = fs.readSync(fd, actual, 0, actual.length, previous.anchorStart);
      return bytesRead !== previous.anchor.length
        || !actual.subarray(0, bytesRead).equals(previous.anchor);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return true;
  }
}

function cursorHookStatus(step: string | undefined, toolName: string | undefined): string {
  const detail = toolName ? ` · ${toolName}` : '';
  switch (step) {
    case 'beforeShellExecution': return `Cursor 正在执行命令${detail}`;
    case 'afterShellExecution': return `Cursor 已完成命令${detail}`;
    case 'preToolUse': return `Cursor 正在调用工具${detail}`;
    case 'postToolUse': return `Cursor 已完成工具${detail}`;
    case 'afterAgentThought': return 'Cursor 正在思考';
    case 'stop':
    case 'sessionEnd': return 'Cursor 正在结束当前 turn';
    default: return step ? `Cursor 后端活动：${step}${detail}` : 'Cursor 后端仍在运行';
  }
}

function cursorHookToolOutput(value: string | undefined): string {
  if (!value) return 'Done';
  let output = value;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      if (typeof record.output === 'string') output = record.output;
    }
  } catch {
    // Cursor tool hooks may return plain text rather than encoded JSON.
  }
  return output.length > HOOK_REALTIME_OUTPUT_MAX_CHARS
    ? `${output.slice(0, HOOK_REALTIME_OUTPUT_MAX_CHARS)}\n…（实时输出已截断，最终 transcript 会继续收取）`
    : output;
}

function cursorHookThoughtHistory(value: string): { content: string; collapseTitle?: string } {
  const trimmed = value.trim();
  const content = trimmed
    .split(/\r?\n/)
    .map((line) => line ? `> ${line}` : '>')
    .join('\n');
  return {
    content,
    ...(Array.from(trimmed).length > HOOK_REALTIME_THOUGHT_COLLAPSE_THRESHOLD
      ? { collapseTitle: '💭 Cursor 思考 · 展开查看' }
      : {}),
  };
}

function enqueueCursorHookActivity(
  controller: ReadableStreamDefaultController<string>,
  context: CursorTurnContext,
  hook: CursorDesktopHookActivity,
  backendStatus: string | undefined,
): void {
  const metadata = {
    backend_status: backendStatus || 'running',
    hook_updated_at: hook.updatedAt,
    // afterAgentThought carries the selected reasoning variant (for example
    // `*-high`). Tool hooks often carry only the base model and would make the
    // card metadata oscillate, forcing full refreshes ahead of tool panels.
    ...(hook.step === 'afterAgentThought' && hook.model ? { model: hook.model } : {}),
  };
  if (hook.step === 'afterAgentThought' && hook.text?.trim()) {
    const thought = cursorHookThoughtHistory(hook.text);
    controller.enqueue(sseEvent('history_item', {
      type: 'markdown',
      role: 'thinking',
      ...thought,
    }));
    controller.enqueue(sseEvent('status', {
      ...metadata,
      reasoning: 'Cursor 正在思考',
    }));
    return;
  }
  if (hook.step === 'preToolUse' && hook.toolUseId) {
    if (!context.emittedToolStarts.has(hook.toolUseId)) {
      const fingerprint = cursorToolFingerprint(hook.toolName || 'tool', hook.toolInput || {});
      const transcriptIds = context.transcriptToolIdsByFingerprint?.get(fingerprint);
      const transcriptId = transcriptIds?.shift();
      if (transcriptIds && transcriptIds.length === 0) {
        context.transcriptToolIdsByFingerprint?.delete(fingerprint);
      }
      context.emittedToolStarts.add(hook.toolUseId);
      if (transcriptId) {
        context.liveHookToolIdAliases?.set(hook.toolUseId, transcriptId);
      } else {
        const hookIds = context.liveHookToolIdsByFingerprint?.get(fingerprint) || [];
        hookIds.push(hook.toolUseId);
        context.liveHookToolIdsByFingerprint?.set(fingerprint, hookIds);
        controller.enqueue(sseEvent('tool_use', {
          id: hook.toolUseId,
          name: hook.toolName || 'tool',
          input: hook.toolInput || {},
        }));
      }
    }
    controller.enqueue(sseEvent('status', {
      ...metadata,
      reasoning: cursorHookStatus(hook.step, hook.toolName),
    }));
    return;
  }
  if (hook.step === 'postToolUse' && hook.toolUseId) {
    const displayToolId = context.liveHookToolIdAliases?.get(hook.toolUseId) || hook.toolUseId;
    if (!context.emittedToolStarts.has(hook.toolUseId)) {
      context.emittedToolStarts.add(hook.toolUseId);
      controller.enqueue(sseEvent('tool_use', {
        id: displayToolId,
        name: hook.toolName || 'tool',
        input: hook.toolInput || {},
      }));
    }
    controller.enqueue(sseEvent('tool_result', {
      tool_use_id: displayToolId,
      content: cursorHookToolOutput(hook.toolOutput),
      is_error: false,
    }));
    return;
  }
  if (hook.step === 'beforeShellExecution' || hook.step === 'afterShellExecution') return;
  controller.enqueue(sseEvent('status', {
    ...metadata,
    reasoning: cursorHookStatus(hook.step, hook.toolName),
  }));
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
  abortSignal: AbortSignal | undefined,
  initialSnapshot: TranscriptSnapshot | null,
  baselineTurnStarts: Set<string>,
  queued: boolean,
  hookSubscription: CursorDesktopHookSubscription,
): Promise<void> {
  const cursorSessionId = context.sessionId;
  if (!cursorSessionId) throw new Error('Cursor Desktop session ID 缺失。');
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
  let targetTurnId: string | null = null;
  let previousSnapshot = initialSnapshot;
  let lastDesktopStatusProbeAt = 0;
  let lastDesktopStatus: string | undefined;
  let hookGenerationId: string | undefined;
  let realtimeCursor = 0;
  let realtimeAvailable: boolean | undefined;
  let lastRealtimeProbeAt = 0;
  let lastRealtimeStatus: string | undefined;
  let lastRealtimeModel: string | undefined;
  while (!context.terminalSeen) {
    if (abortSignal?.aborted) throw new Error('已停止等待；Cursor Desktop 中已提交的 turn 仍可能继续运行。');
    if (!context.sessionFilePath) throw new Error('Cursor Desktop transcript 路径尚未解析。');
    const snapshot = transcriptSnapshot(context.sessionFilePath);
    const endOffset = snapshot?.size ?? context.nextOffset;
    const replaced = Boolean(snapshot && previousSnapshot && (
      snapshot.identity !== previousSnapshot.identity
      || snapshot.size < context.nextOffset
      || transcriptPrefixWasRewritten(context.sessionFilePath, previousSnapshot)
      || (snapshot.size === context.nextOffset && snapshot.mtimeMs !== previousSnapshot.mtimeMs)
    ));
    if (replaced) {
      context.nextOffset = 0;
      context.trailingText = '';
      context.nextTurnId = null;
      context.nextSpecialCallIds = [];
      targetTurnId = null;
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
      if (!targetTurnId) {
        if (record.type === 'task_started' && !baselineTurnStarts.has(record.signature)) {
          targetTurnId = record.turnId || record.signature;
        }
        continue;
      }
      if (record.turnId && record.turnId !== targetTurnId) continue;
      if (record.type === 'message' && record.role === 'user') continue;
      enqueueCursorRecord(controller, context, record);
    }
    if (context.nextOffset > previousOffset) lastActivityAt = Date.now();
    if (context.terminalSeen) return;
    for (const hook of hookSubscription.drain()) {
      if (queued && !targetTurnId) continue;
      if (hookGenerationId && hook.generationId && hook.generationId !== hookGenerationId) continue;
      if (!hookGenerationId && hook.generationId) hookGenerationId = hook.generationId;
      lastActivityAt = Date.now();
      enqueueCursorHookActivity(controller, context, hook, lastDesktopStatus);
    }
    if (realtimeAvailable !== false && Date.now() - lastRealtimeProbeAt >= DESKTOP_REALTIME_POLL_INTERVAL_MS) {
      lastRealtimeProbeAt = Date.now();
      try {
        const batch = await readCursorDesktopEvents(cursorSessionId, realtimeCursor, { timeoutMs: 0 });
        realtimeAvailable = true;
        realtimeCursor = Math.max(realtimeCursor, batch.cursor);
        for (const event of batch.events) {
          lastActivityAt = Date.now();
          if (event.status) lastDesktopStatus = event.status;
          if (event.type === 'finished') {
            controller.enqueue(sseEvent('status', {
              reasoning: 'Cursor Desktop 已发出完成事件，正在收取最终 transcript。',
              backend_status: event.status || 'completed',
              ...(event.model ? { model: event.model } : {}),
            }));
          } else if (event.type === 'stopped') {
            controller.enqueue(sseEvent('status', {
              reasoning: 'Cursor Desktop 已停止生成，正在收取最终 transcript。',
              backend_status: event.status || 'stopped',
              ...(event.model ? { model: event.model } : {}),
            }));
          } else if (event.type === 'error') {
            controller.enqueue(sseEvent('status', {
              reasoning: `Cursor Desktop 实时事件异常：${event.message || 'unknown error'}`,
              backend_status: event.status || 'error',
            }));
          } else if (event.status !== lastRealtimeStatus || event.model !== lastRealtimeModel) {
            lastRealtimeStatus = event.status;
            lastRealtimeModel = event.model;
            controller.enqueue(sseEvent('status', {
              reasoning: 'Cursor Desktop 实时事件已连接。',
              backend_status: event.status || 'unknown',
              ...(event.model ? { model: event.model } : {}),
            }));
          }
        }
      } catch (error) {
        realtimeAvailable = false;
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes('realtime protocol 不可用')) {
          controller.enqueue(sseEvent('status', {
            reasoning: `Cursor Desktop 实时事件不可用，已回退到状态与 transcript：${message}`,
            backend_status: lastDesktopStatus || 'unknown',
          }));
        }
      }
    }
    if (Date.now() - lastDesktopStatusProbeAt >= DESKTOP_STATUS_POLL_INTERVAL_MS) {
      lastDesktopStatusProbeAt = Date.now();
      try {
        lastDesktopStatus = (await listCursorDesktopThreads())
          .find((thread) => thread.id === cursorSessionId)?.status;
      } catch {
        lastDesktopStatus = undefined;
      }
    }
    if (Date.now() - lastActivityAt > idleTimeoutMs) {
      if (lastDesktopStatus === 'running') {
        lastActivityAt = Date.now();
        controller.enqueue(sseEvent('status', {
          reasoning: 'Cursor Desktop 后端仍为 running；transcript 暂无新记录，继续等待。',
          backend_status: 'running',
        }));
        await hookSubscription.waitForActivity(pollIntervalMs);
        continue;
      }
      throw new Error(targetTurnId
        ? `Cursor Desktop transcript 已 ${idleTimeoutMs}ms 没有活动，后端状态为 ${lastDesktopStatus || 'unknown'}。`
        : `Cursor Desktop 已接收消息，但 transcript 中未出现本次用户消息（等待 ${idleTimeoutMs}ms）。`);
    }
    await hookSubscription.waitForActivity(pollIntervalMs);
  }
}

export function streamCursorDesktop(params: StreamChatParams): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      void (async () => {
        const sessionId = params.cursorSessionId?.trim();
        if (!sessionId) throw new Error('Cursor Desktop 连接需要已绑定的桌面对话。');
        const known = findCursorSessionFileById(sessionId, params.workingDirectory);
        const initialFilePath = known?.filePath || (params.workingDirectory
          ? getCursorTranscriptCandidates(sessionId, params.workingDirectory)
            .find((candidate) => fs.existsSync(candidate))
          : undefined);
        const baselineSnapshot = transcriptSnapshot(initialFilePath);
        const hookSubscription = await subscribeCursorDesktopHookActivities(sessionId);
        const baselineTurnStarts = new Set(
          initialFilePath
            ? readCursorSessionMirrorRecordStreamByFilePath(initialFilePath, known?.storePath)
              .filter((record) => record.type === 'task_started')
              .map((record) => record.signature)
            : [],
        );
        const context: CursorTurnContext = {
          sessionName: `cursor-desktop:${sessionId}`,
          sessionId,
          cwd: known?.cwd || params.workingDirectory,
          sessionFilePath: initialFilePath,
          sessionStorePath: known?.storePath,
          nextOffset: baselineSnapshot?.size || 0,
          trailingText: '',
          nextTurnId: null,
          nextSpecialCallIds: [],
          emittedSignatures: new Set(),
          emittedToolStarts: new Set(),
          liveHookToolIdsByFingerprint: new Map(),
          transcriptToolIdsByFingerprint: new Map(),
          transcriptToolIdAliases: new Map(),
          liveHookToolIdAliases: new Map(),
          terminalSeen: false,
        };
        try {
          controller.enqueue(sseEvent('status', {
            reasoning: '正在向已绑定的 Cursor Desktop 对话提交消息。',
            session_id: sessionId,
            ...(context.cwd ? { cwd: context.cwd } : {}),
          }));
          const sent = await sendCursorDesktopMessage(sessionId, params.prompt, {
            delivery: params.cursorDelivery || 'auto',
          });
          controller.enqueue(sseEvent('status', {
            reasoning: sent.status === 'steered'
              ? 'Cursor Desktop 已将消息 steer 到当前 turn。'
              : sent.status === 'queued'
                ? `Cursor Desktop 当前 turn 尚未结束；消息已排队，将在同一对话继续。${sent.warning ? ` ${sent.warning}` : ''}`
                : `Cursor Desktop 已接收消息，正在同一对话中运行。${sent.warning ? ` ${sent.warning}` : ''}`,
            delivery: sent.actualDelivery,
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
            params.abortController?.signal,
            context.sessionFilePath === initialFilePath ? baselineSnapshot : null,
            baselineTurnStarts,
            sent.status === 'queued',
            hookSubscription,
          );
          controller.close();
        } finally {
          hookSubscription.close();
        }
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

export class CursorDesktopTransport implements LLMProvider {
  streamChat(params: StreamChatParams): ReadableStream<string> {
    return streamCursorDesktop(params);
  }
}
