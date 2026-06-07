/**
 * Codex Provider — LLMProvider implementation backed by @openai/codex-sdk.
 *
 * Maps Codex SDK thread events to the SSE stream format consumed by
 * the bridge conversation engine.
 *
 * The provider lazily imports the installed SDK at first use and throws
 * a clear error if the package is missing from the current installation.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ThreadEvent, ThreadItem } from '@openai/codex-sdk';
import type { LLMProvider, StreamChatParams } from '../contracts.js';
import type { PendingPermissions } from '../permission-gateway.js';
import { sseEvent } from '../sse.js';
import type { CodexReasoningEffort, CodexSandboxMode } from '../options.js';
import {
  normalizeSandboxMode,
  parseReasoningEffort,
} from '../options.js';

/** MIME → file extension for temp image files. */
const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

const DEFAULT_TERMINAL_DRAIN_TIMEOUT_MS = 3_000;

// Keep SDK types as `any` because we lazy-load the package at runtime.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CodexModule = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CodexInstance = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ThreadInstance = any;

/**
 * Map bridge permission modes to Codex approval policies.
 * - 'acceptEdits' (code mode) → 'on-request' (allow IM users to approve escalations)
 * - 'plan' → 'on-request' (ask before executing)
 * - 'default' (ask mode) → 'on-request'
 */
function toApprovalPolicy(permissionMode?: string): string {
  switch (permissionMode) {
    case 'never': return 'never';
    case 'acceptEdits': return 'on-request';
    case 'plan': return 'on-request';
    case 'default': return 'on-request';
    default: return 'on-request';
  }
}

function isYoloMode(params: StreamChatParams): boolean {
  return params.codexMode === 'yolo' || params.permissionMode === 'never';
}

/** Allow Codex to run outside a trusted Git repository when explicitly enabled. */
function shouldSkipGitRepoCheck(params: StreamChatParams): boolean {
  return params.skipGitRepoCheck === true || process.env.CODELARK_CODEX_SKIP_GIT_REPO_CHECK === 'true';
}

function normalizeCodexErrorMessage(message: string | null | undefined): string {
  const trimmed = (message || '').trim();
  if (!trimmed) return 'Codex 执行失败，请稍后重试。';

  const lower = trimmed.toLowerCase();
  if (
    lower.includes('timeout waiting for child process to exit')
    || lower.includes('reconnecting...')
  ) {
    return 'Codex 会话恢复失败，上一轮执行进程未正常退出。请稍后重试；当前会话会保留，不会自动切换到新对话。';
  }

  return trimmed;
}

interface CodexErrorContext {
  phase: string;
  bridgeSessionId: string;
  codexThreadId?: string;
  workingDirectory?: string;
  sandboxMode?: string;
  networkAccessEnabled?: boolean;
  approvalPolicy?: string;
  permissionMode?: string;
}

function formatCodexErrorMessage(
  message: string | null | undefined,
  context?: CodexErrorContext,
): string {
  const normalized = normalizeCodexErrorMessage(message);
  if (!context) return normalized;

  return [
    normalized,
    '',
    'Codex context:',
    `- phase: ${context.phase}`,
    `- bridge_session_id: ${context.bridgeSessionId}`,
    context.codexThreadId ? `- codex_thread_id: ${context.codexThreadId}` : undefined,
    context.workingDirectory ? `- cwd: ${context.workingDirectory}` : undefined,
    context.sandboxMode ? `- sandbox_mode: ${context.sandboxMode}` : undefined,
    typeof context.networkAccessEnabled === 'boolean'
      ? `- network_access_enabled: ${context.networkAccessEnabled}`
      : undefined,
    context.approvalPolicy ? `- approval_policy: ${context.approvalPolicy}` : undefined,
    context.permissionMode ? `- permission_mode: ${context.permissionMode}` : undefined,
  ].filter(Boolean).join('\n');
}

function getTerminalDrainTimeoutMs(): number {
  const configured = parseInt(process.env.CODELARK_CODEX_TERMINAL_DRAIN_TIMEOUT_MS || '', 10);
  if (Number.isFinite(configured) && configured >= 10) {
    return configured;
  }
  return DEFAULT_TERMINAL_DRAIN_TIMEOUT_MS;
}

function buildCodexChildEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException && error.name === 'AbortError'
  ) || (
    error instanceof Error && error.name === 'AbortError'
  );
}

function isWindowsProcessTerminationParseNoise(message: string): boolean {
  const normalized = message.replace(/\s+/g, ' ').trim().toLowerCase();
  return (
    normalized.startsWith('failed to parse item: success:')
    && normalized.includes('the process with pid')
    && normalized.includes('has been terminated')
  );
}

function normalizeTaskText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function mapTodoListItems(items: unknown): Array<{ text: string; status: 'in_progress' | 'pending' | 'completed' }> {
  if (!Array.isArray(items)) return [];
  const normalized = items
    .map((item) => ({
      text: normalizeTaskText((item as { text?: unknown })?.text),
      completed: (item as { completed?: unknown })?.completed === true,
    }))
    .filter((item) => item.text);

  let firstIncompleteSeen = false;
  return normalized.map((item) => {
    if (item.completed) {
      return { text: item.text, status: 'completed' as const };
    }
    if (!firstIncompleteSeen) {
      firstIncompleteSeen = true;
      return { text: item.text, status: 'in_progress' as const };
    }
    return { text: item.text, status: 'pending' as const };
  });
}

function extractMcpContentText(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value
    .map((block) => {
      if (!block || typeof block !== 'object') return '';
      const record = block as { text?: unknown; content?: unknown };
      if (typeof record.text === 'string') return record.text.trim();
      if (typeof record.content === 'string') return record.content.trim();
      return '';
    })
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function quoteCliArg(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function formatCodexExecPreview(
  action: 'start' | 'resume',
  threadId: string | undefined,
  threadOptions: Record<string, unknown>,
  imageCount: number,
): string {
  const args = ['codex', 'exec', '--experimental-json'];
  if (typeof threadOptions.model === 'string') args.push('--model', threadOptions.model);
  if (typeof threadOptions.sandboxMode === 'string') args.push('--sandbox', threadOptions.sandboxMode);
  if (typeof threadOptions.workingDirectory === 'string') args.push('--cd', threadOptions.workingDirectory);
  if (threadOptions.skipGitRepoCheck === true) args.push('--skip-git-repo-check');
  if (typeof threadOptions.modelReasoningEffort === 'string') {
    args.push('--config', `model_reasoning_effort="${threadOptions.modelReasoningEffort}"`);
  }
  if (typeof threadOptions.networkAccessEnabled === 'boolean') {
    args.push('--config', `sandbox_workspace_write.network_access=${threadOptions.networkAccessEnabled}`);
  }
  if (typeof threadOptions.webSearchMode === 'string') {
    args.push('--config', `web_search="${threadOptions.webSearchMode}"`);
  }
  if (typeof threadOptions.approvalPolicy === 'string') {
    args.push('--config', `approval_policy="${threadOptions.approvalPolicy}"`);
  }
  if (action === 'resume' && threadId) args.push('resume', threadId);
  for (let i = 0; i < imageCount; i += 1) {
    args.push('--image', '<image-path:redacted>');
  }
  return args.map(quoteCliArg).join(' ');
}

function buildPromptWithSystemPrompt(prompt: string, systemPrompt?: string): string {
  const trimmedSystem = systemPrompt?.trim();
  if (!trimmedSystem) return prompt;
  return [
    '<system>',
    trimmedSystem,
    '</system>',
    '',
    prompt,
  ].join('\n');
}

function logCodexExecStart(params: {
  action: 'start' | 'resume';
  threadId?: string;
  sessionId: string;
  promptChars: number;
  imageCount: number;
  attachmentCount: number;
  permissionMode?: string;
  codexMode?: string;
  threadOptions: Record<string, unknown>;
}): void {
  console.log('[codex-provider] Codex exec start:', {
    action: params.action,
    thread_id: params.threadId,
    bridge_session_id: params.sessionId,
    command: formatCodexExecPreview(
      params.action,
      params.threadId,
      params.threadOptions,
      params.imageCount,
    ),
    prompt_chars: params.promptChars,
    attachments: {
      total: params.attachmentCount,
      images: params.imageCount,
    },
    permission_mode: params.permissionMode || null,
    codex_mode: params.codexMode || null,
    options: {
      model: params.threadOptions.model || null,
      working_directory: params.threadOptions.workingDirectory || null,
      sandbox_mode: params.threadOptions.sandboxMode || null,
      network_access_enabled: typeof params.threadOptions.networkAccessEnabled === 'boolean'
        ? params.threadOptions.networkAccessEnabled
        : null,
      approval_policy: params.threadOptions.approvalPolicy || null,
      model_reasoning_effort: params.threadOptions.modelReasoningEffort || null,
      web_search_mode: params.threadOptions.webSearchMode || null,
      skip_git_repo_check: params.threadOptions.skipGitRepoCheck === true,
    },
  });
}

function isCodexExecExitError(message: string): boolean {
  return message.startsWith('Codex Exec exited with ');
}

export class CodexProvider implements LLMProvider {
  private sdk: CodexModule | null = null;
  private codex: CodexInstance | null = null;

  /** Maps session IDs to Codex thread IDs for resume. */
  private threadIds = new Map<string, string>();

  constructor(_pendingPerms?: PendingPermissions) {}

  private clearCachedThreadId(sessionId: string): void {
    this.threadIds.delete(sessionId);
  }

  /**
   * Lazily load the Codex SDK. Throws a clear error if the installation is incomplete.
   */
  private async ensureSDK(): Promise<{ sdk: CodexModule; codex: CodexInstance }> {
    if (this.sdk && this.codex) {
      return { sdk: this.sdk, codex: this.codex };
    }

    try {
      this.sdk = await (Function('return import("@openai/codex-sdk")')() as Promise<CodexModule>);
    } catch {
      throw new Error(
        '[CodexProvider] @openai/codex-sdk is missing from this codelark installation. ' +
        'Reinstall codelark or run npm install in the project root.'
      );
    }

    // Resolve API key: CODELARK_CODEX_API_KEY > CODEX_API_KEY > OPENAI_API_KEY > (login auth)
    const apiKey = process.env.CODELARK_CODEX_API_KEY
      || process.env.CODEX_API_KEY
      || process.env.OPENAI_API_KEY
      || undefined;
    const baseUrl = process.env.CODELARK_CODEX_BASE_URL || undefined;

    const CodexClass = this.sdk.Codex;
    this.codex = new CodexClass({
      env: buildCodexChildEnv(),
      ...(apiKey ? { apiKey } : {}),
      ...(baseUrl ? { baseUrl } : {}),
    });

    return { sdk: this.sdk, codex: this.codex };
  }

  streamChat(params: StreamChatParams): ReadableStream<string> {
    const self = this;
    let consumerCanceled = false;

    return new ReadableStream<string>({
      start(controller) {
        (async () => {
          const tempFiles: string[] = [];
          try {
            const { codex } = await self.ensureSDK();

            // Resolve or create thread
            const inMemoryThreadId = self.threadIds.get(params.sessionId);
            const savedThreadId = inMemoryThreadId || params.codexThreadId || undefined;

            const yoloMode = isYoloMode(params);
            const approvalPolicy = yoloMode ? 'never' : toApprovalPolicy(params.permissionMode);
            const sandboxMode = yoloMode
              ? 'danger-full-access'
              : normalizeSandboxMode(params.sandboxMode) as CodexSandboxMode;
            const modelReasoningEffort = parseReasoningEffort(params.modelReasoningEffort) as CodexReasoningEffort | undefined;

            const threadOptions: Record<string, unknown> = {
              ...(params.forceModel && params.model ? { model: params.model } : {}),
              ...(params.workingDirectory ? { workingDirectory: params.workingDirectory } : {}),
              ...(shouldSkipGitRepoCheck(params) ? { skipGitRepoCheck: true } : {}),
              sandboxMode,
              ...(typeof params.networkAccessEnabled === 'boolean'
                ? { networkAccessEnabled: params.networkAccessEnabled }
                : {}),
              ...(modelReasoningEffort ? { modelReasoningEffort } : {}),
              ...(modelReasoningEffort === 'minimal' ? { webSearchMode: 'disabled' } : {}),
              approvalPolicy,
            };
            const buildErrorContext = (phase: string): CodexErrorContext => ({
              phase,
              bridgeSessionId: params.sessionId,
              codexThreadId: self.threadIds.get(params.sessionId) || savedThreadId,
              workingDirectory: params.workingDirectory,
              sandboxMode,
              networkAccessEnabled: params.networkAccessEnabled,
              approvalPolicy,
              permissionMode: params.permissionMode,
            });

            // Build input: Codex SDK UserInput supports { type: "text" } and
            // { type: "local_image", path: string }. We write base64 data to
            // temp files so the SDK can read them as local images.
            const imageFiles = params.files?.filter(
              f => f.type.startsWith('image/')
            ) ?? [];

            let input: string | Array<Record<string, string>>;
            const promptText = buildPromptWithSystemPrompt(params.prompt, params.systemPrompt);
            if (imageFiles.length > 0) {
              const parts: Array<Record<string, string>> = [
                { type: 'text', text: promptText },
              ];
              for (const file of imageFiles) {
                if (file.filePath && fs.existsSync(file.filePath)) {
                  parts.push({ type: 'local_image', path: file.filePath });
                  continue;
                }

                const ext = MIME_EXT[file.type] || '.png';
                const tmpPath = path.join(os.tmpdir(), `clk-img-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
                fs.writeFileSync(tmpPath, Buffer.from(file.data, 'base64'));
                tempFiles.push(tmpPath);
                parts.push({ type: 'local_image', path: tmpPath });
              }
              input = parts;
            } else {
              input = promptText;
            }

            const emittedToolStarts = new Set<string>();

            while (true) {
              let thread: ThreadInstance;
              if (savedThreadId) {
                logCodexExecStart({
                  action: 'resume',
                  threadId: savedThreadId,
                  sessionId: params.sessionId,
                  promptChars: params.prompt.length,
                  imageCount: imageFiles.length,
                  attachmentCount: params.files?.length || 0,
                  permissionMode: params.permissionMode,
                  codexMode: params.codexMode,
                  threadOptions,
                });
                thread = codex.resumeThread(savedThreadId, threadOptions);
              } else {
                logCodexExecStart({
                  action: 'start',
                  sessionId: params.sessionId,
                  promptChars: params.prompt.length,
                  imageCount: imageFiles.length,
                  attachmentCount: params.files?.length || 0,
                  permissionMode: params.permissionMode,
                  codexMode: params.codexMode,
                  threadOptions,
                });
                thread = codex.startThread(threadOptions);
              }

              let sawTerminalEvent = false;
              let sawCompletedAssistantContent = false;
              let lastCodexStdoutError: string | null = null;
              const runAbortController = new AbortController();
              let terminalDrainTimer: NodeJS.Timeout | null = null;
              const clearTerminalDrainTimer = () => {
                if (!terminalDrainTimer) return;
                clearTimeout(terminalDrainTimer);
                terminalDrainTimer = null;
              };
              const scheduleTerminalDrainAbort = () => {
                if (terminalDrainTimer || params.abortController?.signal.aborted) return;
                terminalDrainTimer = setTimeout(() => {
                  terminalDrainTimer = null;
                  if (!runAbortController.signal.aborted) {
                    runAbortController.abort();
                  }
                }, getTerminalDrainTimeoutMs());
              };
              const forwardUserAbort = () => {
                if (!runAbortController.signal.aborted) {
                  runAbortController.abort();
                }
              };
              if (params.abortController?.signal.aborted) {
                forwardUserAbort();
              } else {
                params.abortController?.signal.addEventListener('abort', forwardUserAbort, { once: true });
              }

              try {
                const { events } = await thread.runStreamed(input, {
                  signal: runAbortController.signal,
                });

                for await (const event of events as AsyncGenerator<ThreadEvent>) {
                  if (params.abortController?.signal.aborted) {
                    break;
                  }

                  switch (event.type) {
                    case 'thread.started': {
                      const threadId = event.thread_id as string;
                      self.threadIds.set(params.sessionId, threadId);

                      controller.enqueue(sseEvent('status', {
                        session_id: threadId,
                      }));
                      break;
                    }

                    case 'turn.started':
                      break;

                    case 'item.started':
                    case 'item.updated':
                    case 'item.completed': {
                      const item = event.item as ThreadItem;
                      const phase = event.type === 'item.started'
                        ? 'started'
                        : event.type === 'item.updated'
                          ? 'updated'
                          : 'completed';
                      if (
                        phase === 'completed'
                        && item.type === 'agent_message'
                        && typeof item.text === 'string'
                        && item.text.trim()
                      ) {
                        sawCompletedAssistantContent = true;
                      }
                      self.handleItemEvent(
                        controller,
                        item,
                        phase,
                        params.sessionId,
                        emittedToolStarts,
                      );
                      break;
                    }

                    case 'turn.completed': {
                      const usage = event.usage as Record<string, unknown> | undefined;
                      const threadId = self.threadIds.get(params.sessionId);

                      controller.enqueue(sseEvent('result', {
                        usage: usage ? {
                          input_tokens: usage.input_tokens ?? 0,
                          output_tokens: usage.output_tokens ?? 0,
                          cache_read_input_tokens: usage.cached_input_tokens ?? 0,
                          reasoning_output_tokens: usage.reasoning_output_tokens ?? 0,
                        } : undefined,
                        ...(threadId ? { session_id: threadId } : {}),
                      }));
                      sawTerminalEvent = true;
                      break;
                    }

                    case 'turn.failed': {
                      const error = (event as { error?: { message?: string } }).error?.message;
                      lastCodexStdoutError = error || 'Turn failed';
                      self.clearCachedThreadId(params.sessionId);
                      controller.enqueue(sseEvent('error', formatCodexErrorMessage(
                        error || 'Turn failed',
                        buildErrorContext('turn.failed'),
                      )));
                      sawTerminalEvent = true;
                      break;
                    }

                    case 'error': {
                      const error = (event as { message?: string }).message;
                      lastCodexStdoutError = error || 'Thread error';
                      self.clearCachedThreadId(params.sessionId);
                      controller.enqueue(sseEvent('error', formatCodexErrorMessage(
                        error || 'Thread error',
                        buildErrorContext('thread.error'),
                      )));
                      sawTerminalEvent = true;
                      break;
                    }

                    default: {
                      const exhaustiveEvent: never = event;
                      console.warn(
                        '[codex-provider] Unhandled thread event:',
                        stringifyUnknown(exhaustiveEvent),
                      );
                      break;
                    }
                  }

                  if (sawTerminalEvent) {
                    // Codex can emit the terminal turn event slightly before the
                    // underlying child process exits. Keep draining briefly so
                    // the SDK can shut down the child cleanly instead of leaving
                    // a reconnectable rollout behind for the next request.
                    scheduleTerminalDrainAbort();
                  }
                }
                clearTerminalDrainTimer();
                break;
              } catch (err) {
                clearTerminalDrainTimer();
                const message = err instanceof Error ? err.message : String(err);
                const userAborted = params.abortController?.signal.aborted === true;
                if (userAborted && isAbortError(err)) {
                  break;
                }
                if (sawTerminalEvent && (runAbortController.signal.aborted || isAbortError(err)) && !userAborted) {
                  break;
                }
                if (
                  (sawTerminalEvent || sawCompletedAssistantContent)
                  && isWindowsProcessTerminationParseNoise(message)
                ) {
                  console.warn('[codex-provider] Suppressed Codex SDK Windows process cleanup parse noise:', message);
                  break;
                }
                if (sawTerminalEvent && lastCodexStdoutError && isCodexExecExitError(message)) {
                  console.error('[codex-provider] Codex exec failed after stdout error:', {
                    bridge_session_id: params.sessionId,
                    codex_thread_id: self.threadIds.get(params.sessionId) || savedThreadId || null,
                    stdout_error: lastCodexStdoutError,
                    sdk_exit_error: message,
                  });
                  break;
                }
                self.clearCachedThreadId(params.sessionId);
                throw err;
              } finally {
                clearTerminalDrainTimer();
                params.abortController?.signal.removeEventListener('abort', forwardUserAbort);
              }
            }

            if (!consumerCanceled) {
              controller.close();
            }
          } catch (err) {
            if (consumerCanceled) return;
            const message = err instanceof Error ? err.message : String(err);
            console.error('[codex-provider] Error:', err instanceof Error ? err.stack || err.message : err);
            self.clearCachedThreadId(params.sessionId);
            try {
              controller.enqueue(sseEvent('error', formatCodexErrorMessage(message, {
                phase: 'stream.exception',
                bridgeSessionId: params.sessionId,
                codexThreadId: params.codexThreadId,
                workingDirectory: params.workingDirectory,
                permissionMode: params.permissionMode,
              })));
              controller.close();
            } catch {
              // Controller already closed
            }
          } finally {
            // Clean up temp image files
            for (const tmp of tempFiles) {
              try { fs.unlinkSync(tmp); } catch { /* ignore */ }
            }
          }
        })();
      },
      cancel() {
        consumerCanceled = true;
      },
    });
  }

  /**
   * Map a Codex item event to SSE events.
   */
  private handleItemEvent(
    controller: ReadableStreamDefaultController<string>,
    item: ThreadItem,
    phase: 'started' | 'updated' | 'completed',
    sessionId: string,
    emittedToolStarts: Set<string>,
  ): void {
    const itemType = item.type;
    const ensureToolUse = (toolId: string, name: string, input: unknown) => {
      if (emittedToolStarts.has(toolId)) return;
      emittedToolStarts.add(toolId);
      controller.enqueue(sseEvent('tool_use', {
        id: toolId,
        name,
        input,
      }));
    };

    switch (itemType) {
      case 'agent_message': {
        if (phase !== 'completed') break;
        const text = item.text || '';
        if (text) {
          controller.enqueue(sseEvent('text', text));
        }
        break;
      }

      case 'command_execution': {
        const toolId = item.id || `tool-${Date.now()}`;
        const command = item.command || '';
        const output = item.aggregated_output || '';
        const exitCode = item.exit_code;
        const status = item.status;
        const isError = exitCode != null && exitCode !== 0;
        const terminal = phase === 'completed' || status === 'completed' || status === 'failed';

        ensureToolUse(toolId, 'Bash', { command });
        if (!terminal) break;

        const resultContent = output || (isError ? `Exit code: ${exitCode}` : 'Done');
        controller.enqueue(sseEvent('tool_result', {
          tool_use_id: toolId,
          content: resultContent,
          is_error: isError,
        }));
        break;
      }

      case 'file_change': {
        if (phase !== 'completed') break;
        const toolId = item.id || `tool-${Date.now()}`;
        const changes = item.changes || [];
        const summary = changes.map(c => `${c.kind}: ${c.path}`).join('\n');

        ensureToolUse(toolId, 'Edit', { files: changes });

        controller.enqueue(sseEvent('tool_result', {
          tool_use_id: toolId,
          content: summary || 'File changes applied',
          is_error: false,
        }));
        break;
      }

      case 'mcp_tool_call': {
        const toolId = item.id || `tool-${Date.now()}`;
        const server = item.server || '';
        const tool = item.tool || '';
        const args = item.arguments;
        const result = item.result;
        const error = item.error;
        const status = item.status;
        const terminal = phase === 'completed' || status === 'completed' || status === 'failed';

        const resultText = extractMcpContentText(result?.content)
          || stringifyUnknown(result?.structured_content)
          || stringifyUnknown(result?.content);

        ensureToolUse(toolId, `mcp__${server}__${tool}`, args);
        if (!terminal) break;

        controller.enqueue(sseEvent('tool_result', {
          tool_use_id: toolId,
          content: error?.message || resultText || 'Done',
          is_error: !!error,
        }));
        break;
      }

      case 'web_search': {
        const toolId = item.id || `tool-${Date.now()}`;
        const query = item.query || '';
        ensureToolUse(toolId, 'Web Search', { query });
        if (phase !== 'completed') break;
        controller.enqueue(sseEvent('tool_result', {
          tool_use_id: toolId,
          content: query || 'Search completed',
          is_error: false,
        }));
        break;
      }

      case 'reasoning': {
        // Reasoning is internal; emit as status
        const text = item.text || '';
        if (text) {
          controller.enqueue(sseEvent('status', { reasoning: text }));
        }
        break;
      }

      case 'todo_list': {
        const tasks = mapTodoListItems(item.items);
        controller.enqueue(sseEvent('task_update', {
          session_id: sessionId,
          codex_thread_id: this.threadIds.get(sessionId) || undefined,
          tasks,
          todos: tasks,
        }));
        break;
      }

      case 'error': {
        this.clearCachedThreadId(sessionId);
        controller.enqueue(sseEvent('error', normalizeCodexErrorMessage(item.message || 'Codex error')));
        break;
      }

      default: {
        const exhaustiveItem: never = item;
        console.warn(
          '[codex-provider] Unhandled thread item:',
          stringifyUnknown(exhaustiveItem),
        );
        break;
      }
    }
  }

}
