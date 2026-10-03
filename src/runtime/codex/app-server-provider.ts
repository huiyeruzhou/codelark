import fs from 'node:fs';
import type { LLMProvider, StreamChatParams, BridgeMirrorRecord } from '../contracts.js';
import { sseEvent } from '../sse.js';
import { buildTempImageFiles } from './tmux-provider.js';
import { prepareCodexAppServerSession } from './app-server-registry.js';
import type { AppServerInput } from './app-server-lifecycle.js';

export function appServerThreadOptions(params: StreamChatParams) {
  return {
    sessionId: params.sessionId, threadId: params.codexThreadId, endpoint: params.codexAppServerEndpoint,
    cwd: params.workingDirectory, model: params.model,
    sandbox: params.codexMode === 'yolo' ? 'danger-full-access' : params.sandboxMode,
    approvalPolicy: params.codexMode === 'yolo' || params.permissionMode === 'never' ? 'never' : 'on-request',
    developerInstructions: params.systemPrompt,
    config: {
      ...(params.modelReasoningEffort ? { model_reasoning_effort: params.modelReasoningEffort } : {}),
      ...(params.networkAccessEnabled !== undefined ? { 'sandbox_workspace_write.network_access': params.networkAccessEnabled } : {}),
    },
  };
}

export function appServerTurnOptions(params: {
  workingDirectory?: string; model?: string; modelReasoningEffort?: string;
  codexMode?: string; permissionMode?: string; sandboxMode?: string; networkAccessEnabled?: boolean;
}): Record<string, unknown> {
  const sandbox = params.codexMode === 'yolo' ? 'danger-full-access' : params.sandboxMode;
  return {
    ...(params.workingDirectory ? { cwd: params.workingDirectory } : {}),
    ...(params.model ? { model: params.model } : {}),
    ...(params.modelReasoningEffort ? { effort: params.modelReasoningEffort } : {}),
    approvalPolicy: params.codexMode === 'yolo' || params.permissionMode === 'never' ? 'never' : 'on-request',
    sandboxPolicy: sandbox === 'danger-full-access' ? { type: 'dangerFullAccess' }
      : sandbox === 'read-only' ? { type: 'readOnly' }
      : { type: 'workspaceWrite', writableRoots: [], networkAccess: params.networkAccessEnabled === true },
  };
}

/** The direct-turn adapter shares the exact controller used by IM auto-forward and mirror. */
export function streamCodexAppServer(params: StreamChatParams, legacy: LLMProvider): ReadableStream<string> {
  let cleanup = () => {};
  let canceled = false;
  return new ReadableStream<string>({
    async start(controller) {
      const tempFiles: string[] = [];
      let closed = false;
      const emit = (type: Parameters<typeof sseEvent>[0], data: unknown) => { if (!closed && !canceled) controller.enqueue(sseEvent(type, data)); };
      const finish = () => { if (!closed) { closed = true; cleanup(); if (!canceled) controller.close(); } };
      try {
        const session = await prepareCodexAppServerSession(appServerThreadOptions(params));
        if (canceled) return;
        if (!session) {
          const reader = legacy.streamChat(params).getReader();
          cleanup = () => { void reader.cancel(); };
          while (!closed) { const next = await reader.read(); if (next.done) break; controller.enqueue(next.value); }
          finish(); return;
        }
        const { lifecycle, threadId } = session;
        session.direct = true;
        let cursor = lifecycle.recordsAfter(threadId).cursor;
        let turnId: string | undefined;
        let buffered: BridgeMirrorRecord[] = [];
        const startedTools = new Set<string>();
        const assistant = new Map<string, string>();
        const abort = () => { void lifecycle.interrupt(threadId).catch((error) => { emit('status', { message: String(error) }); }); };
        const consume = (record: BridgeMirrorRecord) => {
          if (record.turnId !== turnId) return;
          if (record.type === 'message' && record.role === 'assistant') {
            assistant.set(record.replacementKey || record.signature, record.content);
            emit('text_snapshot', [...assistant.values()].join('\n\n'));
          } else if (record.type === 'reasoning' || (record.type === 'message' && record.role === 'commentary')) emit('status', { reasoning: record.content });
          else if (record.type === 'tool_started' || record.type === 'tool_finished') {
            const id = record.toolId || record.signature;
            if (!startedTools.has(id)) { startedTools.add(id); emit('tool_use', { id, name: record.toolName, input: record.toolInput || {} }); }
            if (record.type === 'tool_finished') emit('tool_result', { tool_use_id: id, content: record.content, is_error: record.isError });
          } else if (record.type === 'context_usage') emit('context_usage', record.contextUsage);
          else if (record.type === 'plan_update') emit('task_update', { tasks: record.tasks || [], todos: record.tasks || [] });
          else if (record.type === 'task_complete' || record.type === 'task_aborted') {
            if (record.isError) emit('error', record.errorText || 'Codex 执行失败。');
            emit('result', {
              session_id: threadId, app_server_endpoint: session.endpoint,
              outcome: record.type === 'task_aborted' ? 'aborted' : record.isError ? 'failed' : 'completed',
            });
            emit('done', ''); finish();
          }
        };
        const changed = (id: string) => {
          if (id !== threadId || closed) return;
          const state = lifecycle.snapshot(threadId);
          if (state.attached === false) { emit('error', 'Bridge 已解除此线程的订阅；后端任务状态请在 Codex 中查看。'); emit('done', ''); finish(); return; }
          params.onRuntimeStatusChange?.(state.connection === 'ready' ? state.activity : 'disconnected');
          const delta = lifecycle.recordsAfter(threadId, cursor); cursor = delta.cursor;
          if (!turnId) { buffered.push(...delta.records); return; }
          for (const record of delta.records) consume(record);
        };
        const unsubscribe = lifecycle.onChange(changed);
        cleanup = () => {
          unsubscribe(); session.direct = false;
          params.abortController?.signal.removeEventListener('abort', abort);
          for (const file of tempFiles) fs.rmSync(file, { force: true });
        };
        emit('status', { session_id: threadId, app_server_endpoint: session.endpoint });
        if (params.abortController?.signal.aborted) { finish(); return; }
        params.abortController?.signal.addEventListener('abort', abort, { once: true });
        const images = buildTempImageFiles(params, tempFiles);
        const input: AppServerInput[] = [{ type: 'text', text: params.prompt }, ...images.map((path) => ({ type: 'localImage' as const, path }))];
        turnId = await lifecycle.submit(threadId, input, appServerTurnOptions(params));
        session.directTurnIds.add(turnId);
        if (params.abortController?.signal.aborted) abort();
        for (const record of buffered) consume(record);
        buffered = [];
        changed(threadId);
      } catch (error) {
        emit('error', error instanceof Error ? error.message : String(error));
        emit('done', ''); finish();
      }
    },
    cancel() { canceled = true; cleanup(); },
  });
}
