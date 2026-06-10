import fs from 'node:fs';

import type { LLMProvider, StreamChatParams } from '../contracts.js';
import type { BridgeMirrorRecord } from '../contracts.js';
import { sseEvent } from '../sse.js';
import { prepareClaudeCodeRouterEnv } from './code-router.js';
import {
  findLatestClaudeSessionJsonlUpdatedAfter,
  parsePositiveIntEnv,
  sleep,
  waitForClaudeSessionJsonlUpdatedAfter,
} from './pty-provider.js';
import {
  listClaudeSessionJsonlFiles,
  readClaudeSessionMirrorRecordDeltaByFilePath,
} from './session-jsonl.js';
import {
  claudeTmuxSessionName,
  startClaudeTmuxSession,
  startRuntimeTmuxSession,
  waitForRuntimeTmuxReady,
} from '../../bridge/tmux/runtime.js';
import { tmuxCore } from '../../bridge/tmux/core.js';

export { startClaudeTmuxSession };

const DEFAULT_CLAUDE_TMUX_PROMPT_DELAY_MS = 1_000;
const DEFAULT_CLAUDE_TMUX_AFTER_SETUP_DELAY_MS = 2_500;
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

async function prepareClaudeTmuxForPrompt(sessionName: string, targetPane: string, controller: ReadableStreamDefaultController<string>): Promise<void> {
  const afterSetupDelayMs = parsePositiveIntEnv(
    'CODELARK_CLAUDE_TMUX_AFTER_SETUP_DELAY_MS',
    DEFAULT_CLAUDE_TMUX_AFTER_SETUP_DELAY_MS,
    0,
  );
  await waitForRuntimeTmuxReady({
    runtime: 'claude',
    sessionName,
    target: targetPane,
    afterSelectionDelayMs: afterSetupDelayMs,
    onSelectionPrompt: (selectionPrompt) => {
      controller.enqueue(sseEvent('status', {
        reasoning: `Claude tmux 检测到 ${selectionPrompt.kind} 提示，正在发送 Enter 继续。`,
      }));
    },
  });
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
          await startRuntimeTmuxSession({
            runtime: 'claude',
            sessionName,
            bridgeSessionId: params.sessionId,
            workingDirectory: params.workingDirectory,
            executable: params.claudeExecutable,
            model: params.model,
            permissionMode: params.claudePermissionMode,
            reasoningEffort: params.claudeReasoningEffort,
            controller,
            recreate: false,
          });
          const promptDelayMs = parsePositiveIntEnv('CODELARK_CLAUDE_TMUX_PROMPT_DELAY_MS', DEFAULT_CLAUDE_TMUX_PROMPT_DELAY_MS, 0);
          if (promptDelayMs > 0) await sleep(promptDelayMs);
          await prepareClaudeTmuxForPrompt(sessionName, targetPane, controller);
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
