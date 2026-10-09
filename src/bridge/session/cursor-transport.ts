import { getCursorCapabilities, type CursorCapabilities } from '../../runtime/cursor/capabilities.js';
import type { BridgeStore } from '../../domain/audit.js';
import type { BridgeSession, CursorTransport } from '../../domain/session.js';
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
export function resolveCursorTransport(
  session: BridgeSession | null | undefined,
  findThread: FindCursorThread = findCursorSessionFileById,
): CursorTransport {
  if (getSessionActiveRuntime(session) !== 'cursor') return 'cli';
  if (session?.runtime?.cursor?.transport === 'desktop' || session?.runtime?.cursor?.provider === 'desktop') return 'desktop';
  const sessionId = getSessionCursorSessionId(session);
  if (!sessionId) return 'cli';
  const cwd = getSessionCursorCwd(session);
  try {
    return findThread(sessionId, cwd)?.transport === 'desktop' ? 'desktop' : 'cli';
  } catch {
    // Source discovery is best-effort. A persisted Desktop identity remains
    // authoritative, while a transient index read failure must not invent one.
    return 'cli';
  }
}

/** Model capabilities follow the bound conversation; provider configuration never changes its transport. */
export function resolveCursorCapabilities(
  session: BridgeSession | null | undefined,
  findThread: FindCursorThread = findCursorSessionFileById,
): CursorCapabilities {
  return getCursorCapabilities(resolveCursorTransport(session, findThread));
}

export function upgradeCursorDesktopSessionIdentity(
  store: BridgeStore,
  session: BridgeSession,
  transport: CursorTransport,
): BridgeSession {
  if (
    getSessionActiveRuntime(session) !== 'cursor'
    || transport !== 'desktop'
    || (session.runtime?.cursor?.transport === 'desktop' && session.runtime.cursor.provider === 'tmux')
  ) {
    return session;
  }
  store.updateSession(session.id, { runtime: { cursor: { provider: 'tmux', transport: 'desktop' } } }, { touch: false });
  return store.getSession(session.id) || session;
}

export function migrateCursorDesktopSessionIdentities(
  store: BridgeStore,
  findThread: FindCursorThread = findCursorSessionFileById,
): number {
  let migrated = 0;
  for (const session of store.listSessions()) {
    if (session.runtime?.cursor?.transport === 'desktop' && session.runtime.cursor.provider === 'tmux') continue;
    if (resolveCursorTransport(session, findThread) !== 'desktop') continue;
    upgradeCursorDesktopSessionIdentity(store, session, 'desktop');
    migrated += 1;
  }
  return migrated;
}
