import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TaskProgressInfo } from '../../domain/progress.js';
import type { LLMProvider, StreamChatParams } from '../contracts.js';
import { BRIDGE_SHUTDOWN_REASON } from '../contracts.js';
import { cursorAcpCommandNotice, isCursorControlPrompt, prepareCursorAcpPrompt } from './acp-commands.js';
import type { PendingPermissions } from '../permission-gateway.js';
import { sseEvent } from '../sse.js';
import { assertCursorAcpRestrictiveResume, cursorAcpSessionStorePath } from './acp-session-policy.js';
import { readCursorNativeTodos } from './cli-store.js';
import { CursorAcpClient, resolveCursorAcpExecutable, type CursorAcpClientOptions, type CursorAcpMessage } from './acp-client.js';
import {
  getSharedAcpHostClient,
  peekSharedAcpHostClient,
  tryConnectExistingAcpHost,
  type AcpHostClient,
} from '../acp/host-client.js';
import {
  makeAcpSessionKey,
  type AcpPendingServerRequest,
  type AcpTurnSnapshot,
} from '../acp/host-protocol.js';
import { consumeHostedAcpTurn } from '../acp/hosted-session.js';

type Connection = Pick<CursorAcpClient, 'request' | 'notify' | 'respond' | 'reject' | 'onMessage' | 'onDisconnect' | 'connected'> & { close(): void | Promise<void> };
export interface CursorAcpProviderOptions {
  clientFactory?: (options: CursorAcpClientOptions) => Promise<Connection>;
  hostClient?: AcpHostClient;
  useHost?: boolean;
  executable?: string;
  /** Extra root CLI arguments, before the final `acp` command. */
  args?: string[];
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  cancelTimeoutMs?: number;
  retryDelayMs?: number;
}

function shouldUseCursorAcpHost(options: CursorAcpProviderOptions): boolean {
  if (options.hostClient) return true;
  if (options.useHost === false || options.clientFactory) return false;
  if (options.useHost === true) return true;
  return process.env.CODELARK_ACP_HOST_DISABLE !== '1';
}

const hostedCursorAppliedEffort = new Map<string, string>();
const hostedCursorForce = new Map<string, boolean>();

function isCursorAuthOrPlanError(message: string): boolean {
  return /\[unauthenticated\]|authentication required|not logged in|login required|upgrade your plan to continue/i.test(message);
}

function isStandalonePlanLimitText(text: string): boolean {
  return /^upgrade your plan to continue\.?$/i.test(text.trim());
}

const PLAN_LIMIT_FAILURE_MESSAGE = 'Upgrade your plan to continue（Cursor 账号认证或套餐额度受限，已回收旧 ACP 进程；请确认重新登录后重试。）';

function readCursorAuthStamp(env?: NodeJS.ProcessEnv): string {
  const effectiveEnv = env ? { ...process.env, ...env } : process.env;
  const home = effectiveEnv.HOME?.trim() || os.homedir();
  const candidates = new Set<string>();
  if (effectiveEnv.CURSOR_CONFIG_DIR?.trim()) {
    candidates.add(path.join(effectiveEnv.CURSOR_CONFIG_DIR.trim(), 'auth.json'));
  }
  const xdgConfig = effectiveEnv.XDG_CONFIG_HOME?.trim() || path.join(home, '.config');
  candidates.add(path.join(xdgConfig, 'cursor', 'auth.json'));
  candidates.add(path.join(home, '.cursor', 'auth.json'));

  const hash = createHash('sha256');
  let hasMaterial = false;
  if (effectiveEnv.CURSOR_API_KEY) {
    hash.update('api_key:');
    hash.update(effectiveEnv.CURSOR_API_KEY);
    hash.update('\0');
    hasMaterial = true;
  }
  for (const filePath of [...candidates].sort()) {
    try {
      const content = fs.readFileSync(filePath);
      hash.update(filePath);
      hash.update(':');
      hash.update(content);
      hash.update('\0');
      hasMaterial = true;
    } catch {
      // Ignore missing or unreadable auth files.
    }
  }
  return hasMaterial ? hash.digest('hex').slice(0, 16) : '';
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
  authStamp: string;
  appliedReasoningEffort?: string;
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
  if (turn) {
    try { await turn.cancel(); }
    finally { await turn.done; }
    return true;
  }
  const host = peekSharedAcpHostClient() || (process.env.CODELARK_ACP_HOST_DISABLE !== '1' ? await tryConnectExistingAcpHost() : null);
  if (!host) return false;
  const res = await host.cancelTurn({ sessionKey: makeAcpSessionKey('cursor', sessionId) }).catch(() => ({ cancelled: false }));
  return res.cancelled;
}

export async function closeCursorAcpSession(sessionId: string): Promise<void> {
  hostedCursorAppliedEffort.delete(sessionId);
  hostedCursorForce.delete(sessionId);
  const session = sessionFor(sessionId);
  if (session) {
    try { await interruptCursorAcpSession(session.bridgeId); }
    finally {
      await session.ready.catch(() => {});
      await disposeSession(session);
      forget(session);
    }
  }
  const host = peekSharedAcpHostClient() || (process.env.CODELARK_ACP_HOST_DISABLE !== '1' ? await tryConnectExistingAcpHost() : null);
  if (host) {
    await host.closeSession(makeAcpSessionKey('cursor', sessionId)).catch(() => {});
  }
}

export function getCursorAcpSessionActivity(sessionId: string): 'idle' | 'active' | 'unknown' {
  const host = peekSharedAcpHostClient();
  const hosted = host?.getCachedSession(makeAcpSessionKey('cursor', sessionId));
  if (hosted) {
    if (hosted.disposalError || hosted.state === 'failed') return 'unknown';
    if (hosted.state === 'running' || hosted.state === 'waiting_permission' || hosted.state === 'cancelling') return 'active';
    return 'idle';
  }
  const session = sessionFor(sessionId);
  if (session?.disposalError) return 'unknown';
  if (!turns.has(session?.bridgeId || sessionId)) return 'idle';
  return session?.client?.connected ? 'active' : 'unknown';
}

export async function closeAllCursorAcpSessions(): Promise<void> {
  await Promise.all([...sessions.keys()].map(closeCursorAcpSession));
}

/** Detach bridge-local state during bridge shutdown without killing persistent hosted ACP sessions. */
export async function detachCursorAcpHostSessions(): Promise<void> {
  hostedCursorAppliedEffort.clear();
  hostedCursorForce.clear();
  await Promise.all([...sessions.keys()].map(async (sessionId) => {
    const session = sessionFor(sessionId);
    if (!session) return;
    await disposeSession(session).catch(() => {});
    forget(session);
  }));
}

export const closeCursorAcpSessions = closeAllCursorAcpSessions;

function isBooleanThoughtOption(option: Record<string, any>): boolean {
  const values = Array.isArray(option.options)
    ? option.options.map((entry: any) => String(entry?.value ?? '').trim().toLowerCase()).filter(Boolean)
    : [];
  return values.length > 0 && values.every(value => value === 'true' || value === 'false');
}

function thoughtLevelCandidateValues(requestedEffort: string): string[] {
  const normalized = requestedEffort.trim().toLowerCase();
  if (normalized === 'xhigh') return ['xhigh', 'extra-high'];
  if (normalized === 'extra-high') return ['extra-high', 'xhigh'];
  return normalized ? [normalized] : [];
}

function resolveCursorThoughtLevelOption(
  configOptions: Array<Record<string, any>>,
  requestedEffort: string,
): {
  option?: Record<string, any>;
  targetValue?: string;
  thinkingToggle?: Record<string, any>;
  availableSummary?: string;
} {
  const thoughtOptions = configOptions.filter(option => option.category === 'thought_level');
  if (thoughtOptions.length === 0) return {};
  const rank = (option: Record<string, any>): number => {
    if (isBooleanThoughtOption(option)) return 2;
    const id = String(option.id || '').toLowerCase();
    return id === 'effort' || id === 'reasoning_effort' || id === 'reasoning' ? 0 : 1;
  };
  const ordered = [...thoughtOptions].sort((a, b) => rank(a) - rank(b));
  const candidates = thoughtLevelCandidateValues(requestedEffort);
  const thinkingToggle = thoughtOptions.find(option => isBooleanThoughtOption(option));
  for (const option of ordered) {
    const entries = Array.isArray(option.options) ? option.options : [];
    for (const candidate of candidates) {
      const matched = entries.find((entry: any) => String(entry?.value ?? '').trim().toLowerCase() === candidate);
      if (matched && typeof matched.value === 'string') {
        return {
          option,
          targetValue: matched.value,
          ...(thinkingToggle && thinkingToggle !== option ? { thinkingToggle } : {}),
        };
      }
    }
  }
  const effortOption = ordered.find(option => !isBooleanThoughtOption(option));
  const availableValues = Array.isArray(effortOption?.options)
    ? effortOption.options.map((entry: any) => String(entry?.value ?? '').trim()).filter(Boolean)
    : [];
  const availableSummary = availableValues.length > 0
    ? `可选：${availableValues.join(' / ')}`
    : thinkingToggle
      ? '该模型仅支持思考开关（true/false），不支持分档思考强度'
      : undefined;
  return { availableSummary };
}

async function prepareSession(params: StreamChatParams, options: CursorAcpProviderOptions): Promise<Session> {
  const cwd = path.resolve(params.workingDirectory || process.cwd());
  const model = params.model?.trim() || undefined;
  const requestedEffort = params.cursorReasoningEffort?.trim() || undefined;
  const authStamp = readCursorAuthStamp(options.env);
  const existing = sessions.get(params.sessionId);
  if (existing) {
    await existing.ready;
    const clearedReasoningOverride = Boolean(existing.appliedReasoningEffort && !requestedEffort);
    if (existing.cwd === cwd && existing.nativeId === params.cursorSessionId
      && existing.force === (params.cursorForce === true) && existing.model === model
      && existing.authStamp === authStamp
      && !clearedReasoningOverride && existing.client?.connected) return existing;
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
  const session: Session = { bridgeId: params.sessionId, nativeId: params.cursorSessionId, cwd, force: params.cursorForce === true, model, authStamp, configOptions: [], todos: new Map(), ready: Promise.resolve() };
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
    const commandNotice = cursorAcpCommandNotice(params.prompt);
    if (commandNotice) return new ReadableStream({ start(controller) {
      controller.enqueue(sseEvent('error', commandNotice));
      controller.enqueue(sseEvent('result', { outcome: 'failed' }));
      controller.enqueue(sseEvent('done', ''));
      controller.close();
    } });
    if (shouldUseCursorAcpHost(this.options)) {
      return this.streamHostedChat(params);
    }
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
            const resolved = resolveCursorThoughtLevelOption(session.configOptions, params.cursorReasoningEffort);
            if (!resolved.option || !resolved.targetValue) {
              const detail = resolved.availableSummary ? `（${resolved.availableSummary}）` : '';
              throw new Error(`当前 Cursor ACP 模型不支持思考强度 ${params.cursorReasoningEffort}${detail}，未忽略设置或提交输入。`);
            }
            if (
              resolved.thinkingToggle
              && String(resolved.thinkingToggle.currentValue ?? '').trim().toLowerCase() === 'false'
              && Array.isArray(resolved.thinkingToggle.options)
              && resolved.thinkingToggle.options.some((entry: any) => String(entry?.value ?? '').trim().toLowerCase() === 'true')
            ) {
              const enabled = await client.request<Record<string, any>>('session/set_config_option', {
                sessionId: session.nativeId,
                configId: resolved.thinkingToggle.id,
                value: 'true',
              });
              if (Array.isArray(enabled.configOptions)) session.configOptions = enabled.configOptions;
            }
            const configured = await client.request<Record<string, any>>('session/set_config_option', {
              sessionId: session.nativeId,
              configId: resolved.option.id,
              value: resolved.targetValue,
            });
            if (Array.isArray(configured.configOptions)) session.configOptions = configured.configOptions;
            if (session.configOptions.find(option => option.id === resolved.option!.id)?.currentValue !== resolved.targetValue) {
              throw new Error(`Cursor ACP 未确认思考强度 ${params.cursorReasoningEffort}，未提交输入。`);
            }
            session.appliedReasoningEffort = resolved.targetValue;
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
          let emittedTextInTurn = false;
          let needsTextBoundary = false;
          let turnTextSample = '';
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
            if (update.sessionUpdate === 'codelark_goal_update') {
              needsTextBoundary = true;
              emit('status', { reasoning: update.continuing ? '目标尚未完成，Cursor 正在自动继续。' : ({ 2: 'Cursor 目标已暂停。', 3: 'Cursor 目标已完成。', 4: 'Cursor 目标已清除。' } as Record<number, string>)[Number(record(update.goal).status)] || 'Cursor 目标已停止。' });
              return;
            }
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
                else if (content.text.length > 0) {
                  if (turnTextSample.length < 256) {
                    turnTextSample += content.text.slice(0, 256 - turnTextSample.length);
                  }
                  const text = needsTextBoundary && emittedTextInTurn && !content.text.startsWith('\n')
                    ? `\n\n${content.text}`
                    : content.text;
                  emittedTextInTurn = true;
                  needsTextBoundary = false;
                  emit('text', text);
                }
              }
            } else if (update.sessionUpdate === 'agent_thought_chunk') {
              if (emittedTextInTurn) needsTextBoundary = true;
              emit('status', { reasoning: 'Cursor 正在思考。' });
            } else if (typeof update.toolCallId === 'string') {
              let tool = tools.get(update.toolCallId);
              if (!tool) {
                if (emittedTextInTurn) needsTextBoundary = true;
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
          let prompt = prepareCursorAcpPrompt(params);
          let stopReason = 'cancelled';
          let retries = 0;
          while (!interrupted) {
            acceptingUpdates = true;
            cancellation = undefined;
            nativeFailure = undefined;
            turnTextSample = '';
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
            if (!failure && tools.size === 0 && isStandalonePlanLimitText(turnTextSample)) {
              failure = PLAN_LIMIT_FAILURE_MESSAGE;
            }
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
              emittedTextInTurn = false; needsTextBoundary = false; turnTextSample = '';
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
          if (session && ((session.client && !session.client.connected) || isCursorAuthOrPlanError(errorMessage(failure)))) {
            try { await disposeSession(session); forget(session); } catch (closeError) { failure = closeError; }
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

  private streamHostedChat(params: StreamChatParams): ReadableStream<string> {
    let readerCanceled = false;
    const pendingPerms = this.pendingPerms;
    const options = this.options;
    let activeHost: AcpHostClient | undefined;
    let activeTurnId: string | undefined;

    return new ReadableStream<string>({
      async start(controller) {
        const emit = (type: string, data: unknown) => {
          if (!readerCanceled) controller.enqueue(sseEvent(type, data));
        };
        const waitingPermissions = new Map<string, string>(); // requestKey -> permissionRequestId
        const cancelLocalPermissions = () => {
          for (const permId of waitingPermissions.values()) {
            pendingPerms?.resolve(permId, { behavior: 'deny', message: 'Cursor 请求已中断。' });
          }
          waitingPermissions.clear();
        };

        let accepted = false;
        const markAccepted = () => {
          if (accepted) return;
          accepted = true;
          params.onInputAccepted?.();
          params.onRuntimeStatusChange?.('running');
          emit('status', { reasoning: 'Cursor ACP 已接收消息，正在执行。' });
        };

        try {
          if (params.abortController?.signal.aborted) {
            if (params.abortController.signal.reason === BRIDGE_SHUTDOWN_REASON) {
              emit('result', { detached: true });
            } else {
              emit('result', { outcome: 'aborted', stop_reason: 'cancelled' });
            }
            return;
          }

          const host = options.hostClient || (params.reattachAcpTurnId
            ? await tryConnectExistingAcpHost()
            : await getSharedAcpHostClient());
          if (!host) throw new Error('待续接的 Cursor ACP 后台暂时无法连接。');
          activeHost = host;
          if (!params.reattachAcpTurnId && isCursorControlPrompt(params.prompt)
            && !(await host.hello()).capabilities?.cursorCommands) {
            throw new Error('ACP 后台仍在完成更新前的任务；本条命令未执行，旧任务结束后将自动升级。');
          }
          const sessionKey = makeAcpSessionKey('cursor', params.sessionId);
          const cwd = path.resolve(params.workingDirectory || process.cwd());
          const model = params.model?.trim() || undefined;
          const requestedEffort = params.cursorReasoningEffort?.trim() || undefined;
          const todos = new Map<string, TaskProgressInfo>();
          const todoHolder = { todos } as unknown as Session;

          let currentTurn: AcpTurnSnapshot;
          let nativeSessionId: string | undefined = params.cursorSessionId;
          let effectiveCwd = cwd;

          if (params.reattachAcpTurnId) {
            const fetched = await host.getTurn(params.reattachAcpTurnId);
            if (!fetched) {
              throw new Error(`找不到待续接的 Cursor ACP 轮次：${params.reattachAcpTurnId}`);
            }
            currentTurn = fetched;
            nativeSessionId = fetched.nativeSessionId || params.cursorSessionId;
            effectiveCwd = fetched.meta.cwd || cwd;
            emit('status', { ...(nativeSessionId ? { session_id: nativeSessionId } : {}), cwd: effectiveCwd });
          } else {
            if (params.cursorSessionId && params.cursorForce === false) {
              assertCursorAcpRestrictiveResume(params.cursorSessionId, options.env);
            }
            const previousForce = hostedCursorForce.get(params.sessionId);
            const existingStatus = await host.getSessionStatus(sessionKey).catch(() => null);
            if (
              previousForce === true
              && params.cursorForce !== true
              && params.cursorSessionId
              && existingStatus?.nativeSessionId === params.cursorSessionId
            ) {
              await host.closeSession(sessionKey).catch(() => {});
              throw new Error('当前 Cursor ACP 版本不能在保留此会话历史时关闭已启用的 Run Everything；旧进程已停止，未假装降低权限或提交新输入。');
            }
            const clearedReasoningOverride = Boolean(hostedCursorAppliedEffort.get(params.sessionId) && !requestedEffort);
            const authStamp = readCursorAuthStamp(options.env);
            const fingerprint = JSON.stringify({
              cwd,
              nativeId: params.cursorSessionId || '',
              force: params.cursorForce === true,
              model: model || '',
              authStamp,
              ...(clearedReasoningOverride ? { resetAt: Date.now() } : {}),
            });
            const ensured = await host.ensureSession({
              sessionKey,
              runtime: 'cursor',
              bridgeSessionId: params.sessionId,
              executable: options.executable || resolveCursorAcpExecutable(),
              args: [...(options.args || []), ...(model ? ['--model', model] : []), ...(params.cursorForce === true ? ['--force'] : []), 'acp'],
              cwd,
              env: options.env as Record<string, string | undefined> | undefined,
              requestTimeoutMs: options.requestTimeoutMs,
              label: 'Cursor ACP',
              fingerprint,
              initializeParams: {
                protocolVersion: 1,
                clientInfo: { name: 'codelark', version: '0.6.0' },
                clientCapabilities: { _meta: { parameterizedModelPicker: true } },
              },
              authenticateParams: { methodId: 'cursor_login' },
              nativeSessionId: params.cursorSessionId,
              requireLoadCapability: true,
              loadUnsupportedMessage: '此 Cursor ACP 版本不能恢复会话，未创建替代会话或重发输入。',
              duplicateNativeMessage: '这个 Cursor ACP 会话已有执行者，未启动第二个进程。',
              missingNativeIdMessage: 'Cursor ACP 未返回原生会话 ID。',
            });
            hostedCursorForce.set(params.sessionId, params.cursorForce === true);
            if (clearedReasoningOverride) hostedCursorAppliedEffort.delete(params.sessionId);

            let configOptions = ensured.session.configOptions as Array<Record<string, any>>;
            nativeSessionId = ensured.session.nativeSessionId;
            if (!ensured.reused && params.cursorSessionId) {
              const savedTodos = readCursorNativeTodos(cursorAcpSessionStorePath(params.cursorSessionId, options.env));
              if (savedTodos) updateTodos(todoHolder, savedTodos, false);
            }
            emit('status', { session_id: nativeSessionId, cwd });

            if (requestedEffort) {
              const resolved = resolveCursorThoughtLevelOption(configOptions, requestedEffort);
              if (!resolved.option || !resolved.targetValue) {
                const detail = resolved.availableSummary ? `（${resolved.availableSummary}）` : '';
                throw new Error(`当前 Cursor ACP 模型不支持思考强度 ${requestedEffort}${detail}，未忽略设置或提交输入。`);
              }
              if (
                resolved.thinkingToggle
                && String(resolved.thinkingToggle.currentValue ?? '').trim().toLowerCase() === 'false'
                && Array.isArray(resolved.thinkingToggle.options)
                && resolved.thinkingToggle.options.some((entry: any) => String(entry?.value ?? '').trim().toLowerCase() === 'true')
              ) {
                const enabled = await host.sessionRpc({
                  sessionKey,
                  method: 'session/set_config_option',
                  params: { sessionId: nativeSessionId, configId: resolved.thinkingToggle.id, value: 'true' },
                });
                configOptions = enabled.session.configOptions as Array<Record<string, any>>;
              }
              const configured = await host.sessionRpc({
                sessionKey,
                method: 'session/set_config_option',
                params: { sessionId: nativeSessionId, configId: resolved.option.id, value: resolved.targetValue },
              });
              configOptions = configured.session.configOptions as Array<Record<string, any>>;
              if (configOptions.find(option => option.id === resolved.option!.id)?.currentValue !== resolved.targetValue) {
                throw new Error(`Cursor ACP 未确认思考强度 ${requestedEffort}，未提交输入。`);
              }
              hostedCursorAppliedEffort.set(params.sessionId, resolved.targetValue);
            }

            const prompt = prepareCursorAcpPrompt(params);
            const started = await host.startTurn({
              sessionKey,
              prompt: [{ type: 'text', text: prompt }],
              meta: {
                runtime: 'cursor',
                bridgeSessionId: params.sessionId,
                channelType: params.acpTurnContext?.channelType,
                chatId: params.acpTurnContext?.chatId,
                requestMessageId: params.acpTurnContext?.requestMessageId,
                userText: params.acpTurnContext?.userText,
                model,
                cwd,
                cursorForce: params.cursorForce === true,
              },
            });
            currentTurn = started.turn;
          }

          let retries = 0;
          let continuationText: string | undefined;

          for (;;) {
            activeTurnId = currentTurn.turnId;
            params.onHostedAcpTurn?.(currentTurn.turnId);

            const tools = new Map<string, { name: string; kind?: string; complete: boolean }>();
            let emittedTextInTurn = false;
            let needsTextBoundary = false;
            let nativeFailure: string | undefined;
            let turnTextSample = '';

            const waitPermission = async (req: AcpPendingServerRequest, isQuestion: boolean) => {
              const payload = record(req.params);
              const reqKey = `${typeof req.requestId}:${String(req.requestId)}`;
              const id = `cursor-acp:${params.sessionId}:${randomUUID()}`;
              if (!pendingPerms) throw new Error('Cursor ACP 需要交互确认，但当前没有权限或问卷通道。');
              waitingPermissions.set(reqKey, id);
              const pending = pendingPerms.waitFor(id);
              emit('permission_request', {
                permissionRequestId: id,
                toolName: isQuestion ? 'Cursor AskQuestion' : record(payload.toolCall).title || 'Cursor Tool Permission',
                toolInput: isQuestion
                  ? { title: payload.title, toolCallId: payload.toolCallId, questions: payload.questions, freeformContinuation: true }
                  : { ...record(payload.toolCall), options: payload.options },
                suggestions: [],
              });
              params.onRuntimeStatusChange?.('waiting');
              try {
                return await pending;
              } finally {
                waitingPermissions.delete(reqKey);
                if (params.abortController?.signal.reason !== BRIDGE_SHUTDOWN_REASON) {
                  params.onRuntimeStatusChange?.(params.abortController?.signal.aborted ? 'interrupted' : 'running');
                }
              }
            };

            const outcome = await consumeHostedAcpTurn(host, currentTurn, {
              onReplayComplete: () => emit('history_replay_complete', {}),
              abortSignal: params.abortController?.signal,
              cancelTimeoutMs: options.cancelTimeoutMs,
              onSessionUpdate: (payload) => {
                const update = record(payload.update);
                if (update.sessionUpdate === 'codelark_goal_update') {
                  needsTextBoundary = true;
                  emit('status', { reasoning: update.continuing ? '目标尚未完成，Cursor 正在自动继续。' : ({ 2: 'Cursor 目标已暂停。', 3: 'Cursor 目标已完成。', 4: 'Cursor 目标已清除。' } as Record<number, string>)[Number(record(update.goal).status)] || 'Cursor 目标已停止。' });
                  return;
                }
                if (update.sessionUpdate === 'codelark_cursor_update_todos') {
                  const tasks = updateTodos(todoHolder, update.todos, update.merge === true);
                  emit('task_update', { tasks, todos: tasks });
                  return;
                }
                if (update.sessionUpdate === 'plan') {
                  const tasks = planTasks(update.entries);
                  emit('task_update', { tasks, todos: tasks });
                  return;
                }
                if (!['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update'].includes(update.sessionUpdate)) return;
                markAccepted();
                if (update.sessionUpdate === 'agent_message_chunk') {
                  const content = record(update.content);
                  if (content.type === 'text' && typeof content.text === 'string') {
                    const failure = nativeErrorChunk(content.text);
                    if (failure) nativeFailure = failure;
                    else if (content.text.length > 0) {
                      if (turnTextSample.length < 256) {
                        turnTextSample += content.text.slice(0, 256 - turnTextSample.length);
                      }
                      const text = needsTextBoundary && emittedTextInTurn && !content.text.startsWith('\n')
                        ? `\n\n${content.text}`
                        : content.text;
                      emittedTextInTurn = true;
                      needsTextBoundary = false;
                      emit('text', text);
                    }
                  }
                } else if (update.sessionUpdate === 'agent_thought_chunk') {
                  if (emittedTextInTurn) needsTextBoundary = true;
                  emit('status', { reasoning: 'Cursor 正在思考。' });
                } else if (typeof update.toolCallId === 'string') {
                  let tool = tools.get(update.toolCallId);
                  if (!tool) {
                    if (emittedTextInTurn) needsTextBoundary = true;
                    tool = { name: toolName(update), kind: update.kind, complete: false };
                    tools.set(update.toolCallId, tool);
                    emit('tool_use', { id: update.toolCallId, name: tool.name, input: initialToolInput(update, effectiveCwd) });
                  }
                  if (!tool.complete && ['completed', 'failed', 'cancelled'].includes(update.status)) {
                    tool.complete = true;
                    const exitCode = record(update.rawOutput).exitCode;
                    const patch = completedPatchInput(update, tool.kind || update.kind, effectiveCwd);
                    const missingDeleteContent = (tool.kind || update.kind) === 'delete' && Array.isArray(update.content)
                      && update.content.some((block: any) => block?.type === 'diff' && typeof block.path === 'string' && block.oldText === block.path);
                    const output = [
                      toolOutput(patch ? { ...update, content: update.content.filter((block: any) => block?.type !== 'diff') } : update, tool.name),
                      missingDeleteContent ? 'Cursor 未提供删除前文件内容。' : '',
                    ].filter(Boolean).join('\n');
                    emit('tool_result', {
                      tool_use_id: update.toolCallId,
                      content: output,
                      ...(patch ? { name: 'apply_patch', input: patch } : {}),
                      is_error: update.status !== 'completed' || (tool.name === 'Shell' && Number.isInteger(exitCode) && exitCode !== 0),
                      show_output: !patch || Boolean(output),
                    });
                  }
                }
              },
              onServerRequest: async (req) => {
                const payload = record(req.params);
                if (req.method === 'session/request_permission') {
                  markAccepted();
                  const resolution = await waitPermission(req, false);
                  if (params.abortController?.signal.reason === BRIDGE_SHUTDOWN_REASON) return;
                  const choices = Array.isArray(payload.options) ? payload.options : [];
                  const option = choices.find((choice: any) => choice.kind === (resolution.behavior === 'allow' ? 'allow_once' : 'reject_once'));
                  await host.respondTurnRequest({
                    turnId: currentTurn.turnId,
                    requestId: req.requestId,
                    result: params.abortController?.signal.aborted || !option
                      ? { outcome: { outcome: 'cancelled' } }
                      : { outcome: { outcome: 'selected', optionId: option.optionId } },
                  });
                } else if (req.method === 'cursor/ask_question') {
                  markAccepted();
                  const resolution = await waitPermission(req, true);
                  if (params.abortController?.signal.reason === BRIDGE_SHUTDOWN_REASON) return;
                  if (resolution.behavior !== 'allow' || params.abortController?.signal.aborted) {
                    await host.respondTurnRequest({
                      turnId: currentTurn.turnId,
                      requestId: req.requestId,
                      result: { outcome: { outcome: 'cancelled' } },
                    });
                    return;
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
                    await host.respondTurnRequest({
                      turnId: currentTurn.turnId,
                      requestId: req.requestId,
                      result: { outcome: { outcome: 'cancelled' } },
                    });
                    await host.cancelTurn({ turnId: currentTurn.turnId, cancelTimeoutMs: options.cancelTimeoutMs });
                  } else {
                    await host.respondTurnRequest({
                      turnId: currentTurn.turnId,
                      requestId: req.requestId,
                      result: { outcome: { outcome: 'answered', answers } },
                    });
                  }
                } else {
                  await host.respondTurnRequest({
                    turnId: currentTurn.turnId,
                    requestId: req.requestId,
                    error: { code: -32601, message: `Unsupported client method: ${req.method}` },
                  });
                }
              },
              onServerRequestResolved: (requestId) => {
                const reqKey = `${typeof requestId}:${String(requestId)}`;
                const permId = waitingPermissions.get(reqKey);
                if (permId) {
                  waitingPermissions.delete(reqKey);
                  pendingPerms?.resolve(permId, { behavior: 'deny', message: 'Cursor 请求已结束。' });
                }
              },
            });

            if (outcome.status === 'detached') {
              cancelLocalPermissions();
              emit('result', {
                ...(nativeSessionId ? { session_id: nativeSessionId } : {}),
                detached: true,
                hosted_turn_id: currentTurn.turnId,
              });
              return;
            }

            if (continuationText && !params.abortController?.signal.aborted) {
              const nextPrompt = continuationText;
              continuationText = undefined;
              await host.ackTurn(currentTurn.turnId).catch(() => {});
              emit('status', { reasoning: '自由文本回答已保留，正在作为新消息继续原任务。' });
              const started = await host.startTurn({
                sessionKey,
                prompt: [{ type: 'text', text: nextPrompt }],
                meta: currentTurn.meta,
              });
              currentTurn = started.turn;
              continue;
            }

            const planLimitFailure = !outcome.error
              && !nativeFailure
              && outcome.status === 'completed'
              && tools.size === 0
              && isStandalonePlanLimitText(turnTextSample)
              ? PLAN_LIMIT_FAILURE_MESSAGE
              : undefined;
            const failure = outcome.error || nativeFailure || planLimitFailure;
            if (failure && outcome.status !== 'aborted') {
              const retryKind = retryableError(failure);
              const sessionStatus = await host.getSessionStatus(sessionKey).catch(() => null);
              if (
                retryKind
                && retries < RETRY_LIMIT
                && sessionStatus?.connected
                && ![...tools.values()].some(tool => !tool.complete)
                && waitingPermissions.size === 0
                && !params.abortController?.signal.aborted
              ) {
                retries += 1;
                await host.ackTurn(currentTurn.turnId).catch(() => {});
                const resourceExhausted = retryKind === 'resource_exhausted';
                const delayMs = Math.max(0, options.retryDelayMs ?? (resourceExhausted ? 30_000 : 1000)) * retries;
                const reason = resourceExhausted ? 'Cursor 上游资源或额度受限' : 'Cursor 连接临时中断';
                emit('status', { reasoning: `${reason}，${Math.ceil(delayMs / 1000)} 秒后自动续接（${retries}/${RETRY_LIMIT}）。` });
                await new Promise<void>((resolve) => {
                  const timer = setTimeout(resolve, delayMs);
                  const wake = () => { clearTimeout(timer); resolve(); };
                  params.abortController?.signal.addEventListener('abort', wake, { once: true });
                });
                if (params.abortController?.signal.aborted) {
                  emit('result', { ...(nativeSessionId ? { session_id: nativeSessionId } : {}), outcome: 'aborted', stop_reason: 'cancelled' });
                  return;
                }
                const started = await host.startTurn({
                  sessionKey,
                  prompt: [{ type: 'text', text: RETRY_PROMPT }],
                  meta: currentTurn.meta,
                });
                currentTurn = started.turn;
                continue;
              }
              if (isCursorAuthOrPlanError(failure)) {
                hostedCursorAppliedEffort.delete(params.sessionId);
                hostedCursorForce.delete(params.sessionId);
                await host.closeSession(sessionKey).catch(() => {});
              }
              emit('error', failure);
              emit('result', {
                ...(outcome.nativeSessionId || nativeSessionId ? { session_id: outcome.nativeSessionId || nativeSessionId } : {}),
                outcome: 'failed',
                ...(outcome.stopReason ? { stop_reason: outcome.stopReason } : {}),
                hosted_turn_id: currentTurn.turnId,
              });
              return;
            }

            if (outcome.status !== 'aborted') markAccepted();
            emit('result', {
              ...(outcome.nativeSessionId || nativeSessionId ? { session_id: outcome.nativeSessionId || nativeSessionId } : {}),
              outcome: outcome.status,
              stop_reason: outcome.stopReason || (outcome.status === 'aborted' ? 'cancelled' : 'end_turn'),
              hosted_turn_id: currentTurn.turnId,
            });
            return;
          }
        } catch (error) {
          emit('error', errorMessage(error));
          emit('result', {
            ...(params.cursorSessionId ? { session_id: params.cursorSessionId } : {}),
            outcome: 'failed',
            ...(activeTurnId ? { hosted_turn_id: activeTurnId } : {}),
          });
        } finally {
          cancelLocalPermissions();
          if (params.abortController?.signal.reason !== BRIDGE_SHUTDOWN_REASON) {
            emit('status', { clear_pending_questions: true });
          }
          emit('done', '');
          if (!readerCanceled) controller.close();
        }
      },
      async cancel() {
        readerCanceled = true;
        if (activeHost && activeTurnId && params.abortController?.signal.reason !== BRIDGE_SHUTDOWN_REASON) {
          await activeHost.cancelTurn({ turnId: activeTurnId, cancelTimeoutMs: options.cancelTimeoutMs }).catch(() => {});
        }
      },
    });
  }
}
