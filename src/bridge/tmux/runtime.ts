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
): Promise<{ ready: boolean; commands: string[] }> {
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
  while (Date.now() <= deadline) {
    try {
      const capture = await core.capturePane(sessionName, 80);
      commands.push(capture.command);
      if (hasCodexResumeTmuxReadyPrompt(capture.screen)) {
        return { ready: true, commands };
      }
    } catch {
      // The pane can be briefly unavailable immediately after tmux creates it.
    }
    await sleep(pollMs);
  }

  console.warn('[codex-tmux-runtime] Timed out waiting for resumed Codex tmux to become ready:', {
    tmux_session: sessionName,
    timeout_ms: timeoutMs,
  });
  return { ready: false, commands };
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
