import type { BridgeSession, BridgeStore, ChannelChat } from '../../domain/index.js';
import { getSessionRuntimeTmuxSessionName } from '../../domain/session-runtime.js';
import { kimiTmuxSessionName } from '../../runtime/kimi/tmux-provider.js';
import { cursorTmuxSessionName } from '../../runtime/cursor/tmux-provider.js';
import { zcodeTmuxSessionName } from '../../runtime/zcode/tmux-provider.js';
import { sendTmuxInterrupt } from '../tmux/runtime.js';
import { invalidateRuntimeTmuxInputReadiness } from '../tmux/input-state-machine.js';
import { sessionLooksRunning } from './command-use-cases/status-guards.js';
import { resolveEffectiveRuntimeProvider } from './support.js';
import { getCodexAppServerSession } from '../../runtime/codex/app-server-registry.js';
import { prepareCodexAppServerForBinding } from '../command/tmux.js';

export interface StopRunningSessionDeps {
  getActiveTask(sessionId: string): { abortController: AbortController } | undefined;
  forceStopSession?(sessionId: string, detail?: string): Promise<boolean>;
  cancelQueuedSessionMessages?(sessionId: string): void;
  recordInteractiveHealthEnd?(sessionId: string, outcome: 'completed' | 'failed' | 'aborted', detail?: string): void;
}

export interface StopRunningSessionResult {
  stopped: boolean;
  method: 'active_task' | 'tmux_interrupt' | 'app_server_interrupt' | 'observed_state' | 'idle';
  detail: string;
  tmuxSessionName?: string;
  command?: string;
}

function tmuxInterruptTarget(
  session: BridgeSession | null | undefined,
  binding: ChannelChat,
): { sessionName: string; runtime: 'codex' | 'claude' | 'kimi' | 'cursor' | 'zcode' } | undefined {
  if (!session || !sessionLooksRunning(session)) return undefined;
  const provider = resolveEffectiveRuntimeProvider(session, binding);
  if (provider.provider !== 'tmux') return undefined;
  const sessionName = getSessionRuntimeTmuxSessionName(session)
    || (provider.runtime === 'kimi'
      ? kimiTmuxSessionName(session.id)
      : provider.runtime === 'cursor'
        ? cursorTmuxSessionName(session.id)
        : provider.runtime === 'zcode'
          ? zcodeTmuxSessionName(session.id)
        : undefined);
  return sessionName ? { sessionName, runtime: provider.runtime } : undefined;
}

function interruptDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendRuntimeInterrupts(
  target: { sessionName: string; runtime: 'codex' | 'claude' | 'kimi' | 'cursor' | 'zcode' },
): Promise<string[]> {
  const commands = [await sendTmuxInterrupt(target.sessionName)];
  if (target.runtime === 'kimi') {
    await interruptDelay(150);
    commands.push(await sendTmuxInterrupt(target.sessionName));
  }
  invalidateRuntimeTmuxInputReadiness(
    target.runtime,
    target.sessionName,
    'runtime was interrupted; revalidate the TUI before the next input',
  );
  return commands;
}

export async function stopRunningSession(options: {
  store: BridgeStore;
  binding: ChannelChat;
  deps: StopRunningSessionDeps;
  detail: string;
}): Promise<StopRunningSessionResult> {
  options.deps.cancelQueuedSessionMessages?.(options.binding.bridgeSessionId);
  const session = options.store.getSession(options.binding.bridgeSessionId);
  const registered = getCodexAppServerSession(options.binding.bridgeSessionId);
  if (session && (registered || session.runtime?.codex?.appServerEndpoint)) {
    const protocol = registered || await prepareCodexAppServerForBinding(options.store, options.binding, session);
    if (!protocol) throw new Error('协议线程的后端尚未恢复，未向独立 TUI 发送停止指令。');
    const interrupted = await protocol.lifecycle.interrupt(protocol.threadId);
    return {
      stopped: interrupted,
      method: interrupted ? 'app_server_interrupt' : 'idle',
      detail: interrupted ? '已请求中断，等待 Codex 确认轮次结束。' : '当前没有正在运行的协议轮次。',
    };
  }
  const task = options.deps.getActiveTask(options.binding.bridgeSessionId);
  const target = tmuxInterruptTarget(session, options.binding);
  if (task) {
    if (options.deps.forceStopSession) {
      await options.deps.forceStopSession(options.binding.bridgeSessionId, options.detail);
    } else {
      task.abortController.abort();
    }
    const commands = target?.runtime === 'kimi' || target?.runtime === 'zcode'
      ? await sendRuntimeInterrupts(target)
      : [];
    options.deps.recordInteractiveHealthEnd?.(options.binding.bridgeSessionId, 'aborted', options.detail);
    return {
      stopped: true,
      method: 'active_task',
      detail: options.detail,
      ...(target?.runtime === 'kimi' || target?.runtime === 'zcode' ? {
        tmuxSessionName: target.sessionName,
        command: commands.join('\n'),
      } : {}),
    };
  }

  if (target) {
    const commands = await sendRuntimeInterrupts(target);
    options.deps.recordInteractiveHealthEnd?.(options.binding.bridgeSessionId, 'aborted', options.detail);
    return {
      stopped: true,
      method: 'tmux_interrupt',
      detail: options.detail,
      tmuxSessionName: target.sessionName,
      command: commands.join('\n'),
    };
  }

  if (sessionLooksRunning(session)) {
    await options.deps.forceStopSession?.(options.binding.bridgeSessionId, options.detail);
    options.deps.recordInteractiveHealthEnd?.(options.binding.bridgeSessionId, 'aborted', options.detail);
    return { stopped: true, method: 'observed_state', detail: options.detail };
  }

  return { stopped: false, method: 'idle', detail: options.detail };
}
