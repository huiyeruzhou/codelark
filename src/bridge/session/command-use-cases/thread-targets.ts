import { DEFAULT_WORKSPACE_ROOT } from '../../../configuration/paths.js';
import type { BridgeSession, BridgeStore, ChannelChat, InboundMessage, OutboundRichCard } from '../../../domain/index.js';
import {
  getBridgeSessionCodexThreadId,
  getBridgeSessionDisplayTitle,
} from '../display/session-display-query.js';
import {
  listBindingsForChat,
  SessionRegistryService,
} from '../registry.js';
import * as router from '../channel-router.js';
import {
  getSessionClaudeCwd,
  getSessionClaudeSessionId,
  getSessionWorkingDirectory,
  mergeSessionRuntimeUpdates,
  setSessionActiveRuntimeUpdate,
  setSessionClaudeIdentityUpdate,
} from '../../../domain/session-runtime.js';
import { readConfiguredCodexModel } from '../../../runtime/codex/models.js';
import { recordBindingChange, type BindingChangeAction } from '../binding-audit.js';
import {
  MAX_LOCAL_SESSION_LIST_LIMIT,
  parseListIndex,
} from '../../command/aliases.js';
import {
  buildGlobalThreadList,
  type GlobalThreadListItem,
} from '../../command/presentation.js';
import {
  CommandThreadDisplay,
  type ThreadCardScope,
} from '../../command/thread-display.js';
import {
  archiveCommandClaudeThread,
  archiveCommandCodexThread,
  getCommandLocalRuntimeThreadByIdSafe,
  getCommandCodexThreadByIdSafe,
  listCommandLocalRuntimeSessions,
  type LocalRuntimeSessionSummary,
} from './source.js';

export function selectLocalRuntimeSessionByThreadId(
  raw: string,
  displayedThreads: LocalRuntimeSessionSummary[],
): {
  thread?: LocalRuntimeSessionSummary;
  threadId?: string;
  ambiguous?: boolean;
} {
  const token = raw.trim();
  const lowerToken = token.toLowerCase();
  const exactThread = displayedThreads.find((session) => session.threadId.toLowerCase() === lowerToken);
  if (exactThread) return { thread: exactThread, threadId: exactThread.threadId };

  const prefixMatches = displayedThreads.filter((session) => session.threadId.toLowerCase().startsWith(lowerToken));
  if (prefixMatches.length > 1) return { ambiguous: true };
  if (prefixMatches.length === 1) return { thread: prefixMatches[0], threadId: prefixMatches[0].threadId };

  const fallback = getCommandLocalRuntimeThreadByIdSafe(raw, undefined, 'thread switch by id');
  return fallback.thread ? fallback : {};
}

export function selectDirectThreadTarget(
  threadDisplay: CommandThreadDisplay,
  raw: string,
  bindings: ChannelChat[],
  displayedThreads: LocalRuntimeSessionSummary[],
  bridgeItems: ReturnType<CommandThreadDisplay['bridgeOnlyBoundThreadCardItems']> = [],
  store?: BridgeStore,
  globalItems: GlobalThreadListItem[] = buildGlobalThreadList(displayedThreads, bridgeItems),
): {
  binding?: ChannelChat;
  bridgeSession?: BridgeSession;
  thread?: LocalRuntimeSessionSummary;
  threadId?: string;
  ambiguous?: boolean;
  index?: number;
} {
  const token = raw.trim();
  const lowerToken = token.toLowerCase();
  const index = parseListIndex(token);
  let outOfRangeIndex: number | undefined;
  if (index !== null) {
    const globalItem = globalItems[index - 1];
    if (!globalItem) {
      outOfRangeIndex = index;
    } else {
      if (globalItem.kind === 'bridge') {
        const bridgeItem = globalItem.bridge;
        const bridgeSession = bridgeItem?.bridgeSessionId && store
          ? store.getSession(bridgeItem.bridgeSessionId)
          : null;
        return bridgeSession ? { bridgeSession, index } : { index };
      }
      return {
        thread: globalItem.local,
        threadId: globalItem.local.threadId,
        index,
      };
    }
  }

  const bindingThreadMatches = bindings.filter((binding) => {
    const threadId = threadDisplay.bindingThreadId(binding);
    return Boolean(threadId && (threadId.toLowerCase() === lowerToken || threadId.toLowerCase().startsWith(lowerToken)));
  });
  if (bindingThreadMatches.length > 1) return { ambiguous: true };
  if (bindingThreadMatches.length === 1) return { binding: bindingThreadMatches[0] };

  const localRuntimeSessionMatch = selectLocalRuntimeSessionByThreadId(raw, displayedThreads);
  if (localRuntimeSessionMatch.ambiguous) return { ambiguous: true };
  if (localRuntimeSessionMatch.threadId) return localRuntimeSessionMatch;

  const bindingIdMatches = bindings.filter((binding) => (
    binding.id.toLowerCase() === lowerToken
    || binding.id.toLowerCase().startsWith(lowerToken)
  ));
  if (bindingIdMatches.length > 1) return { ambiguous: true };
  if (bindingIdMatches.length === 1) return { binding: bindingIdMatches[0] };

  if (store) {
    const bridgeIdMatches = store.listSessions().filter((session) => (
      session.hidden !== true
      && session.session_type !== 'draft'
      && (
        session.id.toLowerCase() === lowerToken
        || session.id.toLowerCase().startsWith(lowerToken)
      )
    ));
    if (bridgeIdMatches.length > 1) return { ambiguous: true };
    if (bridgeIdMatches.length === 1) return { bridgeSession: bridgeIdMatches[0] };
  }

  const bindingNameMatches = bindings.filter((binding) => threadDisplay.binding(binding).title.trim() === token);
  const bindingNameSessionIds = new Set(bindingNameMatches.map((binding) => binding.bridgeSessionId));
  const localNameMatches = displayedThreads.filter((session) => session.title.trim() === token);
  const bridgeNameMatches = store
    ? store.listSessions().filter((session) => (
      session.hidden !== true
      && session.session_type !== 'draft'
      && !bindingNameSessionIds.has(session.id)
      && getBridgeSessionDisplayTitle(session).trim() === token
    ))
    : [];
  const targets = new Map<string, { binding?: ChannelChat; thread?: LocalRuntimeSessionSummary; threadId?: string }>();
  for (const binding of bindingNameMatches) {
    const threadId = threadDisplay.bindingThreadId(binding);
    targets.set(threadId ? `thread:${threadId}` : `binding:${binding.id}`, { binding });
  }
  for (const thread of localNameMatches) {
    const key = `thread:${thread.threadId}`;
    if (!targets.has(key)) {
      targets.set(key, { thread, threadId: thread.threadId });
    }
  }
  for (const session of bridgeNameMatches) {
    targets.set(`bridge:${session.id}`, { binding: undefined, thread: undefined, threadId: undefined });
  }
  if (targets.size > 1) return { ambiguous: true };
  if (bridgeNameMatches.length === 1 && targets.size === 1) return { bridgeSession: bridgeNameMatches[0] };
  return Array.from(targets.values())[0] || (outOfRangeIndex !== undefined ? { index: outOfRangeIndex } : {});
}

export function getRawCodexTitle(threadId: string | undefined, fallback?: string): string | undefined {
  if (!threadId) return fallback;
  return getCommandCodexThreadByIdSafe(threadId, 'thread raw title').thread?.title || fallback;
}

export function createCommandSessionRegistry(store: BridgeStore): SessionRegistryService {
  return new SessionRegistryService(store, {
    codexThreads: {
      getThread(codexThreadId) {
        const session = getCommandCodexThreadByIdSafe(codexThreadId, 'command registry lookup').thread;
        return session
          ? { codexThreadId: session.threadId, title: session.title, cwd: session.cwd }
          : null;
      },
      archiveThread: (codexThreadId) => Boolean(archiveCommandCodexThread(codexThreadId)),
    },
    claudeThreads: {
      getThread: () => null,
      archiveThread: (claudeSessionId, cwd) => Boolean(archiveCommandClaudeThread(claudeSessionId, cwd)),
    },
    readDefaultModel: () => readConfiguredCodexModel(),
    defaultWorkingDirectory: () => DEFAULT_WORKSPACE_ROOT,
  });
}

export function findBridgeSessionByCodexThread(store: BridgeStore, threadId: string): BridgeSession | null {
  return store.listSessions().find((session) => getBridgeSessionCodexThreadId(session) === threadId) || null;
}

function findBridgeSessionByClaudeThread(
  store: BridgeStore,
  thread: Pick<LocalRuntimeSessionSummary, 'threadId' | 'cwd'>,
): BridgeSession | null {
  return store.listSessions().find((session) => (
    session.hidden !== true
    && session.session_type !== 'draft'
    && session.runtime?.activeRuntime === 'claude'
    && session.runtime?.claude?.sessionId === thread.threadId
    && session.runtime?.claude?.cwd === thread.cwd
  )) || null;
}

export function findBridgeSessionByClaudeIdentity(
  store: BridgeStore,
  sessionId: string,
  cwd: string,
): BridgeSession | null {
  return findBridgeSessionByClaudeThread(store, { threadId: sessionId, cwd });
}

function materializeClaudeThread(store: BridgeStore, thread: LocalRuntimeSessionSummary): BridgeSession {
  const existing = findBridgeSessionByClaudeThread(store, thread);
  if (existing) return existing;
  const session = store.createSession(
    thread.title || thread.threadId.slice(0, 8),
    'default',
    undefined,
    thread.cwd || DEFAULT_WORKSPACE_ROOT,
    'normal',
  );
  store.updateSession(session.id, mergeSessionRuntimeUpdates(
    {},
    setSessionActiveRuntimeUpdate('claude'),
    setSessionClaudeIdentityUpdate(thread.threadId, thread.cwd),
  ));
  return store.getSession(session.id) || session;
}

export function localRuntimeOf(thread: LocalRuntimeSessionSummary | undefined): 'codex' | 'claude' {
  return thread?.runtime === 'claude' ? 'claude' : 'codex';
}

export function bindToLocalRuntimeThread(
  store: BridgeStore,
  address: InboundMessage['address'],
  thread: LocalRuntimeSessionSummary,
  opts?: { codexTitle?: string },
): ChannelChat {
  if (localRuntimeOf(thread) === 'claude') {
    const session = materializeClaudeThread(store, thread);
    const binding = router.bindToSession(address, session.id);
    if (!binding) throw new Error('指定的 Claude Code 会话无法绑定。');
    return binding;
  }
  return router.bindToCodexThread(address, thread.threadId, {
    workingDirectory: thread.cwd,
    codexTitle: opts?.codexTitle,
  });
}

export function findVisibleBridgeSessionByToken(
  store: BridgeStore,
  token: string,
  options: { unboundOnly?: boolean; threadlessOnly?: boolean } = {},
): { session: BridgeSession | null; ambiguous: boolean } {
  const lowerToken = token.trim().toLowerCase();
  if (!lowerToken) return { session: null, ambiguous: false };
  const sessionIdsWithBinding = new Set(store.listChannelChats().map((binding) => binding.bridgeSessionId));
  const matches = store.listSessions().filter((session) => (
    session.hidden !== true
    && session.session_type !== 'draft'
    && (!options.unboundOnly || !sessionIdsWithBinding.has(session.id))
    && (!options.threadlessOnly || !getBridgeSessionCodexThreadId(session))
    && (
      session.id.toLowerCase() === lowerToken
      || session.id.toLowerCase().startsWith(lowerToken)
      || getBridgeSessionDisplayTitle(session).trim() === token.trim()
    )
  ));
  return {
    session: matches.length === 1 ? matches[0] : null,
    ambiguous: matches.length > 1,
  };
}

export function findBridgeOnlySessionByToken(store: BridgeStore, token: string) {
  return findVisibleBridgeSessionByToken(store, token, { unboundOnly: true, threadlessOnly: true });
}

export function resolveCurrentCodexThreadTarget(
  store: BridgeStore,
  threadDisplay: CommandThreadDisplay,
  address: InboundMessage['address'],
): {
  threadId?: string;
  runtime?: 'codex' | 'claude';
  title?: string;
  cwd?: string;
  binding?: ChannelChat;
  bridgeSessionId?: string;
} {
  const binding = store.getChannelChat(address.channelType, address.chatId);
  if (!binding) return {};

  const session = store.getSession(binding.bridgeSessionId);
  const activeRuntime = session?.runtime?.activeRuntime === 'claude' ? 'claude' : 'codex';
  if (activeRuntime === 'claude') {
    const sessionId = getSessionClaudeSessionId(session);
    const cwd = getSessionClaudeCwd(session) || getSessionWorkingDirectory(session);
    if (!sessionId) return { binding, bridgeSessionId: binding.bridgeSessionId };
    return {
      threadId: sessionId,
      title: session ? getBridgeSessionDisplayTitle(session) : threadDisplay.binding(binding).title,
      cwd,
      binding,
      bridgeSessionId: binding.bridgeSessionId,
      runtime: 'claude',
    };
  }
  const threadId = session ? getBridgeSessionCodexThreadId(session) : '';
  if (!threadId) return { binding, bridgeSessionId: binding.bridgeSessionId };

  const codexThread = getCommandCodexThreadByIdSafe(threadId, 'thread archive current').thread;
  return {
    threadId,
    title: codexThread?.title || (session ? getBridgeSessionDisplayTitle(session) : threadDisplay.binding(binding).title),
    cwd: codexThread?.cwd || getSessionWorkingDirectory(session) || '',
    binding,
    bridgeSessionId: binding.bridgeSessionId,
    runtime: 'codex',
  };
}

export function auditCommandBindingChange(
  store: BridgeStore,
  action: BindingChangeAction,
  msg: InboundMessage,
  fromBinding: ChannelChat | null | undefined,
  toBinding: ChannelChat | null | undefined,
  reason?: string,
): void {
  recordBindingChange(store, {
    action,
    address: msg.address,
    fromBinding,
    toBinding,
    messageId: msg.messageId,
    source: 'im_command',
    reason,
  });
}

export function buildThreadCardRefresh(
  threadDisplay: CommandThreadDisplay,
  scope: ThreadCardScope | null | undefined,
  address: InboundMessage['address'],
  selectedId?: string | null,
): OutboundRichCard | undefined {
  if (scope === 'bound') {
    return threadDisplay.refreshedBoundThreadsCard(address.channelType, address.chatId, selectedId);
  }
  if (scope === 'global') {
    const runtime = threadDisplay.activeRuntimeForChat(address.channelType, address.chatId);
    return threadDisplay.refreshedLocalRuntimeSessionsCard(
      listCommandLocalRuntimeSessions(MAX_LOCAL_SESSION_LIST_LIMIT, runtime),
      true,
      MAX_LOCAL_SESSION_LIST_LIMIT,
      address.channelType,
      address.chatId,
      selectedId,
      [],
      runtime,
    );
  }
  return undefined;
}
