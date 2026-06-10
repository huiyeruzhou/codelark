import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildCodexTuiSelectionChoiceActions,
  buildCodexTuiArgs,
  buildCodexTuiEnv,
  buildCodexTuiShellCommand,
  parseCodexTuiSelectionPrompt,
  parsePositiveIntEnv,
  type CodexTuiSelectionPrompt,
  type CodexTuiSelectionPromptChoice,
  type CodexTuiSelectionPromptKind,
} from '../../runtime/codex/tmux-provider.js';
import { resolveCodexCliExecutable } from '../../runtime/codex/cli-executable.js';
import {
  buildClaudePtyCommand,
  buildClaudePtyEnv,
  hasClaudePtyInputPrompt,
  hasClaudePtyOnboardingPrompt,
  hasClaudePtyTrustPrompt,
} from '../../runtime/claude/pty-provider.js';
import { prepareClaudeCodeRouterEnv } from '../../runtime/claude/code-router.js';
import {
  buildShellSnapshotLaunchCommand,
  ensureShellSnapshot,
} from '../../runtime/codex/shell-snapshot.js';
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
  launchLogPath?: string;
}

export type RuntimeTmuxKind = 'codex' | 'claude';

export type RuntimeTmuxSelectionPrompt =
  | {
      runtime: 'codex';
      kind: CodexTuiSelectionPromptKind;
      prompt: CodexTuiSelectionPrompt;
      defaultChoice: CodexTuiSelectionPromptChoice | null;
      summary: string;
    }
  | {
      runtime: 'claude';
      kind: 'onboarding' | 'trust';
      defaultChoice: 'confirm';
      summary: string;
    };

export interface RuntimeTmuxReadinessResult {
  ready: boolean;
  runtime: RuntimeTmuxKind;
  commands: string[];
  lastScreen?: string;
  lastError?: string;
  sessionExists?: boolean;
  sessionExistsCommand?: string;
  selectionPrompt?: RuntimeTmuxSelectionPrompt;
}

export interface InspectRuntimeTmuxSessionResult {
  exists: boolean;
  runtime?: RuntimeTmuxKind;
  sessionName: string;
  existsCommand: string;
  screen?: string;
  captureCommand?: string;
  selectionPrompt?: RuntimeTmuxSelectionPrompt;
}

export interface CleanupRuntimeTmuxSessionResult {
  sessionName?: string;
  commands: string[];
  killed: boolean;
  error?: string;
}

export interface CodexResumeTmuxReadinessResult {
  ready: boolean;
  commands: string[];
  lastScreen?: string;
  lastError?: string;
  sessionExists?: boolean;
  sessionExistsCommand?: string;
  selectionPromptKind?: CodexTuiSelectionPromptKind;
  selectionPromptChoice?: CodexTuiSelectionPromptChoice;
  selectionPromptSummary?: string;
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
  selectionPromptKind?: CodexTuiSelectionPromptKind;
  selectionPromptChoice?: CodexTuiSelectionPromptChoice;
  selectionPromptSummary?: string;
  killCommand?: string;
  launchLogPath?: string;
  launchOutput?: string;
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
  selectionPrompt?: RuntimeTmuxSelectionPrompt;
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

export interface StartClaudeTmuxSessionParams {
  sessionName: string;
  bridgeSessionId: string;
  workingDirectory?: string;
  executable?: StreamChatParams['claudeExecutable'];
  model?: string;
  permissionMode?: StreamChatParams['claudePermissionMode'];
  reasoningEffort?: StreamChatParams['claudeReasoningEffort'];
  controller?: ReadableStreamDefaultController<string>;
  core?: TmuxCore;
  recreate?: boolean;
  waitReady?: boolean;
}

export interface StartClaudeTmuxSessionResult {
  sessionName: string;
  commands: string[];
  existed: boolean;
  ready: boolean;
}

export type StartRuntimeTmuxSessionParams =
  | ({ runtime: 'codex'; core?: TmuxCore } & StartCodexResumeTmuxSessionParams)
  | ({ runtime: 'claude' } & StartClaudeTmuxSessionParams);

export type StartRuntimeTmuxSessionResult =
  | ({ runtime: 'codex' } & StartCodexResumeTmuxSessionResult)
  | ({ runtime: 'claude' } & StartClaudeTmuxSessionResult);

// 这里统一的是 provider-owned tmux session 生命周期，而不是强行抽象 CLI 语义。
// Codex 需要 resume thread，Claude 需要等待 JSONL 发现 session id；保留这些差异能让上层共享创建/查看/清理行为，同时避免 provider 暴露多余接口。

const DEFAULT_CODEX_RESUME_TMUX_READY_TIMEOUT_MS = 15_000;
const DEFAULT_CODEX_RESUME_TMUX_READY_POLL_MS = 250;
const CODEX_TMUX_LAUNCH_LOG_LINES = 80;
const DEFAULT_CLAUDE_TMUX_READY_TIMEOUT_MS = 10_000;
const DEFAULT_CLAUDE_TMUX_READY_POLL_MS = 250;

function posixShellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return '\'' + value.replace(/'/g, "'\\''") + '\'';
}

function codexLaunchLogPath(sessionName: string): string {
  const safeName = safeTmuxSessionId(sessionName, 'codex').slice(0, 120);
  return path.join(os.tmpdir(), `codelark-codex-tmux-${process.pid}-${safeName}.log`);
}

function prepareLaunchLog(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try { fs.rmSync(filePath, { force: true }); } catch { /* best effort cleanup */ }
}

function withStderrLaunchLog(command: string, launchLogPath: string): string {
  const quotedLogPath = posixShellQuote(launchLogPath);
  return [
    `${command} 2> ${quotedLogPath}`,
    'status=$?',
    `if [ "$status" -ne 0 ]; then printf '%s\n' "[codelark] process exited with status $status" >> ${quotedLogPath}; fi`,
    'exit "$status"',
  ].join('; ');
}

function readRecentFile(filePath: string | undefined, lines = CODEX_TMUX_LAUNCH_LOG_LINES): string | undefined {
  if (!filePath) return undefined;
  try {
    const content = fs.readFileSync(filePath, 'utf-8').replace(/\s+$/g, '');
    if (!content) return undefined;
    const split = content.split(/\r?\n/);
    return split.slice(Math.max(0, split.length - lines)).join('\n');
  } catch {
    return undefined;
  }
}

function cleanupLaunchLog(filePath: string | undefined): void {
  if (!filePath) return;
  try { fs.rmSync(filePath, { force: true }); } catch { /* best effort cleanup */ }
}

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
  launchLogPath: string;
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
  const rawCodexCommand = buildCodexTuiShellCommand(executable, codexArgs, env);
  const launchLogPath = codexLaunchLogPath(params.sessionName);
  const codexCommand = withStderrLaunchLog(rawCodexCommand, launchLogPath);
  const tmuxArgs = ['new-session', '-d', '-s', params.sessionName];
  if (params.workingDirectory) {
    tmuxArgs.push('-c', params.workingDirectory);
  }
  tmuxArgs.push('--', codexCommand);
  return { tmuxArgs, codexCommand, launchLogPath };
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

function summarizeClaudeSelection(kind: 'onboarding' | 'trust'): string {
  return kind === 'onboarding'
    ? 'Claude Code is waiting at an onboarding prompt.'
    : 'Claude Code is waiting at a workspace trust prompt.';
}

function detectRuntimeTmuxSelectionPrompt(
  runtime: RuntimeTmuxKind,
  screenText: string,
): RuntimeTmuxSelectionPrompt | undefined {
  if (runtime === 'codex') {
    const prompt = parseCodexTuiSelectionPrompt(screenText);
    if (!prompt) return undefined;
    return {
      runtime: 'codex',
      kind: prompt.kind,
      prompt,
      defaultChoice: defaultCodexResumeStartupSelectionChoice(prompt),
      summary: prompt.summary,
    };
  }
  if (hasClaudePtyOnboardingPrompt(screenText)) {
    return {
      runtime: 'claude',
      kind: 'onboarding',
      defaultChoice: 'confirm',
      summary: summarizeClaudeSelection('onboarding'),
    };
  }
  if (hasClaudePtyTrustPrompt(screenText)) {
    return {
      runtime: 'claude',
      kind: 'trust',
      defaultChoice: 'confirm',
      summary: summarizeClaudeSelection('trust'),
    };
  }
  return undefined;
}

function detectAnyRuntimeTmuxSelectionPrompt(screenText: string): RuntimeTmuxSelectionPrompt | undefined {
  return detectRuntimeTmuxSelectionPrompt('codex', screenText)
    || detectRuntimeTmuxSelectionPrompt('claude', screenText);
}

export function hasCodexResumeTmuxReadyPrompt(screenText: string): boolean {
  if (parseCodexTuiSelectionPrompt(screenText)) return false;
  const normalized = screenText
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .slice(-20_000);
  if (!normalized.trim()) return false;
  return /OpenAI\s+Codex|Codex\s+TUI|codex/i.test(normalized)
    && /(?:^|\n)\s*[›>]\s*(?:[^\n]*)?(?:$|\n)|\?\s+for\s+shortcuts|What\s+would\s+you\s+like/i.test(normalized);
}

function defaultCodexResumeStartupSelectionChoice(
  prompt: CodexTuiSelectionPrompt,
): CodexTuiSelectionPromptChoice | null {
  if (prompt.kind === 'update') return 'skip';
  if (prompt.kind === 'goal') return 'cancel';
  return null;
}

function hasRuntimeTmuxReadyPrompt(runtime: RuntimeTmuxKind, screenText: string): boolean {
  return runtime === 'codex'
    ? hasCodexResumeTmuxReadyPrompt(screenText)
    : hasClaudePtyInputPrompt(screenText);
}

function runtimeReadyTimeoutMs(runtime: RuntimeTmuxKind): number {
  if (runtime === 'codex') {
    return parsePositiveIntEnv(
      'CODELARK_CODEX_RESUME_TMUX_READY_TIMEOUT_MS',
      DEFAULT_CODEX_RESUME_TMUX_READY_TIMEOUT_MS,
      0,
    );
  }
  return parsePositiveIntEnv(
    'CODELARK_CLAUDE_TMUX_READY_TIMEOUT_MS',
    DEFAULT_CLAUDE_TMUX_READY_TIMEOUT_MS,
    0,
  );
}

function runtimeReadyPollMs(runtime: RuntimeTmuxKind): number {
  if (runtime === 'codex') {
    return parsePositiveIntEnv(
      'CODELARK_CODEX_RESUME_TMUX_READY_POLL_MS',
      DEFAULT_CODEX_RESUME_TMUX_READY_POLL_MS,
      50,
    );
  }
  return parsePositiveIntEnv(
    'CODELARK_CLAUDE_TMUX_READY_POLL_MS',
    DEFAULT_CLAUDE_TMUX_READY_POLL_MS,
    50,
  );
}

function codexReadinessFromRuntimeResult(result: RuntimeTmuxReadinessResult): CodexResumeTmuxReadinessResult {
  const selectionPrompt = result.selectionPrompt?.runtime === 'codex'
    ? result.selectionPrompt
    : undefined;
  return {
    ready: result.ready,
    commands: result.commands,
    lastScreen: result.lastScreen,
    lastError: result.lastError,
    sessionExists: result.sessionExists,
    sessionExistsCommand: result.sessionExistsCommand,
    selectionPromptKind: selectionPrompt?.kind,
    selectionPromptChoice: selectionPrompt?.defaultChoice || undefined,
    selectionPromptSummary: selectionPrompt?.summary,
  };
}

export async function waitForRuntimeTmuxReady(params: {
  runtime: RuntimeTmuxKind;
  sessionName: string;
  target?: string;
  core?: TmuxCore;
  autoResolveSelection?: boolean;
  afterSelectionDelayMs?: number;
  onSelectionPrompt?: (selectionPrompt: RuntimeTmuxSelectionPrompt) => void | Promise<void>;
}): Promise<RuntimeTmuxReadinessResult> {
  const core = params.core || tmuxCore;
  const captureTarget = params.target || params.sessionName;
  const timeoutMs = runtimeReadyTimeoutMs(params.runtime);
  const pollMs = runtimeReadyPollMs(params.runtime);
  if (timeoutMs <= 0) {
    return { ready: true, runtime: params.runtime, commands: [] };
  }

  const deadline = Date.now() + timeoutMs;
  const commands: string[] = [];
  let lastScreen: string | undefined;
  let lastError: string | undefined;
  let sessionExists: boolean | undefined;
  let sessionExistsCommand: string | undefined;
  let selectionPrompt: RuntimeTmuxSelectionPrompt | undefined;
  const handledSelectionFingerprints = new Set<string>();
  while (Date.now() <= deadline) {
    try {
      const capture = await core.capturePane(captureTarget, 80);
      commands.push(capture.command);
      lastScreen = capture.screen;
      lastError = undefined;
      selectionPrompt = detectRuntimeTmuxSelectionPrompt(params.runtime, capture.screen);
      if (selectionPrompt) {
        if (params.autoResolveSelection === false || selectionPrompt.defaultChoice === null) {
          return {
            ready: false,
            runtime: params.runtime,
            commands,
            lastScreen,
            sessionExists: true,
            selectionPrompt,
          };
        }
        const fingerprint = selectionPrompt.runtime === 'codex'
          ? selectionPrompt.prompt.fingerprint
          : `${selectionPrompt.runtime}:${selectionPrompt.kind}`;
        if (!handledSelectionFingerprints.has(fingerprint)) {
          handledSelectionFingerprints.add(fingerprint);
          await params.onSelectionPrompt?.(selectionPrompt);
          const actions = selectionPrompt.runtime === 'codex'
            ? buildCodexTuiSelectionChoiceActions(selectionPrompt.prompt, selectionPrompt.defaultChoice)
            : [{ type: 'key' as const, key: 'Enter' }];
          if (actions.length > 0) {
            const sent = await core.sendActions(captureTarget, actions);
            commands.push(...sent.commands);
          }
        }
        if (params.afterSelectionDelayMs && params.afterSelectionDelayMs > 0) {
          await sleep(params.afterSelectionDelayMs);
        } else {
          await sleep(pollMs);
        }
        continue;
      }
      if (hasRuntimeTmuxReadyPrompt(params.runtime, capture.screen)) {
        return {
          ready: true,
          runtime: params.runtime,
          commands,
          lastScreen,
          ...(selectionPrompt ? { selectionPrompt } : {}),
        };
      }
    } catch (error) {
      lastError = describeUnknownError(error);
      try {
        const exists = await core.hasSession(params.sessionName);
        commands.push(exists.command);
        sessionExists = exists.exists;
        sessionExistsCommand = exists.command;
        if (!exists.exists) {
          return {
            ready: false,
            runtime: params.runtime,
            commands,
            lastScreen,
            lastError,
            sessionExists,
            sessionExistsCommand,
            ...(selectionPrompt ? { selectionPrompt } : {}),
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
      const exists = await core.hasSession(params.sessionName);
      commands.push(exists.command);
      sessionExists = exists.exists;
      sessionExistsCommand = exists.command;
    } catch (error) {
      lastError = lastError
        ? `${lastError}; session existence check failed: ${describeUnknownError(error)}`
        : `session existence check failed: ${describeUnknownError(error)}`;
    }
  }

  console.warn('[tmux-runtime] Timed out waiting for runtime tmux session to become ready:', {
    runtime: params.runtime,
    tmux_session: params.sessionName,
    capture_target: captureTarget,
    timeout_ms: timeoutMs,
    session_exists: sessionExists,
    last_error: lastError,
    last_screen_excerpt: screenExcerpt(lastScreen),
    selection_prompt: selectionPrompt
      ? {
        runtime: selectionPrompt.runtime,
        kind: selectionPrompt.kind,
        default_choice: selectionPrompt.defaultChoice,
        summary: screenExcerpt(selectionPrompt.summary),
      }
      : undefined,
  });
  return {
    ready: false,
    runtime: params.runtime,
    commands,
    lastScreen,
    lastError,
    sessionExists,
    sessionExistsCommand,
    ...(selectionPrompt ? { selectionPrompt } : {}),
  };
}

export async function waitForCodexResumeTmuxReady(
  sessionName: string,
  core: TmuxCore = tmuxCore,
): Promise<CodexResumeTmuxReadinessResult> {
  return codexReadinessFromRuntimeResult(await waitForRuntimeTmuxReady({
    runtime: 'codex',
    sessionName,
    core,
  }));
}

export async function startCodexResumeTmuxSession(
  params: StartCodexResumeTmuxSessionParams,
  core: TmuxCore = tmuxCore,
): Promise<StartCodexResumeTmuxSessionResult> {
  const { codexCommand, launchLogPath } = buildCodexResumeTmuxCommand(params);
  prepareLaunchLog(launchLogPath);
  const started = await core.ensureDetachedSession({
    name: params.sessionName,
    cwd: params.workingDirectory,
    command: codexCommand,
    recreate: true,
  });
  const startedCheck = await waitForCodexResumeTmuxReady(params.sessionName, core);
  if (!startedCheck.ready) {
    let killCommand: string | undefined;
    try {
      killCommand = await core.killSession(params.sessionName, { ignoreMissing: true });
    } catch (error) {
      console.warn('[codex-tmux-runtime] Failed to clean up unready Codex tmux session:', {
        tmux_session: params.sessionName,
        error: describeUnknownError(error),
      });
    }
    const launchOutput = readRecentFile(launchLogPath);
    cleanupLaunchLog(launchLogPath);
    const reason = startedCheck.sessionExists === false
      ? 'tmux session disappeared after new-session; the Codex TUI process likely exited immediately'
      : startedCheck.selectionPromptKind
        ? `Codex TUI is waiting at a ${startedCheck.selectionPromptKind} selection prompt during startup`
      : startedCheck.lastError
        ? `tmux launch check failed: ${startedCheck.lastError}`
        : 'tmux session did not survive after new-session';
    const details: CodexResumeTmuxLaunchFailureDetails = {
      sessionName: params.sessionName,
      threadId: params.threadId,
      bridgeSessionId: params.bridgeSessionId,
      workingDirectory: params.workingDirectory,
      reason,
      commands: [...started.commands, ...startedCheck.commands, ...(killCommand ? [killCommand] : [])],
      lastScreen: screenExcerpt(startedCheck.lastScreen),
      lastError: startedCheck.lastError,
      sessionExists: startedCheck.sessionExists,
      sessionExistsCommand: startedCheck.sessionExistsCommand,
      selectionPromptKind: startedCheck.selectionPromptKind,
      selectionPromptChoice: startedCheck.selectionPromptChoice,
      selectionPromptSummary: screenExcerpt(startedCheck.selectionPromptSummary),
      killCommand,
      launchLogPath,
      launchOutput: screenExcerpt(launchOutput),
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
      selection_prompt_kind: details.selectionPromptKind,
      selection_prompt_choice: details.selectionPromptChoice,
      selection_prompt_summary: details.selectionPromptSummary,
      launch_log_path: details.launchLogPath,
      launch_output_excerpt: details.launchOutput,
      commands: details.commands,
      kill_command: details.killCommand,
    });
    throw new CodexResumeTmuxLaunchError(details);
  }
  cleanupLaunchLog(launchLogPath);
  return {
    existed: started.existed,
    sessionName: params.sessionName,
    codexCommand,
    tmuxCommand: started.command || '',
    commands: [...started.commands, ...startedCheck.commands],
    ready: true,
    launchLogPath,
  };
}

function commandPreview(command: string, args: string[]): string {
  return [command, ...args].map(posixShellQuote).join(' ');
}

function buildClaudeTmuxShellCommand(command: string, args: string[], env: Record<string, string>): string {
  const snapshot = ensureShellSnapshot(env);
  return buildShellSnapshotLaunchCommand(command, args, snapshot);
}

export async function startClaudeTmuxSession(
  params: StartClaudeTmuxSessionParams,
): Promise<StartClaudeTmuxSessionResult> {
  const core = params.core || tmuxCore;
  const executable = params.executable || 'claude';
  const cwd = params.workingDirectory || process.cwd();
  const baseEnv = buildClaudePtyEnv();
  const { command, args } = buildClaudePtyCommand(executable, {
    model: params.model?.trim() || undefined,
    permissionMode: params.permissionMode?.trim() || undefined,
    reasoningEffort: params.reasoningEffort?.trim() || undefined,
    env: baseEnv,
  });
  const env = executable === 'ccr'
    ? await prepareClaudeCodeRouterEnv(command, baseEnv, {
      controller: params.controller,
      logPrefix: '[claude-tmux]',
    })
    : baseEnv;
  const shellCommand = buildClaudeTmuxShellCommand(command, args, env);

  console.log('[claude-tmux] Claude Code TUI start:', {
    bridge_session_id: params.bridgeSessionId,
    tmux_session: params.sessionName,
    command: commandPreview(command, args),
    cwd,
    executable,
  });
  const started = await core.ensureDetachedSession({
    name: params.sessionName,
    cwd,
    command: shellCommand,
    recreate: params.recreate !== false,
  });
  const readiness = params.waitReady
    ? await waitForRuntimeTmuxReady({
      runtime: 'claude',
      sessionName: params.sessionName,
      core,
    })
    : null;
  return {
    sessionName: params.sessionName,
    existed: started.existed,
    commands: [...started.commands, ...(readiness?.commands || [])],
    ready: readiness?.ready ?? true,
  };
}

export async function startRuntimeTmuxSession(
  params: StartRuntimeTmuxSessionParams,
): Promise<StartRuntimeTmuxSessionResult> {
  if (params.runtime === 'codex') {
    const { runtime: _runtime, core, ...codexParams } = params;
    const started = await startCodexResumeTmuxSession(codexParams, core);
    return { runtime: 'codex', ...started };
  }
  const started = await startClaudeTmuxSession(params);
  return { runtime: 'claude', ...started };
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
  const inspected = await inspectRuntimeTmuxSession({ sessionName: name, lines, core });
  if (!inspected.exists) {
    return {
      exists: false,
      sessionName: name,
      existsCommand: inspected.existsCommand,
    };
  }
  return {
    exists: true,
    sessionName: name,
    existsCommand: inspected.existsCommand,
    screen: inspected.screen,
    captureCommand: inspected.captureCommand,
    selectionPrompt: inspected.selectionPrompt,
  };
}

export async function inspectRuntimeTmuxSession(params: {
  sessionName: string;
  lines: number;
  runtime?: RuntimeTmuxKind;
  core?: TmuxCore;
}): Promise<InspectRuntimeTmuxSessionResult> {
  const core = params.core || tmuxCore;
  const exists = await core.hasSession(params.sessionName);
  if (!exists.exists) {
    return {
      exists: false,
      runtime: params.runtime,
      sessionName: params.sessionName,
      existsCommand: exists.command,
    };
  }
  const capture = await core.capturePane(params.sessionName, params.lines);
  const selectionPrompt = params.runtime
    ? detectRuntimeTmuxSelectionPrompt(params.runtime, capture.screen)
    : detectAnyRuntimeTmuxSelectionPrompt(capture.screen);
  return {
    exists: true,
    runtime: selectionPrompt?.runtime || params.runtime,
    sessionName: params.sessionName,
    existsCommand: exists.command,
    screen: capture.screen,
    captureCommand: capture.command,
    ...(selectionPrompt ? { selectionPrompt } : {}),
  };
}

export async function cleanupRuntimeTmuxSession(params: {
  sessionName?: string;
  runtime?: RuntimeTmuxKind;
  core?: TmuxCore;
  ignoreMissing?: boolean;
}): Promise<CleanupRuntimeTmuxSessionResult> {
  const commands: string[] = [];
  if (!params.sessionName) return { commands, killed: false };
  const core = params.core || tmuxCore;
  try {
    const command = await core.killSession(params.sessionName, { ignoreMissing: params.ignoreMissing !== false });
    commands.push(command);
    return { sessionName: params.sessionName, commands, killed: true };
  } catch (error) {
    return {
      sessionName: params.sessionName,
      commands,
      killed: false,
      error: describeUnknownError(error),
    };
  }
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
