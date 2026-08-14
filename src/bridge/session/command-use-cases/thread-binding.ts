import type { BaseChannelAdapter } from '../../../channels/contracts.js';
import type { BridgeSession, BridgeStore, ChannelChat, InboundMessage } from '../../../domain/index.js';
import type { RuntimeAgent } from '../../../domain/session.js';
import {
  getSessionActiveRuntime,
  getSessionRuntimeTmuxSessionName,
  getSessionWorkingDirectory,
} from '../../../domain/session-runtime.js';
import type { SessionRegistryService } from '../registry.js';
import { getBridgeSessionDisplayTitle } from '../display/session-display-query.js';
import { cleanupRuntimeTmuxSession } from '../../tmux/runtime.js';
import { kimiTmuxSessionName } from '../../../runtime/kimi/tmux-provider.js';
import { cursorTmuxSessionName } from '../../../runtime/cursor/tmux-provider.js';
import { zcodeTmuxSessionName } from '../../../runtime/zcode/tmux-provider.js';
import * as router from '../channel-router.js';
import { clearPendingAttachmentConfirmation } from '../../command/attachment-confirmations.js';
import { clearPendingTakeoverConfirmation } from '../../command/takeover-confirmations.js';
import {
  MAX_LOCAL_SESSION_LIST_LIMIT,
} from '../../command/aliases.js';
import {
  buildCommandFields,
  formatCommandPath,
  toUserVisibleBindingError,
} from '../../command/presentation.js';
import type { CommandThreadDisplay } from '../../command/thread-display.js';
import { validateThreadName } from './args.js';
import {
  listCommandLocalRuntimeSessions,
} from './source.js';
import {
  handleLocalRuntimeSessionsCommand,
} from './local-runtime-list.js';
import {
  auditCommandBindingChange,
  buildThreadCardRefresh,
  createCommandSessionRegistry,
  findBridgeOnlySessionByToken,
  findBridgeSessionByClaudeIdentity,
  findBridgeSessionByCodexThread,
  findBridgeSessionByKimiIdentity,
  findBridgeSessionByCursorIdentity,
  findBridgeSessionByZcodeIdentity,
  resolveCurrentCodexThreadTarget,
  selectDirectThreadTarget,
} from './thread-targets.js';
import {
  createGroupRenameBackgroundEffect,
  scheduleMirrorSubscriptionsBestEffort,
  type SessionCommandBackgroundEffect,
  type SessionCommandDeps,
  type SessionCommandResult,
} from './types.js';

async function cleanupBridgeSessionRuntimeTmuxBestEffort(session: BridgeSession | null | undefined, reason: string): Promise<void> {
  const runtime = getSessionActiveRuntime(session) || 'codex';
  const sessionName = getSessionRuntimeTmuxSessionName(session)
    || (runtime === 'kimi' && session
      ? kimiTmuxSessionName(session.id)
      : runtime === 'cursor' && session
        ? cursorTmuxSessionName(session.id)
        : runtime === 'zcode' && session
          ? zcodeTmuxSessionName(session.id)
        : undefined);
  if (!sessionName) return;
  const cleanup = await cleanupRuntimeTmuxSession({
    runtime,
    sessionName,
  });
  if (cleanup.error) {
    console.warn('[thread-binding] Failed to clean up runtime tmux session:', {
      reason,
      bridge_session_id: session?.id,
      tmux_session: sessionName,
      error: cleanup.error,
    });
  }
}

function bindingRuntimeIdentityFieldName(display: ReturnType<CommandThreadDisplay['binding']>): string {
  return display.originator === 'Claude Code' || display.originator === 'Kimi Code'
    ? 'session_id'
    : 'thread_id';
}

export async function handleThreadBindingCommand(options: {
  adapter: BaseChannelAdapter;
  msg: InboundMessage;
  args: string;
  store: BridgeStore;
  deps: SessionCommandDeps;
  threadDisplay: CommandThreadDisplay;
  markdown: boolean;
}): Promise<SessionCommandResult> {
  const parts = options.args.trim().split(/\s+/).filter(Boolean);
  const rawSubcommand = (parts[0] || '').toLowerCase();
  const subcommand = rawSubcommand;
  const subArgs = parts.slice(1).join(' ');

  if (!subcommand) {
    return handleLocalRuntimeSessionsCommand({
      msg: options.msg,
      args: '',
      threadDisplay: options.threadDisplay,
      markdown: options.markdown,
    });
  }

  if (subcommand === 'ls') {
    return {
      response: '已废除 `/t ls`。现在请直接使用 `/t` 查看本地会话表；卡片首列会标出当前聊天激活的会话和其他聊天激活的会话，其他聊天激活的会话会显示 bridge_id。',
    };
  }

  if (subcommand === 'takeover-cancel') {
    clearPendingAttachmentConfirmation(options.msg.address);
    clearPendingTakeoverConfirmation(options.msg.address);
    return { response: '已取消接管，当前聊天绑定保持不变。' };
  }

  if (subcommand === 'unbind') {
    const currentBinding = options.store.getChannelChat(options.msg.address.channelType, options.msg.address.chatId);
    if (!currentBinding) {
      const binding = router.createBinding(options.msg.address, undefined, undefined, { forceNewDraftSession: true });
      auditCommandBindingChange(
        options.store,
        'web_unbind',
        options.msg,
        null,
        binding,
        'unbind requested without existing binding; created fresh temporary binding',
      );
      const session = options.store.getSession(binding.bridgeSessionId);
      return {
        response: buildCommandFields(
          '当前聊天已解绑',
          [
            ['新 BridgeSession', binding.bridgeSessionId],
            ['目录', formatCommandPath(getSessionWorkingDirectory(session))],
          ],
          ['当前聊天之前没有有效绑定；已创建新的临时 BridgeSession 继续承接后续消息。'],
          options.markdown,
        ),
      };
    }

    const previousSession = options.store.getSession(currentBinding.bridgeSessionId);
    options.store.deleteChannelChat(currentBinding.id);
    options.deps.onBindingRemoved?.(currentBinding);
    const binding = router.createBinding(options.msg.address, undefined, undefined, { forceNewDraftSession: true });
    auditCommandBindingChange(
      options.store,
      'web_unbind',
      options.msg,
      currentBinding,
      binding,
      'im /t unbind',
    );
    scheduleMirrorSubscriptionsBestEffort(options.deps, 'thread unbind');
    const richCard = buildThreadCardRefresh(options.threadDisplay, options.deps.threadCardRefreshScope, options.msg.address, options.deps.threadCardSelectedId);
    const newSession = options.store.getSession(binding.bridgeSessionId);
    return {
      response: buildCommandFields(
        '当前聊天已解绑',
        [
          ['原线程', previousSession ? getBridgeSessionDisplayTitle(previousSession) : currentBinding.bridgeSessionId],
          ['新 BridgeSession', binding.bridgeSessionId],
          ['目录', formatCommandPath(getSessionWorkingDirectory(newSession))],
        ],
        ['当前聊天已绑定到新的临时 BridgeSession；原会话保留在本机，可通过 `/t` 重新接管。'],
        options.markdown,
      ),
      richCard,
      threadTableCardScope: richCard && options.deps.threadCardRefreshScope ? options.deps.threadCardRefreshScope : undefined,
    };
  }

  if (subcommand === 'archive') {
    const targetToken = subArgs.trim();
    let target: {
      threadId?: string;
      runtime?: RuntimeAgent;
      title?: string;
      cwd?: string;
      index?: number;
      bridgeSessionId?: string;
    } = {};

    if (targetToken) {
      const runtime = options.threadDisplay.activeRuntimeForChat(options.msg.address.channelType, options.msg.address.chatId);
      const displayedThreads = listCommandLocalRuntimeSessions(MAX_LOCAL_SESSION_LIST_LIMIT, runtime);
      if (!displayedThreads) {
        return { response: '读取本地会话列表失败，请稍后重试。' };
      }
      const bindings = options.store.listChannelChats();
      const bridgeBindings: Parameters<typeof selectDirectThreadTarget>[4] = [];
      const decoratedThreads = options.threadDisplay.decorateLocalRuntimeSessions(displayedThreads, options.msg.address.channelType, options.msg.address.chatId);
      const selected = selectDirectThreadTarget(options.threadDisplay, targetToken, bindings, decoratedThreads, bridgeBindings, options.store);
      if (selected.ambiguous) {
        return { response: '匹配到多个会话，请先发送 `/t` 查看列表，再用序号归档。' };
      }
      if (selected.binding) {
        const threadId = options.threadDisplay.bindingThreadId(selected.binding);
        if (!threadId) {
          const session = options.store.getSession(selected.binding.bridgeSessionId);
          if (!session) {
            return { response: '这个 Bridge 会话已经不存在。可发送 `/t` 刷新全局会话列表。' };
          }
          const bindingsBeforeArchive = options.store.listChannelChats()
            .filter((binding) => binding.bridgeSessionId === session.id);
          try {
            await cleanupBridgeSessionRuntimeTmuxBestEffort(session, 'bridge archive by binding');
            createCommandSessionRegistry(options.store).deleteBridgeSession(session.id);
          } catch (error) {
            return { response: toUserVisibleBindingError(error, '归档 Bridge 会话失败。') };
          }
          for (const binding of bindingsBeforeArchive) {
            options.deps.onBindingRemoved?.(binding);
          }
          scheduleMirrorSubscriptionsBestEffort(options.deps, 'bridge archive');
          const activeAfterArchive = options.store.getChannelChat(options.msg.address.channelType, options.msg.address.chatId);
          const richCard = buildThreadCardRefresh(options.threadDisplay, options.deps.threadCardRefreshScope, options.msg.address, options.deps.threadCardSelectedId);
          return {
            response: buildCommandFields(
              '已归档 Bridge 会话',
              [
                ['标题', getBridgeSessionDisplayTitle(session)],
                ['bridge_id', selected.binding.bridgeSessionId.slice(0, 8)],
                ['目录', formatCommandPath(getSessionWorkingDirectory(session))],
                ['解除绑定', `${bindingsBeforeArchive.length}`],
                ['当前', activeAfterArchive ? options.threadDisplay.binding(activeAfterArchive).title : '未绑定'],
              ],
              activeAfterArchive
                ? ['Bridge 会话已直接删除；当前聊天仍绑定到上面显示的会话。']
                : ['Bridge 会话已直接删除；之后直接发送文本会自动进入临时 BridgeSession。'],
              options.markdown,
            ),
            richCard,
            threadTableCardScope: richCard && options.deps.threadCardRefreshScope ? options.deps.threadCardRefreshScope : undefined,
          };
        }
        const session = options.store.getSession(selected.binding.bridgeSessionId);
        const activeRuntime = getSessionActiveRuntime(session) || 'codex';
        target = {
          threadId,
          runtime: activeRuntime === 'claude' || activeRuntime === 'kimi' || activeRuntime === 'cursor' || activeRuntime === 'zcode' ? activeRuntime : 'codex',
          title: options.threadDisplay.binding(selected.binding).title,
          cwd: getSessionWorkingDirectory(session),
          bridgeSessionId: selected.binding.bridgeSessionId,
        };
      } else if (selected.bridgeSession) {
        const bindingsBeforeArchive = options.store.listChannelChats()
          .filter((binding) => binding.bridgeSessionId === selected.bridgeSession!.id);
        try {
          await cleanupBridgeSessionRuntimeTmuxBestEffort(selected.bridgeSession, 'bridge archive by selected bridge session');
          createCommandSessionRegistry(options.store).deleteBridgeSession(selected.bridgeSession.id);
        } catch (error) {
          return { response: toUserVisibleBindingError(error, '归档 Bridge 会话失败。') };
        }
        for (const binding of bindingsBeforeArchive) {
          options.deps.onBindingRemoved?.(binding);
        }
        scheduleMirrorSubscriptionsBestEffort(options.deps, 'bridge archive');
        const activeAfterArchive = options.store.getChannelChat(options.msg.address.channelType, options.msg.address.chatId);
        const richCard = buildThreadCardRefresh(options.threadDisplay, options.deps.threadCardRefreshScope, options.msg.address, options.deps.threadCardSelectedId);
        return {
          response: buildCommandFields(
            '已归档 Bridge 会话',
            [
              ['标题', getBridgeSessionDisplayTitle(selected.bridgeSession)],
              ['解除绑定', `${bindingsBeforeArchive.length}`],
              ['当前', activeAfterArchive ? options.threadDisplay.binding(activeAfterArchive).title : '未绑定'],
            ],
            activeAfterArchive
              ? ['Bridge 会话已直接删除；当前聊天仍绑定到上面显示的会话。']
              : ['Bridge 会话已直接删除；之后直接发送文本会自动进入临时 BridgeSession。'],
            options.markdown,
          ),
          richCard,
          threadTableCardScope: richCard && options.deps.threadCardRefreshScope ? options.deps.threadCardRefreshScope : undefined,
        };
      } else if (!selected.threadId) {
        const bridgeOnlyMatch = findBridgeOnlySessionByToken(options.store, targetToken);
        if (bridgeOnlyMatch.ambiguous) {
          return { response: '匹配到多个 Bridge 会话，请先发送 `/t` 查看列表，再用序号归档。' };
        }
        if (bridgeOnlyMatch.session) {
          const bindingsBeforeArchive = options.store.listChannelChats()
            .filter((binding) => binding.bridgeSessionId === bridgeOnlyMatch.session!.id);
          try {
            await cleanupBridgeSessionRuntimeTmuxBestEffort(bridgeOnlyMatch.session, 'bridge archive by token');
            createCommandSessionRegistry(options.store).deleteBridgeSession(bridgeOnlyMatch.session.id);
          } catch (error) {
            return { response: toUserVisibleBindingError(error, '归档 Bridge 会话失败。') };
          }
          for (const binding of bindingsBeforeArchive) {
            options.deps.onBindingRemoved?.(binding);
          }
          scheduleMirrorSubscriptionsBestEffort(options.deps, 'bridge archive');
          const activeAfterArchive = options.store.getChannelChat(options.msg.address.channelType, options.msg.address.chatId);
          const richCard = buildThreadCardRefresh(options.threadDisplay, options.deps.threadCardRefreshScope, options.msg.address, options.deps.threadCardSelectedId);
          return {
            response: buildCommandFields(
              '已归档 Bridge 会话',
              [
                ['标题', getBridgeSessionDisplayTitle(bridgeOnlyMatch.session)],
                ['目录', formatCommandPath(getSessionWorkingDirectory(bridgeOnlyMatch.session))],
                ['解除绑定', `${bindingsBeforeArchive.length}`],
                ['当前', activeAfterArchive ? options.threadDisplay.binding(activeAfterArchive).title : '未绑定'],
              ],
              activeAfterArchive
                ? ['Bridge 会话已直接删除；当前聊天仍绑定到上面显示的会话。']
                : ['Bridge 会话已直接删除；之后直接发送文本会自动进入临时 BridgeSession。'],
              options.markdown,
            ),
            richCard,
            threadTableCardScope: richCard && options.deps.threadCardRefreshScope ? options.deps.threadCardRefreshScope : undefined,
          };
        }
        if (selected.index !== undefined) {
          return { response: `会话列表没有第 ${selected.index} 条。先发送 \`/t\` 查看列表，或直接使用 thread/session id / bridge_id / 名称。` };
        }
        return { response: `没有找到对应会话：${targetToken}。/t 列表按“序号 > thread/session id > bridge_id > 名称”解析；先发送 \`/t\` 刷新列表后优先用序号归档，或用 \`/t codex\`、\`/t claude\`、\`/t kimi\`、\`/t cursor\`、\`/t zcode\` 切换 runtime 列表。` };
      } else {
        target = {
          threadId: selected.threadId,
          runtime: selected.thread?.runtime || 'codex',
          title: selected.thread?.title,
          cwd: selected.thread?.cwd,
          index: selected.index,
        };
      }
    } else {
      target = resolveCurrentCodexThreadTarget(options.store, options.threadDisplay, options.msg.address);
      if (!target.threadId) {
        return {
          response: target.bridgeSessionId
            ? '当前聊天绑定的不是可归档的本地会话。请发送 `/t archive <序号|thread/session-id|bridge-id|名称>` 指定要归档的会话。'
            : '当前聊天还没有绑定本地会话。请发送 `/t archive <序号|thread/session-id|bridge-id|名称>` 指定要归档的会话。',
        };
      }
    }

    const threadId = target.threadId;
    if (!threadId) {
      return { response: '没有找到对应的本地会话。先发送 `/t` 查看列表，再用 `/t archive 1` 归档。' };
    }
    if (target.runtime === 'kimi') {
      const cwd = target.cwd;
      if (!cwd) return { response: '归档本地 Kimi Code 会话失败：缺少 cwd。' };
      const bridgeSessionBeforeArchive = findBridgeSessionByKimiIdentity(options.store, threadId, cwd);
      const bindingsBeforeArchive = options.store.listChannelChats()
        .filter((binding) => binding.bridgeSessionId === bridgeSessionBeforeArchive?.id);
      let result: ReturnType<SessionRegistryService['archiveKimiThread']>;
      try {
        await cleanupBridgeSessionRuntimeTmuxBestEffort(bridgeSessionBeforeArchive, 'kimi archive');
        result = createCommandSessionRegistry(options.store).archiveKimiThread(threadId, cwd);
      } catch (error) {
        return { response: toUserVisibleBindingError(error, '归档本地 Kimi Code 会话失败。') };
      }
      for (const binding of bindingsBeforeArchive) {
        options.deps.onBindingRemoved?.(binding);
      }
      scheduleMirrorSubscriptionsBestEffort(options.deps, 'kimi archive');
      const activeAfterArchive = options.store.getChannelChat(options.msg.address.channelType, options.msg.address.chatId);
      const richCard = buildThreadCardRefresh(options.threadDisplay, options.deps.threadCardRefreshScope, options.msg.address, options.deps.threadCardSelectedId);
      return {
        response: buildCommandFields(
          '已归档本地 Kimi Code 会话',
          [
            ['标题', target.title || threadId.slice(0, 8)],
            ['session_id', threadId],
            ['目录', formatCommandPath(result.cwd)],
            ['解除绑定', `${bindingsBeforeArchive.length}`],
            ['清理 Bridge 会话', `${result.deletedBridgeSessionIds.length}`],
            ['当前', activeAfterArchive ? options.threadDisplay.binding(activeAfterArchive).title : '未绑定'],
          ],
          activeAfterArchive
            ? ['当前聊天仍绑定到上面显示的会话。']
            : ['当前聊天已解除该 Kimi Code 会话绑定；之后直接发送文本会自动进入临时 BridgeSession。'],
          options.markdown,
        ),
        richCard,
        threadTableCardScope: richCard && options.deps.threadCardRefreshScope ? options.deps.threadCardRefreshScope : undefined,
      };
    }
    if (target.runtime === 'cursor') {
      const cwd = target.cwd;
      if (!cwd) return { response: '归档本地 Cursor Agent 会话失败：缺少 cwd。' };
      const bridgeSessionBeforeArchive = findBridgeSessionByCursorIdentity(options.store, threadId, cwd);
      const bindingsBeforeArchive = options.store.listChannelChats()
        .filter((binding) => binding.bridgeSessionId === bridgeSessionBeforeArchive?.id);
      let result: ReturnType<SessionRegistryService['archiveCursorThread']>;
      try {
        await cleanupBridgeSessionRuntimeTmuxBestEffort(bridgeSessionBeforeArchive, 'cursor archive');
        result = createCommandSessionRegistry(options.store).archiveCursorThread(threadId, cwd);
      } catch (error) {
        return { response: toUserVisibleBindingError(error, '归档本地 Cursor Agent 会话失败。') };
      }
      for (const binding of bindingsBeforeArchive) options.deps.onBindingRemoved?.(binding);
      scheduleMirrorSubscriptionsBestEffort(options.deps, 'cursor archive');
      const activeAfterArchive = options.store.getChannelChat(options.msg.address.channelType, options.msg.address.chatId);
      const richCard = buildThreadCardRefresh(options.threadDisplay, options.deps.threadCardRefreshScope, options.msg.address, options.deps.threadCardSelectedId);
      return {
        response: buildCommandFields(
          '已归档本地 Cursor Agent 会话',
          [
            ['标题', target.title || threadId.slice(0, 8)],
            ['session_id', threadId],
            ['目录', formatCommandPath(result.cwd)],
            ['解除绑定', `${bindingsBeforeArchive.length}`],
            ['清理 Bridge 会话', `${result.deletedBridgeSessionIds.length}`],
            ['当前', activeAfterArchive ? options.threadDisplay.binding(activeAfterArchive).title : '未绑定'],
          ],
          activeAfterArchive
            ? ['当前聊天仍绑定到上面显示的会话。']
            : ['当前聊天已解除该 Cursor Agent 会话绑定；之后直接发送文本会自动进入临时 BridgeSession。'],
          options.markdown,
        ),
        richCard,
      };
    }
    if (target.runtime === 'zcode') {
      const cwd = target.cwd;
      if (!cwd) return { response: '归档本地 ZCode 会话失败：缺少 cwd。' };
      const bridgeSessionBeforeArchive = findBridgeSessionByZcodeIdentity(options.store, threadId, cwd);
      const bindingsBeforeArchive = options.store.listChannelChats()
        .filter((binding) => binding.bridgeSessionId === bridgeSessionBeforeArchive?.id);
      let result: ReturnType<SessionRegistryService['archiveZcodeThread']>;
      try {
        await cleanupBridgeSessionRuntimeTmuxBestEffort(bridgeSessionBeforeArchive, 'zcode archive');
        result = createCommandSessionRegistry(options.store).archiveZcodeThread(threadId, cwd);
      } catch (error) {
        return { response: toUserVisibleBindingError(error, '归档本地 ZCode 会话失败。') };
      }
      for (const binding of bindingsBeforeArchive) options.deps.onBindingRemoved?.(binding);
      scheduleMirrorSubscriptionsBestEffort(options.deps, 'zcode archive');
      const activeAfterArchive = options.store.getChannelChat(options.msg.address.channelType, options.msg.address.chatId);
      const richCard = buildThreadCardRefresh(options.threadDisplay, options.deps.threadCardRefreshScope, options.msg.address, options.deps.threadCardSelectedId);
      return {
        response: buildCommandFields(
          '已归档本地 ZCode 会话',
          [
            ['标题', target.title || threadId.slice(0, 8)],
            ['session_id', threadId],
            ['目录', formatCommandPath(result.cwd)],
            ['解除绑定', `${bindingsBeforeArchive.length}`],
            ['清理 Bridge 会话', `${result.deletedBridgeSessionIds.length}`],
            ['当前', activeAfterArchive ? options.threadDisplay.binding(activeAfterArchive).title : '未绑定'],
          ],
          activeAfterArchive
            ? ['当前聊天仍绑定到上面显示的会话。']
            : ['当前聊天已解除该 ZCode 会话绑定；之后直接发送文本会自动进入临时 BridgeSession。'],
          options.markdown,
        ),
        richCard,
      };
    }
    if (target.runtime === 'claude') {
      const cwd = target.cwd;
      if (!cwd) return { response: '归档本地 Claude Code 会话失败：缺少 cwd。' };
      const bridgeSessionBeforeArchive = findBridgeSessionByClaudeIdentity(options.store, threadId, cwd);
      const bindingsBeforeArchive = options.store.listChannelChats()
        .filter((binding) => binding.bridgeSessionId === bridgeSessionBeforeArchive?.id);
      let result: ReturnType<SessionRegistryService['archiveClaudeThread']>;
      try {
        await cleanupBridgeSessionRuntimeTmuxBestEffort(bridgeSessionBeforeArchive, 'claude archive');
        result = createCommandSessionRegistry(options.store).archiveClaudeThread(threadId, cwd);
      } catch (error) {
        return { response: toUserVisibleBindingError(error, '归档本地 Claude Code 会话失败。') };
      }
      for (const binding of bindingsBeforeArchive) {
        options.deps.onBindingRemoved?.(binding);
      }
      scheduleMirrorSubscriptionsBestEffort(options.deps, 'claude archive');
      const activeAfterArchive = options.store.getChannelChat(options.msg.address.channelType, options.msg.address.chatId);
      const richCard = buildThreadCardRefresh(options.threadDisplay, options.deps.threadCardRefreshScope, options.msg.address, options.deps.threadCardSelectedId);
      return {
        response: buildCommandFields(
          '已归档本地 Claude Code 会话',
          [
            ['标题', target.title || threadId.slice(0, 8)],
            ['session_id', threadId],
            ['目录', formatCommandPath(result.cwd)],
            ['解除绑定', `${bindingsBeforeArchive.length}`],
            ['清理 Bridge 会话', `${result.deletedBridgeSessionIds.length}`],
            ['当前', activeAfterArchive ? options.threadDisplay.binding(activeAfterArchive).title : '未绑定'],
          ],
          activeAfterArchive
            ? ['当前聊天仍绑定到上面显示的会话。']
            : ['当前聊天已解除该 Claude Code 会话绑定；之后直接发送文本会自动进入临时 BridgeSession。'],
          options.markdown,
        ),
        richCard,
        threadTableCardScope: richCard && options.deps.threadCardRefreshScope ? options.deps.threadCardRefreshScope : undefined,
      };
    }
    const bridgeSessionBeforeArchive = findBridgeSessionByCodexThread(options.store, threadId);
    const bindingsBeforeArchive = options.store.listChannelChats()
      .filter((binding) => binding.bridgeSessionId === bridgeSessionBeforeArchive?.id);

    let result: ReturnType<SessionRegistryService['archiveCodexThread']>;
    try {
      await cleanupBridgeSessionRuntimeTmuxBestEffort(bridgeSessionBeforeArchive, 'codex archive');
      result = createCommandSessionRegistry(options.store).archiveCodexThread(threadId);
    } catch (error) {
      return { response: toUserVisibleBindingError(error, '归档本地 Codex 会话失败。') };
    }

    for (const binding of bindingsBeforeArchive) {
      options.deps.onBindingRemoved?.(binding);
    }
    scheduleMirrorSubscriptionsBestEffort(options.deps, 'codex archive');
    const activeAfterArchive = options.store.getChannelChat(options.msg.address.channelType, options.msg.address.chatId);
    const richCard = buildThreadCardRefresh(options.threadDisplay, options.deps.threadCardRefreshScope, options.msg.address, options.deps.threadCardSelectedId);
    const title = target.title || (bridgeSessionBeforeArchive ? getBridgeSessionDisplayTitle(bridgeSessionBeforeArchive) : threadId.slice(0, 8));

    return {
      response: buildCommandFields(
        '已归档本地 Codex 会话',
        [
          ['标题', title],
          ['thread_id', threadId],
          ['目录', formatCommandPath(target.cwd || getSessionWorkingDirectory(bridgeSessionBeforeArchive))],
          ['解除绑定', `${bindingsBeforeArchive.length}`],
          ['清理 Bridge 会话', `${result.deletedBridgeSessionIds.length}`],
          ['当前', activeAfterArchive ? options.threadDisplay.binding(activeAfterArchive).title : '未绑定'],
        ],
        activeAfterArchive
          ? ['当前聊天仍绑定到上面显示的会话。']
          : ['当前聊天已解除该 Codex 会话绑定；之后直接发送文本会自动进入临时 BridgeSession。'],
        options.markdown,
      ),
      richCard,
      threadTableCardScope: richCard && options.deps.threadCardRefreshScope ? options.deps.threadCardRefreshScope : undefined,
    };
  }

  if (subcommand === 'rename') {
    const binding = options.store.getChannelChat(options.msg.address.channelType, options.msg.address.chatId);
    if (!binding) {
      return { response: '当前聊天还没有绑定线程，无法重命名。' };
    }
    const parsed = validateThreadName(subArgs);
    if (!parsed.ok) {
      return { response: parsed.message };
    }
    const session = options.store.getSession(binding.bridgeSessionId);
    if (!session) {
      return { response: '当前会话不存在，无法重命名。' };
    }
    options.threadDisplay.renameBinding(binding, parsed.name);
    let groupRenameStatus: string | null = null;
    const backgroundEffects: SessionCommandBackgroundEffect[] = [];
    if (binding.chatKind === 'group') {
      const renameEffect = createGroupRenameBackgroundEffect(options.adapter, binding.chatId, parsed.name);
      if (renameEffect) {
        backgroundEffects.push(renameEffect);
        groupRenameStatus = `${parsed.name}（后台同步中）`;
      } else {
        groupRenameStatus = '当前通道不支持修改群聊名称';
      }
    }
    const display = options.threadDisplay.binding(binding);
    return {
      response: buildCommandFields(
        '当前线程已重命名',
        [
          ['新标题', parsed.name],
          ['群聊名称', groupRenameStatus],
          ['bridge_id', binding.bridgeSessionId.slice(0, 8)],
          [bindingRuntimeIdentityFieldName(display), options.threadDisplay.bindingThreadId(binding) || '-'],
        ],
        [],
        options.markdown,
      ),
      backgroundEffects,
    };
  }

  return { response: '用法：/t、/t codex、/t claude、/t kimi、/t cursor、/t zcode、/t <序号|thread/session-id|bridge-id|名称>、/t archive [序号|thread/session-id|bridge-id|名称]、/t rename <名称>' };
}
