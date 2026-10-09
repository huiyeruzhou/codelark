import { stopCursorDesktopThread } from '../../runtime/cursor/desktop-bridge-client.js';
import { resolveCursorTransport } from './cursor-transport.js';
import type { BridgeSession, BridgeStore, ChannelChat } from '../../domain/index.js';
import { getSessionCursorSessionId, getSessionClaudeSessionId, getSessionCodexThreadId, getSessionRuntimeTmuxSessionName } from '../../domain/session-runtime.js';
import { kimiTmuxSessionName } from '../../runtime/kimi/tmux-provider.js';
import { cursorTmuxSessionName } from '../../runtime/cursor/tmux-provider.js';
import { zcodeTmuxSessionName } from '../../runtime/zcode/tmux-provider.js';
import { claudeTmuxSessionName, codexTmuxSessionName, sendTmuxInterrupt } from '../tmux/runtime.js';
import { invalidateRuntimeTmuxInputReadiness } from '../tmux/input-state-machine.js';
import { resolveEffectiveRuntimeProvider } from './support.js';
import { getCodexAppServerSession } from '../../runtime/codex/app-server-registry.js';
import { prepareCodexAppServerForBinding } from '../command/tmux.js';

export interface StopRunningSessionDeps {
  getActiveTask(sessionId: string): { abortController: AbortController } | undefined;
  stopCursorDesktopThread?: typeof stopCursorDesktopThread;
  forceStopSession?(sessionId: string, detail?: string): Promise<boolean>;
  cancelQueuedSessionMessages?(sessionId: string): void;
  recordInteractiveHealthEnd?(sessionId: string, outcome: 'completed' | 'failed' | 'aborted', detail?: string): void;
}

export interface StopRunningSessionResult {
  /** A stop action was requested, not proof that the runtime reached a terminal state. */
  stopped: boolean;
  method: 'active_task' | 'tmux_interrupt' | 'app_server_interrupt' | 'desktop_interrupt' | 'idle';
  detail: string;
  tmuxSessionName?: string;
  command?: string;
}

/** A recorded runtime target, not evidence that a turn or tmux process is alive. */
export function getProviderOwnedRuntimeTmuxTarget(
  session: BridgeSession | null | undefined,
  binding: ChannelChat,
): { sessionName: string; runtime: 'codex' | 'claude' | 'kimi' | 'cursor' | 'zcode' } | undefined {
  if (!session || session.id !== binding.bridgeSessionId) return undefined;
  const provider = resolveEffectiveRuntimeProvider(session, binding);
  if (provider.provider !== 'tmux' || resolveCursorTransport(session) === 'desktop') return undefined;
  if (provider.runtime === 'codex'
    && (session.runtime?.codex?.appServerEndpoint || getCodexAppServerSession(session.id))) return undefined;
  const sessionName = getSessionRuntimeTmuxSessionName(session);
  if (!sessionName) return undefined;
  // /tmux-attach shares the same storage field. Only names generated for this
  // runtime's own thread/session are ownership evidence; never match a prefix.
  const threadId = getSessionCodexThreadId(session);
  const expected = provider.runtime === 'codex' ? (threadId ? [codexTmuxSessionName(threadId)] : [])
    : provider.runtime === 'claude' ? [claudeTmuxSessionName(session.id), claudeTmuxSessionName(getSessionClaudeSessionId(session) || session.id)]
      : provider.runtime === 'kimi' ? [kimiTmuxSessionName(session.id)]
        : provider.runtime === 'cursor' ? [cursorTmuxSessionName(session.id)]
          : [zcodeTmuxSessionName(session.id)];
  return expected.includes(sessionName) ? { sessionName, runtime: provider.runtime } : undefined;
}

function tmuxInterruptTarget(session: BridgeSession | null | undefined, binding: ChannelChat, hasActiveTask: boolean) {
  const recorded = getProviderOwnedRuntimeTmuxTarget(session, binding);
  if (recorded) return recorded;
  // These providers own a deterministic session for each active IM task even
  // before its attachment metadata has been written. Do not infer an idle target.
  if (!session || session.id !== binding.bridgeSessionId || !hasActiveTask || getSessionRuntimeTmuxSessionName(session)) return undefined;
  const provider = resolveEffectiveRuntimeProvider(session, binding);
  if (provider.provider !== 'tmux' || resolveCursorTransport(session) === 'desktop') return undefined;
  const sessionName = provider.runtime === 'kimi' ? kimiTmuxSessionName(session.id)
    : provider.runtime === 'zcode' ? zcodeTmuxSessionName(session.id) : undefined;
  return sessionName ? { sessionName, runtime: provider.runtime } : undefined;
}

function interruptDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendRuntimeInterrupts(
  target: { sessionName: string; runtime: 'codex' | 'claude' | 'kimi' | 'cursor' | 'zcode' },
  isCurrentTarget: () => boolean,
): Promise<string[]> {
  if (!isCurrentTarget()) return [];
  const commands = [await sendTmuxInterrupt(target.sessionName)];
  if (target.runtime === 'kimi') {
    await interruptDelay(150);
    if (isCurrentTarget()) commands.push(await sendTmuxInterrupt(target.sessionName));
  }
  if (isCurrentTarget()) {
    invalidateRuntimeTmuxInputReadiness(
      target.runtime,
      target.sessionName,
      'runtime was interrupted; revalidate the TUI before the next input',
    );
  }
  return commands;
}

export async function stopRunningSession(options: {
  store: BridgeStore;
  binding: ChannelChat;
  deps: StopRunningSessionDeps;
  detail: string;
}): Promise<StopRunningSessionResult> {
  const isCurrentBinding = (): boolean => options.store.getChannelChat(
    options.binding.channelType, options.binding.chatId,
  )?.bridgeSessionId === options.binding.bridgeSessionId;
  if (!isCurrentBinding()) {
    return { stopped: false, method: 'idle', detail: '当前聊天已切换绑定，未向旧会话发送停止请求。' };
  }
  options.deps.cancelQueuedSessionMessages?.(options.binding.bridgeSessionId);
  const session = options.store.getSession(options.binding.bridgeSessionId);
  if (session && resolveCursorTransport(session) === 'desktop') {
    const threadId = getSessionCursorSessionId(session);
    if (!threadId) throw new Error('当前 Cursor Desktop 会话没有绑定 thread，未发送停止请求。');
    const result = await (options.deps.stopCursorDesktopThread || stopCursorDesktopThread)(threadId, () => {
      const current = options.store.getSession(session.id);
      return isCurrentBinding() && resolveCursorTransport(current) === 'desktop'
        && getSessionCursorSessionId(current) === threadId;
    });
    // Keep the observer alive: only native lifecycle evidence can finish the task.
    return {
      stopped: result.status === 'interrupt-requested',
      method: result.status === 'interrupt-requested' ? 'desktop_interrupt' : 'idle',
      detail: result.status === 'interrupt-requested'
        ? '已向 Cursor Desktop 请求中断，等待后端确认轮次结束。'
        : 'Cursor Desktop 当前没有正在运行的轮次。',
    };
  }
  const registered = getCodexAppServerSession(options.binding.bridgeSessionId);
  if (session && resolveEffectiveRuntimeProvider(session, options.binding).runtime === 'codex'
    && (registered || session.runtime?.codex?.appServerEndpoint)) {
    const protocol = registered || await prepareCodexAppServerForBinding(options.store, options.binding, session);
    if (!protocol) throw new Error('协议线程的后端尚未恢复，未向独立 TUI 发送停止指令。');
    if (!isCurrentBinding()) {
      return { stopped: false, method: 'idle', detail: '当前聊天已切换绑定，未向旧会话发送停止请求。' };
    }
    const interrupted = await protocol.lifecycle.interrupt(protocol.threadId);
    return {
      stopped: interrupted,
      method: interrupted ? 'app_server_interrupt' : 'idle',
      detail: interrupted ? '已请求中断，等待 Codex 确认轮次结束。' : '当前没有正在运行的协议轮次。',
    };
  }
  const task = options.deps.getActiveTask(options.binding.bridgeSessionId);
  const target = tmuxInterruptTarget(session, options.binding, Boolean(task));
  const isCurrentTarget = (): boolean => {
    if (!target || !isCurrentBinding()) return false;
    const currentTask = options.deps.getActiveTask(options.binding.bridgeSessionId);
    if (currentTask && currentTask.abortController !== task?.abortController) return false;
    const current = tmuxInterruptTarget(options.store.getSession(options.binding.bridgeSessionId), options.binding, Boolean(task));
    return current?.runtime === target.runtime && current.sessionName === target.sessionName;
  };
  if (task) {
    if (options.deps.forceStopSession) {
      const handled = await options.deps.forceStopSession(options.binding.bridgeSessionId, options.detail);
      if (!handled) task.abortController.abort();
    } else {
      task.abortController.abort();
    }
    const commands = target?.runtime === 'kimi' || target?.runtime === 'zcode'
      ? await sendRuntimeInterrupts(target, isCurrentTarget)
      : [];
    return {
      stopped: true,
      method: 'active_task',
      detail: '已请求停止当前任务，等待执行结束确认。',
      ...(target?.runtime === 'kimi' || target?.runtime === 'zcode' ? {
        tmuxSessionName: target.sessionName,
        command: commands.join('\n'),
      } : {}),
    };
  }

  if (target) {
    const commands = await sendRuntimeInterrupts(target, isCurrentTarget);
    if (!commands.length) {
      return { stopped: false, method: 'idle', detail: '当前 runtime 绑定已变化，未发送停止按键。' };
    }
    return {
      stopped: true,
      method: 'tmux_interrupt',
      detail: '已发送停止按键，尚未确认底层任务结束。',
      tmuxSessionName: target.sessionName,
      command: commands.join('\n'),
    };
  }

  return { stopped: false, method: 'idle', detail: '当前没有可停止的活动任务或 runtime 终端；历史状态不表示任务仍在运行。' };
}
