import path from 'node:path';

import type { BridgeStore } from '../../../domain/audit.js';
import type { ChannelAddress, ChannelChat, ChannelChatMode, ChannelDefaultTarget } from '../../../domain/channel.js';
import type { BridgeSession } from '../../../domain/session.js';
import { recordBindingChange } from '../binding-audit.js';
import type { ChannelProvider } from '../../../configuration/channel-types.js';
import {
  asChannelProvider,
  resolveConfiguredChannelMeta,
} from '../../../configuration/channel-instances.js';
import {
  getCodexSessionByThreadId,
  isArchivedCodexThread,
  listCodexSessions,
  type CodexSessionSummary,
} from '../../../runtime/codex/session-index.js';
import {
  getCodexThreadId,
} from '../../turn/turn-classifier.js';
import { getBridgeSessionDisplayTitle } from '../display/session-display-query.js';
import {
  getSessionActiveRuntime,
  getSessionClaudeCwd,
  getSessionClaudeSessionId,
  getSessionCodexTitle,
  getSessionWorkingDirectory,
  setSessionCodexTitleUpdate,
} from '../../../domain/session-runtime.js';
import { getGlobalStringConfig } from '../global-config.js';
import {
  hasSessionCodexProviderOverride,
  resolveDisplayedModel,
  resolveEffectiveCodexProvider,
  resolveEffectiveMode,
} from '../support.js';

export interface BindingTargetOption {
  kind: 'codex' | 'session';
  id: string;
  label: string;
  description: string;
  cwd: string;
  bridgeSessionId?: string;
  codexThreadId?: string;
  threadId?: string;
  sessionId?: string;
}

export interface BindingSummary {
  id: string;
  channelType: string;
  channelProvider?: string;
  channelAlias?: string;
  chatId: string;
  chatKind?: ChannelChat['chatKind'];
  chatUserId?: string;
  chatDisplayName?: string;
  mode: ChannelChatMode;
  codexProvider: 'sdk' | 'pty' | 'tmux' | 'default';
  model: string;
  workingDirectory: string;
  currentTargetLabel: string;
  currentSessionId: string;
  currentSessionName: string;
  currentRuntime?: 'codex' | 'claude';
  currentThreadId?: string;
  currentRuntimeThreadId?: string;
  currentClaudeCwd?: string;
  runtimeStatus?: BridgeSession['runtime_status'];
  queuedCount?: number;
  mirrorStatus?: BridgeSession['mirror_status'];
  mirrorLastEventAt?: string;
}

export interface ChannelDefaultTargetSummary {
  id: string;
  channelType: string;
  channelProvider?: string;
  channelAlias?: string;
  bridgeSessionId: string;
  targetLabel: string;
  targetSessionId: string;
  targetRuntime?: 'codex' | 'claude';
  targetThreadId?: string;
  targetRuntimeThreadId?: string;
  targetClaudeCwd?: string;
  createdAt: string;
  updatedAt: string;
}

interface BindingChatMeta {
  chatKind?: ChannelChat['chatKind'];
  chatUserId?: string;
  chatDisplayName?: string;
}

function compareBindingsForChatList(a: ChannelChat, b: ChannelChat): number {
  const aCreated = Date.parse(a.createdAt || '');
  const bCreated = Date.parse(b.createdAt || '');
  const createdDiff = (Number.isFinite(aCreated) ? aCreated : 0) - (Number.isFinite(bCreated) ? bCreated : 0);
  if (createdDiff !== 0) return createdDiff;
  return 0;
}

function resolveChannelMeta(channelType: string, provider?: ChannelProvider): {
  provider?: ChannelProvider;
  alias?: string;
} {
  try {
    return resolveConfiguredChannelMeta(channelType, provider);
  } catch {
    return {
      provider,
      alias: channelType,
    };
  }
}

function formatChannelLabel(binding: Pick<ChannelChat, 'channelType' | 'channelProvider' | 'channelAlias'>): string {
  return binding.channelAlias?.trim()
    || resolveChannelMeta(binding.channelType, asChannelProvider(binding.channelProvider)).alias
    || binding.channelType;
}

function formatBindingChatTarget(binding: ChannelChat): string {
  return binding.chatId;
}

function findConflictingBinding(
  store: BridgeStore,
  current: { channelType: string; chatId: string },
  match: (binding: ChannelChat) => boolean,
): ChannelChat | null {
  return store.listChannelChats().find((binding) => {
    if (binding.channelType === current.channelType && binding.chatId === current.chatId) {
      return false;
    }
    return match(binding);
  }) || null;
}

function findTargetConflict(
  store: BridgeStore,
  opts: { sessionId?: string; codexThreadId?: string },
): ChannelChat | null {
  return store.listChannelChats().find((binding) => (
    (opts.sessionId ? binding.bridgeSessionId === opts.sessionId : false)
    || (opts.codexThreadId
      ? getCodexThreadId(store.getSession(binding.bridgeSessionId)) === opts.codexThreadId
      : false)
  )) || null;
}

function assertBindingTargetAvailable(
  store: BridgeStore,
  current: { channelType: string; chatId: string },
  opts: { sessionId?: string; codexThreadId?: string },
): void {
  const conflict = findConflictingBinding(
    store,
    current,
    (binding) => (
      (opts.sessionId ? binding.bridgeSessionId === opts.sessionId : false)
      || (opts.codexThreadId
        ? getCodexThreadId(store.getSession(binding.bridgeSessionId)) === opts.codexThreadId
        : false)
    ),
  );

  if (!conflict) return;

  throw new Error(
    `该会话已绑定到 ${formatChannelLabel(conflict)} 聊天 ${formatBindingChatTarget(conflict)}。一个会话只能绑定一个聊天。`,
  );
}

function assertBridgeSessionAvailableForDefaultRouting(
  store: BridgeStore,
  bridgeSessionId: string,
): void {
  const session = store.getSession(bridgeSessionId);
  if (!session) {
    throw new Error('Session not found.');
  }

  const conflict = findTargetConflict(store, {
    sessionId: session.id,
    codexThreadId: getCodexThreadId(session),
  });
  if (conflict) {
    throw new Error(
      `该会话已绑定到 ${formatChannelLabel(conflict)} 聊天 ${formatBindingChatTarget(conflict)}。一个会话只能绑定一个聊天。`,
    );
  }
}

function getSessionName(session: BridgeSession): string {
  if (session.session_type === 'draft') return '临时草稿线程';
  if (session.name?.trim() || getSessionCodexTitle(session)) return getBridgeSessionDisplayTitle(session);
  const workingDirectory = getSessionWorkingDirectory(session);
  if (workingDirectory) return path.basename(workingDirectory);
  return session.id.slice(0, 8);
}

function getSessionMode(session: BridgeSession, binding?: ChannelChat | null): ChannelChatMode {
  return resolveEffectiveMode(binding, session);
}

function getSessionCodexProvider(
  session: BridgeSession | null | undefined,
  binding?: ChannelChat | null,
): 'sdk' | 'pty' | 'tmux' | 'default' {
  return hasSessionCodexProviderOverride(session) ? resolveEffectiveCodexProvider(session, binding) : 'default';
}

function describeBridgeSessionTarget(
  store: BridgeStore,
  bridgeSessionId: string,
): {
  targetLabel: string;
  targetSessionId: string;
  targetRuntime: 'codex' | 'claude';
  targetThreadId?: string;
  targetRuntimeThreadId?: string;
  targetClaudeCwd?: string;
} {
  const session = store.getSession(bridgeSessionId);
  if (!session) {
    throw new Error('Session not found.');
  }
  const activeRuntime = getSessionActiveRuntime(session) === 'claude' ? 'claude' : 'codex';
  const codexThreadId = getCodexThreadId(session) || undefined;
  const claudeSessionId = getSessionClaudeSessionId(session) || undefined;

  return {
    targetLabel: getSessionName(session),
    targetSessionId: session.id,
    targetRuntime: activeRuntime,
    targetThreadId: codexThreadId,
    targetRuntimeThreadId: activeRuntime === 'claude' ? claudeSessionId : codexThreadId,
    targetClaudeCwd: activeRuntime === 'claude' ? getSessionClaudeCwd(session) || getSessionWorkingDirectory(session) || undefined : undefined,
  };
}

function updateSessionCodexThread(
  store: BridgeStore,
  sessionId: string,
  codexThreadId: string,
): void {
  store.updateSessionCodexThreadId(sessionId, codexThreadId);
}

export function ensureBridgeSessionForCodexThread(
  store: BridgeStore,
  codexThreadId: string,
  opts?: { workingDirectory?: string; model?: string; displayName?: string; name?: string; codexTitle?: string },
): BridgeSession {
  const codexTitle = opts?.codexTitle || opts?.displayName || '';
  const existing = store.findSessionByCodexThreadId(codexThreadId);
  if (existing) {
    updateSessionCodexThread(store, existing.id, codexThreadId);
    if (codexTitle && getSessionCodexTitle(existing) !== codexTitle) {
      store.updateSession(existing.id, setSessionCodexTitleUpdate(codexTitle), { touch: false });
    }
    return store.getSession(existing.id) || existing;
  }

  const workingDirectory = opts?.workingDirectory || '';
  const model = opts?.model || getGlobalStringConfig('runtime.codex.model') || '';
  const baseName = opts?.name || '';

  const session = store.createSession(
    baseName,
    model,
    undefined,
    workingDirectory,
    'code',
  );
  updateSessionCodexThread(store, session.id, codexThreadId);
  if (codexTitle) {
    store.updateSession(session.id, setSessionCodexTitleUpdate(codexTitle), { touch: false });
  }
  return store.getSession(session.id) || session;
}

export function bindStoreToSession(
  store: BridgeStore,
  channelType: string,
  chatId: string,
  sessionId: string,
  chatMeta?: BindingChatMeta,
): ChannelChat | null {
  const session = store.getSession(sessionId);
  if (!session) return null;

  assertBindingTargetAvailable(
    store,
    { channelType, chatId },
    {
      sessionId: session.id,
      codexThreadId: getCodexThreadId(session),
    },
  );
  const meta = resolveChannelMeta(channelType);
  if (chatMeta?.chatDisplayName && !session.name?.trim()) {
    store.updateSession(session.id, { name: chatMeta.chatDisplayName }, { touch: false });
  }

  return store.upsertChannelChat({
    channelType,
    channelProvider: meta.provider,
    channelAlias: meta.alias,
    chatId,
    chatKind: chatMeta?.chatKind,
    chatUserId: chatMeta?.chatUserId,
    bridgeSessionId: session.id,
  });
}

export function bindStoreToCodexThread(
  store: BridgeStore,
  channelType: string,
  chatId: string,
  codexThreadId: string,
  opts?: { workingDirectory?: string; model?: string; displayName?: string; name?: string; codexTitle?: string; chatKind?: ChannelChat['chatKind']; chatUserId?: string; chatDisplayName?: string },
): ChannelChat {
  assertBindingTargetAvailable(
    store,
    { channelType, chatId },
    { codexThreadId },
  );
  const meta = resolveChannelMeta(channelType);

  const session = ensureBridgeSessionForCodexThread(store, codexThreadId, opts);
  if (opts?.chatDisplayName && !session.name?.trim()) {
    store.updateSession(session.id, { name: opts.chatDisplayName }, { touch: false });
  }

  return store.upsertChannelChat({
    channelType,
    channelProvider: meta.provider,
    channelAlias: meta.alias,
    chatId,
    chatKind: opts?.chatKind,
    chatUserId: opts?.chatUserId,
    bridgeSessionId: session.id,
  });
}

export function bindAddressToBridgeSession(
  store: BridgeStore,
  address: Pick<ChannelAddress, 'channelType' | 'chatId' | 'chatKind' | 'userId' | 'displayName'>,
  bridgeSessionId: string,
): ChannelChat {
  const binding = bindStoreToSession(store, address.channelType, address.chatId, bridgeSessionId, {
    chatKind: address.chatKind,
    chatUserId: address.userId,
    chatDisplayName: address.displayName,
  });
  if (!binding) {
    throw new Error('Session not found.');
  }
  return binding;
}

export function listBindingsForChat(
  store: BridgeStore,
  channelType: string,
  chatId: string,
): ChannelChat[] {
  return store.listChannelChats(channelType)
    .filter((binding) => binding.chatId === chatId)
    .sort(compareBindingsForChatList);
}

export function setActiveBindingForChat(
  store: BridgeStore,
  bindingId: string,
): ChannelChat {
  const binding = store.listChannelChats().find((item) => item.id === bindingId);
  if (!binding) {
    throw new Error('Binding not found.');
  }
  return binding;
}

export function listBindingTargetOptions(
  store: BridgeStore,
  codexLimit = 12,
): BindingTargetOption[] {
  const bridgeOptions = store.listSessions()
    .filter((session) => session.hidden !== true && session.session_type !== 'draft')
    .map((session) => {
      const threadId = getCodexThreadId(session) || undefined;
      return {
        kind: 'session' as const,
        id: session.id,
        label: getSessionName(session),
        description: `${threadId ? `${threadId.slice(0, 8)}... · ` : ''}${getSessionWorkingDirectory(session) || '(no cwd)'}`,
        cwd: getSessionWorkingDirectory(session) || '',
        bridgeSessionId: session.id,
        threadId,
        sessionId: session.id,
      };
    });

  const bridgeByThreadId = new Map<string, BridgeSession>();
  for (const session of store.listSessions()) {
    const threadId = getCodexThreadId(session);
    if (threadId && session.hidden !== true && session.session_type !== 'draft') {
      bridgeByThreadId.set(threadId, session);
    }
  }
  const codexOptions = listCodexSessions(codexLimit).map((session) => {
    const bridgeSession = bridgeByThreadId.get(session.threadId);
    return {
      kind: 'codex' as const,
      id: session.threadId,
      label: bridgeSession
        ? (bridgeSession.name?.trim() ? getBridgeSessionDisplayTitle(bridgeSession) : (getSessionCodexTitle(bridgeSession) || session.title))
        : session.title,
      description: `${session.threadId.slice(0, 8)}... · ${session.cwd || '(no cwd)'}`,
      cwd: session.cwd,
      codexThreadId: session.threadId,
      threadId: session.threadId,
      bridgeSessionId: bridgeSession?.id,
    };
  });

  return [...bridgeOptions, ...codexOptions];
}

export function listBindingSummaries(store: BridgeStore): BindingSummary[] {
  return store.listChannelChats().map((binding) => {
    const session = store.getSession(binding.bridgeSessionId);
    const currentThreadId = getCodexThreadId(session) || undefined;
    const currentRuntime: 'codex' | 'claude' = getSessionActiveRuntime(session) === 'claude' ? 'claude' : 'codex';
    const currentRuntimeThreadId = currentRuntime === 'claude'
      ? getSessionClaudeSessionId(session) || undefined
      : currentThreadId;
    const fallbackSession = { id: binding.bridgeSessionId } as BridgeSession;
    const currentTargetLabel = getSessionName(session || fallbackSession);

    return {
      id: binding.id,
      channelType: binding.channelType,
      channelProvider: binding.channelProvider,
      channelAlias: binding.channelAlias,
      chatId: binding.chatId,
      chatKind: binding.chatKind,
      chatUserId: binding.chatUserId,
      chatDisplayName: session ? getSessionName(session) : undefined,
      mode: session ? getSessionMode(session, binding) : 'normal',
      codexProvider: getSessionCodexProvider(session, binding),
      model: resolveDisplayedModel(binding, session, getGlobalStringConfig('runtime.codex.model'), ''),
      workingDirectory: getSessionWorkingDirectory(session) || '',
      currentTargetLabel,
      currentSessionId: binding.bridgeSessionId,
      currentSessionName: session ? getSessionName(session) : binding.bridgeSessionId.slice(0, 8),
      currentRuntime,
      currentThreadId,
      currentRuntimeThreadId,
      currentClaudeCwd: currentRuntime === 'claude' ? getSessionClaudeCwd(session) || getSessionWorkingDirectory(session) || undefined : undefined,
      runtimeStatus: session?.runtime_status,
      queuedCount: session?.queued_count,
      mirrorStatus: session?.mirror_status,
      mirrorLastEventAt: session?.mirror_last_event_at,
    };
  }).sort((a, b) => {
    const aLabel = a.channelAlias || a.channelType;
    const bLabel = b.channelAlias || b.channelType;
    if (aLabel !== bLabel) return aLabel.localeCompare(bLabel);
    return a.chatId.localeCompare(b.chatId);
  });
}

export function listChannelDefaultTargetSummaries(store: BridgeStore): ChannelDefaultTargetSummary[] {
  return store.listChannelDefaultTargets().map((target) => {
    const resolved = describeBridgeSessionTarget(store, target.bridgeSessionId);
    return {
      id: target.id,
      channelType: target.channelType,
      channelProvider: target.channelProvider,
      channelAlias: target.channelAlias,
      bridgeSessionId: target.bridgeSessionId,
      targetLabel: resolved.targetLabel,
      targetSessionId: resolved.targetSessionId,
      targetRuntime: resolved.targetRuntime,
      targetThreadId: resolved.targetThreadId,
      targetRuntimeThreadId: resolved.targetRuntimeThreadId,
      targetClaudeCwd: resolved.targetClaudeCwd,
      createdAt: target.createdAt,
      updatedAt: target.updatedAt,
    };
  }).sort((a, b) => {
    const aLabel = a.channelAlias || a.channelType;
    const bLabel = b.channelAlias || b.channelType;
    return aLabel.localeCompare(bLabel);
  });
}

export function updateChannelDefaultTarget(
  store: BridgeStore,
  channelType: string,
  bridgeSessionId: string,
): ChannelDefaultTargetSummary {
  assertBridgeSessionAvailableForDefaultRouting(store, bridgeSessionId);
  const meta = resolveChannelMeta(channelType);
  const existing = store.getChannelDefaultTarget(channelType);
  const updated = store.upsertChannelDefaultTarget({
    channelType,
    channelProvider: meta.provider,
    channelAlias: meta.alias,
    bridgeSessionId,
  });

  recordBindingChange(store, {
    action: 'web_set_default_target',
    address: {
      channelType,
      channelProvider: meta.provider,
      channelAlias: meta.alias,
      chatId: '*',
    },
    fromBinding: existing ? ({
      id: existing.id,
      channelType: existing.channelType,
      channelProvider: existing.channelProvider,
      channelAlias: existing.channelAlias,
      chatId: '*',
      bridgeSessionId: existing.bridgeSessionId,
      createdAt: existing.createdAt,
      updatedAt: existing.updatedAt,
    } satisfies ChannelChat) : null,
    toBinding: {
      id: updated.id,
      channelType: updated.channelType,
      channelProvider: updated.channelProvider,
      channelAlias: updated.channelAlias,
      chatId: '*',
      bridgeSessionId: updated.bridgeSessionId,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    },
    source: 'web_ui',
    reason: `bridgeSessionId=${bridgeSessionId}`,
  });

  return listChannelDefaultTargetSummaries(store).find((item) => item.channelType === channelType)!;
}

export function updateChannelDefaultCodexThread(
  store: BridgeStore,
  channelType: string,
  codexThreadId: string,
): ChannelDefaultTargetSummary {
  const local = getCodexSessionByThreadId(codexThreadId);
  const session = ensureBridgeSessionForCodexThread(store, codexThreadId, local ? {
    workingDirectory: local.cwd,
    codexTitle: local.title,
  } : undefined);
  return updateChannelDefaultTarget(store, channelType, session.id);
}

export function removeChannelDefaultTarget(
  store: BridgeStore,
  channelType: string,
): void {
  const existing = store.getChannelDefaultTarget(channelType);
  if (!existing) {
    throw new Error('Channel default target not found.');
  }
  store.deleteChannelDefaultTarget(channelType);
  recordBindingChange(store, {
    action: 'web_clear_default_target',
    address: {
      channelType,
      channelProvider: existing.channelProvider,
      channelAlias: existing.channelAlias,
      chatId: '*',
    },
    fromBinding: {
      id: existing.id,
      channelType: existing.channelType,
      channelProvider: existing.channelProvider,
      channelAlias: existing.channelAlias,
      chatId: '*',
      bridgeSessionId: existing.bridgeSessionId,
      createdAt: existing.createdAt,
      updatedAt: existing.updatedAt,
    },
    toBinding: null,
    source: 'web_ui',
  });
}

export function updateBindingTarget(
  store: BridgeStore,
  bindingId: string,
  target: { bridgeSessionId?: string; codexThreadId?: string },
): BindingSummary {
  const binding = store.listChannelChats().find((item) => item.id === bindingId);
  if (!binding) {
    throw new Error('Binding not found.');
  }
  const fromBinding = { ...binding };

  if (target.codexThreadId) {
    const codexSession = getCodexSessionByThreadId(target.codexThreadId);
    bindStoreToCodexThread(store, binding.channelType, binding.chatId, target.codexThreadId, codexSession ? {
      workingDirectory: codexSession.cwd,
      codexTitle: codexSession.title,
      chatUserId: binding.chatUserId,
      chatKind: binding.chatKind,
    } : {
      chatUserId: binding.chatUserId,
      chatKind: binding.chatKind,
    });
  } else if (target.bridgeSessionId) {
    const updated = bindStoreToSession(store, binding.channelType, binding.chatId, target.bridgeSessionId, {
      chatKind: binding.chatKind,
      chatUserId: binding.chatUserId,
    });
    if (!updated) {
      throw new Error('Session not found.');
    }
  } else {
    throw new Error('Unsupported session target.');
  }

  const toBinding = store.getChannelChat(binding.channelType, binding.chatId);
  recordBindingChange(store, {
    action: 'web_switch',
    address: {
      channelType: binding.channelType,
      channelProvider: binding.channelProvider,
      channelAlias: binding.channelAlias,
      chatId: binding.chatId,
      chatKind: binding.chatKind,
    },
    fromBinding,
    toBinding,
    source: 'web_ui',
    reason: target.codexThreadId ? `codexThreadId=${target.codexThreadId}` : `bridgeSessionId=${target.bridgeSessionId}`,
  });

  const updated = listBindingSummaries(store).find((item) => item.id === bindingId);
  if (!updated) {
    throw new Error('Updated binding not found.');
  }
  return updated;
}

export function removeBinding(
  store: BridgeStore,
  bindingId: string,
): void {
  const binding = store.listChannelChats().find((item) => item.id === bindingId);
  if (!binding) {
    throw new Error('Binding not found.');
  }
  const fromBinding = { ...binding };
  store.deleteChannelChat(bindingId);
  recordBindingChange(store, {
    action: 'web_unbind',
    address: {
      channelType: binding.channelType,
      channelProvider: binding.channelProvider,
      channelAlias: binding.channelAlias,
      chatId: binding.chatId,
    },
    fromBinding,
    toBinding: null,
    source: 'web_ui',
  });
}

export function getChannelChatSummaries(
  store: BridgeStore,
  channelType: string,
): BindingSummary[] {
  return listBindingSummaries(store).filter((binding) => binding.channelType === channelType);
}

export function getCodexCandidateForThread(threadId: string): CodexSessionSummary | null {
  return getCodexSessionByThreadId(threadId);
}
