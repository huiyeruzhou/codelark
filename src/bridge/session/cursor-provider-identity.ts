import { createConfigService } from '../../configuration/service.js';
import { getCursorProviderCapabilities, type CursorProviderCapabilities } from '../../runtime/cursor/capabilities.js';
import type { BridgeStore } from '../../domain/audit.js';
import type { BridgeSession, CursorProviderChoice } from '../../domain/session.js';
import {
  getSessionActiveRuntime,
  getSessionCursorCwd,
  getSessionCursorSessionId,
} from '../../domain/session-runtime.js';
import {
  findCursorSessionFileById,
  type CursorSessionFileSummary,
} from '../../runtime/cursor/session-index.js';

type FindCursorThread = (sessionId: string, cwd?: string) => CursorSessionFileSummary | null;
type ReadSessionProviderOverride = (sessionId: string) => CursorProviderChoice | undefined;

function readSessionProviderOverride(sessionId: string): CursorProviderChoice | undefined {
  const resolved = createConfigService({ migrate: false }).resolve('runtime.cursor.provider', {
    kind: 'session',
    sessionId,
  });
  return resolved.source === 'session' && resolved.value === 'tmux' ? 'tmux' : undefined;
}

export function resolveCursorSourceProvider(
  session: BridgeSession | null | undefined,
  findThread: FindCursorThread = findCursorSessionFileById,
): CursorProviderChoice {
  if (getSessionActiveRuntime(session) !== 'cursor') return 'tmux';
  if (session?.runtime?.cursor?.provider === 'desktop') return 'desktop';
  const sessionId = getSessionCursorSessionId(session);
  if (!sessionId) return 'tmux';
  const cwd = getSessionCursorCwd(session);
  try {
    return findThread(sessionId, cwd)?.provider === 'desktop' ? 'desktop' : 'tmux';
  } catch {
    // Source discovery is best-effort. A persisted Desktop identity remains
    // authoritative, while a transient index read failure must not invent one.
    return 'tmux';
  }
}

export function resolveCursorExecutionProvider(
  session: BridgeSession | null | undefined,
  options: {
    findThread?: FindCursorThread;
    readSessionOverride?: ReadSessionProviderOverride;
  } = {},
): CursorProviderChoice {
  if (session?.id) {
    const override = (options.readSessionOverride || readSessionProviderOverride)(session.id);
    if (override === 'tmux') return 'tmux';
  }
  return resolveCursorSourceProvider(session, options.findThread);
}

/** Resolve from the execution route, including an explicit CLI override of a Desktop thread. */
export function resolveCursorCapabilities(
  session: BridgeSession | null | undefined,
  options: Parameters<typeof resolveCursorExecutionProvider>[1] = {},
): CursorProviderCapabilities {
  return getCursorProviderCapabilities(resolveCursorExecutionProvider(session, options));
}

export function upgradeCursorDesktopSessionIdentity(
  store: BridgeStore,
  session: BridgeSession,
  sourceProvider: CursorProviderChoice,
): BridgeSession {
  if (
    getSessionActiveRuntime(session) !== 'cursor'
    || sourceProvider !== 'desktop'
    || session.runtime?.cursor?.provider === 'desktop'
  ) {
    return session;
  }
  store.updateSession(session.id, { runtime: { cursor: { provider: 'desktop' } } }, { touch: false });
  return store.getSession(session.id) || session;
}

export function migrateCursorDesktopSessionIdentities(
  store: BridgeStore,
  findThread: FindCursorThread = findCursorSessionFileById,
): number {
  let migrated = 0;
  for (const session of store.listSessions()) {
    if (session.runtime?.cursor?.provider === 'desktop') continue;
    if (resolveCursorSourceProvider(session, findThread) !== 'desktop') continue;
    upgradeCursorDesktopSessionIdentity(store, session, 'desktop');
    migrated += 1;
  }
  return migrated;
}
