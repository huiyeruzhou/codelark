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
  getSessionCursorCwd,
  getSessionCursorSessionId,
  getSessionKimiCwd,
  getSessionKimiSessionId,
  getSessionZcodeCwd,
  getSessionZcodeSessionId,
  getSessionWorkingDirectory,
} from '../../../domain/session-runtime.js';
import {
  hasSessionCodexProviderOverride,
  resolveClaudeRuntimeConfig,
  resolveCursorRuntimeConfig,
  resolveEffectiveCodexProvider,
  resolveEffectiveRuntimeMode,
  resolveKimiRuntimeConfig,
  resolveZcodeRuntimeConfig,
} from '../support.js';

export interface SessionDisplaySummary {
  kind: 'bridge' | 'codex' | 'claude' | 'kimi' | 'cursor' | 'zcode';
  runtime: 'codex' | 'claude' | 'kimi' | 'cursor' | 'zcode';
  bridgeSessionId?: string;
  sessionId?: string;
  claudeSessionId?: string;
  claudeCwd?: string;
  kimiSessionId?: string;
  kimiCwd?: string;
  cursorSessionId?: string;
  cursorCwd?: string;
  zcodeSessionId?: string;
  zcodeCwd?: string;
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
  kimiPhysical?: number;
  cursorPhysical?: number;
  zcodePhysical?: number;
  bridgeClaudeLinked?: number;
  bridgeKimiLinked?: number;
  bridgeCursorLinked?: number;
  bridgeZcodeLinked?: number;
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
  return resolveEffectiveRuntimeMode(null, session);
}

export function bridgeSessionExecutionProvider(session: BridgeSession | null | undefined): string {
  const activeRuntime = getSessionActiveRuntime(session);
  if (activeRuntime === 'kimi') return resolveKimiRuntimeConfig(session).provider;
  if (activeRuntime === 'cursor') return resolveCursorRuntimeConfig(session).provider;
  if (activeRuntime === 'zcode') return resolveZcodeRuntimeConfig(session).provider;
  if (activeRuntime === 'claude') return resolveClaudeRuntimeConfig(session).provider;
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

export function findVisibleBridgeSessionByKimiSession(
  store: Pick<BridgeStore, 'listSessions'>,
  kimiSessionId: string,
  cwd?: string,
): BridgeSession | undefined {
  if (!kimiSessionId) return undefined;
  return store.listSessions().find((session) => (
    isVisibleBridgeSession(session)
    && getSessionActiveRuntime(session) === 'kimi'
    && getSessionKimiSessionId(session) === kimiSessionId
    && (!cwd || getSessionKimiCwd(session) === cwd || getSessionWorkingDirectory(session) === cwd)
  ));
}

export function findVisibleBridgeSessionByCursorSession(
  store: Pick<BridgeStore, 'listSessions'>,
  cursorSessionId: string,
  cwd?: string,
): BridgeSession | undefined {
  if (!cursorSessionId) return undefined;
  return store.listSessions().find((session) => (
    isVisibleBridgeSession(session)
    && getSessionActiveRuntime(session) === 'cursor'
    && getSessionCursorSessionId(session) === cursorSessionId
    && (!cwd || getSessionCursorCwd(session) === cwd || getSessionWorkingDirectory(session) === cwd)
  ));
}

export function findVisibleBridgeSessionByZcodeSession(
  store: Pick<BridgeStore, 'listSessions'>,
  zcodeSessionId: string,
  cwd?: string,
): BridgeSession | undefined {
  if (!zcodeSessionId) return undefined;
  return store.listSessions().find((session) => (
    isVisibleBridgeSession(session)
    && getSessionActiveRuntime(session) === 'zcode'
    && getSessionZcodeSessionId(session) === zcodeSessionId
    && (!cwd || getSessionZcodeCwd(session) === cwd || getSessionWorkingDirectory(session) === cwd)
  ));
}

export function buildBridgeSessionDisplaySummary(
  session: BridgeSession,
  linkedCodexSession?: CodexSessionSummary,
): SessionDisplaySummary {
  const codexThreadId = getBridgeSessionCodexThreadId(session);
  const activeRuntime = getSessionActiveRuntime(session);
  const sessionCodexTitle = getSessionCodexTitle(session);
  const title = getBridgeSessionDisplayTitleWithCodexFallback(session, sessionCodexTitle || linkedCodexSession?.title);
  const executionProvider = bridgeSessionExecutionProvider(session);
  const creatorBadge = formatCreatorBadge('bridge');
  const claudeSessionId = getSessionClaudeSessionId(session) || undefined;
  const kimiSessionId = getSessionKimiSessionId(session) || undefined;
  const cursorSessionId = getSessionCursorSessionId(session) || undefined;
  const zcodeSessionId = getSessionZcodeSessionId(session) || undefined;
  return {
    kind: 'bridge',
    runtime: activeRuntime === 'claude' ? 'claude' : activeRuntime === 'kimi' ? 'kimi' : activeRuntime === 'cursor' ? 'cursor' : activeRuntime === 'zcode' ? 'zcode' : 'codex',
    bridgeSessionId: session.id,
    sessionId: session.id,
    claudeSessionId,
    claudeCwd: getSessionClaudeCwd(session) || undefined,
    kimiSessionId,
    kimiCwd: getSessionKimiCwd(session) || undefined,
    cursorSessionId,
    cursorCwd: getSessionCursorCwd(session) || undefined,
    zcodeSessionId,
    zcodeCwd: getSessionZcodeCwd(session) || undefined,
    codexThreadId,
    threadId: codexThreadId || claudeSessionId || kimiSessionId || cursorSessionId || zcodeSessionId || '',
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

  const runtime = session.runtime === 'kimi' ? 'kimi' : session.runtime === 'cursor' ? 'cursor' : session.runtime === 'zcode' ? 'zcode' : 'claude';
  const title = linkedBridgeSession
    ? getBridgeSessionDisplayTitleWithCodexFallback(linkedBridgeSession, session.title)
    : session.title;
  const creatorBadge = formatCreatorBadge('tui_cli');
  return {
    kind: runtime,
    runtime,
    bridgeSessionId: linkedBridgeSession?.id,
    sessionId: linkedBridgeSession?.id,
    claudeSessionId: runtime === 'claude' ? session.threadId : undefined,
    claudeCwd: runtime === 'claude' ? session.cwd : undefined,
    kimiSessionId: runtime === 'kimi' ? session.threadId : undefined,
    kimiCwd: runtime === 'kimi' ? session.cwd : undefined,
    cursorSessionId: runtime === 'cursor' ? session.threadId : undefined,
    cursorCwd: runtime === 'cursor' ? session.cwd : undefined,
    zcodeSessionId: runtime === 'zcode' ? session.threadId : undefined,
    zcodeCwd: runtime === 'zcode' ? session.cwd : undefined,
    codexThreadId: '',
    threadId: session.threadId,
    displayTitle: title,
    title,
    codexTitle: '',
    cwd: session.cwd,
    mode: '-',
    executionProvider: runtime === 'kimi' || runtime === 'cursor' || runtime === 'zcode' ? 'tmux' : 'pty',
    codexProvider: runtime === 'kimi' || runtime === 'cursor' || runtime === 'zcode' ? 'tmux' : '-',
    creatorKind: 'tui_cli',
    creatorLabel: creatorBadge.label,
    creatorClass: creatorBadge.className,
    codexSource: {
      originator: session.originator || undefined,
      source: session.source || undefined,
      cliVersion: session.cliVersion || undefined,
    },
    originator: session.originator || (runtime === 'kimi' ? 'Kimi Code' : runtime === 'cursor' ? 'Cursor Agent' : runtime === 'zcode' ? 'ZCode' : 'Claude Code'),
    source: session.source || runtime,
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
        : session.runtime === 'kimi'
          ? findVisibleBridgeSessionByKimiSession(this.store, session.threadId, session.cwd)
          : session.runtime === 'cursor'
            ? findVisibleBridgeSessionByCursorSession(this.store, session.threadId, session.cwd)
            : session.runtime === 'zcode'
              ? findVisibleBridgeSessionByZcodeSession(this.store, session.threadId, session.cwd)
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
    const bridgeByKimiIdentity = new Map<string, BridgeSession>();
    const bridgeByCursorIdentity = new Map<string, BridgeSession>();
    const bridgeByZcodeIdentity = new Map<string, BridgeSession>();
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
      const kimiSessionId = getSessionKimiSessionId(session);
      const kimiCwd = getSessionKimiCwd(session) || getSessionWorkingDirectory(session);
      if (kimiSessionId && kimiCwd) {
        const key = `${kimiCwd}\0${kimiSessionId}`;
        if (!bridgeByKimiIdentity.has(key)) bridgeByKimiIdentity.set(key, session);
      }
      const cursorSessionId = getSessionCursorSessionId(session);
      const cursorCwd = getSessionCursorCwd(session) || getSessionWorkingDirectory(session);
      if (cursorSessionId && cursorCwd) {
        const key = `${cursorCwd}\0${cursorSessionId}`;
        if (!bridgeByCursorIdentity.has(key)) bridgeByCursorIdentity.set(key, session);
      }
      const zcodeSessionId = getSessionZcodeSessionId(session);
      const zcodeCwd = getSessionZcodeCwd(session) || getSessionWorkingDirectory(session);
      if (zcodeSessionId && zcodeCwd) {
        const key = `${zcodeCwd}\0${zcodeSessionId}`;
        if (!bridgeByZcodeIdentity.has(key)) bridgeByZcodeIdentity.set(key, session);
      }
    }

    let dedupedBridgeRows = 0;
    const seenCodexThreadIds = new Set<string>();
    const seenClaudeIdentities = new Set<string>();
    const seenKimiIdentities = new Set<string>();
    const seenCursorIdentities = new Set<string>();
    const seenZcodeIdentities = new Set<string>();
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
      const kimiSessionId = getSessionKimiSessionId(session);
      const kimiCwd = getSessionKimiCwd(session) || getSessionWorkingDirectory(session);
      if (kimiSessionId && kimiCwd) {
        const key = `${kimiCwd}\0${kimiSessionId}`;
        if (seenKimiIdentities.has(key)) {
          dedupedBridgeRows += 1;
          continue;
        }
        seenKimiIdentities.add(key);
      }
      const cursorSessionId = getSessionCursorSessionId(session);
      const cursorCwd = getSessionCursorCwd(session) || getSessionWorkingDirectory(session);
      if (cursorSessionId && cursorCwd) {
        const key = `${cursorCwd}\0${cursorSessionId}`;
        if (seenCursorIdentities.has(key)) {
          dedupedBridgeRows += 1;
          continue;
        }
        seenCursorIdentities.add(key);
      }
      const zcodeSessionId = getSessionZcodeSessionId(session);
      const zcodeCwd = getSessionZcodeCwd(session) || getSessionWorkingDirectory(session);
      if (zcodeSessionId && zcodeCwd) {
        const key = `${zcodeCwd}\0${zcodeSessionId}`;
        if (seenZcodeIdentities.has(key)) {
          dedupedBridgeRows += 1;
          continue;
        }
        seenZcodeIdentities.add(key);
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
        const identityKey = `${session.cwd}\0${session.threadId}`;
        const linked = session.runtime === 'kimi'
          ? bridgeByKimiIdentity.has(identityKey)
          : session.runtime === 'cursor'
            ? bridgeByCursorIdentity.has(identityKey)
            : session.runtime === 'zcode'
              ? bridgeByZcodeIdentity.has(identityKey)
            : bridgeByClaudeIdentity.has(identityKey);
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
    const kimiPhysical = localRuntimeSessions.filter((session) => session.runtime === 'kimi').length;
    const cursorPhysical = localRuntimeSessions.filter((session) => session.runtime === 'cursor').length;
    const zcodePhysical = localRuntimeSessions.filter((session) => session.runtime === 'zcode').length;
    const bridgeCodexLinked = bridgeRawSessions.filter((session) => Boolean(getBridgeSessionCodexThreadId(session))).length;
    const bridgeClaudeLinked = bridgeRawSessions.filter((session) => Boolean(getSessionClaudeSessionId(session))).length;
    const bridgeKimiLinked = bridgeRawSessions.filter((session) => Boolean(getSessionKimiSessionId(session))).length;
    const bridgeCursorLinked = bridgeRawSessions.filter((session) => Boolean(getSessionCursorSessionId(session))).length;
    const bridgeZcodeLinked = bridgeRawSessions.filter((session) => Boolean(getSessionZcodeSessionId(session))).length;

    return {
      root: options.root,
      sessions,
      counts: {
        codexPhysical,
        claudePhysical,
        kimiPhysical,
        cursorPhysical,
        zcodePhysical,
        bridgeStored: bridgeRawSessions.length,
        bridgeWithoutCodexThread,
        bridgeCodexLinked,
        bridgeClaudeLinked,
        bridgeKimiLinked,
        bridgeCursorLinked,
        bridgeZcodeLinked,
        dedupedBridgeRows,
        totalDisplayable: combined.length,
        displayed: sessions.length,
      },
    };
  }
}
