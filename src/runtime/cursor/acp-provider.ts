import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { TaskProgressInfo } from '../../domain/progress.js';
import type { LLMProvider, StreamChatParams } from '../contracts.js';
import { BRIDGE_SHUTDOWN_REASON } from '../contracts.js';
import { prepareTextAttachmentPrompt } from '../local-attachments.js';
import type { PendingPermissions } from '../permission-gateway.js';
import { sseEvent } from '../sse.js';
import { assertCursorAcpRestrictiveResume, cursorAcpSessionStorePath } from './acp-session-policy.js';
import { readCursorNativeTodos } from './cli-store.js';
import { CursorAcpClient, type CursorAcpClientOptions, type CursorAcpMessage } from './acp-client.js';

type Connection = Pick<CursorAcpClient, 'request' | 'notify' | 'respond' | 'reject' | 'onMessage' | 'onDisconnect' | 'connected'> & { close(): void | Promise<void> };
export interface CursorAcpProviderOptions {
  clientFactory?: (options: CursorAcpClientOptions) => Promise<Connection>;
  executable?: string;
  /** Extra root CLI arguments, before the final `acp` command. */
  args?: string[];
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  cancelTimeoutMs?: number;
  retryDelayMs?: number;
}

// Cursor CLI 2026.11 sends caught exceptions as one diagnostic text chunk,
// followed by end_turn. Interpret only that native envelope, never arbitrary
// answer text or tool output containing an error example.
function nativeErrorChunk(text: string): string | undefined {
  return /^\n\nError: ((?:(?:RetriableError|ConnectError|Error):|\[unauthenticated\])[^\r\n]+)$/.exec(text)?.[1];
}

function retryableError(message: string): 'resource_exhausted' | 'transport' | undefined {
  const detail = message.replace(/^Cursor ACP \(-?\d+\): /, '');
  if (/^RetriableError: \[resource_exhausted\] /.test(detail)) return 'resource_exhausted';
  if (/^RetriableError: \[(?:unavailable|deadline_exceeded)\] /.test(detail)
    || detail === 'RetriableError: [canceled] http/2 stream closed with error code CANCEL (0x8)') return 'transport';
  return undefined;
}

const RETRY_LIMIT = 2;
const RETRY_PROMPT = '上一次请求因临时服务错误中断。请继续本会话中尚未完成的任务，先核对已保存的进度和工具结果，不要重复已完成的操作。';
interface Session {
  bridgeId: string;
  nativeId?: string;
  cwd: string;
  force: boolean;
  model?: string;
  configOptions: Array<Record<string, any>>;
  todos: Map<string, { content: string; status: TaskProgressInfo['status'] | 'cancelled' }>;
  disposalError?: Error;
  client?: Connection;
  ready: Promise<void>;
}
interface Turn { cancel(): Promise<void>; done: Promise<void> }
const sessions = new Map<string, Session>();
const turns = new Map<string, Turn>();

function record(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function todoStatus(value: unknown): TaskProgressInfo['status'] | 'cancelled' {
  if (value === 'completed' || value === 3) return 'completed';
  if (value === 'in_progress' || value === 2) return 'in_progress';
  if (value === 'cancelled' || value === 4) return 'cancelled';
  return 'pending';
}

function updateTodos(session: Session, value: unknown, merge: boolean): TaskProgressInfo[] {
  if (!merge) session.todos.clear();
  for (const item of Array.isArray(value) ? value : []) {
    const todo = record(item);
    if (typeof todo.id !== 'string' || !todo.id) continue;
    const previous = session.todos.get(todo.id);
    const content = typeof todo.content === 'string' && todo.content.trim() ? todo.content.trim() : previous?.content;
    if (!content) continue;
    session.todos.set(todo.id, { content, status: todo.status === undefined && previous ? previous.status : todoStatus(todo.status) });
  }
  return [...session.todos.values()].filter(todo => todo.status !== 'cancelled')
    .map(todo => ({ text: todo.content, status: todo.status as TaskProgressInfo['status'] }));
}

function planTasks(value: unknown): TaskProgressInfo[] {
  return (Array.isArray(value) ? value : []).flatMap(item => {
    const entry = record(item), status = todoStatus(entry.status);
    return typeof entry.content === 'string' && entry.content.trim() && status !== 'cancelled'
      ? [{ text: entry.content.trim(), status }] : [];
  });
}
function sessionFor(id: string): Session | undefined {
  return sessions.get(id) || [...sessions.values()].find(session => session.nativeId === id);
}
async function disposeSession(session: Session): Promise<void> {
  try { await session.client?.close(); session.disposalError = undefined; }
  catch (error) { session.disposalError = error instanceof Error ? error : new Error(String(error)); throw session.disposalError; }
}
function forget(session: Session): void {
  if (sessions.get(session.bridgeId) === session) sessions.delete(session.bridgeId);
}

export async function interruptCursorAcpSession(sessionId: string): Promise<boolean> {
  const turn = turns.get(sessionFor(sessionId)?.bridgeId || sessionId);
  if (!turn) return false;
  try { await turn.cancel(); }
  finally { await turn.done; }
  return true;
}

export async function closeCursorAcpSession(sessionId: string): Promise<void> {
  const session = sessionFor(sessionId);
  if (!session) return;
  try { await interruptCursorAcpSession(session.bridgeId); }
  finally {
    await session.ready.catch(() => {});
    await disposeSession(session);
    forget(session);
  }
}

export function getCursorAcpSessionActivity(sessionId: string): 'idle' | 'active' | 'unknown' {
  const session = sessionFor(sessionId);
  if (session?.disposalError) return 'unknown';
  if (!turns.has(session?.bridgeId || sessionId)) return 'idle';
  return session?.client?.connected ? 'active' : 'unknown';
}

export async function closeAllCursorAcpSessions(): Promise<void> {
  await Promise.all([...sessions.keys()].map(closeCursorAcpSession));
}

export const closeCursorAcpSessions = closeAllCursorAcpSessions;

async function prepareSession(params: StreamChatParams, options: CursorAcpProviderOptions): Promise<Session> {
  const cwd = path.resolve(params.workingDirectory || process.cwd());
  const model = params.model?.trim() || undefined;
  const existing = sessions.get(params.sessionId);
  if (existing) {
    await existing.ready;
    if (existing.cwd === cwd && existing.nativeId === params.cursorSessionId
      && existing.force === (params.cursorForce === true) && existing.model === model && existing.client?.connected) return existing;
    // A cleared binding explicitly requests a new session. Finish disposing the old
    // process before changing identity, cwd or startup permissions.
    await disposeSession(existing);
    if (existing.force && params.cursorForce !== true && params.cursorSessionId === existing.nativeId) {
      throw new Error('当前 Cursor ACP 版本不能在保留此会话历史时关闭已启用的 Run Everything；旧进程已停止，未假装降低权限或提交新输入。');
    }
    forget(existing);
  }
  if (params.cursorSessionId && [...sessions.values()].some(s => s.nativeId === params.cursorSessionId)) {
    throw new Error('这个 Cursor ACP 会话已有执行者，未启动第二个进程。');
  }
  if (params.cursorSessionId && params.cursorForce === false) assertCursorAcpRestrictiveResume(params.cursorSessionId, options.env);
  const session: Session = { bridgeId: params.sessionId, nativeId: params.cursorSessionId, cwd, force: params.cursorForce === true, model, configOptions: [], todos: new Map(), ready: Promise.resolve() };
  sessions.set(params.sessionId, session);
  session.ready = (async () => {
    const client = await (options.clientFactory || CursorAcpClient.start)({
      // CLI --model resolves exact catalog variant IDs and their parameterValues.
      // ACP's parameterized model setter only accepts base IDs, so sending an
      // existing CLI variant (e.g. gemini-4-carbon-high) there would reject it.
      executable: options.executable, args: [...(options.args || []), ...(model ? ['--model', model] : []), ...(params.cursorForce === true ? ['--force'] : []), 'acp'],
      cwd, env: options.env, requestTimeoutMs: options.requestTimeoutMs,
    });
    session.client = client;
    // While loading, the server replays history through session/update. No stream listener
    // exists yet, so old text/tool calls cannot be delivered as a fresh answer.
    const loadingRequests = client.onMessage(message => {
      if (message.id !== undefined && message.method) client.reject(message.id, -32601, 'Client is loading the session');
    });
    try {
      const initialized = await client.request<Record<string, unknown>>('initialize', {
        protocolVersion: 1, clientInfo: { name: 'codelark', version: '0.6.0' },
        clientCapabilities: { _meta: { parameterizedModelPicker: true } },
      });
      if (params.cursorSessionId && record(initialized.agentCapabilities).loadSession !== true) {
        throw new Error('此 Cursor ACP 版本不能恢复会话，未创建替代会话或重发输入。');
      }
      await client.request('authenticate', { methodId: 'cursor_login' });
      if (params.cursorSessionId) {
        const loaded = await client.request<Record<string, any>>('session/load', { sessionId: params.cursorSessionId, cwd, mcpServers: [] }, 120_000);
        session.configOptions = Array.isArray(loaded.configOptions) ? loaded.configOptions : [];
        // Replay drops UpdateTodos.merge, so it cannot reconstruct an authoritative list.
        // Restore only the current todo snapshot once; never poll or replay old messages.
        const todos = readCursorNativeTodos(cursorAcpSessionStorePath(params.cursorSessionId, options.env));
        if (todos) updateTodos(session, todos, false);
      } else {
        const created = await client.request<{ sessionId?: string; configOptions?: Array<Record<string, any>> }>('session/new', { cwd, mcpServers: [] }, 120_000);
        if (!created.sessionId) throw new Error('Cursor ACP 未返回原生会话 ID。');
        session.nativeId = created.sessionId;
        session.configOptions = created.configOptions || [];
      }
    } finally { loadingRequests(); }
  })();
  try { await session.ready; return session; }
  catch (error) { await disposeSession(session); forget(session); throw error; }
}

function toolName(update: Record<string, any>): string {
  return ({ execute: 'Shell', read: 'Read', edit: 'apply_patch', delete: 'apply_patch', search: 'Search', fetch: 'WebFetch' } as Record<string, string>)[update.kind]
    || update.title || 'Cursor Tool';
}

function textLines(text: string): string[] {
  if (!text) return [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function patchDiffLines(beforeText: string, afterText: string): string[] {
  if (beforeText === afterText) return [];
  const before = textLines(beforeText), after = textLines(afterText);
  let prefix = 0, suffix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  while (suffix < before.length - prefix && suffix < after.length - prefix
    && before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix++;
  // A trailing newline change still needs a visible replacement of the last line.
  if (prefix === before.length && prefix === after.length) prefix = Math.max(0, prefix - 1);
  const start = Math.max(0, prefix - 3), tail = Math.min(3, suffix);
  const removed = before.slice(prefix, before.length - suffix).map(line => `-${line}`);
  const added = after.slice(prefix, after.length - suffix).map(line => `+${line}`);
  if (removed.length && !suffix && beforeText && !beforeText.endsWith('\n')) removed.push('\\ No newline at end of file');
  if (added.length && !suffix && afterText && !afterText.endsWith('\n')) added.push('\\ No newline at end of file');
  return [
    `@@ -${start + 1},${before.length - suffix + tail - start} +${start + 1},${after.length - suffix + tail - start} @@`,
    ...before.slice(start, prefix).map(line => ` ${line}`), ...removed, ...added,
    ...before.slice(before.length - suffix, before.length - suffix + tail).map(line => ` ${line}`),
  ];
}

function completedPatchInput(update: Record<string, any>, kind: string | undefined, cwd: string): { patch: string; workdir: string } | undefined {
  const diffs = (Array.isArray(update.content) ? update.content : []).map(record).filter(block =>
    block.type === 'diff' && typeof block.path === 'string' && typeof block.newText === 'string'
    && (block.oldText === null || typeof block.oldText === 'string'));
  if (!diffs.length) return undefined;
  const lines = ['*** Begin Patch'];
  for (const diff of diffs) {
    const action = kind === 'delete' ? 'Delete' : diff.oldText === null ? 'Add' : 'Update';
    lines.push(`*** ${action} File: ${diff.path}`);
    if (action === 'Update') lines.push(...patchDiffLines(diff.oldText, diff.newText));
    // Cursor 2026.11.17 uses DeleteSuccess.deletedFile (the path) as oldText,
    // dropping prevContent. A path placeholder is not deleted file content.
    else if (!(action === 'Delete' && diff.oldText === diff.path)) {
      lines.push(...textLines(action === 'Delete' ? diff.oldText || '' : diff.newText).map(line => `${action === 'Delete' ? '-' : '+'}${line}`));
    }
  }
  lines.push('*** End Patch');
  return { patch: lines.join('\n'), workdir: cwd };
}

function initialToolInput(update: Record<string, any>, cwd: string): unknown {
  const input = record(update.rawInput);
  if (!['edit', 'delete'].includes(update.kind) || typeof input.path !== 'string') return update.rawInput ?? {};
  return { ...input, patch: `*** Begin Patch\n*** ${update.kind === 'delete' ? 'Delete' : 'Update'} File: ${input.path}\n*** End Patch`, workdir: cwd };
}

function toolOutput(update: Record<string, any>, name: string): string {
  const content = Array.isArray(update.content) ? update.content.map((item: unknown) => {
    const block = record(item);
    return block.type === 'content' ? record(block.content).text || '' : block.type === 'diff' ? block.newText || '' : '';
  }).filter(Boolean).join('\n') : '';
  const raw = record(update.rawOutput);
  if (name === 'Shell' && (typeof raw.stdout === 'string' || typeof raw.stderr === 'string' || Number.isInteger(raw.exitCode))) {
    // Use the process envelope already understood by the shared Shell renderer.
    // Native ACP's camelCase exitCode would otherwise disappear inside raw JSON.
    const output = [raw.stdout, raw.stderr].filter(value => typeof value === 'string' && value.length > 0).join('\n') || content;
    return `${Number.isInteger(raw.exitCode) ? `Process exited with code ${raw.exitCode}\n` : ''}Output:\n${output}`;
  }
  if (content) return content;
  // Native Read wraps the actual file body in {content}. Match the existing
  // Cursor desktop path: keep visible text and its real newlines, not a JSON
  // string whose quotes/backslashes/newlines get escaped again by card JSON.
  for (const key of ['output', 'content', 'markdown', 'text']) {
    if (typeof raw[key] === 'string') return raw[key];
  }
  // Grep/Glob currently send only counts and truncation metadata through ACP.
  // Preserve exactly what the agent retained; do not invent or re-read results.
  return typeof update.rawOutput === 'string' ? update.rawOutput : update.rawOutput === undefined ? '' : JSON.stringify(update.rawOutput, null, 2);
}

/** Direct ACP owns the turn until prompt's terminal response, including cancellation. */
export class CursorAcpProvider implements LLMProvider {
  constructor(private pendingPerms?: PendingPermissions, private options: CursorAcpProviderOptions = {}) {}

  streamChat(params: StreamChatParams): ReadableStream<string> {
    let readerCanceled = false;
    let cancel = async () => {};
    const pendingPerms = this.pendingPerms;
    const options = this.options;
    return new ReadableStream<string>({
      async start(controller) {
        const emit = (type: string, data: unknown) => { if (!readerCanceled) controller.enqueue(sseEvent(type, data)); };
        if (turns.has(params.sessionId)) {
          emit('error', 'Cursor ACP 上一轮尚未确认结束，请等待中断确认后再提交。'); emit('done', ''); controller.close(); return;
        }
        let resolveDone!: () => void;
        const done = new Promise<void>(resolve => { resolveDone = resolve; });
        let session: Session | undefined;
        let promptPromise: Promise<Record<string, any>> | undefined;
        let cancellation: Promise<void> | undefined;
        let cancelFailure: Error | undefined;
        let interrupted = false;
        let acceptingUpdates = false;
        let unsubscribe = () => {};
        let continuationText: string | undefined;
        let accepted = false;
        let nativeFailure: string | undefined;
        let retryWake: (() => void) | undefined;
        const waitingPermissions = new Set<string>();
        const cancelPermissions = () => {
          for (const id of waitingPermissions) pendingPerms?.resolve(id, { behavior: 'deny', message: 'Cursor 请求已中断。' });
        };
        const cancelPrompt = async () => {
          if (!session?.client || !promptPromise) return;
          if (cancellation) return cancellation;
          const client = session.client;
          const pending = promptPromise;
          cancellation = (async () => {
            client.notify('session/cancel', { sessionId: session!.nativeId });
            cancelPermissions();
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              await Promise.race([pending, new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error('Cursor ACP 尚未确认中断，已关闭本连接防止重叠执行。')), options.cancelTimeoutMs ?? 15_000);
              })]);
            } catch (error) { cancelFailure = error instanceof Error ? error : new Error(String(error)); await disposeSession(session!); forget(session!); throw error; }
            finally { if (timer) clearTimeout(timer); }
          })();
          return cancellation;
        };
        cancel = async () => { interrupted = true; retryWake?.(); await cancelPrompt(); };
        const turn: Turn = { cancel, done };
        turns.set(params.sessionId, turn);
        const onAbort = () => { void cancel().catch(() => {}); };
        params.abortController?.signal.addEventListener('abort', onAbort, { once: true });
        const markAccepted = () => {
          if (accepted) return;
          accepted = true;
          params.onInputAccepted?.();
          params.onRuntimeStatusChange?.('running');
          emit('status', { reasoning: 'Cursor ACP 已接收消息，正在执行。' });
        };
        const waitPermission = async (message: CursorAcpMessage, isQuestion: boolean) => {
          const payload = record(message.params);
          const id = `cursor-acp:${params.sessionId}:${randomUUID()}`;
          if (!pendingPerms) throw new Error('Cursor ACP 需要交互确认，但当前没有权限或问卷通道。');
          waitingPermissions.add(id);
          const pending = pendingPerms.waitFor(id);
          emit('permission_request', {
            permissionRequestId: id,
            toolName: isQuestion ? 'Cursor AskQuestion' : record(payload.toolCall).title || 'Cursor Tool Permission',
            toolInput: isQuestion ? { title: payload.title, toolCallId: payload.toolCallId, questions: payload.questions, freeformContinuation: true }
              : { ...record(payload.toolCall), options: payload.options },
            suggestions: [],
          });
          params.onRuntimeStatusChange?.('waiting');
          try { return await pending; }
          finally { waitingPermissions.delete(id); params.onRuntimeStatusChange?.(interrupted ? 'interrupted' : 'running'); }
        };
        try {
          if (params.abortController?.signal.aborted) interrupted = true;
          if (interrupted) return;
          session = await prepareSession(params, options);
          const client = session.client!;
          emit('status', { session_id: session.nativeId, cwd: session.cwd });
          if (params.cursorReasoningEffort) {
            const reasoning = session.configOptions.find(option => option.category === 'thought_level');
            if (!reasoning || !reasoning.options?.some((option: any) => option.value === params.cursorReasoningEffort)) {
              throw new Error(`当前 Cursor ACP 模型不支持思考强度 ${params.cursorReasoningEffort}，未忽略设置或提交输入。`);
            }
            const configured = await client.request<Record<string, any>>('session/set_config_option', { sessionId: session.nativeId, configId: reasoning.id, value: params.cursorReasoningEffort });
            if (Array.isArray(configured.configOptions)) session.configOptions = configured.configOptions;
            if (session.configOptions.find(option => option.id === reasoning.id)?.currentValue !== params.cursorReasoningEffort) {
              throw new Error(`Cursor ACP 未确认思考强度 ${params.cursorReasoningEffort}，未提交输入。`);
            }
          }
          const tools = new Map<string, { name: string; kind?: string; complete: boolean }>();
          const handleRequest = async (message: CursorAcpMessage) => {
            if (message.id === undefined) return;
            const payload = record(message.params);
            if (payload.sessionId && payload.sessionId !== session!.nativeId) {
              client.reject(message.id, -32602, 'Session does not belong to this connection'); return;
            }
            if (!acceptingUpdates || interrupted) {
              client.respond(message.id, { outcome: { outcome: 'cancelled' } }); return;
            }
            if (message.method === 'session/request_permission') {
              markAccepted();
              const resolution = await waitPermission(message, false);
              const choices = Array.isArray(payload.options) ? payload.options : [];
              const option = choices.find((choice: any) => choice.kind === (resolution.behavior === 'allow' ? 'allow_once' : 'reject_once'));
              client.respond(message.id, interrupted || !option ? { outcome: { outcome: 'cancelled' } }
                : { outcome: { outcome: 'selected', optionId: option.optionId } });
            } else if (message.method === 'cursor/ask_question') {
              markAccepted();
              const resolution = await waitPermission(message, true);
              if (resolution.behavior !== 'allow' || interrupted) {
                client.respond(message.id, { outcome: { outcome: 'cancelled' } }); return;
              }
              let answers: Array<{ questionId: string; selectedOptionIds: string[]; freeformText?: string }>;
              try { answers = JSON.parse(resolution.message || '{}').answers; } catch { throw new Error('Cursor 问卷回答格式无效。'); }
              const questions = Array.isArray(payload.questions) ? payload.questions : [];
              if (!Array.isArray(answers) || answers.length !== questions.length || questions.some((question: any) => {
                const answer = answers.find(item => item.questionId === question.id);
                return !answer || !Array.isArray(answer.selectedOptionIds) || (!question.allowMultiple && answer.selectedOptionIds.length > 1)
                  || answer.selectedOptionIds.some(id => !question.options?.some((option: any) => option.id === id))
                  || (!answer.selectedOptionIds.length && !answer.freeformText?.trim());
              })) throw new Error('Cursor 问卷回答不符合当前问题。');
              if (answers.some(answer => answer.freeformText?.trim())) {
                continuationText = '以下是我对刚才问卷的回答，请据此继续原任务：\n' + questions.map((question: any) => {
                  const answer = answers.find(item => item.questionId === question.id)!;
                  const labels = answer.selectedOptionIds.map(id => question.options.find((option: any) => option.id === id)?.label || id);
                  return `${question.prompt}\n回答：${[...labels, answer.freeformText].filter(Boolean).join('；')}`;
                }).join('\n\n');
                // The native adapter drops freeformText. Cancel and wait for the old prompt;
                // then submit only these answers as a real new user message.
                const canceling = cancelPrompt();
                client.respond(message.id, { outcome: { outcome: 'cancelled' } });
                await canceling;
              } else client.respond(message.id, { outcome: { outcome: 'answered', answers } });
            } else if (message.method === 'cursor/update_todos') {
              const tasks = updateTodos(session!, payload.todos, payload.merge === true);
              emit('task_update', { tasks, todos: tasks }); client.respond(message.id, {});
            } else client.reject(message.id, -32601, `Unsupported client method: ${message.method}`);
          };
          unsubscribe = client.onMessage(message => {
            if (message.id !== undefined && message.method) {
              void handleRequest(message).catch(error => {
                if (client.connected) client.reject(message.id!, -32603, errorMessage(error));
                emit('status', { reasoning: errorMessage(error) });
              });
              return;
            }
            const payload = record(message.params);
            if (!acceptingUpdates || message.method !== 'session/update' || payload.sessionId !== session!.nativeId) return;
            const update = record(payload.update);
            if (update.sessionUpdate === 'plan') {
              const tasks = planTasks(update.entries);
              emit('task_update', { tasks, todos: tasks }); return;
            }
            if (!['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update'].includes(update.sessionUpdate)) return;
            markAccepted();
            if (update.sessionUpdate === 'agent_message_chunk') {
              const content = record(update.content);
              if (content.type === 'text' && typeof content.text === 'string') {
                const failure = nativeErrorChunk(content.text);
                if (failure) nativeFailure = failure;
                else emit('text', content.text);
              }
            } else if (update.sessionUpdate === 'agent_thought_chunk') {
              emit('status', { reasoning: 'Cursor 正在思考。' });
            } else if (typeof update.toolCallId === 'string') {
              let tool = tools.get(update.toolCallId);
              if (!tool) {
                tool = { name: toolName(update), kind: update.kind, complete: false }; tools.set(update.toolCallId, tool);
                emit('tool_use', { id: update.toolCallId, name: tool.name, input: initialToolInput(update, session!.cwd) });
              }
              if (!tool.complete && ['completed', 'failed', 'cancelled'].includes(update.status)) {
                tool.complete = true;
                const exitCode = record(update.rawOutput).exitCode;
                const patch = completedPatchInput(update, tool.kind || update.kind, session!.cwd);
                const missingDeleteContent = (tool.kind || update.kind) === 'delete' && Array.isArray(update.content)
                  && update.content.some((block: any) => block?.type === 'diff' && typeof block.path === 'string' && block.oldText === block.path);
                const output = [
                  toolOutput(patch ? { ...update, content: update.content.filter((block: any) => block?.type !== 'diff') } : update, tool.name),
                  missingDeleteContent ? 'Cursor 未提供删除前文件内容。' : '',
                ].filter(Boolean).join('\n');
                emit('tool_result', {
                  tool_use_id: update.toolCallId, content: output,
                  ...(patch ? { name: 'apply_patch', input: patch } : {}),
                  is_error: update.status !== 'completed' || (tool.name === 'Shell' && Number.isInteger(exitCode) && exitCode !== 0),
                  // Shared cards hide tool output unless the runtime explicitly retains it.
                  // Cursor's completed output is user-visible, just as in the tmux provider.
                  show_output: !patch || Boolean(output),
                });
              }
            }
          });
          let prompt = prepareTextAttachmentPrompt(params);
          if (!params.cursorSessionId && params.systemPrompt) prompt = `${params.systemPrompt}\n\n${prompt}`;
          let stopReason = 'cancelled';
          let retries = 0;
          while (!interrupted) {
            acceptingUpdates = true;
            cancellation = undefined;
            nativeFailure = undefined;
            promptPromise = client.request<Record<string, any>>('session/prompt', {
              sessionId: session.nativeId, prompt: [{ type: 'text', text: prompt }],
            }, 0);
            if (params.abortController?.signal.aborted) onAbort();
            let result: Record<string, any> | undefined;
            let failure: string | undefined;
            try { result = await promptPromise; }
            catch (error) { failure = errorMessage(error); }
            acceptingUpdates = false;
            if (cancellation) await cancellation;
            promptPromise = undefined;
            if (interrupted) break;
            failure ||= nativeFailure;
            if (failure) {
              // The old prompt has settled. Never retry an unconfirmed tool,
              // disconnected executor, or the user's cancellation.
              const retryKind = retryableError(failure);
              if (!retryKind || retries >= RETRY_LIMIT || !client.connected
                || [...tools.values()].some(tool => !tool.complete) || waitingPermissions.size) throw new Error(failure);
              retries++;
              // ACP only exposes the native diagnostic string, without Retry-After.
              // Capacity/quota failures need slower, bounded attempts, not a tight loop.
              const resourceExhausted = retryKind === 'resource_exhausted';
              const delayMs = Math.max(0, options.retryDelayMs ?? (resourceExhausted ? 30_000 : 1000)) * retries;
              const reason = resourceExhausted ? 'Cursor 上游资源或额度受限' : 'Cursor 连接临时中断';
              emit('status', { reasoning: `${reason}，${Math.ceil(delayMs / 1000)} 秒后自动续接（${retries}/${RETRY_LIMIT}）。` });
              await new Promise<void>(resolve => {
                const timer = setTimeout(resolve, delayMs);
                retryWake = () => { clearTimeout(timer); resolve(); };
              });
              retryWake = undefined;
              if (interrupted) break;
              prompt = RETRY_PROMPT;
              continue;
            }
            stopReason = typeof result?.stopReason === 'string' ? result.stopReason : 'unknown';
            if (continuationText && !interrupted) {
              prompt = continuationText; continuationText = undefined; tools.clear();
              emit('status', { reasoning: '自由文本回答已保留，正在作为新消息继续原任务。' });
              continue;
            }
            break;
          }
          if (interrupted) stopReason = 'cancelled';
          if (stopReason !== 'cancelled') markAccepted();
          if (!['end_turn', 'cancelled'].includes(stopReason)) emit('error', `Cursor ACP 本轮未正常完成：${stopReason}`);
          emit('result', { session_id: session.nativeId, outcome: stopReason === 'cancelled' ? 'aborted' : stopReason === 'end_turn' ? 'completed' : 'failed', stop_reason: stopReason });
        } catch (error) {
          let failure = cancelFailure || error;
          if (session?.client && !session.client.connected) {
            try { await disposeSession(session); } catch (closeError) { failure = closeError; }
          }
          emit('error', errorMessage(failure));
          emit('result', { ...(session?.nativeId ? { session_id: session.nativeId } : {}), outcome: 'failed' });
        } finally {
          acceptingUpdates = false; unsubscribe(); cancelPermissions();
          emit('status', { clear_pending_questions: true });
          params.abortController?.signal.removeEventListener('abort', onAbort);
          if (turns.get(params.sessionId) === turn) turns.delete(params.sessionId);
          if (params.abortController?.signal.reason === BRIDGE_SHUTDOWN_REASON && session) {
            try { await disposeSession(session); forget(session); } catch (error) { emit('error', errorMessage(error)); }
          }
          emit('done', '');
          if (!readerCanceled) controller.close();
          resolveDone();
        }
      },
      async cancel() { readerCanceled = true; await cancel(); },
    });
  }
}
