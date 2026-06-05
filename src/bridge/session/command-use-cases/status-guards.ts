import type { BridgeSession, BridgeStore, ChannelChat } from '../../../domain/index.js';
import { buildCommandFields } from '../../command/presentation.js';
import { CommandThreadDisplay } from '../../command/thread-display.js';

const RUNNING_HEALTH_STATUSES = new Set([
  'running_active',
  'waiting_tool',
  'slow_observed',
  'suspected_stall',
  'suspected_stream_ui_stall',
  'suspected_detached',
]);

export interface ActiveTaskLookupDeps {
  getActiveTask(sessionId: string): { abortController: AbortController } | undefined;
}

export function sessionLooksRunning(session: BridgeSession | null | undefined): boolean {
  return session?.runtime_status === 'running'
    || session?.runtime_status === 'queued'
    || RUNNING_HEALTH_STATUSES.has(session?.health_status || '');
}

function buildActiveTaskSwitchBlockedResponse(
  store: BridgeStore,
  binding: ChannelChat,
  markdown: boolean,
): string {
  const threadDisplay = new CommandThreadDisplay(store);
  return buildCommandFields(
    '当前会话仍在运行',
    [
      ['标题', threadDisplay.binding(binding).title],
      ['Session', binding.bridgeSessionId],
    ],
    [
      '为避免旧任务完成后把回复发到已经切走的聊天，当前不直接切换绑定。',
      '请先发送 `/stop` 停止当前任务；如果确认要强制切换，请在原命令末尾加 `--force`。',
    ],
    markdown,
  );
}

export function guardBindingChangeWhileRunning(
  store: BridgeStore,
  binding: ChannelChat | null,
  force: boolean,
  deps: ActiveTaskLookupDeps,
  markdown: boolean,
): string | null {
  if (!binding || force) return null;
  return deps.getActiveTask(binding.bridgeSessionId)
    ? buildActiveTaskSwitchBlockedResponse(store, binding, markdown)
    : null;
}
