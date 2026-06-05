import fs from 'node:fs';

import type { LLMProvider, StreamChatParams } from '../contracts.js';
import type { PendingPermissions } from '../permission-gateway.js';
import { sseEvent } from '../sse.js';
import { resolveCodexCliExecutable } from './cli-executable.js';
import {
  buildCodexTuiArgs,
  buildCodexTuiEnv,
  buildCodexTuiUpdateChoiceActions,
  buildTempImageFiles,
  compactCodexTuiUpdateProgress,
  findSessionFileByThreadId,
  hasCodexTuiTrustPrompt,
  hasCodexTuiUpdatePrompt,
  isTruthyEnv,
  parseCodexTuiUpdatePrompt,
  parsePositiveIntEnv,
  pollCodexTuiSessionFile,
  requestCodexTuiTrustConfirmation,
  requestCodexTuiUpdateConfirmation,
  snapshotSessionFiles,
  type CodexTuiRunContext,
} from './tmux-provider.js';

const DEFAULT_PTY_PROMPT_DELAY_MS = 1_200;
const DEFAULT_PTY_TRUST_PROMPT_TIMEOUT_MS = 2_000;
const DEFAULT_PTY_AFTER_TRUST_DELAY_MS = 1_000;
const DEFAULT_PTY_SUBMIT_DELAY_MS = 100;
const DEFAULT_PTY_UPDATE_PROMPT_TIMEOUT_MS = 2_000;
const DEFAULT_CODEX_TUI_UPDATE_TIMEOUT_MS = 300_000;
const PTY_WRITE_CHUNK_SIZE = 512;
const PTY_WRITE_CHUNK_DELAY_MS = 25;
const MAX_SCREEN_BUFFER_CHARS = 200_000;

interface PtyExitEvent {
  exitCode: number;
  signal?: number;
}

interface PtyProcess {
  write(data: string): void;
  kill(signal?: string): void;
  onData(callback: (data: string) => void): void;
  onExit(callback: (event: PtyExitEvent) => void): void;
}

interface PtyModule {
  spawn(
    file: string,
    args: string[],
    options: {
      name: string;
      cols: number;
      rows: number;
      cwd?: string;
      env: Record<string, string>;
    },
  ): PtyProcess;
}

export interface PtyScreenSnapshot {
  sessionId: string;
  threadId?: string;
  cwd?: string;
  startedAt: string;
  updatedAt: string;
  exited: boolean;
  exitCode?: number;
  signal?: number;
  screen: string;
}

interface PtyScreenState {
  sessionId: string;
  threadId?: string;
  cwd?: string;
  child?: PtyProcess;
  startedAtMs: number;
  updatedAtMs: number;
  exited: boolean;
  exitEvent?: PtyExitEvent;
  buffer: string;
}

const ptyScreens = new Map<string, PtyScreenState>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function shouldUseCodexPtyTui(): boolean {
  return isTruthyEnv(process.env.CODELARK_CODEX_USE_PTY_TUI)
    || isTruthyEnv(process.env.CODELARK_CODEX_PTY_TUI);
}

function isDebugPtyOutput(): boolean {
  return isTruthyEnv(process.env.CODELARK_DEBUG_PTY)
    || isTruthyEnv(process.env.CODELARK_DEBUG);
}

function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[PX^_].*?\x1b\\/gs, '')
    .replace(/\x1b[@-_]/g, '');
}

function normalizePtyOutput(text: string): string {
  return stripAnsi(text)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

function registerPtyScreen(params: {
  sessionId: string;
  threadId?: string;
  cwd?: string;
  startedAtMs?: number;
}): void {
  ptyScreens.set(params.sessionId, {
    sessionId: params.sessionId,
    threadId: params.threadId,
    cwd: params.cwd,
    startedAtMs: params.startedAtMs || Date.now(),
    updatedAtMs: Date.now(),
    exited: false,
    buffer: '',
  });
}

function attachPtyScreenChild(sessionId: string, child: PtyProcess): void {
  const state = ptyScreens.get(sessionId);
  if (!state) return;
  state.child = child;
  state.updatedAtMs = Date.now();
}

function appendPtyScreenData(sessionId: string, data: string): void {
  const state = ptyScreens.get(sessionId);
  if (!state) return;
  state.buffer += normalizePtyOutput(data);
  if (state.buffer.length > MAX_SCREEN_BUFFER_CHARS) {
    state.buffer = state.buffer.slice(-MAX_SCREEN_BUFFER_CHARS);
  }
  state.updatedAtMs = Date.now();
}

function markPtyScreenExited(sessionId: string, event: PtyExitEvent): void {
  const state = ptyScreens.get(sessionId);
  if (!state) return;
  state.exited = true;
  state.exitEvent = event;
  state.updatedAtMs = Date.now();
}

function tailLines(text: string, lines: number): string {
  const trimmed = text.replace(/\s+$/g, '');
  if (lines <= 0) return trimmed;
  return trimmed.split('\n').slice(-lines).join('\n');
}

function getPtyScreenBuffer(sessionId: string): string {
  return ptyScreens.get(sessionId)?.buffer || '';
}

async function waitForPtyBuffer(
  sessionId: string,
  predicate: (buffer: string) => boolean,
  timeoutMs: number,
  intervalMs = 100,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate(getPtyScreenBuffer(sessionId))) return true;
    await sleep(intervalMs);
  }
  return predicate(getPtyScreenBuffer(sessionId));
}

export function capturePtyScreen(sessionId: string, lines = 0): PtyScreenSnapshot | null {
  const state = ptyScreens.get(sessionId);
  if (!state) return null;
  return {
    sessionId: state.sessionId,
    threadId: state.threadId,
    cwd: state.cwd,
    startedAt: new Date(state.startedAtMs).toISOString(),
    updatedAt: new Date(state.updatedAtMs).toISOString(),
    exited: state.exited,
    exitCode: state.exitEvent?.exitCode,
    signal: state.exitEvent?.signal,
    screen: tailLines(state.buffer, lines),
  };
}

export async function injectPromptIntoActivePty(sessionId: string, prompt: string): Promise<boolean> {
  const state = ptyScreens.get(sessionId);
  if (!state?.child || state.exited) return false;
  await injectPromptIntoPty(state.child, prompt);
  return true;
}

export const _testOnlyPtyScreens = {
  register: registerPtyScreen,
  attachChild: attachPtyScreenChild,
  append: appendPtyScreenData,
  exit: markPtyScreenExited,
  injectPromptIntoActivePty,
  clear: () => ptyScreens.clear(),
  count: () => ptyScreens.size,
};

async function loadPtyModule(): Promise<PtyModule> {
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<unknown>;
  try {
    const loaded = await dynamicImport('@homebridge/node-pty-prebuilt-multiarch') as { default?: unknown };
    return (loaded.default || loaded) as PtyModule;
  } catch (primaryError) {
    try {
      const loaded = await dynamicImport('node-pty') as { default?: unknown };
      return (loaded.default || loaded) as PtyModule;
    } catch {
      const detail = primaryError instanceof Error ? primaryError.message : String(primaryError);
      throw new Error([
        'pty Provider 需要可用的 node pty 运行时，但当前安装未能加载。',
        '请重新安装 codelark 依赖；如果仍失败，可以先切回 `/provider sdk`，或在已安装 tmux 的系统上使用 `/provider tmux`。',
        `原始错误：${detail}`,
      ].join('\n'));
    }
  }
}

function buildPtyEnv(): Record<string, string> {
  const env = buildCodexTuiEnv();
  env.TERM = env.TERM || 'xterm-256color';
  return env;
}

async function writePtyChunks(child: PtyProcess, text: string): Promise<void> {
  if (!text) return;
  const chars = Array.from(text);
  for (let offset = 0; offset < chars.length; offset += PTY_WRITE_CHUNK_SIZE) {
    child.write(chars.slice(offset, offset + PTY_WRITE_CHUNK_SIZE).join(''));
    if (offset + PTY_WRITE_CHUNK_SIZE < chars.length) {
      await sleep(PTY_WRITE_CHUNK_DELAY_MS);
    }
  }
}

export async function prepareCodexPtyForPrompt(params: {
  child: PtyProcess;
  controller: ReadableStreamDefaultController<string>;
  pendingPerms?: PendingPermissions;
  sessionId: string;
  workingDirectory?: string;
}): Promise<void> {
  const trustPromptTimeoutMs = parsePositiveIntEnv(
    'CODELARK_CODEX_PTY_TRUST_PROMPT_TIMEOUT_MS',
    DEFAULT_PTY_TRUST_PROMPT_TIMEOUT_MS,
    0,
  );
  const sawTrustPrompt = trustPromptTimeoutMs > 0
    ? await waitForPtyBuffer(params.sessionId, hasCodexTuiTrustPrompt, trustPromptTimeoutMs)
    : hasCodexTuiTrustPrompt(getPtyScreenBuffer(params.sessionId));
  if (!sawTrustPrompt) return;

  console.log('[codex-pty] Codex TUI trust prompt detected; waiting for user confirmation before prompt injection');
  await requestCodexTuiTrustConfirmation({
    controller: params.controller,
    pendingPerms: params.pendingPerms,
    provider: 'pty',
    bridgeSessionId: params.sessionId,
    workingDirectory: params.workingDirectory,
    screenCommand: '/pty-screen 80',
  });
  params.child.write('\r');
  const afterTrustDelayMs = parsePositiveIntEnv(
    'CODELARK_CODEX_PTY_AFTER_TRUST_DELAY_MS',
    DEFAULT_PTY_AFTER_TRUST_DELAY_MS,
    0,
  );
  if (afterTrustDelayMs > 0) await sleep(afterTrustDelayMs);
}

async function waitForPtyExit(params: {
  sessionId: string;
  isExited: () => boolean;
  controller: ReadableStreamDefaultController<string>;
  timeoutMs: number;
}): Promise<void> {
  const deadline = Date.now() + params.timeoutMs;
  let lastProgress = '';
  while (!params.isExited()) {
    const progress = compactCodexTuiUpdateProgress(getPtyScreenBuffer(params.sessionId));
    if (progress && progress !== lastProgress) {
      lastProgress = progress;
      params.controller.enqueue(sseEvent('status', { reasoning: `Codex 正在更新：\n${progress}` }));
    }
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for Codex update to finish.');
    }
    await sleep(1_000);
  }
}

export async function prepareCodexPtyUpdatePrompt(params: {
  child: PtyProcess;
  controller: ReadableStreamDefaultController<string>;
  pendingPerms?: PendingPermissions;
  sessionId: string;
  isExited: () => boolean;
}): Promise<boolean> {
  const updatePromptTimeoutMs = parsePositiveIntEnv(
    'CODELARK_CODEX_PTY_UPDATE_PROMPT_TIMEOUT_MS',
    DEFAULT_PTY_UPDATE_PROMPT_TIMEOUT_MS,
    0,
  );
  const sawUpdatePrompt = updatePromptTimeoutMs > 0
    ? await waitForPtyBuffer(params.sessionId, hasCodexTuiUpdatePrompt, updatePromptTimeoutMs)
    : hasCodexTuiUpdatePrompt(getPtyScreenBuffer(params.sessionId));
  if (!sawUpdatePrompt) return false;

  const prompt = parseCodexTuiUpdatePrompt(getPtyScreenBuffer(params.sessionId));
  if (!prompt) return false;
  console.log('[codex-pty] Codex TUI update prompt detected; waiting for user confirmation');
  const choice = await requestCodexTuiUpdateConfirmation({
    controller: params.controller,
    pendingPerms: params.pendingPerms,
    provider: 'pty',
    bridgeSessionId: params.sessionId,
    screenCommand: '/pty-screen 80',
    prompt,
  });
  const actions = buildCodexTuiUpdateChoiceActions(prompt, choice);
  for (const action of actions) {
    if (action.type === 'literal') {
      params.child.write(action.text);
    } else if (action.key === 'Enter') {
      params.child.write('\r');
    } else if (action.key === 'Up') {
      params.child.write('\x1b[A');
    } else if (action.key === 'Down') {
      params.child.write('\x1b[B');
    }
  }
  if (choice !== 'update_now') {
    return false;
  }

  params.controller.enqueue(sseEvent('status', { reasoning: '用户确认更新 Codex CLI，正在等待更新完成。' }));
  const timeoutMs = parsePositiveIntEnv(
    'CODELARK_CODEX_TUI_UPDATE_TIMEOUT_MS',
    DEFAULT_CODEX_TUI_UPDATE_TIMEOUT_MS,
    1_000,
  );
  await waitForPtyExit({
    sessionId: params.sessionId,
    isExited: params.isExited,
    controller: params.controller,
    timeoutMs,
  });
  params.controller.enqueue(sseEvent('status', { reasoning: 'Codex CLI 更新流程已结束，正在重新启动 Codex pty。' }));
  return true;
}

export async function injectPromptIntoPty(child: PtyProcess, prompt: string): Promise<void> {
  const lines = prompt.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  console.log('[codex-pty] Prompt inject start:', {
    prompt_chars: prompt.length,
    lines: lines.length,
    newline_sequence: 'ESC CR',
    submit_sequence: 'CR',
  });
  for (let i = 0; i < lines.length; i += 1) {
    await writePtyChunks(child, lines[i] || '');
    if (i < lines.length - 1) {
      child.write('\x1b\r');
      await sleep(PTY_WRITE_CHUNK_DELAY_MS);
    }
  }
  const submitDelayMs = parsePositiveIntEnv('CODELARK_CODEX_PTY_SUBMIT_DELAY_MS', DEFAULT_PTY_SUBMIT_DELAY_MS, 0);
  if (submitDelayMs > 0) await sleep(submitDelayMs);
  child.write('\r');
  console.log('[codex-pty] Prompt inject submitted:', {
    prompt_chars: prompt.length,
    lines: lines.length,
  });
}

export function streamCodexPtyTui(params: StreamChatParams, pendingPerms?: PendingPermissions): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      (async () => {
        const tempFiles: string[] = [];
        const before = snapshotSessionFiles();
        const startedAtMs = Date.now();
        let child: PtyProcess | null = null;
        let exited = false;
        let exitEvent: PtyExitEvent | null = null;
        const context: CodexTuiRunContext = {
          sessionName: `pty-${process.pid}-${Date.now()}`,
          targetPane: 'pty',
          bridgeSessionId: params.sessionId,
          threadId: params.codexThreadId,
          sessionFilePath: params.codexThreadId ? findSessionFileByThreadId(params.codexThreadId) || undefined : undefined,
          nextOffset: 0,
          trailingText: '',
          nextTurnId: null,
          nextSpecialCallIds: [],
          emittedToolStarts: new Set(),
          emittedRecordSignatures: new Set(),
          lastAssistantText: '',
          terminalSeen: false,
          hasError: false,
        };
        if (context.sessionFilePath) {
          context.nextOffset = before.get(context.sessionFilePath)?.size || 0;
        }

        const abortListener = () => {
          if (!child || exited) return;
          try { child.write('\x03'); } catch { /* best-effort interrupt */ }
        };

        try {
          const imagePaths = buildTempImageFiles(params, tempFiles);
          const pty = await loadPtyModule();
          const codexArgs = buildCodexTuiArgs(params, imagePaths);
          const env = buildPtyEnv();
          const command = resolveCodexCliExecutable({ env });
          params.abortController?.signal.addEventListener('abort', abortListener, { once: true });

          for (let launchAttempt = 0; launchAttempt < 2; launchAttempt += 1) {
            exited = false;
            exitEvent = null;
            controller.enqueue(sseEvent('status', { reasoning: params.codexThreadId
              ? '正在启动 Codex pty，并 resume 当前 Codex thread。'
              : '正在启动 Codex pty。' }));
            console.log('[codex-pty] Codex TUI start:', {
              bridge_session_id: params.sessionId,
              command,
              args: codexArgs.map((arg) => imagePaths.includes(arg) ? '<image-path:redacted>' : arg),
              prompt_chars: params.prompt.length,
              cwd: params.workingDirectory || process.cwd(),
              resume_thread_id: params.codexThreadId || null,
              launch_attempt: launchAttempt + 1,
            });
            registerPtyScreen({
              sessionId: params.sessionId,
              threadId: params.codexThreadId,
              cwd: params.workingDirectory || process.cwd(),
              startedAtMs: Date.now(),
            });
            child = pty.spawn(command, codexArgs, {
              name: env.TERM || 'xterm-256color',
              cols: 100,
              rows: 30,
              cwd: params.workingDirectory || process.cwd(),
              env,
            });
            attachPtyScreenChild(params.sessionId, child);
            child.onData((data) => {
              appendPtyScreenData(params.sessionId, data);
              if (isDebugPtyOutput()) process.stdout.write(data);
            });
            child.onExit((event) => {
              exited = true;
              exitEvent = event;
              markPtyScreenExited(params.sessionId, event);
              console.log('[codex-pty] Codex TUI exited:', event);
            });

            const promptDelayMs = parsePositiveIntEnv('CODELARK_CODEX_PTY_PROMPT_DELAY_MS', DEFAULT_PTY_PROMPT_DELAY_MS, 0);
            if (promptDelayMs > 0) await sleep(promptDelayMs);
            if (params.abortController?.signal.aborted) {
              throw new DOMException('Aborted', 'AbortError');
            }
            controller.enqueue(sseEvent('status', { reasoning: 'Codex pty 已启动，正在准备注入本次消息。' }));
            const restartedAfterUpdate = await prepareCodexPtyUpdatePrompt({
              child,
              controller,
              pendingPerms,
              sessionId: params.sessionId,
              isExited: () => exited,
            });
            if (restartedAfterUpdate) {
              child = null;
              if (launchAttempt === 0) continue;
              throw new Error('Codex update finished, but the restarted Codex pty asked to update again.');
            }
            break;
          }
          if (!child) throw new Error('Codex pty did not start.');
          await prepareCodexPtyForPrompt({
            child,
            controller,
            pendingPerms,
            sessionId: params.sessionId,
            workingDirectory: params.workingDirectory,
          });
          controller.enqueue(sseEvent('status', { reasoning: '正在把本次消息发送到 Codex pty。' }));
          await injectPromptIntoPty(child, params.prompt);
          await pollCodexTuiSessionFile(
            controller,
            params,
            context,
            before,
            startedAtMs,
            async () => !exited,
          );
          controller.close();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error('[codex-pty] Error:', error instanceof Error ? error.stack || error.message : error);
          try {
            controller.enqueue(sseEvent('error', message || 'Codex pty execution failed.'));
            controller.close();
          } catch {
            // Controller may already be closed.
          }
        } finally {
          params.abortController?.signal.removeEventListener('abort', abortListener);
          for (const tmp of tempFiles) {
            try { fs.unlinkSync(tmp); } catch { /* ignore */ }
          }
          if (child && !exited) {
            try { child.kill(); } catch { /* best-effort cleanup */ }
          } else {
            const finalExitEvent = exitEvent as PtyExitEvent | null;
            if (finalExitEvent && finalExitEvent.exitCode !== 0 && !context.terminalSeen) {
              console.warn('[codex-pty] Codex TUI exited before terminal record:', finalExitEvent);
            }
          }
        }
      })();
    },
  });
}

export class CodexPtyProvider implements LLMProvider {
  constructor(private readonly pendingPerms?: PendingPermissions) {}

  streamChat(params: StreamChatParams): ReadableStream<string> {
    return streamCodexPtyTui(params, this.pendingPerms);
  }
}
