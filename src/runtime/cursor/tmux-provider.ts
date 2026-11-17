import { isCursorQuestionScreen, assertCursorPromptAvailable } from './questions.js';
import { readCursorNativeUserPrompts } from './cli-store.js';
import { CURSOR_AUTH_FAILURE, CursorLoginError, cursorLoginManager } from './login.js';
import { prepareTextAttachmentPrompt } from '../local-attachments.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { BridgeMirrorRecord, LLMProvider, StreamChatParams } from '../contracts.js';
import { BRIDGE_SHUTDOWN_REASON, RUNTIME_TURN_FINALIZED_REASON } from '../contracts.js';
import { sseEvent } from '../sse.js';
import { tmuxCore } from '../tmux/core.js';
import {
  assertRuntimeTmuxInputOwner,
  mutateRuntimeTmuxSession,
  withRuntimeTmuxInputOwner,
  inspectRuntimeTmuxInput,
  sendRuntimeTmuxInput,
  transitionRuntimeTmuxInputState,
} from '../tmux/input-state-machine.js';
import { detectRuntimeTmuxPaneDead } from '../tmux/pane-state.js';
import {
  buildShellSnapshotLaunchArgs,
  ensureShellSnapshot,
  resolveDefaultUserShell,
  type CodexUserShell,
} from '../codex/shell-snapshot.js';
import {
  findCursorSessionFileById,
  getCursorTranscriptCandidates,
  listCursorSessionFileSummaries,
  readCursorSessionMirrorRecordDeltaByFilePath,
  type CursorSessionFileSummary,
} from './session-index.js';

const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_INPUT_READY_TIMEOUT_MS = 180_000;
const INPUT_READY_PROGRESS_INTERVAL_MS = 10_000;
const INPUT_SUBMISSION_CONFIRMATION_GRACE_MS = 300;

class CursorInputReadinessTimeoutError extends Error {}
class CursorAuthenticationError extends Error {}
class CursorModelUnavailableError extends Error {}
class CursorPaneExitedError extends Error {}

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
  if (
    /(?:^|\n)\s*Error:\s*Authentication error\s*(?:\n|$)/i.test(normalized)
    || /Authentication failed:\s*(?:your )?Cursor credentials or API key are invalid or expired/i.test(normalized)
  ) {
    return 'Cursor Agent authentication failed because its credentials are invalid or expired. Run `agent login`, then resend this message.';
  }
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
  if (cursorAuthenticationScreenError(normalized) || isCursorQuestionScreen(normalized)) return false;
  // Cursor renders the prompt shell before a persisted conversation has
  // finished restoring. Input sent during that window stays as a multiline
  // draft, and Enter edits the draft instead of starting a turn.
  if (/\bLoading conversation\b/i.test(normalized)) return false;
  const hasPrompt = /(?:^|\n)\s*[>›❯→]\s*/u.test(normalized);
  const hasMode = /(?:^|\s)(?:Agent|Ask|Plan)(?:\s|$)/u.test(normalized);
  const hasContext = /(?:^|\s)Context(?:\s|$)/u.test(normalized);
  return hasPrompt || (hasMode && hasContext);
}

export function isCursorInputDraftScreen(screen: string): boolean {
  const normalized = normalizeScreen(screen);
  if (/ctrl\+c\s+to\s+stop/i.test(normalized)) return false;
  const promptLines = normalized.split('\n').filter((line) => /^\s*[>›❯→]\s*/u.test(line));
  const promptText = promptLines.at(-1)
    ?.replace(/^\s*[>›❯→]\s*/u, '')
    .replace(/\s{2,}ctrl\+c\s+to\s+stop\s*$/i, '')
    .trim() || '';
  if (!promptText) {
    const lines = normalized.split('\n');
    const arrowIndex = lines.findLastIndex(line => /^\s*[>›❯→]\s*$/u.test(line));
    const arrowLine = lines[arrowIndex];
    const nextLine = lines[arrowIndex + 1];
    // Multiline drafts can put the arrow on its own line. Cursor indents the
    // editor body beneath it; the model/footer sits outside that indentation.
    if (arrowLine && nextLine?.trim()
      && nextLine.search(/\S/u) > arrowLine.search(/\S/u)) return true;
    // Cursor 2026.11 can render a pasted multiline prompt without the old
    // leading arrow: the collapsed editor shows only its first source tag
    // immediately above the model footer. Treat that tail-local marker as a
    // draft so submission confirmation retries Enter instead of falsely
    // waiting forever for a turn that never started.
    return normalized.split('\n').slice(-12).some((line) =>
      /^\s*<(?:codelark_source|user_query|local_attachment)(?:\s|>)/u.test(line)
      || /<\/(?:codelark_source|user_query)>/u.test(line)
      || /(?:来源群聊|来源\s*Bot|来源会话\s*ID|当前会话\s*ID)\s*[：:]/u.test(line),
    );
  }
  return !/^(?:Plan, search, build anything|Add a follow-up|Ask anything)[.!]?$/i.test(promptText);
}

function assertCursorPaneAlive(screen: string, exited = false): void {
  const authenticationError = cursorAuthenticationScreenError(screen);
  if (authenticationError) throw new CursorAuthenticationError(authenticationError);
  const paneDead = detectRuntimeTmuxPaneDead(screen);
  if (!paneDead && !exited) return;
  const modelError = normalizeScreen(screen).split('\n').find(line => /^Cannot use this model:/i.test(line.trim()));
  if (modelError) throw new CursorModelUnavailableError(`${modelError.trim()} 请检查 Cursor 登录及可用模型；本条消息尚未发送。`);
  const status = paneDead?.status === undefined ? '' : ` (exit ${paneDead.status})`;
  throw new CursorPaneExitedError(`Cursor Agent exited${status}.`);
}

export function withCursorReasoningEffort(model: string, effort?: string): string {
  const normalizedEffort = effort?.trim();
  if (!normalizedEffort) return model;
  const parameterized = /^(.*)\[([^\]]*)\]$/.exec(model.trim());
  if (!parameterized) return `${model}[effort=${normalizedEffort}]`;
  const parameters = parameterized[2]
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry) => entry.split('=', 1)[0]?.trim().toLowerCase() !== 'effort');
  parameters.push(`effort=${normalizedEffort}`);
  return `${parameterized[1]}[${parameters.join(',')}]`;
}

export function buildCursorArgs(params: StreamChatParams): string[] {
  const args: string[] = [];
  if (params.cursorSessionId) args.push('--resume', params.cursorSessionId);
  if (params.model) args.push('--model', withCursorReasoningEffort(params.model, params.cursorReasoningEffort));
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
  await mutateRuntimeTmuxSession('cursor', sessionName, () => tmuxCore.ensureDetachedSession({
    name: sessionName,
    cwd: params.workingDirectory,
    command,
    recreate: true,
    remainOnExit: true,
  }));
}

async function waitForCursorInputReady(
  sessionName: string,
  targetPane: string,
  onProgress?: (elapsedMs: number) => void,
  signal?: AbortSignal,
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
    signal?.throwIfAborted();
    const capture = await tmuxCore.capturePane(targetPane, 160);
    lastScreen = capture.screen;
    assertCursorPaneAlive(lastScreen, await tmuxCore.readPaneDead?.(targetPane));
    assertCursorPromptAvailable(lastScreen);
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

interface CursorInputConfirmation {
  prompt: string;
  storePath?: string;
  nativeCount?: number;
  screenCount: number;
  running: boolean;
}

const compactInput = (text: string) => normalizeScreen(text).replace(/[│\s]/gu, '');
function screenPromptCount(screen: string, prompt: string): number {
  // A follow-up shown in the queue has not reached the model yet.
  const history = screen.split(/┌─ follow-ups\b/u)[0]!;
  return compactInput(history).split(compactInput(prompt)).length - 1;
}
function nativePromptCount(storePath: string | undefined, prompt: string): number | undefined {
  const prompts = storePath ? readCursorNativeUserPrompts(storePath) : null;
  return prompts?.filter(text => {
    // Native user messages carry timestamp/context wrappers; compare the query,
    // not the surrounding orchestration text, with the submitted input.
    const query = /<user_query>\s*([\s\S]*)<\/user_query>\s*$/u.exec(text)?.[1] || text;
    return normalizeScreen(text).trim() === normalizeScreen(prompt).trim()
      || normalizeScreen(query).trim() === normalizeScreen(prompt).trim();
  }).length;
}

export async function prepareCursorInputConfirmation(targetPane: string, prompt: string, storePath?: string): Promise<CursorInputConfirmation> {
  let { screen } = await tmuxCore.capturePane(targetPane, 160);
  assertCursorPromptAvailable(screen);
  const running = /ctrl\+c\s+to\s+stop/i.test(screen);
  const queued = /^\s*┌─ follow-ups\b/im.test(screen);
  const draft = isCursorInputDraftScreen(screen.replace(/ctrl\+c\s+to\s+stop/ig, ''));
  if (draft && (running || queued)) {
    throw new CursorInputReadinessTimeoutError('Cursor 正在运行且输入框另有草稿，本条消息尚未发送；已保留草稿和会话，请用 `/tmux-screen` 查看。');
  }
  // An IM message replaces the managed editor's idle draft. Pasting into a
  // retained draft concatenates previously submitted instructions with it.
  // Cursor can retain editor text while its parent input state is already
  // empty; Ctrl+C alone then does nothing. An editing key synchronizes that
  // state first. Backspace/Delete cover both ends of the cursor without ever
  // submitting input. Never use Ctrl+C while running or follow-ups are queued.
  if (draft) {
    assertCursorPaneAlive(screen);
    await tmuxCore.sendActions(targetPane, [{ type: 'key', key: 'BSpace' }, { type: 'key', key: 'Delete' }], { delayMs: 100 });
    await sleep(100);
    ({ screen } = await tmuxCore.capturePane(targetPane, 160));
    assertCursorPaneAlive(screen);
    assertCursorPromptAvailable(screen);
    if (/ctrl\+c\s+to\s+stop|^\s*┌─ follow-ups\b/im.test(screen)) {
      throw new CursorInputReadinessTimeoutError('Cursor 已开始运行，本条消息尚未发送；已保留会话。');
    }
    if (isCursorInputDraftScreen(screen)) {
      await tmuxCore.sendActions(targetPane, [{ type: 'key', key: 'C-c' }]);
    }
    for (let attempt = 0; attempt < 20; attempt++) {
      await sleep(100);
      ({ screen } = await tmuxCore.capturePane(targetPane, 160));
      assertCursorPaneAlive(screen);
      assertCursorPromptAvailable(screen);
      if (isCursorInputReadyScreen(screen) && !isCursorInputDraftScreen(screen)) break;
    }
    if (!isCursorInputReadyScreen(screen) || isCursorInputDraftScreen(screen)) {
      throw new CursorInputReadinessTimeoutError('Cursor 输入框仍有旧草稿，本条消息尚未发送；已保留会话，请用 `/tmux-screen` 查看。');
    }
  }
  return { prompt, storePath, nativeCount: nativePromptCount(storePath, prompt), screenCount: screenPromptCount(screen, prompt), running: /ctrl\+c\s+to\s+stop/i.test(screen) };
}

/** tmux accepting bytes does not mean Cursor has consumed the paste. */
export async function pasteCursorPromptAndSubmit(targetPane: string, prompt: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await tmuxCore.injectPromptIntoPane(targetPane, prompt, { bracketedPaste: true, beforeSubmit: async () => {
    const expected = compactInput(prompt);
    for (let attempt = 0; attempt < 100; attempt++) {
      signal?.throwIfAborted();
      const { screen } = await tmuxCore.capturePane(targetPane, 160);
      assertCursorPaneAlive(screen);
      assertCursorPromptAvailable(screen);
      const lines = normalizeScreen(screen).split('\n');
      const arrow = lines.findLastIndex(line => /^\s*[>›❯→]\s*/u.test(line));
      const editorLines = lines.slice(arrow >= 0 ? arrow : -12);
      const indent = lines[arrow]?.search(/\S/u) ?? 0;
      const end = editorLines.findIndex((line, i) => i > 0 && line.trim() && line.search(/\S/u) <= indent);
      const editor = editorLines.slice(0, end < 0 ? undefined : end).join('\n').replace(/^\s*[>›❯→]\s*/u, '');
      // Long pastes are replaced by Cursor's native pasted-text token. Short
      // input must be visible in the editor itself, never just in scrollback.
      const observed = compactInput(editor);
      const visible = observed === expected
        || (observed.length >= Math.min(32, expected.length) && expected.includes(observed))
        || (prompt.length > 800 && /\[Pasted text #\d+(?: \+\d+ lines)?\]/u.test(editor));
      if (visible) {
        signal?.throwIfAborted();
        return;
      }
      await sleep(100);
    }
    throw new CursorInputReadinessTimeoutError('Cursor 尚未显示本条输入，未发送提交键；已保留会话和草稿。');
  } });
}

export async function waitForCursorInputSubmitted(
  targetPane: string,
  onProgress?: (elapsedMs: number) => void,
  confirmation?: CursorInputConfirmation,
  signal?: AbortSignal,
): Promise<void> {
  const pollIntervalMs = positiveIntEnv(
    'CODELARK_CURSOR_TMUX_POLL_INTERVAL_MS',
    DEFAULT_POLL_INTERVAL_MS,
    50,
  );
  const startedAt = Date.now();
  let lastProgressAt = startedAt;
  let steerSent = false;
  await sleep(INPUT_SUBMISSION_CONFIRMATION_GRACE_MS);
  // Receipt is checkpoint-backed, not a deadline: a live Cursor may accept
  // input long before persisting its first checkpoint. Keep the same turn
  // pending until acceptance, explicit cancellation or a real pane failure.
  while (true) {
    signal?.throwIfAborted();
    const capture = await tmuxCore.capturePane(targetPane, 160);
    signal?.throwIfAborted();
    assertCursorPaneAlive(capture.screen);
    if (await tmuxCore.readPaneDead?.(targetPane)) throw new Error('Cursor Agent exited before confirming input.');
    signal?.throwIfAborted();
    const accepted = confirmation && (confirmation.nativeCount !== undefined
      ? (nativePromptCount(confirmation.storePath, confirmation.prompt) || 0) > confirmation.nativeCount
      : screenPromptCount(capture.screen, confirmation.prompt) > confirmation.screenCount);
    // Another input can checkpoint while this follow-up still waits in the
    // queue. Only this prompt's new receipt confirms it; a global count change
    // proves neither a mismatch nor acceptance and never authorizes a retry.
    const screen = normalizeScreen(capture.screen);
    const queued = /^\s*┌─ follow-ups\b/im.test(screen);
    // Cursor can retain the submitted text below a queue while repainting.
    // A queued input is never an unsubmitted draft.
    const inputDraft = !queued && isCursorInputDraftScreen(screen);
    if (accepted && (confirmation?.nativeCount !== undefined || !inputDraft)) return;
    if (isCursorQuestionScreen(capture.screen)) {
      if (confirmation?.running) throw new Error('Cursor 正在等待问卷回答，尚未确认这条补充消息已进入当前轮。');
      return;
    }
    if (!inputDraft) {
      // Recent Cursor CLI queues the text on the first Enter. Only the explicit
      // native footer authorizes a second Enter to promote it into this turn.
      // Repeating Enter after promotion can interrupt a pending steer.
      if (queued && !steerSent && /^\s*│\s*(?:\+\d+ more lines?\s*·\s*)?enter\s+steer(?:\s+·|\s+│)/im.test(screen)) {
        await tmuxCore.sendActions(targetPane, [{ type: 'key', key: 'Enter' }]);
        steerSent = true;
      } else if (!confirmation?.running && (!steerSent || !queued)) {
        if (!confirmation) return;
        const inputReady = isCursorInputReadyScreen(capture.screen);
        // A resumed chat already has a native message baseline. Its previous
        // empty editor can survive the paste/Enter redraw, so readiness alone
        // cannot acknowledge this input. Wait for the new native user record.
        if (confirmation.nativeCount === undefined && inputReady) return;
      } else if (queued && /enter\s+interrupt and send/i.test(screen)) {
        // Cursor has queued the follow-up but is not at a safe in-turn steer
        // boundary yet. Leave it queued and keep polling; pressing Enter here
        // would abort the active turn instead of injecting context into it.
      }
    }
    // The submission key was sent only after the editor acknowledged this
    // paste. A retained draft or missing footer cannot prove it was lost;
    // retries can submit the same prompt again when checkpoints are delayed.
    const now = Date.now();
    if (onProgress && now - lastProgressAt >= INPUT_READY_PROGRESS_INTERVAL_MS) {
      lastProgressAt = now;
      onProgress(now - startedAt);
    }
    await sleep(pollIntervalMs);
  }
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
    onAuthentication?: (message: string) => void;
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
  const paneDead = inspection.exists && await tmuxCore.readPaneDead?.(targetPane);
  const launched = !inspection.exists || paneDead || options.recreate === true;
  if (launched) await launchCursorTmuxSession(sessionName, params);
  if (launched || inspection.needsReadiness) {
    await tmuxCore.ensureExtendedKeys?.();
    try {
      await waitForCursorInputReady(sessionName, targetPane, options.onReadinessProgress, params.abortController?.signal);
    } catch (error) {
      let authenticationFailed = error instanceof CursorAuthenticationError;
      if (error instanceof CursorModelUnavailableError) {
        // Cursor can hide an expired login behind an empty model list. Probe
        // only this failure; ordinary starts must not pay another network call.
        try { await (await import('./models.js')).listCursorAvailableModels(); }
        catch (probeError) { authenticationFailed = CURSOR_AUTH_FAILURE.test(String(probeError)); }
      }
      if (!authenticationFailed || !options.onAuthentication) throw error;
      const notify = options.onAuthentication;
      notify('Cursor 登录已失效，正在发起官方登录。本条消息尚未发送，授权后会恢复原会话并提交一次。');
      await cursorLoginManager.wait(resolveCursorCliExecutable(), url => {
        notify(`Cursor 登录已失效：[点击登录 Cursor](${url})。完成网页授权后会自动继续；停止按钮可取消等待。`);
      }, params.abortController?.signal);
      params.abortController?.signal.throwIfAborted();
      notify('Cursor 登录完成，正在恢复原会话。');
      await launchCursorTmuxSession(sessionName, params);
      // One recovery only. A still-invalid model/login is a real failure.
      await waitForCursorInputReady(sessionName, targetPane, options.onReadinessProgress, params.abortController?.signal);
    }
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

export async function restartCursorTmuxInputSession(params: StreamChatParams, options: Parameters<typeof ensureCursorTmuxInputSession>[1] = {}): Promise<CursorTmuxInputSession> {
  return withRuntimeTmuxInputOwner('cursor', cursorTmuxSessionName(params.sessionId),
    () => ensureCursorTmuxInputSession(params, { ...options, recreate: true }), { restart: true });
}

export interface CursorTurnContext {
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
  /** Turns present before input submission cannot belong to this direct stream. */
  baselineTurnIds?: Set<string>;
  /** Desktop hooks expose Cursor's real tool ID before transcript rows assign a synthetic one. */
  liveHookToolIdsByFingerprint?: Map<string, string[]>;
  transcriptToolIdsByFingerprint?: Map<string, string[]>;
  transcriptToolIdAliases?: Map<string, string>;
  liveHookToolIdAliases?: Map<string, string>;
  terminalSeen: boolean;
}

export function cursorToolFingerprint(name: string, input: unknown): string {
  if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
    const record = input as Record<string, unknown>;
    for (const key of ['command', 'path', 'file_path', 'query', 'url']) {
      const value = record[key];
      if (typeof value === 'string' && value.length > 0) {
        return JSON.stringify([name, key, value]);
      }
    }
  }
  try {
    return JSON.stringify([name, input ?? {}]);
  } catch {
    return JSON.stringify([name, String(input)]);
  }
}

export function enqueueCursorRecord(
  controller: ReadableStreamDefaultController<string>,
  context: CursorTurnContext,
  record: BridgeMirrorRecord,
): void {
  if (record.turnId && context.baselineTurnIds?.has(record.turnId)) return;
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
    const fingerprint = cursorToolFingerprint(record.toolName || 'tool', record.toolInput || {});
    const hookIds = context.liveHookToolIdsByFingerprint?.get(fingerprint);
    const hookId = hookIds?.shift();
    if (hookIds && hookIds.length === 0) context.liveHookToolIdsByFingerprint?.delete(fingerprint);
    if (hookId) {
      context.transcriptToolIdAliases?.set(id, hookId);
      context.emittedToolStarts.add(id);
      return;
    }
    if (context.emittedToolStarts.has(id)) return;
    context.emittedToolStarts.add(id);
    const transcriptIds = context.transcriptToolIdsByFingerprint?.get(fingerprint) || [];
    transcriptIds.push(id);
    context.transcriptToolIdsByFingerprint?.set(fingerprint, transcriptIds);
    controller.enqueue(sseEvent('tool_use', {
      id,
      name: record.toolName || 'tool',
      input: record.toolInput || {},
    }));
    return;
  }
  if (record.type === 'tool_finished') {
    const transcriptId = record.toolId || record.signature;
    const id = context.transcriptToolIdAliases?.get(transcriptId) || transcriptId;
    if (!context.emittedToolStarts.has(id)) {
      context.emittedToolStarts.add(id);
      controller.enqueue(sseEvent('tool_use', { id, name: record.toolName || 'tool', input: {} }));
    }
    controller.enqueue(sseEvent('tool_result', {
      tool_use_id: id,
      content: record.showToolOutput ? record.content : record.content || 'Done',
      is_error: record.isError === true,
      ...(record.showToolOutput ? { show_output: true } : {}),
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
  abortSignal: AbortSignal | undefined,
): Promise<void> {
  const pollIntervalMs = positiveIntEnv(
    'CODELARK_CURSOR_TMUX_POLL_INTERVAL_MS',
    DEFAULT_POLL_INTERVAL_MS,
    50,
  );
  while (true) {
    assertRuntimeTmuxInputOwner('cursor', context.sessionName);
    if (abortSignal?.aborted) throw new Error('Cursor Agent request was aborted.');
    if (context.sessionId && context.cwd) {
      const filePath = getCursorTranscriptCandidates(context.sessionId, context.cwd)
        .find((candidate) => fs.existsSync(candidate));
      if (filePath) {
        context.sessionFilePath = filePath;
        return;
      }
    }
    const summary = context.sessionId
      ? context.cwd ? null : findCursorSessionFileById(context.sessionId)
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
    assertCursorPaneAlive(capture.screen, await tmuxCore.readPaneDead?.(targetPane));
    await sleep(pollIntervalMs);
  }
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
  while (!context.terminalSeen) {
    assertRuntimeTmuxInputOwner('cursor', context.sessionName);
    if (abortSignal?.aborted) throw new Error('Cursor Agent request was aborted.');
    if (!context.sessionFilePath) throw new Error('Cursor transcript path was not resolved.');
    let endOffset = context.nextOffset;
    try {
      endOffset = fs.statSync(context.sessionFilePath).size;
    } catch {
      // Preserve the cursor and retry transient replacement races.
    }
    // Like the mirror, recover semantic identities from the whole snapshot.
    // Cursor removes the previous EOF terminal when resuming; the old byte
    // offset can land inside the next user row even when the file grows.
    const delta = readCursorSessionMirrorRecordDeltaByFilePath(
      context.sessionFilePath,
      0,
      endOffset,
      '',
      null,
      [],
      context.sessionStorePath,
    );
    context.nextOffset = delta.nextOffset;
    context.trailingText = delta.trailingText;
    context.nextTurnId = delta.nextTurnId;
    context.nextSpecialCallIds = delta.nextSpecialCallIds;
    for (const record of delta.records) enqueueCursorRecord(controller, context, record);
    if (context.terminalSeen) break;
    const existence = await tmuxCore.hasSession(context.sessionName);
    if (!existence.exists) throw new Error('Cursor Agent exited before writing a terminal turn event.');
    // Like the other TUI providers, wait for the native terminal event while
    // the process is alive. Cursor may defer JSONL writes until a checkpoint.
    const capture = await tmuxCore.capturePane(targetPane, 160);
    assertCursorPaneAlive(capture.screen, await tmuxCore.readPaneDead?.(targetPane));
    await sleep(pollIntervalMs);
  }
}

export function streamCursorTmuxTui(params: StreamChatParams): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      const sessionName = cursorTmuxSessionName(params.sessionId);
      void withRuntimeTmuxInputOwner('cursor', sessionName, async () => {
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
        let preparedForInput = false;
        let preserveTmuxAfterFailure = false;
        try {
          controller.enqueue(sseEvent('status', {
            reasoning: params.cursorSessionId
              ? '正在确认 Cursor tmux 和当前 Cursor chat。'
              : '正在初始化 Cursor tmux 和 Cursor chat；首次打开工作区时可能需要先建立索引。',
          }));
          const prepared = await ensureCursorTmuxInputSession(params, {
            onAuthentication: content => controller.enqueue(sseEvent('history_item', { type: 'markdown', role: 'system', content })),
            onReadinessProgress: (elapsedMs) => {
              controller.enqueue(sseEvent('status', {
                reasoning: `Cursor Agent 正在准备工作区；首次打开时通常会建立索引，已等待 ${Math.floor(elapsedMs / 1_000)}s。`,
              }));
            },
          });
          preparedForInput = true;
          context.sessionId = prepared.sessionId;
          context.cwd = prepared.cwd;
          context.sessionFilePath = prepared.sessionFilePath;
          context.sessionStorePath = prepared.sessionStorePath;
          context.nextOffset = prepared.nextOffset;
          if (context.sessionFilePath) {
            const baseline = readCursorSessionMirrorRecordDeltaByFilePath(
              context.sessionFilePath, 0, context.nextOffset, '', null, [], context.sessionStorePath,
            );
            context.baselineTurnIds = new Set(baseline.records.flatMap((record) => record.turnId ? [record.turnId] : []));
            for (const record of baseline.records) context.emittedSignatures.add(record.signature);
          }
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
              const prompt = prepareTextAttachmentPrompt(params);
              const confirmation = await prepareCursorInputConfirmation(targetPane, prompt, context.sessionStorePath);
              await pasteCursorPromptAndSubmit(targetPane, prompt, params.abortController?.signal);
              await waitForCursorInputSubmitted(targetPane, (elapsedMs) => {
                controller.enqueue(sseEvent('status', {
                  reasoning: `输入已发送，正在等待 Cursor 确认接收；已等待 ${Math.floor(elapsedMs / 1_000)}s，可使用停止按钮取消。`,
                }));
              }, confirmation, params.abortController?.signal);
            },
          });
          params.onInputAccepted?.();
          controller.enqueue(sseEvent('status', {
            reasoning: 'Cursor Agent 已接收消息，正在运行。',
          }));
          if (!context.sessionFilePath) {
            await waitForCursorTranscript(context, baselineSessionIds, targetPane, params.abortController?.signal);
            context.nextOffset = 0;
            controller.enqueue(sseEvent('status', {
              session_id: context.sessionId,
              ...(context.cwd ? { cwd: context.cwd } : {}),
            }));
          }
          await pollCursorTranscript(controller, context, targetPane, params.abortController?.signal);
          controller.close();
        } catch (error) {
          if (params.abortController?.signal.reason === RUNTIME_TURN_FINALIZED_REASON) {
            // The native turn already ended. Its observer owns final delivery;
            // cancellation here releases this reader, not the persistent TUI.
            try { controller.close(); } catch { /* Already closed by the consumer. */ }
            return;
          }
          failed = true;
          preserveTmuxAfterFailure = (!preparedForInput && (
            error instanceof CursorAuthenticationError || error instanceof CursorModelUnavailableError
            || error instanceof CursorPaneExitedError || error instanceof CursorLoginError
          )) || error instanceof CursorInputReadinessTimeoutError
            || params.abortController?.signal.reason === BRIDGE_SHUTDOWN_REASON;
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
              await mutateRuntimeTmuxSession('cursor', sessionName,
                () => tmuxCore.killSession(sessionName, { ignoreMissing: true }));
            } catch {
              // Best-effort cleanup; the next lifecycle probes tmux again.
            }
          }
        }
      });
    },
  });
}

export class CursorCliTransport implements LLMProvider {
  streamChat(params: StreamChatParams): ReadableStream<string> {
    return streamCursorTmuxTui(params);
  }
}
