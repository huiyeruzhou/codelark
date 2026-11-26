import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { TaskProgressInfo } from '../../domain/progress.js';
import type { DoubaoMode } from '../../domain/session.js';
import type { LLMProvider, StreamChatParams } from '../contracts.js';
import { BRIDGE_SHUTDOWN_REASON } from '../contracts.js';
import { prepareTextAttachmentPrompt } from '../local-attachments.js';
import type { PendingPermissions } from '../permission-gateway.js';
import { sseEvent } from '../sse.js';
import { AcpClient, type AcpClientOptions, type AcpConnection, type AcpMessage } from '../acp/client.js';
import { resolveDoubaoExecutable } from './models.js';

export type DoubaoAcpModeId = 'default' | 'plan' | 'bypass_permissions';

export interface DoubaoAcpProviderOptions {
  clientFactory?: (options: AcpClientOptions) => Promise<AcpConnection>;
  executable?: string;
  /** Extra CLI arguments inserted after `acp serve`. */
  args?: string[];
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  cancelTimeoutMs?: number;
  retryDelayMs?: number;
}

export function doubaoModeToAcpModeId(mode?: DoubaoMode): DoubaoAcpModeId {
  if (mode === 'yolo') return 'bypass_permissions';
  if (mode === 'plan') return 'plan';
  return 'default';
}

const RETRY_LIMIT = 2;
const RETRY_PROMPT = '上一次请求因临时服务错误中断。请继续本会话中尚未完成的任务，先核对已保存的进度和工具结果，不要重复已完成的操作。';

interface Session {
  bridgeId: string;
  nativeId?: string;
  cwd: string;
  modeId: DoubaoAcpModeId;
  appliedModel?: string;
  appliedEffort?: string;
  configOptions: Array<Record<string, any>>;
  disposalError?: Error;
  client?: AcpConnection;
  ready: Promise<void>;
}
interface Turn { cancel(): Promise<void>; done: Promise<void> }

const sessions = new Map<string, Session>();
const turns = new Map<string, Turn>();

function record(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (/\b(?:unauthenticated|not logged in|please login|auth(?:entication)? required)\b|未登录/iu.test(raw)) {
    return `${raw}（请先在终端运行 \`doubao login\` 完成登录）`;
  }
  return raw;
}

function retryableError(message: string): 'resource_exhausted' | 'transport' | undefined {
  if (/\b(?:resource_exhausted|rate[_\s-]?limit|429|quota)\b/iu.test(message)) return 'resource_exhausted';
  if (/\b(?:unavailable|service_unavailable|deadline_exceeded|econnreset|etimedout|502|503|504)\b|http\/2 stream closed|error code cancel|与共享服务断开/iu.test(message)) return 'transport';
  return undefined;
}

function todoStatus(value: unknown): TaskProgressInfo['status'] | 'cancelled' {
  if (value === 'completed' || value === 3) return 'completed';
  if (value === 'in_progress' || value === 2) return 'in_progress';
  if (value === 'cancelled' || value === 4) return 'cancelled';
  return 'pending';
}

function planTasks(value: unknown): TaskProgressInfo[] {
  return (Array.isArray(value) ? value : []).flatMap(item => {
    const entry = record(item);
    const status = todoStatus(entry.status);
    return typeof entry.content === 'string' && entry.content.trim() && status !== 'cancelled'
      ? [{ text: entry.content.trim(), status }]
      : [];
  });
}

function sessionFor(id: string): Session | undefined {
  return sessions.get(id) || [...sessions.values()].find(session => session.nativeId === id);
}

async function disposeSession(session: Session): Promise<void> {
  try {
    await session.client?.close();
    session.disposalError = undefined;
  } catch (error) {
    session.disposalError = error instanceof Error ? error : new Error(String(error));
    throw session.disposalError;
  }
}

function forget(session: Session): void {
  if (sessions.get(session.bridgeId) === session) sessions.delete(session.bridgeId);
}

export async function interruptDoubaoAcpSession(sessionId: string): Promise<boolean> {
  const turn = turns.get(sessionFor(sessionId)?.bridgeId || sessionId);
  if (!turn) return false;
  try { await turn.cancel(); }
  finally { await turn.done; }
  return true;
}

export async function closeDoubaoAcpSession(sessionId: string): Promise<void> {
  const session = sessionFor(sessionId);
  if (!session) return;
  try { await interruptDoubaoAcpSession(session.bridgeId); }
  finally {
    await session.ready.catch(() => {});
    await disposeSession(session);
    forget(session);
  }
}

export function getDoubaoAcpSessionActivity(sessionId: string): 'idle' | 'active' | 'unknown' {
  const session = sessionFor(sessionId);
  if (session?.disposalError) return 'unknown';
  if (!turns.has(session?.bridgeId || sessionId)) return 'idle';
  return session?.client?.connected ? 'active' : 'unknown';
}

export async function closeAllDoubaoAcpSessions(): Promise<void> {
  await Promise.all([...sessions.keys()].map(closeDoubaoAcpSession));
}

export const closeDoubaoAcpSessions = closeAllDoubaoAcpSessions;

function resolveConfigOptionValue(
  option: Record<string, any> | undefined,
  requested: string,
): string | undefined {
  if (!option || !Array.isArray(option.options)) return undefined;
  const query = requested.trim().toLowerCase();
  if (!query) return undefined;
  const byValue = option.options.find((item: any) => String(item?.value || '').trim().toLowerCase() === query);
  if (byValue) return String(byValue.value);
  const byName = option.options.filter((item: any) => String(item?.name || '').trim().toLowerCase() === query);
  if (byName.length === 1) return String(byName[0].value);
  const fuzzy = option.options.filter((item: any) => String(item?.name || '').trim().toLowerCase().includes(query));
  return fuzzy.length === 1 ? String(fuzzy[0].value) : undefined;
}

function displayedModelFromConfigOptions(configOptions: Array<Record<string, any>>): string | undefined {
  const modelOpt = configOptions.find(opt => opt.category === 'model' || opt.id === 'model');
  if (!modelOpt) return undefined;
  const current = typeof modelOpt.currentValue === 'string' ? modelOpt.currentValue.trim() : '';
  if (!current) return undefined;
  const match = Array.isArray(modelOpt.options)
    ? modelOpt.options.find((item: any) => String(item?.value || '') === current)
    : undefined;
  return (typeof match?.name === 'string' && match.name.trim()) ? match.name.trim() : current;
}

async function prepareSession(params: StreamChatParams, options: DoubaoAcpProviderOptions): Promise<Session> {
  const cwd = path.resolve(params.workingDirectory || process.cwd());
  const requestedModeId = doubaoModeToAcpModeId(params.doubaoMode);
  const model = params.model?.trim() || undefined;
  const effort = params.doubaoReasoningEffort?.trim() || undefined;
  const existing = sessions.get(params.sessionId);
  if (existing) {
    await existing.ready;
    const sameNativeSession = !params.doubaoSessionId || existing.nativeId === params.doubaoSessionId;
    const clearedModelOverride = Boolean(existing.appliedModel && !model);
    const clearedEffortOverride = Boolean(existing.appliedEffort && !effort);
    if (existing.cwd === cwd && sameNativeSession && !clearedModelOverride && !clearedEffortOverride && existing.client?.connected) {
      return existing;
    }
    await disposeSession(existing);
    forget(existing);
  }
  if (params.doubaoSessionId && [...sessions.values()].some(s => s.nativeId === params.doubaoSessionId)) {
    throw new Error('这个豆包 ACP 会话已有执行者，未启动第二个进程。');
  }
  const session: Session = {
    bridgeId: params.sessionId,
    nativeId: params.doubaoSessionId,
    cwd,
    modeId: requestedModeId,
    appliedModel: model,
    appliedEffort: effort,
    configOptions: [],
    ready: Promise.resolve(),
  };
  sessions.set(params.sessionId, session);
  session.ready = (async () => {
    const launchArgs = [
      'acp', 'serve',
      '-C', cwd,
      ...(model ? ['--model', model] : []),
      ...(effort ? ['--effort', effort] : []),
      ...(options.args || []),
    ];
    const client = await (options.clientFactory || AcpClient.start)({
      executable: options.executable || resolveDoubaoExecutable(options.env),
      args: launchArgs,
      cwd,
      env: options.env,
      requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
      label: 'Doubao ACP',
      stdinPipe: true,
    });
    session.client = client;
    // Reject server requests during session/load replay; history updates are ignored because no turn listener is registered yet.
    const loadingRequests = client.onMessage(message => {
      if (message.id !== undefined && message.method) client.reject(message.id, -32601, 'Client is loading the session');
    });
    try {
      const initialized = await client.request<Record<string, unknown>>('initialize', {
        protocolVersion: 1,
        clientInfo: { name: 'codelark', version: '0.6.0' },
        clientCapabilities: {},
      });
      if (params.doubaoSessionId && record(initialized.agentCapabilities).loadSession !== true) {
        throw new Error('当前豆包 CLI ACP 版本不支持恢复会话，未创建替代会话或重发输入。');
      }
      if (params.doubaoSessionId) {
        const loaded = await client.request<Record<string, any>>('session/load', {
          sessionId: params.doubaoSessionId,
          cwd,
          mcpServers: [],
        }, 120_000);
        session.configOptions = Array.isArray(loaded.configOptions) ? loaded.configOptions : [];
        const currentMode = record(loaded.modes).currentModeId;
        if (currentMode === 'default' || currentMode === 'plan' || currentMode === 'bypass_permissions') {
          session.modeId = currentMode;
        }
      } else {
        const created = await client.request<Record<string, any>>('session/new', {
          cwd,
          mcpServers: [],
        }, 120_000);
        if (typeof created.sessionId !== 'string' || !created.sessionId.trim()) {
          throw new Error('豆包 ACP 未返回原生会话 ID。');
        }
        session.nativeId = created.sessionId;
        session.configOptions = Array.isArray(created.configOptions) ? created.configOptions : [];
        const currentMode = record(created.modes).currentModeId;
        if (currentMode === 'default' || currentMode === 'plan' || currentMode === 'bypass_permissions') {
          session.modeId = currentMode;
        }
      }
    } finally {
      loadingRequests();
    }
  })();
  try {
    await session.ready;
    return session;
  } catch (error) {
    await disposeSession(session).catch(() => {});
    forget(session);
    throw error;
  }
}

async function syncSessionRuntimeOptions(
  session: Session,
  params: StreamChatParams,
): Promise<void> {
  const client = session.client!;
  const desiredModeId = doubaoModeToAcpModeId(params.doubaoMode);
  if (session.modeId !== desiredModeId) {
    await client.request('session/set_mode', {
      sessionId: session.nativeId,
      modeId: desiredModeId,
    });
    session.modeId = desiredModeId;
  }
  const requestedModel = params.model?.trim();
  if (requestedModel) {
    const modelOpt = session.configOptions.find(opt => opt.category === 'model' || opt.id === 'model');
    if (modelOpt) {
      const targetValue = resolveConfigOptionValue(modelOpt, requestedModel);
      if (!targetValue) {
        const available = Array.isArray(modelOpt.options)
          ? modelOpt.options.map((item: any) => `${item.value}(${item.name})`).join(' / ')
          : '';
        throw new Error(`当前豆包账号不支持模型 ${requestedModel}${available ? `（可选：${available}）` : ''}，未提交输入。`);
      }
      if (modelOpt.currentValue !== targetValue) {
        const updated = await client.request<Record<string, any>>('session/set_config_option', {
          sessionId: session.nativeId,
          configId: modelOpt.id,
          value: targetValue,
        });
        if (Array.isArray(updated.configOptions)) session.configOptions = updated.configOptions;
        else modelOpt.currentValue = targetValue;
      }
      session.appliedModel = targetValue;
    }
  }
  const requestedEffort = params.doubaoReasoningEffort?.trim();
  if (requestedEffort) {
    const effortOpt = session.configOptions.find(opt => opt.category === 'thought_level' || opt.id === 'effort');
    if (!effortOpt) {
      throw new Error(`当前豆包 ACP 模型不支持设置思考强度 ${requestedEffort}，未提交输入。`);
    }
    const targetEffort = resolveConfigOptionValue(effortOpt, requestedEffort);
    if (!targetEffort) {
      const available = Array.isArray(effortOpt.options)
        ? effortOpt.options.map((item: any) => String(item.value)).join(' / ')
        : '';
      throw new Error(`当前豆包 ACP 模型不支持思考强度 ${requestedEffort}${available ? `（可选：${available}）` : ''}，未提交输入。`);
    }
    if (effortOpt.currentValue !== targetEffort) {
      const updated = await client.request<Record<string, any>>('session/set_config_option', {
        sessionId: session.nativeId,
        configId: effortOpt.id,
        value: targetEffort,
      });
      if (Array.isArray(updated.configOptions)) session.configOptions = updated.configOptions;
      else effortOpt.currentValue = targetEffort;
    }
    session.appliedEffort = targetEffort;
  }
}

function toolName(update: Record<string, any>): string {
  const byKind = ({
    execute: 'Shell',
    read: 'Read',
    edit: 'apply_patch',
    delete: 'apply_patch',
    search: 'Search',
    fetch: 'WebFetch',
  } as Record<string, string>)[update.kind];
  if (byKind) return byKind;
  if (typeof update.title === 'string' && update.title.trim()) return update.title.trim();
  return 'Doubao Tool';
}

function textLines(text: string): string[] {
  if (!text) return [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function patchDiffLines(beforeText: string, afterText: string): string[] {
  if (beforeText === afterText) return [];
  const before = textLines(beforeText);
  const after = textLines(afterText);
  let prefix = 0;
  let suffix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  while (
    suffix < before.length - prefix
    && suffix < after.length - prefix
    && before[before.length - suffix - 1] === after[after.length - suffix - 1]
  ) suffix++;
  if (prefix === before.length && prefix === after.length) prefix = Math.max(0, prefix - 1);
  const start = Math.max(0, prefix - 3);
  const tail = Math.min(3, suffix);
  const removed = before.slice(prefix, before.length - suffix).map(line => `-${line}`);
  const added = after.slice(prefix, after.length - suffix).map(line => `+${line}`);
  return [
    `@@ -${start + 1},${before.length - suffix + tail - start} +${start + 1},${after.length - suffix + tail - start} @@`,
    ...before.slice(start, prefix).map(line => ` ${line}`),
    ...removed,
    ...added,
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
    else lines.push(...textLines(action === 'Delete' ? diff.oldText || '' : diff.newText).map(line => `${action === 'Delete' ? '-' : '+'}${line}`));
  }
  lines.push('*** End Patch');
  return { patch: lines.join('\n'), workdir: cwd };
}

function initialToolInput(update: Record<string, any>, cwd: string): unknown {
  const input = record(update.rawInput);
  if (['edit', 'delete'].includes(update.kind) && typeof input.path === 'string') {
    return { ...input, patch: `*** Begin Patch\n*** ${update.kind === 'delete' ? 'Delete' : 'Update'} File: ${input.path}\n*** End Patch`, workdir: cwd };
  }
  if (update.rawInput !== undefined) return update.rawInput;
  if (typeof update.title === 'string' && update.title.trim()) return { description: update.title.trim() };
  return {};
}

function toolOutput(update: Record<string, any>, name: string): string {
  const content = Array.isArray(update.content) ? update.content.map((item: unknown) => {
    const block = record(item);
    return block.type === 'content' ? record(block.content).text || '' : block.type === 'diff' ? block.newText || '' : '';
  }).filter(Boolean).join('\n') : '';
  const raw = record(update.rawOutput);
  if (name === 'Shell' && (typeof raw.stdout === 'string' || typeof raw.stderr === 'string' || Number.isInteger(raw.exitCode))) {
    const output = [raw.stdout, raw.stderr].filter(value => typeof value === 'string' && value.length > 0).join('\n') || content;
    return `${Number.isInteger(raw.exitCode) ? `Process exited with code ${raw.exitCode}\n` : ''}Output:\n${output}`;
  }
  if (content) return content;
  for (const key of ['output', 'content', 'markdown', 'text']) {
    if (typeof raw[key] === 'string') return raw[key];
  }
  if (typeof update.rawOutput === 'string') return update.rawOutput;
  return update.rawOutput === undefined ? '' : JSON.stringify(update.rawOutput, null, 2);
}

/** Direct ACP v1 provider for Doubao CLI (`doubao acp serve`). */
export class DoubaoAcpProvider implements LLMProvider {
  constructor(private pendingPerms?: PendingPermissions, private options: DoubaoAcpProviderOptions = {}) {}

  streamChat(params: StreamChatParams): ReadableStream<string> {
    let readerCanceled = false;
    let cancel = async () => {};
    const pendingPerms = this.pendingPerms;
    const options = this.options;
    return new ReadableStream<string>({
      async start(controller) {
        const emit = (type: string, data: unknown) => { if (!readerCanceled) controller.enqueue(sseEvent(type, data)); };
        if (turns.has(params.sessionId)) {
          emit('error', '豆包 ACP 上一轮尚未确认结束，请等待中断确认后再提交。');
          emit('done', '');
          controller.close();
          return;
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
        let accepted = false;
        let retryWake: (() => void) | undefined;
        const waitingPermissions = new Set<string>();
        const cancelPermissions = () => {
          for (const id of waitingPermissions) pendingPerms?.resolve(id, { behavior: 'deny', message: '豆包请求已中断。' });
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
                timer = setTimeout(() => reject(new Error('豆包 ACP 尚未确认中断，已关闭本连接防止重叠执行。')), options.cancelTimeoutMs ?? 15_000);
              })]);
            } catch (error) {
              cancelFailure = error instanceof Error ? error : new Error(String(error));
              await disposeSession(session!);
              forget(session!);
              throw error;
            } finally {
              if (timer) clearTimeout(timer);
            }
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
          emit('status', { reasoning: '豆包 ACP 已接收消息，正在执行。' });
        };
        const waitPermission = async (message: AcpMessage) => {
          const payload = record(message.params);
          const id = `doubao-acp:${params.sessionId}:${randomUUID()}`;
          if (!pendingPerms) throw new Error('豆包 ACP 需要工具审批，但当前没有权限通道。');
          waitingPermissions.add(id);
          const pending = pendingPerms.waitFor(id);
          emit('permission_request', {
            permissionRequestId: id,
            toolName: record(payload.toolCall).title || 'Doubao Tool Permission',
            toolInput: { ...record(payload.toolCall), options: payload.options },
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
          await syncSessionRuntimeOptions(session, params);
          const client = session.client!;
          const displayedModel = displayedModelFromConfigOptions(session.configOptions);
          emit('status', {
            session_id: session.nativeId,
            cwd: session.cwd,
            ...(displayedModel ? { model: displayedModel } : {}),
          });

          const tools = new Map<string, { name: string; kind?: string; complete: boolean }>();
          const handleRequest = async (message: AcpMessage) => {
            if (message.id === undefined) return;
            const payload = record(message.params);
            if (payload.sessionId && payload.sessionId !== session!.nativeId) {
              client.reject(message.id, -32602, 'Session does not belong to this connection');
              return;
            }
            if (!acceptingUpdates || interrupted) {
              client.respond(message.id, { outcome: { outcome: 'cancelled' } });
              return;
            }
            if (message.method === 'session/request_permission') {
              markAccepted();
              const choices = Array.isArray(payload.options) ? payload.options : [];
              if (session!.modeId === 'bypass_permissions') {
                const autoAllow = choices.find((choice: any) => choice.kind === 'allow_always')
                  || choices.find((choice: any) => choice.kind === 'allow_once')
                  || choices.find((choice: any) => String(choice.kind || '').startsWith('allow'));
                client.respond(
                  message.id,
                  autoAllow
                    ? { outcome: { outcome: 'selected', optionId: autoAllow.optionId } }
                    : { outcome: { outcome: 'cancelled' } },
                );
                return;
              }
              const resolution = await waitPermission(message);
              const preferredKind = resolution.behavior === 'allow' ? 'allow_once' : 'reject_once';
              const option = choices.find((choice: any) => choice.kind === preferredKind)
                || choices.find((choice: any) => String(choice.kind || '').startsWith(resolution.behavior === 'allow' ? 'allow' : 'reject'));
              client.respond(
                message.id,
                interrupted || !option
                  ? { outcome: { outcome: 'cancelled' } }
                  : { outcome: { outcome: 'selected', optionId: option.optionId } },
              );
            } else {
              client.reject(message.id, -32601, `Unsupported client method: ${message.method}`);
            }
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
            if (update.sessionUpdate === 'current_mode_update') {
              const modeId = update.currentModeId;
              if (modeId === 'default' || modeId === 'plan' || modeId === 'bypass_permissions') {
                session!.modeId = modeId;
              }
              return;
            }
            if (update.sessionUpdate === 'config_option_update' && Array.isArray(update.configOptions)) {
              session!.configOptions = update.configOptions;
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
                emit('text', content.text);
              }
            } else if (update.sessionUpdate === 'agent_thought_chunk') {
              emit('status', { reasoning: '豆包正在思考。' });
            } else if (typeof update.toolCallId === 'string') {
              let tool = tools.get(update.toolCallId);
              if (!tool) {
                tool = { name: toolName(update), kind: update.kind, complete: false };
                tools.set(update.toolCallId, tool);
                emit('tool_use', { id: update.toolCallId, name: tool.name, input: initialToolInput(update, session!.cwd) });
              }
              if (!tool.complete && ['completed', 'failed', 'cancelled'].includes(update.status)) {
                tool.complete = true;
                const exitCode = record(update.rawOutput).exitCode;
                const patch = completedPatchInput(update, tool.kind || update.kind, session!.cwd);
                const output = toolOutput(
                  patch ? { ...update, content: update.content.filter((block: any) => block?.type !== 'diff') } : update,
                  tool.name,
                );
                emit('tool_result', {
                  tool_use_id: update.toolCallId,
                  content: output,
                  ...(patch ? { name: 'apply_patch', input: patch } : {}),
                  is_error: update.status !== 'completed' || (tool.name === 'Shell' && Number.isInteger(exitCode) && exitCode !== 0),
                  show_output: !patch || Boolean(output),
                });
              }
            }
          });

          let prompt = prepareTextAttachmentPrompt(params);
          if (!params.doubaoSessionId && params.systemPrompt) prompt = `${params.systemPrompt}\n\n${prompt}`;
          let stopReason = 'cancelled';
          let retries = 0;
          while (!interrupted) {
            acceptingUpdates = true;
            cancellation = undefined;
            promptPromise = client.request<Record<string, any>>('session/prompt', {
              sessionId: session.nativeId,
              prompt: [{ type: 'text', text: prompt }],
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
            if (failure) {
              const retryKind = retryableError(failure);
              if (!retryKind || retries >= RETRY_LIMIT || !client.connected
                || [...tools.values()].some(tool => !tool.complete) || waitingPermissions.size) {
                throw new Error(failure);
              }
              retries++;
              const resourceExhausted = retryKind === 'resource_exhausted';
              const delayMs = Math.max(0, options.retryDelayMs ?? (resourceExhausted ? 30_000 : 1000)) * retries;
              const reason = resourceExhausted ? '豆包上游资源或额度受限' : '豆包连接临时中断';
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
            break;
          }
          if (interrupted) stopReason = 'cancelled';
          if (stopReason !== 'cancelled') markAccepted();
          if (!['end_turn', 'cancelled'].includes(stopReason)) emit('error', `豆包 ACP 本轮未正常完成：${stopReason}`);
          const finalModel = displayedModelFromConfigOptions(session.configOptions);
          emit('result', {
            session_id: session.nativeId,
            ...(finalModel ? { model: finalModel } : {}),
            outcome: stopReason === 'cancelled' ? 'aborted' : stopReason === 'end_turn' ? 'completed' : 'failed',
            stop_reason: stopReason,
          });
        } catch (error) {
          let failure = cancelFailure || error;
          if (session?.client && !session.client.connected) {
            try { await disposeSession(session); } catch (closeError) { failure = closeError; }
          }
          emit('error', errorMessage(failure));
        } finally {
          unsubscribe();
          cancelPermissions();
          params.abortController?.signal.removeEventListener('abort', onAbort);
          if (params.abortController?.signal.reason === BRIDGE_SHUTDOWN_REASON && session) {
            await disposeSession(session).catch(() => {});
            forget(session);
          }
          if (turns.get(params.sessionId) === turn) turns.delete(params.sessionId);
          resolveDone();
          emit('done', '');
          if (!readerCanceled) controller.close();
        }
      },
      async cancel() {
        readerCanceled = true;
        await cancel().catch(() => {});
      },
    });
  }
}
