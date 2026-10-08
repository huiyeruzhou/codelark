import type { BaseChannelAdapter } from '../../../channels/contracts.js';
import type { BridgeStore, ChannelChat, InboundMessage } from '../../../domain/index.js';
import {
  getSessionActiveRuntime,
  getSessionCodexThreadId,
  getSessionRuntimeTmuxSessionName,
  getSessionWorkingDirectory,
} from '../../../domain/session-runtime.js';
import { cleanupRuntimeTmuxSession } from '../../tmux/runtime.js';
import { getCodexAppServerSession, releaseCodexAppServerSession } from '../../../runtime/codex/app-server-registry.js';
import { releaseAppServerRequestObserver } from '../../permission/app-server.js';
import { getProviderOwnedRuntimeTmuxTarget, stopRunningSession } from '../stop-running-session.js';
import * as router from '../channel-router.js';
import {
  ensureWorkingDirectoryExists,
  resolveNewSessionWorkingDirectory,
} from '../support.js';
import { kimiTmuxSessionName } from '../../../runtime/kimi/tmux-provider.js';
import { cursorTmuxSessionName } from '../../../runtime/cursor/tmux-provider.js';
import { zcodeTmuxSessionName } from '../../../runtime/zcode/tmux-provider.js';
import { getSessionDisplayName } from '../display/session-title.js';
import {
  buildCommandFields,
  formatCommandPath,
} from '../../command/presentation.js';
import {
  formatSessionRuntimeMode,
  formatSessionRuntimeProvider,
} from '../../command/runtime-session.js';
import {
  clearPendingClearConfirmation,
  registerPendingClearConfirmation,
} from '../../command/clear-confirmations.js';
import type { CommandThreadDisplay } from '../../command/thread-display.js';
import {
  buildClearConfirmedCommand,
  CLEAR_SESSION_ARG_RULE_NOTE,
  deriveNewGroupName,
  parseClearConfirmationFlag,
  parseClearSessionArgs,
  validateNewSessionName,
} from './args.js';
import { inheritSessionConfiguration } from './inherit-session-configuration.js';
import { buildClearConfirmationCard } from './clear-confirmation.js';
import { sessionLooksRunning } from './status-guards.js';
import { auditCommandBindingChange } from './thread-targets.js';
import {
  createGroupRenameBackgroundEffect,
  scheduleMirrorSubscriptionsBestEffort,
  type SessionCommandBackgroundEffect,
  type SessionCommandDeps,
  type SessionCommandResult,
} from './types.js';

export async function handleClearSessionCommand(options: {
  adapter: BaseChannelAdapter;
  msg: InboundMessage;
  args: string;
  currentBinding: ChannelChat | null;
  store: BridgeStore;
  deps: SessionCommandDeps;
  threadDisplay: CommandThreadDisplay;
  markdown: boolean;
}): Promise<SessionCommandResult> {
  const confirmation = parseClearConfirmationFlag(options.args);
  const parsed = parseClearSessionArgs(confirmation.args);
  if ('error' in parsed) return { response: parsed.error };

  const previousBinding = options.currentBinding || options.store.getChannelChat(options.msg.address.channelType, options.msg.address.chatId);
  const previousSession = previousBinding ? options.store.getSession(previousBinding.bridgeSessionId) : null;
  // 参数错误不能先中断任务或解除旧线程订阅。
  const resolved = resolveNewSessionWorkingDirectory(parsed.pathArgs, previousBinding, previousSession);
  if (!resolved.ok) return { response: resolved.message };
  const workDir = resolved.workDir;
  const validatedName = validateNewSessionName(deriveNewGroupName(parsed.name, previousSession, workDir));
  if (!validatedName.ok) return { response: validatedName.message };
  const sessionName = validatedName.name;
  const protocol = previousSession ? getCodexAppServerSession(previousSession.id) : undefined;
  const usesProtocol = Boolean(protocol || (previousSession?.runtime?.codex?.appServerEndpoint && getSessionCodexThreadId(previousSession)));
  const protocolState = protocol?.lifecycle.snapshot(protocol.threadId);
  const sdkRunning = previousBinding ? Boolean(options.deps.getActiveTask(previousBinding.bridgeSessionId)) : false;
  const observedRunning = sessionLooksRunning(previousSession);
  const runningReasons = [
    usesProtocol && (!protocolState || protocolState.activity !== 'idle') ? '共享 Codex 线程正在运行或状态待确认' : null,
    sdkRunning ? 'sdk 正在运行' : null,
    !sdkRunning && observedRunning ? 'mirror/健康状态显示仍在运行' : null,
    !usesProtocol && previousBinding && getProviderOwnedRuntimeTmuxTarget(previousSession, previousBinding)
      ? '当前会话有旧版 runtime 终端，清空将结束该终端' : null,
  ].filter(Boolean) as string[];

  if (previousBinding && runningReasons.length > 0 && !confirmation.confirmed) {
    const confirmedCommand = buildClearConfirmedCommand(confirmation.args);
    registerPendingClearConfirmation(options.msg.address, confirmedCommand, Date.now(), previousBinding.bridgeSessionId);
    return {
      response: buildCommandFields(
        '确认清空当前对话',
        [
          ['当前线程', options.threadDisplay.binding(previousBinding).title],
          ['Session', previousBinding.bridgeSessionId],
          ['状态', runningReasons.join('，')],
        ],
        [
          '回复“是”或点击“终止并新建”会终止当前任务，并把当前聊天绑定到一个新的 BridgeSession。',
          '回复“否”或“取消”会保留当前对话。',
        ],
        options.markdown,
      ),
      richCard: buildClearConfirmationCard(confirmedCommand, previousBinding.bridgeSessionId),
    };
  }

  clearPendingClearConfirmation(options.msg.address);
  const cleanupNotes: string[] = [];
  if (previousBinding) {
    options.deps.cancelRuntimeWaits?.(previousBinding.bridgeSessionId);
  }
  if (previousBinding && runningReasons.length > 0) {
    const detail = '用户确认 /clear，终止当前任务并新建 BridgeSession。';
    if (usesProtocol) {
      try {
        await stopRunningSession({ store: options.store, binding: previousBinding, deps: options.deps, detail });
      } catch (error) {
        cleanupNotes.push(`旧任务未能停止，请在 Codex 中查看：${error instanceof Error ? error.message : String(error)}`);
      }
      // End this chat's delivery before detaching; a late backend reply must not enter the new conversation.
      if (options.deps.forceStopSession) await options.deps.forceStopSession(previousBinding.bridgeSessionId, detail);
      else options.deps.getActiveTask(previousBinding.bridgeSessionId)?.abortController.abort();
    } else if (options.deps.forceStopSession) {
      await options.deps.forceStopSession(previousBinding.bridgeSessionId, detail);
    } else {
      options.deps.getActiveTask(previousBinding.bridgeSessionId)?.abortController.abort();
    }
    if (!usesProtocol) options.deps.recordInteractiveHealthEnd?.(previousBinding.bridgeSessionId, 'aborted', detail);
  }
  const previousRuntime = getSessionActiveRuntime(previousSession) || 'codex';
  const previousRuntimeTmuxSessionName = getSessionRuntimeTmuxSessionName(previousSession)
    || (previousRuntime === 'kimi' && previousSession
      ? kimiTmuxSessionName(previousSession.id)
      : previousRuntime === 'cursor' && previousSession
        ? cursorTmuxSessionName(previousSession.id)
        : previousRuntime === 'zcode' && previousSession
          ? zcodeTmuxSessionName(previousSession.id)
        : undefined);
  let cleanedTmuxSessionName: string | null = null;
  if (previousSession && options.store.getChannelChat(options.msg.address.channelType, options.msg.address.chatId)?.bridgeSessionId !== previousSession.id) {
    return { response: '处理期间当前聊天已切换会话，未覆盖新的绑定。' };
  }
  if (usesProtocol && previousSession) {
    // Confirmation authorizes a new context. Old execution state is not an eligibility check.
    releaseAppServerRequestObserver(previousSession.id);
    try {
      await releaseCodexAppServerSession(previousSession.id);
    } catch (error) {
      cleanupNotes.push(`旧对话已在本端解除订阅，后端清理未确认：${error instanceof Error ? error.message : String(error)}`);
    }
    if (options.store.getChannelChat(options.msg.address.channelType, options.msg.address.chatId)?.bridgeSessionId !== previousSession.id) {
      return { response: '处理期间当前聊天已切换会话，未覆盖新的绑定。' };
    }
  } else if (previousRuntimeTmuxSessionName) {
    const cleanup = await cleanupRuntimeTmuxSession({
      runtime: previousRuntime,
      sessionName: previousRuntimeTmuxSessionName,
    });
    if (cleanup.error) {
      console.warn('[clear-session] Failed to clean up previous runtime tmux session:', {
        bridge_session_id: previousSession?.id,
        tmux_session: previousRuntimeTmuxSessionName,
        error: cleanup.error,
      });
    } else if (cleanup.killed) {
      cleanedTmuxSessionName = previousRuntimeTmuxSessionName;
    }
  }

  ensureWorkingDirectoryExists(workDir);
  let binding = router.createBinding(
    {
      ...options.msg.address,
      displayName: sessionName,
    },
    workDir,
    sessionName,
  );
  binding = inheritSessionConfiguration({
    store: options.store,
    sourceBinding: previousBinding,
    sourceSession: previousSession,
    newBinding: binding,
    workDir,
    preserveOtherRuntimeBindings: true,
  });
  const session = options.store.getSession(binding.bridgeSessionId);
  let groupRenameStatus: string | null = null;
  const backgroundEffects: SessionCommandBackgroundEffect[] = [];
  const shouldRenameGroup = options.msg.address.chatKind === 'group' || previousBinding?.chatKind === 'group';
  if (shouldRenameGroup) {
    const renameEffect = createGroupRenameBackgroundEffect(options.adapter, options.msg.address.chatId, sessionName);
    if (renameEffect) {
      backgroundEffects.push(renameEffect);
      groupRenameStatus = `${sessionName}（后台同步中）`;
    } else {
      groupRenameStatus = '当前通道不支持修改群聊名称';
    }
  }

  auditCommandBindingChange(
    options.store,
    'new_session',
    options.msg,
    previousBinding,
    binding,
    confirmation.confirmed ? 'clear confirmed' : 'clear',
  );
  scheduleMirrorSubscriptionsBestEffort(options.deps, 'clear session');

  return {
    response: buildCommandFields(
      '已清空当前聊天上下文',
      [
        ['新标题', session ? getSessionDisplayName(session, getSessionWorkingDirectory(session)) : sessionName],
        ['群聊名称', groupRenameStatus],
        ['目录', formatCommandPath(getSessionWorkingDirectory(session) || workDir)],
        ['模式', formatSessionRuntimeMode(binding, session)],
        ['Provider', formatSessionRuntimeProvider(session, binding)],
      ],
      [
        previousBinding && runningReasons.length > 0
          ? (usesProtocol ? '当前聊天已切到新对话，保留了原来的配置。' : '旧任务已按确认请求终止；当前聊天已切到新的 BridgeSession。')
          : '当前聊天已切到新的 BridgeSession。',
        ...cleanupNotes,
        ...(cleanedTmuxSessionName ? [`已清理旧 tmux Provider session：${cleanedTmuxSessionName}`] : []),
        CLEAR_SESSION_ARG_RULE_NOTE,
      ],
      options.markdown,
    ),
    backgroundEffects,
  };
}
