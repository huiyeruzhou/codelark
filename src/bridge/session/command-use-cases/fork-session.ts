import type { BaseChannelAdapter } from '../../../channels/contracts.js';
import { deliverBridgeNotice } from '../../../channels/delivery/feedback.js';
import type { BridgeStore, ChannelChat, InboundMessage } from '../../../domain/index.js';
import { getSessionCodexThreadId, getSessionWorkingDirectory } from '../../../domain/session-runtime.js';
import { readCardForkCheckpoint, readLatestCompletedCardForkCheckpoint, saveCardForkCheckpoint } from '../../../storage/card-fork-checkpoints.js';
import { forkCodexThreadAtCheckpoint, remapCodexForkSignatures } from '../../../runtime/codex/fork-thread.js';
import { codexLocalAppServerEndpoint } from '../../../runtime/codex/app-server-local.js';
import * as router from '../channel-router.js';
import { inheritSessionConfiguration } from './inherit-session-configuration.js';
import { validateNewSessionName } from './args.js';
import type { SessionCommandResult } from './types.js';
import { resolveEffectiveRuntimeProvider } from '../support.js';

export async function handleForkSessionCommand(options: {
  adapter: BaseChannelAdapter;
  msg: InboundMessage;
  args: string;
  commandBinding: ChannelChat | null;
  store: BridgeStore;
  forkThread?: typeof forkCodexThreadAtCheckpoint;
  remapSignatures?: typeof remapCodexForkSignatures;
}): Promise<SessionCommandResult> {
  const { adapter, msg, store } = options;
  if (adapter.provider !== 'feishu' || !adapter.createGroupChat || !adapter.listChatMessageIdsThrough
    || !adapter.forwardChatMessage || msg.address.cloudDocument) {
    return { response: '`/fork` 目前支持飞书聊天中的 Codex 对话卡片。' };
  }
  if (!msg.address.userId) return { response: '无法确定操作者，未创建分支群。' };
  const currentSession = options.commandBinding && store.getSession(options.commandBinding.bridgeSessionId);
  const checkpoint = msg.replyToMessageId
    ? readCardForkCheckpoint(msg.address.channelType, msg.address.chatId, msg.replyToMessageId)
    : currentSession ? readLatestCompletedCardForkCheckpoint(msg.address.channelType, msg.address.chatId,
      currentSession.id, getSessionCodexThreadId(currentSession) || '') : null;
  if (!checkpoint) {
    return { response: msg.replyToMessageId
      ? '该消息没有可用的历史边界。请回复本版本生成且已结束或已续接的对话卡片；运行中的卡片、旧卡片和超长记录的中间分页暂不支持分叉。'
      : '当前会话尚无可用的已完成卡片。请等待一轮回复完成；升级前的卡片请使用“回复”后发送 `/fork [新群名]`。' };
  }
  const sourceSession = store.getSession(checkpoint.sessionId);
  if (!sourceSession) return { response: '该卡片的原会话已不存在，未创建空白分支。' };
  const sourceBinding = options.commandBinding?.bridgeSessionId === sourceSession.id ? options.commandBinding : null;
  if (resolveEffectiveRuntimeProvider(sourceSession, sourceBinding).runtime !== 'codex') {
    return { response: '目前仅支持 Codex 原生历史分叉；此卡片的会话不是 Codex。' };
  }
  const endpoint = sourceSession.runtime?.codex?.appServerEndpoint;
  if (endpoint && endpoint !== codexLocalAppServerEndpoint()) {
    return { response: '此会话使用外部 Codex app-server，暂不支持本地历史分叉。' };
  }
  const workDir = getSessionWorkingDirectory(sourceSession);
  if (!workDir) return { response: '原会话缺少工作目录，未创建分支。' };
  const validated = validateNewSessionName(options.args.trim() || `${sourceSession.name || 'Codex'} fork`);
  if (!validated.ok) return { response: validated.message };
  let historyMessageIds: string[];
  try {
    historyMessageIds = await adapter.listChatMessageIdsThrough(msg.address.chatId, checkpoint.messageId, 10);
  } catch (error) {
    return { response: `读取待转发历史失败，未创建分支：${error instanceof Error ? error.message : String(error)}` };
  }
  let fork: { threadId: string };
  try {
    fork = await (options.forkThread || forkCodexThreadAtCheckpoint)({
      threadId: checkpoint.threadId, signature: checkpoint.signature, workingDirectory: workDir,
    });
  } catch (error) {
    return { response: `分叉历史失败：${error instanceof Error ? error.message : String(error)}` };
  }
  let group: Awaited<ReturnType<NonNullable<BaseChannelAdapter['createGroupChat']>>>;
  try {
    group = await adapter.createGroupChat({ name: validated.name, ownerUserId: msg.address.userId, userIds: [msg.address.userId] });
  } catch (error) {
    return { response: `已创建 Codex 分支 ${fork.threadId}，但建群失败：${error instanceof Error ? error.message : String(error)}。原会话未改变。` };
  }
  const address = { ...msg.address, chatId: group.chatId, chatKind: 'group' as const,
    displayName: group.name || validated.name, feishuTopic: undefined, cloudDocument: undefined };
  let binding: ChannelChat;
  try {
    binding = router.createBinding(address, workDir, group.name || validated.name);
    binding = inheritSessionConfiguration({ store, sourceSession,
      sourceBinding,
      newBinding: binding, workDir });
    store.updateSessionCodexThreadId(binding.bridgeSessionId, fork.threadId);
    // Native mirroring starts after inheritance; the original Feishu messages are forwarded below.
    store.updateSession(binding.bridgeSessionId, { mirror_last_event_at: new Date().toISOString() });
  } catch (error) {
    return { response: `分支群 ${group.chatId} 与 Codex thread ${fork.threadId} 已创建，但绑定失败：${error instanceof Error ? error.message : String(error)}。请修复绑定后继续，原会话未改变。` };
  }
  const link = `https://applink.feishu.cn/client/chat/open?openChatId=${encodeURIComponent(group.chatId)}`;
  let forwarded = 0;
  try {
    const checkpoints = new Map(historyMessageIds.map(id => [id,
      readCardForkCheckpoint(msg.address.channelType, msg.address.chatId, id)]));
    const inherited = [...checkpoints.values()].filter(c => c?.threadId === checkpoint.threadId && c.sessionId === checkpoint.sessionId);
    const signatures = (options.remapSignatures || remapCodexForkSignatures)(checkpoint.threadId, fork.threadId,
      inherited.map(c => c!.signature));
    for (const sourceMessageId of historyMessageIds) {
      const messageId = await adapter.forwardChatMessage(sourceMessageId, group.chatId);
      forwarded++;
      const original = checkpoints.get(sourceMessageId);
      if (original?.threadId === checkpoint.threadId && original.sessionId === checkpoint.sessionId) {
        saveCardForkCheckpoint({ ...original, chatId: group.chatId, messageId,
          sessionId: binding.bridgeSessionId, threadId: fork.threadId, signature: signatures.get(original.signature)! });
      }
    }
  } catch (error) {
    return { response: `分支已创建：[打开分支群](${link})。Agent 历史已继承，但飞书历史转发未完成（${forwarded}/${historyMessageIds.length} 条）：${error instanceof Error ? error.message : String(error)}。原会话未改变，请勿重复 /fork 创建新群。` };
  }
  return {
    response: `已创建分支「${group.name || validated.name}」：[打开分支群](${link})。\n\nAgent 已继承到所选卡片为止的完整对话历史。新群仅转发该卡片及之前最近 10 条消息，本次共 ${forwarded} 条。工作目录和会话配置沿用原会话，原会话继续保留。`,
    afterDelivery: async () => {
      const notice = await deliverBridgeNotice(adapter, address,
        `已从「${sourceSession.name || 'Codex'}」创建分支，可在本群继续对话。\n\n分支仅复制对话历史，不回退或复制工作目录中的文件。`,
        { sessionId: binding.bridgeSessionId });
      if (!notice.ok) throw new Error(notice.error || '分支群通知发送失败');
      await adapter.notifyGroupChatCreated?.(address, group);
    },
  };
}
