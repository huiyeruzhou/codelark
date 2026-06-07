import fs from 'node:fs';

import type { LLMProvider, StreamChatParams } from '../contracts.js';
import type { BridgeMirrorRecord } from '../contracts.js';
import { sseEvent } from '../sse.js';
import { prepareClaudeCodeRouterEnv } from './code-router.js';
import {
  buildClaudePtyCommand,
  buildClaudePtyEnv,
  findLatestClaudeSessionJsonlUpdatedAfter,
  hasClaudePtyInputPrompt,
  hasClaudePtyOnboardingPrompt,
  hasClaudePtyTrustPrompt,
  parsePositiveIntEnv,
  sleep,
  waitForClaudeSessionJsonlUpdatedAfter,
} from './pty-provider.js';
import {
  listClaudeSessionJsonlFiles,
  readClaudeSessionMirrorRecordDeltaByFilePath,
} from './session-jsonl.js';
import {
  buildShellSnapshotLaunchCommand,
  ensureShellSnapshot,
} from '../codex/shell-snapshot.js';
import { tmuxCore, type TmuxCore, type TmuxEnsureSessionResult } from '../../bridge/tmux/core.js';
import { claudeTmuxSessionName } from '../../bridge/tmux/runtime.js';

const DEFAULT_CLAUDE_TMUX_PROMPT_DELAY_MS = 1_000;
const DEFAULT_CLAUDE_TMUX_AFTER_SETUP_DELAY_MS = 2_500;
const DEFAULT_CLAUDE_TMUX_INPUT_READY_TIMEOUT_MS = 10_000;
const DEFAULT_CLAUDE_TMUX_POLL_INTERVAL_MS = 500;
const DEFAULT_CLAUDE_TMUX_SESSION_FILE_TIMEOUT_MS = 30_000;

interface SessionFileSnapshotEntry {
  size: number;
  mtimeMs: number;
}

type SessionFileSnapshot = Map<string, SessionFileSnapshotEntry>;

interface ClaudeTmuxRunContext {
  sessionName: string;
  targetPane: string;
  bridgeSessionId: string;
  claudeSessionId?: string;
  cwd: string;
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

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function commandPreview(command: string, args: string[]): string {
  return [command, ...args].map(shellQuote).join(' ');
}

function snapshotClaudeSessionFiles(cwd: string): SessionFileSnapshot {
  const snapshot: SessionFileSnapshot = new Map();
  for (const filePath of listClaudeSessionJsonlFiles(cwd)) {
    try {
      const stat = fs.statSync(filePath);
      snapshot.set(filePath, { size: stat.size, mtimeMs: stat.mtimeMs });
    } catch {
      // Ignore races with Claude Code writing or rotating JSONL files.
    }
  }
  return snapshot;
}

function buildClaudeTmuxShellCommand(command: string, args: string[], env: Record<string, string>): string {
  const snapshot = ensureShellSnapshot(env);
  return buildShellSnapshotLaunchCommand(command, args, snapshot);
}

async function launchClaudeTmuxSession(params: {
  sessionName: string;
  streamParams: StreamChatParams;
  controller?: ReadableStreamDefaultController<string>;
  core?: TmuxCore;
  recreate?: boolean;
}): Promise<TmuxEnsureSessionResult> {
  const core = params.core || tmuxCore;
  const streamParams = params.streamParams;
  const executable = streamParams.claudeExecutable || 'claude';
  const cwd = streamParams.workingDirectory || process.cwd();
  const baseEnv = buildClaudePtyEnv();
  const { command, args } = buildClaudePtyCommand(executable, {
    model: streamParams.model?.trim() || undefined,
    permissionMode: streamParams.claudePermissionMode?.trim() || undefined,
    reasoningEffort: streamParams.claudeReasoningEffort?.trim() || undefined,
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
    bridge_session_id: streamParams.sessionId,
    tmux_session: params.sessionName,
    command: commandPreview(command, args),
    cwd,
    executable,
  });
  return await core.ensureDetachedSession({
    name: params.sessionName,
    cwd,
    command: shellCommand,
    recreate: params.recreate === true,
  });
}

export async function startClaudeTmuxSession(params: {
  sessionName: string;
  bridgeSessionId: string;
  workingDirectory?: string;
  executable?: StreamChatParams['claudeExecutable'];
  model?: string;
  permissionMode?: StreamChatParams['claudePermissionMode'];
  reasoningEffort?: StreamChatParams['claudeReasoningEffort'];
  core?: TmuxCore;
}): Promise<{ sessionName: string; commands: string[]; existed: boolean }> {
  const started = await launchClaudeTmuxSession({
    sessionName: params.sessionName,
    core: params.core,
    recreate: true,
    streamParams: {
      prompt: '',
      sessionId: params.bridgeSessionId,
      runtime: 'claude',
      claudeExecutable: params.executable,
      model: params.model,
      claudePermissionMode: params.permissionMode,
      claudeReasoningEffort: params.reasoningEffort,
      workingDirectory: params.workingDirectory,
    },
  });
  return {
    sessionName: params.sessionName,
    existed: started.existed,
    commands: started.commands,
  };
}

async function prepareClaudeTmuxForPrompt(targetPane: string, controller: ReadableStreamDefaultController<string>): Promise<void> {
  const inputReadyTimeoutMs = parsePositiveIntEnv(
    'CODELARK_CLAUDE_TMUX_INPUT_READY_TIMEOUT_MS',
    DEFAULT_CLAUDE_TMUX_INPUT_READY_TIMEOUT_MS,
    0,
  );
  const afterSetupDelayMs = parsePositiveIntEnv(
    'CODELARK_CLAUDE_TMUX_AFTER_SETUP_DELAY_MS',
    DEFAULT_CLAUDE_TMUX_AFTER_SETUP_DELAY_MS,
    0,
  );
  const deadline = Date.now() + inputReadyTimeoutMs;

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const capture = await tmuxCore.capturePane(targetPane, 80).catch(() => ({ screen: '', command: '/tmux-screen 80' }));
    if (hasClaudePtyInputPrompt(capture.screen)) return;
    if (hasClaudePtyOnboardingPrompt(capture.screen) || hasClaudePtyTrustPrompt(capture.screen)) {
      const kind = hasClaudePtyOnboardingPrompt(capture.screen) ? 'onboarding' : 'trust';
      controller.enqueue(sseEvent('status', { reasoning: `Claude tmux 检测到 ${kind} 提示，正在发送 Enter 继续。` }));
      await tmuxCore.sendActions(targetPane, [{ type: 'key', key: 'Enter' }]);
      if (afterSetupDelayMs > 0) await sleep(afterSetupDelayMs);
      continue;
    }
    if (Date.now() >= deadline || inputReadyTimeoutMs <= 0) return;
    await sleep(250);
  }
}

function recordToolName(record: BridgeMirrorRecord): string {
  return record.toolName || 'tool';
}

function enqueueClaudeTmuxRecordAsSse(
  controller: ReadableStreamDefaultController<string>,
  context: ClaudeTmuxRunContext,
  record: BridgeMirrorRecord,
): void {
  if (context.emittedRecordSignatures.has(record.signature)) return;
  context.emittedRecordSignatures.add(record.signature);

  switch (record.type) {
    case 'task_started':
      context.terminalSeen = false;
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
      }
      break;
    case 'task_complete':
      if (record.content && record.content !== context.lastAssistantText) {
        context.lastAssistantText = record.content;
        controller.enqueue(sseEvent('text', record.content));
      }
      context.terminalSeen = true;
      controller.enqueue(sseEvent('result', {
        ...(context.claudeSessionId ? { session_id: context.claudeSessionId } : {}),
        cwd: context.cwd,
        ...(context.sessionFilePath ? { transcript_path: context.sessionFilePath } : {}),
      }));
      break;
    case 'task_aborted':
      context.terminalSeen = true;
      context.hasError = true;
      controller.enqueue(sseEvent('error', record.content || 'Claude tmux task aborted.'));
      break;
    default:
      break;
  }
}

async function pollClaudeTmuxSessionFile(
  controller: ReadableStreamDefaultController<string>,
  params: StreamChatParams,
  context: ClaudeTmuxRunContext,
  before: SessionFileSnapshot,
  startedAtMs: number,
): Promise<void> {
  const pollIntervalMs = parsePositiveIntEnv('CODELARK_CLAUDE_TMUX_POLL_INTERVAL_MS', DEFAULT_CLAUDE_TMUX_POLL_INTERVAL_MS, 100);
  const fileTimeoutMs = parsePositiveIntEnv('CODELARK_CLAUDE_TMUX_SESSION_FILE_TIMEOUT_MS', DEFAULT_CLAUDE_TMUX_SESSION_FILE_TIMEOUT_MS, 1_000);
  let sessionFileDeadline = Date.now() + fileTimeoutMs;

  while (!context.terminalSeen) {
    if (params.abortController?.signal.aborted) break;

    if (!context.sessionFilePath) {
      const found = await waitForClaudeSessionJsonlUpdatedAfter(context.cwd, startedAtMs);
      if (found) {
        context.sessionFilePath = found.filePath;
        context.claudeSessionId = found.sessionId;
        context.cwd = found.cwd || context.cwd;
        context.nextOffset = before.get(found.filePath)?.size || 0;
        sessionFileDeadline = Date.now() + fileTimeoutMs;
        controller.enqueue(sseEvent('status', {
          session_id: found.sessionId,
          cwd: context.cwd,
          transcript_path: found.filePath,
        }));
      } else if (Date.now() > sessionFileDeadline) {
        throw new Error('Timed out waiting for Claude tmux session jsonl file.');
      }
    }

    if (context.sessionFilePath) {
      let size = context.nextOffset;
      try {
        size = fs.statSync(context.sessionFilePath).size;
      } catch {
        size = context.nextOffset;
      }
      if (size > context.nextOffset) {
        const delta = readClaudeSessionMirrorRecordDeltaByFilePath(
          context.sessionFilePath,
          context.nextOffset,
          size,
          context.trailingText,
          context.nextTurnId,
          context.nextSpecialCallIds,
        );
        context.nextOffset = delta.nextOffset;
        context.trailingText = delta.trailingText;
        context.nextTurnId = delta.nextTurnId;
        context.nextSpecialCallIds = delta.nextSpecialCallIds;
        for (const record of delta.records) {
          enqueueClaudeTmuxRecordAsSse(controller, context, record);
        }
      }
    }

    if (context.terminalSeen) break;
    const alive = (await tmuxCore.hasSession(context.sessionName)).exists;
    if (!alive) {
      if (!context.hasError) {
        controller.enqueue(sseEvent('result', {
          ...(context.claudeSessionId ? { session_id: context.claudeSessionId } : {}),
          cwd: context.cwd,
          ...(context.sessionFilePath ? { transcript_path: context.sessionFilePath } : {}),
        }));
      }
      break;
    }
    await sleep(pollIntervalMs);
  }
}

export async function injectPromptIntoClaudeTmuxSession(sessionName: string, prompt: string): Promise<void> {
  const targetPane = `${sessionName}:0.0`;
  await tmuxCore.injectPromptIntoPane(targetPane, prompt);
}

export function streamClaudeTmuxTui(params: StreamChatParams): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      (async () => {
        const sessionName = claudeTmuxSessionName(params.claudeSessionId || params.sessionId);
        const targetPane = `${sessionName}:0.0`;
        const cwd = params.workingDirectory || process.cwd();
        const before = snapshotClaudeSessionFiles(cwd);
        const startedAtMs = Date.now();
        const context: ClaudeTmuxRunContext = {
          sessionName,
          targetPane,
          bridgeSessionId: params.sessionId,
          claudeSessionId: params.claudeSessionId,
          cwd,
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
        const abortListener = () => {
          void tmuxCore.sendInterrupt(targetPane).catch(() => {});
        };

        try {
          params.abortController?.signal.addEventListener('abort', abortListener, { once: true });
          controller.enqueue(sseEvent('status', { reasoning: '正在启动或复用 Claude tmux。' }));
          await launchClaudeTmuxSession({ sessionName, streamParams: params, controller });
          const promptDelayMs = parsePositiveIntEnv('CODELARK_CLAUDE_TMUX_PROMPT_DELAY_MS', DEFAULT_CLAUDE_TMUX_PROMPT_DELAY_MS, 0);
          if (promptDelayMs > 0) await sleep(promptDelayMs);
          await prepareClaudeTmuxForPrompt(targetPane, controller);
          controller.enqueue(sseEvent('status', { reasoning: '正在把本次消息发送到 Claude tmux。' }));
          await tmuxCore.injectPromptIntoPane(targetPane, params.prompt);
          const startedClaudeJsonlSession = await waitForClaudeSessionJsonlUpdatedAfter(cwd, startedAtMs);
          if (startedClaudeJsonlSession) {
            context.sessionFilePath = startedClaudeJsonlSession.filePath;
            context.claudeSessionId = startedClaudeJsonlSession.sessionId;
            context.cwd = startedClaudeJsonlSession.cwd || cwd;
            context.nextOffset = before.get(startedClaudeJsonlSession.filePath)?.size || 0;
            controller.enqueue(sseEvent('status', {
              session_id: startedClaudeJsonlSession.sessionId,
              cwd: context.cwd,
              transcript_path: startedClaudeJsonlSession.filePath,
            }));
          }
          await pollClaudeTmuxSessionFile(controller, params, context, before, startedAtMs);
          controller.close();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error('[claude-tmux] Error:', error instanceof Error ? error.stack || error.message : error);
          try {
            controller.enqueue(sseEvent('error', message || 'Claude tmux execution failed.'));
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

export class ClaudeTmuxProvider implements LLMProvider {
  streamChat(params: StreamChatParams): ReadableStream<string> {
    return streamClaudeTmuxTui(params);
  }
}

export const _testOnlyClaudeTmux = {
  tmuxSessionName: claudeTmuxSessionName,
  snapshotClaudeSessionFiles,
  enqueueClaudeTmuxRecordAsSse,
  findLatestClaudeSessionJsonlUpdatedAfter,
};
