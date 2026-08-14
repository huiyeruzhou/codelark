import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import type { BridgeMirrorRecord, LLMProvider, StreamChatParams } from '../contracts.js';
import { sseEvent } from '../sse.js';
import { tmuxCore } from '../../bridge/tmux/core.js';
import {
  inspectRuntimeTmuxInput,
  sendRuntimeTmuxInput,
  setRuntimeTmuxTurnState,
  transitionRuntimeTmuxInputState,
} from '../../bridge/tmux/input-state-machine.js';
import { detectRuntimeTmuxPaneDead } from '../../bridge/tmux/runtime.js';
import { CODELARK_HOME } from '../../configuration/paths.js';
import {
  buildShellSnapshotLaunchArgs,
  ensureShellSnapshot,
  resolveDefaultUserShell,
  type CodexUserShell,
} from '../codex/shell-snapshot.js';
import {
  findLatestZcodeTurnId,
  findZcodeSessionById,
  readZcodeSessionMirrorRecords,
  resolveZcodeSessionDbPath,
} from './session-index.js';

const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_INPUT_READY_TIMEOUT_MS = 180_000;
const DEFAULT_SESSION_TIMEOUT_MS = 30_000;
const DEFAULT_OUTPUT_IDLE_TIMEOUT_MS = 120_000;
const INPUT_READY_PROGRESS_INTERVAL_MS = 10_000;
const INPUT_SUBMISSION_RETRY_INTERVAL_MS = 1_000;
const INPUT_SUBMISSION_CONFIRMATION_GRACE_MS = 300;

class ZcodeInputReadinessTimeoutError extends Error {}
class ZcodeInputSubmissionTimeoutError extends Error {}

export function shouldPreserveZcodeTmuxAfterFailure(error: unknown, abortSignal?: AbortSignal): boolean {
  return error instanceof ZcodeInputReadinessTimeoutError
    || error instanceof ZcodeInputSubmissionTimeoutError
    || abortSignal?.aborted === true;
}

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

export function resolveZcodeCliExecutable(): string {
  const configured = process.env.ZCODE_EXECUTABLE || process.env.CODELARK_ZCODE_EXECUTABLE;
  if (configured?.trim()) return configured.trim();
  const local = path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'zcode.exe' : 'zcode');
  return fs.existsSync(local) ? local : 'zcode';
}

export function zcodeTmuxSessionName(bridgeSessionId: string): string {
  return `clk-zcode-${bridgeSessionId}`;
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

function zcodeCommandEnvironmentPrefix(env: NodeJS.ProcessEnv): string {
  const names = [
    'ZCODE_HOME',
    'ZCODE_STORAGE_DIR',
    'ZCODE_SESSION_DB_PATH',
    'ZCODE_DATA_BASE_DIR',
    'ZCODE_LOG_DIR',
    'ZCODE_BASE_URL',
    'ZCODE_TUI_RUNTIME_LOG',
  ];
  const assignments = names.flatMap((name) => {
    const value = env[name];
    return value ? [`${name}=${shellQuote(value)}`] : [];
  });
  return assignments.length > 0 ? `${assignments.join(' ')} ` : '';
}

export function createZcodeSecretEnvironmentFile(
  env: NodeJS.ProcessEnv,
  directory: string,
): string | undefined {
  const apiKey = env.ZCODE_API_KEY?.trim();
  if (!apiKey) return undefined;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch { /* best effort */ }
  const filePath = path.join(directory, `launch-env-${process.pid}-${crypto.randomUUID()}.sh`);
  fs.writeFileSync(filePath, `export ZCODE_API_KEY=${shellQuote(apiKey)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  try { fs.chmodSync(filePath, 0o600); } catch { /* best effort */ }
  return filePath;
}

export function buildZcodeTmuxLaunchCommand(
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
    return `${zcodeCommandEnvironmentPrefix(env)}${commandPreview(executable, args)}`;
  }
  const shell = options.shell || resolveDefaultUserShell({ platform });
  const snapshot = ensureShellSnapshot(definedEnvironment(env), shell);
  return buildShellSnapshotLaunchArgs(executable, args, snapshot, { platform });
}

export function buildZcodeArgs(params: StreamChatParams): string[] {
  const args: string[] = [];
  if (params.zcodeSessionId) args.push('--resume', params.zcodeSessionId);
  if (params.model) args.push('--model', params.model);
  if (params.zcodeMode) args.push('--mode', params.zcodeMode);
  if (params.workingDirectory) args.push('--cwd', params.workingDirectory);
  return args;
}

function normalizeScreen(screen: string): string {
  return screen
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

function isSeparator(line: string): boolean {
  return /^\s*[─━-]{20,}\s*$/u.test(line);
}

export function zcodeEditorText(screen: string): string {
  const lines = normalizeScreen(screen).split('\n');
  const separators = lines
    .map((line, index) => isSeparator(line) ? index : -1)
    .filter((index) => index >= 0);
  if (separators.length < 2) return '';
  const start = separators.at(-2) as number;
  const end = separators.at(-1) as number;
  return lines.slice(start + 1, end).map((line) => line.trim()).filter(Boolean).join('\n');
}

export function isZcodeInputReadyScreen(screen: string): boolean {
  const normalized = normalizeScreen(screen);
  const lines = normalized.split('\n');
  return lines.some((line) => /^\s*◈\s+.+?─\s+◉\s+(?:build|edit|plan|yolo)\b/u.test(line))
    && lines.filter(isSeparator).length >= 2;
}

function assertZcodePaneAlive(screen: string): void {
  const paneDead = detectRuntimeTmuxPaneDead(screen);
  if (!paneDead) return;
  const status = paneDead.status === undefined ? '' : ` (exit ${paneDead.status})`;
  throw new Error(`ZCode exited before becoming ready${status}.`);
}

function sameEditorPrompt(editorText: string, prompt: string): boolean {
  const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
  return normalize(editorText) === normalize(prompt);
}

export interface ZcodeScreenResult {
  content: string;
  failed: boolean;
}

export function extractZcodeScreenResult(screen: string, prompt: string): ZcodeScreenResult | null {
  const lines = normalizeScreen(screen).split('\n');
  const expected = `› ${prompt.trim()}`;
  let promptIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index]?.trim() === expected) {
      promptIndex = index;
      break;
    }
  }
  if (promptIndex < 0) return null;
  const resultIndex = lines.findIndex((line, index) => (
    index > promptIndex && /^\s*\[\s*[✓✗]/u.test(line)
  ));
  if (resultIndex < 0) return null;
  const content = lines.slice(promptIndex + 1, resultIndex)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() && !isSeparator(line))
    .join('\n')
    .trim();
  return {
    content,
    failed: /^\s*\[\s*✗/u.test(lines[resultIndex] || ''),
  };
}

interface ZcodeLaunchArtifacts {
  logDir: string;
}

function safeRuntimePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 160) || 'session';
}

async function launchZcodeTmuxSession(
  sessionName: string,
  params: StreamChatParams,
): Promise<ZcodeLaunchArtifacts> {
  const executable = resolveZcodeCliExecutable();
  const args = buildZcodeArgs(params);
  const launchRoot = path.join(
    CODELARK_HOME,
    'runtime',
    'zcode',
    safeRuntimePathSegment(params.sessionId),
    `${Date.now()}-${crypto.randomUUID()}`,
  );
  const logDir = path.join(launchRoot, 'logs');
  const launchEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ZCODE_LOG_DIR: logDir,
    ZCODE_TUI_RUNTIME_LOG: path.join(launchRoot, 'tui-runtime.log'),
  };
  const secretEnvFile = process.platform === 'win32'
    ? undefined
    : createZcodeSecretEnvironmentFile(launchEnv, launchRoot);
  const baseCommand = buildZcodeTmuxLaunchCommand(executable, args, { env: launchEnv });
  const command = secretEnvFile && typeof baseCommand === 'string'
    ? `. ${shellQuote(secretEnvFile)} && rm -f ${shellQuote(secretEnvFile)} && ${baseCommand}`
    : baseCommand;
  console.log('[zcode-tmux] ZCode TUI start:', {
    bridge_session_id: params.sessionId,
    tmux_session: sessionName,
    command,
    cwd: params.workingDirectory || null,
    resume_session_id: params.zcodeSessionId || null,
    debug_keep_tmux: debugKeepsTmuxAlive(),
  });
  transitionRuntimeTmuxInputState('zcode', sessionName, 'starting_tmux', 'starting ZCode tmux session');
  try {
    await tmuxCore.ensureDetachedSession({
      name: sessionName,
      cwd: params.workingDirectory,
      command,
      recreate: true,
    });
  } finally {
    if (secretEnvFile) {
      try { fs.unlinkSync(secretEnvFile); } catch { /* the launch shell normally removes it first */ }
    }
  }
  return { logDir };
}

export function findZcodeSessionIdInLaunchLogs(logDir: string): string | undefined {
  let files: string[];
  try {
    files = fs.readdirSync(logDir)
      .filter((name) => name.endsWith('.jsonl'))
      .sort();
  } catch {
    return undefined;
  }
  let found: string | undefined;
  for (const name of files) {
    let content: string;
    try { content = fs.readFileSync(path.join(logDir, name), 'utf8'); } catch { continue; }
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as { event?: unknown; sessionId?: unknown };
        if (
          entry.event === 'bootstrap.app.startup.started'
          && typeof entry.sessionId === 'string'
          && /^sess_[A-Za-z0-9._-]+$/.test(entry.sessionId)
        ) {
          found = entry.sessionId;
        }
      } catch {
        // Ignore a partially-written final JSONL line and retry on the next poll.
      }
    }
  }
  return found;
}

async function waitForZcodeSessionIdentity(logDir: string, targetPane: string): Promise<string> {
  const timeoutMs = positiveIntEnv(
    'CODELARK_ZCODE_TMUX_SESSION_TIMEOUT_MS',
    DEFAULT_SESSION_TIMEOUT_MS,
    1_000,
  );
  const pollIntervalMs = positiveIntEnv(
    'CODELARK_ZCODE_TMUX_POLL_INTERVAL_MS',
    DEFAULT_POLL_INTERVAL_MS,
    50,
  );
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    const sessionId = findZcodeSessionIdInLaunchLogs(logDir);
    if (sessionId) return sessionId;
    const capture = await tmuxCore.capturePane(targetPane, 180);
    assertZcodePaneAlive(capture.screen);
    await sleep(pollIntervalMs);
  }
  throw new Error('Timed out waiting for the launched ZCode TUI to report its session identity.');
}

async function waitForZcodeInputReady(
  targetPane: string,
  onProgress?: (elapsedMs: number) => void,
): Promise<void> {
  const timeoutMs = positiveIntEnv(
    'CODELARK_ZCODE_TMUX_INPUT_READY_TIMEOUT_MS',
    DEFAULT_INPUT_READY_TIMEOUT_MS,
    1_000,
  );
  const pollIntervalMs = positiveIntEnv(
    'CODELARK_ZCODE_TMUX_POLL_INTERVAL_MS',
    DEFAULT_POLL_INTERVAL_MS,
    50,
  );
  const startedAt = Date.now();
  let lastProgressAt = startedAt;
  let lastScreen = '';
  while (Date.now() - startedAt <= timeoutMs) {
    const capture = await tmuxCore.capturePane(targetPane, 180);
    lastScreen = capture.screen;
    assertZcodePaneAlive(lastScreen);
    if (isZcodeInputReadyScreen(lastScreen)) return;
    const now = Date.now();
    if (onProgress && now - lastProgressAt >= INPUT_READY_PROGRESS_INTERVAL_MS) {
      lastProgressAt = now;
      onProgress(now - startedAt);
    }
    await sleep(pollIntervalMs);
  }
  const tail = normalizeScreen(lastScreen).split('\n').map((line) => line.trim()).filter(Boolean).slice(-8).join(' · ');
  throw new ZcodeInputReadinessTimeoutError([
    `ZCode 在 ${Math.round(timeoutMs / 1_000)}s 内尚未进入输入界面。`,
    'tmux session 已保留；可以用 `/tmux-screen` 查看当前屏幕。',
    ...(tail ? [`当前屏幕末尾：${tail}`] : []),
  ].join(' '));
}

async function waitForZcodeInputSubmitted(
  targetPane: string,
  prompt: string,
  onProgress?: (elapsedMs: number) => void,
): Promise<void> {
  const timeoutMs = positiveIntEnv(
    'CODELARK_ZCODE_TMUX_INPUT_READY_TIMEOUT_MS',
    DEFAULT_INPUT_READY_TIMEOUT_MS,
    1_000,
  );
  const pollIntervalMs = positiveIntEnv(
    'CODELARK_ZCODE_TMUX_POLL_INTERVAL_MS',
    DEFAULT_POLL_INTERVAL_MS,
    50,
  );
  const startedAt = Date.now();
  let lastProgressAt = startedAt;
  let lastRetryAt = 0;
  await sleep(INPUT_SUBMISSION_CONFIRMATION_GRACE_MS);
  while (Date.now() - startedAt <= timeoutMs) {
    const capture = await tmuxCore.capturePane(targetPane, 180);
    assertZcodePaneAlive(capture.screen);
    if (!sameEditorPrompt(zcodeEditorText(capture.screen), prompt)) return;
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
  throw new ZcodeInputSubmissionTimeoutError([
    `ZCode 在 ${Math.round(timeoutMs / 1_000)}s 内仍未接受输入。`,
    '输入和 tmux session 均已保留；可以用 `/tmux-screen` 检查。',
  ].join(' '));
}

async function waitForZcodeSlashResult(
  targetPane: string,
  prompt: string,
  abortSignal: AbortSignal | undefined,
): Promise<ZcodeScreenResult> {
  const timeoutMs = positiveIntEnv(
    'CODELARK_ZCODE_TMUX_OUTPUT_IDLE_TIMEOUT_MS',
    DEFAULT_OUTPUT_IDLE_TIMEOUT_MS,
    1_000,
  );
  const pollIntervalMs = positiveIntEnv(
    'CODELARK_ZCODE_TMUX_POLL_INTERVAL_MS',
    DEFAULT_POLL_INTERVAL_MS,
    50,
  );
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    if (abortSignal?.aborted) throw new Error('ZCode request was aborted.');
    const capture = await tmuxCore.capturePane(targetPane, 220);
    assertZcodePaneAlive(capture.screen);
    const result = extractZcodeScreenResult(capture.screen, prompt);
    if (result) return result;
    await sleep(pollIntervalMs);
  }
  throw new Error(`ZCode native command produced no terminal screen result for ${timeoutMs}ms.`);
}

export interface ZcodeTmuxInputSession {
  sessionName: string;
  targetPane: string;
  sessionId?: string;
  cwd?: string;
  dbPath: string;
  existed: boolean;
}

export function resolveZcodeTmuxSessionPlan(input: {
  exists: boolean;
  recreate?: boolean;
  requestedSessionId?: string;
  persistedSessionId?: string;
}): {
  launch: boolean;
  reuseSessionId?: string;
  resumeSessionId?: string;
} {
  const requestedSessionId = input.requestedSessionId?.trim() || undefined;
  const persistedSessionId = input.persistedSessionId?.trim() || undefined;
  const reuseSessionId = input.exists && input.recreate !== true
    ? persistedSessionId || requestedSessionId
    : undefined;
  const launch = !input.exists || input.recreate === true || !reuseSessionId;
  return {
    launch,
    ...(reuseSessionId ? { reuseSessionId } : {}),
    ...(launch && persistedSessionId ? { resumeSessionId: persistedSessionId } : {}),
  };
}

export async function ensureZcodeTmuxInputSession(
  params: StreamChatParams,
  options: { recreate?: boolean; onReadinessProgress?: (elapsedMs: number) => void } = {},
): Promise<ZcodeTmuxInputSession> {
  const sessionName = zcodeTmuxSessionName(params.sessionId);
  const targetPane = `${sessionName}:0.0`;
  const dbPath = resolveZcodeSessionDbPath();
  const known = params.zcodeSessionId
    ? findZcodeSessionById(params.zcodeSessionId, params.workingDirectory, { dbPath, includeArchived: true })
    : null;
  const inspection = await inspectRuntimeTmuxInput({
    runtime: 'zcode',
    sessionName,
    hasSession: () => tmuxCore.hasSession(sessionName),
  });
  const plan = resolveZcodeTmuxSessionPlan({
    exists: inspection.exists,
    recreate: options.recreate,
    requestedSessionId: params.zcodeSessionId,
    persistedSessionId: known?.sessionId,
  });
  const { zcodeSessionId: _requestedSessionId, ...freshParams } = params;
  const launchParams = plan.resumeSessionId
    ? { ...freshParams, zcodeSessionId: plan.resumeSessionId }
    : freshParams;
  const launched = plan.launch;
  const launch = launched ? await launchZcodeTmuxSession(sessionName, launchParams) : undefined;
  if (launched || inspection.needsReadiness) {
    await tmuxCore.ensureExtendedKeys?.();
    await waitForZcodeInputReady(targetPane, options.onReadinessProgress);
  }
  transitionRuntimeTmuxInputState(
    'zcode',
    sessionName,
    'running',
    launched ? 'ZCode tmux process is ready for input' : 'existing ZCode tmux process is reusable',
  );
  const sessionId = plan.reuseSessionId
    || known?.sessionId
    || (launch ? await waitForZcodeSessionIdentity(launch.logDir, targetPane) : undefined);
  if (!sessionId) {
    throw new Error('Existing ZCode tmux session has no stable session identity; restart it with `/p tmux`.');
  }
  return {
    sessionName,
    targetPane,
    dbPath,
    sessionId,
    ...(known?.cwd || params.workingDirectory ? { cwd: known?.cwd || params.workingDirectory } : {}),
    existed: inspection.exists,
  };
}

export async function restartZcodeTmuxInputSession(params: StreamChatParams): Promise<ZcodeTmuxInputSession> {
  return ensureZcodeTmuxInputSession(params, { recreate: true });
}

interface ZcodeTurnContext {
  sessionName: string;
  targetPane: string;
  dbPath: string;
  sessionId?: string;
  cwd?: string;
  turnId?: string;
  emittedSignatures: Set<string>;
  emittedToolStarts: Set<string>;
  terminalSeen: boolean;
}

function enqueueZcodeRecord(
  controller: ReadableStreamDefaultController<string>,
  context: ZcodeTurnContext,
  record: BridgeMirrorRecord,
): void {
  if (context.emittedSignatures.has(record.signature)) return;
  context.emittedSignatures.add(record.signature);
  if (record.type === 'message' && record.role === 'assistant' && record.content) {
    controller.enqueue(sseEvent(record.replacementKey ? 'text_snapshot' : 'text', record.content));
    return;
  }
  if (record.type === 'reasoning' && record.content) {
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
  if (record.contextUsage) controller.enqueue(sseEvent('context_usage', record.contextUsage));
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
    controller.enqueue(sseEvent('error', record.content || 'ZCode task aborted.'));
  }
}

async function waitForZcodeTurnIdentity(
  context: ZcodeTurnContext,
  submittedAt: number,
): Promise<void> {
  if (!context.sessionId) throw new Error('ZCode session identity is not resolved before input submission.');
  const timeoutMs = positiveIntEnv(
    'CODELARK_ZCODE_TMUX_SESSION_TIMEOUT_MS',
    DEFAULT_SESSION_TIMEOUT_MS,
    1_000,
  );
  const pollIntervalMs = positiveIntEnv(
    'CODELARK_ZCODE_TMUX_POLL_INTERVAL_MS',
    DEFAULT_POLL_INTERVAL_MS,
    50,
  );
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    const session = findZcodeSessionById(context.sessionId, context.cwd, {
      dbPath: context.dbPath,
      includeArchived: true,
    });
    const turnId = findLatestZcodeTurnId(context.dbPath, context.sessionId, submittedAt - 2_000);
    if (turnId) {
      context.cwd = session?.cwd || context.cwd;
      context.turnId = turnId;
      return;
    }
    const capture = await tmuxCore.capturePane(context.targetPane, 180);
    assertZcodePaneAlive(capture.screen);
    await sleep(pollIntervalMs);
  }
  throw new Error('Timed out waiting for ZCode to persist the submitted turn.');
}

async function pollZcodeTurn(
  controller: ReadableStreamDefaultController<string>,
  context: ZcodeTurnContext,
  abortSignal: AbortSignal | undefined,
): Promise<void> {
  if (!context.sessionId || !context.turnId) throw new Error('ZCode turn identity is not resolved.');
  const pollIntervalMs = positiveIntEnv(
    'CODELARK_ZCODE_TMUX_POLL_INTERVAL_MS',
    DEFAULT_POLL_INTERVAL_MS,
    50,
  );
  const idleTimeoutMs = positiveIntEnv(
    'CODELARK_ZCODE_TMUX_OUTPUT_IDLE_TIMEOUT_MS',
    DEFAULT_OUTPUT_IDLE_TIMEOUT_MS,
    1_000,
  );
  let lastActivityAt = Date.now();
  while (!context.terminalSeen) {
    if (abortSignal?.aborted) throw new Error('ZCode request was aborted.');
    const before = context.emittedSignatures.size;
    const records = readZcodeSessionMirrorRecords(context.dbPath, context.sessionId, {
      turnId: context.turnId,
    });
    for (const record of records) enqueueZcodeRecord(controller, context, record);
    if (context.emittedSignatures.size > before) lastActivityAt = Date.now();
    if (context.terminalSeen) break;
    const existence = await tmuxCore.hasSession(context.sessionName);
    if (!existence.exists) throw new Error('ZCode exited before persisting a terminal turn state.');
    if (Date.now() - lastActivityAt > idleTimeoutMs) {
      const capture = await tmuxCore.capturePane(context.targetPane, 180);
      assertZcodePaneAlive(capture.screen);
      throw new Error(`ZCode produced no persisted turn activity for ${idleTimeoutMs}ms.`);
    }
    await sleep(pollIntervalMs);
  }
}

export function streamZcodeTmuxTui(params: StreamChatParams): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      void (async () => {
        const sessionName = zcodeTmuxSessionName(params.sessionId);
        const targetPane = `${sessionName}:0.0`;
        let failed = false;
        let preserveTmuxAfterFailure = false;
        const context: ZcodeTurnContext = {
          sessionName,
          targetPane,
          dbPath: resolveZcodeSessionDbPath(),
          sessionId: params.zcodeSessionId,
          cwd: params.workingDirectory,
          emittedSignatures: new Set(),
          emittedToolStarts: new Set(),
          terminalSeen: false,
        };
        try {
          controller.enqueue(sseEvent('status', {
            reasoning: params.zcodeSessionId
              ? '正在确认 ZCode tmux 和当前 session。'
              : '正在初始化 ZCode tmux 和 session。',
          }));
          const prepared = await ensureZcodeTmuxInputSession(params, {
            onReadinessProgress: (elapsedMs) => controller.enqueue(sseEvent('status', {
              reasoning: `ZCode 正在启动，已等待 ${Math.floor(elapsedMs / 1_000)}s。`,
            })),
          });
          context.sessionId = prepared.sessionId;
          context.cwd = prepared.cwd;
          context.dbPath = prepared.dbPath;
          const submittedAt = Date.now();
          await sendRuntimeTmuxInput({
            runtime: 'zcode',
            sessionName,
            send: async () => {
              const result = await tmuxCore.injectPromptIntoPane(targetPane, params.prompt);
              await waitForZcodeInputSubmitted(targetPane, params.prompt, (elapsedMs) => {
                controller.enqueue(sseEvent('status', {
                  reasoning: `输入已写入 ZCode，正在确认提交，已等待 ${Math.floor(elapsedMs / 1_000)}s。`,
                }));
              });
              return result;
            },
          });
          setRuntimeTmuxTurnState('zcode', sessionName, 'active', 'ZCode accepted the submitted input');
          controller.enqueue(sseEvent('status', { reasoning: 'ZCode 已接收消息，正在运行。' }));

          if (params.prompt.trimStart().startsWith('/')) {
            const result = await waitForZcodeSlashResult(targetPane, params.prompt, params.abortController?.signal);
            if (result.content) controller.enqueue(sseEvent('text', result.content));
            if (result.failed) throw new Error(result.content || 'ZCode native command failed.');
            controller.enqueue(sseEvent('result', {
              ...(context.sessionId ? { session_id: context.sessionId } : {}),
              ...(context.cwd ? { cwd: context.cwd } : {}),
            }));
          } else {
            await waitForZcodeTurnIdentity(context, submittedAt);
            controller.enqueue(sseEvent('status', {
              session_id: context.sessionId,
              ...(context.cwd ? { cwd: context.cwd } : {}),
            }));
            await pollZcodeTurn(controller, context, params.abortController?.signal);
          }
          setRuntimeTmuxTurnState('zcode', sessionName, 'idle', 'ZCode turn reached a terminal state');
          controller.close();
        } catch (error) {
          failed = true;
          preserveTmuxAfterFailure = shouldPreserveZcodeTmuxAfterFailure(
            error,
            params.abortController?.signal,
          );
          const message = error instanceof Error ? error.message : String(error);
          setRuntimeTmuxTurnState('zcode', sessionName, 'idle', 'ZCode turn failed or was interrupted');
          transitionRuntimeTmuxInputState('zcode', sessionName, 'failed', 'ZCode tmux lifecycle failed', { error: message });
          console.error('[zcode-tmux] Error:', error instanceof Error ? error.stack || error.message : error);
          try {
            controller.enqueue(sseEvent('error', message || 'ZCode TUI execution failed.'));
            controller.close();
          } catch {
            // The stream may already be closed by its consumer.
          }
        } finally {
          if (failed && !preserveTmuxAfterFailure && !debugKeepsTmuxAlive()) {
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

export class ZcodeTmuxProvider implements LLMProvider {
  streamChat(params: StreamChatParams): ReadableStream<string> {
    return streamZcodeTmuxTui(params);
  }
}
