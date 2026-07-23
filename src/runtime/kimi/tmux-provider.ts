import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { LLMProvider, StreamChatParams, BridgeMirrorRecord } from '../contracts.js';
import { sseEvent } from '../sse.js';
import { tmuxCore } from '../../bridge/tmux/core.js';
import {
  sendRuntimeTmuxInput,
  transitionRuntimeTmuxInputState,
} from '../../bridge/tmux/input-state-machine.js';
import {
  findKimiSessionFileById,
  readKimiSessionMirrorRecordDeltaByFilePath,
} from './session-index.js';

const DEFAULT_KIMI_POLL_INTERVAL_MS = 500;
const DEFAULT_KIMI_SESSION_FILE_TIMEOUT_MS = 30_000;
const DEFAULT_KIMI_PROMPT_DELAY_MS = 800;
const DEFAULT_KIMI_SESSION_ID_TIMEOUT_MS = 30_000;

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

function kimiCommandEnvironmentPrefix(): string {
  const assignments = [
    ['KIMI_CODE_HOME', process.env.KIMI_CODE_HOME],
  ]
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([key, value]) => `${key}=${shellQuote(value)}`);
  return assignments.length > 0 ? `${assignments.join(' ')} ` : '';
}

export function parseKimiSessionIdFromScreen(screenText: string): string | null {
  const normalized = screenText
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
  const resumeMatch = normalized.match(/To\s+resume\s+this\s+session:\s*kimi\s+-r\s+(session_[A-Za-z0-9-]+)/i);
  if (resumeMatch?.[1]) return resumeMatch[1];
  const headerMatch = normalized.match(/\bSession:\s*(session_[A-Za-z0-9-]+)/i);
  return headerMatch?.[1] || null;
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
  nextOffset: number;
  trailingText: string;
  nextTurnId: string | null;
  nextSpecialCallIds: string[];
  emittedToolStarts: Set<string>;
  emittedRecordSignatures: Set<string>;
  lastAssistantText: string;
  terminalSeen: boolean;
  hasError: boolean;
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
      controller.enqueue(sseEvent('result', {
        ...(context.sessionId ? { session_id: context.sessionId } : {}),
        ...(context.cwd ? { cwd: context.cwd } : {}),
      }));
      break;

    case 'task_aborted':
      context.terminalSeen = true;
      context.hasError = true;
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
  const sessionFileTimeoutMs = parsePositiveIntEnv(
    'CODELARK_KIMI_TMUX_SESSION_FILE_TIMEOUT_MS',
    DEFAULT_KIMI_SESSION_FILE_TIMEOUT_MS,
    1_000,
  );

  let sessionFileResolvedAtMs = context.sessionFilePath ? Date.now() : 0;

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
      if (delta.records.length > 0) {
        sessionFileResolvedAtMs = Date.now();
      }
    }

    if (context.terminalSeen) break;

    const alive = await isTerminalAlive();
    if (!alive) {
      if (!context.hasError) {
        controller.enqueue(sseEvent('result', {
          ...(context.sessionId ? { session_id: context.sessionId } : {}),
          ...(context.cwd ? { cwd: context.cwd } : {}),
        }));
      }
      break;
    }

    if (context.sessionFilePath && Date.now() - sessionFileResolvedAtMs > sessionFileTimeoutMs) {
      // Session file has gone stale while process is still alive; bail out.
      console.warn('[kimi-tmux] Session file stale; terminating poll.');
      controller.enqueue(sseEvent('result', {
        ...(context.sessionId ? { session_id: context.sessionId } : {}),
        ...(context.cwd ? { cwd: context.cwd } : {}),
      }));
      break;
    }

    await sleep(pollIntervalMs);
  }
}

function buildKimiArgs(params: StreamChatParams): string[] {
  const args: string[] = [];
  if (params.kimiSessionId) {
    args.push('-r', params.kimiSessionId);
  }
  args.push('-y');
  if (params.model) {
    args.push('-m', params.model);
  }
  return args;
}

async function launchTmuxKimiSession(
  sessionName: string,
  params: StreamChatParams,
): Promise<void> {
  const executable = resolveKimiCliExecutable();
  const args = buildKimiArgs(params);
  const command = `${kimiCommandEnvironmentPrefix()}${commandPreview(executable, args)}`;

  console.log('[kimi-tmux] Kimi TUI start:', {
    bridge_session_id: params.sessionId,
    tmux_session: sessionName,
    command,
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
    command,
    recreate: true,
  });
}

async function waitForKimiSessionIdFromTmux(context: KimiTuiRunContext): Promise<string> {
  if (context.sessionId) return context.sessionId;
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
  const startedAtMs = Date.now();
  while (Date.now() - startedAtMs <= timeoutMs) {
    const capture = await tmuxCore.capturePane(context.targetPane, 160);
    const parsed = parseKimiSessionIdFromScreen(capture.screen);
    if (parsed) {
      context.sessionId = parsed;
      return parsed;
    }
    await sleep(pollIntervalMs);
  }
  throw new Error('Timed out waiting for Kimi to print its session id.');
}

async function waitForKimiSessionIdOnScreen(
  context: KimiTuiRunContext,
  timeoutMs: number,
): Promise<string | null> {
  if (context.sessionId) return context.sessionId;
  const pollIntervalMs = parsePositiveIntEnv(
    'CODELARK_KIMI_TMUX_POLL_INTERVAL_MS',
    DEFAULT_KIMI_POLL_INTERVAL_MS,
    50,
  );
  const startedAtMs = Date.now();
  while (Date.now() - startedAtMs <= timeoutMs) {
    const capture = await tmuxCore.capturePane(context.targetPane, 160);
    const parsed = parseKimiSessionIdFromScreen(capture.screen);
    if (parsed) {
      context.sessionId = parsed;
      return parsed;
    }
    await sleep(pollIntervalMs);
  }
  return null;
}

async function waitForKimiSessionFileBySessionId(context: KimiTuiRunContext): Promise<void> {
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
    const summary = findKimiSessionFileById(context.sessionId, context.cwd);
    if (summary?.filePath) {
      context.sessionFilePath = summary.filePath;
      context.sessionId = summary.sessionId;
      context.nextOffset = fs.statSync(summary.filePath).size;
      console.log('[kimi-tmux] Session file resolved:', {
        session_id: context.sessionId,
        file_path: context.sessionFilePath,
        start_offset: context.nextOffset,
      });
      return;
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(`Timed out waiting for Kimi session file for ${context.sessionId}.`);
}

async function captureKimiResumeHint(
  context: KimiTuiRunContext,
  options: { requireKnownSession?: boolean } = {},
): Promise<void> {
  const requireKnownSession = options.requireKnownSession !== false;
  if ((requireKnownSession && !context.sessionId) || isDebugTmuxKeepAlive()) return;
  try {
    await tmuxCore.sendActions(context.targetPane, [
      { type: 'key', key: 'C-c' },
      { type: 'key', key: 'C-c' },
    ], { delayMs: 150 });
    await sleep(500);
    const capture = await tmuxCore.capturePane(context.targetPane, 160);
    const parsed = parseKimiSessionIdFromScreen(capture.screen);
    if (parsed) context.sessionId = parsed;
  } catch (error) {
    console.warn('[kimi-tmux] Failed to capture Kimi resume hint:', error);
  }
}

async function initializeFreshKimiSessionFromResumeHint(
  context: KimiTuiRunContext,
  params: StreamChatParams,
): Promise<void> {
  transitionRuntimeTmuxInputState(
    'kimi',
    context.sessionName,
    'starting_session',
    'discovering and resuming a fresh Kimi session before input',
  );
  const timeoutMs = parsePositiveIntEnv(
    'CODELARK_KIMI_TMUX_SESSION_ID_TIMEOUT_MS',
    DEFAULT_KIMI_SESSION_ID_TIMEOUT_MS,
    1_000,
  );
  const fastPathMs = Math.min(timeoutMs, 1_500);
  const directSessionId = await waitForKimiSessionIdOnScreen(context, fastPathMs);
  if (directSessionId) return;

  await captureKimiResumeHint(context, { requireKnownSession: false });
  if (!context.sessionId) {
    throw new Error('Timed out waiting for Kimi to print its resume session id.');
  }

  await launchTmuxKimiSession(context.sessionName, {
    ...params,
    kimiSessionId: context.sessionId,
  });
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
          trailingText: '',
          nextTurnId: null,
          nextSpecialCallIds: [],
          emittedToolStarts: new Set(),
          emittedRecordSignatures: new Set(),
          lastAssistantText: '',
          terminalSeen: false,
          hasError: false,
        };

        try {
          controller.enqueue(sseEvent('status', {
            reasoning: params.kimiSessionId
              ? '正在启动 Kimi tmux，并 resume 当前 Kimi session。'
              : '正在启动 Kimi tmux。',
          }));
          await launchTmuxKimiSession(sessionName, params);

          if (params.kimiSessionId) {
            await waitForKimiSessionIdFromTmux(context);
          } else {
            await initializeFreshKimiSessionFromResumeHint(context, params);
          }
          controller.enqueue(sseEvent('status', {
            session_id: context.sessionId,
            ...(context.cwd ? { cwd: context.cwd } : {}),
          }));
          await waitForKimiSessionFileBySessionId(context);

          const promptDelayMs = parsePositiveIntEnv('CODELARK_KIMI_TMUX_PROMPT_DELAY_MS', DEFAULT_KIMI_PROMPT_DELAY_MS, 0);
          if (promptDelayMs > 0) await sleep(promptDelayMs);
          transitionRuntimeTmuxInputState(
            'kimi',
            sessionName,
            'running',
            'Kimi session id and wire file are ready for input',
          );
          await sendRuntimeTmuxInput({
            runtime: 'kimi',
            sessionName,
            send: async () => {
              await tmuxCore.injectPromptIntoPane(targetPane, params.prompt);
              await tmuxCore.sendActions(targetPane, [{ type: 'key', key: 'C-s' }], { delayMs: 100 });
            },
          });

          await pollKimiSessionFile(
            controller,
            context,
            async () => (await tmuxCore.hasSession(context.sessionName)).exists,
          );
          await captureKimiResumeHint(context);
          controller.close();
        } catch (error) {
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
          if (!isDebugTmuxKeepAlive()) {
            try {
              await tmuxCore.killSession(sessionName, { ignoreMissing: true });
              transitionRuntimeTmuxInputState(
                'kimi',
                sessionName,
                'stopped',
                'Kimi turn completed and its provider-owned tmux session was cleaned up',
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
          } else {
            console.log(`[kimi-tmux] CODELARK_DEBUG is enabled; tmux session kept: ${sessionName}`);
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
