import { listBindingsForChat } from '../session/registry.js';
import type { BridgeStore } from '../../domain/index.js';
import { getBridgeSessionCodexThreadId } from '../session/display/session-display-query.js';
import {
  ThreadDisplayService,
  type ThreadTitleOptions,
} from '../session/thread-display-resolver.js';
import {
  getSessionActiveRuntime,
  getSessionClaudeSessionId,
  getSessionCursorSessionId,
  getSessionKimiSessionId,
  getSessionZcodeSessionId,
  getSessionWorkingDirectory,
} from '../../domain/session-runtime.js';
import type { RuntimeAgent } from '../../domain/session.js';
import type { ChannelChat, OutboundRichCard } from '../../domain/index.js';
import {
  buildBoundThreadsCommandCard,
  buildBoundThreadsCommandResponse,
  buildLocalRuntimeSessionsCommandCard,
  buildCommandFields,
  type BoundThreadCardItem,
  type ThreadCardBindingState,
  type ThreadCardScope,
} from './presentation.js';
import type { LocalRuntimeSessionSummary } from '../session/command-use-cases/source.js';

export class CommandThreadDisplay {
  private readonly display: ThreadDisplayService;

  constructor(private readonly store: BridgeStore) {
    this.display = new ThreadDisplayService(store);
  }

  chatBindingsResponse(channelType: string, chatId: string, markdown: boolean): string {
    const bindings = listBindingsForChat(this.store, channelType, chatId);
    if (bindings.length === 0) {
      return buildCommandFields(
        '当前聊天绑定',
        [],
        ['还没有绑定线程。发送 `/t` 查看本地会话，再用 `/t 1` 切换当前聊天。'],
        markdown,
      );
    }

    return buildBoundThreadsCommandResponse(this.boundThreadCardItems(channelType, chatId), markdown);
  }

  refreshedLocalRuntimeSessionsCard(
    localSessions: LocalRuntimeSessionSummary[] | null | undefined,
    showAll: boolean,
    limit: number | undefined,
    channelType: string,
    chatId: string,
    selectedThreadId?: string | null,
    bridgeBindings: BoundThreadCardItem[] = [],
    runtime?: RuntimeAgent,
  ): OutboundRichCard | undefined {
    return buildLocalRuntimeSessionsCommandCard(
      this.decorateLocalRuntimeSessions(localSessions || [], channelType, chatId),
      showAll,
      limit,
      this.threadBindingStates(channelType, chatId),
      bridgeBindings,
      { channelType, chatId, selectedThreadId, activeRuntime: runtime || this.activeRuntimeForChat(channelType, chatId) },
    ) || undefined;
  }

  activeRuntimeForChat(channelType: string, chatId: string): RuntimeAgent {
    const currentBinding = this.store.getChannelChat(channelType, chatId);
    return getSessionActiveRuntime(this.store.getSession(currentBinding?.bridgeSessionId || '')) || 'codex';
  }

  refreshedBoundThreadsCard(
    channelType: string,
    chatId: string,
    selectedBindingId?: string | null,
  ): OutboundRichCard | undefined {
    return buildBoundThreadsCommandCard(
      this.boundThreadCardItems(channelType, chatId),
      { channelType, chatId, selectedBindingId },
    ) || undefined;
  }

  bindingThreadId(binding: ChannelChat): string {
    return this.display.bindingThreadId(binding);
  }

  bindingShortId(binding: ChannelChat): string {
    return this.display.bindingShortId(binding);
  }

  binding(binding: ChannelChat, options: ThreadTitleOptions = {}) {
    return this.display.binding(binding, options);
  }

  localRuntimeSession(session: LocalRuntimeSessionSummary, binding?: ChannelChat, options: ThreadTitleOptions = {}) {
    return this.display.localRuntimeSession(session, binding, options);
  }

  resolveBoundBindingSelection(bindings: ChannelChat[], raw: string) {
    return this.display.resolveBoundBindingSelection(bindings, raw);
  }

  selectLocalRuntimeSession(raw: string, displayedThreads: LocalRuntimeSessionSummary[]) {
    return this.display.selectLocalRuntimeSession(raw, displayedThreads);
  }

  renameBinding(binding: ChannelChat, name: string): void {
    this.display.renameBinding(binding, name);
  }

  decorateLocalRuntimeSessions(
    localSessions: LocalRuntimeSessionSummary[],
    channelType?: string,
    chatId?: string,
  ): LocalRuntimeSessionSummary[] {
    const bindingByThreadId = new Map<string, ChannelChat>();
    if (channelType && chatId) {
      for (const binding of listBindingsForChat(this.store, channelType, chatId)) {
        const threadId = this.bindingThreadId(binding);
        if (threadId) bindingByThreadId.set(threadId, binding);
      }
    }

    return localSessions.map((session) => ({
      ...session,
      title: this.localRuntimeSession(session, bindingByThreadId.get(session.threadId)).title,
    }));
  }

  threadBindingStates(channelType: string, chatId: string): ThreadCardBindingState[] {
    const statesByThreadId = new Map<string, ThreadCardBindingState>();
    for (const session of this.store.listSessions()) {
      if (session.hidden === true || session.session_type === 'draft') continue;
      const activeRuntime = getSessionActiveRuntime(session);
      const threadId = activeRuntime === 'claude'
        ? getSessionClaudeSessionId(session)
        : activeRuntime === 'kimi'
          ? getSessionKimiSessionId(session)
          : activeRuntime === 'cursor'
            ? getSessionCursorSessionId(session)
            : activeRuntime === 'zcode'
              ? getSessionZcodeSessionId(session)
          : getBridgeSessionCodexThreadId(session);
      if (!threadId) continue;
      statesByThreadId.set(threadId, {
        threadId,
        bridgeSessionId: session.id,
        active: false,
      });
    }
    for (const binding of this.store.listChannelChats()) {
      const isCurrentChat = binding.channelType === channelType && binding.chatId === chatId;
      const display = this.binding(binding);
      if (!display.threadId) continue;
      const state = {
        threadId: display.threadId,
        bindingId: binding.id,
        bridgeSessionId: binding.bridgeSessionId,
        active: isCurrentChat,
        title: display.title,
      };
      const previous = statesByThreadId.get(display.threadId);
      if (!previous || state.active || !previous.bindingId) {
        statesByThreadId.set(display.threadId, state);
      }
    }
    return Array.from(statesByThreadId.values());
  }

  boundThreadCardItems(channelType: string, chatId: string): BoundThreadCardItem[] {
    return this.sortedBoundBindings(channelType, chatId).map(({ item }) => item);
  }

  sortedBoundBindings(channelType: string, chatId: string): Array<{ binding: ChannelChat; item: BoundThreadCardItem }> {
    return listBindingsForChat(this.store, channelType, chatId)
      .map((binding) => ({ binding, item: this.boundThreadCardItem(binding) }))
      .sort((a, b) => compareBoundThreadActivityDesc(a.item, b.item));
  }

  private boundThreadCardItem(binding: ChannelChat): BoundThreadCardItem {
    const display = this.binding(binding);
    return {
      title: display.title,
      cwd: display.cwd,
      lastActiveAt: display.lastActiveAt,
      threadId: display.threadId,
      bridgeSessionId: binding.bridgeSessionId,
      bindingId: binding.id,
      active: true,
      originator: display.originator,
    };
  }

  bridgeOnlyBoundThreadCardItems(channelType: string, chatId: string): BoundThreadCardItem[] {
    const currentChatBindingsBySessionId = new Map(
      listBindingsForChat(this.store, channelType, chatId)
        .map((binding) => [binding.bridgeSessionId, binding]),
    );
    const anyBindingsBySessionId = new Map<string, ChannelChat>();
    for (const binding of this.store.listChannelChats()) {
      if (!anyBindingsBySessionId.has(binding.bridgeSessionId)) {
        anyBindingsBySessionId.set(binding.bridgeSessionId, binding);
      }
    }
    return this.store.listSessions()
      .filter((session) => (
        session.hidden !== true
        && session.session_type !== 'draft'
        && !getBridgeSessionCodexThreadId(session)
      ))
      .map((session) => {
        const binding = currentChatBindingsBySessionId.get(session.id);
        const anyBinding = binding || anyBindingsBySessionId.get(session.id);
        const display = binding ? this.binding(binding) : this.display.thread('', session.id);
        const activeRuntime = getSessionActiveRuntime(session);
        const runtimeSessionId = activeRuntime === 'claude'
          ? getSessionClaudeSessionId(session) || ''
          : activeRuntime === 'kimi'
            ? getSessionKimiSessionId(session) || ''
            : activeRuntime === 'cursor'
              ? getSessionCursorSessionId(session) || ''
              : activeRuntime === 'zcode'
                ? getSessionZcodeSessionId(session) || ''
            : '';
        return {
          title: display.title,
          cwd: display.cwd || getSessionWorkingDirectory(session) || '',
          lastActiveAt: display.lastActiveAt || session.updated_at,
          threadId: runtimeSessionId,
          bridgeSessionId: session.id,
          bindingId: anyBinding ? anyBinding.id : '',
          active: Boolean(binding),
          originator: runtimeSessionId
            ? activeRuntime === 'kimi' ? 'Kimi Code' : activeRuntime === 'cursor' ? 'Cursor Agent' : activeRuntime === 'zcode' ? 'ZCode' : 'Claude Code'
            : binding ? display.originator : 'Bridge',
        };
      })
      .sort(compareBoundThreadActivityDesc);
  }
}

export type { ThreadCardScope };

function activityTimeMs(value: string | undefined): number {
  const time = Date.parse(value || '');
  return Number.isNaN(time) ? 0 : time;
}

function compareBoundThreadActivityDesc(a: BoundThreadCardItem, b: BoundThreadCardItem): number {
  const timeDiff = activityTimeMs(b.lastActiveAt) - activityTimeMs(a.lastActiveAt);
  if (timeDiff !== 0) return timeDiff;
  return (a.title || '').localeCompare(b.title || '');
}
