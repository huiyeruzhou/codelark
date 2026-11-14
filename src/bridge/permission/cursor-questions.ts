import { createHash } from 'node:crypto';
import type { BaseChannelAdapter } from '../../channels/contracts.js';
import type { BridgeStore, BridgeSession, ChannelChat, InboundMessage, ChannelAddress, OutboundRichCard } from '../../domain/index.js';
import { deliver, enqueueDelivery } from '../../channels/delivery/deliver.js';
import { getSessionActiveRuntime, getSessionCursorSessionId, getSessionWorkingDirectory, getSessionRuntimeTmuxSessionName } from '../../domain/session-runtime.js';
import { findCursorSessionFileById } from '../../runtime/cursor/session-index.js';
import { readCursorPendingQuestion } from '../../runtime/cursor/cli-store.js';
import { answerCursorQuestion, inspectCursorQuestion, type CursorQuestionTarget, type CursorQuestionView, type CursorQuestionAnswer } from '../../runtime/cursor/questions.js';

const PREFIX = 'cursor-question:';
interface Pending { id: string; sessionId: string; bindingId: string; address: ChannelAddress; target: CursorQuestionTarget; view: CursorQuestionView; messageId?: string; busy: boolean }
const pending = new Map<string, Pending>();
const scanning = new Set<string>();

export function hasCursorQuestion(sessionId: string): boolean { return [...pending.values()].some((p) => p.sessionId === sessionId); }
export function clearCursorQuestions(): void { pending.clear(); }

export function buildCursorQuestionCard(view: CursorQuestionView, id: string): OutboundRichCard {
  const q = view.request.questions[view.index]!;
  const wait = `${view.request.title}（第 ${view.index + 1}/${view.request.questions.length} 题）`;
  const buttons = q.options.map((_option, i) => ({ text: `选 ${i + 1}`, callbackData: `${id}:${i}` }));
  return {
    title: 'Cursor 等待你的回答', template: 'orange',
    sections: [{ markdown: [
      `**${wait}**`, q.prompt, q.options.map((o, i) => `${i + 1}. ${o.label}`).join('\n'),
      q.allowMultiple ? '多选请直接回复选项编号，以逗号分隔；也可以回复其他文字。' : '点击下方编号选择，或直接在当前聊天回复文字。',
    ].join('\n\n') }],
    // Section actions sit beside the entire text. Question choices belong below
    // it, with short labels so native descriptions never squeeze the question.
    actions: q.allowMultiple ? [] : Array.from({ length: Math.ceil(buttons.length / 4) }, (_, i) => buttons.slice(i * 4, i * 4 + 4)),
  };
}

export async function reconcileCursorQuestion(
  session: BridgeSession, binding: ChannelChat, adapter: BaseChannelAdapter, store: BridgeStore,
): Promise<void> {
  if (getSessionActiveRuntime(session) !== 'cursor' || scanning.has(binding.id)) return;
  scanning.add(binding.id);
  try {
    const nativeId = getSessionCursorSessionId(session);
    const summary = nativeId ? findCursorSessionFileById(nativeId, getSessionWorkingDirectory(session)) : null;
    const pane = getSessionRuntimeTmuxSessionName(session);
    const target = summary?.storePath && pane ? { storePath: summary.storePath, nativeSessionId: nativeId!, targetPane: `${pane}:0.0` } : null;
    let paneAvailable = true;
    const view = target ? await inspectCursorQuestion(target).catch(() => { paneAvailable = false; return null; }) : null;
    const id = view ? PREFIX + createHash('sha256').update(JSON.stringify([session.id, binding.id, view.request.toolCallId, view.index])).digest('hex').slice(0, 24) : null;
    for (const [key, entry] of pending) {
      if (entry.sessionId === session.id && entry.address.chatId === binding.chatId && key !== id) { pending.delete(key); store.markPermissionLinkResolved(key); }
    }
    if (!view || !target || !id) {
      const native = paneAvailable && target && readCursorPendingQuestion(target.storePath);
      const waiting = native ? `${native.title}（请用 /tmux-screen 查看当前问卷）` : undefined;
      if (session.pending_user_input !== waiting) store.updateSession(session.id, { pending_user_input: waiting });
      return;
    }
    const wait = `${view.request.title}（第 ${view.index + 1}/${view.request.questions.length} 题）`;
    if (session.pending_user_input !== wait) store.updateSession(session.id, { pending_user_input: wait });
    if (pending.has(id)) return;
    const address = { channelType: binding.channelType, chatId: binding.chatId };
    const entry: Pending = { id, sessionId: session.id, bindingId: binding.id, address, target, view, busy: false };
    pending.set(id, entry);
    const link = store.getPermissionLink(id);
    if (link && !link.resolved && link.sessionId === session.id && link.chatId === binding.chatId) {
      entry.messageId = link.messageId;
      return;
    }
    const q = view.request.questions[view.index]!;
    const result = await enqueueDelivery(adapter, address, () => deliver(adapter, {
      address,
      text: `${wait}\n${q.prompt}`,
      richCard: buildCursorQuestionCard(view, id),
    }, { sessionId: session.id }), { queueClass: 'interactive' }).completion.catch((error) => { pending.delete(id); throw error; });
    if (result.ok && result.messageId) {
      entry.messageId = result.messageId;
      store.insertPermissionLink({ permissionRequestId: id, channelType: address.channelType, chatId: address.chatId,
        messageId: result.messageId, sessionId: session.id, toolName: 'Cursor AskQuestion', suggestions: '' });
      if (pending.get(id) !== entry) store.markPermissionLinkResolved(id);
    } else pending.delete(id); // Failed delivery is retried by the existing reconciliation loop.
  } finally { scanning.delete(binding.id); }
}

async function submit(entry: Pending, answer: CursorQuestionAnswer, store: BridgeStore): Promise<string> {
  if (entry.busy) return '正在向 Cursor 提交此题，请勿重复操作。';
  const binding = store.getChannelChat(entry.address.channelType, entry.address.chatId);
  const session = store.getSession(entry.sessionId);
  if (binding?.id !== entry.bindingId || binding.bridgeSessionId !== entry.sessionId || !session || getSessionActiveRuntime(session) !== 'cursor'
    || getSessionCursorSessionId(session) !== entry.target.nativeSessionId
    || `${getSessionRuntimeTmuxSessionName(session)}:0.0` !== entry.target.targetPane) return '会话已改变，未提交旧答复。';
  entry.busy = true;
  try {
    await answerCursorQuestion(entry.target, entry.view.request.toolCallId, entry.view.index, answer);
    pending.delete(entry.id);
    store.markPermissionLinkResolved(entry.id);
    if (entry.view.index === entry.view.request.questions.length - 1) store.updateSession(entry.sessionId, { pending_user_input: undefined });
    return entry.view.index < entry.view.request.questions.length - 1 ? 'Cursor 已接收此题，正在显示下一题。' : 'Cursor 已接收完整回答，继续执行原任务。';
  } catch (error) { return error instanceof Error ? error.message : String(error); }
  finally { entry.busy = false; }
}

export async function handleCursorQuestionCallback(msg: InboundMessage, store: BridgeStore): Promise<string | undefined> {
  if (!msg.callbackData?.startsWith(PREFIX)) return undefined;
  const split = msg.callbackData.lastIndexOf(':');
  const entry = pending.get(msg.callbackData.slice(0, split));
  if (!entry || entry.address.chatId !== msg.address.chatId || entry.address.channelType !== msg.address.channelType
    || (entry.messageId && (msg.callbackMessageId || msg.messageId) !== entry.messageId)) return '这个 Cursor 问题已失效，请使用当前问题卡片。';
  const index = Number(msg.callbackData.slice(split + 1));
  const option = entry.view.request.questions[entry.view.index]?.options[index];
  if (!Number.isInteger(index) || !option) return '无效选项。';
  return submit(entry, { optionIds: [option.id] }, store);
}

export async function answerCursorQuestionText(msg: InboundMessage, sessionId: string, store: BridgeStore): Promise<string | undefined> {
  const entries = [...pending.values()].filter((p) => p.sessionId === sessionId && p.address.chatId === msg.address.chatId && p.address.channelType === msg.address.channelType);
  if (!entries.length || !msg.text.trim()) return undefined;
  if (entries.length !== 1) return '当前有多个问题，请使用对应卡片。';
  const entry = entries[0]!;
  const q = entry.view.request.questions[entry.view.index]!;
  const text = msg.text.trim();
  const values = q.allowMultiple ? text.split(/[,，]/u).map((s) => s.trim()) : [text];
  const options = values.map((value) => q.options.find((o, i) => value === o.label || value === o.id || value === String(i + 1)));
  return submit(entry, options.every(Boolean) ? { optionIds: options.map((o) => o!.id) } : { text }, store);
}
