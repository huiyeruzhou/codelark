import { randomUUID } from 'node:crypto';
import type { BridgeSession, ChannelChat } from '../../domain/index.js';
import { getSessionActiveRuntime } from '../../domain/session-runtime.js';
import type { SessionCommandResult } from '../session/command-use-cases/types.js';
import { buildCommandCallbackData } from './callbacks.js';

const confirmations = new Map<string, { bindingId: string; sessionId: string; runtime: string; task?: AbortController; createdAt: number }>();
const ttlMs = 10 * 60_000;

export function requestTmuxRestart(binding: ChannelChat, session: BridgeSession, task?: AbortController): SessionCommandResult {
  for (const [key, value] of confirmations) {
    if (Date.now() - value.createdAt > ttlMs || value.bindingId === binding.id) confirmations.delete(key);
  }
  const id = randomUUID();
  confirmations.set(id, { bindingId: binding.id, sessionId: session.id,
    runtime: getSessionActiveRuntime(session) || 'codex', task, createdAt: Date.now() });
  const response = '当前对话可能还有未结束的任务。点击“结束并重启”后会结束旧任务并继续 /p tmux，保留对话上下文；无需先执行 /stop。';
  return {
    response,
    richCard: {
      title: '重启当前对话', template: 'orange', sections: [{ text: response }],
      actions: [[
        { text: '结束并重启', type: 'danger', callbackData: buildCommandCallbackData(`/p tmux --restart=${id}`, session.id) },
        { text: '取消', callbackData: buildCommandCallbackData(`/p tmux --cancel-restart=${id}`, session.id) },
      ]],
    },
  };
}

/** A repeated or stale button cannot stop work started after the original restart. */
export function consumeTmuxRestart(id: string, binding: ChannelChat, session: BridgeSession, task?: AbortController): boolean {
  const pending = confirmations.get(id);
  confirmations.delete(id);
  return !!pending && Date.now() - pending.createdAt <= ttlMs && pending.bindingId === binding.id
    && pending.sessionId === session.id && pending.runtime === (getSessionActiveRuntime(session) || 'codex')
    && (!task || pending.task === task);
}
