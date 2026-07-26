import type { BridgeStore, ChannelChat, InboundMessage } from '../../../domain/index.js';
import {
  getSessionWorkingDirectory,
} from '../../../domain/session-runtime.js';
import * as router from '../channel-router.js';
import { registerPendingTakeoverConfirmation } from '../../command/takeover-confirmations.js';
import { getOrCreateDraftSession } from '../internal-sessions.js';
import {
  listBindingsForChat,
} from '../registry.js';
import {
  resetDraftSession,
} from '../support.js';
import { getSessionDisplayName } from '../display/session-title.js';
import {
  DEFAULT_LOCAL_SESSION_LIST_LIMIT,
  MAX_LOCAL_SESSION_LIST_LIMIT,
} from '../../command/aliases.js';
import {
  buildCommandFields,
  buildLocalRuntimeSessionsCommandResponse,
  formatCommandDateTime,
  formatCommandPath,
  toUserVisibleBindingError,
} from '../../command/presentation.js';
import type { CommandThreadDisplay } from '../../command/thread-display.js';
import { parseForceFlag } from './args.js';
import { sessionLooksRunning } from './status-guards.js';
import { listCommandLocalRuntimeSessions } from './source.js';
import { prepareCurrentSessionForAttachment } from './attachment-lifecycle.js';
import { buildTakeoverConfirmationCard } from './takeover-confirmation.js';
import {
  auditCommandBindingChange,
  bindToLocalRuntimeThread,
  buildThreadCardRefresh,
  findVisibleBridgeSessionByToken,
  findBridgeSessionByClaudeIdentity,
  findBridgeSessionByKimiIdentity,
  getRawCodexTitle,
  localRuntimeOf,
  selectDirectThreadTarget,
} from './thread-targets.js';
import type { SessionCommandDeps, SessionCommandResult } from './types.js';

function localRuntimeDisplayName(runtime: ReturnType<typeof localRuntimeOf>): string {
  if (runtime === 'claude') return 'Claude Code';
  if (runtime === 'kimi') return 'Kimi Code';
  return 'Codex';
}

function localRuntimeIdentityFieldName(runtime: ReturnType<typeof localRuntimeOf>): string {
  return runtime === 'codex' ? 'thread_id' : 'session_id';
}

function bindingRuntimeIdentityFieldName(display: ReturnType<CommandThreadDisplay['binding']>): string {
  return display.originator === 'Claude Code' || display.originator === 'Kimi Code'
    ? 'session_id'
    : 'thread_id';
}

function localRuntimeSwitchAction(runtime: ReturnType<typeof localRuntimeOf>): 'switch_bridge' | 'switch_codex' {
  return runtime === 'codex' ? 'switch_codex' : 'switch_bridge';
}

export async function handleThreadSwitchCommand(options: {
  msg: InboundMessage;
  args: string;
  currentBinding: ChannelChat | null;
  commandBinding: ChannelChat | null;
  store: BridgeStore;
  deps: SessionCommandDeps;
  threadDisplay: CommandThreadDisplay;
  markdown: boolean;
}): Promise<SessionCommandResult> {
  const parsedArgs = parseForceFlag(options.args);
  const takeoverConfirmed = /(^|\s)--takeover-yes(?=\s|$)/.test(parsedArgs.args);
  const stopCurrentMatch = parsedArgs.args.match(/(^|\s)--stop-current=([^\s]+)(?=\s|$)/);
  const stopCurrentExpectedBindingId = stopCurrentMatch?.[2];
  const stopCurrentConfirmed = parsedArgs.force || Boolean(stopCurrentExpectedBindingId);
  const threadArgs = parsedArgs.args
    .replace(/(^|\s)--takeover-yes(?=\s|$)/g, ' ')
    .replace(/(^|\s)--stop-current=[^\s]+(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const prepareCurrentSessionForSwitch = (targetIsCurrent: boolean) => prepareCurrentSessionForAttachment({
    msg: options.msg,
    store: options.store,
    deps: options.deps,
    threadDisplay: options.threadDisplay,
    markdown: options.markdown,
    targetArgs: threadArgs,
    targetIsCurrent,
    stopCurrentConfirmed,
    stopCurrentExpectedBindingId,
  });

  const findConflictBySessionId = (sessionId: string | undefined): ChannelChat | null => {
    if (!sessionId) return null;
    return options.store.listChannelChats().find((binding) => (
      binding.bridgeSessionId === sessionId
      && !(binding.channelType === options.msg.address.channelType && binding.chatId === options.msg.address.chatId)
    )) || null;
  };
  const findConflictByThreadId = (threadId: string | undefined): ChannelChat | null => {
    if (!threadId) return null;
    return options.store.listChannelChats().find((binding) => (
      options.threadDisplay.bindingThreadId(binding) === threadId
      && !(binding.channelType === options.msg.address.channelType && binding.chatId === options.msg.address.chatId)
    )) || null;
  };
  const prepareTakeover = async (conflict: ChannelChat | null): Promise<SessionCommandResult | null> => {
    if (!conflict) return null;
    const conflictSession = options.store.getSession(conflict.bridgeSessionId);
    if (sessionLooksRunning(conflictSession) || options.deps.getActiveTask(conflict.bridgeSessionId)) {
      return {
        response: buildCommandFields(
          '不能接管正在运行的会话',
          [
            ['标题', options.threadDisplay.binding(conflict).title],
            ['绑定聊天', conflict.chatId],
            ['Session', conflict.bridgeSessionId],
          ],
          ['请先在原聊天停止任务，或等待任务结束后再接管。'],
          options.markdown,
        ),
      };
    }
    const confirmedCommand = `/t ${threadArgs} --takeover-yes`;
    if (!takeoverConfirmed) {
      registerPendingTakeoverConfirmation(options.msg.address, confirmedCommand);
      return {
        response: buildCommandFields(
          '确认接管会话',
          [
            ['标题', options.threadDisplay.binding(conflict).title],
            ['绑定聊天', conflict.chatId],
            ['Session', conflict.bridgeSessionId],
          ],
          ['回复“是”或点击确认后，会先解绑原聊天，再把该会话绑定到当前聊天。'],
          options.markdown,
        ),
        richCard: buildTakeoverConfirmationCard({
          commandText: confirmedCommand,
          conflict,
          threadDisplay: options.threadDisplay,
        }),
      };
    }
    options.store.deleteChannelChat(conflict.id);
    options.deps.onBindingRemoved?.(conflict);
    auditCommandBindingChange(
      options.store,
      'web_unbind',
      options.msg,
      conflict,
      null,
      'takeover confirmed; unbound previous chat',
    );
    return null;
  };
  if (threadArgs === '0' || threadArgs === '0 reset') {
    const blocked = await prepareCurrentSessionForSwitch(false);
    if (blocked) return blocked;

    const temporarySession = threadArgs === '0 reset'
      ? resetDraftSession(options.msg.address)
      : getOrCreateDraftSession(options.store, options.msg.address);
    const binding = router.attachToSession(options.msg.address, temporarySession.id);
    if (!binding) {
      return { response: '临时 BridgeSession 切换失败。' };
    }
    const updatedBinding = options.store.getChannelChat(options.msg.address.channelType, options.msg.address.chatId) || binding;
    auditCommandBindingChange(
      options.store,
      'switch_draft',
      options.msg,
      options.commandBinding,
      updatedBinding,
      [
        threadArgs === '0 reset' ? 'reset' : null,
        parsedArgs.force ? 'forced' : null,
      ].filter(Boolean).join(', ') || undefined,
    );
    return {
      response: buildCommandFields(
        threadArgs === '0 reset' ? '已重置临时 BridgeSession' : '已切换到临时 BridgeSession',
        [
          ['标题', getSessionDisplayName(temporarySession, getSessionWorkingDirectory(temporarySession))],
          ['目录', formatCommandPath(getSessionWorkingDirectory(temporarySession))],
          ['过期时间', formatCommandDateTime(temporarySession.expires_at)],
          ['模式', 'normal'],
        ],
        ['这是隐藏的临时 BridgeSession，不会出现在常规会话列表中。'],
        options.markdown,
      ),
    };
  }

  if (!threadArgs) {
    return { response: `用法：/thread <序号>，或 /thread 0 进入临时 BridgeSession；发送 /t 查看最近 ${DEFAULT_LOCAL_SESSION_LIST_LIMIT} 条文本列表和最多 ${MAX_LOCAL_SESSION_LIST_LIMIT} 条卡片列表，或 /t n 100 查看最近 100 条本地会话` };
  }
  if (threadArgs === 'all') {
    const runtime = options.threadDisplay.activeRuntimeForChat(options.msg.address.channelType, options.msg.address.chatId);
    const localSessions = listCommandLocalRuntimeSessions(MAX_LOCAL_SESSION_LIST_LIMIT, runtime);
    if (!localSessions) {
      return { response: '读取本地会话列表失败，请稍后重试。' };
    }
    const decoratedSessions = options.threadDisplay.decorateLocalRuntimeSessions(localSessions, options.msg.address.channelType, options.msg.address.chatId);
    return {
      response: buildLocalRuntimeSessionsCommandResponse(
        decoratedSessions,
        options.markdown,
        true,
        MAX_LOCAL_SESSION_LIST_LIMIT,
        options.threadDisplay.threadBindingStates(options.msg.address.channelType, options.msg.address.chatId),
        [],
      ),
      richCard: options.threadDisplay.refreshedLocalRuntimeSessionsCard(
        decoratedSessions,
        true,
        MAX_LOCAL_SESSION_LIST_LIMIT,
        options.msg.address.channelType,
        options.msg.address.chatId,
        undefined,
        [],
        runtime,
      ),
      threadTableCardScope: 'global',
    };
  }

  const runtime = options.threadDisplay.activeRuntimeForChat(options.msg.address.channelType, options.msg.address.chatId);
  const displayedThreads = listCommandLocalRuntimeSessions(MAX_LOCAL_SESSION_LIST_LIMIT, runtime);
  if (!displayedThreads) {
    return { response: '读取本地会话列表失败，请稍后重试。' };
  }
  const decoratedThreads = options.threadDisplay.decorateLocalRuntimeSessions(displayedThreads, options.msg.address.channelType, options.msg.address.chatId);
  const bindings = listBindingsForChat(options.store, options.msg.address.channelType, options.msg.address.chatId);
  const selected = selectDirectThreadTarget(options.threadDisplay, threadArgs, bindings, decoratedThreads, [], options.store);
  if (selected.ambiguous) {
    return { response: '匹配到多个会话，请先发送 `/t` 查看列表，再用序号切换。' };
  }
  if (selected.binding) {
    const blocked = await prepareCurrentSessionForSwitch(
      selected.binding.id === options.commandBinding?.id,
    );
    if (blocked) return blocked;
    const previousActive = options.store.getChannelChat(options.msg.address.channelType, options.msg.address.chatId);
    const selectedDisplay = options.threadDisplay.binding(selected.binding);
    auditCommandBindingChange(
      options.store,
      'switch_binding',
      options.msg,
      previousActive,
      selected.binding,
      parsedArgs.force ? 'forced' : undefined,
    );
    const richCard = buildThreadCardRefresh(options.threadDisplay, options.deps.threadCardRefreshScope, options.msg.address, options.deps.threadCardSelectedId);
    return {
      response: buildCommandFields(
        '当前线程已切换',
        [
          ...(previousActive && previousActive.id !== selected.binding.id
            ? [['原线程', options.threadDisplay.binding(previousActive).title] as [string, string]]
            : []),
          ['当前', selectedDisplay.title],
          ['bridge_id', selected.binding.bridgeSessionId.slice(0, 8)],
          [bindingRuntimeIdentityFieldName(selectedDisplay), options.threadDisplay.bindingThreadId(selected.binding) || '-'],
        ],
        ['接下来直接发送文本即可继续。'],
        options.markdown,
      ),
      richCard,
      threadTableCardScope: richCard && options.deps.threadCardRefreshScope ? options.deps.threadCardRefreshScope : undefined,
    };
  }
  if (selected.bridgeSession) {
    const blocked = await prepareCurrentSessionForSwitch(
      selected.bridgeSession.id === options.commandBinding?.bridgeSessionId,
    );
    if (blocked) return blocked;
    const takeover = await prepareTakeover(findConflictBySessionId(selected.bridgeSession.id));
    if (takeover) return takeover;
    let binding: ReturnType<typeof router.attachToSession>;
    try {
      binding = router.attachToSession(options.msg.address, selected.bridgeSession.id);
    } catch (error) {
      return { response: toUserVisibleBindingError(error, '切换 Bridge 会话失败。') };
    }
    if (!binding) {
      return { response: `指定的 Bridge 会话不存在或已被删除：${threadArgs}。请发送 \`/t\` 刷新列表后用序号接管。` };
    }
    auditCommandBindingChange(
      options.store,
      'switch_bridge',
      options.msg,
      options.commandBinding,
      binding,
      parsedArgs.force ? 'forced' : undefined,
    );
    const richCard = buildThreadCardRefresh(options.threadDisplay, options.deps.threadCardRefreshScope, options.msg.address, options.deps.threadCardSelectedId);
    const bindingDisplay = options.threadDisplay.binding(binding);
    return {
      response: buildCommandFields(
        '已切换到 Bridge 会话',
        [
          ['标题', bindingDisplay.title],
          ['bridge_id', binding.bridgeSessionId.slice(0, 8)],
          [bindingRuntimeIdentityFieldName(bindingDisplay), options.threadDisplay.bindingThreadId(binding) || '-'],
          ['目录', formatCommandPath(getSessionWorkingDirectory(selected.bridgeSession))],
        ],
        ['接下来直接发送文本即可继续。'],
        options.markdown,
      ),
      richCard,
      threadTableCardScope: richCard && options.deps.threadCardRefreshScope ? options.deps.threadCardRefreshScope : undefined,
    };
  }
  if (!selected.threadId) {
    if (selected.index !== undefined) {
      return {
        response: displayedThreads.length > 0
          ? `当前只找到 ${displayedThreads.length} 条全局会话，没有第 ${selected.index} 条。先发送 \`/t\` 查看列表后再选择。`
          : '没有找到本地 Codex、Claude Code 或 Kimi Code 会话。先创建一个会话，再回来试一次。',
      };
    }
    const bridgeMatch = findVisibleBridgeSessionByToken(options.store, threadArgs);
    if (bridgeMatch.ambiguous) {
      return { response: '匹配到多个 Bridge 会话，请先发送 `/t` 查看列表，再使用更长的 bridge session id。' };
    }
    if (bridgeMatch.session) {
      const blocked = await prepareCurrentSessionForSwitch(
        bridgeMatch.session.id === options.commandBinding?.bridgeSessionId,
      );
      if (blocked) return blocked;
      const takeover = await prepareTakeover(findConflictBySessionId(bridgeMatch.session.id));
      if (takeover) return takeover;
      let binding: ReturnType<typeof router.attachToSession>;
      try {
        binding = router.attachToSession(options.msg.address, bridgeMatch.session.id);
      } catch (error) {
        return { response: toUserVisibleBindingError(error, '切换 Bridge 会话失败。') };
      }
      if (!binding) {
        return { response: `指定的 Bridge 会话不存在或已被删除：${threadArgs}。请发送 \`/t\` 刷新列表后用序号接管。` };
      }
      auditCommandBindingChange(
        options.store,
        'switch_bridge',
        options.msg,
        options.commandBinding,
        binding,
        parsedArgs.force ? 'forced' : undefined,
      );
      const richCard = buildThreadCardRefresh(options.threadDisplay, options.deps.threadCardRefreshScope, options.msg.address, options.deps.threadCardSelectedId);
      const bindingDisplay = options.threadDisplay.binding(binding);
      return {
        response: buildCommandFields(
          '已切换到 Bridge 会话',
          [
            ['标题', bindingDisplay.title],
            ['bridge_id', binding.bridgeSessionId.slice(0, 8)],
            [bindingRuntimeIdentityFieldName(bindingDisplay), options.threadDisplay.bindingThreadId(binding) || '-'],
            ['目录', formatCommandPath(getSessionWorkingDirectory(bridgeMatch.session))],
          ],
          ['接下来直接发送文本即可继续。'],
          options.markdown,
        ),
        richCard,
        threadTableCardScope: richCard && options.deps.threadCardRefreshScope ? options.deps.threadCardRefreshScope : undefined,
      };
    }
    return { response: `没有找到对应会话：${threadArgs}。/t 列表按“序号 > thread/session id > bridge_id > 名称”解析；先发送 \`/t\` 刷新列表后优先用序号接管，或用 \`/t codex\`、\`/t claude\`、\`/t kimi\` 切换 runtime 列表。` };
  }
  if (!selected.thread) {
    const blocked = await prepareCurrentSessionForSwitch(
      selected.threadId === (options.commandBinding
        ? options.threadDisplay.bindingThreadId(options.commandBinding)
        : undefined),
    );
    if (blocked) return blocked;
    const takeover = await prepareTakeover(findConflictByThreadId(selected.threadId));
    if (takeover) return takeover;
    let binding: ReturnType<typeof router.attachToCodexThread>;
    try {
      binding = router.attachToCodexThread(options.msg.address, selected.threadId);
    } catch (error) {
      return { response: toUserVisibleBindingError(error, '切换本地 Codex 会话失败。') };
    }
    auditCommandBindingChange(
      options.store,
      'switch_codex',
      options.msg,
      options.currentBinding,
      binding,
      parsedArgs.force ? 'forced' : undefined,
    );
    const richCard = buildThreadCardRefresh(options.threadDisplay, options.deps.threadCardRefreshScope, options.msg.address, options.deps.threadCardSelectedId);
    return {
      response: buildCommandFields(
        '已切换到本地 Codex 会话',
        [
          ['标题', options.threadDisplay.binding(binding).title],
          ['bridge_id', binding.bridgeSessionId.slice(0, 8)],
          ['thread_id', options.threadDisplay.bindingThreadId(binding) || selected.threadId],
          ['目录', formatCommandPath(getSessionWorkingDirectory(options.store.getSession(binding.bridgeSessionId)) || '')],
        ],
        ['接下来直接发送文本即可继续。'],
        options.markdown,
      ),
      richCard,
      threadTableCardScope: richCard && options.deps.threadCardRefreshScope ? options.deps.threadCardRefreshScope : undefined,
    };
  }

  let binding: ChannelChat;
  const selectedRuntime = localRuntimeOf(selected.thread);
  const blocked = await prepareCurrentSessionForSwitch(
    selected.thread.threadId === (options.commandBinding
      ? options.threadDisplay.bindingThreadId(options.commandBinding)
      : undefined),
  );
  if (blocked) return blocked;
  try {
    const conflict = selectedRuntime === 'claude'
      ? findConflictBySessionId(findBridgeSessionByClaudeIdentity(options.store, selected.thread.threadId, selected.thread.cwd)?.id)
      : selectedRuntime === 'kimi'
        ? findConflictBySessionId(findBridgeSessionByKimiIdentity(options.store, selected.thread.threadId, selected.thread.cwd)?.id)
        : findConflictByThreadId(selected.thread.threadId);
    const takeover = await prepareTakeover(conflict);
    if (takeover) return takeover;
    binding = bindToLocalRuntimeThread(options.store, options.msg.address, selected.thread, {
      codexTitle: selectedRuntime === 'codex'
        ? getRawCodexTitle(selected.thread.threadId, selected.thread.title)
        : undefined,
    });
  } catch (error) {
    return { response: toUserVisibleBindingError(error, `切换本地 ${localRuntimeDisplayName(selectedRuntime)} 会话失败。`) };
  }
  auditCommandBindingChange(
    options.store,
    localRuntimeSwitchAction(selectedRuntime),
    options.msg,
    options.commandBinding,
    binding,
    parsedArgs.force ? 'forced' : undefined,
  );
  const richCard = buildThreadCardRefresh(options.threadDisplay, options.deps.threadCardRefreshScope, options.msg.address, options.deps.threadCardSelectedId);
  return {
    response: buildCommandFields(
      `已切换到本地 ${localRuntimeDisplayName(selectedRuntime)} 会话`,
      [
        ['标题', options.threadDisplay.binding(binding).title],
        ['bridge_id', binding.bridgeSessionId.slice(0, 8)],
        [localRuntimeIdentityFieldName(selectedRuntime), options.threadDisplay.bindingThreadId(binding) || selected.thread.threadId],
        ['目录', formatCommandPath(getSessionWorkingDirectory(options.store.getSession(binding.bridgeSessionId)) || selected.thread.cwd)],
      ],
      ['接下来直接发送文本即可继续。'],
      options.markdown,
    ),
    richCard,
    threadTableCardScope: richCard && options.deps.threadCardRefreshScope ? options.deps.threadCardRefreshScope : undefined,
  };
}
