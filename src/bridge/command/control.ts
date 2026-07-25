import {
  buildCommandFields,
} from './presentation.js';
import * as router from '../session/channel-router.js';
import type { BridgeSession, BridgeStore } from '../../domain/index.js';
import { sendTmuxInterrupt } from '../tmux/runtime.js';
import { resolveEffectiveRuntimeProvider } from '../session/support.js';
import { getSessionRuntimeTmuxSessionName } from '../../domain/session-runtime.js';
import { kimiTmuxSessionName } from '../../runtime/kimi/tmux-provider.js';
import type { CommandThreadDisplay } from './thread-display.js';
import type { ChannelChat, InboundMessage } from '../../domain/index.js';
import { sessionLooksRunning } from '../session/command-use-cases/status-guards.js';

export interface StopCommandDeps {
  getActiveTask(sessionId: string): { abortController: AbortController } | undefined;
  forceStopSession?(sessionId: string, detail?: string): Promise<boolean>;
  recordInteractiveHealthEnd?(sessionId: string, outcome: 'completed' | 'failed' | 'aborted', detail?: string): void;
}

function getStopTmuxInterruptTarget(
  session: BridgeSession | null | undefined,
  binding?: ChannelChat | null,
): string | undefined {
  if (!session) return undefined;
  const provider = resolveEffectiveRuntimeProvider(session, binding);
  if (provider.provider !== 'tmux' || !sessionLooksRunning(session)) return undefined;
  const tmuxSessionName = getSessionRuntimeTmuxSessionName(session)
    || (provider.runtime === 'kimi' ? kimiTmuxSessionName(session.id) : undefined);
  return tmuxSessionName || undefined;
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
  const tmuxInterruptTarget = getStopTmuxInterruptTarget(session, binding);
  if (!task && tmuxInterruptTarget) {
    const command = await sendTmuxInterrupt(tmuxInterruptTarget);
    const provider = resolveEffectiveRuntimeProvider(session, binding);
    const detail = `用户执行 /stop，已向 ${provider.identity} TUI 发送 C-c。`;
    options.deps.recordInteractiveHealthEnd?.(binding.bridgeSessionId, 'aborted', detail);
    return buildCommandFields(
      '已发送停止按键',
      [
        ['Provider', 'tmux'],
        ['tmux session', tmuxInterruptTarget],
      ],
      [
        '当前会话处于 tmux Provider，且 mirror 显示任务仍在输出；`/stop` 已映射为向 TUI 发送 `C-c`。',
        `底层命令：\`${command}\``,
      ],
      options.markdown,
    );
  }
  if (task || looksRunning) {
    const taskName = options.threadDisplay.binding(binding).title;
    const detail = '用户执行 /stop，已停止当前任务。';
    if (options.deps.forceStopSession) {
      await options.deps.forceStopSession(binding.bridgeSessionId, detail);
    } else if (task) {
      task.abortController.abort();
    }
    options.deps.recordInteractiveHealthEnd?.(binding.bridgeSessionId, 'aborted', detail);
    return `旧会话「${taskName}」任务已停止，可继续发送消息恢复该线程。`;
  }
  return '当前没有正在运行的任务。';
}
