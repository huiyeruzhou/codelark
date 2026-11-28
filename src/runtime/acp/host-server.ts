import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { AcpClient, AcpRpcError, type AcpClientOptions, type AcpConnection, type AcpMessage } from './client.js';
import { cursorCliModel } from '../cursor/acp-commands.js';
import { withCursorCompaction } from '../cursor/compact-client.js';
import { withCursorGoalContinuation } from '../cursor/goal-continuation.js';
import {
  ACP_HOST_PROTOCOL_VERSION,
  isAcpTurnActiveStatus,
  type AcpHostHelloResult,
  type AcpHostPushEnvelope,
  type AcpHostRequestEnvelope,
  type AcpHostResponseEnvelope,
  type AcpPendingServerRequest,
  type AcpRuntimeKind,
  type AcpSessionEnsureParams,
  type AcpSessionEnsureResult,
  type AcpSessionRpcParams,
  type AcpSessionRpcResult,
  type AcpSessionSnapshot,
  type AcpSessionState,
  type AcpTurnCancelParams,
  type AcpTurnEvent,
  type AcpTurnMeta,
  type AcpTurnRespondParams,
  type AcpTurnSnapshot,
  type AcpTurnStartParams,
  type AcpTurnStartResult,
  type AcpTurnStatus,
  type AcpTurnSubscribeParams,
  type AcpTurnSubscribeResult,
  type AcpTurnUpdateMetaParams,
} from './host-protocol.js';

const MAX_TURN_EVENTS = 50_000;
const ACKED_TURN_RETENTION_MS = 5 * 60_000;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

interface ManagedAcpSession {
  sessionKey: string;
  runtime: AcpRuntimeKind;
  bridgeSessionId: string;
  nativeSessionId?: string;
  cwd: string;
  fingerprint: string;
  label: string;
  state: AcpSessionState;
  client?: AcpConnection;
  configOptions: Array<Record<string, unknown>>;
  modes?: Record<string, unknown>;
  activeTurnId?: string;
  disposalError?: string;
  ready: Promise<void>;
  unsubscribeMessages?: () => void;
  unsubscribeDisconnect?: () => void;
}

interface ManagedAcpTurn {
  turnId: string;
  sessionKey: string;
  runtime: AcpRuntimeKind;
  bridgeSessionId: string;
  nativeSessionId?: string;
  status: AcpTurnStatus;
  stopReason?: string;
  error?: string;
  startedAt: number;
  updatedAt: number;
  endedAt?: number;
  nextSeq: number;
  acked: boolean;
  meta: AcpTurnMeta;
  events: AcpTurnEvent[];
  pendingRequests: Map<string, AcpPendingServerRequest>;
  subscribers: Set<net.Socket>;
  done: Promise<void>;
  resolveDone: () => void;
  cancellation?: Promise<void>;
}

export interface AcpHostServerOptions {
  socketPath: string;
  codeHash?: string;
  clientFactory?: (options: AcpClientOptions) => Promise<AcpConnection>;
  onShutdownRequested?: () => void;
}

export interface AcpHostServerHandle {
  readonly socketPath: string;
  readonly startedAt: number;
  getHello(): AcpHostHelloResult;
  close(force?: boolean): Promise<void>;
}

function requestKey(requestId: string | number): string {
  return `${typeof requestId}:${String(requestId)}`;
}

function sendFrame(socket: net.Socket, payload: AcpHostResponseEnvelope | AcpHostPushEnvelope): void {
  if (socket.destroyed || !socket.writable) return;
  try {
    socket.write(`${JSON.stringify(payload)}\n`);
  } catch {
    // Ignore write errors on disconnecting bridge sockets; turn keeps running undisturbed.
  }
}

function sanitizeEnv(env?: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...process.env };
  if (!env) return merged;
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  return merged;
}

/**
 * Persistent, bridge-independent ACP host server.
 *
 * Owns live `cursor-agent acp` / `doubao acp serve` child processes, maintains an
 * exact state machine for every session and turn, journals all ACP turn events with
 * monotonic sequence numbers, and holds pending permission/question requests open
 * across bridge restarts so a new bridge can seamlessly re-attach.
 */
export async function startAcpHostServer(options: AcpHostServerOptions): Promise<AcpHostServerHandle> {
  const startedAt = Date.now();
  const codeHash = options.codeHash || 'dev';
  const clientFactory = options.clientFactory || ((opts: AcpClientOptions) => AcpClient.start(opts));

  const sessions = new Map<string, ManagedAcpSession>();
  const turns = new Map<string, ManagedAcpTurn>();
  const allClients = new Set<net.Socket>();
  let shuttingDown = false;
  let pendingOperations = 0;
  let closing: Promise<void> | undefined;

  const sessionSnapshot = (session: ManagedAcpSession): AcpSessionSnapshot => ({
    sessionKey: session.sessionKey,
    runtime: session.runtime,
    bridgeSessionId: session.bridgeSessionId,
    nativeSessionId: session.nativeSessionId,
    cwd: session.cwd,
    state: session.state,
    connected: Boolean(session.client?.connected),
    activeTurnId: session.activeTurnId,
    configOptions: session.configOptions,
    modes: session.modes,
    disposalError: session.disposalError,
  });

  const turnSnapshot = (turn: ManagedAcpTurn): AcpTurnSnapshot => ({
    turnId: turn.turnId,
    sessionKey: turn.sessionKey,
    runtime: turn.runtime,
    bridgeSessionId: turn.bridgeSessionId,
    nativeSessionId: turn.nativeSessionId,
    status: turn.status,
    stopReason: turn.stopReason,
    error: turn.error,
    startedAt: turn.startedAt,
    updatedAt: turn.updatedAt,
    endedAt: turn.endedAt,
    lastSeq: turn.nextSeq - 1,
    acked: turn.acked,
    meta: turn.meta,
    pendingRequests: [...turn.pendingRequests.values()],
  });

  const broadcastSessionState = (session: ManagedAcpSession): void => {
    const payload: AcpHostPushEnvelope = {
      event: 'session/state',
      session: sessionSnapshot(session),
    };
    for (const sock of allClients) sendFrame(sock, payload);
  };

  type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
  type AcpTurnEventBody = DistributiveOmit<AcpTurnEvent, 'seq' | 'ts'>;

  const appendTurnEvent = (turn: ManagedAcpTurn, eventBody: AcpTurnEventBody): AcpTurnEvent => {
    const seq = turn.nextSeq++;
    const ts = Date.now();
    const item = { ...eventBody, seq, ts } as AcpTurnEvent;
    turn.updatedAt = ts;
    turn.events.push(item);
    if (turn.events.length > MAX_TURN_EVENTS) {
      turn.events.splice(0, turn.events.length - MAX_TURN_EVENTS);
    }
    const push: AcpHostPushEnvelope = { event: 'turn/event', turnId: turn.turnId, item };
    for (const sock of turn.subscribers) sendFrame(sock, push);
    return item;
  };

  const pruneAckedTurns = (): void => {
    const cutoff = Date.now() - ACKED_TURN_RETENTION_MS;
    for (const [turnId, turn] of turns) {
      if (turn.acked && !isAcpTurnActiveStatus(turn.status) && (turn.endedAt ?? turn.updatedAt) < cutoff) {
        turns.delete(turnId);
      }
    }
  };

  const gcTimer = setInterval(pruneAckedTurns, 60_000);
  gcTimer.unref();

  const disposeManagedSession = async (session: ManagedAcpSession): Promise<void> => {
    session.unsubscribeMessages?.();
    session.unsubscribeMessages = undefined;
    session.unsubscribeDisconnect?.();
    session.unsubscribeDisconnect = undefined;
    try {
      await session.client?.close();
      session.disposalError = undefined;
      session.state = 'closed';
    } catch (error) {
      session.disposalError = error instanceof Error ? error.message : String(error);
      session.state = 'failed';
      throw error;
    } finally {
      broadcastSessionState(session);
    }
  };

  const cancelPendingRequestsOnClient = (session: ManagedAcpSession, turn: ManagedAcpTurn): void => {
    for (const [key, req] of turn.pendingRequests) {
      turn.pendingRequests.delete(key);
      try {
        if (req.method === 'session/request_permission') {
          session.client?.respond(req.requestId, { outcome: { outcome: 'cancelled' } });
        } else {
          session.client?.reject(req.requestId, -32000, 'Turn cancelled');
        }
      } catch {
        // Ignore if child already exited.
      }
      appendTurnEvent(turn, { kind: 'server_request_resolved', requestId: req.requestId });
    }
  };

  const finishTurn = (
    session: ManagedAcpSession,
    turn: ManagedAcpTurn,
    status: 'completed' | 'aborted' | 'failed',
    detail: { stopReason?: string; error?: string },
  ): void => {
    if (!isAcpTurnActiveStatus(turn.status)) return;
    cancelPendingRequestsOnClient(session, turn);
    turn.status = status;
    turn.stopReason = detail.stopReason;
    turn.error = detail.error;
    turn.endedAt = Date.now();
    turn.nativeSessionId = session.nativeSessionId;
    if (session.activeTurnId === turn.turnId) {
      session.activeTurnId = undefined;
      if (session.state !== 'closed' && session.state !== 'failed') {
        session.state = session.client?.connected ? 'ready' : 'failed';
      }
      broadcastSessionState(session);
    }
    appendTurnEvent(turn, {
      kind: 'turn_end',
      status,
      ...(detail.stopReason ? { stopReason: detail.stopReason } : {}),
      ...(detail.error ? { error: detail.error } : {}),
      ...(session.nativeSessionId ? { nativeSessionId: session.nativeSessionId } : {}),
    });
    turn.resolveDone();
  };

  const attachSessionListeners = (session: ManagedAcpSession): void => {
    const client = session.client;
    if (!client) return;
    session.unsubscribeMessages = client.onMessage((message: AcpMessage) => {
      const activeTurn = session.activeTurnId ? turns.get(session.activeTurnId) : undefined;
      if (!activeTurn || !isAcpTurnActiveStatus(activeTurn.status)) {
        if (message.id !== undefined && message.method) {
          client.reject(message.id, -32601, 'No active turn on ACP session');
        }
        return;
      }
      if (message.method === 'session/update') {
        const params = record(message.params);
        const update = record(params.update);
        if (update.sessionUpdate === 'config_option_update' && Array.isArray(update.configOptions)) {
          session.configOptions = update.configOptions as Array<Record<string, unknown>>;
        }
        appendTurnEvent(activeTurn, { kind: 'session_update', params });
        return;
      }
      if (message.id !== undefined && message.method) {
        const params = record(message.params);
        if (message.method === 'cursor/update_todos') {
          // Todo updates are non-blocking notifications modeled as RPC requests by Cursor ACP;
          // ack immediately in host so Cursor never stalls during a bridge restart, while
          // still journaling the event so re-attaching bridges reconstruct the exact todo list.
          client.respond(message.id, {});
          appendTurnEvent(activeTurn, {
            kind: 'session_update',
            params: {
              sessionId: session.nativeSessionId,
              update: {
                sessionUpdate: 'codelark_cursor_update_todos',
                todos: params.todos,
                merge: params.merge === true,
              },
            },
          });
          return;
        }
        if (
          message.method === 'session/request_permission'
          && session.runtime === 'doubao'
          && (session.modes?.currentModeId === 'bypass_permissions' || activeTurn.meta.doubaoMode === 'bypass_permissions')
        ) {
          const choices = Array.isArray(params.options) ? params.options as Array<Record<string, unknown>> : [];
          const autoAllow = choices.find((choice) => choice.kind === 'allow_always')
            || choices.find((choice) => choice.kind === 'allow_once')
            || choices.find((choice) => String(choice.kind || '').startsWith('allow'));
          client.respond(
            message.id,
            autoAllow
              ? { outcome: { outcome: 'selected', optionId: autoAllow.optionId } }
              : { outcome: { outcome: 'cancelled' } },
          );
          return;
        }
        const key = requestKey(message.id);
        const evt = appendTurnEvent(activeTurn, {
          kind: 'server_request',
          requestId: message.id,
          method: message.method,
          params,
        });
        activeTurn.pendingRequests.set(key, {
          requestId: message.id,
          method: message.method,
          params,
          seq: evt.seq,
        });
        if (activeTurn.status === 'running') {
          activeTurn.status = 'waiting_permission';
          session.state = 'waiting_permission';
          broadcastSessionState(session);
        }
      }
    });

    session.unsubscribeDisconnect = client.onDisconnect((error: Error) => {
      if (session.state !== 'closed') {
        session.state = 'failed';
        broadcastSessionState(session);
      }
      const activeTurn = session.activeTurnId ? turns.get(session.activeTurnId) : undefined;
      if (activeTurn && isAcpTurnActiveStatus(activeTurn.status)) {
        finishTurn(session, activeTurn, 'failed', { error: error.message });
      }
    });
  };

  const ensureSession = async (params: AcpSessionEnsureParams): Promise<AcpSessionEnsureResult> => {
    const existing = sessions.get(params.sessionKey);
    if (existing) {
      await existing.ready.catch(() => {});
      if (existing.activeTurnId) {
        const activeTurn = turns.get(existing.activeTurnId);
        if (activeTurn && isAcpTurnActiveStatus(activeTurn.status)) {
          throw new Error(`${params.label} 上一轮尚未确认结束，请等待中断确认后再提交。`);
        }
      }
      if (existing.fingerprint === params.fingerprint && existing.client?.connected && existing.state === 'ready') {
        return { reused: true, session: sessionSnapshot(existing) };
      }
      await disposeManagedSession(existing);
      if (sessions.get(params.sessionKey) === existing) sessions.delete(params.sessionKey);
    }

    if (params.nativeSessionId) {
      for (const other of sessions.values()) {
        if (other.sessionKey !== params.sessionKey && other.runtime === params.runtime && other.nativeSessionId === params.nativeSessionId && other.client?.connected) {
          throw new Error(params.duplicateNativeMessage || `这个 ${params.label} 会话已有执行者，未启动第二个进程。`);
        }
      }
    }

    const session: ManagedAcpSession = {
      sessionKey: params.sessionKey,
      runtime: params.runtime,
      bridgeSessionId: params.bridgeSessionId,
      nativeSessionId: params.nativeSessionId,
      cwd: params.cwd,
      fingerprint: params.fingerprint,
      label: params.label,
      state: 'starting',
      configOptions: [],
      ready: Promise.resolve(),
    };
    sessions.set(params.sessionKey, session);
    broadcastSessionState(session);

    session.ready = (async () => {
      const start = () => clientFactory({
        executable: params.executable,
        args: params.args,
        cwd: params.cwd,
        env: sanitizeEnv(params.env),
        requestTimeoutMs: params.requestTimeoutMs ?? 30_000,
        label: params.label,
        stdinPipe: params.stdinPipe,
      });
      const connection = await start();
      const client = params.runtime === 'cursor'
        ? withCursorGoalContinuation(withCursorCompaction(connection, start, { executable: params.executable, cwd: params.cwd, env: sanitizeEnv(params.env), model: cursorCliModel(params.args) }), sanitizeEnv(params.env)) : connection;
      session.client = client;

      const loadingRejector = client.onMessage((message: AcpMessage) => {
        if (message.id !== undefined && message.method) {
          client.reject(message.id, -32601, 'Client is loading the session');
        }
      });

      try {
        const initialized = await client.request<Record<string, unknown>>('initialize', params.initializeParams);
        if (params.nativeSessionId && params.requireLoadCapability !== false) {
          if (record(initialized.agentCapabilities).loadSession !== true) {
            throw new Error(params.loadUnsupportedMessage || `当前 ${params.label} 版本不支持恢复会话，未创建替代会话或重发输入。`);
          }
        }
        if (params.authenticateParams) {
          await client.request('authenticate', params.authenticateParams);
        }
        if (params.nativeSessionId) {
          const loaded = await client.request<Record<string, unknown>>('session/load', {
            sessionId: params.nativeSessionId,
            cwd: params.cwd,
            mcpServers: params.mcpServers ?? [],
          }, 120_000);
          session.configOptions = Array.isArray(loaded.configOptions)
            ? loaded.configOptions as Array<Record<string, unknown>>
            : [];
          if (loaded.modes && typeof loaded.modes === 'object') {
            session.modes = record(loaded.modes);
          }
        } else {
          const created = await client.request<Record<string, unknown>>('session/new', {
            cwd: params.cwd,
            mcpServers: params.mcpServers ?? [],
          }, 120_000);
          const createdId = typeof created.sessionId === 'string' ? created.sessionId.trim() : '';
          if (!createdId) {
            throw new Error(params.missingNativeIdMessage || `${params.label} 未返回原生会话 ID。`);
          }
          session.nativeSessionId = createdId;
          session.configOptions = Array.isArray(created.configOptions)
            ? created.configOptions as Array<Record<string, unknown>>
            : [];
          if (created.modes && typeof created.modes === 'object') {
            session.modes = record(created.modes);
          }
        }
      } finally {
        loadingRejector();
      }

      attachSessionListeners(session);
      session.state = 'ready';
      broadcastSessionState(session);
    })();

    try {
      await session.ready;
      return { reused: false, session: sessionSnapshot(session) };
    } catch (error) {
      await disposeManagedSession(session).catch(() => {});
      if (sessions.get(params.sessionKey) === session) sessions.delete(params.sessionKey);
      throw error;
    }
  };

  const sessionRpc = async (params: AcpSessionRpcParams): Promise<AcpSessionRpcResult> => {
    const session = sessions.get(params.sessionKey);
    if (!session || !session.client?.connected) {
      throw new Error(`ACP 会话不存在或已断开：${params.sessionKey}`);
    }
    const result = await session.client.request<Record<string, unknown>>(params.method, params.params, params.timeoutMs);
    const resultObj = record(result);
    if (Array.isArray(resultObj.configOptions)) {
      session.configOptions = resultObj.configOptions as Array<Record<string, unknown>>;
    }
    if (params.method === 'session/set_mode' && typeof params.params.modeId === 'string') {
      session.modes = { ...(session.modes || {}), currentModeId: params.params.modeId };
    }
    return { result, session: sessionSnapshot(session) };
  };

  const startTurn = async (params: AcpTurnStartParams, originSocket: net.Socket): Promise<AcpTurnStartResult> => {
    const session = sessions.get(params.sessionKey);
    if (!session || !session.client?.connected) {
      throw new Error(`ACP 会话未就绪：${params.sessionKey}`);
    }
    if (session.activeTurnId) {
      const existing = turns.get(session.activeTurnId);
      if (existing && isAcpTurnActiveStatus(existing.status)) {
        throw new Error(`${session.label} 上一轮尚未确认结束，请等待中断确认后再提交。`);
      }
    }
    if (!session.nativeSessionId) {
      throw new Error(`${session.label} 缺少原生会话 ID。`);
    }

    const turnId = params.turnId || randomUUID();
    const now = Date.now();
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => { resolveDone = resolve; });

    const turn: ManagedAcpTurn = {
      turnId,
      sessionKey: session.sessionKey,
      runtime: session.runtime,
      bridgeSessionId: session.bridgeSessionId,
      nativeSessionId: session.nativeSessionId,
      status: 'running',
      startedAt: now,
      updatedAt: now,
      nextSeq: 1,
      acked: false,
      meta: { ...params.meta },
      events: [],
      pendingRequests: new Map(),
      subscribers: new Set(),
      done,
      resolveDone,
    };

    turns.set(turnId, turn);
    session.activeTurnId = turnId;
    session.state = 'running';
    broadcastSessionState(session);

    const promptPromise = session.client.request<Record<string, unknown>>('session/prompt', {
      sessionId: session.nativeSessionId,
      prompt: params.prompt,
    }, 0);

    void promptPromise.then(
      (result) => {
        const stopReason = typeof result?.stopReason === 'string' ? result.stopReason : 'end_turn';
        const status: 'completed' | 'aborted' | 'failed' = stopReason === 'cancelled'
          ? 'aborted'
          : stopReason === 'end_turn'
            ? 'completed'
            : 'failed';
        finishTurn(session, turn, status, {
          stopReason,
          ...(status === 'failed' ? { error: `${session.label} 本轮未正常完成：${stopReason}` } : {}),
        });
      },
      (error) => {
        const message = error instanceof Error ? error.message : String(error);
        const wasCancelling = turn.status === 'cancelling';
        finishTurn(session, turn, wasCancelling ? 'aborted' : 'failed', {
          ...(wasCancelling ? { stopReason: 'cancelled' } : { error: message }),
        });
      },
    );

    return { turn: turnSnapshot(turn) };
  };

  const subscribeTurn = (params: AcpTurnSubscribeParams, socket: net.Socket): AcpTurnSubscribeResult => {
    const turn = turns.get(params.turnId);
    if (!turn) {
      throw new Error(`找不到 ACP 轮次：${params.turnId}`);
    }
    const afterSeq = typeof params.afterSeq === 'number' && Number.isFinite(params.afterSeq) ? params.afterSeq : 0;
    const snapshot = turnSnapshot(turn);
    const missed = turn.events.filter((evt) => evt.seq > afterSeq);
    // Defer adding to live subscribers until missed events are flushed on the wire
    // right after the RPC response, guaranteeing strictly monotonic, duplicate-free delivery.
    queueMicrotask(() => {
      if (socket.destroyed || !socket.writable) return;
      const replayedMaxSeq = missed.length > 0 ? missed[missed.length - 1]!.seq : afterSeq;
      for (const item of missed) {
        sendFrame(socket, { event: 'turn/event', turnId: turn.turnId, item });
      }
      // Flush any events emitted during the microtask gap before joining live fanout.
      for (const item of turn.events) {
        if (item.seq > replayedMaxSeq) {
          sendFrame(socket, { event: 'turn/event', turnId: turn.turnId, item });
        }
      }
      turn.subscribers.add(socket);
    });
    return { turn: snapshot };
  };

  const respondTurnRequest = (params: AcpTurnRespondParams): { ok: boolean } => {
    const turn = turns.get(params.turnId);
    if (!turn) return { ok: false };
    const session = sessions.get(turn.sessionKey);
    const key = requestKey(params.requestId);
    const req = turn.pendingRequests.get(key);
    if (!req || !session?.client?.connected) return { ok: false };
    turn.pendingRequests.delete(key);
    if (params.error) {
      session.client.reject(req.requestId, params.error.code, params.error.message);
    } else {
      session.client.respond(req.requestId, params.result);
    }
    appendTurnEvent(turn, { kind: 'server_request_resolved', requestId: req.requestId });
    if (turn.status === 'waiting_permission' && turn.pendingRequests.size === 0) {
      turn.status = 'running';
      session.state = 'running';
      broadcastSessionState(session);
    }
    return { ok: true };
  };

  const cancelTurn = async (params: AcpTurnCancelParams): Promise<{ cancelled: boolean; turn?: AcpTurnSnapshot }> => {
    const turn = params.turnId
      ? turns.get(params.turnId)
      : (params.sessionKey ? (() => {
        const s = sessions.get(params.sessionKey);
        return s?.activeTurnId ? turns.get(s.activeTurnId) : undefined;
      })() : undefined);
    if (!turn || !isAcpTurnActiveStatus(turn.status)) {
      return { cancelled: false, ...(turn ? { turn: turnSnapshot(turn) } : {}) };
    }
    if (turn.cancellation) {
      await turn.cancellation;
      return { cancelled: true, turn: turnSnapshot(turn) };
    }

    const session = sessions.get(turn.sessionKey);
    turn.status = 'cancelling';
    if (session) {
      session.state = 'cancelling';
      broadcastSessionState(session);
    }

    const cancelTimeoutMs = params.cancelTimeoutMs ?? 15_000;
    turn.cancellation = (async () => {
      if (session?.client?.connected && session.nativeSessionId) {
        try {
          session.client.notify('session/cancel', { sessionId: session.nativeSessionId });
        } catch {
          // Ignore notify failure if child already closed.
        }
        cancelPendingRequestsOnClient(session, turn);
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          turn.done,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${session?.label || 'ACP'} 尚未确认中断，已关闭本连接防止重叠执行。`)), cancelTimeoutMs);
          }),
        ]);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (session) {
          await disposeManagedSession(session).catch(() => {});
          if (sessions.get(session.sessionKey) === session) sessions.delete(session.sessionKey);
          finishTurn(session, turn, 'failed', { error: msg });
        }
        throw error;
      } finally {
        if (timer) clearTimeout(timer);
      }
    })();

    await turn.cancellation;
    return { cancelled: true, turn: turnSnapshot(turn) };
  };

  const closeSession = async (sessionKey: string): Promise<{ closed: boolean }> => {
    const session = sessions.get(sessionKey);
    if (!session) return { closed: false };
    try {
      await cancelTurn({ sessionKey });
    } catch {
      // Proceed to hard disposal even if cancel timed out.
    }
    await session.ready.catch(() => {});
    await disposeManagedSession(session);
    if (sessions.get(sessionKey) === session) sessions.delete(sessionKey);
    return { closed: true };
  };

  const getHello = (): AcpHostHelloResult => {
    let activeTurnCount = 0;
    let unackedTurnCount = 0;
    for (const turn of turns.values()) {
      if (isAcpTurnActiveStatus(turn.status)) activeTurnCount += 1;
      if (!turn.acked) unackedTurnCount += 1;
    }
    return {
      capabilities: { cursorCommands: true },
      pid: process.pid,
      protocolVersion: ACP_HOST_PROTOCOL_VERSION,
      codeHash,
      startedAt,
      sessionCount: sessions.size,
      activeTurnCount,
      unackedTurnCount,
    };
  };

  const handleRequest = async (req: AcpHostRequestEnvelope, socket: net.Socket): Promise<unknown> => {
    if (shuttingDown) throw new Error('ACP Host 正在关闭，未接收新请求。');
    const p = record(req.params);
    switch (req.method) {
      case 'host/hello':
        return getHello();
      case 'host/shutdown': {
        const force = p.force === true;
        const hello = getHello();
        if (!force && (pendingOperations > 0 || hello.activeTurnCount > 0 || hello.unackedTurnCount > 0)) {
          return { ok: false, activeTurnCount: hello.activeTurnCount, unackedTurnCount: hello.unackedTurnCount };
        }
        shuttingDown = true;
        setImmediate(() => {
          void closeServer(force).then(() => options.onShutdownRequested?.());
        });
        return { ok: true };
      }
      case 'session/ensure':
        return ensureSession(req.params as AcpSessionEnsureParams);
      case 'session/rpc':
        return sessionRpc(req.params as AcpSessionRpcParams);
      case 'session/status': {
        const sessionKey = String(p.sessionKey || '');
        const session = sessions.get(sessionKey);
        return { session: session ? sessionSnapshot(session) : null };
      }
      case 'session/list':
        return { sessions: [...sessions.values()].map(sessionSnapshot) };
      case 'session/close':
        return closeSession(String(p.sessionKey || ''));
      case 'turn/start':
        return startTurn(req.params as AcpTurnStartParams, socket);
      case 'turn/subscribe':
        return subscribeTurn(req.params as AcpTurnSubscribeParams, socket);
      case 'turn/unsubscribe': {
        const turn = turns.get(String(p.turnId || ''));
        if (turn) turn.subscribers.delete(socket);
        return { ok: true };
      }
      case 'turn/respond':
        return respondTurnRequest(req.params as AcpTurnRespondParams);
      case 'turn/cancel':
        return cancelTurn(req.params as AcpTurnCancelParams);
      case 'turn/update_meta': {
        const update = req.params as AcpTurnUpdateMetaParams;
        const turn = turns.get(update.turnId);
        if (!turn) return { ok: false };
        if (update.metaPatch) {
          turn.meta = { ...turn.meta, ...update.metaPatch };
        }
        if (update.card) {
          turn.meta = { ...turn.meta, card: update.card };
        }
        turn.updatedAt = Date.now();
        return { ok: true, turn: turnSnapshot(turn) };
      }
      case 'turn/list_unacked': {
        const list = [...turns.values()]
          .filter((turn) => !turn.acked)
          .sort((a, b) => a.startedAt - b.startedAt)
          .map(turnSnapshot);
        return { turns: list };
      }
      case 'turn/get': {
        const turn = turns.get(String(p.turnId || ''));
        return { turn: turn ? turnSnapshot(turn) : null };
      }
      case 'turn/ack': {
        const turn = turns.get(String(p.turnId || ''));
        if (!turn || isAcpTurnActiveStatus(turn.status)) return { ok: false };
        turn.acked = true;
        pruneAckedTurns();
        return { ok: true };
      }
      default:
        throw new Error(`Unknown ACP host method: ${req.method}`);
    }
  };

  if (process.platform !== 'win32') {
    const dir = path.dirname(options.socketPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
    try { fs.unlinkSync(options.socketPath); } catch { /* may not exist */ }
  }

  const server = net.createServer((socket) => {
    allClients.add(socket);
    socket.setEncoding('utf8');
    let buffer = '';

    const detachSocket = (): void => {
      allClients.delete(socket);
      // CRITICAL: Detaching a bridge socket ONLY removes it from subscribers.
      // Running turns and pending permission requests remain alive in acp-host.
      for (const turn of turns.values()) {
        turn.subscribers.delete(socket);
      }
    };

    socket.on('close', detachSocket);
    socket.on('error', detachSocket);
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let req: AcpHostRequestEnvelope;
        try {
          req = JSON.parse(line) as AcpHostRequestEnvelope;
        } catch {
          continue;
        }
        if (typeof req.id !== 'number' || typeof req.method !== 'string') continue;
        // Session loading and configuration are work even before turn/start.
        // Register synchronously so a concurrent shutdown cannot overtake them.
        const operation = ['session/ensure', 'session/rpc', 'session/close', 'turn/start', 'turn/cancel'].includes(req.method);
        if (operation) pendingOperations += 1;
        void handleRequest(req, socket).finally(() => {
          if (operation) pendingOperations -= 1;
        }).then(
          (result) => sendFrame(socket, { id: req.id, result }),
          (error) => {
            const code = error instanceof AcpRpcError ? error.code : -32000;
            const message = error instanceof Error ? error.message : String(error);
            const data = error instanceof AcpRpcError ? error.data : undefined;
            sendFrame(socket, { id: req.id, error: { code, message, ...(data !== undefined ? { data } : {}) } });
          },
        );
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.socketPath, () => {
      server.removeListener('error', reject);
      if (process.platform !== 'win32') {
        try { fs.chmodSync(options.socketPath, 0o600); } catch { /* best effort */ }
      }
      resolve();
    });
  });

  const closeServer = (force = false): Promise<void> => {
    if (closing) return closing;
    shuttingDown = true;
    closing = (async () => {
      clearInterval(gcTimer);
      if (force) {
        await Promise.allSettled([...sessions.keys()].map((key) => closeSession(key)));
      } else {
        await Promise.allSettled([...sessions.values()].map(async (session) => {
          if (!session.activeTurnId) await disposeManagedSession(session);
        }));
      }
      for (const sock of allClients) {
        try { sock.destroy(); } catch { /* ignore */ }
      }
      allClients.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      // net.Server owns removal of its Unix socket; never unlink a successor's.
    })();
    return closing;
  };

  return {
    socketPath: options.socketPath,
    startedAt,
    getHello,
    close: closeServer,
  };
}
