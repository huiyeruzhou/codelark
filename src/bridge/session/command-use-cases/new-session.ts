import type { BaseChannelAdapter } from '../../../channels/contracts.js';
import { deliverBridgeNotice } from '../../../channels/delivery/feedback.js';
import { DEFAULT_WORKSPACE_ROOT } from '../../../configuration/index.js';
import type { BridgeSession, BridgeStore, ChannelChat, InboundMessage } from '../../../domain/index.js';
import {
  getSessionCodexProvider,
  getSessionWorkingDirectory,
  mergeSessionRuntimeUpdates,
  setSessionCodexProviderUpdate,
  setSessionTmuxAutoEnterUpdate,
} from '../../../domain/session-runtime.js';
import * as router from '../channel-router.js';
import {
  ensureWorkingDirectoryExists,
  getWorkspaceRoot,
  resolveEffectiveCodexProvider,
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
import type { CommandThreadDisplay } from '../../command/thread-display.js';
import {
  deriveNewGroupName,
  NEW_SESSION_ARG_RULE_NOTE,
  parseForceFlag,
  parseNewSessionArgs,
  validateNewSessionName,
} from './args.js';
import { guardBindingChangeWhileRunning } from './status-guards.js';
import { auditCommandBindingChange } from './thread-targets.js';
import type { SessionCommandDeps, SessionCommandResult } from './types.js';

type InheritedCodexProvider = ReturnType<typeof getSessionCodexProvider>;

function shouldEnableTmuxAutoEnterForNewSession(
  inheritedProvider: InheritedCodexProvider,
  session: BridgeSession,
): boolean {
  if (inheritedProvider === 'tmux') return true;
  if (inheritedProvider === 'pty') return false;
  return resolveEffectiveCodexProvider(session) === 'tmux';
}

export async function handleNewSessionCommand(options: {
  adapter: BaseChannelAdapter;
  msg: InboundMessage;
  args: string;
  commandBinding: ChannelChat | null;
  store: BridgeStore;
  deps: SessionCommandDeps;
  threadDisplay: CommandThreadDisplay;
  markdown: boolean;
}): Promise<SessionCommandResult> {
  const parsedArgs = parseForceFlag(options.args);
  const blocked = guardBindingChangeWhileRunning(
    options.store,
    options.commandBinding,
    parsedArgs.force,
    options.deps,
    options.markdown,
  );
  if (blocked) return { response: blocked };
  const newSessionArgs = parseNewSessionArgs(parsedArgs.args);
  if ('error' in newSessionArgs) return { response: newSessionArgs.error };
  let newSessionName = newSessionArgs.name;

  const currentSession = options.commandBinding
    ? options.store.getSession(options.commandBinding.bridgeSessionId)
    : null;
  const cloudDocument = options.msg.address.cloudDocument;
  if (cloudDocument) {
    if (!options.adapter.createGroupChat) {
      return { response: '当前通道不支持通过 `/new` 自动创建云文档群聊。' };
    }

    const existing = options.store.listChannelChats(options.msg.address.channelType)
      .find((binding) => (
        binding.cloudDocumentChat?.provider === 'feishu'
        && binding.cloudDocumentChat.fileToken === cloudDocument.fileToken
        && binding.cloudDocumentChat.fileType === cloudDocument.fileType
        && binding.cloudDocumentChat.commentId === cloudDocument.commentId
      ));
    if (existing) {
      return {
        response: buildCommandFields(
          '云文档群聊模式已开启',
          [
            ['群聊 chat_id', existing.chatId],
            ['Session', existing.bridgeSessionId],
          ],
          ['请到已创建的群聊继续聊天；云文档评论不会再接入 bot 对话。'],
          options.markdown,
        ),
      };
    }

    const resolved = newSessionArgs.pathArgs.trim()
      ? resolveNewSessionWorkingDirectory(newSessionArgs.pathArgs, options.commandBinding, currentSession)
      : currentSession
        ? resolveNewSessionWorkingDirectory('', options.commandBinding, currentSession)
        : { ok: true as const, workDir: getWorkspaceRoot() || DEFAULT_WORKSPACE_ROOT };
    if (!resolved.ok) return { response: resolved.message };
    const workDir = resolved.workDir;
    let documentChatName = newSessionName || `文档聊天-${cloudDocument.fileToken.slice(0, 8)}`;
    const validatedName = validateNewSessionName(documentChatName);
    if (!validatedName.ok) return { response: validatedName.message };
    documentChatName = validatedName.name;

    ensureWorkingDirectoryExists(workDir);
    let groupChat: Awaited<ReturnType<NonNullable<BaseChannelAdapter['createGroupChat']>>>;
    try {
      groupChat = await options.adapter.createGroupChat({
        name: documentChatName,
        createAs: 'user',
      });
    } catch (error) {
      return { response: `创建云文档群聊失败：${error instanceof Error ? error.message : String(error)}` };
    }

    const groupAddress = {
      ...options.msg.address,
      chatId: groupChat.chatId,
      chatKind: 'group' as const,
      displayName: groupChat.name || documentChatName,
      cloudDocument: undefined,
    };
    const binding = router.createBinding(groupAddress, workDir, groupChat.name || documentChatName);
    options.store.updateChannelChat(binding.id, {
      cloudDocumentChat: {
        provider: 'feishu',
        fileToken: cloudDocument.fileToken,
        fileType: cloudDocument.fileType,
        commentId: cloudDocument.commentId,
      },
    });
    let session = options.store.getSession(binding.bridgeSessionId);
    if (session) {
      const updates: Partial<BridgeSession> = {};
      const inheritedProvider = getSessionCodexProvider(currentSession);
      if (inheritedProvider === 'tmux' || inheritedProvider === 'pty') {
        Object.assign(updates, mergeSessionRuntimeUpdates(updates, setSessionCodexProviderUpdate(inheritedProvider)));
      }
      if (shouldEnableTmuxAutoEnterForNewSession(inheritedProvider, session)) {
        Object.assign(updates, mergeSessionRuntimeUpdates(updates, setSessionTmuxAutoEnterUpdate(true)));
      }
      if (Object.keys(updates).length > 0) {
        options.store.updateSession(session.id, updates);
        session = options.store.getSession(session.id);
      }
    }

    auditCommandBindingChange(
      options.store,
      'new_session',
      options.msg,
      options.commandBinding,
      binding,
      'cloud document chat',
    );
    await deliverBridgeNotice(
      options.adapter,
      groupAddress,
      [
        '这个群聊已绑定为云文档聊天入口。',
        `文档：${cloudDocument.fileType}/${cloudDocument.fileToken}`,
        '接下来请直接在这个群聊里聊天；云文档评论只会提示回到本群。',
      ].join('\n'),
      { sessionId: binding.bridgeSessionId },
    );
    return {
      response: buildCommandFields(
        '已开启云文档群聊模式',
        [
          ['群聊', groupChat.name || documentChatName],
          ['chat_id', groupChat.chatId],
          ['Session', binding.bridgeSessionId],
          ['目录', formatCommandPath(getSessionWorkingDirectory(session) || workDir)],
          ['文档', `${cloudDocument.fileType}/${cloudDocument.fileToken}`],
        ],
        ['请到已创建的群聊继续聊天；后续云文档评论不会再接入 bot 对话。'],
        options.markdown,
      ),
    };
  }

  const resolved = resolveNewSessionWorkingDirectory(newSessionArgs.pathArgs, options.commandBinding, currentSession);
  if (!resolved.ok) return { response: resolved.message };

  const workDir = resolved.workDir;
  newSessionName = deriveNewGroupName(newSessionName, currentSession, workDir);
  const validatedName = validateNewSessionName(newSessionName);
  if (!validatedName.ok) return { response: validatedName.message };
  newSessionName = validatedName.name;

  if (!options.adapter.createGroupChat) {
    return { response: '当前通道不支持通过 `/new` 自动创建群聊。' };
  }

  ensureWorkingDirectoryExists(workDir);
  let groupChat: Awaited<ReturnType<NonNullable<BaseChannelAdapter['createGroupChat']>>>;
  try {
    groupChat = await options.adapter.createGroupChat({
      name: newSessionName,
      ownerUserId: options.msg.address.userId,
      userIds: options.msg.address.userId ? [options.msg.address.userId] : [],
    });
  } catch (error) {
    return { response: `创建群聊失败：${error instanceof Error ? error.message : String(error)}` };
  }

  const groupAddress = {
    ...options.msg.address,
    chatId: groupChat.chatId,
    chatKind: 'group' as const,
    displayName: groupChat.name || newSessionName,
  };
  const binding = router.createBinding(groupAddress, workDir, groupChat.name || newSessionName);
  let session = options.store.getSession(binding.bridgeSessionId);
  if (session) {
    const updates: Partial<BridgeSession> = {};
    const inheritedProvider = getSessionCodexProvider(currentSession);
    if (inheritedProvider === 'tmux' || inheritedProvider === 'pty') {
      Object.assign(updates, mergeSessionRuntimeUpdates(updates, setSessionCodexProviderUpdate(inheritedProvider)));
    }
    if (shouldEnableTmuxAutoEnterForNewSession(inheritedProvider, session)) {
      Object.assign(updates, mergeSessionRuntimeUpdates(updates, setSessionTmuxAutoEnterUpdate(true)));
    }
    if (Object.keys(updates).length > 0) {
      options.store.updateSession(session.id, updates);
      session = options.store.getSession(session.id);
    }
  }
  auditCommandBindingChange(
    options.store,
    'new_session',
    options.msg,
    options.commandBinding,
    binding,
    parsedArgs.force ? 'forced' : undefined,
  );
  const notes = [
    parsedArgs.args.trim() ? '接下来直接发送文本即可继续。' : '已在当前工作目录下新建一个线程。接下来直接发送文本即可继续。',
    NEW_SESSION_ARG_RULE_NOTE,
    ...(parsedArgs.force
      ? ['如果当前聊天里已有旧任务在运行，它不会被终止，仍会在后台继续执行并可能稍后回消息。']
      : []),
    '这是 IM 侧线程，当前只保证在 IM 中可继续；不会自动出现在 Codex Native 会话列表中。',
  ];
  return {
    responseAddress: groupAddress,
    response: buildCommandFields(
      '已创建群聊会话',
      [
        ['群聊', groupChat.name || newSessionName],
        ['chat_id', groupChat.chatId],
        ['标题', session ? getSessionDisplayName(session, getSessionWorkingDirectory(session)) : options.threadDisplay.binding(binding).title],
        ['目录', formatCommandPath(getSessionWorkingDirectory(session) || workDir)],
        ['模式', formatSessionMode(binding, session)],
        ['Provider', formatSessionCodexProvider(session)],
      ],
      notes,
      options.markdown,
    ),
  };
}
