import type { BridgeStore, InboundMessage } from '../../../domain/index.js';
import {
  clearPendingAttachmentConfirmation,
  registerPendingAttachmentConfirmation,
} from '../../command/attachment-confirmations.js';
import { buildCommandFields } from '../../command/presentation.js';
import type { CommandThreadDisplay } from '../../command/thread-display.js';
import { stopRunningSession } from '../stop-running-session.js';
import { buildAttachmentStopConfirmationCard } from './attachment-confirmation.js';
import { sessionLooksRunning } from './status-guards.js';
import type { SessionCommandDeps, SessionCommandResult } from './types.js';

/**
 * Completes the old-session half of a chat attachment transaction.
 * It never changes the binding: cancel/stale/error paths leave routing intact,
 * and the caller may commit the new target only after this function succeeds.
 */
export async function prepareCurrentSessionForAttachment(options: {
  msg: InboundMessage;
  store: BridgeStore;
  deps: SessionCommandDeps;
  threadDisplay: CommandThreadDisplay;
  markdown: boolean;
  targetArgs: string;
  targetIsCurrent: boolean;
  stopCurrentConfirmed: boolean;
  stopCurrentExpectedBindingId?: string;
}): Promise<SessionCommandResult | null> {
  const currentBinding = options.store.getChannelChat(
    options.msg.address.channelType,
    options.msg.address.chatId,
  );
  if (!currentBinding || options.targetIsCurrent) return null;
  const currentSession = options.store.getSession(currentBinding.bridgeSessionId);
  const activeTask = options.deps.getActiveTask(currentBinding.bridgeSessionId);
  const observedRunning = sessionLooksRunning(currentSession);
  if (!activeTask && !observedRunning) return null;

  if (!options.stopCurrentConfirmed) {
    const confirmedCommand = `/t ${options.targetArgs} --stop-current=${currentBinding.id}`;
    registerPendingAttachmentConfirmation(options.msg.address, confirmedCommand);
    return {
      response: buildCommandFields(
        '确认停止并切换会话',
        [
          ['当前线程', options.threadDisplay.binding(currentBinding).title],
          ['Session', currentBinding.bridgeSessionId],
          ['状态', activeTask ? '任务正在运行' : 'mirror/健康状态显示仍在运行'],
        ],
        [
          '回复“是”或点击“停止并切换”后，会先停止并等待当前任务结束，再切换到所选会话。',
          '回复“否”或点击“取消”时，当前绑定和运行状态都不会改变。',
        ],
        options.markdown,
      ),
      richCard: buildAttachmentStopConfirmationCard({
        confirmedCommand,
        currentBinding,
        threadDisplay: options.threadDisplay,
      }),
    };
  }

  if (
    options.stopCurrentExpectedBindingId
    && options.stopCurrentExpectedBindingId !== currentBinding.id
  ) {
    clearPendingAttachmentConfirmation(options.msg.address);
    return {
      response: '当前聊天绑定已在确认期间发生变化；没有停止任何任务，也没有执行切换。请重新发送 `/t` 选择会话。',
    };
  }

  clearPendingAttachmentConfirmation(options.msg.address);
  await stopRunningSession({
    store: options.store,
    binding: currentBinding,
    deps: options.deps,
    detail: '用户确认 /t 接管，先停止当前任务再切换会话。',
  });
  return null;
}
