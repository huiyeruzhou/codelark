import type { AcpConnection, AcpMessage } from '../acp/client.js';
import { compactCursorSession, type CursorCompactOptions } from './cli-compact.js';
import { isCursorCompactPrompt } from './acp-commands.js';

/** Preserve the logical ACP connection while transferring its native store to
 * a one-shot CLI compactor. No second writer may overlap the ACP process. */
export function withCursorCompaction(
  initial: AcpConnection,
  restart: () => Promise<AcpConnection>,
  options: Pick<CursorCompactOptions, 'executable' | 'cwd' | 'env' | 'model'>,
  compact = compactCursorSession,
): AcpConnection {
  let client = initial, closed = false, suppressed = false;
  let compaction: AbortController | undefined;
  let compactDone: Promise<unknown> | undefined;
  const listeners = new Set<(m: AcpMessage) => void>(), disconnects = new Set<(e: Error) => void>();
  const publish = (m: AcpMessage) => { for (const fn of listeners) fn(m); };
  let offMessage = () => {}, offDisconnect = () => {};
  const attach = () => {
    offMessage = client.onMessage(m => { if (!suppressed) publish(m); else if (m.id !== undefined && m.method) client.reject(m.id, -32601, 'Reloading session'); });
    offDisconnect = client.onDisconnect(e => { if (!suppressed && !closed) for (const fn of disconnects) fn(e); });
  };
  attach();
  let initialize: any, authenticate: any, load: any;
  const settings = new Map<string, { method: string; params: any }>();
  const reload = async () => {
    const replacement = await restart();
    if (closed) { await replacement.close(); return; }
    client = replacement; attach();
    await client.request('initialize', initialize);
    if (authenticate) await client.request('authenticate', authenticate);
    await client.request('session/load', load, 120_000);
    for (const setting of settings.values()) await client.request(setting.method, setting.params);
  };
  return {
    get connected() { return !closed && (Boolean(compaction) || client.connected); },
    onMessage(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    onDisconnect(fn) { disconnects.add(fn); return () => { disconnects.delete(fn); }; },
    respond: (id, result) => client.respond(id, result), reject: (id, code, message) => client.reject(id, code, message),
    notify(method, params) {
      if (compaction && method === 'session/cancel') { compaction.abort(); return; }
      client.notify(method, params);
    },
    async close() {
      closed = true; compaction?.abort(); offMessage(); offDisconnect();
      // Closing must also interrupt initialize/load, rather than waiting for the
      // very RPC whose process close is needed to settle.
      await client.close(); await compactDone?.catch(() => {});
    },
    async request<T>(method: string, params: any = {}, timeoutMs?: number): Promise<T> {
      if (compaction) throw new Error('Cursor 正在压缩，不能重叠提交输入。');
      if (method === 'session/prompt' && isCursorCompactPrompt(params.prompt?.[0]?.text || '')) {
        if (!load || load.sessionId !== params.sessionId) throw new Error('无法确认待压缩的 Cursor 会话。');
        const abort = new AbortController(); compaction = abort;
        const update = (text: string) => publish({ method: 'session/update', params: { sessionId: load.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
        compactDone = (async () => {
          update('正在执行 Cursor 原生上下文压缩…\n');
          suppressed = true; offMessage(); offDisconnect();
          await client.close();
          let result: { before: number; after: number } | undefined, failure: unknown;
          try {
            const model = [...settings.values()].find(s => s.params.configId === 'model')?.params.value || options.model;
            result = await compact({ ...options, sessionId: load.sessionId, model, signal: abort.signal });
          } catch (error) { failure = error; }
          // Cancellation still restores ACP ownership before the next input.
          if (!closed) await reload();
          suppressed = false;
          if (abort.signal.aborted) return { stopReason: 'cancelled' };
          if (failure) throw failure;
          update(`压缩完成，已接回原 Cursor 会话。当前模型消息：${result!.before} → ${result!.after}；历史记录和目标保留。`);
          return { stopReason: 'end_turn' };
        })();
        try { return await compactDone as T; }
        finally { compaction = undefined; compactDone = undefined; suppressed = false; }
      }
      const result: any = await client.request(method, params, timeoutMs);
      if (method === 'initialize') initialize = params;
      if (method === 'authenticate') authenticate = params;
      if (method === 'session/new') load = { ...params, sessionId: result.sessionId };
      if (method === 'session/load') load = params;
      if (method === 'session/set_config_option' || method === 'session/set_mode') settings.set(params.configId || method, { method, params });
      return result as T;
    },
  };
}
