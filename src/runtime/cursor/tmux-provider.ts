import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { BridgeMirrorRecord, LLMProvider, StreamChatParams } from '../contracts.js';
import { sseEvent } from '../sse.js';
import { tmuxCore } from '../../bridge/tmux/core.js';
import {
  inspectRuntimeTmuxInput,
  sendRuntimeTmuxInput,
  transitionRuntimeTmuxInputState,
} from '../../bridge/tmux/input-state-machine.js';
import { detectRuntimeTmuxPaneDead } from '../../bridge/tmux/runtime.js';
import {
  buildShellSnapshotLaunchArgs,
  ensureShellSnapshot,
  resolveDefaultUserShell,
  type CodexUserShell,
} from '../codex/shell-snapshot.js';
import {
  findCursorSessionFileById,
  listCursorSessionFileSummaries,
  readCursorSessionMirrorRecordDeltaByFilePath,
  type CursorSessionFileSummary,
} from './session-index.js';

const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_INPUT_READY_TIMEOUT_MS = 180_000;
const INPUT_READY_PROGRESS_INTERVAL_MS = 10_000;
const INPUT_SUBMISSION_RETRY_INTERVAL_MS = 1_000;
const INPUT_SUBMISSION_CONFIRMATION_GRACE_MS = 300;
const DEFAULT_SESSION_FILE_TIMEOUT_MS = 30_000;
const DEFAULT_OUTPUT_IDLE_TIMEOUT_MS = 120_000;

class CursorInputReadinessTimeoutError extends Error {}
class CursorInputSubmissionTimeoutError extends Error {}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function positiveIntEnv(name: string, fallback: number, minimum: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= minimum ? Math.floor(value) : fallback;
}

function debugKeepsTmuxAlive(): boolean {
  return /^(?:1|true|yes|on)$/i.test((process.env.CODELARK_DEBUG || '').trim());
}

export function resolveCursorCliExecutable(): string {
  const configured = process.env.CURSOR_AGENT_EXECUTABLE || process.env.CODELARK_CURSOR_EXECUTABLE;
  if (configured?.trim()) return configured.trim();
  const localAgent = path.join(os.homedir(), '.local', 'bin', 'agent');
  return fs.existsSync(localAgent) ? localAgent : 'agent';
}

export function cursorTmuxSessionName(bridgeSessionId: string): string {
  return `clk-cursor-${bridgeSessionId}`;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function commandPreview(command: string, args: string[]): string {
  return [command, ...args].map(shellQuote).join(' ');
}

function definedEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function cursorCommandEnvironmentPrefix(env: NodeJS.ProcessEnv): string {
  const values = [
    ['CURSOR_CONFIG_DIR', env.CURSOR_CONFIG_DIR],
    ['CURSOR_DATA_DIR', env.CURSOR_DATA_DIR],
    ['CURSOR_API_KEY', env.CURSOR_API_KEY],
    ['CURSOR_AUTH_TOKEN', env.CURSOR_AUTH_TOKEN],
  ]
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([key, value]) => `${key}=${shellQuote(value)}`);
  return values.length > 0 ? `${values.join(' ')} ` : '';
}

export function buildCursorTmuxLaunchCommand(
  executable: string,
  args: string[],
  options: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    shell?: CodexUserShell;
  } = {},
): string | string[] {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  if (platform !== 'win32') {
    return `${cursorCommandEnvironmentPrefix(env)}${commandPreview(executable, args)}`;
  }
  const shell = options.shell || resolveDefaultUserShell({ platform });
  const snapshot = ensureShellSnapshot(definedEnvironment(env), shell);
  return buildShellSnapshotLaunchArgs(executable, args, snapshot, { platform });
}

function normalizeScreen(screen: string): string {
  return screen
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

export function cursorAuthenticationScreenError(screen: string): string | null {
  const normalized = normalizeScreen(screen);
  if (/Press any key to log in/i.test(normalized)) {
    return 'Cursor Agent is not authenticated. Run `agent login` in a terminal first.';
  }
  if (/Authentication required/i.test(normalized)) {
    return 'Cursor Agent authentication is required. Run `agent login` or configure CURSOR_API_KEY.';
  }
  return null;
}

export function isCursorInputReadyScreen(screen: string): boolean {
  const normalized = normalizeScreen(screen);
  if (cursorAuthenticationScreenError(normalized)) return false;
  const hasPrompt = /(?:^|\n)\s*[>›❯→]\s*/u.test(normalized);
  const hasMode = /(?:^|\s)(?:Agent|Ask|Plan)(?:\s|$)/u.test(normalized);
  const hasContext = /(?:^|\s)Context(?:\s|$)/u.test(normalized);
  return hasPrompt || (hasMode && hasContext);
}

export function isCursorInputDraftScreen(screen: string): boolean {
  const normalized = normalizeScreen(screen);
  const promptLines = normalized.split('\n').filter((line) => /^\s*[>›❯→]\s*/u.test(line));
  const promptText = promptLines.at(-1)
    ?.replace(/^\s*[>›❯→]\s*/u, '')
    .replace(/\s{2,}ctrl\+c\s+to\s+stop\s*$/i, '')
    .trim() || '';
  if (!promptText) return false;
  return !/^(?:Plan, search, build anything|Add a follow-up|Ask anything)[.!]?$/i.test(promptText);
}

function assertCursorPaneAlive(screen: string): void {
  const authenticationError = cursorAuthenticationScreenError(screen);
  if (authenticationError) throw new Error(authenticationError);
  const paneDead = detectRuntimeTmuxPaneDead(screen);
  if (!paneDead) return;
  const status = paneDead.status === undefined ? '' : ` (exit ${paneDead.status})`;
  throw new Error(`Cursor Agent exited before becoming ready${status}.`);
}

function buildCursorArgs(params: StreamChatParams): string[] {
  const args: string[] = [];
  if (params.cursorSessionId) args.push('--resume', params.cursorSessionId);
  if (params.model) args.push('--model', params.model);
  if (params.cursorForce) args.push('--force');
  args.push('--trust');
  return args;
}

async function launchCursorTmuxSession(sessionName: string, params: StreamChatParams): Promise<void> {
  const executable = resolveCursorCliExecutable();
  const args = buildCursorArgs(params);
  const command = buildCursorTmuxLaunchCommand(executable, args);
  console.log('[cursor-tmux] Cursor TUI start:', {
    bridge_session_id: params.sessionId,
    tmux_session: sessionName,
    command,
    cwd: params.workingDirectory || null,
    resume_session_id: params.cursorSessionId || null,
    debug_keep_tmux: debugKeepsTmuxAlive(),
  });
  transitionRuntimeTmuxInputState('cursor', sessionName, 'starting_tmux', 'starting Cursor tmux session');
  await tmuxCore.ensureDetachedSession({
    name: sessionName,
    cwd: params.workingDirectory,
    command,
    recreate: true,
  });
}

async function waitForCursorInputReady(
  sessionName: string,
  targetPane: string,
  onProgress?: (elapsedMs: number) => void,
): Promise<void> {
  const timeoutMs = positiveIntEnv(
    'CODELARK_CURSOR_TMUX_INPUT_READY_TIMEOUT_MS',
    DEFAULT_INPUT_READY_TIMEOUT_MS,
    1_000,
  );
  const pollIntervalMs = positiveIntEnv(
    'CODELARK_CURSOR_TMUX_POLL_INTERVAL_MS',
    DEFAULT_POLL_INTERVAL_MS,
    50,
  );
  const startedAt = Date.now();
  let lastProgressAt = startedAt;
  let lastScreen = '';
  while (Date.now() - startedAt <= timeoutMs) {
    const capture = await tmuxCore.capturePane(targetPane, 160);
    lastScreen = capture.screen;
    assertCursorPaneAlive(lastScreen);
    if (isCursorInputReadyScreen(lastScreen)) return;
    const now = Date.now();
    if (onProgress && now - lastProgressAt >= INPUT_READY_PROGRESS_INTERVAL_MS) {
      lastProgressAt = now;
      onProgress(now - startedAt);
    }
    await sleep(pollIntervalMs);
  }
  const tail = normalizeScreen(lastScreen)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-6)
    .join(' · ');
  throw new CursorInputReadinessTimeoutError([
    `Cursor Agent 在 ${Math.round(timeoutMs / 1_000)}s 内尚未进入输入界面，首次打开工作区时可能仍在建立索引。`,
    'tmux session 已保留；稍后重新发送消息即可继续，也可以用 `/tmux-screen` 查看当前屏幕。',
    ...(tail ? [`当前屏幕末尾：${tail}`] : []),
  ].join(' '));
}

async function waitForCursorInputSubmitted(
  targetPane: string,
  onProgress?: (elapsedMs: number) => void,
): Promise<void> {
  const timeoutMs = positiveIntEnv(
    'CODELARK_CURSOR_TMUX_INPUT_READY_TIMEOUT_MS',
    DEFAULT_INPUT_READY_TIMEOUT_MS,
    1_000,
  );
  const pollIntervalMs = positiveIntEnv(
    'CODELARK_CURSOR_TMUX_POLL_INTERVAL_MS',
    DEFAULT_POLL_INTERVAL_MS,
    50,
  );
  const startedAt = Date.now();
  let lastProgressAt = startedAt;
  let lastRetryAt = 0;
  await sleep(INPUT_SUBMISSION_CONFIRMATION_GRACE_MS);
  while (Date.now() - startedAt <= timeoutMs) {
    const capture = await tmuxCore.capturePane(targetPane, 160);
    assertCursorPaneAlive(capture.screen);
    if (!isCursorInputDraftScreen(capture.screen)) return;
    const now = Date.now();
    if (now - lastRetryAt >= INPUT_SUBMISSION_RETRY_INTERVAL_MS) {
      await tmuxCore.sendActions(targetPane, [{ type: 'key', key: 'Enter' }]);
      lastRetryAt = now;
    }
    if (onProgress && now - lastProgressAt >= INPUT_READY_PROGRESS_INTERVAL_MS) {
      lastProgressAt = now;
      onProgress(now - startedAt);
    }
    await sleep(pollIntervalMs);
  }
  throw new CursorInputSubmissionTimeoutError([
    `Cursor Agent 在 ${Math.round(timeoutMs / 1_000)}s 内仍未接受输入。`,
    '输入保留在编辑框，tmux session 也已保留；可以稍后重新发送，或用 `/tmux-screen` 查看当前屏幕。',
  ].join(' '));
}

function transcriptSize(summary: CursorSessionFileSummary | null | undefined): number {
  if (!summary?.filePath) return 0;
  try {
    return fs.statSync(summary.filePath).size;
  } catch {
    return 0;
  }
}

function latestCursorSession(cwd: string | undefined): CursorSessionFileSummary | null {
  return listCursorSessionFileSummaries(cwd).find((summary) => Boolean(summary.filePath)) || null;
}

export interface CursorTmuxInputSession {
  sessionName: string;
  targetPane: string;
  sessionId?: string;
  cwd?: string;
  sessionFilePath?: string;
  sessionStorePath?: string;
  nextOffset: number;
  existed: boolean;
}

export async function ensureCursorTmuxInputSession(
  params: StreamChatParams,
  options: {
    recreate?: boolean;
    onReadinessProgress?: (elapsedMs: number) => void;
  } = {},
): Promise<CursorTmuxInputSession> {
  const sessionName = cursorTmuxSessionName(params.sessionId);
  const targetPane = `${sessionName}:0.0`;
  const known = params.cursorSessionId
    ? findCursorSessionFileById(params.cursorSessionId, params.workingDirectory)
    : null;
  const inspection = await inspectRuntimeTmuxInput({
    runtime: 'cursor',
    sessionName,
    hasSession: () => tmuxCore.hasSession(sessionName),
  });
  const launched = !inspection.exists || options.recreate === true;
  if (launched) await launchCursorTmuxSession(sessionName, params);
  if (launched || inspection.needsReadiness) {
    await tmuxCore.ensureExtendedKeys?.();
    await waitForCursorInputReady(sessionName, targetPane, options.onReadinessProgress);
  }
  const discovered = known || (!params.cursorSessionId && !launched ? latestCursorSession(params.workingDirectory) : null);
  transitionRuntimeTmuxInputState(
    'cursor',
    sessionName,
    'running',
    launched ? 'Cursor tmux process is ready for input' : 'existing Cursor tmux process is reusable',
  );
  return {
    sessionName,
    targetPane,
    ...(discovered?.sessionId ? { sessionId: discovered.sessionId } : {}),
    ...(discovered?.cwd || params.workingDirectory ? { cwd: discovered?.cwd || params.workingDirectory } : {}),
    ...(discovered?.filePath ? { sessionFilePath: discovered.filePath } : {}),
    ...(discovered?.storePath ? { sessionStorePath: discovered.storePath } : {}),
    nextOffset: transcriptSize(discovered),
    existed: inspection.exists,
  };
}

export async function restartCursorTmuxInputSession(params: StreamChatParams): Promise<CursorTmuxInputSession> {
  return ensureCursorTmuxInputSession(params, { recreate: true });
}

interface CursorTurnContext {
  sessionName: string;
  sessionId?: string;
  cwd?: string;
  sessionFilePath?: string;
  sessionStorePath?: string;
  nextOffset: number;
  trailingText: string;
  nextTurnId: string | null;
  nextSpecialCallIds: string[];
  emittedSignatures: Set<string>;
  emittedToolStarts: Set<string>;
  terminalSeen: boolean;
}

function enqueueCursorRecord(
  controller: ReadableStreamDefaultController<string>,
  context: CursorTurnContext,
  record: BridgeMirrorRecord,
): void {
  if (context.emittedSignatures.has(record.signature)) return;
  context.emittedSignatures.add(record.signature);
  if (record.type === 'message' && record.role === 'assistant' && record.content) {
    controller.enqueue(sseEvent(record.replacementKey ? 'text_snapshot' : 'text', record.content));
    return;
  }
  if (record.type === 'reasoning' && record.content) {
    if (record.reasoningKind === 'summary') {
      controller.enqueue(sseEvent('history_item', {
        type: 'markdown',
        role: 'thinking',
        variant: 'thinking_summary',
        content: record.content,
      }));
      return;
    }
    if (record.reasoningKind === 'history') {
      controller.enqueue(sseEvent('history_item', {
        type: 'markdown',
        role: 'thinking',
        content: record.content,
      }));
      return;
    }
    controller.enqueue(sseEvent('status', { reasoning: record.content }));
    return;
  }
  if (record.type === 'tool_started') {
    const id = record.toolId || record.signature;
    context.emittedToolStarts.add(id);
    controller.enqueue(sseEvent('tool_use', {
      id,
      name: record.toolName || 'tool',
      input: record.toolInput || {},
    }));
    return;
  }
  if (record.type === 'tool_finished') {
    const id = record.toolId || record.signature;
    if (!context.emittedToolStarts.has(id)) {
      context.emittedToolStarts.add(id);
      controller.enqueue(sseEvent('tool_use', { id, name: record.toolName || 'tool', input: {} }));
    }
    controller.enqueue(sseEvent('tool_result', {
      tool_use_id: id,
      content: record.content || 'Done',
      is_error: record.isError === true,
    }));
    return;
  }
  if (record.type === 'task_complete') {
    context.terminalSeen = true;
    controller.enqueue(sseEvent('result', {
      ...(context.sessionId ? { session_id: context.sessionId } : {}),
      ...(context.cwd ? { cwd: context.cwd } : {}),
    }));
    return;
  }
  if (record.type === 'task_aborted') {
    context.terminalSeen = true;
    controller.enqueue(sseEvent('error', record.content || 'Cursor Agent task aborted.'));
  }
}

async function waitForCursorTranscript(
  context: CursorTurnContext,
  baselineSessionIds: Set<string>,
  targetPane: string,
): Promise<void> {
  const timeoutMs = positiveIntEnv(
    'CODELARK_CURSOR_TMUX_SESSION_FILE_TIMEOUT_MS',
    DEFAULT_SESSION_FILE_TIMEOUT_MS,
    1_000,
  );
  const pollIntervalMs = positiveIntEnv(
    'CODELARK_CURSOR_TMUX_POLL_INTERVAL_MS',
    DEFAULT_POLL_INTERVAL_MS,
    50,
  );
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    const summary = context.sessionId
      ? findCursorSessionFileById(context.sessionId, context.cwd)
      : listCursorSessionFileSummaries(context.cwd)
        .find((candidate) => Boolean(candidate.filePath) && !baselineSessionIds.has(candidate.sessionId));
    if (summary?.filePath) {
      context.sessionId = summary.sessionId;
      context.cwd = summary.cwd || context.cwd;
      context.sessionFilePath = summary.filePath;
      context.sessionStorePath = summary.storePath;
      return;
    }
    const capture = await tmuxCore.capturePane(targetPane, 160);
    assertCursorPaneAlive(capture.screen);
    await sleep(pollIntervalMs);
  }
  throw new Error('Timed out waiting for Cursor Agent to create its transcript JSONL.');
}

async function pollCursorTranscript(
  controller: ReadableStreamDefaultController<string>,
  context: CursorTurnContext,
  targetPane: string,
  abortSignal: AbortSignal | undefined,
): Promise<void> {
  const pollIntervalMs = positiveIntEnv(
    'CODELARK_CURSOR_TMUX_POLL_INTERVAL_MS',
    DEFAULT_POLL_INTERVAL_MS,
    50,
  );
  const idleTimeoutMs = positiveIntEnv(
    'CODELARK_CURSOR_TMUX_OUTPUT_IDLE_TIMEOUT_MS',
    DEFAULT_OUTPUT_IDLE_TIMEOUT_MS,
    1_000,
  );
  let lastActivityAt = Date.now();
  while (!context.terminalSeen) {
    if (abortSignal?.aborted) throw new Error('Cursor Agent request was aborted.');
    if (!context.sessionFilePath) throw new Error('Cursor transcript path was not resolved.');
    let endOffset = context.nextOffset;
    try {
      endOffset = fs.statSync(context.sessionFilePath).size;
    } catch {
      // Preserve the cursor and retry transient replacement races.
    }
    if (endOffset < context.nextOffset) {
      context.nextOffset = 0;
      context.trailingText = '';
    }
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
    for (const record of delta.records) enqueueCursorRecord(controller, context, record);
    if (context.nextOffset > previousOffset) lastActivityAt = Date.now();
    if (context.terminalSeen) break;
    const existence = await tmuxCore.hasSession(context.sessionName);
    if (!existence.exists) throw new Error('Cursor Agent exited before writing a terminal turn event.');
    if (Date.now() - lastActivityAt > idleTimeoutMs) {
      const capture = await tmuxCore.capturePane(targetPane, 160);
      assertCursorPaneAlive(capture.screen);
      throw new Error(`Cursor Agent produced no transcript activity for ${idleTimeoutMs}ms.`);
    }
    await sleep(pollIntervalMs);
  }
}

export function streamCursorTmuxTui(params: StreamChatParams): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      void (async () => {
        const sessionName = cursorTmuxSessionName(params.sessionId);
        const targetPane = `${sessionName}:0.0`;
        const baselineSessionIds = new Set(
          listCursorSessionFileSummaries(params.workingDirectory).map((summary) => summary.sessionId),
        );
        const context: CursorTurnContext = {
          sessionName,
          sessionId: params.cursorSessionId,
          cwd: params.workingDirectory,
          nextOffset: 0,
          trailingText: '',
          nextTurnId: null,
          nextSpecialCallIds: [],
          emittedSignatures: new Set(),
          emittedToolStarts: new Set(),
          terminalSeen: false,
        };
        let failed = false;
        let preserveTmuxAfterFailure = false;
        try {
          controller.enqueue(sseEvent('status', {
            reasoning: params.cursorSessionId
              ? '正在确认 Cursor tmux 和当前 Cursor chat。'
              : '正在初始化 Cursor tmux 和 Cursor chat；首次打开工作区时可能需要先建立索引。',
          }));
          const prepared = await ensureCursorTmuxInputSession(params, {
            onReadinessProgress: (elapsedMs) => {
              controller.enqueue(sseEvent('status', {
                reasoning: `Cursor Agent 正在准备工作区；首次打开时通常会建立索引，已等待 ${Math.floor(elapsedMs / 1_000)}s。`,
              }));
            },
          });
          context.sessionId = prepared.sessionId;
          context.cwd = prepared.cwd;
          context.sessionFilePath = prepared.sessionFilePath;
          context.sessionStorePath = prepared.sessionStorePath;
          context.nextOffset = prepared.nextOffset;
          if (context.sessionId) {
            controller.enqueue(sseEvent('status', {
              session_id: context.sessionId,
              ...(context.cwd ? { cwd: context.cwd } : {}),
            }));
          }
          await sendRuntimeTmuxInput({
            runtime: 'cursor',
            sessionName,
            send: async () => {
              const result = await tmuxCore.injectPromptIntoPane(targetPane, params.prompt);
              await waitForCursorInputSubmitted(targetPane, (elapsedMs) => {
                controller.enqueue(sseEvent('status', {
                  reasoning: `输入已写入 Cursor；工作区索引可能仍在进行，正在确认提交，已等待 ${Math.floor(elapsedMs / 1_000)}s。`,
                }));
              });
              return result;
            },
          });
          controller.enqueue(sseEvent('status', {
            reasoning: 'Cursor Agent 已接收消息，正在运行。',
          }));
          if (!context.sessionFilePath) {
            await waitForCursorTranscript(context, baselineSessionIds, targetPane);
            context.nextOffset = 0;
            controller.enqueue(sseEvent('status', {
              session_id: context.sessionId,
              ...(context.cwd ? { cwd: context.cwd } : {}),
            }));
          }
          await pollCursorTranscript(controller, context, targetPane, params.abortController?.signal);
          controller.close();
        } catch (error) {
          failed = true;
          preserveTmuxAfterFailure = error instanceof CursorInputReadinessTimeoutError
            || error instanceof CursorInputSubmissionTimeoutError;
          const message = error instanceof Error ? error.message : String(error);
          transitionRuntimeTmuxInputState('cursor', sessionName, 'failed', 'Cursor tmux lifecycle failed', { error: message });
          console.error('[cursor-tmux] Error:', error instanceof Error ? error.stack || error.message : error);
          try {
            controller.enqueue(sseEvent('error', message || 'Cursor TUI execution failed.'));
            controller.close();
          } catch {
            // The stream may already be closed by its consumer.
          }
        } finally {
          if (
            failed
            && !preserveTmuxAfterFailure
            && !debugKeepsTmuxAlive()
          ) {
            try {
              await tmuxCore.killSession(sessionName, { ignoreMissing: true });
            } catch {
              // Best-effort cleanup; the next lifecycle probes tmux again.
            }
          }
        }
      })();
    },
  });
}

export class CursorTmuxProvider implements LLMProvider {
  streamChat(params: StreamChatParams): ReadableStream<string> {
    return streamCursorTmuxTui(params);
  }
}
