import type { BaseChannelAdapter } from '../../../channels/contracts.js';
import { deliverBridgeNotice } from '../../../channels/delivery/feedback.js';
import { DEFAULT_WORKSPACE_ROOT } from '../../../configuration/paths.js';
import { createConfigService } from '../../../configuration/service.js';
import type { BridgeSession, BridgeStore, ChannelChat, CloudDocumentAddress, InboundMessage } from '../../../domain/index.js';
import {
  getSessionWorkingDirectory,
} from '../../../domain/session-runtime.js';
import { validateWorkingDirectory } from '../../../shared/security/validators.js';
import * as router from '../channel-router.js';
import {
  ensureWorkingDirectoryExists,
  getSessionCodexProviderOverride,
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
  parseForceFlag,
  parseNewSessionArgs,
  validateNewSessionName,
} from './args.js';
import { guardBindingChangeWhileRunning } from './status-guards.js';
import { auditCommandBindingChange } from './thread-targets.js';
import type { SessionCommandDeps, SessionCommandResult } from './types.js';

type InheritedCodexProvider = ReturnType<typeof getSessionCodexProviderOverride>;

const CLOUD_DOCUMENT_GROUP_TITLE_CHARS = 8;

function resolveDefaultWorkspaceRootForCloudDocument(): { ok: true; workDir: string } | { ok: false; message: string } {
  const root = getWorkspaceRoot() || DEFAULT_WORKSPACE_ROOT;
  const validated = validateWorkingDirectory(root);
  if (validated) return { ok: true, workDir: validated };
  return { ok: false, message: '全局默认工作目录无效，请先用 `/set defaultWorkspaceRoot <目录>` 设置有效目录。' };
}

function compactCloudDocumentTitle(title: string | undefined): string {
  const compacted = (title || '')
    .replace(/\s+/g, '')
    .replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '');
  return Array.from(compacted).slice(0, CLOUD_DOCUMENT_GROUP_TITLE_CHARS).join('');
}

function deriveCloudDocumentGroupName(cloudDocument: CloudDocumentAddress): string {
  const titleSegment = compactCloudDocumentTitle(cloudDocument.title);
  return `doc:${titleSegment || cloudDocument.fileToken.slice(0, 8)}`;
}

function setSessionCodexProviderToml(sessionId: string, provider: Exclude<InheritedCodexProvider, undefined>): void {
  createConfigService({ migrate: false }).set(
    { kind: 'session', sessionId },
    { runtime: { codex: { provider } } },
  );
}

function setSessionTmuxAutoEnterToml(sessionId: string, tmuxAutoEnter: boolean): void {
  createConfigService({ migrate: false }).set(
    { kind: 'session', sessionId },
    { session: { tmuxAutoEnter } },
  );
}

function shouldEnableTmuxAutoEnterForNewSession(
  inheritedProvider: InheritedCodexProvider,
  session: BridgeSession,
  binding?: ChannelChat | null,
): boolean {
  if (inheritedProvider === 'tmux') return true;
  if (inheritedProvider === 'pty') return false;
  return resolveEffectiveCodexProvider(session, binding) === 'tmux';
}

const NEW_SESSION_KEY_COMMAND_NOTES = [
  '`/`：查看/修改当前工作区配置。',
  '`/set`：查看/修改全局配置。',
  '`/new`：新建对话。',
  '`/p tmux`：重启当前对话，不会丢失上下文，可用于尝试修复卡顿。',
  '`/tmux-screen`：查看当前 tmux 的屏幕界面，卡住时可以用来 debug。',
];

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
      ));
    if (existing) {
      return {
        response: buildCommandFields(
          '云文档群聊模式已开启',
          [
            ['群聊 chat_id', existing.chatId],
            ['Session', existing.bridgeSessionId],
          ],
          ['请到已创建的群聊继续聊天；后续云文档评论会转发到这个群聊。'],
          options.markdown,
        ),
      };
    }

    const resolved = resolveDefaultWorkspaceRootForCloudDocument();
    if (!resolved.ok) return { response: resolved.message };
    const workDir = resolved.workDir;
    let documentChatName = deriveCloudDocumentGroupName(cloudDocument);
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
      },
    });
    let session = options.store.getSession(binding.bridgeSessionId);
    if (session) {
      const inheritedProvider = getSessionCodexProviderOverride(currentSession);
      if (inheritedProvider === 'tmux' || inheritedProvider === 'pty') {
        setSessionCodexProviderToml(session.id, inheritedProvider);
      }
      if (shouldEnableTmuxAutoEnterForNewSession(inheritedProvider, session, binding)) {
        setSessionTmuxAutoEnterToml(session.id, true);
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
        cloudDocument.title ? `标题：${cloudDocument.title}` : '',
        `文档：${cloudDocument.fileType}/${cloudDocument.fileToken}`,
        '接下来请直接在这个群聊里聊天；后续云文档评论会转发到本群。',
      ].filter(Boolean).join('\n'),
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
          ...(cloudDocument.title ? [['标题', cloudDocument.title] as [string, string]] : []),
          ['文档', `${cloudDocument.fileType}/${cloudDocument.fileToken}`],
        ],
        ['请到已创建的群聊继续聊天；后续云文档评论会转发到这个群聊。'],
        options.markdown,
      ),
      afterDelivery: () => options.adapter.notifyGroupChatCreated?.(groupAddress, groupChat),
      postDeliveryCurrentAddress: groupAddress,
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
    const inheritedProvider = getSessionCodexProviderOverride(currentSession);
    if (inheritedProvider === 'tmux' || inheritedProvider === 'pty') {
      setSessionCodexProviderToml(session.id, inheritedProvider);
    }
    if (shouldEnableTmuxAutoEnterForNewSession(inheritedProvider, session, binding)) {
      setSessionTmuxAutoEnterToml(session.id, true);
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
    '接下来直接发送文本即可继续。',
    ...NEW_SESSION_KEY_COMMAND_NOTES,
    ...(parsedArgs.force
      ? ['如果当前聊天里已有旧任务在运行，它不会被终止，仍会在后台继续执行并可能稍后回消息。']
      : []),
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
        ['Provider', formatSessionCodexProvider(session, binding)],
      ],
      notes,
      options.markdown,
    ),
    afterDelivery: () => options.adapter.notifyGroupChatCreated?.(groupAddress, groupChat),
    postDeliveryCurrentAddress: groupAddress,
  };
}
