import type { CodexSessionSummary } from '../../runtime/codex/session-index.js';
import { getCodexSessionByThreadIdSafe } from './support.js';
import {
  bridgeSessionExecutionProvider,
  buildCodexThreadDisplaySummary,
  findVisibleBridgeSessionByCodexThread,
  getBridgeSessionDisplayTitle,
} from './display/session-display-query.js';
import {
  resolveCreatorKind,
  type CodexSourceSummary,
  type CreatorKind,
} from './display/session-creator.js';
import {
  getSessionDisplayName,
  stripLegacySessionPrefix,
} from './display/session-title.js';
import type { BridgeStore } from '../../domain/audit.js';
import type { LocalRuntimeSessionSummary } from './local-runtime-session.js';
import type { ChannelChat } from '../../domain/channel.js';
import {
  getSessionActiveRuntime,
  getSessionClaudeCwd,
  getSessionClaudeModel,
  getSessionClaudeReasoningEffort,
  getSessionClaudeSessionId,
  getSessionCodexModel,
  getSessionCodexReasoningEffort,
  getSessionCodexTitle,
  getSessionWorkingDirectory,
} from '../../domain/session-runtime.js';
import { getCodexThreadId } from '../turn/turn-classifier.js';
import { normalizeReasoningEffort } from '../../configuration/runtime-options.js';
import { getGlobalStringConfig } from './global-config.js';

export interface ThreadDisplayInfo {
  title: string;
  threadId: string;
  cwd: string;
  lastActiveAt?: string;
  originator?: string;
  bridgeSessionId?: string;
  creatorKind?: CreatorKind;
  codexSource?: CodexSourceSummary;
  executionProvider?: string;
  reasoningEffort?: string;
  model?: string;
}

export interface ThreadTitleOptions {
  stripInternalPrefix?: boolean;
}

export interface BindingSelection {
  binding?: ChannelChat;
  ambiguous?: boolean;
  index?: number;
}

export interface LocalRuntimeSessionSelection {
  thread?: LocalRuntimeSessionSummary;
  threadId?: string;
  ambiguous?: boolean;
  index?: number;
}

export class ThreadDisplayService {
  constructor(private readonly store: BridgeStore) {}

  private runtimeMetadata(
    session: ReturnType<BridgeStore['getSession']>,
    runtime: 'codex' | 'claude' = getSessionActiveRuntime(session) === 'claude' ? 'claude' : 'codex',
  ): Pick<ThreadDisplayInfo, 'reasoningEffort' | 'model'> {
    if (runtime === 'claude') {
      return {
        reasoningEffort: getSessionClaudeReasoningEffort(session) || 'default',
        model: getSessionClaudeModel(session)
          || getGlobalStringConfig('runtime.claude.model', 'bridge_claude_default_model', { store: this.store })
          || 'default',
      };
    }
    return {
      reasoningEffort: normalizeReasoningEffort(
        getSessionCodexReasoningEffort(session)
          || getGlobalStringConfig('runtime.codex.reasoningEffort', 'bridge_codex_reasoning_effort', { store: this.store }),
      ),
      model: getSessionCodexModel(session)
        || getGlobalStringConfig('runtime.codex.model', 'bridge_default_model', { store: this.store })
        || 'default',
    };
  }

  bindingThreadId(binding: ChannelChat): string {
    const session = this.store.getSession(binding.bridgeSessionId);
    if (getSessionActiveRuntime(session) === 'claude') {
      return getSessionClaudeSessionId(session) || '';
    }
    return getCodexThreadId(session, binding) || '';
  }

  bindingShortId(binding: ChannelChat): string {
    return binding.id.slice(0, 8);
  }

  binding(binding: ChannelChat, options: ThreadTitleOptions = {}): ThreadDisplayInfo {
    const session = this.store.getSession(binding.bridgeSessionId);
    const threadId = this.bindingThreadId(binding);
    const isClaude = getSessionActiveRuntime(session) === 'claude';
    const codexSession = !isClaude && threadId ? getCodexSessionByThreadIdSafe(threadId, 'thread display binding') : null;
    const sessionCodexTitle = getSessionCodexTitle(session);
    const sessionWorkingDirectory = getSessionWorkingDirectory(session);
    const title = this.resolveTitle({
      sessionName: session ? getBridgeSessionDisplayTitle(session) : undefined,
      sessionId: session?.id || binding.bridgeSessionId,
      threadId,
      codexTitle: sessionCodexTitle || codexSession?.title,
      fallback: getSessionDisplayName(session, sessionWorkingDirectory) || binding.bridgeSessionId.slice(0, 8),
    });
    const codexSource = codexSession ? codexSessionSource(codexSession) : undefined;
    const runtimeMetadata = this.runtimeMetadata(session, isClaude ? 'claude' : 'codex');
    return {
      title: formatResolvedThreadTitle(title, options),
      threadId,
      cwd: sessionWorkingDirectory || codexSession?.cwd || '',
      lastActiveAt: codexSession?.lastEventAt || session?.last_progress_at || session?.updated_at || binding.updatedAt,
      originator: isClaude ? 'Claude Code' : codexSession?.originator || '当前聊天',
      bridgeSessionId: session?.id || binding.bridgeSessionId,
      creatorKind: isClaude ? 'tui_cli' : codexSession ? resolveCreatorKind(codexSource || {}) : 'bridge',
      codexSource,
      executionProvider: bridgeSessionExecutionProvider(session),
      ...runtimeMetadata,
    };
  }

  localRuntimeSession(session: LocalRuntimeSessionSummary, binding?: ChannelChat, options: ThreadTitleOptions = {}): ThreadDisplayInfo {
    if (session.runtime === 'claude') {
      const bindingDisplay = binding ? this.binding(binding, options) : null;
      const linkedBridgeSession = this.store.listSessions().find((candidate) => (
        getSessionActiveRuntime(candidate) === 'claude'
        && getSessionClaudeSessionId(candidate) === session.threadId
        && (!session.cwd || getSessionClaudeCwd(candidate) === session.cwd)
      ));
      const title = this.resolveTitle({
        sessionName: linkedBridgeSession ? getBridgeSessionDisplayTitle(linkedBridgeSession) : undefined,
        sessionId: linkedBridgeSession?.id || binding?.bridgeSessionId,
        threadId: session.threadId,
        codexTitle: session.title,
        fallback: session.cwd || session.threadId.slice(0, 8),
      });
      return {
        title: formatResolvedThreadTitle(title, options),
        threadId: session.threadId,
        cwd: session.cwd || bindingDisplay?.cwd || '',
        lastActiveAt: session.lastEventAt || bindingDisplay?.lastActiveAt,
        originator: session.originator || bindingDisplay?.originator || 'Claude Code',
        bridgeSessionId: bindingDisplay?.bridgeSessionId || linkedBridgeSession?.id,
        creatorKind: 'tui_cli',
        executionProvider: bindingDisplay?.executionProvider || bridgeSessionExecutionProvider(linkedBridgeSession),
        ...this.runtimeMetadata(linkedBridgeSession || null, 'claude'),
      };
    }
    const bindingDisplay = binding ? this.binding(binding, options) : null;
    const linkedBridgeSession = binding
      ? this.store.getSession(binding.bridgeSessionId) || undefined
      : findVisibleBridgeSessionByCodexThread(this.store, session.threadId);
    const linkedCodexTitle = getSessionCodexTitle(linkedBridgeSession);
    const summary = buildCodexThreadDisplaySummary(session, linkedBridgeSession);
    const title = this.resolveTitle({
      sessionName: linkedBridgeSession ? getBridgeSessionDisplayTitle(linkedBridgeSession) : undefined,
      sessionId: linkedBridgeSession?.id || binding?.bridgeSessionId,
      threadId: session.threadId,
      codexTitle: linkedCodexTitle || session.title,
      fallback: session.cwd || session.threadId.slice(0, 8),
    });
    return {
      title: formatResolvedThreadTitle(title, options),
      threadId: session.threadId,
      cwd: session.cwd || bindingDisplay?.cwd || '',
      lastActiveAt: session.lastEventAt || bindingDisplay?.lastActiveAt,
      originator: session.originator || bindingDisplay?.originator || 'Codex Native',
      bridgeSessionId: bindingDisplay?.bridgeSessionId || linkedBridgeSession?.id,
      creatorKind: summary.creatorKind,
      codexSource: summary.codexSource,
      executionProvider: bindingDisplay?.executionProvider || summary.executionProvider,
      ...this.runtimeMetadata(linkedBridgeSession || null),
    };
  }

  thread(threadId: string, sessionId?: string | null, options: ThreadTitleOptions = {}): ThreadDisplayInfo {
    const session = sessionId
      ? this.store.getSession(sessionId)
      : findVisibleBridgeSessionByCodexThread(this.store, threadId) || null;
    const codexSession = getCodexSessionByThreadIdSafe(threadId, 'thread display thread') || null;
    const sessionCodexTitle = getSessionCodexTitle(session);
    const sessionWorkingDirectory = getSessionWorkingDirectory(session);
    const title = this.resolveTitle({
      sessionName: session ? getBridgeSessionDisplayTitle(session) : undefined,
      sessionId: session?.id,
      threadId,
      codexTitle: sessionCodexTitle || codexSession?.title,
      fallback: codexSession?.cwd || threadId.slice(0, 8),
    });
    const codexSource = codexSession ? codexSessionSource(codexSession) : undefined;
    const runtimeMetadata = this.runtimeMetadata(session);
    return {
      title: formatResolvedThreadTitle(title, options),
      threadId,
      cwd: sessionWorkingDirectory || codexSession?.cwd || '',
      lastActiveAt: codexSession?.lastEventAt || session?.last_progress_at || session?.updated_at,
      originator: codexSession?.originator || 'Codex Native',
      bridgeSessionId: session?.id,
      creatorKind: codexSession ? resolveCreatorKind(codexSource || {}) : (session ? 'bridge' : 'native'),
      codexSource,
      executionProvider: bridgeSessionExecutionProvider(session),
      ...runtimeMetadata,
    };
  }

  resolveBoundBindingSelection(bindings: ChannelChat[], raw: string): BindingSelection {
    const token = raw.trim();
    const lowerToken = token.toLowerCase();
    const index = /^\d+$/.test(token) ? Number(token) : null;
    if (index !== null) {
      if (!Number.isInteger(index) || index < 1) return {};
      const binding = bindings[index - 1];
      if (binding) return { binding, index };
    }

    const threadMatches = bindings.filter((binding) => {
      const threadId = this.bindingThreadId(binding);
      return Boolean(threadId && (threadId.toLowerCase() === lowerToken || threadId.toLowerCase().startsWith(lowerToken)));
    });
    if (threadMatches.length > 1) return { ambiguous: true };
    if (threadMatches.length === 1) return { binding: threadMatches[0] };

    const bindingMatches = bindings.filter((binding) => (
      binding.id.toLowerCase() === lowerToken
      || binding.id.toLowerCase().startsWith(lowerToken)
    ));
    if (bindingMatches.length > 1) return { ambiguous: true };
    if (bindingMatches.length === 1) return { binding: bindingMatches[0] };

    const bridgeSessionMatches = bindings.filter((binding) => (
      binding.bridgeSessionId.toLowerCase() === lowerToken
      || binding.bridgeSessionId.toLowerCase().startsWith(lowerToken)
    ));
    if (bridgeSessionMatches.length > 1) return { ambiguous: true };
    if (bridgeSessionMatches.length === 1) return { binding: bridgeSessionMatches[0] };

    const nameMatches = bindings.filter((binding) => this.binding(binding).title.trim() === token);
    if (nameMatches.length > 1) return { ambiguous: true };
    return { binding: nameMatches[0] };
  }

  selectLocalRuntimeSession(raw: string, displayedThreads: LocalRuntimeSessionSummary[]): LocalRuntimeSessionSelection {
    const token = raw.trim();
    const lowerToken = token.toLowerCase();
    const index = /^\d+$/.test(token) ? Number(token) : null;
    if (index !== null) {
      return displayedThreads[index - 1]
        ? { thread: displayedThreads[index - 1], threadId: displayedThreads[index - 1].threadId, index }
        : { index };
    }

    const exactThread = displayedThreads.find((session) => session.threadId.toLowerCase() === lowerToken);
    if (exactThread) return { thread: exactThread, threadId: exactThread.threadId };

    const prefixMatches = displayedThreads.filter((session) => session.threadId.toLowerCase().startsWith(lowerToken));
    if (prefixMatches.length > 1) return { ambiguous: true };
    if (prefixMatches.length === 1) return { thread: prefixMatches[0], threadId: prefixMatches[0].threadId };

    const nameMatches = displayedThreads.filter((session) => session.title.trim() === token);
    if (nameMatches.length > 1) return { ambiguous: true };
    if (nameMatches.length === 1) return { thread: nameMatches[0], threadId: nameMatches[0].threadId };
    return {};
  }

  renameBinding(binding: ChannelChat, name: string): void {
    const session = this.store.getSession(binding.bridgeSessionId);
    if (!session) throw new Error('Session not found.');
    this.store.updateSession(session.id, { name });
  }

  private resolveTitle(options: {
    sessionName?: string | null;
    sessionId?: string;
    threadId?: string;
    codexTitle?: string | null;
    fallback: string;
  }): string {
    return options.sessionName?.trim()
      || options.codexTitle?.trim()
      || options.fallback.trim()
      || '未命名线程';
  }
}

function formatResolvedThreadTitle(value: string, options: ThreadTitleOptions): string {
  const withoutLegacyPrefix = stripLegacySessionPrefix(value);
  const title = options.stripInternalPrefix ? stripInternalSessionPrefix(withoutLegacyPrefix) : withoutLegacyPrefix;
  return stripLegacySessionPrefix(title);
}

function codexSessionSource(session: CodexSessionSummary): CodexSourceSummary {
  return {
    originator: session.originator || undefined,
    source: session.source || undefined,
    cliVersion: session.cliVersion || undefined,
  };
}

function stripInternalSessionPrefix(value: string): string {
  return value.replace(/^(Bridge|Desktop):\s*/i, '').trim() || value;
}
