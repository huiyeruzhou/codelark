import { randomUUID } from 'node:crypto';
import type { BaseChannelAdapter } from '../../channels/contracts.js';
import type { BridgeStore, ChannelAddress, InboundMessage, OutboundRichCardSection } from '../../domain/index.js';
import { deliver, enqueueDelivery } from '../../channels/delivery/deliver.js';
import { buildFencedCodeBlock } from '../../shared/markdown/fence.js';
import type { CodexAppServerSession } from '../../runtime/codex/app-server-registry.js';
import type { AppServerPendingRequest } from '../../runtime/codex/app-server-lifecycle.js';

const PREFIX = 'app-server-request:';
interface Question { id: string; question: string; options?: Array<{ label: string; description?: string }> }
interface Pending {
  id: string;
  request: AppServerPendingRequest;
  handle: CodexAppServerSession;
  sessionId: string;
  address: ChannelAddress;
  messageId?: string;
  questions: Question[];
  answers: Record<string, { answers: string[] }>;
}
const pending = new Map<string, Pending>();
const observers = new Map<string, { handle: CodexAppServerSession; address: ChannelAddress; store: BridgeStore; close: () => void }>();

function active(entry: Pending): boolean {
  return entry.handle.lifecycle.snapshot(entry.handle.threadId).requests.some((r) => r.key === entry.request.key);
}

function questionsOf(request: AppServerPendingRequest): Question[] {
  if (request.method !== 'item/tool/requestUserInput' || !Array.isArray(request.params.questions)) return [];
  return request.params.questions.filter((q): q is Question => Boolean(q && typeof q === 'object'
    && typeof q.id === 'string' && typeof q.question === 'string')).map((q) => ({
      id: q.id, question: q.question,
      options: Array.isArray(q.options) ? q.options.filter((o) => o && typeof o.label === 'string') : [],
    }));
}

function requestDescription(request: AppServerPendingRequest): string {
  const p = request.params;
  const lines: string[] = [];
  if (request.method === 'item/commandExecution/requestApproval') {
    lines.push('Codex 请求执行以下命令：');
    if (typeof p.command === 'string') lines.push(buildFencedCodeBlock(p.command, 'sh'));
    if (typeof p.cwd === 'string') lines.push(`工作目录：${p.cwd}`);
  } else if (request.method === 'item/fileChange/requestApproval') {
    lines.push('Codex 请求修改文件。');
    if (typeof p.grantRoot === 'string') lines.push(`允许修改的目录：${p.grantRoot}`);
    const changes = p.changes && typeof p.changes === 'object' ? Object.entries(p.changes) : [];
    for (const [filePath, change] of changes) {
      lines.push(`文件：${filePath}`);
      if (change && typeof change === 'object' && 'diff' in change && typeof change.diff === 'string') {
        lines.push(buildFencedCodeBlock(change.diff, 'diff'));
      }
    }
    if (!changes.length) lines.push('请在 Codex 客户端核对具体文件和修改内容后再决定。');
  } else {
    lines.push('Codex 需要处理额外权限、工具授权或当前尚未支持的请求，请在 Desktop / Codex 客户端完成确认。');
  }
  if (typeof p.reason === 'string' && p.reason) lines.push(`原因：${p.reason}`);
  return lines.join('\n\n');
}

/** Approval and input responses remain scoped to the backend connection generation. */
export function observeAppServerRequests(
  sessionId: string, handle: CodexAppServerSession, adapter: BaseChannelAdapter,
  address: ChannelAddress, store: BridgeStore,
): void {
  const previous = observers.get(sessionId);
  if (previous?.handle === handle && previous.address.chatId === address.chatId && previous.address.channelType === address.channelType) return;
  releaseAppServerRequestObserver(sessionId);
  const synchronize = () => {
    const requests = handle.lifecycle.snapshot(handle.threadId).requests;
    for (const [id, entry] of pending) {
      if (entry.sessionId !== sessionId) continue;
      if (entry.handle === handle && requests.some((r) => r.key === entry.request.key)) continue;
      pending.delete(id);
      try { store.markPermissionLinkResolved(id); } catch { /* Link may still be in delivery. */ }
    }
    for (const request of requests) {
      if ([...pending.values()].some((e) => e.sessionId === sessionId && e.handle === handle && e.request.key === request.key)) continue;
      const id = `${PREFIX}${randomUUID()}`;
      const questions = questionsOf(request);
      const entry: Pending = { id, request, handle, sessionId, address, questions, answers: {} };
      pending.set(id, entry);
      const approval = request.method === 'item/commandExecution/requestApproval' || request.method === 'item/fileChange/requestApproval';
      const sections: OutboundRichCardSection[] = questions.length
        ? questions.map((question, qi) => ({
          markdown: [question.question, ...(question.options || []).map((option) => `${option.label}${option.description ? `：${option.description}` : ''}`)].join('\n\n'),
          actions: [(question.options || []).map((option, oi) => ({ text: option.label, callbackData: `${id}:answer:${qi}:${oi}` }))],
        }))
        : [{ markdown: requestDescription(request) }];
      if (approval) sections.push({ actions: [[
        { text: '允许', callbackData: `${id}:accept`, type: 'primary' },
        { text: '拒绝', callbackData: `${id}:decline`, type: 'danger' },
      ]] });
      if (questions.length) sections.push({ markdown: '可点击选项；也可直接发送文字回答当前第一个尚未回答的问题。' });
      if (!approval && !questions.length) sections.push({ markdown: '此请求需要在 Codex 客户端处理，CodeLark 尚未支持该请求类型，未自动批准。' });
      const delivery = enqueueDelivery(adapter, address, () => deliver(adapter, {
        address,
        text: questions.length ? questions.map((q) => q.question).join('\n\n') : requestDescription(request),
        richCard: { title: questions.length ? 'Codex 需要你的回答' : 'Codex 请求确认', sections },
      }, { sessionId }), { queueClass: 'interactive' });
      void delivery.completion.then((result) => {
        if (!result.ok || !result.messageId) return;
        entry.messageId = result.messageId;
        store.insertPermissionLink({ permissionRequestId: id, channelType: address.channelType,
          chatId: address.chatId, messageId: result.messageId, sessionId, toolName: request.method, suggestions: '' });
        if (!pending.has(id) || !active(entry)) store.markPermissionLinkResolved(id);
      }).catch((error) => console.warn('[app-server-permission] 请求卡片投递失败:', error));
    }
  };
  const offChange = handle.lifecycle.onChange((threadId) => { if (threadId === handle.threadId) synchronize(); });
  const offRequest = handle.lifecycle.onRequest((request) => { if (request.threadId === handle.threadId) synchronize(); });
  observers.set(sessionId, { handle, address, store, close: () => { offChange(); offRequest(); } });
  synchronize();
}

function finish(entry: Pending, result: unknown, store: BridgeStore): string {
  if (!active(entry)) { pending.delete(entry.id); return '这个请求已处理或连接已更新，请使用当前请求。'; }
  const link = store.getPermissionLink(entry.id);
  if (link && !store.markPermissionLinkResolved(entry.id)) return '这个请求已处理。';
  pending.delete(entry.id);
  return entry.handle.lifecycle.reply(entry.request.key, result) ? '已提交给 Codex。' : '请求已失效，未提交旧答复。';
}

function answer(entry: Pending, index: number, text: string, store: BridgeStore): string {
  const question = entry.questions[index];
  if (!question || !active(entry)) return '这个问题已失效。';
  entry.answers[question.id] = { answers: [text] };
  if (entry.questions.some((q) => !entry.answers[q.id])) return '已记录此项，请继续回答其余问题。';
  return finish(entry, { answers: entry.answers }, store);
}

export function handleAppServerRequestCallback(msg: InboundMessage, store: BridgeStore): string | undefined {
  if (!msg.callbackData?.startsWith(PREFIX)) return undefined;
  const parts = msg.callbackData.split(':');
  const id = parts.slice(0, 2).join(':');
  const entry = pending.get(id);
  if (!entry || !active(entry)) return '这个请求已处理或连接已更新，请使用当前请求。';
  if (entry.address.chatId !== msg.address.chatId || entry.address.channelType !== msg.address.channelType
    || (msg.callbackMessageId && entry.messageId && msg.callbackMessageId !== entry.messageId)) return '请求来源不匹配，未提交答复。';
  if (parts[2] === 'answer') {
    const qi = Number(parts[3]); const oi = Number(parts[4]);
    const option = entry.questions[qi]?.options?.[oi];
    return option ? answer(entry, qi, option.label, store) : '无效的问题选项。';
  }
  if (entry.request.method !== 'item/commandExecution/requestApproval' && entry.request.method !== 'item/fileChange/requestApproval') return '此请求不是允许/拒绝审批。';
  if (parts[2] !== 'accept' && parts[2] !== 'decline') return '无效的审批选项。';
  return finish(entry, { decision: parts[2] }, store);
}

export function answerAppServerQuestion(msg: InboundMessage, sessionId: string, store: BridgeStore): string | undefined {
  const entries = [...pending.values()].filter((entry) => entry.sessionId === sessionId && active(entry)
    && entry.questions.length && entry.address.chatId === msg.address.chatId && entry.address.channelType === msg.address.channelType);
  if (!msg.text.trim() || !entries.length) return undefined;
  if (entries.length > 1) return '当前有多个待回答请求，请使用对应问题卡片的选项，或在 Codex 客户端回答。';
  const entry = entries[0]!;
  const index = entry.questions.findIndex((question) => !entry.answers[question.id]);
  return index >= 0 ? answer(entry, index, msg.text.trim(), store) : undefined;
}

export function hasAppServerQuestion(sessionId: string): boolean {
  return [...pending.values()].some((entry) => entry.sessionId === sessionId && entry.questions.length && active(entry));
}

export function closeAppServerRequestObservers(): void {
  for (const sessionId of observers.keys()) releaseAppServerRequestObserver(sessionId);
}

export function releaseAppServerRequestObserver(sessionId: string): void {
  const observer = observers.get(sessionId);
  observer?.close();
  observers.delete(sessionId);
  for (const [id, entry] of pending) {
    if (entry.sessionId !== sessionId) continue;
    pending.delete(id);
    observer?.store.markPermissionLinkResolved(id);
  }
}
