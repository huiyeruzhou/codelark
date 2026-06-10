import {
  buildCodexTuiArgs,
  buildCodexTuiEnv,
  buildCodexTuiShellCommand,
  parsePositiveIntEnv,
} from '../../runtime/codex/tmux-provider.js';
import { resolveCodexCliExecutable } from '../../runtime/codex/cli-executable.js';
import type { StreamChatParams } from '../../runtime/contracts.js';
import {
  tmuxCore,
  type TmuxCore,
  type TmuxSendAction,
} from './core.js';

export {
  tmuxCore,
  type TmuxCore,
  type TmuxSendAction,
  type TmuxSessionInfo,
} from './core.js';

export interface StartCodexResumeTmuxSessionParams {
  sessionName: string;
  threadId?: string;
  bridgeSessionId: string;
  workingDirectory?: string;
  model?: string;
  sandboxMode?: StreamChatParams['sandboxMode'];
  networkAccessEnabled?: boolean;
  modelReasoningEffort?: StreamChatParams['modelReasoningEffort'];
  skipGitRepoCheck?: boolean;
  codexMode?: StreamChatParams['codexMode'];
  permissionMode?: string;
}

export interface StartCodexResumeTmuxSessionResult {
  existed: boolean;
  sessionName: string;
  codexCommand: string;
  tmuxCommand: string;
  commands: string[];
  ready: boolean;
}

export interface CodexResumeTmuxReadinessResult {
  ready: boolean;
  commands: string[];
  lastScreen?: string;
  lastError?: string;
  sessionExists?: boolean;
  sessionExistsCommand?: string;
}

export interface CodexResumeTmuxLaunchFailureDetails {
  sessionName: string;
  threadId?: string;
  bridgeSessionId: string;
  workingDirectory?: string;
  reason: string;
  commands: string[];
  lastScreen?: string;
  lastError?: string;
  sessionExists?: boolean;
  sessionExistsCommand?: string;
  killCommand?: string;
}

export class CodexResumeTmuxLaunchError extends Error {
  readonly details: CodexResumeTmuxLaunchFailureDetails;

  constructor(details: CodexResumeTmuxLaunchFailureDetails) {
    super(`Codex tmux session ${details.sessionName} did not become ready after launch: ${details.reason}`);
    this.name = 'CodexResumeTmuxLaunchError';
    this.details = details;
  }
}

export interface AttachTmuxSessionResult {
  exists: boolean;
  sessionName: string;
  existsCommand: string;
  screen?: string;
  captureCommand?: string;
}

export interface CreateOrAttachTmuxSessionResult {
  existed: boolean;
  sessionName: string;
  screen: string;
  commands: string[];
}

export interface SendTmuxActionsAndCaptureParams {
  target: string;
  actions: TmuxSendAction[];
  lines: number;
  sendDelayMs?: number;
  captureDelayMs?: number;
}

export interface SendTmuxActionsAndCaptureResult {
  screen: string;
  commands: string[];
}

const DEFAULT_CODEX_RESUME_TMUX_READY_TIMEOUT_MS = 15_000;
const DEFAULT_CODEX_RESUME_TMUX_READY_POLL_MS = 250;

function safeTmuxSessionId(id: string, fallback: string): string {
  return id.trim().replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 180) || fallback;
}

export function runtimeTmuxSessionName(runtime: 'codex' | 'claude', id: string): string {
  return `${runtime}_${safeTmuxSessionId(id, runtime === 'codex' ? 'thread' : 'session')}`;
}

export function codexTmuxSessionName(threadId: string): string {
  return runtimeTmuxSessionName('codex', threadId);
}

export function claudeTmuxSessionName(sessionId: string): string {
  return runtimeTmuxSessionName('claude', sessionId);
}

export function buildCodexResumeTmuxCommand(params: StartCodexResumeTmuxSessionParams): {
  tmuxArgs: string[];
  codexCommand: string;
} {
  const codexArgs = buildCodexTuiArgs({
    prompt: '',
    sessionId: params.bridgeSessionId,
    codexThreadId: params.threadId,
    model: params.model,
    forceModel: Boolean(params.model),
    sandboxMode: params.sandboxMode,
    networkAccessEnabled: params.networkAccessEnabled,
    modelReasoningEffort: params.modelReasoningEffort,
    skipGitRepoCheck: params.skipGitRepoCheck,
    workingDirectory: params.workingDirectory,
    permissionMode: params.permissionMode,
    codexMode: params.codexMode,
  }, []);
  const env = buildCodexTuiEnv();
  const executable = resolveCodexCliExecutable({ env });
  const codexCommand = buildCodexTuiShellCommand(executable, codexArgs, env);
  const tmuxArgs = ['new-session', '-d', '-s', params.sessionName];
  if (params.workingDirectory) {
    tmuxArgs.push('-c', params.workingDirectory);
  }
  tmuxArgs.push('--', codexCommand);
  return { tmuxArgs, codexCommand };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function screenExcerpt(screen: string | undefined): string | undefined {
  if (!screen) return undefined;
  return screen.replace(/\s+$/g, '').slice(-2_000);
}

export function hasCodexResumeTmuxReadyPrompt(screenText: string): boolean {
  const normalized = screenText
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .slice(-20_000);
  if (!normalized.trim()) return false;
  return /OpenAI\s+Codex|Codex\s+TUI|codex/i.test(normalized)
    && /(?:^|\n)\s*[›>]\s*(?:[^\n]*)?(?:$|\n)|\?\s+for\s+shortcuts|What\s+would\s+you\s+like/i.test(normalized);
}

export async function waitForCodexResumeTmuxReady(
  sessionName: string,
  core: TmuxCore = tmuxCore,
): Promise<CodexResumeTmuxReadinessResult> {
  const timeoutMs = parsePositiveIntEnv(
    'CODELARK_CODEX_RESUME_TMUX_READY_TIMEOUT_MS',
    DEFAULT_CODEX_RESUME_TMUX_READY_TIMEOUT_MS,
    0,
  );
  const pollMs = parsePositiveIntEnv(
    'CODELARK_CODEX_RESUME_TMUX_READY_POLL_MS',
    DEFAULT_CODEX_RESUME_TMUX_READY_POLL_MS,
    50,
  );
  if (timeoutMs <= 0) return { ready: true, commands: [] };

  const deadline = Date.now() + timeoutMs;
  const commands: string[] = [];
  let lastScreen: string | undefined;
  let lastError: string | undefined;
  let sessionExists: boolean | undefined;
  let sessionExistsCommand: string | undefined;
  while (Date.now() <= deadline) {
    try {
      const capture = await core.capturePane(sessionName, 80);
      commands.push(capture.command);
      lastScreen = capture.screen;
      lastError = undefined;
      if (hasCodexResumeTmuxReadyPrompt(capture.screen)) {
        return { ready: true, commands, lastScreen };
      }
    } catch (error) {
      lastError = describeUnknownError(error);
      try {
        const exists = await core.hasSession(sessionName);
        commands.push(exists.command);
        sessionExists = exists.exists;
        sessionExistsCommand = exists.command;
        if (!exists.exists) {
          return {
            ready: false,
            commands,
            lastScreen,
            lastError,
            sessionExists,
            sessionExistsCommand,
          };
        }
      } catch (existsError) {
        lastError = `${lastError}; session existence check failed: ${describeUnknownError(existsError)}`;
      }
    }
    await sleep(pollMs);
  }

  if (sessionExists === undefined) {
    try {
      const exists = await core.hasSession(sessionName);
      commands.push(exists.command);
      sessionExists = exists.exists;
      sessionExistsCommand = exists.command;
    } catch (error) {
      lastError = lastError
        ? `${lastError}; session existence check failed: ${describeUnknownError(error)}`
        : `session existence check failed: ${describeUnknownError(error)}`;
    }
  }

  console.warn('[codex-tmux-runtime] Timed out waiting for resumed Codex tmux to become ready:', {
    tmux_session: sessionName,
    timeout_ms: timeoutMs,
    session_exists: sessionExists,
    last_error: lastError,
    last_screen_excerpt: screenExcerpt(lastScreen),
  });
  return { ready: false, commands, lastScreen, lastError, sessionExists, sessionExistsCommand };
}

export async function startCodexResumeTmuxSession(
  params: StartCodexResumeTmuxSessionParams,
  core: TmuxCore = tmuxCore,
): Promise<StartCodexResumeTmuxSessionResult> {
  const { codexCommand } = buildCodexResumeTmuxCommand(params);
  const started = await core.ensureDetachedSession({
    name: params.sessionName,
    cwd: params.workingDirectory,
    command: codexCommand,
    recreate: true,
  });
  const ready = await waitForCodexResumeTmuxReady(params.sessionName, core);
  if (!ready.ready) {
    let killCommand: string | undefined;
    try {
      killCommand = await core.killSession(params.sessionName, { ignoreMissing: true });
    } catch (error) {
      console.warn('[codex-tmux-runtime] Failed to clean up unready Codex tmux session:', {
        tmux_session: params.sessionName,
        error: describeUnknownError(error),
      });
    }
    const reason = ready.sessionExists === false
      ? 'tmux session disappeared after new-session; the Codex TUI process likely exited immediately'
      : ready.lastError
        ? `ready probe failed: ${ready.lastError}`
        : 'ready prompt was not detected before timeout';
    const details: CodexResumeTmuxLaunchFailureDetails = {
      sessionName: params.sessionName,
      threadId: params.threadId,
      bridgeSessionId: params.bridgeSessionId,
      workingDirectory: params.workingDirectory,
      reason,
      commands: [...started.commands, ...ready.commands, ...(killCommand ? [killCommand] : [])],
      lastScreen: screenExcerpt(ready.lastScreen),
      lastError: ready.lastError,
      sessionExists: ready.sessionExists,
      sessionExistsCommand: ready.sessionExistsCommand,
      killCommand,
    };
    console.error('[codex-tmux-runtime] Codex resume tmux launch failed:', {
      tmux_session: details.sessionName,
      thread_id: details.threadId,
      bridge_session_id: details.bridgeSessionId,
      cwd: details.workingDirectory,
      reason: details.reason,
      session_exists: details.sessionExists,
      last_error: details.lastError,
      last_screen_excerpt: details.lastScreen,
      commands: details.commands,
      kill_command: details.killCommand,
    });
    throw new CodexResumeTmuxLaunchError(details);
  }
  return {
    existed: started.existed,
    sessionName: params.sessionName,
    codexCommand,
    tmuxCommand: started.command || '',
    commands: [...started.commands, ...ready.commands],
    ready: ready.ready,
  };
}

export async function listTmuxSessions(core: TmuxCore = tmuxCore) {
  return core.listSessions();
}

export async function captureTmuxScreen(
  target: string,
  lines: number,
  core: TmuxCore = tmuxCore,
) {
  return core.capturePane(target, lines);
}

export async function hasTmuxSession(
  name: string,
  core: TmuxCore = tmuxCore,
) {
  return core.hasSession(name);
}

export async function attachTmuxSession(
  name: string,
  lines: number,
  core: TmuxCore = tmuxCore,
): Promise<AttachTmuxSessionResult> {
  const exists = await core.hasSession(name);
  if (!exists.exists) {
    return {
      exists: false,
      sessionName: name,
      existsCommand: exists.command,
    };
  }
  const capture = await core.capturePane(name, lines);
  return {
    exists: true,
    sessionName: name,
    existsCommand: exists.command,
    screen: capture.screen,
    captureCommand: capture.command,
  };
}

export async function createOrAttachTmuxSession(
  params: { name: string; cwd?: string; lines: number },
  core: TmuxCore = tmuxCore,
): Promise<CreateOrAttachTmuxSessionResult> {
  const ensured = await core.ensureDetachedSession({ name: params.name, cwd: params.cwd });
  const capture = await core.capturePane(params.name, params.lines);
  return {
    existed: ensured.existed,
    sessionName: params.name,
    screen: capture.screen,
    commands: [...ensured.commands, capture.command],
  };
}

export async function sendTmuxActionsAndCapture(
  params: SendTmuxActionsAndCaptureParams,
  core: TmuxCore = tmuxCore,
): Promise<SendTmuxActionsAndCaptureResult> {
  const sendResult = await core.sendActions(params.target, params.actions, { delayMs: params.sendDelayMs });
  if (params.captureDelayMs && params.captureDelayMs > 0) {
    await sleep(params.captureDelayMs);
  }
  const capture = await core.capturePane(params.target, params.lines);
  return {
    screen: capture.screen,
    commands: [...sendResult.commands, capture.command],
  };
}

export async function sendTmuxActions(
  target: string,
  actions: TmuxSendAction[],
  options: { delayMs?: number } = {},
  core: TmuxCore = tmuxCore,
) {
  return core.sendActions(target, actions, options);
}

export async function sendTmuxInterrupt(target: string): Promise<string> {
  return tmuxCore.sendInterrupt(target);
}
