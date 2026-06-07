import type { BaseChannelAdapter } from '../../../channels/contracts.js';
import { setSessionConfigPatch } from '../../../configuration/session-writes.js';
import type { BridgeStore, ChannelChat, InboundMessage } from '../../../domain/index.js';
import {
  getSessionWorkingDirectory,
} from '../../../domain/session-runtime.js';
import * as router from '../channel-router.js';
import {
  ensureWorkingDirectoryExists,
  getSessionCodexProviderOverride,
  resolveNewSessionWorkingDirectory,
} from '../support.js';
import { getSessionDisplayName } from '../display/session-title.js';
import {
  buildCommandFields,
  formatCommandPath,
} from '../../command/presentation.js';
import {
  formatSessionCodexProvider,
  formatSessionMode,
} from '../../command/runtime-settings.js';
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
import { buildClearConfirmationCard } from './clear-confirmation.js';
import { sessionLooksRunning } from './status-guards.js';
import { auditCommandBindingChange } from './thread-targets.js';
import {
  reconcileMirrorSubscriptionsBestEffort,
  type SessionCommandDeps,
  type SessionCommandResult,
} from './types.js';

function setSessionCodexProviderToml(sessionId: string, provider: 'tmux' | 'pty'): void {
  setSessionConfigPatch(sessionId, { runtime: { codex: { provider } } });
}

function setSessionTmuxAutoEnterToml(sessionId: string, tmuxAutoEnter: boolean): void {
  setSessionConfigPatch(sessionId, { session: { tmuxAutoEnter } });
}

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
  const sdkRunning = previousBinding ? Boolean(options.deps.getActiveTask(previousBinding.bridgeSessionId)) : false;
  const observedRunning = sessionLooksRunning(previousSession);
  const runningReasons = [
    sdkRunning ? 'sdk 正在运行' : null,
    !sdkRunning && observedRunning ? 'mirror/健康状态显示仍在运行' : null,
  ].filter(Boolean) as string[];

  if (previousBinding && runningReasons.length > 0 && !confirmation.confirmed) {
    const confirmedCommand = buildClearConfirmedCommand(confirmation.args);
    registerPendingClearConfirmation(options.msg.address, confirmedCommand);
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
      richCard: buildClearConfirmationCard(confirmedCommand),
    };
  }

  clearPendingClearConfirmation(options.msg.address);
  if (previousBinding && runningReasons.length > 0) {
    const detail = '用户确认 /clear，终止当前任务并新建 BridgeSession。';
    if (options.deps.forceStopSession) {
      await options.deps.forceStopSession(previousBinding.bridgeSessionId, detail);
    } else {
      options.deps.getActiveTask(previousBinding.bridgeSessionId)?.abortController.abort();
    }
    options.deps.recordInteractiveHealthEnd?.(previousBinding.bridgeSessionId, 'aborted', detail);
  }

  const resolved = resolveNewSessionWorkingDirectory(parsed.pathArgs, previousBinding, previousSession);
  if (!resolved.ok) return { response: resolved.message };
  const workDir = resolved.workDir;
  let sessionName = deriveNewGroupName(parsed.name, previousSession, workDir);
  const validatedName = validateNewSessionName(sessionName);
  if (!validatedName.ok) return { response: validatedName.message };
  sessionName = validatedName.name;

  ensureWorkingDirectoryExists(workDir);
  const binding = router.createBinding(
    {
      ...options.msg.address,
      displayName: sessionName,
    },
    workDir,
    sessionName,
  );
  let session = options.store.getSession(binding.bridgeSessionId);
  if (session) {
    const inheritedProvider = getSessionCodexProviderOverride(previousSession);
    if (inheritedProvider === 'tmux' || inheritedProvider === 'pty') {
      setSessionCodexProviderToml(session.id, inheritedProvider);
      if (inheritedProvider === 'tmux') setSessionTmuxAutoEnterToml(session.id, true);
    }
  }
  let groupRenameStatus: string | null = null;
  const shouldRenameGroup = options.msg.address.chatKind === 'group' || previousBinding?.chatKind === 'group';
  if (shouldRenameGroup) {
    if (options.adapter.renameGroupChat) {
      try {
        const renamed = await options.adapter.renameGroupChat(options.msg.address.chatId, sessionName);
        groupRenameStatus = renamed.name || sessionName;
      } catch (error) {
        groupRenameStatus = `失败：${error instanceof Error ? error.message : String(error)}`;
      }
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
  await reconcileMirrorSubscriptionsBestEffort(options.deps, 'clear session');

  return {
    response: buildCommandFields(
      '已清空当前聊天上下文',
      [
        ['新标题', session ? getSessionDisplayName(session, getSessionWorkingDirectory(session)) : sessionName],
        ['群聊名称', groupRenameStatus],
        ['目录', formatCommandPath(getSessionWorkingDirectory(session) || workDir)],
        ['模式', formatSessionMode(binding, session)],
        ['Provider', formatSessionCodexProvider(session, binding)],
      ],
      [
        previousBinding && runningReasons.length > 0
          ? '旧任务已按确认请求终止；当前聊天已切到新的 BridgeSession。'
          : '当前聊天已切到新的 BridgeSession。',
        CLEAR_SESSION_ARG_RULE_NOTE,
      ],
      options.markdown,
    ),
  };
}
