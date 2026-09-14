import fs from 'node:fs';
import path from 'node:path';
import type { ClaudeExecutable } from '../options.js';
import { buildStandardLarkCliEnv } from '../../shared/lark-cli-env.js';
import type { LLMProvider, StreamChatParams } from '../contracts.js';
import { sseEvent } from '../sse.js';
import {
  parseClaudeCodeRouterActivateEnv,
  parseClaudeCodeRouterStatus,
  prepareClaudeCodeRouterEnv,
} from './code-router.js';
import { resolveClaudeCliExecutable } from '../../runtime/codex/cli-executable.js';
import {
  getClaudeSessionJsonlById,
  listClaudeSessionJsonlFiles,
  summarizeClaudeSessionJsonl,
  type ClaudeSessionJsonlSummary,
} from './session-jsonl.js';
import {
  compactTerminalScreenText,
  hasTuiEnterConfirmFooter,
  hasTuiEnterContinueFooter,
  normalizeTerminalScreenText,
} from '../tui-screen.js';

const DEFAULT_PROMPT_DELAY_MS = 1_000;
const DEFAULT_SUBMIT_DELAY_MS = 75;
const DEFAULT_TRUST_PROMPT_TIMEOUT_MS = 5_000;
const DEFAULT_AFTER_TRUST_DELAY_MS = 2_500;
const DEFAULT_INPUT_READY_TIMEOUT_MS = 10_000;
const DEFAULT_JSONL_DISCOVERY_TIMEOUT_MS = 2_500;
const DEFAULT_RESPONSE_QUIET_MS = 1_500;
const DEFAULT_RESPONSE_TIMEOUT_MS = 45_000;
const MAX_SCREEN_BUFFER_CHARS = 200_000;
const FILE_MTIME_SKEW_MS = 250;

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

interface ClaudePtySession {
  child: PtyProcess;
  executable: ClaudeExecutable;
  claudeSessionId?: string;
  cwd: string;
  model?: string;
  permissionMode?: string;
  reasoningEffort?: string;
  buffer: string;
  startedAtMs: number;
  updatedAtMs: number;
  exited: boolean;
  exitEvent?: PtyExitEvent;
}

const claudePtySessions = new Map<string, ClaudePtySession>();

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parsePositiveIntEnv(name: string, fallback: number, minValue: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed >= minValue) return Math.floor(parsed);
  return fallback;
}

function normalizePtyOutput(text: string): string {
  return normalizeTerminalScreenText(text);
}

function compactScreenText(text: string): string {
  return compactTerminalScreenText(text);
}

export function hasClaudePtyTrustPrompt(text: string): boolean {
  if (hasClaudePtyBypassPermissionsPrompt(text)) return false;
  const compact = compactScreenText(text);
  return compact.includes('quicksafetycheck')
    || compact.includes('yes,itrustthisfolder')
    || compact.includes('claudecode\'llbeabletoread,edit,andexecutefileshere')
    || hasTuiEnterConfirmFooter(text);
}

export type ClaudeTrustPromptKey = 'Up' | 'Down' | 'Enter';

function buildClaudeAffirmativePromptKeys(
  text: string,
  choicePattern: RegExp,
  affirmativePattern: RegExp,
): ClaudeTrustPromptKey[] | null {
  const normalized = normalizePtyOutput(text).replace(/\r/g, '');
  const choices = normalized
    .split('\n')
    .map((line) => ({
      line,
      selected: /^\s*[❯›>]\s*/u.test(line),
    }))
    .filter(({ line }) => choicePattern.test(line));
  const selectedIndex = choices.findIndex((choice) => choice.selected);
  const affirmativeIndex = choices.findIndex((choice) => affirmativePattern.test(choice.line));
  if (selectedIndex < 0 || affirmativeIndex < 0) return null;
  const direction: ClaudeTrustPromptKey = affirmativeIndex < selectedIndex ? 'Up' : 'Down';
  return [
    ...Array.from({ length: Math.abs(affirmativeIndex - selectedIndex) }, () => direction),
    'Enter',
  ];
}

export function buildClaudeTrustPromptKeys(text: string): ClaudeTrustPromptKey[] | null {
  return buildClaudeAffirmativePromptKeys(
    text,
    /yes,?\s+i trust this folder|no,?\s+(?:continue without these permissions|exit!?)/i,
    /yes,?\s+i trust this folder/i,
  );
}

export function hasClaudePtyBypassPermissionsPrompt(text: string): boolean {
  const compact = compactScreenText(text);
  return compact.includes('claudecoderunninginbypasspermissionsmode')
    && compact.includes('yes,iaccept')
    && hasTuiEnterConfirmFooter(text);
}

export function buildClaudeBypassPermissionsPromptKeys(text: string): ClaudeTrustPromptKey[] | null {
  return buildClaudeAffirmativePromptKeys(
    text,
    /no,?\s+exit!?|yes,?\s+i accept/i,
    /yes,?\s+i accept/i,
  );
}

export function hasClaudePtyOnboardingPrompt(text: string): boolean {
  const compact = compactScreenText(text);
  const hasWelcomeContinue = (
    compact.includes('welcometoclaudecode')
    || compact.includes('securitynotes:')
    || compact.includes('securitynotes')
  ) && (
    hasTuiEnterContinueFooter(text)
  );
  const hasThemeSelection = compact.includes('syntaxtheme')
    && (compact.includes('darkmode') || compact.includes('lightmode') || compact.includes('colorblind'));
  return hasWelcomeContinue || hasThemeSelection;
}

export function hasClaudePtyInputPrompt(text: string): boolean {
  if (
    hasClaudePtyOnboardingPrompt(text)
    || hasClaudePtyBypassPermissionsPrompt(text)
    || hasClaudePtyTrustPrompt(text)
  ) return false;
  const compact = compactScreenText(text);
  return text.includes('❯') && (
    compact.includes('forshortcuts')
    || compact.includes('/effort')
  );
}

function appendScreen(sessionId: string, data: string): void {
  const session = claudePtySessions.get(sessionId);
  if (!session) return;
  session.buffer += normalizePtyOutput(data);
  if (session.buffer.length > MAX_SCREEN_BUFFER_CHARS) {
    session.buffer = session.buffer.slice(-MAX_SCREEN_BUFFER_CHARS);
  }
  session.updatedAtMs = Date.now();
}

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
        'Claude pty provider 需要可用的 node pty 运行时，但当前安装未能加载。',
        '请重新安装 codelark 依赖，或先切回 Codex runtime。',
        `原始错误：${detail}`,
      ].join('\n'));
    }
  }
}

export function buildClaudePtyCommand(
  executable: ClaudeExecutable,
  options: {
    claudeSessionId?: string;
    model?: string;
    permissionMode?: string;
    reasoningEffort?: string;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    fileExists?: (filePath: string) => boolean;
    requireInstalled?: boolean;
  } = {},
): { command: string; args: string[] } {
  const args = executable === 'ccr' ? ['code'] : [];
  const claudeSessionId = options.claudeSessionId?.trim();
  if (claudeSessionId) {
    args.push('--resume', claudeSessionId);
  }
  const model = options.model?.trim();
  if (model) {
    args.push('--model', model);
  }
  const permissionMode = options.permissionMode?.trim();
  if (permissionMode && permissionMode !== 'default') {
    args.push('--permission-mode', permissionMode);
  }
  const reasoningEffort = options.reasoningEffort?.trim();
  if (reasoningEffort) {
    args.push('--effort', reasoningEffort);
  }
  if (executable === 'ccr') {
    return {
      command: resolveClaudeCliExecutable('ccr', options),
      args,
    };
  }
  return {
    command: resolveClaudeCliExecutable('claude', options),
    args,
  };
}

export function buildClaudePtyEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(buildStandardLarkCliEnv())) {
    if (value !== undefined) env[key] = value;
  }
  env.TERM = env.TERM || 'xterm-256color';
  return env;
}

async function waitForClaudePtyBuffer(
  session: ClaudePtySession,
  predicate: (buffer: string) => boolean,
  timeoutMs: number,
  intervalMs = 100,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !session.exited) {
    if (predicate(session.buffer)) return true;
    await sleep(intervalMs);
  }
  return predicate(session.buffer);
}

export function findLatestClaudeSessionJsonlUpdatedAfter(
  cwd: string,
  sinceMs: number,
  expectedSessionId?: string,
): ClaudeSessionJsonlSummary | null {
  if (expectedSessionId) {
    const expected = getClaudeSessionJsonlById(expectedSessionId, cwd);
    if (!expected) return null;
    try {
      return fs.statSync(expected.filePath).mtimeMs + FILE_MTIME_SKEW_MS >= sinceMs ? expected : null;
    } catch {
      return null;
    }
  }
  const candidates: Array<{ mtimeMs: number; summary: ClaudeSessionJsonlSummary }> = [];
  for (const filePath of listClaudeSessionJsonlFiles(cwd)) {
    try {
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs + FILE_MTIME_SKEW_MS < sinceMs) continue;
      const summary = summarizeClaudeSessionJsonl(filePath);
      if (summary) candidates.push({ mtimeMs: stat.mtimeMs, summary });
    } catch {
      // Ignore files that disappear while Claude Code is writing.
    }
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates[0]?.summary || null;
}

export async function waitForClaudeSessionJsonlUpdatedAfter(
  cwd: string,
  sinceMs: number,
  expectedSessionId?: string,
): Promise<ClaudeSessionJsonlSummary | null> {
  const timeoutMs = parsePositiveIntEnv(
    'CODELARK_CLAUDE_PTY_JSONL_DISCOVERY_TIMEOUT_MS',
    DEFAULT_JSONL_DISCOVERY_TIMEOUT_MS,
    0,
  );
  const deadline = Date.now() + timeoutMs;
  do {
    const session = findLatestClaudeSessionJsonlUpdatedAfter(cwd, sinceMs, expectedSessionId);
    if (session) return session;
    if (timeoutMs <= 0) break;
    await sleep(100);
  } while (Date.now() < deadline);
  return null;
}

async function prepareClaudePtyForPrompt(session: ClaudePtySession): Promise<void> {
  const trustPromptTimeoutMs = parsePositiveIntEnv(
    'CODELARK_CLAUDE_PTY_TRUST_PROMPT_TIMEOUT_MS',
    DEFAULT_TRUST_PROMPT_TIMEOUT_MS,
    0,
  );
  const inputReadyTimeoutMs = parsePositiveIntEnv(
    'CODELARK_CLAUDE_PTY_INPUT_READY_TIMEOUT_MS',
    DEFAULT_INPUT_READY_TIMEOUT_MS,
    0,
  );
  const afterTrustDelayMs = parsePositiveIntEnv(
    'CODELARK_CLAUDE_PTY_AFTER_TRUST_DELAY_MS',
    DEFAULT_AFTER_TRUST_DELAY_MS,
    0,
  );
  const setupPromptTimeoutMs = Math.max(trustPromptTimeoutMs, inputReadyTimeoutMs);
  const setupPromptDeadlineMs = Date.now() + setupPromptTimeoutMs;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (hasClaudePtyInputPrompt(session.buffer)) break;
    const remainingMs = setupPromptDeadlineMs - Date.now();
    const sawSetupPrompt = remainingMs > 0
      ? await waitForClaudePtyBuffer(
        session,
        (buffer) => hasClaudePtyInputPrompt(buffer)
          || hasClaudePtyBypassPermissionsPrompt(buffer)
          || hasClaudePtyTrustPrompt(buffer)
          || hasClaudePtyOnboardingPrompt(buffer),
        remainingMs,
      )
      : hasClaudePtyBypassPermissionsPrompt(session.buffer)
        || hasClaudePtyTrustPrompt(session.buffer)
        || hasClaudePtyOnboardingPrompt(session.buffer);
    if (!sawSetupPrompt || hasClaudePtyInputPrompt(session.buffer)) break;
    if (hasClaudePtyOnboardingPrompt(session.buffer)) {
      console.log('[claude-pty] Claude Code first-run onboarding detected; continuing before prompt injection');
      session.buffer = '';
      session.child.write('\r');
      if (afterTrustDelayMs > 0) await sleep(afterTrustDelayMs);
      continue;
    }
    if (hasClaudePtyBypassPermissionsPrompt(session.buffer)) {
      const bypassKeys = buildClaudeBypassPermissionsPromptKeys(session.buffer);
      if (!bypassKeys) {
        throw new Error('Claude Code bypass-permissions warning was detected, but the affirmative choice could not be identified safely.');
      }
      console.log('[claude-pty] Claude Code bypass-permissions warning detected; selecting acceptance before prompt injection');
      session.buffer = '';
      for (const key of bypassKeys) {
        session.child.write(key === 'Up' ? '\x1b[A' : key === 'Down' ? '\x1b[B' : '\r');
      }
      if (afterTrustDelayMs > 0) await sleep(afterTrustDelayMs);
      continue;
    }
    if (hasClaudePtyTrustPrompt(session.buffer)) {
      const trustKeys = buildClaudeTrustPromptKeys(session.buffer);
      if (!trustKeys) {
        throw new Error('Claude Code trust prompt was detected, but the selected choice could not be identified safely.');
      }
      console.log('[claude-pty] Claude Code trust prompt detected; selecting trusted workspace before prompt injection');
      session.buffer = '';
      for (const key of trustKeys) {
        session.child.write(key === 'Up' ? '\x1b[A' : key === 'Down' ? '\x1b[B' : '\r');
      }
      if (afterTrustDelayMs > 0) await sleep(afterTrustDelayMs);
      continue;
    }
    break;
  }

  if (hasClaudePtyOnboardingPrompt(session.buffer)) {
    console.log('[claude-pty] Claude Code setup prompt remained after auto-confirm attempts; sending one final confirm before prompt injection');
    session.buffer = '';
    session.child.write('\r');
    if (afterTrustDelayMs > 0) await sleep(afterTrustDelayMs);
  }

  if (inputReadyTimeoutMs > 0) {
    await waitForClaudePtyBuffer(session, hasClaudePtyInputPrompt, inputReadyTimeoutMs);
  }
}

async function writePrompt(child: PtyProcess, prompt: string): Promise<void> {
  const lines = prompt.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    child.write(lines[i] || '');
    if (i < lines.length - 1) {
      child.write('\x1b\r');
      await sleep(25);
    }
  }
  const submitDelayMs = parsePositiveIntEnv('CODELARK_CLAUDE_PTY_SUBMIT_DELAY_MS', DEFAULT_SUBMIT_DELAY_MS, 0);
  if (submitDelayMs > 0) await sleep(submitDelayMs);
  child.write('\r');
}

export async function injectPromptIntoClaudePtySession(sessionId: string, prompt: string): Promise<boolean> {
  const session = claudePtySessions.get(sessionId);
  if (!session || session.exited) return false;
  await prepareClaudePtyForPrompt(session);
  await writePrompt(session.child, prompt);
  return true;
}

async function getOrCreateSession(
  params: StreamChatParams,
  controller?: ReadableStreamDefaultController<string>,
): Promise<ClaudePtySession> {
  const executable = params.claudeExecutable || 'claude';
  const claudeSessionId = params.claudeSessionId?.trim() || undefined;
  const cwd = params.workingDirectory || process.cwd();
  const model = params.model?.trim() || undefined;
  const permissionMode = params.claudePermissionMode?.trim() || undefined;
  const reasoningEffort = params.claudeReasoningEffort?.trim() || undefined;
  const existing = claudePtySessions.get(params.sessionId);
  if (
    existing
    && !existing.exited
    && existing.executable === executable
    && existing.claudeSessionId === claudeSessionId
    && existing.cwd === cwd
    && existing.model === model
    && existing.permissionMode === permissionMode
    && existing.reasoningEffort === reasoningEffort
  ) {
    return existing;
  }
  if (existing && !existing.exited) {
    try { existing.child.kill(); } catch { /* best-effort cleanup */ }
  }

  const pty = await loadPtyModule();
  const baseEnv = buildClaudePtyEnv();
  const { command, args } = buildClaudePtyCommand(executable, {
    claudeSessionId,
    model,
    permissionMode,
    reasoningEffort,
    env: baseEnv,
  });
  const env = executable === 'ccr'
    ? await prepareClaudeCodeRouterEnv(command, baseEnv, { controller, logPrefix: '[claude-pty]' })
    : baseEnv;
  console.log('[claude-pty] Claude Code TUI start:', {
    bridge_session_id: params.sessionId,
    command,
    args,
    cwd,
    executable,
  });
  const child = pty.spawn(command, args, {
    name: env.TERM || 'xterm-256color',
    cols: 100,
    rows: 30,
    cwd,
    env,
  });
  const session: ClaudePtySession = {
    child,
    executable,
    claudeSessionId,
    cwd,
    model,
    permissionMode,
    reasoningEffort,
    buffer: '',
    startedAtMs: Date.now(),
    updatedAtMs: Date.now(),
    exited: false,
  };
  claudePtySessions.set(params.sessionId, session);
  child.onData((data) => appendScreen(params.sessionId, data));
  child.onExit((event) => {
    session.exited = true;
    session.exitEvent = event;
    session.updatedAtMs = Date.now();
    console.log('[claude-pty] Claude Code TUI exited:', event);
  });
  return session;
}

function tailScreen(text: string): string {
  return text.replace(/\s+$/g, '').split('\n').slice(-80).join('\n');
}

function tailLines(text: string, lines: number): string {
  const trimmed = text.replace(/\s+$/g, '');
  if (lines <= 0) return trimmed;
  return trimmed.split('\n').slice(-lines).join('\n');
}

export interface ClaudePtyScreenSnapshot {
  sessionId: string;
  executable: ClaudeExecutable;
  cwd: string;
  startedAt: string;
  updatedAt: string;
  exited: boolean;
  exitCode?: number;
  signal?: number;
  screen: string;
}

export function captureClaudePtyScreen(sessionId: string, lines = 0): ClaudePtyScreenSnapshot | null {
  const session = claudePtySessions.get(sessionId);
  if (!session) return null;
  return {
    sessionId,
    executable: session.executable,
    cwd: session.cwd,
    startedAt: new Date(session.startedAtMs).toISOString(),
    updatedAt: new Date(session.updatedAtMs).toISOString(),
    exited: session.exited,
    exitCode: session.exitEvent?.exitCode,
    signal: session.exitEvent?.signal,
    screen: tailLines(session.buffer, lines),
  };
}

async function waitForQuietScreen(session: ClaudePtySession): Promise<string> {
  const quietMs = parsePositiveIntEnv('CODELARK_CLAUDE_PTY_RESPONSE_QUIET_MS', DEFAULT_RESPONSE_QUIET_MS, 250);
  const timeoutMs = parsePositiveIntEnv('CODELARK_CLAUDE_PTY_RESPONSE_TIMEOUT_MS', DEFAULT_RESPONSE_TIMEOUT_MS, 1_000);
  const deadline = Date.now() + timeoutMs;
  let lastLength = session.buffer.length;
  let quietSince = Date.now();
  while (Date.now() < deadline && !session.exited) {
    await sleep(100);
    if (session.buffer.length !== lastLength) {
      lastLength = session.buffer.length;
      quietSince = Date.now();
      continue;
    }
    if (Date.now() - quietSince >= quietMs) break;
  }
  return tailScreen(session.buffer);
}

export function streamClaudePtyTui(params: StreamChatParams): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      (async () => {
        let session: ClaudePtySession | null = null;
        const abortListener = () => {
          if (!session || session.exited) return;
          try { session.child.write('\x03'); } catch { /* best-effort interrupt */ }
        };
        try {
          session = await getOrCreateSession(params, controller);
          params.abortController?.signal.addEventListener('abort', abortListener, { once: true });
          await prepareClaudePtyForPrompt(session);
          const promptDelayMs = parsePositiveIntEnv('CODELARK_CLAUDE_PTY_PROMPT_DELAY_MS', DEFAULT_PROMPT_DELAY_MS, 0);
          if (promptDelayMs > 0) await sleep(promptDelayMs);
          const promptStartedAtMs = Date.now();
          await writePrompt(session.child, params.prompt);
          const startedClaudeJsonlSession = await waitForClaudeSessionJsonlUpdatedAfter(
            session.cwd,
            promptStartedAtMs,
            params.claudeSessionId,
          );
          if (startedClaudeJsonlSession) {
            session.claudeSessionId = startedClaudeJsonlSession.sessionId;
            controller.enqueue(sseEvent('status', {
              session_id: startedClaudeJsonlSession.sessionId,
              cwd: startedClaudeJsonlSession.cwd || session.cwd,
              transcript_path: startedClaudeJsonlSession.filePath,
            }));
          }
          const screen = await waitForQuietScreen(session);
          const claudeJsonlSession = findLatestClaudeSessionJsonlUpdatedAfter(
            session.cwd,
            promptStartedAtMs,
            session.claudeSessionId,
          ) || await waitForClaudeSessionJsonlUpdatedAfter(
            session.cwd,
            promptStartedAtMs,
            session.claudeSessionId,
          );
          if (claudeJsonlSession) session.claudeSessionId = claudeJsonlSession.sessionId;
          controller.enqueue(sseEvent('text', screen || '(Claude Code TUI has not produced visible output yet.)'));
          controller.enqueue(sseEvent('result', {
            ...(claudeJsonlSession?.sessionId || params.claudeSessionId
              ? { session_id: claudeJsonlSession?.sessionId || params.claudeSessionId }
              : {}),
            ...(claudeJsonlSession?.cwd || params.claudeSessionId ? { cwd: claudeJsonlSession?.cwd || session.cwd } : {}),
            ...(claudeJsonlSession?.filePath ? { transcript_path: claudeJsonlSession.filePath } : {}),
          }));
          controller.close();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error('[claude-pty] Error:', error instanceof Error ? error.stack || error.message : error);
          try {
            controller.enqueue(sseEvent('error', message || 'Claude pty execution failed.'));
            controller.close();
          } catch {
            // Controller may already be closed.
          }
        } finally {
          params.abortController?.signal.removeEventListener('abort', abortListener);
        }
      })();
    },
  });
}

export class ClaudePtyProvider implements LLMProvider {
  streamChat(params: StreamChatParams): ReadableStream<string> {
    return streamClaudePtyTui(params);
  }
}

export const _testOnlyClaudePty = {
  buildClaudePtyCommand,
  captureClaudePtyScreen,
  injectPromptIntoClaudePtySession,
  registerSession: (sessionId: string, session: any) => {
    claudePtySessions.set(sessionId, {
      child: session.child,
      executable: session.executable || 'claude',
      cwd: session.cwd || process.cwd(),
      model: session.model,
      permissionMode: session.permissionMode,
      reasoningEffort: session.reasoningEffort,
      buffer: session.buffer || '',
      startedAtMs: session.startedAtMs || Date.now(),
      updatedAtMs: session.updatedAtMs || Date.now(),
      exited: session.exited === true,
      exitEvent: session.exitEvent,
    });
  },
  hasClaudePtyInputPrompt,
  hasClaudePtyBypassPermissionsPrompt,
  hasClaudePtyOnboardingPrompt,
  hasClaudePtyTrustPrompt,
  prepareClaudePtyForPrompt,
  findLatestClaudeSessionJsonlUpdatedAfter,
  parseClaudeCodeRouterActivateEnv,
  parseClaudeCodeRouterStatus,
  clear: () => {
    for (const session of claudePtySessions.values()) {
      if (!session.exited) {
        try { session.child.kill(); } catch { /* best-effort cleanup */ }
      }
    }
    claudePtySessions.clear();
  },
  count: () => claudePtySessions.size,
};
