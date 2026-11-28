import type { AcpConnection, AcpMessage } from '../acp/client.js';
import { cursorAcpSessionStorePath } from './acp-session-policy.js';
import { readCursorNativeGoal } from './cli-store.js';

/** One logical ACP prompt owns all native goal continuations, including while
 * the bridge is detached. The host retains the same turn, journal and Stop. */
export function withCursorGoalContinuation(client: AcpConnection, env: NodeJS.ProcessEnv = process.env): AcpConnection {
  const listeners = new Set<(message: AcpMessage) => void>();
  let cancelled = false;
  let active = false;
  let nativeFailure = false;
  const pendingTools = new Set<string>();
  const publish = (message: AcpMessage) => { for (const listener of listeners) listener(message); };
  const unsubscribe = client.onMessage(message => {
    const update = (message.params as any)?.update;
    if (active && update) {
      if (update.sessionUpdate === 'agent_message_chunk' && typeof update.content?.text === 'string'
        && (/^\n\nError: /u.test(update.content.text)
          || /^(?:\n\n)?(?:Please sign in|Upgrade your plan|Add a payment method|Check your settings) to continue/u.test(update.content.text))) nativeFailure = true;
      if (typeof update.toolCallId === 'string') {
        if (['completed', 'failed', 'cancelled'].includes(update.status)) pendingTools.delete(update.toolCallId);
        else if (update.sessionUpdate === 'tool_call') pendingTools.add(update.toolCallId);
      }
    }
    publish(message);
  });
  return {
    get connected() { return client.connected; },
    onMessage(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    onDisconnect: listener => client.onDisconnect(listener),
    respond: (id, result) => client.respond(id, result),
    reject: (id, code, message) => client.reject(id, code, message),
    notify(method, params) {
      if (method === 'session/cancel') cancelled = true;
      client.notify(method, params);
    },
    async close() { cancelled = true; unsubscribe(); await client.close(); },
    async request<T>(method: string, params: any = {}, timeoutMs?: number): Promise<T> {
      if (method !== 'session/prompt') return await client.request<T>(method, params, timeoutMs);
      if (active) throw new Error('Cursor goal 上一轮尚未结束，不能重叠执行。');
      active = true; cancelled = false;
      let next = params;
      let expectedGoal = (params.prompt || []).some((part: any) => part.type === 'text' && /^\/goal\s+\S/i.test(part.text));
      try {
        for (;;) {
          nativeFailure = false; pendingTools.clear();
          const result = await client.request<any>(method, next, timeoutMs);
          // Let a queued Stop/steer cancellation reach this boundary before starting again.
          await new Promise<void>(resolve => setImmediate(resolve));
          if (cancelled) return { ...result, stopReason: 'cancelled' } as T;
          if (result.stopReason !== 'end_turn' || nativeFailure) return result as T;
          const state = readCursorNativeGoal(cursorAcpSessionStorePath(params.sessionId, env));
          if (!state || !state.goal) {
            if (expectedGoal) throw new Error('Cursor 未提供可核实的原生目标状态，已停止自动续跑；未把本轮回复当作目标完成。');
            return result as T;
          }
          const goal = state.goal;
          if (goal.conversationId !== params.sessionId) throw new Error('Cursor 目标不属于当前会话，已停止自动续跑。');
          expectedGoal = true;
          if (goal.status === 1 && (state.pendingTools || pendingTools.size)) throw new Error('Cursor 目标仍有未确认的工具调用，已停止自动续跑，避免重复执行。');
          publish({ method: 'session/update', params: { sessionId: params.sessionId,
            update: { sessionUpdate: 'codelark_goal_update', goal, continuing: goal.status === 1 } } });
          if (goal.status !== 1) return result as T;
          next = { ...params, prompt: [{ type: 'text', text:
            `<codelark_goal_continuation goal_id="${goal.id}">\n当前原生目标仍为 active。继续推进已有目标，不创建或替换目标，不重复已完成的操作。达到完成条件后用原生 goal 工具标记完成；需要用户决定或外部条件时明确说明并暂停目标。\n</codelark_goal_continuation>` }] };
        }
      } finally { active = false; }
    },
  };
}
