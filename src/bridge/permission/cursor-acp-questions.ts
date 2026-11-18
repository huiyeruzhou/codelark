import { createHash } from 'node:crypto';
import type { BaseChannelAdapter } from '../../channels/contracts.js';
import type { BridgeStore, ChannelAddress, InboundMessage, PermissionGateway } from '../../domain/index.js';
import { getSessionCursorSessionId } from '../../domain/session-runtime.js';
import type { CursorPendingQuestion } from '../../runtime/cursor/cli-store.js';
import { deliver, enqueueDelivery } from '../../channels/delivery/deliver.js';
import { buildCursorQuestionCard } from './cursor-questions.js';
import { resolveEffectiveRuntimeProvider } from '../session/support.js';

const PREFIX = 'cursor-acp-question:';
interface Pending {
  id: string; permissionId: string; sessionId: string; nativeSessionId?: string; bindingId: string; address: ChannelAddress;
  request: CursorPendingQuestion; index: number; answers: Array<{ questionId: string; selectedOptionIds: string[]; freeformText?: string }>;
  adapter: BaseChannelAdapter; store: BridgeStore; permissions: PermissionGateway; replyToMessageId?: string;
  messageId?: string; busy: boolean;
}
const pending = new Map<string, Pending>();
const waitingText = (entry: Pending) => `${entry.request.title}（第 ${entry.index + 1}/${entry.request.questions.length} 题）`;

function remove(entry: Pending, denyMessage?: string): void {
  if (pending.get(entry.id) !== entry) return;
  pending.delete(entry.id);
  if (denyMessage) entry.permissions.resolvePendingPermission(entry.permissionId, { behavior: 'deny', message: denyMessage });
  entry.store.markPermissionLinkResolved(entry.permissionId);
  const remaining = [...pending.values()].find(other => other.store === entry.store && other.sessionId === entry.sessionId);
  entry.store.updateSession(entry.sessionId, { pending_user_input: remaining ? waitingText(remaining) : undefined });
}

function isCurrent(entry: Pending): boolean {
  if (pending.get(entry.id) !== entry) return false;
  if (entry.permissions.hasPendingPermission?.(entry.permissionId) === false) {
    remove(entry);
    return false;
  }
  const binding = entry.store.getChannelChat(entry.address.channelType, entry.address.chatId);
  const session = entry.store.getSession(entry.sessionId);
  if (binding?.id !== entry.bindingId || binding.bridgeSessionId !== entry.sessionId || !session
    || resolveEffectiveRuntimeProvider(session, binding).identity !== 'cursor:acp'
    || (entry.nativeSessionId && getSessionCursorSessionId(session) !== entry.nativeSessionId)) {
    remove(entry, '会话已改变，未提交旧答复。');
    return false;
  }
  return true;
}

export function hasCursorAcpQuestion(sessionId: string): boolean {
  return [...pending.values()].filter(entry => entry.sessionId === sessionId && isCurrent(entry)).length > 0;
}

export function clearCursorAcpQuestions(store?: BridgeStore, sessionId?: string): void {
  for (const entry of [...pending.values()]) {
    if ((store && entry.store !== store) || (sessionId && entry.sessionId !== sessionId)) continue;
    remove(entry, '当前问卷已经结束。');
  }
}

async function show(entry: Pending): Promise<void> {
  if (!isCurrent(entry)) return;
  const wait = waitingText(entry);
  entry.messageId = undefined;
  entry.store.updateSession(entry.sessionId, { pending_user_input: wait });
  const card = buildCursorQuestionCard({ request: entry.request, index: entry.index, screen: '' }, `${entry.id}:${entry.index}`);
  const result = await enqueueDelivery(entry.adapter, entry.address, () => isCurrent(entry)
    ? deliver(entry.adapter, { address: entry.address, replyToMessageId: entry.replyToMessageId, text: wait, richCard: card }, { sessionId: entry.sessionId })
    : Promise.resolve({ ok: false, error: 'Cursor 问卷已结束。' }), { queueClass: 'interactive' }).completion;
  if (!result.ok || !result.messageId) {
    if (!isCurrent(entry)) return;
    throw new Error('Cursor 问题卡片发送失败，未自动选择答案。');
  }
  entry.store.insertPermissionLink({ permissionRequestId: entry.permissionId, channelType: entry.address.channelType,
    chatId: entry.address.chatId, messageId: result.messageId, sessionId: entry.sessionId, toolName: 'Cursor AskQuestion', suggestions: '' });
  if (isCurrent(entry)) entry.messageId = result.messageId;
  else entry.store.markPermissionLinkResolved(entry.permissionId);
}

function validQuestions(value: unknown): value is CursorPendingQuestion['questions'] {
  if (!Array.isArray(value) || !value.length) return false;
  const ids = new Set<string>();
  return value.every(q => {
    if (!q || typeof q.id !== 'string' || !q.id || ids.has(q.id) || typeof q.prompt !== 'string'
      || (q.allowMultiple !== undefined && typeof q.allowMultiple !== 'boolean') || !Array.isArray(q.options)) return false;
    ids.add(q.id);
    const options = new Set<string>();
    return q.options.every((o: unknown) => {
      if (!o || typeof o !== 'object') return false;
      const option = o as Record<string, unknown>;
      if (typeof option.id !== 'string' || !option.id || options.has(option.id) || typeof option.label !== 'string') return false;
      options.add(option.id);
      return true;
    });
  });
}

export async function forwardCursorAcpQuestion(
  adapter: BaseChannelAdapter, address: ChannelAddress, permissionId: string, input: Record<string, unknown>,
  sessionId: string, store: BridgeStore, permissions: PermissionGateway, replyToMessageId?: string,
): Promise<void> {
  const binding = store.getChannelChat(address.channelType, address.chatId);
  const questions = input.questions;
  const session = store.getSession(sessionId);
  if (binding?.bridgeSessionId !== sessionId || !session || !validQuestions(questions)
    || resolveEffectiveRuntimeProvider(session, binding).identity !== 'cursor:acp') {
    permissions.resolvePendingPermission(permissionId, { behavior: 'deny', message: '问题格式或会话来源无效。' });
    return;
  }
  const id = PREFIX + createHash('sha256').update(permissionId).digest('hex').slice(0, 24);
  if (pending.has(id)) return;
  const entry: Pending = { id, permissionId, sessionId, nativeSessionId: getSessionCursorSessionId(session), bindingId: binding.id,
    address, adapter, store, permissions, replyToMessageId, request: { title: typeof input.title === 'string' ? input.title : '请回答问题',
      toolCallId: String(input.toolCallId || permissionId), questions }, index: 0, answers: [], busy: true };
  pending.set(id, entry);
  try { await show(entry); }
  catch (error) { remove(entry, '问题卡片发送失败，当前问卷已经结束。'); throw error; }
  finally { entry.busy = false; }
}

async function submit(entry: Pending, text: string): Promise<string> {
  if (!isCurrent(entry)) return '这个问题已结束，未提交旧答复。';
  if (entry.busy) return '正在提交此题，请勿重复操作。';
  const q = entry.request.questions[entry.index]!;
  const values = q.allowMultiple ? text.split(/[,，]/u).map(value => value.trim()) : [text.trim()];
  const options = values.map(value => q.options.find((option, index) => value === option.id || value === option.label || value === String(index + 1)));
  const answer = options.every(Boolean)
    ? { questionId: q.id, selectedOptionIds: [...new Set(options.map(option => option!.id))] }
    : { questionId: q.id, selectedOptionIds: [], freeformText: text };
  entry.busy = true;
  entry.answers.push(answer);
  entry.index++;
  try {
    if (entry.index < entry.request.questions.length) {
      await show(entry);
      return isCurrent(entry) ? '已记录此题，请继续回答下一题。' : '这个问题已结束，未提交旧答复。';
    }
    const ok = entry.permissions.resolvePendingPermission(entry.permissionId,
      { behavior: 'allow', message: JSON.stringify({ answers: entry.answers }) });
    remove(entry);
    return ok ? (entry.answers.some(item => item.freeformText)
      ? '回答已提交；自由文本将作为新消息继续原任务。' : '回答已提交，Cursor 继续执行。') : '这个问题已结束，未提交旧答复。';
  } catch (error) {
    remove(entry, '问题卡片发送失败，当前问卷已经结束。');
    return error instanceof Error ? error.message : String(error);
  } finally { entry.busy = false; }
}

export async function answerCursorAcpQuestion(msg: InboundMessage, sessionId: string, store: BridgeStore): Promise<string | undefined> {
  const entries = [...pending.values()].filter(entry => entry.store === store && entry.sessionId === sessionId
    && entry.address.channelType === msg.address.channelType && entry.address.chatId === msg.address.chatId && isCurrent(entry));
  if (!entries.length || !msg.text.trim()) return undefined;
  if (entries.length !== 1) return '当前有多个问题，请使用对应卡片。';
  return submit(entries[0]!, msg.text);
}

export async function handleCursorAcpQuestionCallback(msg: InboundMessage): Promise<string | undefined> {
  if (!msg.callbackData?.startsWith(PREFIX)) return undefined;
  const parts = /^cursor-acp-question:([a-f0-9]{24}):(\d+):(\d+)$/u.exec(msg.callbackData);
  const entry = parts ? pending.get(PREFIX + parts[1]) : undefined;
  if (!entry || entry.address.channelType !== msg.address.channelType || entry.address.chatId !== msg.address.chatId
    || !isCurrent(entry) || Number(parts![2]) !== entry.index || !entry.messageId
    || (msg.callbackMessageId || msg.messageId) !== entry.messageId) {
    return '这个 Cursor 问题已失效，请使用当前问题卡片。';
  }
  const option = entry.request.questions[entry.index]?.options[Number(parts![3])];
  return option ? submit(entry, option.id) : '无效选项。';
}
