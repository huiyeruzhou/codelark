import {
  buildCommandFields,
} from './presentation.js';
import * as router from '../session/channel-router.js';
import type { BridgeStore } from '../../domain/index.js';
import type { CommandThreadDisplay } from './thread-display.js';
import type { ChannelChat, InboundMessage } from '../../domain/index.js';
import { sessionLooksRunning } from '../session/command-use-cases/status-guards.js';
import { stopRunningSession } from '../session/stop-running-session.js';

export interface StopCommandDeps {
  getActiveTask(sessionId: string): { abortController: AbortController } | undefined;
  forceStopSession?(sessionId: string, detail?: string): Promise<boolean>;
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
  const session = options.store.getSession(binding.bridgeSessionId);
  const task = options.deps.getActiveTask(binding.bridgeSessionId);
  const looksRunning = sessionLooksRunning(session);
  if (task || looksRunning) {
    const taskName = options.threadDisplay.binding(binding).title;
    const detail = '用户执行 /stop，已停止当前任务。';
    const result = await stopRunningSession({
      store: options.store,
      binding,
      deps: options.deps,
      detail,
    });
    if (result.method !== 'tmux_interrupt') {
      return `旧会话「${taskName}」任务已停止，可继续发送消息恢复该线程。`;
    }
    return buildCommandFields(
      '已发送停止按键',
      [
        ['Provider', 'tmux'],
        ['tmux session', result.tmuxSessionName],
      ],
      [
        '当前会话处于 tmux Provider，且 mirror 显示任务仍在输出；`/stop` 已映射为向 TUI 发送 `C-c`。',
        `底层命令：\`${result.command}\``,
      ],
      options.markdown,
    );
  }
  return '当前没有正在运行的任务。';
}
