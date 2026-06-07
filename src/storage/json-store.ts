/**
 * JSON file-backed BridgeStore implementation.
 *
 * Uses in-memory Maps as cache with write-through persistence
 * to JSON files in ~/.codelark/data/.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type {
  BridgeStore,
  AuditLogInput,
  OutboundRefInput,
  UpsertChannelChatInput,
  UpsertChannelDefaultTargetInput,
} from '../domain/audit.js';
import type { ChannelChat, ChannelDefaultTarget, ChannelType } from '../domain/channel.js';
import type { BridgeMessage } from '../domain/message.js';
import type { PermissionLinkInput, PermissionLinkRecord } from '../domain/permission.js';
import type {
  BridgeSession,
  CodexReasoningEffort,
  BridgeSessionRuntimeState,
  BridgeSessionUpdate,
} from '../domain/session.js';
import type { BridgeApiProvider } from '../runtime/contracts.js';
import {
  defaultAliasForChannelProvider,
  getConfiguredChannelInstance,
} from '../configuration/channel-instances.js';
import { CODELARK_HOME } from '../configuration/paths.js';
import { loadRuntimeSettings } from '../configuration/runtime-settings-projection.js';
import { setSessionConfigPatch } from '../configuration/session-writes.js';
import { runStartupStorageMigrations } from './migrations.js';
import {
  getSessionActiveRuntime,
  getSessionClaudeSessionId,
  getSessionCodexThreadId,
  materializeBridgeSessionRuntime,
  setSessionCodexThreadIdUpdate,
} from '../domain/session-runtime.js';

const DATA_DIR = path.join(CODELARK_HOME, 'data');
const MESSAGES_DIR = path.join(DATA_DIR, 'messages');
const CHANNEL_CHATS_PATH = path.join(DATA_DIR, 'channel-chats.json');
const CHANNEL_DEFAULT_TARGETS_PATH = path.join(DATA_DIR, 'channel-default-targets.json');
const AUDIT_JSON_PATH = path.join(DATA_DIR, 'audit.json');
const AUDIT_JSONL_PATH = path.join(DATA_DIR, 'audit.jsonl');

// ── Helpers ──

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function atomicWrite(filePath: string, data: string): void {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, data, 'utf-8');
  fs.renameSync(tmp, filePath);
}

function readJson<T>(filePath: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson(filePath: string, data: unknown): void {
  atomicWrite(filePath, JSON.stringify(data, null, 2));
}

function appendJsonl(filePath: string, record: unknown): void {
  fs.appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf-8');
}

function readJsonl<T>(filePath: string): T[] {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }
  const rows: T[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as T);
    } catch {
      // Ignore malformed trailing/partial lines; later appends remain readable.
    }
  }
  return rows;
}

function uuid(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

function normalizeChatKind(value: unknown): ChannelChat['chatKind'] | undefined {
  return value === 'p2p' || value === 'group' ? value : undefined;
}

function bindingChatKey(binding: Pick<ChannelChat, 'channelType' | 'chatId'>): string {
  return `${binding.channelType}:${binding.chatId}`;
}

function compareBindingUpdatedAtDesc(a: ChannelChat, b: ChannelChat): number {
  const aTime = Date.parse(a.updatedAt || a.createdAt || '');
  const bTime = Date.parse(b.updatedAt || b.createdAt || '');
  return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
}

function normalizeRuntimeBridgeSessionIds(value: unknown): ChannelChat['runtimeBridgeSessionIds'] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as { codex?: unknown; claude?: unknown };
  const normalized: NonNullable<ChannelChat['runtimeBridgeSessionIds']> = {};
  if (typeof raw.codex === 'string' && raw.codex.trim()) normalized.codex = raw.codex.trim();
  if (typeof raw.claude === 'string' && raw.claude.trim()) normalized.claude = raw.claude.trim();
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function sameRuntimeBridgeSessionIds(
  left: ChannelChat['runtimeBridgeSessionIds'],
  right: ChannelChat['runtimeBridgeSessionIds'],
): boolean {
  return (left?.codex || '') === (right?.codex || '')
    && (left?.claude || '') === (right?.claude || '');
}

function mergeSessionRuntime(
  sessionRuntime: BridgeSession['runtime'],
  updatesRuntime: BridgeSessionUpdate['runtime'],
): BridgeSessionRuntimeState | undefined {
  if (!updatesRuntime) return sessionRuntime;
  const targetRuntime = updatesRuntime.activeRuntime === 'claude'
    ? 'claude'
    : updatesRuntime.activeRuntime === 'codex'
      ? 'codex'
      : sessionRuntime?.activeRuntime === 'claude'
        ? 'claude'
        : 'codex';
  const general = updatesRuntime.general
    ? { ...sessionRuntime?.general, ...updatesRuntime.general }
    : sessionRuntime?.general;
  if (targetRuntime === 'claude') {
    return {
      activeRuntime: 'claude',
      claude: updatesRuntime.claude
        ? { ...(sessionRuntime?.activeRuntime === 'claude' ? sessionRuntime.claude : undefined), ...updatesRuntime.claude }
        : sessionRuntime?.activeRuntime === 'claude'
          ? sessionRuntime.claude
          : undefined,
      ...(general ? { general } : {}),
    };
  }
  return {
    ...(updatesRuntime.activeRuntime === 'codex' || sessionRuntime?.activeRuntime === 'codex' ? { activeRuntime: 'codex' as const } : {}),
    codex: updatesRuntime.codex
      ? { ...(sessionRuntime?.activeRuntime === 'claude' ? undefined : sessionRuntime?.codex), ...updatesRuntime.codex }
      : sessionRuntime?.activeRuntime === 'claude'
        ? undefined
        : sessionRuntime?.codex,
    ...(general ? { general } : {}),
  };
}

function normalizeChannelDefaultTarget(target: ChannelDefaultTarget): ChannelDefaultTarget {
  let instance: { provider?: string; alias?: string } | undefined;
  try {
    instance = getConfiguredChannelInstance(target.channelType) || undefined;
  } catch {
    instance = undefined;
  }
  const channelProvider = instance?.provider || target.channelProvider;
  const channelAlias = instance?.alias || target.channelAlias || defaultAliasForChannelProvider(channelProvider);

  return {
    ...target,
    channelProvider,
    channelAlias,
  };
}

function didChannelDefaultTargetChange(before: ChannelDefaultTarget, after: ChannelDefaultTarget): boolean {
  return before.channelProvider !== after.channelProvider
    || before.channelAlias !== after.channelAlias;
}

function messageJsonPath(sessionId: string): string {
  return path.join(MESSAGES_DIR, `${sessionId}.json`);
}

function messageJsonlPath(sessionId: string): string {
  return path.join(MESSAGES_DIR, `${sessionId}.jsonl`);
}

// ── Lock entry ──

interface LockEntry {
  lockId: string;
  owner: string;
  expiresAt: number;
}

// ── Store ──

export class JsonFileStore implements BridgeStore {
  private settings: Map<string, string>;
  private dynamicSettings: boolean;
  private sessions = new Map<string, BridgeSession>();
  private bindings = new Map<string, ChannelChat>();
  private channelDefaultTargets = new Map<string, ChannelDefaultTarget>();
  private messages = new Map<string, BridgeMessage[]>();
  private permissionLinks = new Map<string, PermissionLinkRecord>();
  private offsets = new Map<string, string>();
  private dedupKeys = new Map<string, number>();
  private locks = new Map<string, LockEntry>();
  private auditLog: Array<AuditLogInput & { id: string; createdAt: string }> = [];

  constructor(
    settingsMap: Map<string, string>,
    options?: { dynamicSettings?: boolean },
  ) {
    this.settings = settingsMap;
    this.dynamicSettings = options?.dynamicSettings === true;
    ensureDir(DATA_DIR);
    ensureDir(MESSAGES_DIR);
    runStartupStorageMigrations({ logger: false });
    this.loadAll();
  }

  // ── Persistence ──

  private loadAll(): void {
    this.reloadSessions();
    this.reloadBindings();
    this.reloadChannelDefaultTargets();

    // Permission links
    const perms = readJson<Record<string, PermissionLinkRecord>>(
      path.join(DATA_DIR, 'permissions.json'),
      {},
    );
    for (const [id, p] of Object.entries(perms)) {
      this.permissionLinks.set(id, p);
    }

    // Offsets
    const offsets = readJson<Record<string, string>>(
      path.join(DATA_DIR, 'offsets.json'),
      {},
    );
    for (const [k, v] of Object.entries(offsets)) {
      this.offsets.set(k, v);
    }

    // Dedup
    const dedup = readJson<Record<string, number>>(
      path.join(DATA_DIR, 'dedup.json'),
      {},
    );
    for (const [k, v] of Object.entries(dedup)) {
      this.dedupKeys.set(k, v);
    }

    // Audit: keep old audit.json readable, append new records to audit.jsonl.
    this.auditLog = [
      ...readJson<Array<AuditLogInput & { id: string; createdAt: string }>>(AUDIT_JSON_PATH, []),
      ...readJsonl<AuditLogInput & { id: string; createdAt: string }>(AUDIT_JSONL_PATH),
    ].slice(-1000);
  }

  private reloadSessions(): void {
    const sessions = readJson<Record<string, BridgeSession>>(
      path.join(DATA_DIR, 'sessions.json'),
      {},
    );
    this.sessions = new Map(Object.entries(sessions).map(([id, session]) => [
      id,
      materializeBridgeSessionRuntime(session),
    ]));
  }

  private reloadBindings(): void {
    const bindings = readJson<Record<string, ChannelChat>>(
      CHANNEL_CHATS_PATH,
      {},
    );
    this.bindings = new Map(Object.entries(bindings).map(([id, binding]) => [
      id,
      {
        ...binding,
        runtimeBridgeSessionIds: normalizeRuntimeBridgeSessionIds(binding.runtimeBridgeSessionIds),
      },
    ]));
  }

  private reloadChannelDefaultTargets(): void {
    const targets = readJson<Record<string, ChannelDefaultTarget>>(
      CHANNEL_DEFAULT_TARGETS_PATH,
      {},
    );
    const normalized = new Map<string, ChannelDefaultTarget>();
    let changed = false;

    for (const target of Object.values(targets)) {
      const normalizedTarget = normalizeChannelDefaultTarget(target);
      if (didChannelDefaultTargetChange(target, normalizedTarget)) {
        changed = true;
      }
      normalized.set(normalizedTarget.channelType, normalizedTarget);
    }

    this.channelDefaultTargets = normalized;
    if (changed) {
      this.persistChannelDefaultTargets();
    }
  }

  private persistSessions(): void {
    writeJson(
      path.join(DATA_DIR, 'sessions.json'),
      Object.fromEntries(this.sessions),
    );
  }

  private persistBindings(): void {
    writeJson(
      CHANNEL_CHATS_PATH,
      Object.fromEntries(this.bindings),
    );
  }

  private persistChannelDefaultTargets(): void {
    writeJson(
      CHANNEL_DEFAULT_TARGETS_PATH,
      Object.fromEntries(this.channelDefaultTargets),
    );
  }

  private persistPermissions(): void {
    writeJson(
      path.join(DATA_DIR, 'permissions.json'),
      Object.fromEntries(this.permissionLinks),
    );
  }

  private persistOffsets(): void {
    writeJson(
      path.join(DATA_DIR, 'offsets.json'),
      Object.fromEntries(this.offsets),
    );
  }

  private persistDedup(): void {
    writeJson(
      path.join(DATA_DIR, 'dedup.json'),
      Object.fromEntries(this.dedupKeys),
    );
  }

  private loadMessages(sessionId: string): BridgeMessage[] {
    if (this.messages.has(sessionId)) {
      return this.messages.get(sessionId)!;
    }
    const msgs = [
      ...readJson<BridgeMessage[]>(messageJsonPath(sessionId), []),
      ...readJsonl<BridgeMessage>(messageJsonlPath(sessionId)),
    ];
    this.messages.set(sessionId, msgs);
    return msgs;
  }

  // ── Settings ──

  private refreshSettings(): void {
    if (!this.dynamicSettings) return;
    try {
      const next = loadRuntimeSettings({ codelarkHome: CODELARK_HOME, migrate: false });
      this.settings = new Map([
        ...this.settings,
        ...next,
      ]);
    } catch {
      // Keep the last known settings if the config file is temporarily unreadable.
    }
  }

  getSetting(key: string): string | null {
    this.refreshSettings();
    return this.settings.get(key) ?? null;
  }

  // ── Channel Chats ──

  private getBindingsForChat(channelType: string, chatId: string): ChannelChat[] {
    return Array.from(this.bindings.values()).filter((binding) => (
      binding.channelType === channelType && binding.chatId === chatId
    ));
  }

  private deleteUnboundTemporarySession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (
      !session
      || session.hidden !== true
      || getSessionCodexThreadId(session)
      || getSessionClaudeSessionId(session)
    ) {
      return false;
    }
    const stillBound = Array.from(this.bindings.values()).some((binding) => binding.bridgeSessionId === sessionId);
    if (stillBound) return false;
    this.sessions.delete(sessionId);
    this.messages.delete(sessionId);
    try {
      fs.rmSync(messageJsonPath(sessionId), { force: true });
      fs.rmSync(messageJsonlPath(sessionId), { force: true });
    } catch {
      // best effort
    }
    return true;
  }

  getChannelChat(channelType: string, chatId: string): ChannelChat | null {
    this.reloadBindings();
    return this.getBindingsForChat(channelType, chatId)[0] ?? null;
  }

  upsertChannelChat(data: UpsertChannelChatInput): ChannelChat {
    this.reloadBindings();
    this.reloadSessions();
    const activeSession = this.sessions.get(data.bridgeSessionId);
    const activeRuntime = getSessionActiveRuntime(activeSession) || 'codex';
    const existing = this.getBindingsForChat(data.channelType, data.chatId)[0];
    if (existing) {
      const previousBridgeSessionId = existing.bridgeSessionId;
      const chatKind = normalizeChatKind(data.chatKind) ?? existing.chatKind;
      const runtimeBridgeSessionIds = {
        ...existing.runtimeBridgeSessionIds,
        ...normalizeRuntimeBridgeSessionIds(data.runtimeBridgeSessionIds),
        [activeRuntime]: data.bridgeSessionId,
      };
      const updated: ChannelChat = {
        ...existing,
        bridgeSessionId: data.bridgeSessionId,
        runtimeBridgeSessionIds,
        chatUserId: data.chatUserId ?? existing.chatUserId,
        channelProvider: data.channelProvider ?? existing.channelProvider,
        channelAlias: data.channelAlias ?? existing.channelAlias,
        cloudDocumentChat: data.cloudDocumentChat ?? existing.cloudDocumentChat,
        updatedAt: now(),
      };
      if (chatKind) updated.chatKind = chatKind;
      else delete updated.chatKind;
      this.bindings.set(updated.id, updated);
      const deletedTemporary = previousBridgeSessionId !== data.bridgeSessionId
        && this.deleteUnboundTemporarySession(previousBridgeSessionId);
      if (deletedTemporary) this.persistSessions();
      this.persistBindings();
      return this.bindings.get(updated.id) || updated;
    }
    const timestamp = now();
    const chatKind = normalizeChatKind(data.chatKind);
    const runtimeBridgeSessionIds = {
      ...normalizeRuntimeBridgeSessionIds(data.runtimeBridgeSessionIds),
      [activeRuntime]: data.bridgeSessionId,
    };
    const binding: ChannelChat = {
      id: uuid(),
      channelType: data.channelType,
      channelProvider: data.channelProvider,
      channelAlias: data.channelAlias,
      chatId: data.chatId,
      chatUserId: data.chatUserId,
      bridgeSessionId: data.bridgeSessionId,
      runtimeBridgeSessionIds,
      cloudDocumentChat: data.cloudDocumentChat,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastActivityAt: timestamp,
    };
    if (chatKind) binding.chatKind = chatKind;
    this.bindings.set(binding.id, binding);
    this.persistBindings();
    return this.bindings.get(binding.id) || binding;
  }

  deleteChannelChat(id: string): void {
    this.reloadBindings();
    const binding = this.bindings.get(id);
    if (!binding) return;
    this.bindings.delete(id);
    this.persistBindings();
  }

  updateChannelChat(id: string, updates: Partial<ChannelChat>): void {
    this.reloadBindings();
    const binding = this.bindings.get(id);
    if (!binding) return;
    const runtimeBridgeSessionIds = updates.runtimeBridgeSessionIds
      ? normalizeRuntimeBridgeSessionIds({
        ...binding.runtimeBridgeSessionIds,
        ...updates.runtimeBridgeSessionIds,
      })
      : binding.runtimeBridgeSessionIds;
    const updated = { ...binding, ...updates, runtimeBridgeSessionIds, id: binding.id, updatedAt: now() };
    this.bindings.set(id, updated);
    this.persistBindings();
  }

  touchChannelChatActivity(id: string, timestamp = now()): void {
    this.reloadBindings();
    const binding = this.bindings.get(id);
    if (!binding) return;
    this.bindings.set(id, { ...binding, lastActivityAt: timestamp });
    this.persistBindings();
  }

  listChannelChats(channelType?: ChannelType): ChannelChat[] {
    this.reloadBindings();
    const all = Array.from(this.bindings.values());
    if (!channelType) return all;
    return all.filter((b) => b.channelType === channelType);
  }

  getChannelDefaultTarget(channelType: string): ChannelDefaultTarget | null {
    this.reloadChannelDefaultTargets();
    return this.channelDefaultTargets.get(channelType) ?? null;
  }

  upsertChannelDefaultTarget(data: UpsertChannelDefaultTargetInput): ChannelDefaultTarget {
    this.reloadChannelDefaultTargets();
    const existing = this.channelDefaultTargets.get(data.channelType);
    if (existing) {
      const updated: ChannelDefaultTarget = {
        ...existing,
        bridgeSessionId: data.bridgeSessionId,
        channelProvider: data.channelProvider ?? existing.channelProvider,
        channelAlias: data.channelAlias ?? existing.channelAlias,
        updatedAt: now(),
      };
      this.channelDefaultTargets.set(data.channelType, updated);
      this.persistChannelDefaultTargets();
      return updated;
    }

    const target: ChannelDefaultTarget = {
      id: uuid(),
      channelType: data.channelType,
      channelProvider: data.channelProvider,
      channelAlias: data.channelAlias,
      bridgeSessionId: data.bridgeSessionId,
      createdAt: now(),
      updatedAt: now(),
    };
    this.channelDefaultTargets.set(data.channelType, target);
    this.persistChannelDefaultTargets();
    return target;
  }

  deleteChannelDefaultTarget(channelType: string): void {
    this.reloadChannelDefaultTargets();
    if (this.channelDefaultTargets.delete(channelType)) {
      this.persistChannelDefaultTargets();
    }
  }

  listChannelDefaultTargets(): ChannelDefaultTarget[] {
    this.reloadChannelDefaultTargets();
    return Array.from(this.channelDefaultTargets.values());
  }

  // ── Sessions ──

  getSession(id: string): BridgeSession | null {
    this.reloadSessions();
    return this.sessions.get(id) ?? null;
  }

  listSessions(): BridgeSession[] {
    this.reloadSessions();
    return Array.from(this.sessions.values());
  }

  findSessionByCodexThreadId(codexThreadId: string): BridgeSession | null {
    this.reloadSessions();
    const normalized = codexThreadId.trim();
    if (!normalized) return null;
    for (const session of this.sessions.values()) {
      if (getSessionCodexThreadId(session) === normalized) {
        return session;
      }
    }
    return null;
  }

  createSession(
    name: string,
    _model: string,
    systemPrompt?: string,
    cwd?: string,
    _mode?: string,
    options?: {
      reasoningEffort?: CodexReasoningEffort;
      activeRuntime?: 'codex' | 'claude';
      sessionType?: BridgeSession['session_type'];
      hidden?: boolean;
      parentSessionId?: string;
      expiresAt?: string;
    },
  ): BridgeSession {
    this.reloadSessions();
    const timestamp = now();
    const activeRuntime = options?.activeRuntime === 'claude' ? 'claude' : options?.activeRuntime === 'codex' ? 'codex' : undefined;
    const workingDirectory = cwd || process.cwd();
    const session: BridgeSession = {
      id: uuid(),
      name,
      runtime: activeRuntime === 'claude' ? {
        activeRuntime: 'claude',
        ...(systemPrompt ? { general: { systemPrompt } } : {}),
      } : {
        ...(activeRuntime ? { activeRuntime } : {}),
        ...(systemPrompt ? { general: { systemPrompt } } : {}),
      },
      session_type: options?.sessionType || 'normal',
      hidden: options?.hidden === true,
      parent_session_id: options?.parentSessionId,
      expires_at: options?.expiresAt,
      created_at: timestamp,
      updated_at: timestamp,
    };
    const materialized = materializeBridgeSessionRuntime(session);
    this.sessions.set(session.id, materialized);
    this.persistSessions();
    setSessionConfigPatch(session.id, { session: { workspace: workingDirectory } });
    return materialized;
  }

  updateSessionProviderId(sessionId: string, providerId: string): void {
    this.reloadSessions();
    const s = this.sessions.get(sessionId);
    if (s) {
      s.provider_id = providerId;
      s.updated_at = now();
      this.persistSessions();
    }
  }

  updateSession(sessionId: string, updates: BridgeSessionUpdate, options?: { touch?: boolean }): void {
    this.reloadSessions();
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const runtimeUpdates = updates.runtime;
    const runtime = mergeSessionRuntime(session.runtime, runtimeUpdates);
    const next = materializeBridgeSessionRuntime({
      ...session,
      ...updates,
      runtime,
      id: session.id,
      updated_at: options?.touch === false ? session.updated_at : now(),
    });
    this.sessions.set(sessionId, next);
    this.persistSessions();
  }

  deleteSession(sessionId: string): void {
    this.reloadSessions();
    this.reloadBindings();
    this.sessions.delete(sessionId);
    for (const [key, binding] of this.bindings) {
      if (binding.bridgeSessionId === sessionId) {
        this.bindings.delete(key);
        continue;
      }
      const runtimeBridgeSessionIds = normalizeRuntimeBridgeSessionIds({
        ...binding.runtimeBridgeSessionIds,
        codex: binding.runtimeBridgeSessionIds?.codex === sessionId ? undefined : binding.runtimeBridgeSessionIds?.codex,
        claude: binding.runtimeBridgeSessionIds?.claude === sessionId ? undefined : binding.runtimeBridgeSessionIds?.claude,
      });
      if (!sameRuntimeBridgeSessionIds(runtimeBridgeSessionIds, binding.runtimeBridgeSessionIds)) {
        this.bindings.set(key, { ...binding, runtimeBridgeSessionIds, updatedAt: now() });
      }
    }
    this.messages.delete(sessionId);
    try {
      fs.rmSync(messageJsonPath(sessionId), { force: true });
      fs.rmSync(messageJsonlPath(sessionId), { force: true });
    } catch {
      // best effort
    }
    this.persistSessions();
    this.persistBindings();
  }

  // ── Messages ──

  addMessage(sessionId: string, role: string, content: string, _usage?: string | null): void {
    const msgs = this.loadMessages(sessionId);
    const message = { role, content, timestamp: now() };
    msgs.push(message);
    appendJsonl(messageJsonlPath(sessionId), message);
  }

  getMessages(sessionId: string, opts?: { limit?: number }): { messages: BridgeMessage[] } {
    const msgs = this.loadMessages(sessionId);
    if (opts?.limit && opts.limit > 0) {
      return { messages: msgs.slice(-opts.limit) };
    }
    return { messages: [...msgs] };
  }

  // ── Session Locking ──

  acquireSessionLock(sessionId: string, lockId: string, owner: string, ttlSecs: number): boolean {
    const existing = this.locks.get(sessionId);
    if (existing && existing.expiresAt > Date.now()) {
      // Lock held by someone else
      if (existing.lockId !== lockId) return false;
    }
    this.locks.set(sessionId, {
      lockId,
      owner,
      expiresAt: Date.now() + ttlSecs * 1000,
    });
    return true;
  }

  renewSessionLock(sessionId: string, lockId: string, ttlSecs: number): void {
    const lock = this.locks.get(sessionId);
    if (lock && lock.lockId === lockId) {
      lock.expiresAt = Date.now() + ttlSecs * 1000;
    }
  }

  releaseSessionLock(sessionId: string, lockId: string): void {
    const lock = this.locks.get(sessionId);
    if (lock && lock.lockId === lockId) {
      this.locks.delete(sessionId);
    }
  }

  setSessionRuntimeStatus(_sessionId: string, _status: string): void {
    this.reloadSessions();
    const session = this.sessions.get(_sessionId);
    if (!session) return;

    const queuedCount = session.queued_count && session.queued_count > 0
      ? session.queued_count
      : 0;
    let runtimeStatus: BridgeSession['runtime_status'];

    if (_status === 'running') {
      runtimeStatus = queuedCount > 0 ? 'queued' : 'running';
    } else if (_status === 'idle') {
      runtimeStatus = queuedCount > 0 ? 'queued' : 'idle';
    } else {
      runtimeStatus = session.runtime_status;
    }

    const next: BridgeSession = {
      ...session,
      runtime_status: runtimeStatus,
      last_runtime_update_at: now(),
      updated_at: now(),
    };
    this.sessions.set(_sessionId, next);
    this.persistSessions();
  }

  // ── Codex Thread ──

  updateSessionCodexThreadId(sessionId: string, codexThreadId: string): void {
    this.updateSession(sessionId, setSessionCodexThreadIdUpdate(codexThreadId || undefined));
  }

  updateSessionModel(_sessionId: string, _model: string): void {
    // Runtime-reported model is not session configuration. The config refactor
    // keeps BridgeSession JSON for identity/status only.
  }

  syncSdkTasks(_sessionId: string, _todos: unknown): void {
    // no-op
  }

  // ── Provider ──

  getProvider(_id: string): BridgeApiProvider | undefined {
    return undefined;
  }

  getDefaultProviderId(): string | null {
    return null;
  }

  // ── Audit & Dedup ──

  insertAuditLog(entry: AuditLogInput): void {
    const record = {
      ...entry,
      id: uuid(),
      createdAt: now(),
    };
    this.auditLog.push(record);
    // Ring buffer: keep last 1000
    if (this.auditLog.length > 1000) {
      this.auditLog = this.auditLog.slice(-1000);
    }
    appendJsonl(AUDIT_JSONL_PATH, record);
  }

  checkDedup(key: string): boolean {
    const ts = this.dedupKeys.get(key);
    if (ts === undefined) return false;
    // 5 minute window
    if (Date.now() - ts > 5 * 60 * 1000) {
      this.dedupKeys.delete(key);
      return false;
    }
    return true;
  }

  insertDedup(key: string): void {
    this.dedupKeys.set(key, Date.now());
    this.persistDedup();
  }

  cleanupExpiredDedup(): void {
    const cutoff = Date.now() - 5 * 60 * 1000;
    let changed = false;
    for (const [key, ts] of this.dedupKeys) {
      if (ts < cutoff) {
        this.dedupKeys.delete(key);
        changed = true;
      }
    }
    if (changed) this.persistDedup();
  }

  insertOutboundRef(_ref: OutboundRefInput): void {
    // no-op for file-based store
  }

  // ── Permission Links ──

  insertPermissionLink(link: PermissionLinkInput): void {
    const record: PermissionLinkRecord = {
      permissionRequestId: link.permissionRequestId,
      chatId: link.chatId,
      messageId: link.messageId,
      sessionId: link.sessionId,
      resolved: false,
      suggestions: link.suggestions,
    };
    this.permissionLinks.set(link.permissionRequestId, record);
    this.persistPermissions();
  }

  getPermissionLink(permissionRequestId: string): PermissionLinkRecord | null {
    return this.permissionLinks.get(permissionRequestId) ?? null;
  }

  markPermissionLinkResolved(permissionRequestId: string): boolean {
    const link = this.permissionLinks.get(permissionRequestId);
    if (!link || link.resolved) return false;
    link.resolved = true;
    this.persistPermissions();
    return true;
  }

  listPendingPermissionLinksByChat(chatId: string): PermissionLinkRecord[] {
    const result: PermissionLinkRecord[] = [];
    for (const link of this.permissionLinks.values()) {
      if (link.chatId === chatId && !link.resolved) {
        result.push(link);
      }
    }
    return result;
  }

  // ── Channel Offsets ──

  getChannelOffset(key: string): string {
    return this.offsets.get(key) ?? '0';
  }

  setChannelOffset(key: string, offset: string): void {
    this.offsets.set(key, offset);
    this.persistOffsets();
  }
}
