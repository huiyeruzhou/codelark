import {
  buildCommandFields,
} from './presentation.js';
import * as router from '../session/channel-router.js';
import type { BridgeStore } from '../../domain/index.js';
import type { CommandThreadDisplay } from './thread-display.js';
import type { ChannelChat, InboundMessage } from '../../domain/index.js';
import { stopRunningSession } from '../session/stop-running-session.js';

export interface StopCommandDeps {
  getActiveTask(sessionId: string): { abortController: AbortController } | undefined;
  forceStopSession?(sessionId: string, detail?: string): Promise<boolean>;
  cancelQueuedSessionMessages?(sessionId: string): void;
  recordInteractiveHealthEnd?(sessionId: string, outcome: 'completed' | 'failed' | 'aborted', detail?: string): void;
}

export async function handleStopCommand(options: {
  msg: InboundMessage;
  binding: ChannelChat | null;
  store: BridgeStore;
  deps: StopCommandDeps;
  threadDisplay: CommandThreadDisplay;
  markdown: boolean;
}): Promise<string> {
  const binding = options.binding || router.resolve(options.msg.address);
  const result = await stopRunningSession({
    store: options.store,
    binding,
    deps: options.deps,
    detail: '用户执行 /stop，请求停止当前任务。',
  });
  if (result.method !== 'tmux_interrupt') return result.detail;
  return buildCommandFields(
    '已发送停止按键',
    [
      ['Provider', 'tmux'],
      ['tmux session', result.tmuxSessionName],
    ],
    [
      '已向当前绑定的 runtime 终端发送 `C-c`；按键送达不代表底层任务已经结束。',
      `底层命令：\`${result.command}\``,
    ],
    options.markdown,
  );
}
