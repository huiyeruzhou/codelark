import { bootstrapLocalCodexThread } from '../../runtime/codex/thread-bootstrap.js';
import type { CodexReasoningEffort, CodexSandboxMode } from '../../configuration/index.js';
import type { BridgeSession, ChannelChat } from '../../domain/index.js';
import {
  getSessionWorkingDirectory,
} from '../../domain/session-runtime.js';
import type { LLMProvider, SSEEvent } from '../../runtime/contracts.js';
import {
  getCodexSessionByThreadIdSafe,
  resolveSessionRuntimeConfig,
} from '../session/support.js';

const BOOTSTRAP_THREAD_VISIBILITY_TIMEOUT_MS = 2_000;
const BOOTSTRAP_THREAD_VISIBILITY_POLL_MS = 50;

export interface BootstrapCodexThreadParams {
  session: BridgeSession;
  binding: ChannelChat;
  mode: string;
  sandboxMode: CodexSandboxMode;
  networkAccessEnabled: boolean;
  modelReasoningEffort: CodexReasoningEffort;
  skipGitRepoCheck: boolean;
}

function readCodexThreadIdFromEvent(event: SSEEvent): string | null {
  if (event.type !== 'status' && event.type !== 'result') return null;
  try {
    const payload = JSON.parse(event.data) as { session_id?: unknown };
    return typeof payload.session_id === 'string' && payload.session_id.trim()
      ? payload.session_id.trim()
      : null;
  } catch {
    return null;
  }
}

function readErrorFromEvent(event: SSEEvent): string | null {
  if (event.type !== 'error') return null;
  const raw = typeof event.data === 'string' ? event.data.trim() : '';
  return raw || null;
}

function parseSseDataLine(line: string): SSEEvent | null {
  if (!line.startsWith('data: ')) return null;
  try {
    return JSON.parse(line.slice(6)) as SSEEvent;
  } catch {
    return null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCodexThreadVisible(threadId: string): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < BOOTSTRAP_THREAD_VISIBILITY_TIMEOUT_MS) {
    if (getCodexSessionByThreadIdSafe(threadId, 'SDK bootstrap visibility wait')) return;
    await delay(BOOTSTRAP_THREAD_VISIBILITY_POLL_MS);
  }
}

export async function readFirstCodexThreadId(
  stream: ReadableStream<string>,
  onThreadId?: (threadId: string) => void | Promise<void>,
): Promise<string> {
  const reader = stream.getReader();
  let pending = '';
  const errors: string[] = [];
  let threadId = '';
  const rememberThreadId = (foundThreadId: string) => {
    if (!threadId) threadId = foundThreadId;
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += value;
      const normalized = pending.replace(/\r\n/g, '\n');
      const parts = normalized.split('\n');
      pending = parts.pop() ?? '';
      for (const line of parts) {
        const event = parseSseDataLine(line);
        const foundThreadId = event ? readCodexThreadIdFromEvent(event) : null;
        if (foundThreadId) {
          rememberThreadId(foundThreadId);
          await onThreadId?.(threadId);
          return threadId;
        }
        const error = event ? readErrorFromEvent(event) : null;
        if (error) errors.push(error);
      }
    }
    const trailingEvent = parseSseDataLine(pending);
    const trailingThreadId = trailingEvent ? readCodexThreadIdFromEvent(trailingEvent) : null;
    if (trailingThreadId) {
      rememberThreadId(trailingThreadId);
      await onThreadId?.(threadId);
      return threadId;
    }
    const trailingError = trailingEvent ? readErrorFromEvent(trailingEvent) : null;
    if (trailingError) errors.push(trailingError);
    if (errors.length > 0) {
      throw new Error(`无法通过 SDK 预创建 Codex thread：${errors.at(-1)}`);
    }
    if (threadId) return threadId;
    return '';
  } finally {
    try { await reader.cancel(); } catch { /* stream may already be closed */ }
  }
}

export async function bootstrapCodexThreadWithSdk(
  llm: LLMProvider,
  params: BootstrapCodexThreadParams,
): Promise<string> {
  const abortController = new AbortController();
  let threadId = '';
  const model = resolveSessionRuntimeConfig(params.binding, params.session).model;
  const stream = llm.streamChat({
    prompt: 'Initialize this Codex session and wait for the next instruction.',
    sessionId: params.session.id,
    model: model || undefined,
    forceModel: Boolean(model),
    sandboxMode: params.sandboxMode,
    networkAccessEnabled: params.networkAccessEnabled,
    modelReasoningEffort: params.modelReasoningEffort,
    skipGitRepoCheck: params.skipGitRepoCheck,
    workingDirectory: getSessionWorkingDirectory(params.session) || undefined,
    abortController,
    permissionMode: params.mode === 'yolo' ? 'never' : 'acceptEdits',
    codexMode: params.mode === 'yolo' ? 'yolo' : 'normal',
    codexProvider: 'sdk',
    conversationHistory: [],
  });
  threadId = await readFirstCodexThreadId(stream, async (foundThreadId) => {
    await waitForCodexThreadVisible(foundThreadId);
    if (!abortController.signal.aborted) abortController.abort();
  });
  if (!abortController.signal.aborted) abortController.abort();
  if (!threadId) {
    throw new Error('无法通过 SDK 预创建 Codex thread：未收到 codex_thread_id。');
  }
  return threadId;
}

export async function bootstrapCodexThreadLocally(params: BootstrapCodexThreadParams): Promise<string> {
  const runtimeConfig = resolveSessionRuntimeConfig(params.binding, params.session);
  return bootstrapLocalCodexThread({
    bridgeSessionId: params.session.id,
    model: runtimeConfig.model || undefined,
    workingDirectory: getSessionWorkingDirectory(params.session) || undefined,
    mode: params.mode,
    sandboxMode: params.sandboxMode,
    networkAccessEnabled: params.networkAccessEnabled,
    modelReasoningEffort: params.modelReasoningEffort,
    skipGitRepoCheck: params.skipGitRepoCheck,
  });
}
