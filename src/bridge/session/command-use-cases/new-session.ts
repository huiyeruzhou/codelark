import type { BaseChannelAdapter } from '../../../channels/contracts.js';
import { enqueueBridgeNotice } from '../../../channels/delivery/feedback.js';
import { DEFAULT_WORKSPACE_ROOT } from '../../../configuration/paths.js';
import { createConfigService } from '../../../configuration/service.js';
import type { BridgeSession, BridgeStore, ChannelChat, CloudDocumentAddress, InboundMessage } from '../../../domain/index.js';
import {
  getSessionActiveRuntime,
  getSessionWorkingDirectory,
  setSessionActiveRuntimeUpdate,
} from '../../../domain/session-runtime.js';
import { validateWorkingDirectory } from '../../../shared/security/validators.js';
import * as router from '../channel-router.js';
import {
  ensureWorkingDirectoryExists,
  getSessionClaudeProviderOverride,
  getSessionCodexProviderOverride,
  getWorkspaceRoot,
  resolveNewSessionWorkingDirectory,
} from '../support.js';
import { getSessionDisplayName } from '../display/session-title.js';
import {
  buildCommandFields,
  formatCommandPath,
} from '../../command/presentation.js';
import {
  formatSessionRuntimeMode,
  formatSessionRuntimeProvider,
} from '../../command/runtime-session.js';
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
type InheritedClaudeProvider = ReturnType<typeof getSessionClaudeProviderOverride>;
type InheritedRuntime = 'codex' | 'claude' | 'kimi' | 'cursor';

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

function buildCloudDocumentBootstrapPrompt(cloudDocument: CloudDocumentAddress): string {
  const docHost = cloudDocument.provider === 'feishu' ? 'https://feishu.cn' : '';
  const docUrl = docHost ? `${docHost}/${cloudDocument.fileType}/${cloudDocument.fileToken}` : '';
  return [
    '这是一条云文档群聊初始化消息，只需要在当前会话中记住这些上下文。',
    '',
    '当前群聊已绑定为飞书云文档聊天入口。',
    '文档信息：',
    cloudDocument.title ? `- 标题：${cloudDocument.title}` : '',
    docUrl ? `- 链接：${docUrl}` : '',
    `- file_type：${cloudDocument.fileType}`,
    `- file_token：${cloudDocument.fileToken}`,
    '',
    '后续从云文档评论转发来的用户消息，会作为当前群聊里的正常用户输入处理。',
    '如果用户要求你进行改进、重写、润色、扩写、压缩、调整结构或修改文章内容，请直接改写到当前云文档里；不要只在聊天里给出一份需要用户手动复制的版本，除非你确实没有云文档写入能力或用户明确要求只给文本建议。',
    '如果缺少完整正文上下文，请先说明需要系统侧补充文档读取/写入能力，或基于已提供的评论选区继续处理。',
    '',
    '这条初始化消息不需要展开回答；如果必须回复，请只回复“已记录云文档上下文”。',
  ].filter(Boolean).join('\n');
}

function setSessionCodexProviderToml(sessionId: string, provider: Exclude<InheritedCodexProvider, undefined>): void {
  createConfigService({ migrate: false }).set(
    { kind: 'session', sessionId },
    { runtime: { codex: { provider } } },
  );
}

function setSessionClaudeProviderToml(sessionId: string, provider: Exclude<InheritedClaudeProvider, undefined>): void {
  createConfigService({ migrate: false }).set(
    { kind: 'session', sessionId },
    { runtime: { claude: { provider } } },
  );
}

function setSessionKimiProviderToml(sessionId: string): void {
  createConfigService({ migrate: false }).set(
    { kind: 'session', sessionId },
    { runtime: { kimi: { provider: 'tmux' } } },
  );
}

function setSessionCursorProviderToml(sessionId: string): void {
  createConfigService({ migrate: false }).set(
    { kind: 'session', sessionId },
    { runtime: { cursor: { provider: 'tmux' } } },
  );
}
function activeRuntimeForNewSession(previousSession: BridgeSession | null): InheritedRuntime {
  const activeRuntime = getSessionActiveRuntime(previousSession);
  return activeRuntime === 'claude' || activeRuntime === 'kimi' || activeRuntime === 'cursor' ? activeRuntime : 'codex';
}

function formatInheritedRuntimeLabel(runtime: InheritedRuntime): string {
  if (runtime === 'claude') return 'Claude Code';
  if (runtime === 'kimi') return 'Kimi Code';
  if (runtime === 'cursor') return 'Cursor Agent';
  return 'Codex';
}

function preserveNewSessionRuntimeBinding(options: {
  store: BridgeStore;
  previousSession: BridgeSession | null;
  newBinding: ChannelChat;
}): ChannelChat {
  const activeRuntime = activeRuntimeForNewSession(options.previousSession);
  const newSession = options.store.getSession(options.newBinding.bridgeSessionId);
  if (newSession && getSessionActiveRuntime(newSession) !== activeRuntime) {
    options.store.updateSession(newSession.id, setSessionActiveRuntimeUpdate(activeRuntime), { touch: false });
  }
  options.store.updateChannelChat(options.newBinding.id, {
    runtimeBridgeSessionIds: {
      [activeRuntime]: options.newBinding.bridgeSessionId,
    },
  });
  return options.store.getChannelChat(options.newBinding.channelType, options.newBinding.chatId) || options.newBinding;
}

function inheritNewSessionRuntimeProvider(
  sessionId: string,
  previousSession: BridgeSession | null,
): void {
  const activeRuntime = activeRuntimeForNewSession(previousSession);
  if (activeRuntime === 'claude') {
    const inheritedProvider = getSessionClaudeProviderOverride(previousSession);
    if (inheritedProvider) setSessionClaudeProviderToml(sessionId, inheritedProvider);
    return;
  }
  if (activeRuntime === 'kimi') {
    setSessionKimiProviderToml(sessionId);
    return;
  }
  if (activeRuntime === 'cursor') {
    setSessionCursorProviderToml(sessionId);
    return;
  }
  const inheritedProvider = getSessionCodexProviderOverride(previousSession);
  if (inheritedProvider === 'tmux' || inheritedProvider === 'pty') {
    setSessionCodexProviderToml(sessionId, inheritedProvider);
  }
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
    const operatorUserId = cloudDocument.operatorId || options.msg.address.userId;
    if (!operatorUserId) {
      return { response: '无法确定当前操作者，已停止创建云文档群聊，避免创建无法由用户管理的群。' };
    }
    try {
      groupChat = await options.adapter.createGroupChat({
        name: documentChatName,
        ownerUserId: operatorUserId,
        userIds: [operatorUserId],
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
    let binding = router.createBinding(groupAddress, workDir, groupChat.name || documentChatName);
    binding = preserveNewSessionRuntimeBinding({
      store: options.store,
      previousSession: currentSession,
      newBinding: binding,
    });
    options.store.updateChannelChat(binding.id, {
      cloudDocumentChat: {
        provider: 'feishu',
        fileToken: cloudDocument.fileToken,
        fileType: cloudDocument.fileType,
        ...(cloudDocument.commentId ? { commentId: cloudDocument.commentId } : {}),
      },
    });
    let session = options.store.getSession(binding.bridgeSessionId);
    if (session) {
      inheritNewSessionRuntimeProvider(session.id, currentSession);
      session = options.store.getSession(binding.bridgeSessionId);
    }

    auditCommandBindingChange(
      options.store,
      'new_session',
      options.msg,
      options.commandBinding,
      binding,
      'cloud document chat',
    );
    enqueueBridgeNotice(
      options.adapter,
      groupAddress,
      [
        '这个群聊已绑定为云文档聊天入口。',
        cloudDocument.title ? `标题：${cloudDocument.title}` : '',
        `文档：${cloudDocument.fileType}/${cloudDocument.fileToken}`,
        '云文档上下文会在聊天开始时发送给模型一次。',
        cloudDocument.initialPrompt ? '首条云文档评论会随后作为用户输入发送给模型。' : '',
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
          ['Runtime', formatInheritedRuntimeLabel(activeRuntimeForNewSession(currentSession))],
          ...(cloudDocument.title ? [['标题', cloudDocument.title] as [string, string]] : []),
          ['文档', `${cloudDocument.fileType}/${cloudDocument.fileToken}`],
        ],
        ['请到已创建的群聊继续聊天；后续云文档评论会转发到这个群聊。'],
        options.markdown,
      ),
      afterDelivery: () => options.adapter.notifyGroupChatCreated?.(groupAddress, groupChat),
      postDeliveryCurrentAddress: groupAddress,
      postDeliveryUserMessages: [
        {
          address: groupAddress,
          text: buildCloudDocumentBootstrapPrompt(cloudDocument),
          messageId: `doc-bootstrap:${cloudDocument.fileToken}`,
        },
        ...(cloudDocument.initialPrompt
          ? [{
              address: groupAddress,
              text: cloudDocument.initialPrompt,
              messageId: `doc-initial:${cloudDocument.fileToken}:${cloudDocument.commentId}:${cloudDocument.replyId || Date.now()}`,
            }]
          : []),
      ],
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
  if (!options.msg.address.userId) {
    return { response: '无法确定当前操作者，已停止创建群聊，避免创建无法由用户管理的群。' };
  }
  try {
    groupChat = await options.adapter.createGroupChat({
      name: newSessionName,
      ownerUserId: options.msg.address.userId,
      userIds: [options.msg.address.userId],
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
  let binding = router.createBinding(groupAddress, workDir, groupChat.name || newSessionName);
  binding = preserveNewSessionRuntimeBinding({
    store: options.store,
    previousSession: currentSession,
    newBinding: binding,
  });
  let session = options.store.getSession(binding.bridgeSessionId);
  if (session) {
    inheritNewSessionRuntimeProvider(session.id, currentSession);
    session = options.store.getSession(binding.bridgeSessionId);
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
  const inheritedRuntime = activeRuntimeForNewSession(currentSession);
  return {
    responseAddress: groupAddress,
    response: buildCommandFields(
      '已创建群聊会话',
      [
        ['群聊', groupChat.name || newSessionName],
        ['chat_id', groupChat.chatId],
        ['标题', session ? getSessionDisplayName(session, getSessionWorkingDirectory(session)) : options.threadDisplay.binding(binding).title],
        ['目录', formatCommandPath(getSessionWorkingDirectory(session) || workDir)],
        ['Runtime', formatInheritedRuntimeLabel(inheritedRuntime)],
        ['模式', formatSessionRuntimeMode(binding, session)],
        ['Provider', formatSessionRuntimeProvider(session, binding)],
      ],
      notes,
      options.markdown,
    ),
    afterDelivery: () => options.adapter.notifyGroupChatCreated?.(groupAddress, groupChat),
    postDeliveryCurrentAddress: groupAddress,
  };
}
