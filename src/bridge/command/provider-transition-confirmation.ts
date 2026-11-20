import { randomUUID } from 'node:crypto';
import type { BridgeSession, ChannelChat } from '../../domain/index.js';
import { getSessionActiveRuntime } from '../../domain/session-runtime.js';
import type { SessionCommandResult } from '../session/command-use-cases/types.js';
import { buildCommandCallbackData } from './callbacks.js';

const confirmations = new Map<string, { bindingId: string; sessionId: string; runtime: string; provider: 'tmux' | 'acp'; task?: AbortController; createdAt: number }>();
const ttlMs = 10 * 60_000;

export function requestProviderTransition(binding: ChannelChat, session: BridgeSession, provider: 'tmux' | 'acp', task?: AbortController): SessionCommandResult {
  for (const [key, value] of confirmations) {
    if (Date.now() - value.createdAt > ttlMs || value.bindingId === binding.id) confirmations.delete(key);
  }
  const id = randomUUID();
  confirmations.set(id, { bindingId: binding.id, sessionId: session.id,
    runtime: getSessionActiveRuntime(session) || 'codex', provider, task, createdAt: Date.now() });
  const response = provider === 'tmux'
    ? '当前对话可能还有未结束的任务。点击“结束并重启”后会结束旧任务并继续 /p tmux，保留对话上下文；无需先执行 /stop。'
    : '点击“结束并切换 ACP”后会停止当前执行并切换到 ACP。旧会话记录保留；ACP 使用独立的原生会话，下一条消息开始使用实时事件。';
  return {
    response,
    richCard: {
      title: provider === 'tmux' ? '重启当前对话' : '切换到 ACP', template: 'orange', sections: [{ text: response }],
      actions: [[
        { text: provider === 'tmux' ? '结束并重启' : '结束并切换 ACP', type: 'danger', callbackData: buildCommandCallbackData(`/p ${provider} --restart=${id}`, session.id) },
        { text: '取消', callbackData: buildCommandCallbackData(`/p ${provider} --cancel-restart=${id}`, session.id) },
      ]],
    },
  };
}

/** A repeated or stale button cannot stop work started after the original restart. */
export function consumeProviderTransition(id: string, binding: ChannelChat, session: BridgeSession, provider: 'tmux' | 'acp', task?: AbortController): boolean {
  const pending = confirmations.get(id);
  confirmations.delete(id);
  return !!pending && Date.now() - pending.createdAt <= ttlMs && pending.bindingId === binding.id
    && pending.sessionId === session.id && pending.provider === provider && pending.runtime === (getSessionActiveRuntime(session) || 'codex')
    && (!task || pending.task === task);
}
