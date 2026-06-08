import fs from 'node:fs';
import path from 'node:path';

import { DEFAULT_WORKSPACE_ROOT } from '../../configuration/index.js';
import type { BridgeSession, BridgeStore } from '../../domain/index.js';
import { setSessionCodexModeUpdate } from '../../domain/session-runtime.js';

const TEMPORARY_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_HIDDEN_TEMPORARY_SESSIONS = 64;

function ensureDirectory(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function isSessionExpired(session: BridgeSession | null | undefined): boolean {
  if (!session?.expires_at) return false;
  const expiresAt = Date.parse(session.expires_at);
  return Number.isFinite(expiresAt) && expiresAt <= Date.now();
}

function userIdShortName(userId: string | undefined): string | null {
  const trimmed = userId?.trim();
  if (!trimmed) return null;
  const body = trimmed.startsWith('ou_') ? trimmed.slice(3) : trimmed;
  const normalized = body.replace(/[^a-zA-Z0-9]/g, '');
  return normalized ? `ou_${normalized.slice(0, 6)}` : null;
}

function chatIdShortName(chatId: string | undefined): string | null {
  const trimmed = chatId?.trim();
  if (!trimmed) return null;
  const body = trimmed.startsWith('oc_') ? trimmed.slice(3) : trimmed;
  const normalized = body.replace(/[^a-zA-Z0-9]/g, '');
  return normalized ? `oc_${normalized.slice(0, 12)}` : null;
}

export function makeDraftSessionName(address: { channelType: string; chatId: string; chatKind?: string; userId?: string }): string {
  if (address.chatKind === 'group') {
    return chatIdShortName(address.chatId) || userIdShortName(address.userId) || `oc_${address.chatId.slice(0, 12)}`;
  }
  return userIdShortName(address.userId) || chatIdShortName(address.chatId) || `oc_${address.chatId.slice(0, 12)}`;
}

function getDefaultSessionWorkingDirectory(store: BridgeStore): string {
  const dir = store.getSetting('bridge_default_workspace_root') || DEFAULT_WORKSPACE_ROOT;
  ensureDirectory(dir);
  return dir;
}

function isHiddenTemporarySession(session: BridgeSession): boolean {
  return session.hidden === true && !session.runtime?.codex?.threadId && !session.runtime?.claude?.sessionId;
}

function sessionHasBindingOutsideAddress(
  store: BridgeStore,
  sessionId: string,
  address: { channelType: string; chatId: string },
): boolean {
  return store.listChannelChats().some((binding) =>
    binding.bridgeSessionId === sessionId
    && (binding.channelType !== address.channelType || binding.chatId !== address.chatId)
  );
}

export function cleanupHiddenSessions(store: BridgeStore): void {
  const bindings = store.listChannelChats();
  const boundSessionIds = new Set(bindings.map((binding) => binding.bridgeSessionId));
  const hiddenSessions = store.listSessions().filter((session) => session.hidden === true);

  for (const session of hiddenSessions) {
    if (isSessionExpired(session) && !boundSessionIds.has(session.id)) {
      store.deleteSession(session.id);
    }
  }

  const temporarySessions = store.listSessions()
    .filter((session) => isHiddenTemporarySession(session) && !boundSessionIds.has(session.id))
    .sort((a, b) => Date.parse(b.updated_at || b.created_at || '') - Date.parse(a.updated_at || a.created_at || ''));

  for (const session of temporarySessions.slice(MAX_HIDDEN_TEMPORARY_SESSIONS)) {
    store.deleteSession(session.id);
  }
}

export function getOrCreateDraftSession(
  store: BridgeStore,
  address: { channelType: string; chatId: string; userId?: string },
  options?: { activeRuntime?: 'codex' | 'claude' },
): BridgeSession {
  cleanupHiddenSessions(store);
  const expectedName = makeDraftSessionName(address);
  const existing = store.listSessions().find((session) =>
    session.hidden === true
    && session.session_type !== 'draft'
    && session.name === expectedName
    && !isSessionExpired(session)
    && !sessionHasBindingOutsideAddress(store, session.id, address)
  );

  if (existing) {
    store.updateSession(existing.id, {
      ...setSessionCodexModeUpdate('normal'),
      expires_at: new Date(Date.now() + TEMPORARY_SESSION_TTL_MS).toISOString(),
    });
    return store.getSession(existing.id) || existing;
  }

  const workingDirectory = getDefaultSessionWorkingDirectory(store);
  return store.createSession(
    expectedName,
    store.getSetting('bridge_default_model') || '',
    undefined,
    workingDirectory,
    'normal',
    {
      hidden: true,
      sessionType: 'normal',
      expiresAt: new Date(Date.now() + TEMPORARY_SESSION_TTL_MS).toISOString(),
      reasoningEffort: 'low',
      activeRuntime: options?.activeRuntime,
    },
  );
}

export function resetDraftSession(
  store: BridgeStore,
  address: { channelType: string; chatId: string; userId?: string },
): BridgeSession {
  const expectedName = makeDraftSessionName(address);
  for (const session of store.listSessions()) {
    if (
      isHiddenTemporarySession(session)
      && session.name === expectedName
      && !sessionHasBindingOutsideAddress(store, session.id, address)
    ) {
      store.deleteSession(session.id);
    }
  }
  return getOrCreateDraftSession(store, address);
}
