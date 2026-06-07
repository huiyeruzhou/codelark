import type { CodexSessionSummary } from '../../../runtime/codex/session-index.js';
import type { LocalRuntimeSessionSummary } from '../local-runtime-session.js';
import { stripLegacySessionPrefix } from './session-title.js';
import type { BridgeStore } from '../../../domain/audit.js';
import type { BridgeSession } from '../../../domain/session.js';
import {
  formatCreatorBadge,
  resolveCreatorKind,
  type CodexSourceSummary,
  type CreatorKind,
} from './session-creator.js';
import type { ChannelChat } from '../../../domain/channel.js';
import {
  getSessionCodexThreadId,
  getSessionCodexTitle,
  getSessionClaudeCwd,
  getSessionClaudeSessionId,
  getSessionActiveRuntime,
  getSessionWorkingDirectory,
} from '../../../domain/session-runtime.js';
import {
  hasSessionCodexProviderOverride,
  resolveEffectiveCodexProvider,
  resolveEffectiveMode,
} from '../support.js';

export interface SessionDisplaySummary {
  kind: 'bridge' | 'codex' | 'claude';
  runtime: 'codex' | 'claude';
  bridgeSessionId?: string;
  sessionId?: string;
  claudeSessionId?: string;
  claudeCwd?: string;
  codexThreadId: string;
  threadId: string;
  displayTitle: string;
  title: string;
  codexTitle: string;
  cwd: string;
  mode: string;
  executionProvider: string;
  codexProvider: string;
  creatorKind: CreatorKind;
  creatorLabel: string;
  creatorClass: string;
  codexSource?: CodexSourceSummary;
  originator: string;
  source: string;
  lastEventAt: string;
}

export interface SessionDisplayCounts {
  codexPhysical: number;
  bridgeStored: number;
  bridgeWithoutCodexThread: number;
  bridgeCodexLinked: number;
  dedupedBridgeRows: number;
  totalDisplayable: number;
  displayed: number;
  claudePhysical?: number;
  bridgeClaudeLinked?: number;
}

export interface SessionDisplayListPayload {
  root: string;
  sessions: SessionDisplaySummary[];
  counts: SessionDisplayCounts;
}

export interface BindingDisplaySummary {
  bindingId: string;
  bridgeSessionId: string;
  codexThreadId: string;
  displayTitle: string;
  codexTitle: string;
  cwd: string;
  executionProvider: string;
  creatorKind: CreatorKind;
  codexSource?: CodexSourceSummary;
}

export function getBridgeSessionCodexThreadId(session: Pick<BridgeSession, 'runtime'>): string {
  return getSessionCodexThreadId(session) || '';
}

export function isVisibleBridgeSession(session: BridgeSession): boolean {
  return session.hidden !== true && session.session_type !== 'draft';
}

export function getBridgeSessionDisplayTitle(session: BridgeSession): string {
  if (session.name?.trim()) return stripLegacySessionPrefix(session.name);
  const codexTitle = getSessionCodexTitle(session);
  if (codexTitle) return stripLegacySessionPrefix(codexTitle);
  const workingDirectory = getSessionWorkingDirectory(session);
  if (workingDirectory) {
    const parts = workingDirectory.split(/[\\/]+/).filter(Boolean);
    return parts[parts.length - 1] || session.id.slice(0, 8);
  }
  return session.id.slice(0, 8);
}

function getBridgeSessionDisplayTitleWithCodexFallback(session: BridgeSession, codexTitle?: string): string {
  if (session.name?.trim()) return getBridgeSessionDisplayTitle(session);
  if (codexTitle?.trim()) return stripLegacySessionPrefix(codexTitle);
  return getBridgeSessionDisplayTitle(session);
}

export function bridgeSessionMode(session: BridgeSession | null | undefined): string {
  return resolveEffectiveMode(null, session);
}

export function bridgeSessionExecutionProvider(session: BridgeSession | null | undefined): string {
  return hasSessionCodexProviderOverride(session) ? resolveEffectiveCodexProvider(session) : 'default';
}

export function findVisibleBridgeSessionByCodexThread(
  store: Pick<BridgeStore, 'listSessions'>,
  codexThreadId: string,
): BridgeSession | undefined {
  if (!codexThreadId) return undefined;
  return store.listSessions().find((session) => (
    isVisibleBridgeSession(session)
    && getBridgeSessionCodexThreadId(session) === codexThreadId
  ));
}

export function findVisibleBridgeSessionByClaudeSession(
  store: Pick<BridgeStore, 'listSessions'>,
  claudeSessionId: string,
  cwd?: string,
): BridgeSession | undefined {
  if (!claudeSessionId) return undefined;
  return store.listSessions().find((session) => (
    isVisibleBridgeSession(session)
    && getSessionActiveRuntime(session) === 'claude'
    && getSessionClaudeSessionId(session) === claudeSessionId
    && (!cwd || getSessionClaudeCwd(session) === cwd || getSessionWorkingDirectory(session) === cwd)
  ));
}

export function buildBridgeSessionDisplaySummary(
  session: BridgeSession,
  linkedCodexSession?: CodexSessionSummary,
): SessionDisplaySummary {
  const codexThreadId = getBridgeSessionCodexThreadId(session);
  const sessionCodexTitle = getSessionCodexTitle(session);
  const title = getBridgeSessionDisplayTitleWithCodexFallback(session, sessionCodexTitle || linkedCodexSession?.title);
  const executionProvider = bridgeSessionExecutionProvider(session);
  const creatorBadge = formatCreatorBadge('bridge');
  return {
    kind: 'bridge',
    runtime: getSessionActiveRuntime(session) === 'claude' ? 'claude' : 'codex',
    bridgeSessionId: session.id,
    sessionId: session.id,
    claudeSessionId: getSessionClaudeSessionId(session) || undefined,
    claudeCwd: getSessionClaudeCwd(session) || undefined,
    codexThreadId,
    threadId: codexThreadId || getSessionClaudeSessionId(session) || '',
    displayTitle: title,
    title,
    codexTitle: sessionCodexTitle || linkedCodexSession?.title || '',
    cwd: getSessionWorkingDirectory(session) || linkedCodexSession?.cwd || '',
    mode: bridgeSessionMode(session),
    executionProvider,
    codexProvider: executionProvider,
    creatorKind: 'bridge',
    creatorLabel: creatorBadge.label,
    creatorClass: creatorBadge.className,
    originator: 'Bridge / IM',
    source: 'bridge',
    lastEventAt: session.updated_at || session.last_progress_at || linkedCodexSession?.lastEventAt || session.created_at || '',
  };
}

export function buildCodexThreadDisplaySummary(
  session: CodexSessionSummary,
  linkedBridgeSession?: BridgeSession,
): SessionDisplaySummary {
  const linkedCodexTitle = getSessionCodexTitle(linkedBridgeSession);
  const title = linkedBridgeSession
    ? getBridgeSessionDisplayTitleWithCodexFallback(linkedBridgeSession, linkedCodexTitle || session.title)
    : session.title;
  const codexSource: CodexSourceSummary = {
    originator: session.originator || undefined,
    source: session.source || undefined,
    cliVersion: session.cliVersion || undefined,
  };
  const executionProvider = linkedBridgeSession ? bridgeSessionExecutionProvider(linkedBridgeSession) : 'unknown';
  const creatorKind = resolveCreatorKind(codexSource);
  const creatorBadge = formatCreatorBadge(creatorKind);
  return {
    kind: 'codex',
    runtime: 'codex',
    bridgeSessionId: linkedBridgeSession?.id,
    sessionId: linkedBridgeSession?.id,
    codexThreadId: session.threadId,
    threadId: session.threadId,
    displayTitle: title,
    title,
    codexTitle: linkedCodexTitle || session.title || '',
    cwd: session.cwd,
    mode: linkedBridgeSession ? bridgeSessionMode(linkedBridgeSession) : '-',
    executionProvider,
    codexProvider: linkedBridgeSession ? executionProvider : '-',
    creatorKind,
    creatorLabel: creatorBadge.label,
    creatorClass: creatorBadge.className,
    codexSource,
    originator: session.originator || 'Codex Native',
    source: session.source || 'codex',
    lastEventAt: session.lastEventAt,
  };
}

export function buildLocalRuntimeSessionDisplaySummary(
  session: LocalRuntimeSessionSummary,
  linkedBridgeSession?: BridgeSession,
): SessionDisplaySummary {
  if (session.runtime === 'codex') {
    return buildCodexThreadDisplaySummary({
      threadId: session.threadId,
      filePath: session.filePath,
      cwd: session.cwd,
      originator: session.originator,
      source: session.source,
      cliVersion: session.cliVersion,
      firstSeenAt: session.firstSeenAt,
      lastEventAt: session.lastEventAt,
      title: session.title,
      activeEstimate: session.activeEstimate,
    }, linkedBridgeSession);
  }

  const title = linkedBridgeSession
    ? getBridgeSessionDisplayTitleWithCodexFallback(linkedBridgeSession, session.title)
    : session.title;
  const creatorBadge = formatCreatorBadge('tui_cli');
  return {
    kind: 'claude',
    runtime: 'claude',
    bridgeSessionId: linkedBridgeSession?.id,
    sessionId: linkedBridgeSession?.id,
    claudeSessionId: session.threadId,
    claudeCwd: session.cwd,
    codexThreadId: '',
    threadId: session.threadId,
    displayTitle: title,
    title,
    codexTitle: '',
    cwd: session.cwd,
    mode: '-',
    executionProvider: 'pty',
    codexProvider: '-',
    creatorKind: 'tui_cli',
    creatorLabel: creatorBadge.label,
    creatorClass: creatorBadge.className,
    codexSource: {
      originator: session.originator || undefined,
      source: session.source || undefined,
      cliVersion: session.cliVersion || undefined,
    },
    originator: session.originator || 'Claude Code',
    source: session.source || 'claude',
    lastEventAt: session.lastEventAt,
  };
}

export function buildBindingDisplaySummary(
  store: Pick<BridgeStore, 'getSession'>,
  binding: ChannelChat,
): BindingDisplaySummary {
  const session = store.getSession(binding.bridgeSessionId);
  const codexThreadId = session ? getBridgeSessionCodexThreadId(session) : '';
  const displayTitle = session
    ? getBridgeSessionDisplayTitle(session)
    : binding.bridgeSessionId.slice(0, 8);
  return {
    bindingId: binding.id,
    bridgeSessionId: binding.bridgeSessionId,
    codexThreadId,
    displayTitle,
    codexTitle: getSessionCodexTitle(session) || '',
    cwd: getSessionWorkingDirectory(session) || '',
    executionProvider: bridgeSessionExecutionProvider(session),
    creatorKind: session ? 'bridge' : 'native',
  };
}

export class SessionDisplayQuery {
  constructor(private readonly store: BridgeStore) {}

  bridgeSession(session: BridgeSession): SessionDisplaySummary {
    return buildBridgeSessionDisplaySummary(session);
  }

  codexThread(session: CodexSessionSummary): SessionDisplaySummary {
    return buildCodexThreadDisplaySummary(
      session,
      findVisibleBridgeSessionByCodexThread(this.store, session.threadId),
    );
  }

  localRuntimeSession(session: LocalRuntimeSessionSummary): SessionDisplaySummary {
    return buildLocalRuntimeSessionDisplaySummary(
      session,
      session.runtime === 'codex'
        ? findVisibleBridgeSessionByCodexThread(this.store, session.threadId)
        : findVisibleBridgeSessionByClaudeSession(this.store, session.threadId, session.cwd),
    );
  }

  binding(binding: ChannelChat): BindingDisplaySummary {
    return buildBindingDisplaySummary(this.store, binding);
  }

  listSessions(
    codexRawSessions: CodexSessionSummary[],
    options: { root: string; limit?: number },
  ): SessionDisplayListPayload {
    const codexByThreadId = new Map(codexRawSessions.map((session) => [session.threadId, session]));
    const bridgeRawSessions = this.store.listSessions()
      .filter(isVisibleBridgeSession)
      .sort((left, right) => (
        (right.updated_at || right.created_at || '').localeCompare(left.updated_at || left.created_at || '')
      ));
    const bridgeByCodexThreadId = new Map<string, BridgeSession>();
    for (const session of bridgeRawSessions) {
      const threadId = getBridgeSessionCodexThreadId(session);
      if (threadId && !bridgeByCodexThreadId.has(threadId)) {
        bridgeByCodexThreadId.set(threadId, session);
      }
    }

    let dedupedBridgeRows = 0;
    const seenThreadIds = new Set<string>();
    const bridgeSessions: SessionDisplaySummary[] = [];
    for (const session of bridgeRawSessions) {
      const threadId = getBridgeSessionCodexThreadId(session);
      if (threadId) {
        if (seenThreadIds.has(threadId)) {
          dedupedBridgeRows += 1;
          continue;
        }
        seenThreadIds.add(threadId);
      }
      bridgeSessions.push(buildBridgeSessionDisplaySummary(session, threadId ? codexByThreadId.get(threadId) : undefined));
    }

    const codexSessions = codexRawSessions
      .filter((session) => {
        const hasLinkedBridgeSession = bridgeByCodexThreadId.has(session.threadId);
        if (hasLinkedBridgeSession) dedupedBridgeRows += 1;
        return !hasLinkedBridgeSession;
      })
      .map((session) => buildCodexThreadDisplaySummary(session));

    const combined = [...bridgeSessions, ...codexSessions]
      .sort((left, right) => (right.lastEventAt || '').localeCompare(left.lastEventAt || ''));

    const sessions = typeof options.limit === 'number' && Number.isFinite(options.limit) && options.limit > 0
      ? combined.slice(0, Math.floor(options.limit))
      : combined;

    const bridgeWithoutCodexThread = bridgeRawSessions
      .filter((session) => !getBridgeSessionCodexThreadId(session))
      .length;

    return {
      root: options.root,
      sessions,
      counts: {
        codexPhysical: codexRawSessions.length,
        bridgeStored: bridgeRawSessions.length,
        bridgeWithoutCodexThread,
        bridgeCodexLinked: bridgeRawSessions.length - bridgeWithoutCodexThread,
        dedupedBridgeRows,
        totalDisplayable: combined.length,
        displayed: sessions.length,
      },
    };
  }

  listRuntimeSessions(
    localRuntimeSessions: LocalRuntimeSessionSummary[],
    options: { root: string; limit?: number },
  ): SessionDisplayListPayload {
    const codexByThreadId = new Map(
      localRuntimeSessions
        .filter((session) => session.runtime === 'codex')
        .map((session) => [session.threadId, session]),
    );
    const claudeByIdentity = new Map(
      localRuntimeSessions
        .filter((session) => session.runtime === 'claude')
        .map((session) => [`${session.cwd}\0${session.threadId}`, session]),
    );
    const bridgeRawSessions = this.store.listSessions()
      .filter(isVisibleBridgeSession)
      .sort((left, right) => (
        (right.updated_at || right.created_at || '').localeCompare(left.updated_at || left.created_at || '')
      ));
    const bridgeByCodexThreadId = new Map<string, BridgeSession>();
    const bridgeByClaudeIdentity = new Map<string, BridgeSession>();
    for (const session of bridgeRawSessions) {
      const codexThreadId = getBridgeSessionCodexThreadId(session);
      if (codexThreadId && !bridgeByCodexThreadId.has(codexThreadId)) {
        bridgeByCodexThreadId.set(codexThreadId, session);
      }
      const claudeSessionId = getSessionClaudeSessionId(session);
      const claudeCwd = getSessionClaudeCwd(session) || getSessionWorkingDirectory(session);
      if (claudeSessionId && claudeCwd) {
        const key = `${claudeCwd}\0${claudeSessionId}`;
        if (!bridgeByClaudeIdentity.has(key)) bridgeByClaudeIdentity.set(key, session);
      }
    }

    let dedupedBridgeRows = 0;
    const seenCodexThreadIds = new Set<string>();
    const seenClaudeIdentities = new Set<string>();
    const bridgeSessions: SessionDisplaySummary[] = [];
    for (const session of bridgeRawSessions) {
      const codexThreadId = getBridgeSessionCodexThreadId(session);
      if (codexThreadId) {
        if (seenCodexThreadIds.has(codexThreadId)) {
          dedupedBridgeRows += 1;
          continue;
        }
        seenCodexThreadIds.add(codexThreadId);
      }
      const claudeSessionId = getSessionClaudeSessionId(session);
      const claudeCwd = getSessionClaudeCwd(session) || getSessionWorkingDirectory(session);
      if (claudeSessionId && claudeCwd) {
        const key = `${claudeCwd}\0${claudeSessionId}`;
        if (seenClaudeIdentities.has(key)) {
          dedupedBridgeRows += 1;
          continue;
        }
        seenClaudeIdentities.add(key);
      }
      const linkedCodex = codexThreadId ? codexByThreadId.get(codexThreadId) : undefined;
      bridgeSessions.push(buildBridgeSessionDisplaySummary(session, linkedCodex as CodexSessionSummary | undefined));
    }

    const nativeSessions = localRuntimeSessions
      .filter((session) => {
        if (session.runtime === 'codex') {
          const linked = bridgeByCodexThreadId.has(session.threadId);
          if (linked) dedupedBridgeRows += 1;
          return !linked;
        }
        const linked = bridgeByClaudeIdentity.has(`${session.cwd}\0${session.threadId}`);
        if (linked) dedupedBridgeRows += 1;
        return !linked;
      })
      .map((session) => buildLocalRuntimeSessionDisplaySummary(session));

    const combined = [...bridgeSessions, ...nativeSessions]
      .sort((left, right) => (right.lastEventAt || '').localeCompare(left.lastEventAt || ''));

    const sessions = typeof options.limit === 'number' && Number.isFinite(options.limit) && options.limit > 0
      ? combined.slice(0, Math.floor(options.limit))
      : combined;

    const bridgeWithoutCodexThread = bridgeRawSessions
      .filter((session) => !getBridgeSessionCodexThreadId(session))
      .length;
    const codexPhysical = localRuntimeSessions.filter((session) => session.runtime === 'codex').length;
    const claudePhysical = localRuntimeSessions.filter((session) => session.runtime === 'claude').length;
    const bridgeClaudeLinked = bridgeRawSessions.filter((session) => Boolean(getSessionClaudeSessionId(session))).length;

    return {
      root: options.root,
      sessions,
      counts: {
        codexPhysical,
        claudePhysical,
        bridgeStored: bridgeRawSessions.length,
        bridgeWithoutCodexThread,
        bridgeCodexLinked: bridgeRawSessions.length - bridgeWithoutCodexThread,
        bridgeClaudeLinked,
        dedupedBridgeRows,
        totalDisplayable: combined.length,
        displayed: sessions.length,
      },
    };
  }
}
