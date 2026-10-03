import { randomUUID } from 'node:crypto';
import type { BaseChannelAdapter } from '../../channels/contracts.js';
import type { BridgeStore, ChannelAddress, InboundMessage, OutboundRichCardSection, OutboundCardActionButton } from '../../domain/index.js';
import { deliver, enqueueDelivery } from '../../channels/delivery/deliver.js';
import { buildFencedCodeBlock } from '../../shared/markdown/fence.js';
import type { CodexAppServerSession } from '../../runtime/codex/app-server-registry.js';
import type { AppServerPendingRequest } from '../../runtime/codex/app-server-lifecycle.js';

import { describePermissions, requestedPermissions, questionsOf, mcpSchema, isMcpForm, parseMcpAnswer, type RequestQuestion } from './app-server-request-types.js';

const PREFIX = 'app-server-request:';
interface Pending {
  id: string;
  request: AppServerPendingRequest;
  handle: CodexAppServerSession;
  sessionId: string;
  address: ChannelAddress;
  messageId?: string;
  questions: RequestQuestion[];
  answers: Record<string, unknown>;
}
const pending = new Map<string, Pending>();
const observers = new Map<string, { handle: CodexAppServerSession; address: ChannelAddress; store: BridgeStore; close: () => void }>();

function active(entry: Pending): boolean {
  return entry.handle.lifecycle.snapshot(entry.handle.threadId).requests.some((r) => r.key === entry.request.key);
}

function requestDescription(request: AppServerPendingRequest, handle?: CodexAppServerSession): string {
  const p = request.params;
  const lines: string[] = [];
  if (request.method === 'item/commandExecution/requestApproval') {
    lines.push('Codex 请求执行以下命令：');
    if (typeof p.command === 'string') lines.push(buildFencedCodeBlock(p.command, 'sh'));
    if (typeof p.cwd === 'string') lines.push(`工作目录：${p.cwd}`);
    const network = p.networkApprovalContext as { host?: string; protocol?: string } | undefined;
    if (network?.host) lines.push(`网络目标：${network.protocol || '网络'}://${network.host}`);
    if (p.additionalPermissions) lines.push(...describePermissions(p.additionalPermissions));
  } else if (request.method === 'item/fileChange/requestApproval') {
    lines.push('Codex 请求修改文件。');
    if (typeof p.grantRoot === 'string') lines.push(`允许修改的目录：${p.grantRoot}`);
    const item = typeof p.itemId === 'string' && request.turnId
      ? handle?.lifecycle.item(request.threadId, request.turnId, p.itemId) : undefined;
    const changes = Array.isArray(item?.changes) ? item.changes
      : p.changes && typeof p.changes === 'object' ? Object.entries(p.changes).map(([path, change]) => ({ path, ...(change as object) })) : [];
    for (const change of changes) {
      if (!change || typeof change !== 'object') continue;
      if (typeof change.path === 'string') lines.push(`文件：${change.path}`);
      if (typeof change.diff === 'string') lines.push(buildFencedCodeBlock(change.diff, 'diff'));
    }
    if (!changes.length) lines.push('请在 Codex 客户端核对具体文件和修改内容后再决定。');
  } else if (request.method === 'item/permissions/requestApproval') {
    lines.push('Codex 请求在本轮使用以下权限：', ...describePermissions(p.permissions));
    if (typeof p.cwd === 'string') lines.push(`工作目录：${p.cwd}`);
  } else if (request.method === 'mcpServer/elicitation/request') {
    if (typeof p.serverName === 'string') lines.push(`工具服务：${p.serverName}`);
    if (typeof p.message === 'string') lines.push(p.message);
    if (p.mode === 'url') {
      const url = elicitationUrl(request);
      if (url) lines.push(`[打开链接](<${url}>)`, '请打开链接完成操作，再点击“已完成”。');
    }
  } else {
    lines.push('Codex 需要处理额外权限、工具授权或当前尚未支持的请求，请在 Desktop / Codex 客户端完成确认。');
  }
  if (typeof p.reason === 'string' && p.reason) lines.push(`原因：${p.reason}`);
  return lines.join('\n\n');
}

function elicitationUrl(request: AppServerPendingRequest): string | undefined {
  try {
    const url = new URL(String(request.params.url));
    return ['https:', 'http:'].includes(url.protocol) ? url.href.replaceAll('<', '%3C').replaceAll('>', '%3E') : undefined;
  } catch { return undefined; }
}

function decisions(entry: Pending): OutboundCardActionButton[] {
  const { id, request } = entry;
  const button = (text: string, action: string, type?: 'primary' | 'danger'): OutboundCardActionButton => ({ text, callbackData: `${id}:${action}`, ...(type ? { type } : {}) });
  if (request.method === 'item/permissions/requestApproval') return [
    ...(requestedPermissions(request.params.permissions) ? [button('仅本轮允许', 'accept', 'primary')] : []), button('拒绝', 'decline', 'danger'),
  ];
  if (request.method === 'mcpServer/elicitation/request') {
    const url = elicitationUrl(request);
    return [
      ...(request.params.mode === 'url' && url ? [button('已完成', 'accept', 'primary')] : []),
      ...(isMcpForm(request) && mcpSchema(request) && !entry.questions.length ? [button('确认', 'accept', 'primary')] : []),
      button('拒绝', 'decline', 'danger'), button('取消', 'cancel'),
    ];
  }
  if (request.method !== 'item/commandExecution/requestApproval' && request.method !== 'item/fileChange/requestApproval') return [];
  const available = Array.isArray(request.params.availableDecisions) ? request.params.availableDecisions : ['accept', 'decline'];
  return [['accept', '允许'], ['decline', '拒绝'], ['cancel', '取消']].filter(([decision]) => available.includes(decision))
    .filter(([decision]) => decision !== 'accept' || !request.params.additionalPermissions || requestedPermissions(request.params.additionalPermissions))
    .map(([decision, label]) => button(label!, decision!, decision === 'accept' ? 'primary' : decision === 'decline' ? 'danger' : undefined));
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
      const entry: Pending = { id, request, handle, sessionId, address, questions, answers: Object.create(null) };
      pending.set(id, entry);
      const actions = decisions(entry);
      const sections: OutboundRichCardSection[] = questions.length
        ? questions.map((question, qi) => ({
          markdown: [question.question, ...(question.options || []).map((option) => `${option.label}${option.description ? `：${option.description}` : ''}`)].join('\n\n'),
          actions: [[...(question.options || []).map((option, oi) => ({ text: option.label, callbackData: `${id}:answer:${qi}:${oi}` })),
            ...(question.optional ? [{ text: '不填写', callbackData: `${id}:skip:${qi}` }] : [])]],
        }))
        : [{ markdown: requestDescription(request, handle) }];
      if (questions.length && request.method === 'mcpServer/elicitation/request') sections.unshift({ markdown: requestDescription(request, handle) });
      if (actions.length) sections.push({ actions: [actions] });
      if (questions.length) sections.push({ markdown: '可点击选项；也可直接发送文字回答当前第一个尚未回答的问题。' });
      if (!actions.length && !questions.length) sections.push({ markdown: '此请求需要在 Codex 客户端处理，CodeLark 尚未支持该请求类型，未自动批准。' });
      const delivery = enqueueDelivery(adapter, address, () => deliver(adapter, {
        address,
        text: questions.length ? questions.map((q) => q.question).join('\n\n') : requestDescription(request, handle),
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

function answer(entry: Pending, index: number, text: string, store: BridgeStore, skip = false): string {
  const question = entry.questions[index];
  if (!question || !active(entry)) return '这个问题已失效。';
  try {
    entry.answers[question.id] = isMcpForm(entry.request)
      ? (skip && question.optional ? undefined : parseMcpAnswer(question, text)) : { answers: [text] };
  } catch { return '回答不符合此项要求，请按问题中的选项或格式重新填写。'; }
  if (entry.questions.some((q) => !Object.hasOwn(entry.answers, q.id))) return '已记录此项，请继续回答其余问题。';
  if (!isMcpForm(entry.request)) return finish(entry, { answers: { ...entry.answers } }, store);
  const parsed = mcpSchema(entry.request)?.safeParse(Object.fromEntries(Object.entries(entry.answers).filter(([, value]) => value !== undefined)));
  if (!parsed?.success) {
    delete entry.answers[question.id];
    return '表单内容尚未满足要求，请重新填写当前问题。';
  }
  return finish(entry, { action: 'accept', content: parsed.data, _meta: null }, store);
}

export function handleAppServerRequestCallback(msg: InboundMessage, store: BridgeStore): string | undefined {
  if (!msg.callbackData?.startsWith(PREFIX)) return undefined;
  const parts = msg.callbackData.split(':');
  const id = parts.slice(0, 2).join(':');
  const entry = pending.get(id);
  if (!entry || !active(entry)) return '这个请求已处理或连接已更新，请使用当前请求。';
  if (entry.address.chatId !== msg.address.chatId || entry.address.channelType !== msg.address.channelType
    || (msg.callbackMessageId && entry.messageId && msg.callbackMessageId !== entry.messageId)) return '请求来源不匹配，未提交答复。';
  if (parts[2] === 'skip' && entry.questions[Number(parts[3])]?.optional) return answer(entry, Number(parts[3]), '', store, true);
  if (parts[2] === 'answer') {
    const qi = Number(parts[3]); const oi = Number(parts[4]);
    const option = entry.questions[qi]?.options?.[oi];
    return option ? answer(entry, qi, option.label, store) : '无效的问题选项。';
  }
  const decision = parts[2];
  if (!decisions(entry).some((action) => action.callbackData === msg.callbackData)) return '无效的审批选项。';
  if (entry.request.method === 'item/permissions/requestApproval') {
    return finish(entry, { permissions: decision === 'accept' ? requestedPermissions(entry.request.params.permissions) : {}, scope: 'turn' }, store);
  }
  if (entry.request.method === 'mcpServer/elicitation/request') {
    const content = decision === 'accept' && isMcpForm(entry.request) ? mcpSchema(entry.request)?.safeParse({}) : undefined;
    if (content && !content.success) return '表单尚未填写完整。';
    return finish(entry, { action: decision, content: content?.success ? content.data : null, _meta: null }, store);
  }
  return finish(entry, { decision }, store);
}

export function answerAppServerQuestion(msg: InboundMessage, sessionId: string, store: BridgeStore): string | undefined {
  const entries = [...pending.values()].filter((entry) => entry.sessionId === sessionId && active(entry)
    && entry.questions.length && entry.address.chatId === msg.address.chatId && entry.address.channelType === msg.address.channelType);
  if (!msg.text.trim() || !entries.length) return undefined;
  if (entries.length > 1) return '当前有多个待回答请求，请使用对应问题卡片的选项，或在 Codex 客户端回答。';
  const entry = entries[0]!;
  const index = entry.questions.findIndex((question) => !Object.hasOwn(entry.answers, question.id));
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
