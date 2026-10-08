import { randomUUID } from 'node:crypto';
import type { BridgeSession, ChannelChat, OutboundRichCard } from '../../domain/index.js';
import { buildCommandCallbackData } from './callbacks.js';

interface PendingDesktopRestart {
  bindingId: string;
  sessionId: string;
  threadId: string;
  retryText?: string;
  retryContextText?: string;
  createdAt: number;
}

const pendingRestarts = new Map<string, PendingDesktopRestart>();
const ttlMs = 10 * 60_000;

function prune(): void {
  for (const [id, pending] of pendingRestarts) {
    if (Date.now() - pending.createdAt > ttlMs) pendingRestarts.delete(id);
  }
}

export function requestCodexDesktopRestart(options: {
  binding: ChannelChat;
  session: BridgeSession;
  threadId: string;
  retryText?: string;
  retryContextText?: string;
}): { response: string; richCard: OutboundRichCard } {
  prune();
  for (const [id, pending] of pendingRestarts) {
    if (pending.bindingId === options.binding.id) pendingRestarts.delete(id);
  }
  const id = randomUUID();
  pendingRestarts.set(id, {
    bindingId: options.binding.id,
    sessionId: options.session.id,
    threadId: options.threadId,
    retryText: options.retryText,
    retryContextText: options.retryContextText,
    createdAt: Date.now(),
  });
  const retry = Boolean(options.retryText);
  const response = [
    '该 thread 仍由较早启动的 Codex Desktop 持有，无法直接迁移到共享 app-server。',
    '点击按钮会正常退出并重新打开 Codex Desktop；这会中断 Desktop 中正在运行的其他任务，但不会强制杀进程。',
    retry ? 'Desktop 重启成功后，CodeLark 会自动重试这条输入。' : 'Desktop 重启成功后，请重新发送含附件的输入。',
  ].join('\n\n');
  return {
    response,
    richCard: {
      title: '需要重启 Codex Desktop',
      template: 'orange',
      sections: [{ text: response }],
      actions: [[
        { text: retry ? '重启并重试' : '重启 Desktop', type: 'danger', callbackData: buildCommandCallbackData(`/codex-desktop-restart --confirm=${id}`, options.session.id) },
        { text: '取消', callbackData: buildCommandCallbackData(`/codex-desktop-restart --cancel=${id}`, options.session.id) },
      ]],
    },
  };
}

export function consumeCodexDesktopRestart(
  id: string,
  binding: ChannelChat,
  session: BridgeSession,
): PendingDesktopRestart | undefined {
  prune();
  const pending = pendingRestarts.get(id);
  pendingRestarts.delete(id);
  if (!pending || pending.bindingId !== binding.id || pending.sessionId !== session.id
    || pending.threadId !== session.runtime?.codex?.threadId) return;
  return pending;
}

export function cancelCodexDesktopRestart(id: string): boolean {
  return pendingRestarts.delete(id);
}
