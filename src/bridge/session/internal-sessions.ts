import fs from 'node:fs';
import path from 'node:path';

import type { BridgeSession, BridgeStore } from '../../domain/index.js';
import { createConfigService } from '../../configuration/service.js';
import { getGlobalStringConfig, getGlobalWorkspaceRoot } from './global-config.js';

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

export function makeDraftSessionName(address: { channelType: string; chatId: string; userId?: string }): string {
  return userIdShortName(address.userId) || userIdShortName(address.chatId) || `ou_${address.chatId.slice(0, 6)}`;
}

function getDefaultSessionWorkingDirectory(store: BridgeStore): string {
  const dir = getGlobalWorkspaceRoot();
  ensureDirectory(dir);
  return dir;
}

function isHiddenTemporarySession(session: BridgeSession): boolean {
  return session.hidden === true && !session.runtime?.codex?.threadId && !session.runtime?.claude?.sessionId;
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
  );

  if (existing) {
    store.updateSession(existing.id, {
      expires_at: new Date(Date.now() + TEMPORARY_SESSION_TTL_MS).toISOString(),
    });
    return store.getSession(existing.id) || existing;
  }

  const workingDirectory = getDefaultSessionWorkingDirectory(store);
  const session = store.createSession(
    expectedName,
    getGlobalStringConfig('runtime.codex.model') || '',
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
  if (options?.activeRuntime !== 'claude') {
    createConfigService({ migrate: false }).set(
      { kind: 'session', sessionId: session.id },
      { runtime: { codex: { reasoningEffort: 'low' } } },
    );
  }
  return session;
}

export function resetDraftSession(
  store: BridgeStore,
  address: { channelType: string; chatId: string; userId?: string },
): BridgeSession {
  const expectedName = makeDraftSessionName(address);
  for (const session of store.listSessions()) {
    if (isHiddenTemporarySession(session) && session.name === expectedName) {
      store.deleteSession(session.id);
    }
  }
  return getOrCreateDraftSession(store, address);
}
