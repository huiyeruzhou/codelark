import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { LLMProvider, StreamChatParams, BridgeMirrorRecord } from '../contracts.js';
import { sseEvent } from '../sse.js';
import { tmuxCore } from '../../bridge/tmux/core.js';
import {
  inspectRuntimeTmuxInput,
  setRuntimeTmuxTurnState,
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
  findKimiSessionFileById,
  readKimiSessionMirrorRecordDeltaByFilePath,
} from './session-index.js';
import {
  kimiSessionLogFilePath,
  parseKimiTerminalErrorsFromLog,
} from './runtime-log.js';

import { assertKimiLaunchAuthentication } from './auth.js';

const DEFAULT_KIMI_POLL_INTERVAL_MS = 500;
const DEFAULT_KIMI_SESSION_FILE_TIMEOUT_MS = 30_000;
const DEFAULT_KIMI_OUTPUT_IDLE_TIMEOUT_MS = 120_000;
const DEFAULT_KIMI_PROMPT_DELAY_MS = 0;
const DEFAULT_KIMI_SESSION_ID_TIMEOUT_MS = 30_000;
const DEFAULT_KIMI_INPUT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_KIMI_STEER_DELAY_MS = 500;
const DEFAULT_KIMI_INPUT_STABILITY_MS = 500;
const DEFAULT_KIMI_SUBMISSION_ACK_TIMEOUT_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePositiveIntEnv(name: string, fallback: number, minValue: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed >= minValue) return Math.floor(parsed);
  return fallback;
}

function isTruthyEnv(value: string | undefined): boolean {
  const normalized = (value || '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function isDebugTmuxKeepAlive(): boolean {
  return isTruthyEnv(process.env.CODELARK_DEBUG);
}

function resolveKimiCliExecutable(): string {
  const envPath = process.env.KIMI_CODE_EXECUTABLE || process.env.CODELARK_KIMI_EXECUTABLE;
  if (envPath) return envPath;
  const homeBin = path.join(os.homedir(), '.kimi-code', 'bin', 'kimi');
  if (fs.existsSync(homeBin)) return homeBin;
  return 'kimi';
}

export function kimiTmuxSessionName(sessionId: string): string {
  return `clk-kimi-${sessionId}`;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function commandPreview(command: string, args: string[]): string {
  return [command, ...args].map(shellQuote).join(' ');
}

function kimiCommandEnvironmentPrefix(env: NodeJS.ProcessEnv = process.env): string {
  const assignments = [
    ['KIMI_CODE_HOME', env.KIMI_CODE_HOME],
  ]
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([key, value]) => `${key}=${shellQuote(value)}`);
  return assignments.length > 0 ? `${assignments.join(' ')} ` : '';
}

function definedEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

export function buildKimiTmuxLaunchCommand(
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
    return `${kimiCommandEnvironmentPrefix(env)}${commandPreview(executable, args)}`;
  }
  const shell = options.shell || resolveDefaultUserShell({ platform });
  const snapshot = ensureShellSnapshot(definedEnvironment(env), shell);
  return buildShellSnapshotLaunchArgs(executable, args, snapshot, { platform });
}

function normalizeKimiScreenText(screenText: string): string {
  return screenText
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

export function parseKimiSessionIdFromScreen(screenText: string): string | null {
  const normalized = normalizeKimiScreenText(screenText);
  const resumeMatch = normalized.match(/To\s+resume\s+this\s+session:\s*kimi\s+-r\s+(session_[A-Za-z0-9-]+)/i);
  if (resumeMatch?.[1]) return resumeMatch[1];
  const headerMatch = normalized.match(/\bSession:\s*(session_[A-Za-z0-9-]+)/i);
  return headerMatch?.[1] || null;
}

function parseKimiActiveSessionIdFromScreen(screenText: string): string | null {
  const normalized = normalizeKimiScreenText(screenText);
  return normalized.match(/\bSession:\s*(session_[A-Za-z0-9-]+)/i)?.[1] || null;
}

export function isKimiInputReadyScreen(
  screenText: string,
  expectedSessionId?: string,
): boolean {
  const normalized = normalizeKimiScreenText(screenText);
  const activeSessionId = parseKimiActiveSessionIdFromScreen(normalized);
  if (!activeSessionId || (expectedSessionId && activeSessionId !== expectedSessionId)) return false;
  return isKimiEditorReadyScreen(normalized);
}

function isKimiEditorReadyScreen(screenText: string): boolean {
  const normalized = normalizeKimiScreenText(screenText);
  const hasInputPrompt = /(?:^|\n)\s*(?:[│|]\s*)?>\s/u.test(normalized);
  const hasContextFooter = /\bcontext:\s*\d+%/iu.test(normalized);
  return hasInputPrompt && hasContextFooter;
}

function kimiStartupErrorFromScreen(screenText: string): string | null {
  const lines = screenText
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const start = lines.findIndex((line) => /^error:/i.test(line));
  if (start < 0) return null;
  return lines
    .slice(start)
    .filter((line) => !/^See log:/i.test(line) && !/^Pane is dead /i.test(line))
    .join(' ');
}

function assertKimiPaneAlive(screenText: string): void {
  const paneDead = detectRuntimeTmuxPaneDead(screenText);
  if (!paneDead) return;
  const status = paneDead.status === undefined ? '' : ` (exit ${paneDead.status})`;
  const detail = kimiStartupErrorFromScreen(screenText);
  throw new Error(`Kimi Code exited before session initialization${status}${detail ? `: ${detail}` : '.'}`);
}

function recordToolName(record: BridgeMirrorRecord): string {
  return record.toolName || 'tool';
}

interface KimiTuiRunContext {
  sessionName: string;
  targetPane: string;
  bridgeSessionId: string;
  sessionId?: string;
  cwd?: string;
  sessionFilePath?: string;
  lastScreen?: string;
  sessionLogFilePath?: string;
  nextOffset: number;
  nextLogOffset: number;
  logTrailingText: string;
  trailingText: string;
  nextTurnId: string | null;
  nextSpecialCallIds: string[];
  emittedToolStarts: Set<string>;
  emittedRecordSignatures: Set<string>;
  lastAssistantText: string;
  terminalSeen: boolean;
  hasError: boolean;
}

function initializeKimiSessionLogCursor(context: KimiTuiRunContext): void {
  if (!context.sessionFilePath) return;
  const filePath = kimiSessionLogFilePath(context.sessionFilePath);
  context.sessionLogFilePath = filePath;
  try {
    context.nextLogOffset = fs.statSync(filePath).size;
  } catch {
    context.nextLogOffset = 0;
  }
  context.logTrailingText = '';
}

function readKimiRuntimeErrorDelta(context: KimiTuiRunContext): { error: string | null; advanced: boolean } {
  if (!context.sessionLogFilePath) return { error: null, advanced: false };
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(context.sessionLogFilePath);
  } catch {
    return { error: null, advanced: false };
  }
  if (bytes.length <= context.nextLogOffset) return { error: null, advanced: false };
  const chunk = bytes.subarray(context.nextLogOffset).toString('utf8');
  context.nextLogOffset = bytes.length;
  const parsed = parseKimiTerminalErrorsFromLog(
    `${context.logTrailingText}${chunk}`,
    null,
    context.nextTurnId,
  );
  context.logTrailingText = parsed.trailingText;
  return { error: parsed.records[0]?.errorText || null, advanced: true };
}

function enqueueKimiRecordAsSse(
  controller: ReadableStreamDefaultController<string>,
  context: KimiTuiRunContext,
  record: BridgeMirrorRecord,
): void {
  if (context.emittedRecordSignatures.has(record.signature)) return;
  context.emittedRecordSignatures.add(record.signature);

  switch (record.type) {
    case 'task_started':
      context.terminalSeen = false;
      setRuntimeTmuxTurnState('kimi', context.sessionName, 'active', 'Kimi wire reported task_started');
      break;

    case 'reasoning':
      if (record.content) {
        controller.enqueue(sseEvent('status', record.reasoningKind === 'thinking'
          ? {
              reasoning: record.reasoningLabel || '思考',
              thinking: record.content,
            }
          : { reasoning: record.content }));
      }
      break;

    case 'context_usage':
      if (record.contextUsage) {
        controller.enqueue(sseEvent('context_usage', record.contextUsage));
      }
      break;

    case 'tool_started': {
      const toolId = record.toolId || record.signature;
      if (!context.emittedToolStarts.has(toolId)) {
        context.emittedToolStarts.add(toolId);
        controller.enqueue(sseEvent('tool_use', {
          id: toolId,
          name: recordToolName(record),
          input: record.toolInput || {},
        }));
      }
      break;
    }

    case 'tool_finished': {
      const toolId = record.toolId || record.signature;
      if (!context.emittedToolStarts.has(toolId)) {
        context.emittedToolStarts.add(toolId);
        controller.enqueue(sseEvent('tool_use', {
          id: toolId,
          name: recordToolName(record),
          input: {},
        }));
      }
      controller.enqueue(sseEvent('tool_result', {
        tool_use_id: toolId,
        content: record.content || 'Done',
        is_error: record.isError === true,
      }));
      break;
    }

    case 'message':
      if (record.role === 'assistant' && record.content) {
        context.lastAssistantText = record.content;
        controller.enqueue(sseEvent('text', record.content));
      } else if (record.role === 'commentary' && record.content) {
        controller.enqueue(sseEvent('status', { reasoning: record.content }));
      }
      break;

    case 'task_complete':
      context.terminalSeen = true;
      setRuntimeTmuxTurnState('kimi', context.sessionName, 'idle', 'Kimi wire reported task_complete');
      controller.enqueue(sseEvent('result', {
        ...(context.sessionId ? { session_id: context.sessionId } : {}),
        ...(context.cwd ? { cwd: context.cwd } : {}),
      }));
      break;

    case 'task_aborted':
      context.terminalSeen = true;
      context.hasError = true;
      setRuntimeTmuxTurnState('kimi', context.sessionName, 'idle', 'Kimi wire reported task_aborted');
      controller.enqueue(sseEvent('error', record.content || 'Kimi task aborted.'));
      break;

    case 'goal_status':
      // Kimi goals map to task updates when available; for now, emit as status.
      if (record.goalObjective) {
        controller.enqueue(sseEvent('status', { reasoning: `Goal: ${record.goalObjective}` }));
      }
      break;
  }
}

async function pollKimiSessionFile(
  controller: ReadableStreamDefaultController<string>,
  context: KimiTuiRunContext,
  isTerminalAlive: () => Promise<boolean>,
): Promise<void> {
  const pollIntervalMs = parsePositiveIntEnv(
    'CODELARK_KIMI_TMUX_POLL_INTERVAL_MS',
    DEFAULT_KIMI_POLL_INTERVAL_MS,
    50,
  );
  const legacyIdleTimeoutMs = parsePositiveIntEnv(
    'CODELARK_KIMI_TMUX_SESSION_FILE_TIMEOUT_MS',
    DEFAULT_KIMI_OUTPUT_IDLE_TIMEOUT_MS,
    1_000,
  );
  const outputIdleTimeoutMs = parsePositiveIntEnv(
    'CODELARK_KIMI_TMUX_OUTPUT_IDLE_TIMEOUT_MS',
    process.env.CODELARK_KIMI_TMUX_SESSION_FILE_TIMEOUT_MS
      ? legacyIdleTimeoutMs
      : DEFAULT_KIMI_OUTPUT_IDLE_TIMEOUT_MS,
    1_000,
  );

  let lastActivityAtMs = Date.now();

  while (true) {
    if (!context.sessionFilePath) {
      throw new Error('Kimi session file was not resolved before polling.');
    }

    if (context.sessionFilePath) {
      let endOffset = context.nextOffset;
      try {
        endOffset = fs.statSync(context.sessionFilePath).size;
      } catch {
        // Let the delta reader handle the read race and preserve cursor state.
      }
      const previousOffset = context.nextOffset;
      const delta = readKimiSessionMirrorRecordDeltaByFilePath(
        context.sessionFilePath,
        context.nextOffset,
        endOffset,
        context.trailingText,
        context.nextTurnId,
        context.nextSpecialCallIds,
      );
      context.nextOffset = delta.nextOffset;
      context.trailingText = delta.trailingText;
      context.nextTurnId = delta.nextTurnId;
      context.nextSpecialCallIds = delta.nextSpecialCallIds;
      for (const record of delta.records) {
        enqueueKimiRecordAsSse(controller, context, record);
      }
      if (delta.nextOffset > previousOffset) lastActivityAtMs = Date.now();
    }

    const logDelta = readKimiRuntimeErrorDelta(context);
    if (logDelta.advanced) lastActivityAtMs = Date.now();
    if (logDelta.error) throw new Error(`Kimi Code request failed: ${logDelta.error}`);

    if (context.terminalSeen) break;

    const alive = await isTerminalAlive();
    if (!alive) {
      throw new Error('Kimi Code exited before writing a terminal turn event.');
    }

    if (Date.now() - lastActivityAtMs > outputIdleTimeoutMs) {
      throw new Error(`Kimi Code produced no wire or runtime-log activity for ${outputIdleTimeoutMs}ms.`);
    }

    await sleep(pollIntervalMs);
  }
}

export function buildKimiArgs(params: StreamChatParams): string[] {
  const args: string[] = [];
  if (params.kimiSessionId) {
    args.push('-r', params.kimiSessionId);
  }
  args.push('-y');
  if (params.model) {
    args.push('-m', params.model);
  }
  if (params.kimiThinking === true) {
    args.push('--thinking');
  } else if (params.kimiThinking === false) {
    args.push('--no-thinking');
  }
  return args;
}

async function launchTmuxKimiSession(
  sessionName: string,
  params: StreamChatParams,
): Promise<void> {
  const executable = resolveKimiCliExecutable();
  const args = buildKimiArgs(params);
  const tmuxCommand = buildKimiTmuxLaunchCommand(executable, args);

  console.log('[kimi-tmux] Kimi TUI start:', {
    bridge_session_id: params.sessionId,
    tmux_session: sessionName,
    command: tmuxCommand,
    prompt_chars: params.prompt.length,
    cwd: params.workingDirectory || null,
    resume_session_id: params.kimiSessionId || null,
    debug_keep_tmux: isDebugTmuxKeepAlive(),
  });
  transitionRuntimeTmuxInputState(
    'kimi',
    sessionName,
    'starting_tmux',
    'starting or replacing the provider-owned Kimi tmux session',
  );

  await tmuxCore.ensureDetachedSession({
    name: sessionName,
    cwd: params.workingDirectory,
    command: tmuxCommand,
    recreate: true,
  });
}

async function ensureKimiTmuxInputKeys(): Promise<void> {
  const command = await tmuxCore.ensureExtendedKeys?.();
  if (command) {
    console.log('[kimi-tmux] tmux extended keys enabled for Kimi input:', command);
  }
}

function isMissingTmuxServerError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no server running|failed to connect to server|error connecting to .*\(no such file or directory\)/i.test(message);
}

async function ensureKimiTmuxInputKeysWithRelaunch(
  sessionName: string,
  params: StreamChatParams,
): Promise<boolean> {
  const maxChecks = 3;
  for (let check = 1; check <= maxChecks; check += 1) {
    try {
      await ensureKimiTmuxInputKeys();
      return check > 1;
    } catch (error) {
      if (!isMissingTmuxServerError(error) || check === maxChecks) throw error;
      console.warn('[kimi-tmux] tmux server exited during Kimi startup; relaunching:', {
        tmux_session: sessionName,
        check,
        max_checks: maxChecks,
        error: error instanceof Error ? error.message : String(error),
      });
      await sleep(100 * check);
      await launchTmuxKimiSession(sessionName, params);
    }
  }
  return false;
}

async function waitForKimiSessionIdFromTmux(context: KimiTuiRunContext): Promise<string> {
  const expectedSessionId = context.sessionId;
  transitionRuntimeTmuxInputState(
    'kimi',
    context.sessionName,
    'checking_session',
    'waiting for the resumed Kimi session id',
  );
  const timeoutMs = parsePositiveIntEnv(
    'CODELARK_KIMI_TMUX_SESSION_ID_TIMEOUT_MS',
    DEFAULT_KIMI_SESSION_ID_TIMEOUT_MS,
    1_000,
  );
  const pollIntervalMs = parsePositiveIntEnv(
    'CODELARK_KIMI_TMUX_POLL_INTERVAL_MS',
    DEFAULT_KIMI_POLL_INTERVAL_MS,
    50,
  );
  let deadline = Date.now() + timeoutMs;
  let lastTrustActionAt = 0;
  while (Date.now() <= deadline) {
    const capture = await tmuxCore.capturePane(context.targetPane, 160);
    context.lastScreen = capture.screen;
    assertKimiPaneAlive(capture.screen);
    if (isKimiWorkspaceTrustPrompt(capture.screen)) {
      if (Date.now() - lastTrustActionAt >= 250) {
        await tmuxCore.sendActions(context.targetPane, [{ type: 'key', key: 'Enter' }]);
        lastTrustActionAt = Date.now();
        deadline = lastTrustActionAt + timeoutMs;
        console.log('[kimi-tmux] Confirmed Kimi workspace trust prompt before session id:', context.targetPane);
      }
      await sleep(pollIntervalMs);
      continue;
    }
    const parsed = parseKimiActiveSessionIdFromScreen(capture.screen);
    if (parsed) {
      if (expectedSessionId && parsed !== expectedSessionId) {
        throw new Error(`Kimi resumed unexpected session ${parsed}; expected ${expectedSessionId}.`);
      }
      context.sessionId = parsed;
      return parsed;
    }
    await sleep(pollIntervalMs);
  }
  throw new Error('Timed out waiting for Kimi to print its session id.');
}

function resolveKimiSessionFileBySessionId(
  context: KimiTuiRunContext,
  startAtEnd: boolean,
): boolean {
  if (!context.sessionId) return false;
  const summary = findKimiSessionFileById(context.sessionId, context.cwd);
  if (!summary?.filePath) return false;
  context.sessionFilePath = summary.filePath;
  context.sessionId = summary.sessionId;
  context.cwd = summary.cwd || context.cwd;
  context.nextOffset = startAtEnd ? fs.statSync(summary.filePath).size : 0;
  console.log('[kimi-tmux] Session file resolved:', {
    session_id: context.sessionId,
    file_path: context.sessionFilePath,
    start_offset: context.nextOffset,
  });
  return true;
}

type KimiSubmissionState = 'missing' | 'accepted' | 'started';

function inspectKimiTurnActive(sessionFilePath: string, endOffset?: number): boolean {
  const wire = fs.readFileSync(sessionFilePath);
  const wireText = wire.subarray(0, endOffset ?? wire.length).toString('utf8');
  let turnActive = false;
  for (const line of wireText.split(/\r?\n/u)) {
    try {
      const entry = JSON.parse(line) as { event?: { type?: string } };
      if (entry.event?.type === 'step.begin') turnActive = true;
      if (entry.event?.type === 'step.end') turnActive = false;
    } catch {
      // Ignore non-JSON and a partial final wire line.
    }
  }
  return turnActive;
}

export function syncKimiTmuxTurnStateFromSession(params: {
  sessionName: string;
  sessionId?: string;
  cwd?: string;
  sessionFilePath?: string;
  forceIdle?: boolean;
}): {
  sessionFilePath?: string;
  startOffset: number;
  turnActive: boolean;
} {
  const sessionFilePath = params.sessionFilePath
    || (params.sessionId ? findKimiSessionFileById(params.sessionId, params.cwd)?.filePath : undefined);
  const startOffset = sessionFilePath ? fs.statSync(sessionFilePath).size : 0;
  const turnActive = params.forceIdle !== true
    && Boolean(sessionFilePath)
    && inspectKimiTurnActive(sessionFilePath!, startOffset);
  setRuntimeTmuxTurnState(
    'kimi',
    params.sessionName,
    turnActive ? 'active' : 'idle',
    turnActive
      ? 'Kimi wire has step.begin without a later step.end'
      : params.forceIdle === true
        ? 'new or resumed Kimi process starts from an idle editor'
        : 'Kimi wire has no active turn',
  );
  return {
    ...(sessionFilePath ? { sessionFilePath } : {}),
    startOffset,
    turnActive,
  };
}

function inspectKimiSubmissionState(
  sessionFilePath: string,
  startOffset: number,
  expectedPrompt?: string,
): KimiSubmissionState {
  if (!expectedPrompt) return 'started';
  if (fs.statSync(sessionFilePath).size <= startOffset) return 'missing';
  const wire = fs.readFileSync(sessionFilePath);
  const wireDelta = wire.subarray(startOffset).toString('utf8');
  const encodedPrompt = JSON.stringify(expectedPrompt);
  let turnActive = inspectKimiTurnActive(sessionFilePath, startOffset);
  let promptAccepted = false;
  for (const line of wireDelta.split(/\r?\n/u)) {
    if (!line) continue;
    if (line.includes(encodedPrompt)) promptAccepted = true;
    try {
      const entry = JSON.parse(line) as {
        type?: string;
        event?: { type?: string };
      };
      if (entry.type === 'turn.steer' && promptAccepted && turnActive) return 'started';
      if (entry.event?.type === 'step.begin') {
        turnActive = true;
      }
      if (entry.event?.type === 'step.end') turnActive = false;
      if (entry.type === 'llm.request' && promptAccepted) {
        return 'started';
      }
    } catch {
      // Ignore a partial final wire line until the next poll.
    }
  }
  return promptAccepted ? 'accepted' : 'missing';
}

async function waitForKimiSubmissionState(
  resolveSessionFilePath: () => string | undefined,
  startOffset: number,
  timeoutMs: number,
  expectedPrompt?: string,
): Promise<KimiSubmissionState> {
  const deadline = Date.now() + timeoutMs;
  let latestState: KimiSubmissionState = 'missing';
  while (Date.now() <= deadline) {
    try {
      const sessionFilePath = resolveSessionFilePath();
      if (sessionFilePath) {
        latestState = inspectKimiSubmissionState(sessionFilePath, startOffset, expectedPrompt);
        if (latestState === 'started') return latestState;
      }
    } catch {
      // A fresh Kimi session may create wire.jsonl only after accepting input.
    }
    await sleep(50);
  }
  return latestState;
}

export async function sendKimiTmuxExplicitSteer(targetPane: string): Promise<void> {
  const steerDelayMs = parsePositiveIntEnv(
    'CODELARK_KIMI_TMUX_STEER_DELAY_MS',
    DEFAULT_KIMI_STEER_DELAY_MS,
    0,
  );
  if (steerDelayMs > 0) await sleep(steerDelayMs);
  await tmuxCore.sendActions(targetPane, [{ type: 'key', key: 'C-s' }]);
}

async function retryKimiSubmitKeys(sessionName: string, targetPane: string): Promise<void> {
  await sendRuntimeTmuxInput({
    runtime: 'kimi',
    sessionName,
    send: () => tmuxCore.sendActions(targetPane, [{ type: 'key', key: 'Enter' }]),
    steer: () => sendKimiTmuxExplicitSteer(targetPane),
  });
}

export async function retryKimiSubmitIfNoActivity(params: {
  sessionName: string;
  targetPane: string;
  sessionFilePath?: string;
  sessionId?: string;
  cwd?: string;
  startOffset: number;
  expectedPrompt?: string;
  retrySubmit?: () => Promise<void>;
}): Promise<boolean> {
  if (!params.sessionFilePath && !params.sessionId) return true;
  const resolveSessionFilePath = (): string | undefined => params.sessionFilePath
    || (params.sessionId ? findKimiSessionFileById(params.sessionId, params.cwd)?.filePath : undefined);
  const timeoutMs = parsePositiveIntEnv(
    'CODELARK_KIMI_TMUX_SUBMISSION_ACK_TIMEOUT_MS',
    DEFAULT_KIMI_SUBMISSION_ACK_TIMEOUT_MS,
    100,
  );
  const initialState = await waitForKimiSubmissionState(
    resolveSessionFilePath,
    params.startOffset,
    timeoutMs,
    params.expectedPrompt,
  );
  if (initialState === 'started') return true;
  console.warn('[kimi-tmux] Kimi input did not start a turn; retrying once:', {
    target_pane: params.targetPane,
    session_file: resolveSessionFilePath() || null,
    session_id: params.sessionId || null,
    start_offset: params.startOffset,
    submission_state: initialState,
    retry: initialState === 'missing' && params.retrySubmit ? 'full_input' : 'submit_keys',
  });
  if (initialState === 'missing' && params.retrySubmit) {
    await params.retrySubmit();
  } else {
    await retryKimiSubmitKeys(params.sessionName, params.targetPane);
  }
  let retryState = await waitForKimiSubmissionState(
    resolveSessionFilePath,
    params.startOffset,
    timeoutMs,
    params.expectedPrompt,
  );
  if (initialState === 'missing' && retryState === 'accepted') {
    console.warn('[kimi-tmux] Kimi prompt was recorded after full retry but the turn did not start; retrying submit keys:', {
      target_pane: params.targetPane,
      session_file: resolveSessionFilePath() || null,
      session_id: params.sessionId || null,
      start_offset: params.startOffset,
    });
    await retryKimiSubmitKeys(params.sessionName, params.targetPane);
    retryState = await waitForKimiSubmissionState(
      resolveSessionFilePath,
      params.startOffset,
      timeoutMs,
      params.expectedPrompt,
    );
  }
  if (retryState !== 'started') {
    console.warn('[kimi-tmux] Kimi input still did not start a turn after retry:', {
      target_pane: params.targetPane,
      session_file: resolveSessionFilePath() || null,
      session_id: params.sessionId || null,
      start_offset: params.startOffset,
      submission_state: retryState,
    });
  }
  return retryState === 'started';
}

async function waitForKimiSessionFileBySessionId(
  context: KimiTuiRunContext,
  options: { startAtEnd: boolean },
): Promise<void> {
  if (!context.sessionId) throw new Error('Kimi session id is required before locating wire.jsonl.');
  const timeoutMs = parsePositiveIntEnv(
    'CODELARK_KIMI_TMUX_SESSION_FILE_TIMEOUT_MS',
    DEFAULT_KIMI_SESSION_FILE_TIMEOUT_MS,
    1_000,
  );
  const pollIntervalMs = parsePositiveIntEnv(
    'CODELARK_KIMI_TMUX_POLL_INTERVAL_MS',
    DEFAULT_KIMI_POLL_INTERVAL_MS,
    50,
  );
  const startedAtMs = Date.now();
  while (Date.now() - startedAtMs <= timeoutMs) {
    if (resolveKimiSessionFileBySessionId(context, options.startAtEnd)) return;
    const capture = await tmuxCore.capturePane(context.targetPane, 160);
    context.lastScreen = capture.screen;
    assertKimiPaneAlive(capture.screen);
    await sleep(pollIntervalMs);
  }
  throw new Error(`Timed out waiting for Kimi session file for ${context.sessionId}.`);
}

async function waitForKimiInputReady(
  context: KimiTuiRunContext,
  options: { requireSessionHeader?: boolean } = {},
): Promise<void> {
  const timeoutMs = parsePositiveIntEnv(
    'CODELARK_KIMI_TMUX_INPUT_READY_TIMEOUT_MS',
    DEFAULT_KIMI_INPUT_READY_TIMEOUT_MS,
    1_000,
  );
  const pollIntervalMs = parsePositiveIntEnv(
    'CODELARK_KIMI_TMUX_POLL_INTERVAL_MS',
    DEFAULT_KIMI_POLL_INTERVAL_MS,
    50,
  );
  const stabilityMs = parsePositiveIntEnv(
    'CODELARK_KIMI_TMUX_INPUT_STABILITY_MS',
    DEFAULT_KIMI_INPUT_STABILITY_MS,
    0,
  );
  let deadline = Date.now() + timeoutMs;
  let lastTrustActionAt = 0;
  let lastScreen = context.lastScreen || '';
  const isReady = (screen: string): boolean => {
    const activeSessionId = parseKimiActiveSessionIdFromScreen(screen);
    if (activeSessionId && context.sessionId && activeSessionId !== context.sessionId) {
      throw new Error(`Kimi resumed unexpected session ${activeSessionId}; expected ${context.sessionId}.`);
    }
    return options.requireSessionHeader === false
      ? isKimiEditorReadyScreen(screen)
      : isKimiInputReadyScreen(screen, context.sessionId);
  };
  const remainsReady = async (): Promise<boolean> => {
    if (stabilityMs <= 0) return true;
    await sleep(stabilityMs);
    const capture = await tmuxCore.capturePane(context.targetPane, 160);
    lastScreen = capture.screen;
    context.lastScreen = lastScreen;
    assertKimiPaneAlive(lastScreen);
    return !isKimiWorkspaceTrustPrompt(lastScreen) && isReady(lastScreen);
  };
  if (
    !isKimiWorkspaceTrustPrompt(lastScreen)
    && isReady(lastScreen)
    && await remainsReady()
  ) return;
  while (Date.now() <= deadline) {
    const capture = await tmuxCore.capturePane(context.targetPane, 160);
    lastScreen = capture.screen;
    context.lastScreen = lastScreen;
    assertKimiPaneAlive(lastScreen);
    if (isKimiWorkspaceTrustPrompt(lastScreen)) {
      if (Date.now() - lastTrustActionAt >= 250) {
        await tmuxCore.sendActions(context.targetPane, [{ type: 'key', key: 'Enter' }]);
        lastTrustActionAt = Date.now();
        deadline = lastTrustActionAt + timeoutMs;
        console.log('[kimi-tmux] Confirmed Kimi workspace trust prompt:', context.targetPane);
      }
      await sleep(pollIntervalMs);
      continue;
    }
    if (isReady(lastScreen) && await remainsReady()) return;
    await sleep(pollIntervalMs);
  }
  const visibleTail = normalizeKimiScreenText(lastScreen)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-6)
    .join(' · ');
  throw new Error(`Timed out waiting for Kimi Code input readiness${visibleTail ? `: ${visibleTail}` : '.'}`);
}

async function waitForKimiInputReadyWithRelaunch(
  context: KimiTuiRunContext,
  params: StreamChatParams,
  options: { requireSessionHeader?: boolean } = {},
): Promise<boolean> {
  try {
    await waitForKimiInputReady(context, options);
    return false;
  } catch (error) {
    if (!isMissingTmuxServerError(error)) throw error;
    console.warn('[kimi-tmux] tmux server exited before Kimi input became ready; relaunching once:', {
      tmux_session: context.sessionName,
      error: error instanceof Error ? error.message : String(error),
    });
    await sleep(100);
    await launchTmuxKimiSession(context.sessionName, params);
    await ensureKimiTmuxInputKeys();
    context.lastScreen = '';
    if (!params.kimiSessionId) {
      context.sessionId = undefined;
      context.sessionFilePath = undefined;
      context.nextOffset = 0;
      await waitForKimiSessionIdFromTmux(context);
      resolveKimiSessionFileBySessionId(context, true);
    }
    await waitForKimiInputReady(context, options);
    return true;
  }
}

export function isKimiWorkspaceTrustPrompt(screenText: string): boolean {
  const normalized = normalizeKimiScreenText(screenText);
  return /Trust this folder/i.test(normalized)
    && /Enable project MCP servers/i.test(normalized)
    && /Don't trust/i.test(normalized);
}

export interface KimiTmuxInputSession {
  sessionName: string;
  targetPane: string;
  sessionId: string;
  cwd?: string;
  sessionFilePath?: string;
  nextOffset: number;
  existed: boolean;
}

/** Establishes the provider-owned Kimi process and validates input readiness. */
export async function ensureKimiTmuxInputSession(
  params: StreamChatParams,
  options: { recreate?: boolean } = {},
): Promise<KimiTmuxInputSession> {
  const sessionName = kimiTmuxSessionName(params.sessionId);
  const targetPane = `${sessionName}:0.0`;
  const knownSession = params.kimiSessionId
    ? findKimiSessionFileById(params.kimiSessionId, params.workingDirectory)
    : null;
  const context: KimiTuiRunContext = {
    sessionName,
    targetPane,
    bridgeSessionId: params.sessionId,
    sessionId: params.kimiSessionId,
    cwd: params.workingDirectory,
    sessionFilePath: knownSession?.filePath,
    nextOffset: knownSession?.filePath ? fs.statSync(knownSession.filePath).size : 0,
    nextLogOffset: 0,
    logTrailingText: '',
    trailingText: '',
    nextTurnId: null,
    nextSpecialCallIds: [],
    emittedToolStarts: new Set(),
    emittedRecordSignatures: new Set(),
    lastAssistantText: '',
    terminalSeen: false,
    hasError: false,
  };
  const inspection = await inspectRuntimeTmuxInput({
    runtime: 'kimi',
    sessionName,
    hasSession: () => tmuxCore.hasSession(sessionName),
  });
  let launched = !inspection.exists || options.recreate === true;
  const hasPersistedResumeIdentity = Boolean(context.sessionId && context.sessionFilePath);

  try {
    if (launched) {
      assertKimiLaunchAuthentication(params.model);
      await launchTmuxKimiSession(sessionName, params);
      launched = (await ensureKimiTmuxInputKeysWithRelaunch(sessionName, params)) || launched;
      if (!hasPersistedResumeIdentity) {
        await waitForKimiSessionIdFromTmux(context);
      }
    } else if (inspection.needsReadiness || !context.sessionId) {
      launched = (await ensureKimiTmuxInputKeysWithRelaunch(sessionName, params)) || launched;
      if (!hasPersistedResumeIdentity) {
        await waitForKimiSessionIdFromTmux(context);
      }
    }

    if (!context.sessionFilePath) resolveKimiSessionFileBySessionId(context, true);
    if (!context.sessionId) {
      throw new Error('Kimi tmux input lifecycle did not resolve a session id.');
    }
    launched = (await waitForKimiInputReadyWithRelaunch(context, params, {
      requireSessionHeader: !hasPersistedResumeIdentity,
    })) || launched;
    initializeKimiSessionLogCursor(context);
    transitionRuntimeTmuxInputState(
      'kimi',
      sessionName,
      'running',
      !launched
        ? 'existing Kimi tmux process and persisted runtime identity are reusable'
        : 'Kimi tmux process and runtime session are ready for input',
    );
    syncKimiTmuxTurnStateFromSession({
      sessionName,
      sessionId: context.sessionId,
      cwd: context.cwd,
      sessionFilePath: context.sessionFilePath,
      forceIdle: launched,
    });
    return {
      sessionName,
      targetPane,
      sessionId: context.sessionId,
      ...(context.cwd ? { cwd: context.cwd } : {}),
      ...(context.sessionFilePath ? { sessionFilePath: context.sessionFilePath } : {}),
      nextOffset: context.nextOffset,
      existed: inspection.exists,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    transitionRuntimeTmuxInputState(
      'kimi',
      sessionName,
      'failed',
      'Kimi tmux preparation failed',
      { error: message },
    );
    throw error;
  }
}

export async function restartKimiTmuxInputSession(
  params: StreamChatParams,
): Promise<KimiTmuxInputSession> {
  return ensureKimiTmuxInputSession(params, { recreate: true });
}

export function streamKimiTmuxTui(params: StreamChatParams): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      (async () => {
        const sessionName = kimiTmuxSessionName(params.sessionId);
        const targetPane = `${sessionName}:0.0`;
        const context: KimiTuiRunContext = {
          sessionName,
          targetPane,
          bridgeSessionId: params.sessionId,
          sessionId: params.kimiSessionId,
          cwd: params.workingDirectory,
          sessionFilePath: params.kimiSessionId
            ? findKimiSessionFileById(params.kimiSessionId, params.workingDirectory)?.filePath
            : undefined,
          nextOffset: 0,
          nextLogOffset: 0,
          logTrailingText: '',
          trailingText: '',
          nextTurnId: null,
          nextSpecialCallIds: [],
          emittedToolStarts: new Set(),
          emittedRecordSignatures: new Set(),
          lastAssistantText: '',
          terminalSeen: false,
          hasError: false,
        };

        let lifecycleFailed = false;
        try {
          controller.enqueue(sseEvent('status', {
            reasoning: params.kimiSessionId
              ? '正在确认 Kimi tmux 和当前 Kimi session。'
              : '正在初始化 Kimi tmux 和 Kimi session。',
          }));
          const prepared = await ensureKimiTmuxInputSession(params);
          context.sessionId = prepared.sessionId;
          context.cwd = prepared.cwd;
          context.sessionFilePath = prepared.sessionFilePath;
          context.nextOffset = prepared.nextOffset;
          initializeKimiSessionLogCursor(context);
          controller.enqueue(sseEvent('status', {
            session_id: context.sessionId,
            ...(context.cwd ? { cwd: context.cwd } : {}),
          }));

          const promptDelayMs = parsePositiveIntEnv('CODELARK_KIMI_TMUX_PROMPT_DELAY_MS', DEFAULT_KIMI_PROMPT_DELAY_MS, 0);
          if (promptDelayMs > 0) await sleep(promptDelayMs);
          const submitPrompt = () => sendRuntimeTmuxInput({
            runtime: 'kimi',
            sessionName,
            send: () => tmuxCore.injectPromptIntoPane(targetPane, params.prompt),
            steer: () => sendKimiTmuxExplicitSteer(targetPane),
          });
          await submitPrompt();

          const accepted = await retryKimiSubmitIfNoActivity({
            sessionName,
            targetPane,
            sessionFilePath: context.sessionFilePath,
            sessionId: context.sessionId,
            cwd: context.cwd,
            startOffset: context.nextOffset,
            expectedPrompt: params.prompt,
            retrySubmit: () => submitPrompt().then(() => undefined),
          });
          if (!accepted) {
            throw new Error('Kimi Code input was not recorded after retrying the full prompt.');
          }

          if (!context.sessionFilePath) {
            await waitForKimiSessionFileBySessionId(context, { startAtEnd: false });
            initializeKimiSessionLogCursor(context);
          }

          await pollKimiSessionFile(
            controller,
            context,
            async () => (await tmuxCore.hasSession(context.sessionName)).exists,
          );
          controller.close();
        } catch (error) {
          lifecycleFailed = true;
          const message = error instanceof Error ? error.message : String(error);
          transitionRuntimeTmuxInputState(
            'kimi',
            sessionName,
            'failed',
            'Kimi tmux input lifecycle failed',
            { error: message },
          );
          console.error('[kimi-tmux] Error:', error instanceof Error ? error.stack || error.message : error);
          try {
            controller.enqueue(sseEvent('error', message || 'Kimi TUI execution failed.'));
            controller.close();
          } catch {
            // Controller may already be closed.
          }
        } finally {
          if (lifecycleFailed && !isDebugTmuxKeepAlive()) {
            try {
              await tmuxCore.killSession(sessionName, { ignoreMissing: true });
              transitionRuntimeTmuxInputState(
                'kimi',
                sessionName,
                'failed',
                'failed Kimi lifecycle was cleaned up so the next input can recover',
              );
            } catch (error) {
              transitionRuntimeTmuxInputState(
                'kimi',
                sessionName,
                'failed',
                'Kimi turn completed but tmux cleanup failed',
                { error: error instanceof Error ? error.message : String(error) },
              );
            }
          } else if (!lifecycleFailed) {
            console.log(`[kimi-tmux] Provider-owned tmux session remains reusable: ${sessionName}`);
          }
        }
      })();
    },
  });
}

export class KimiTmuxProvider implements LLMProvider {
  streamChat(params: StreamChatParams): ReadableStream<string> {
    return streamKimiTmuxTui(params);
  }
}
