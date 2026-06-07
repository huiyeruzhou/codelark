/**
 * SDK Conversation Engine — processes inbound IM messages through the configured LLM provider.
 *
 * Takes a ChannelChat + inbound message, calls the LLM provider,
 * consumes the SSE stream server-side, saves messages to DB,
 * and returns the response text for delivery.
 */

import type { ChannelChat, OutboundAttachment, OutboundQuestion, TaskProgressInfo } from '../../../domain/index.js';
import type {
  BridgeSession,
  BridgeStore,
  FileAttachment,
} from '../../../domain/index.js';
import type {
  BridgeApiProvider,
  LLMProvider,
  MessageContentBlock,
  SSEEvent,
  StreamChatParams,
  TokenUsage,
} from '../../../runtime/contracts.js';
import crypto from 'crypto';
import {
  collectFinalResponseArtifacts,
  dedupeOutboundAttachments,
} from '../response-assembler.js';
import {
  buildConversationPromptText,
  prepareSdkMessageAttachments,
} from './sdk-attachments.js';
import {
  appendStreamPreviewChunk,
  buildInlineToolBlock,
  buildReasoningPreviewNote,
} from './sdk-stream-preview.js';
import {
  parseContextUsageInfo,
  type ContextUsageInfo,
} from '../../../shared/progress/context-usage.js';
import { resolveClaudeRuntimeConfig, resolveSessionRuntimeConfig } from '../../session/support.js';
import {
  getSessionActiveRuntime,
  getSessionClaudeSessionId,
  getSessionCodexThreadId,
  getSessionSystemPrompt,
  getSessionWorkingDirectory,
  setSessionClaudeSessionIdUpdate,
  setSessionClaudeIdentityUpdate,
} from '../../../domain/session-runtime.js';

export interface PermissionRequestInfo {
  permissionRequestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  suggestions?: unknown[];
}

/**
 * Callback invoked immediately when a permission_request SSE event arrives.
 * This breaks the deadlock: the stream blocks until the permission is resolved,
 * so we must forward the request to the IM *during* stream consumption,
 * not after it returns.
 */
export type OnPermissionRequest = (perm: PermissionRequestInfo) => Promise<void>;

/**
 * Callback invoked on each `text` SSE event with the full accumulated text so far.
 * Must return synchronously — the bridge-manager handles throttling and fire-and-forget.
 */
export type OnPartialText = (fullText: string) => void;

/**
 * Callback invoked when tool_use or tool_result SSE events arrive.
 * Used by bridge-manager to forward tool progress to adapters for real-time display.
 */
export type OnToolEvent = (
  toolId: string,
  toolName: string,
  status: 'running' | 'complete' | 'error',
  detail?: {
    input?: unknown;
    output?: string;
    isError?: boolean;
  },
) => void;
export type OnTaskEvent = (tasks: TaskProgressInfo[]) => void;
export type OnStatusNote = (note: string | null) => void;
export type OnContextUsage = (contextUsage: ContextUsageInfo) => void;
export type OnRuntimeIdentity = (identity: {
  runtime: 'codex' | 'claude';
  sessionId: string;
  cwd?: string;
  transcriptPath?: string;
}) => void | Promise<void>;

export interface ConversationResult {
  responseText: string;
  outboundAttachments: OutboundAttachment[];
  outboundQuestions?: OutboundQuestion[];
  tokenUsage: TokenUsage | null;
  hasError: boolean;
  errorMessage: string;
  /** Permission request events that were forwarded during streaming */
  permissionRequests: PermissionRequestInfo[];
  /** Codex thread id captured from status/result events, for session resume */
  codexThreadId: string | null;
}

export type ConsumeSdkSseEvents = (
  stream: ReadableStream<string>,
  onEvent: (event: SSEEvent) => Promise<void>,
) => Promise<void>;

export interface SdkConversationRuntime {
  store: BridgeStore;
  llm: LLMProvider;
  consumeSseEvents: ConsumeSdkSseEvents;
  normalizeSandboxMode(value: unknown): NonNullable<StreamChatParams['sandboxMode']>;
  normalizeReasoningEffort(value: unknown): NonNullable<StreamChatParams['modelReasoningEffort']>;
}

/**
 * Process an inbound message: send to the LLM provider, consume the response stream,
 * save to DB, and return the result.
 */
export async function processMessage(
  binding: ChannelChat,
  text: string,
  onPermissionRequest?: OnPermissionRequest,
  abortSignal?: AbortSignal,
  files?: FileAttachment[],
  onPartialText?: OnPartialText,
  onToolEvent?: OnToolEvent,
  onTaskEvent?: OnTaskEvent,
  onStatusNote?: OnStatusNote,
  onPromptPrepared?: (promptText: string) => void,
  options?: {
    expandToolCalls?: boolean;
    streamPreview?: {
      includeToolSnippets?: boolean;
    };
    onContextUsage?: OnContextUsage;
    onRuntimeIdentity?: OnRuntimeIdentity;
  },
  runtime?: SdkConversationRuntime,
): Promise<ConversationResult> {
  if (!runtime) {
    throw new Error('SDK conversation runtime port is not configured');
  }
  const { store, llm } = runtime;
  const sessionId = binding.bridgeSessionId;

  // Acquire session lock
  const lockId = crypto.randomBytes(8).toString('hex');
  const lockAcquired = store.acquireSessionLock(sessionId, lockId, `bridge-${binding.channelType}`, 600);
  if (!lockAcquired) {
    return {
      responseText: '',
      outboundAttachments: [],
      outboundQuestions: [],
      tokenUsage: null,
      hasError: true,
      errorMessage: 'Session is busy processing another request',
      permissionRequests: [],
      codexThreadId: null,
    };
  }

  store.setSessionRuntimeStatus(sessionId, 'running');

  // Lock renewal interval
  const renewalInterval = setInterval(() => {
    try { store.renewSessionLock(sessionId, lockId, 600); } catch { /* best effort */ }
  }, 60_000);

  try {
    // Resolve session early — needed for workingDirectory and provider resolution
    const session = store.getSession(sessionId);
    const workDir = getSessionWorkingDirectory(session) || '';
    const activeRuntime = getSessionActiveRuntime(session) || 'codex';
    const runtimeConfig = resolveSessionRuntimeConfig(binding, session);
    const claudeRuntimeConfig = activeRuntime === 'claude' ? resolveClaudeRuntimeConfig(session, binding) : null;

    const { savedContent, llmFiles, persistedFileMeta } = prepareSdkMessageAttachments({ text, files, workDir });
    store.addMessage(sessionId, 'user', savedContent);

    const promptText = buildConversationPromptText(text, persistedFileMeta);
    onPromptPrepared?.(promptText);
    // Resolve provider
    let resolvedProvider: BridgeApiProvider | undefined;
    const providerId = session?.provider_id || '';
    if (providerId && providerId !== 'env') {
      resolvedProvider = store.getProvider(providerId);
    }
    if (!resolvedProvider) {
      const defaultId = store.getDefaultProviderId();
      if (defaultId) resolvedProvider = store.getProvider(defaultId);
    }

    // Effective model
    const effectiveModel = activeRuntime === 'claude'
      ? claudeRuntimeConfig?.model
      : runtimeConfig.model || undefined;
    const codexThreadId = getSessionCodexThreadId(session);
    const claudeSessionId = getSessionClaudeSessionId(session);

    const permissionMode = runtimeConfig.mode === 'yolo' ? 'never' : 'acceptEdits';

    // Load conversation history for context
    const { messages: recentMsgs } = store.getMessages(sessionId, { limit: 50 });
    const historyMsgs = recentMsgs.slice(0, -1).map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));

    const abortController = new AbortController();
    if (abortSignal) {
      if (abortSignal.aborted) {
        abortController.abort();
      } else {
        abortSignal.addEventListener('abort', () => abortController.abort(), { once: true });
      }
    }

    const stream = llm.streamChat({
      prompt: promptText,
      sessionId,
      runtime: activeRuntime,
      codexThreadId: codexThreadId,
      claudeSessionId,
      claudeExecutable: claudeRuntimeConfig?.executable,
      claudeProvider: claudeRuntimeConfig?.provider,
      model: effectiveModel,
      forceModel: !codexThreadId && Boolean(effectiveModel),
      sandboxMode: runtimeConfig.sandboxMode as StreamChatParams['sandboxMode'],
      networkAccessEnabled: runtimeConfig.networkAccessEnabled,
      modelReasoningEffort: runtimeConfig.reasoningEffort as StreamChatParams['modelReasoningEffort'],
      skipGitRepoCheck: runtimeConfig.skipGitRepoCheck,
      systemPrompt: getSessionSystemPrompt(session),
      workingDirectory: workDir || undefined,
      abortController,
      permissionMode,
      claudePermissionMode: claudeRuntimeConfig?.permissionMode,
      claudeReasoningEffort: claudeRuntimeConfig?.reasoningEffort,
      codexMode: runtimeConfig.mode,
      codexProvider: runtimeConfig.codexProvider,
      provider: resolvedProvider,
      conversationHistory: historyMsgs,
      files: llmFiles,
      onRuntimeStatusChange: (status: string) => {
        try { store.setSessionRuntimeStatus(sessionId, status); } catch { /* best effort */ }
      },
    });

    // Consume the stream server-side (replicate collectStreamResponse pattern).
    // Permission requests are forwarded immediately via the callback during streaming
    // because the stream blocks until permission is resolved — we can't wait until after.
    return await consumeStream(
      runtime,
      stream,
      sessionId,
      onPermissionRequest,
      onPartialText,
      onToolEvent,
      onTaskEvent,
      onStatusNote,
      options,
      activeRuntime,
    );
  } finally {
    clearInterval(renewalInterval);
    store.releaseSessionLock(sessionId, lockId);
    store.setSessionRuntimeStatus(sessionId, 'idle');
  }
}

/**
 * Consume an SSE stream and extract response data.
 * Mirrors the collectStreamResponse() logic from chat/route.ts.
 */
async function consumeStream(
  runtime: SdkConversationRuntime,
  stream: ReadableStream<string>,
  sessionId: string,
  onPermissionRequest?: OnPermissionRequest,
  onPartialText?: OnPartialText,
  onToolEvent?: OnToolEvent,
  onTaskEvent?: OnTaskEvent,
  onStatusNote?: OnStatusNote,
  options?: {
    expandToolCalls?: boolean;
    streamPreview?: {
      includeToolSnippets?: boolean;
    };
    onContextUsage?: OnContextUsage;
    onRuntimeIdentity?: OnRuntimeIdentity;
  },
  activeRuntime: 'codex' | 'claude' = 'codex',
): Promise<ConversationResult> {
  const { store } = runtime;
  const contentBlocks: MessageContentBlock[] = [];
  let currentText = '';
  /** Monotonically accumulated text for streaming preview — never resets on tool_use. */
  let previewText = '';
  let separateNextPreviewText = false;
  let tokenUsage: TokenUsage | null = null;
  let hasError = false;
  let errorMessage = '';
  const seenToolResultIds = new Set<string>();
  const permissionRequests: PermissionRequestInfo[] = [];
  let capturedCodexThreadId: string | null = null;
  const outboundAttachments: OutboundAttachment[] = [];
  const outboundQuestions: OutboundQuestion[] = [];
  const toolPreview = new Map<string, { name: string; input: unknown }>();
  let lastReasoningNote: string | null = null;
  const expandToolCalls = options?.expandToolCalls !== false;
  const includeToolSnippets = expandToolCalls && options?.streamPreview?.includeToolSnippets !== false;
  const onContextUsage = options?.onContextUsage;

  const formatSseErrorPayload = (raw: string): string => {
    const trimmed = (raw || '').trim();
    if (!trimmed) return 'Unknown error';
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (typeof parsed === 'string') return parsed.trim() || 'Unknown error';
      if (!parsed || typeof parsed !== 'object') return trimmed;
      const record = parsed as Record<string, unknown>;
      const name = typeof record.name === 'string' ? record.name.trim() : '';
      const message = typeof record.message === 'string'
        ? record.message.trim()
        : typeof record.error === 'string'
          ? record.error.trim()
          : '';
      const stack = typeof record.stack === 'string' ? record.stack.trim() : '';
      const code = typeof record.code === 'string' ? record.code.trim() : '';
      const pieces = [
        name && message ? `${name}: ${message}` : (name || message),
        code ? `code: ${code}` : '',
        stack,
      ].filter(Boolean);
      return pieces.length > 0 ? pieces.join('\n') : trimmed;
    } catch {
      return trimmed;
    }
  };

  try {
    await runtime.consumeSseEvents(stream, async (event: SSEEvent) => {
      switch (event.type) {
        case 'text':
          currentText += event.data;
          if (onPartialText) {
            previewText = appendStreamPreviewChunk(previewText, event.data, separateNextPreviewText);
            separateNextPreviewText = false;
            try { onPartialText(previewText); } catch { /* non-critical */ }
          }
          break;

        case 'tool_use': {
          if (expandToolCalls && currentText.trim()) {
            contentBlocks.push({ type: 'text', text: currentText });
            currentText = '';
          }
          try {
            const toolData = JSON.parse(event.data);
            if (expandToolCalls) {
              contentBlocks.push({
                type: 'tool_use',
                id: toolData.id,
                name: toolData.name,
                input: toolData.input,
              });
            }
            toolPreview.set(toolData.id, { name: toolData.name, input: toolData.input });
            if (onToolEvent) {
              try {
                onToolEvent(toolData.id, toolData.name, 'running', { input: toolData.input });
              } catch { /* non-critical */ }
            }
            if (onPartialText && includeToolSnippets) {
              const snippet = buildInlineToolBlock({ name: toolData.name, status: 'running', input: toolData.input });
              previewText = appendStreamPreviewChunk(previewText, snippet, true);
              separateNextPreviewText = false;
              try { onPartialText(previewText); } catch { /* non-critical */ }
            }
            separateNextPreviewText = true;
          } catch { /* skip */ }
          break;
        }

        case 'tool_result': {
          try {
            const resultData = JSON.parse(event.data);
            const newBlock = {
              type: 'tool_result' as const,
              tool_use_id: resultData.tool_use_id,
              content: resultData.content,
              is_error: resultData.is_error || false,
            };
            if (expandToolCalls) {
              if (seenToolResultIds.has(resultData.tool_use_id)) {
                const idx = contentBlocks.findIndex(
                  (b) => b.type === 'tool_result' && 'tool_use_id' in b && b.tool_use_id === resultData.tool_use_id
                );
                if (idx >= 0) contentBlocks[idx] = newBlock;
              } else {
                seenToolResultIds.add(resultData.tool_use_id);
                contentBlocks.push(newBlock);
              }
            }
            if (onToolEvent) {
              try {
                onToolEvent(
                  resultData.tool_use_id,
                  '',
                  resultData.is_error ? 'error' : 'complete',
                  { output: resultData.content, isError: resultData.is_error || false },
                );
              } catch { /* non-critical */ }
            }
            if (onPartialText && includeToolSnippets) {
              const prior = toolPreview.get(resultData.tool_use_id);
              const snippet = buildInlineToolBlock({
                name: prior?.name || 'tool',
                input: prior?.input,
                output: String(resultData.content || ''),
                isError: Boolean(resultData.is_error),
                status: resultData.is_error ? 'error' : 'complete',
              });
              previewText = appendStreamPreviewChunk(previewText, snippet, true);
              separateNextPreviewText = false;
              try { onPartialText(previewText); } catch { /* non-critical */ }
            }
            separateNextPreviewText = true;
          } catch { /* skip */ }
          break;
        }

        case 'permission_request': {
          try {
            const permData = JSON.parse(event.data);
            const perm: PermissionRequestInfo = {
              permissionRequestId: permData.permissionRequestId,
              toolName: permData.toolName,
              toolInput: permData.toolInput,
              suggestions: permData.suggestions,
            };
            permissionRequests.push(perm);
            if (onPermissionRequest) {
              onPermissionRequest(perm).catch((err) => {
                console.error('[sdk-conversation-engine] Failed to forward permission request:', err);
              });
            }
          } catch { /* skip */ }
          break;
        }

        case 'status': {
          try {
            const statusData = JSON.parse(event.data);
            if (statusData.session_id) {
              if (activeRuntime === 'claude') {
                if (typeof statusData.cwd === 'string') {
                  store.updateSession(sessionId, setSessionClaudeIdentityUpdate(statusData.session_id, statusData.cwd));
                } else {
                  store.updateSession(sessionId, setSessionClaudeSessionIdUpdate(statusData.session_id));
                }
                await options?.onRuntimeIdentity?.({
                  runtime: 'claude',
                  sessionId: statusData.session_id,
                  ...(typeof statusData.cwd === 'string' ? { cwd: statusData.cwd } : {}),
                  ...(typeof statusData.transcript_path === 'string' ? { transcriptPath: statusData.transcript_path } : {}),
                });
              } else {
                capturedCodexThreadId = statusData.session_id;
                store.updateSessionCodexThreadId(sessionId, statusData.session_id);
                await options?.onRuntimeIdentity?.({
                  runtime: 'codex',
                  sessionId: statusData.session_id,
                });
              }
            }
            if (statusData.model && activeRuntime !== 'claude') {
              store.updateSessionModel(sessionId, statusData.model);
            }
            if (typeof statusData.reasoning === 'string' && onStatusNote) {
              try { onStatusNote(statusData.reasoning); } catch { /* non-critical */ }
            }
            if (typeof statusData.reasoning === 'string' && onPartialText) {
              const note = statusData.reasoning.trim();
              if (note && note !== lastReasoningNote) {
                lastReasoningNote = note;
                const snippet = buildReasoningPreviewNote(note);
                if (snippet) {
                  previewText = appendStreamPreviewChunk(previewText, snippet, true);
                  separateNextPreviewText = false;
                  try { onPartialText(previewText); } catch { /* non-critical */ }
                }
              }
            }
          } catch { /* skip */ }
          break;
        }

        case 'context_usage': {
          try {
            const contextUsage = parseContextUsageInfo(JSON.parse(event.data));
            if (contextUsage && onContextUsage) {
              try { onContextUsage(contextUsage); } catch { /* non-critical */ }
            }
          } catch { /* skip */ }
          break;
        }

        case 'task_update': {
          try {
            const taskData = JSON.parse(event.data);
            const tasks = Array.isArray(taskData.tasks)
              ? taskData.tasks
              : (Array.isArray(taskData.todos) ? taskData.todos : null);
            if (tasks) {
              store.syncSdkTasks(sessionId, tasks);
              if (onTaskEvent) {
                try { onTaskEvent(tasks as TaskProgressInfo[]); } catch { /* non-critical */ }
              }
            }
          } catch { /* skip */ }
          break;
        }

        case 'error':
          hasError = true;
          errorMessage = formatSseErrorPayload(event.data);
          break;

        case 'result': {
          try {
            const resultData = JSON.parse(event.data);
            if (resultData.usage) tokenUsage = resultData.usage;
            if (resultData.model && activeRuntime !== 'claude') {
              store.updateSessionModel(sessionId, resultData.model);
            }
            if (resultData.usage && onContextUsage) {
              const contextUsage = parseContextUsageInfo({ last_token_usage: resultData.usage });
              if (contextUsage) {
                try { onContextUsage(contextUsage); } catch { /* non-critical */ }
              }
            }
            if (resultData.is_error) hasError = true;
            if (resultData.session_id) {
              if (activeRuntime === 'claude') {
                store.updateSession(sessionId, setSessionClaudeIdentityUpdate(
                  resultData.session_id,
                  typeof resultData.cwd === 'string' ? resultData.cwd : undefined,
                ));
                await options?.onRuntimeIdentity?.({
                  runtime: 'claude',
                  sessionId: resultData.session_id,
                  ...(typeof resultData.cwd === 'string' ? { cwd: resultData.cwd } : {}),
                  ...(typeof resultData.transcript_path === 'string' ? { transcriptPath: resultData.transcript_path } : {}),
                });
              } else {
                capturedCodexThreadId = resultData.session_id;
                store.updateSessionCodexThreadId(sessionId, resultData.session_id);
                await options?.onRuntimeIdentity?.({
                  runtime: 'codex',
                  sessionId: resultData.session_id,
                });
              }
            }
          } catch { /* skip */ }
          break;
        }

        // tool_output, tool_timeout, mode_changed, done — ignored for bridge
      }
    });

    // Flush remaining text
    if (currentText.trim()) {
      contentBlocks.push({ type: 'text', text: currentText });
    }

    // Save assistant message
    if (contentBlocks.length > 0) {
      for (const block of contentBlocks) {
        if (block.type !== 'text') continue;
        const parsed = collectFinalResponseArtifacts(block.text);
        block.text = parsed.text;
        outboundAttachments.push(...parsed.attachments);
        outboundQuestions.push(...parsed.questions);
      }

      const hasToolBlocks = contentBlocks.some(
        (b) => b.type === 'tool_use' || b.type === 'tool_result'
      );
      const content = hasToolBlocks
        ? JSON.stringify(contentBlocks)
        : contentBlocks
            .filter((b): b is Extract<MessageContentBlock, { type: 'text' }> => b.type === 'text')
            .map((b) => b.text)
            .join('\n\n')
            .trim();

      if (content) {
        store.addMessage(sessionId, 'assistant', content, tokenUsage ? JSON.stringify(tokenUsage) : null);
      }
    }

    // Extract text-only response for IM delivery
    const responseText = contentBlocks
      .filter((b): b is Extract<MessageContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n\n')
      .trim();

    return {
      responseText,
      outboundAttachments: dedupeOutboundAttachments(outboundAttachments),
      outboundQuestions,
      tokenUsage,
      hasError,
      errorMessage,
      permissionRequests,
      codexThreadId: capturedCodexThreadId,
    };
  } catch (e) {
    // Best-effort save on stream error
    if (currentText.trim()) {
      contentBlocks.push({ type: 'text', text: currentText });
    }
    if (contentBlocks.length > 0) {
      const hasToolBlocks = contentBlocks.some(
        (b) => b.type === 'tool_use' || b.type === 'tool_result'
      );
      const content = hasToolBlocks
        ? JSON.stringify(contentBlocks)
        : contentBlocks
            .filter((b): b is Extract<MessageContentBlock, { type: 'text' }> => b.type === 'text')
            .map((b) => b.text)
            .join('\n\n')
            .trim();
      if (content) {
        store.addMessage(sessionId, 'assistant', content);
      }
    }

    const isAbort = e instanceof DOMException && e.name === 'AbortError'
      || e instanceof Error && e.name === 'AbortError';

    return {
      responseText: '',
      outboundAttachments: [],
      outboundQuestions: [],
      tokenUsage,
      hasError: true,
      errorMessage: isAbort
        ? 'Task stopped by user'
        : (e instanceof Error ? (e.stack || e.message) : 'Stream consumption error'),
      permissionRequests,
      codexThreadId: capturedCodexThreadId,
    };
  }
}
