import { randomUUID } from 'node:crypto';
import type { BridgeMirrorRecord } from '../contracts.js';
import { AppServerRpcError, CodexAppServerClient, isUnsupportedAppServerMethod, type AppServerMessage } from './app-server-client.js';
import { protocolItemRecord, protocolRecord, protocolTurnRecord, type AppServerItem, type AppServerThread, type AppServerTurn } from './app-server-events.js';

export type AppServerInput = { type: 'text'; text: string; text_elements?: unknown[] } | { type: 'localImage'; path: string };
export interface AppServerThreadOptions {
  threadId?: string;
  cwd?: string;
  model?: string;
  sandbox?: string;
  approvalPolicy?: string;
  config?: Record<string, unknown>;
  developerInstructions?: string;
}
export interface AppServerSubmission { id: string; method: string; turnId?: string }
export interface AppServerPendingRequest {
  /** Includes connection generation: a callback from an old connection cannot answer a replay. */
  key: string;
  id: string | number;
  threadId: string;
  turnId?: string;
  method: string;
  params: Record<string, unknown>;
}
export interface AppServerThreadState {
  threadId: string;
  attached?: boolean;
  connection: 'connecting' | 'ready' | 'disconnected';
  activity: 'unknown' | 'idle' | 'active' | 'waiting';
  turnId?: string;
  submission?: AppServerSubmission;
  requests: AppServerPendingRequest[];
  error?: string;
}
export interface AppServerLifecycleOptions {
  connect?: () => Promise<CodexAppServerClient>;
  loadSubmission?: (threadId: string) => AppServerSubmission | undefined;
  saveSubmission?: (threadId: string, submission: AppServerSubmission | undefined) => void;
  loadActiveTurn?: (threadId: string) => string | undefined;
  saveActiveTurn?: (threadId: string, turnId: string | undefined) => void;
  resumeConfig?: Record<string, unknown>;
}
interface ThreadState {
  snapshot: AppServerThreadState;
  records: Map<string, { sequence: number; record: BridgeMirrorRecord }>;
  sequence: number;
  turns: Map<string, AppServerTurn>;
  items: Map<string, AppServerItem>;
  acceptedInputs: Map<string, string>;
  revision: number;
  serial: Promise<unknown>;
}

/** One backend owns execution. This object owns only a connection and thread subscriptions. */
export class CodexAppServerLifecycle {
  private client?: CodexAppServerClient;
  private connecting?: Promise<void>;
  private generation = 0;
  private identity = randomUUID();
  private disposed = false;
  private threads = new Map<string, ThreadState>();
  private listeners = new Set<(threadId: string) => void>();
  private requestListeners = new Set<(request: AppServerPendingRequest) => void>();
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectDelay = 250;
  private connectionUpdatedAt?: string;

  constructor(readonly endpoint: string, private options: AppServerLifecycleOptions = {}) {}

  /** Transport evidence, independent of whether thread/start or resume succeeded. No I/O. */
  connectionSnapshot(): { connection: 'connecting' | 'ready' | 'disconnected' | 'unknown'; updatedAt?: string } {
    return {
      connection: this.disposed ? 'disconnected' : this.client ? 'ready' : this.connecting ? 'connecting'
        : this.connectionUpdatedAt ? 'disconnected' : 'unknown',
      updatedAt: this.connectionUpdatedAt,
    };
  }

  onChange(listener: (threadId: string) => void): () => void {
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  }
  onRequest(listener: (request: AppServerPendingRequest) => void): () => void {
    this.requestListeners.add(listener); return () => this.requestListeners.delete(listener);
  }
  snapshot(threadId: string): AppServerThreadState {
    const state = this.threads.get(threadId)?.snapshot;
    if (!state) return { threadId, attached: false, connection: 'disconnected', activity: 'unknown', requests: [] };
    return { ...state, requests: [...state.requests] };
  }
  item(threadId: string, turnId: string, itemId: string): AppServerItem | undefined {
    const item = this.threads.get(threadId)?.items.get(`${turnId}:${itemId}`);
    return item ? structuredClone(item) : undefined;
  }
  recordsAfter(threadId: string, cursor = 0): { records: BridgeMirrorRecord[]; cursor: number } {
    const state = this.threads.get(threadId);
    if (!state) return { records: [], cursor };
    return { records: [...state.records.values()].filter((entry) => entry.sequence > cursor)
      .sort((a, b) => a.sequence - b.sequence).map((entry) => entry.record), cursor: state.sequence };
  }

  async connect(): Promise<void> {
    if (this.disposed) throw new Error('app-server 客户端已关闭。');
    if (this.connecting) return this.connecting;
    if (this.client) return;
    this.connectionUpdatedAt = new Date().toISOString();
    this.connecting = (async () => {
      const client = await (this.options.connect?.() ?? CodexAppServerClient.connect(this.endpoint));
      if (this.disposed) { client.close(); throw new Error('app-server 客户端已关闭。'); }
      this.client = client;
      this.connectionUpdatedAt = new Date().toISOString();
      this.generation += 1;
      client.onMessage((message) => { if (this.client === client) this.receive(message); });
      client.onDisconnect(() => {
        if (this.client !== client) return;
        this.client = undefined;
        this.connectionUpdatedAt = new Date().toISOString();
        for (const [id, state] of this.threads) {
          state.snapshot.connection = 'disconnected'; state.snapshot.activity = 'unknown';
          state.snapshot.requests = []; this.changed(id);
        }
        this.scheduleReconnect();
      });
      // Re-subscribe only. No input or permission response is ever replayed here.
      for (const [id, state] of this.threads) {
        try { await this.resume(id); }
        catch (error) {
          if (this.threads.get(id) !== state) continue;
          state.snapshot.connection = 'disconnected'; state.snapshot.activity = 'unknown';
          state.snapshot.error = String(error); this.changed(id);
        }
      }
      this.reconnectDelay = 250;
    })().catch((error) => {
      this.connectionUpdatedAt = new Date().toISOString();
      const client = this.client; this.client = undefined; client?.close();
      this.scheduleReconnect(); throw error;
    }).finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  async ensureThread(
    options: AppServerThreadOptions = {},
    beforeResume?: () => Promise<void>,
  ): Promise<string> {
    await this.connect();
    if (options.threadId) {
      const existing = this.threads.get(options.threadId);
      if (existing?.snapshot.connection !== 'ready') {
        try {
          await beforeResume?.();
          await this.resume(options.threadId, options.config);
        } catch (error) {
          // A rejected first attachment is not a subscription. Keeping the
          // provisional state would make reconnect treat it as one and retry
          // thread/resume even though no Bridge session owns this thread.
          if (!existing) {
            this.threads.delete(options.threadId);
            this.changed(options.threadId);
          }
          throw error;
        }
      }
      return options.threadId;
    }
    const { threadId: _, ...config } = options;
    const client = this.client!;
    const result = await client.request<{ thread: AppServerThread }>('thread/start', config);
    if (this.disposed || this.client !== client) throw new Error('创建线程期间连接已结束。');
    this.applyThread(result.thread, false);
    return result.thread.id;
  }

  /** Resume both returns state and replays unresolved requests to this connection. */
  private async resume(threadId: string, config?: Record<string, unknown>): Promise<void> {
    const state = this.thread(threadId);
    const before = state.revision;
    const resumeConfig = config || this.options.resumeConfig;
    const client = this.client!;
    const result = await client.request<{ thread: AppServerThread }>('thread/resume', { threadId, ...(resumeConfig ? { config: resumeConfig } : {}) });
    this.assertAttached(state, client);
    this.applyThread(result.thread, true, state.revision !== before);
  }

  async refresh(threadId: string): Promise<void> {
    const state = this.requireThread(threadId);
    await this.connect();
    this.assertAttached(state);
    const client = this.client!;
    const before = state.revision;
    let result: { thread: AppServerThread };
    try { result = await client.request('thread/read', { threadId, includeTurns: true }); }
    catch (error) {
      if (!(error instanceof AppServerRpcError) || error.code !== -32600 || !(
        error.message.endsWith('paginated threads do not support thread/read(includeTurns=true)')
        || error.message.endsWith('ephemeral threads do not support includeTurns')
        || error.message.endsWith(`thread ${threadId} is not materialized yet; includeTurns is unavailable before first user message`)
      )) throw error;
      this.assertAttached(state, client);
      result = await client.request('thread/read', { threadId, includeTurns: false });
    }
    this.assertAttached(state, client);
    this.applyThread(result.thread, true, state.revision !== before);
    if (state.snapshot.activity === 'unknown') await this.resume(threadId);
  }

  async submit(threadId: string, input: AppServerInput[], turnOptions: Record<string, unknown> = {}): Promise<string> {
    const state = this.requireThread(threadId);
    const operation = state.serial.catch(() => {}).then(async () => {
      await this.connect();
      this.assertAttached(state);
      if (state.snapshot.connection !== 'ready') await this.resume(threadId);
      this.assertAttached(state);
      if (state.snapshot.submission) throw new Error('上一条输入的提交结果尚未确认；已保留记录，没有重复发送。请先检查此线程的当前状态。');
      if (state.snapshot.activity === 'unknown') await this.refresh(threadId);
      this.assertAttached(state);
      if (state.snapshot.activity === 'unknown') throw new Error('尚未确认线程状态，未发送输入。');
      const active = state.snapshot.turnId;
      const method = active ? 'turn/steer' : 'turn/start';
      const submission: AppServerSubmission = { id: randomUUID(), method, turnId: active };
      this.saveSubmission(state, submission); // persisted BEFORE sending a side effect
      // A correlated userMessage proves acceptance even if the RPC response is lost.
      // Consume its native turn immediately, so a direct consumer never drops buffered output.
      let stopObserving = () => {};
      const accepted = new Promise<string>((resolve, reject) => {
        stopObserving = this.onChange((id) => {
          if (id !== threadId) return;
          if (this.threads.get(threadId) !== state) { reject(new Error('线程订阅已解除。')); return; }
          const turnId = state.acceptedInputs.get(submission.id);
          if (turnId) resolve(turnId);
        });
      });
      try {
        const response = this.client!.request<{ turn?: AppServerTurn; turnId?: string }>(method, {
          ...(!active ? turnOptions : {}), threadId, input,
          ...(active ? { expectedTurnId: active } : {}), clientUserMessageId: submission.id,
        }).then(async (result) => {
          this.assertAttached(state);
          const responseId = result.turn?.id || result.turnId || active;
          // 0.145 can return a submission id when another client started a turn concurrently.
          // Bind to the observed native turn or the client's accepted userMessage correlation.
          const turnId = active || await this.acceptedTurn(state, submission.id, responseId);
          this.assertAttached(state);
          if (!state.turns.has(turnId)) this.applyTurn(threadId, result.turn || { id: turnId, status: 'inProgress' });
          return turnId;
        });
        const turnId = await Promise.race([accepted, response]);
        this.assertAttached(state);
        this.saveSubmission(state, undefined);
        return turnId;
      } catch (error) {
        if (this.threads.get(threadId) !== state) throw error;
        if (error instanceof AppServerRpcError && [-32600, -32601, -32602, -32001].includes(error.code)) this.saveSubmission(state, undefined);
        else {
          state.snapshot.activity = 'unknown'; this.changed(threadId);
          // A live socket can also lose a reply to a timeout. Reconcile observation once,
          // without replaying the side effect or requiring a user to interrupt the turn.
          if (this.client) void this.refresh(threadId).catch((recoveryError) => {
            if (this.threads.get(threadId) !== state) return;
            state.snapshot.error = String(recoveryError); this.changed(threadId);
          });
        }
        throw error;
      } finally { stopObserving(); }
    });
    state.serial = operation;
    return operation;
  }

  async interrupt(threadId: string, expectedTurnId?: string): Promise<boolean> {
    const state = this.requireThread(threadId);
    await this.refresh(threadId);
    this.assertAttached(state);
    if (state.snapshot.activity === 'unknown') throw new Error('线程状态未知，未猜测要中断的轮次。');
    const turnId = state.snapshot.turnId;
    if (!turnId) return false;
    if (expectedTurnId && turnId !== expectedTurnId) return false;
    await this.client!.request('turn/interrupt', { threadId, turnId });
    // The response acknowledges the command; only turn/completed closes the turn.
    return true;
  }

  reply(key: string, result: unknown): boolean {
    for (const [id, state] of this.threads) {
      const request = state.snapshot.requests.find((r) => r.key === key);
      if (!request || !this.client || state.snapshot.connection !== 'ready') continue;
      this.client.send({ id: request.id, result });
      state.snapshot.requests = state.snapshot.requests.filter((r) => r.key !== key);
      this.changed(id); return true;
    }
    return false;
  }

  async detach(threadId: string): Promise<void> {
    this.threads.delete(threadId); // invalidate in-flight operations before awaiting unsubscribe
    this.changed(threadId);
    if (this.client) {
      try { await this.client.request('thread/unsubscribe', { threadId }); }
      catch (error) { if (!isUnsupportedAppServerMethod(error, 'thread/unsubscribe')) throw error; }
    }
  }

  close(): void {
    this.disposed = true;
    this.connectionUpdatedAt = new Date().toISOString();
    clearTimeout(this.reconnectTimer);
    this.client?.close(); this.client = undefined;
    this.listeners.clear(); this.requestListeners.clear();
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer || !this.threads.size) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect().catch(() => {});
    }, this.reconnectDelay);
    this.reconnectTimer.unref();
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 10_000);
  }

  private thread(id: string): ThreadState {
    let state = this.threads.get(id);
    if (!state) {
      state = { snapshot: { threadId: id, attached: true, connection: 'connecting', activity: 'unknown', requests: [], submission: this.options.loadSubmission?.(id) }, records: new Map(), sequence: 0, turns: new Map(), items: new Map(), acceptedInputs: new Map(), revision: 0, serial: Promise.resolve() };
      const active = this.options.loadActiveTurn?.(id);
      if (active) { state.turns.set(active, { id: active, status: 'inProgress' }); state.snapshot.turnId = active; }
      this.threads.set(id, state);
    }
    return state;
  }

  private requireThread(id: string): ThreadState {
    const state = this.threads.get(id);
    if (!state) throw new Error('线程订阅已解除。');
    return state;
  }
  private assertAttached(state: ThreadState, client?: CodexAppServerClient): void {
    if (this.disposed || this.threads.get(state.snapshot.threadId) !== state || (client && this.client !== client)) throw new Error('线程订阅或连接已结束，已丢弃旧请求回包。');
  }

  private changed(id: string): void { for (const listener of this.listeners) listener(id); }
  private acceptedTurn(state: ThreadState, clientId: string, responseId?: string): Promise<string> {
    const find = () => state.acceptedInputs.get(clientId) || (responseId && state.turns.has(responseId) ? responseId : undefined);
    const known = find();
    if (known) return Promise.resolve(known);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { unsubscribe(); reject(new Error('输入已获响应，但实际轮次身份尚未确认；没有重复提交。')); }, 10_000);
      const unsubscribe = this.onChange((id) => {
        if (id !== state.snapshot.threadId) return;
        const turnId = find();
        if (turnId) { clearTimeout(timer); unsubscribe(); resolve(turnId); }
        else if (this.threads.get(id) !== state || state.snapshot.connection === 'disconnected') { clearTimeout(timer); unsubscribe(); reject(new Error('确认轮次身份前连接或订阅断开；没有重复提交。')); }
      });
    });
  }
  private saveSubmission(state: ThreadState, value: AppServerSubmission | undefined): void {
    this.options.saveSubmission?.(state.snapshot.threadId, value);
    state.snapshot.submission = value; this.changed(state.snapshot.threadId);
  }
  private append(id: string, record: BridgeMirrorRecord | undefined): void {
    if (!record) return;
    const state = this.thread(id);
    // Keep the latest item snapshot, not N copies of an increasingly long answer.
    // Sequence numbers still let independent consumers observe every revision they need.
    const key = `${record.turnId}:${record.type}:${record.replacementKey || record.toolId || record.signature.split(':').slice(0, -1).join(':')}`;
    if (state.records.get(key)?.record.signature === record.signature) return;
    state.records.set(key, { sequence: ++state.sequence, record });
    this.changed(id);
  }

  private applyThread(thread: AppServerThread, history: boolean, newerEvents = false): void {
    const state = this.thread(thread.id);
    state.snapshot.connection = 'ready';
    state.snapshot.error = undefined;
    if (!Array.isArray(thread.turns)) {
      state.snapshot.activity = state.snapshot.turnId || thread.status?.type === 'active' ? 'unknown'
        : thread.status?.type === 'idle' ? 'idle' : 'unknown';
      this.changed(thread.id); return;
    }
    if (!newerEvents) state.snapshot.activity = 'idle';
    // Some app-server histories retain orphaned turns as inProgress after a
    // newer turn has already started. Only the last turn can be the current
    // server-side turn; replaying every orphan after a Bridge restart creates
    // duplicate cards and eventually finalizes them as interrupted.
    const lastTurn = thread.turns.at(-1);
    const activeHistoryTurnId = lastTurn?.status === 'inProgress' ? lastTurn.id : undefined;
    for (const turn of thread.turns || []) {
      // Initial attachment must not re-deliver the entire history as new IM messages.
      // On reconnect, reconcile only turns already observed or the one current turn.
      const confirmsSubmission = state.snapshot.submission && turn.items?.some((item) => item.type === 'userMessage' && item.clientId === state.snapshot.submission?.id);
      const knownTurn = state.turns.has(turn.id);
      if (history && !knownTurn && turn.id !== activeHistoryTurnId && !confirmsSubmission) continue;
      if (history && turn.status === 'inProgress' && turn.id !== activeHistoryTurnId && !confirmsSubmission) continue;
      const current = state.turns.get(turn.id);
      if (newerEvents && current) continue;
      if (!current) this.applyTurn(thread.id, { ...turn, status: 'inProgress' });
      for (const item of turn.items || []) this.applyItem(thread.id, turn.id, item, true);
      this.applyTurn(thread.id, turn);
    }
    if (state.snapshot.requests.length) state.snapshot.activity = 'waiting';
    else if (state.snapshot.turnId && !thread.turns.some((turn) => turn.id === state.snapshot.turnId && turn.status === 'inProgress')) state.snapshot.activity = 'unknown';
    else if (['active', 'systemError', 'notLoaded'].includes(thread.status?.type || '') && !state.snapshot.turnId) state.snapshot.activity = 'unknown';
    this.changed(thread.id);
  }

  private applyTurn(threadId: string, turn: AppServerTurn): void {
    const state = this.thread(threadId);
    const previous = state.turns.get(turn.id);
    if (previous && previous.status !== 'inProgress') return;
    if (turn.status !== 'inProgress') {
      for (const item of turn.items || []) this.applyItem(threadId, turn.id, item, true);
    }
    state.turns.set(turn.id, turn);
    if (turn.status === 'inProgress') {
      if (state.snapshot.turnId !== turn.id) this.options.saveActiveTurn?.(threadId, turn.id);
      state.snapshot.turnId = turn.id;
      state.snapshot.activity = state.snapshot.requests.length ? 'waiting' : 'active';
    } else {
      if (state.snapshot.turnId === turn.id) {
        this.options.saveActiveTurn?.(threadId, undefined);
        state.snapshot.turnId = undefined; state.snapshot.activity = 'idle';
      }
      state.snapshot.requests = state.snapshot.requests.filter((r) => r.turnId && r.turnId !== turn.id);
    }
    this.append(threadId, protocolTurnRecord(threadId, turn));
    this.changed(threadId);
  }

  private applyItem(threadId: string, turnId: string, item: AppServerItem, completed: boolean): void {
    const state = this.thread(threadId);
    // A terminal turn is immutable from the Bridge's point of view. Some
    // app-server versions can emit a delayed item completion after
    // turn/completed (for example when a yielded command process exits).
    // Re-emitting that item would make the mirror create a second card for a
    // turn it already finalized.
    const turn = state.turns.get(turnId);
    if (turn && turn.status !== 'inProgress') return;
    state.items.set(`${turnId}:${item.id}`, item);
    // The correlation id identifies a user message; it is not an idempotency guarantee.
    if (item.type === 'userMessage' && item.clientId) {
      state.acceptedInputs.set(item.clientId, turnId);
      if (state.snapshot.submission?.id === item.clientId) this.saveSubmission(state, undefined);
    }
    let record = protocolItemRecord(threadId, turnId, item, completed);
    if (record?.type === 'message' && record.role === 'assistant') {
      const content = [...state.items.entries()].filter(([key, value]) => key.startsWith(`${turnId}:`) && value.type === 'agentMessage' && value.phase !== 'commentary')
        .map(([, value]) => value.text || '').filter(Boolean).join('\n\n');
      record = protocolRecord(threadId, turnId, 'assistant', { type: 'message', role: 'assistant', content, replacementKey: `${turnId}:assistant` });
    }
    this.append(threadId, record);
  }

  private receive(message: AppServerMessage): void {
    const p = (message.params || {}) as Record<string, any>;
    const threadId = p.threadId || p.thread?.id;
    if (message.method === 'serverRequest/resolved') {
      for (const [id, state] of this.threads) {
        state.snapshot.requests = state.snapshot.requests.filter((r) => r.id !== p.requestId);
        if (!state.snapshot.requests.length && state.snapshot.activity === 'waiting') state.snapshot.activity = state.snapshot.turnId ? 'active' : 'idle';
        this.changed(id);
      }
      return;
    }
    if (!threadId || !this.threads.has(threadId)) return;
    const state = this.thread(threadId);
    if (message.method === 'thread/tokenUsage/updated') {
      // Resume replays persisted usage even for completed turns. Metadata neither
      // invalidates an in-flight thread snapshot nor starts a new output turn.
      if (state.turns.get(p.turnId)?.status === 'inProgress') {
        this.append(threadId, protocolRecord(threadId, p.turnId, 'usage', { type: 'context_usage', content: '', contextUsage: {
          modelContextWindow: p.tokenUsage?.modelContextWindow,
          lastTokenUsage: p.tokenUsage?.last, totalTokenUsage: p.tokenUsage?.total,
        } }));
      }
      return;
    }
    state.revision += 1;
    if (message.id !== undefined && message.method) {
      const request: AppServerPendingRequest = { key: `${this.identity}:${this.generation}:${message.id}`, id: message.id, threadId, turnId: p.turnId, method: message.method, params: p };
      if (state.snapshot.requests.some((r) => r.key === request.key)) return;
      state.snapshot.requests.push(request); state.snapshot.activity = 'waiting';
      this.changed(threadId);
      for (const listener of this.requestListeners) listener(request);
      return;
    }
    switch (message.method) {
      case 'thread/closed':
        state.snapshot.connection = 'disconnected'; state.snapshot.activity = 'unknown';
        state.snapshot.requests = []; this.changed(threadId); break;
      case 'turn/started': case 'turn/completed': this.applyTurn(threadId, p.turn); break;
      case 'item/started': case 'item/completed': this.applyItem(threadId, p.turnId, p.item, message.method === 'item/completed'); break;
      case 'item/agentMessage/delta': {
        const key = `${p.turnId}:${p.itemId}`;
        const item = state.items.get(key) || { id: p.itemId, type: 'agentMessage', text: '' };
        this.applyItem(threadId, p.turnId, { ...item, text: (item.text || '') + (p.delta || '') }, false);
        break;
      }
      case 'item/commandExecution/outputDelta': {
        const key = `${p.turnId}:${p.itemId}`;
        const item = state.items.get(key);
        if (item) this.applyItem(threadId, p.turnId, { ...item, aggregatedOutput: (item.aggregatedOutput || '') + (p.delta || '') }, false);
        break;
      }
      case 'thread/status/changed':
        if (p.status?.type === 'systemError' || p.status?.type === 'notLoaded') state.snapshot.activity = 'unknown';
        if (p.status?.type === 'active') state.snapshot.activity = state.snapshot.requests.length ? 'waiting' : state.snapshot.turnId ? 'active' : 'unknown';
        // idle is not a turn terminal; do not close a card from a status hint.
        if (p.status?.type === 'idle' && !state.snapshot.turnId) state.snapshot.activity = 'idle';
        this.changed(threadId); break;
      case 'turn/plan/updated':
        if (state.turns.has(p.turnId) && state.turns.get(p.turnId)?.status !== 'inProgress') break;
        this.append(threadId, protocolRecord(threadId, p.turnId, 'plan', { type: 'plan_update', content: p.explanation || '', tasks: (p.plan || []).map((s: any) => ({ text: s.step, status: s.status === 'inProgress' ? 'in_progress' : s.status === 'completed' ? 'completed' : 'pending' })) })); break;
      // Unknown notifications are optional enhancements, not session failures.
    }
  }
}
