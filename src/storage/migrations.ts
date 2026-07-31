import fs from 'node:fs';
import path from 'node:path';

import { CODELARK_HOME } from '../configuration/paths.js';

interface MigrationOptions {
  codelarkHome?: string;
  now?: () => Date;
  logger?: Pick<Console, 'log' | 'warn'> | false;
}

export interface StorageMigrationResult {
  changed: boolean;
  changedFiles: string[];
  createdSessions: number;
  migratedSessions: number;
  retiredChannelDefaultTargets: number;
  repairedDuplicateBindings: number;
  migratedUiSessionNames: number;
  migratedChannelRuntimeBindings: number;
  removedFields: number;
  errors: string[];
}

const SESSION_THREAD_SOURCE_FIELDS = [
  'desktop_thread_id',
  'desktopThreadId',
  'sdk_session_id',
  'sdkSessionId',
  'thread_id',
  'threadId',
];

const RETIRED_SESSION_FIELDS = [
  'working_directory',
  'system_prompt',
  'model',
  'preferred_mode',
  'codex_thread_id',
  'codex_title',
  'reasoning_effort',
  'codex_provider',
  'codex_sandbox_mode',
  'codex_network_access',
  'tmux_session_name',
  'tmux_capture_lines',
  'tmux_auto_enter',
  'tmux_echo_input',
  'desktop_thread_id',
  'desktopThreadId',
  'sdk_session_id',
  'sdkSessionId',
  'thread_origin',
  'threadOrigin',
  'thread_id',
  'threadId',
];

const RUNTIME_KEYS = ['codex', 'claude', 'kimi', 'cursor'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readJsonRecord(filePath: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readJsonArray(filePath: string): unknown[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function readJsonLines(filePath: string): Record<string, unknown>[] {
  try {
    return fs.readFileSync(filePath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const value = JSON.parse(line) as unknown;
          return isRecord(value) ? [value] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function appendJsonLine(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf-8');
}

function atomicWriteJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2), 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

function readPositiveInteger(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return Number.isInteger(value) && (value as number) > 0 ? value as number : undefined;
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = readString(record, key);
    if (value) return value;
  }
  return undefined;
}

function ensureRuntimeContainer(session: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(session.runtime)) {
    session.runtime = {};
  }
  return session.runtime as Record<string, unknown>;
}

function ensureNestedContainer(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  if (!isRecord(parent[key])) {
    parent[key] = {};
  }
  return parent[key] as Record<string, unknown>;
}

function normalizeRuntimeBridgeSessionIds(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const result: Record<string, string> = {};
  const codex = typeof value.codex === 'string' && value.codex.trim() ? value.codex.trim() : '';
  const claude = typeof value.claude === 'string' && value.claude.trim() ? value.claude.trim() : '';
  const kimi = typeof value.kimi === 'string' && value.kimi.trim() ? value.kimi.trim() : '';
  const cursor = typeof value.cursor === 'string' && value.cursor.trim() ? value.cursor.trim() : '';
  if (codex) result.codex = codex;
  if (claude) result.claude = claude;
  if (kimi) result.kimi = kimi;
  if (cursor) result.cursor = cursor;
  return result;
}

function setIfMissing(target: Record<string, unknown>, key: string, value: unknown): boolean {
  if (value === undefined || value === null || value === '') return false;
  if (target[key] !== undefined) return false;
  target[key] = value;
  return true;
}

function removeFields(record: Record<string, unknown>, fields: string[]): number {
  let removed = 0;
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(record, field)) {
      delete record[field];
      removed += 1;
    }
  }
  return removed;
}

function migrateSessions(
  sessions: Record<string, unknown>,
): Pick<StorageMigrationResult, 'migratedSessions' | 'removedFields'> & { changed: boolean } {
  let changed = false;
  let migratedSessions = 0;
  let removedFields = 0;

  for (const [key, value] of Object.entries(sessions)) {
    if (!isRecord(value)) continue;
    const runtime = ensureRuntimeContainer(value);
    const activeRuntime = runtime.activeRuntime === 'claude'
      ? 'claude'
      : runtime.activeRuntime === 'kimi'
        ? 'kimi'
        : runtime.activeRuntime === 'cursor'
          ? 'cursor'
          : 'codex';
    const activeRuntimeState = ensureNestedContainer(runtime, activeRuntime);
    const codex = activeRuntime === 'codex' ? activeRuntimeState : {};
    const claude = activeRuntime === 'claude' ? activeRuntimeState : {};
    const kimi = activeRuntime === 'kimi' ? activeRuntimeState : {};
    const cursor = activeRuntime === 'cursor' ? activeRuntimeState : {};
    const general = ensureNestedContainer(runtime, 'general');

    const threadId = firstString(value, ['codex_thread_id', ...SESSION_THREAD_SOURCE_FIELDS]);
    const model = readString(value, 'model');
    const migratedRuntime = [
      activeRuntime === 'codex' && setIfMissing(codex, 'threadId', threadId),
      activeRuntime === 'codex' && setIfMissing(codex, 'title', readString(value, 'codex_title')),
      activeRuntime === 'codex' && setIfMissing(codex, 'model', model),
      activeRuntime === 'codex' && setIfMissing(codex, 'mode', readString(value, 'preferred_mode')),
      activeRuntime === 'codex' && setIfMissing(codex, 'provider', readString(value, 'codex_provider')),
      activeRuntime === 'codex' && setIfMissing(codex, 'sandboxMode', readString(value, 'codex_sandbox_mode')),
      activeRuntime === 'codex' && setIfMissing(codex, 'networkAccess', readBoolean(value, 'codex_network_access')),
      activeRuntime === 'codex' && setIfMissing(codex, 'reasoningEffort', readString(value, 'reasoning_effort')),
      activeRuntime === 'claude' && setIfMissing(claude, 'model', model),
      activeRuntime === 'kimi' && setIfMissing(kimi, 'model', model),
      activeRuntime === 'cursor' && setIfMissing(cursor, 'model', model),
      setIfMissing(general, 'workingDirectory', readString(value, 'working_directory')),
      setIfMissing(general, 'systemPrompt', readString(value, 'system_prompt')),
      setIfMissing(general, 'tmuxSessionName', readString(value, 'tmux_session_name')),
      setIfMissing(general, 'captureLines', readPositiveInteger(value, 'tmux_capture_lines')),
      setIfMissing(general, 'autoEnter', readBoolean(value, 'tmux_auto_enter')),
      setIfMissing(general, 'echoInput', readBoolean(value, 'tmux_echo_input')),
    ].some(Boolean);

    for (const runtimeKey of RUNTIME_KEYS) {
      if (runtimeKey === activeRuntime) continue;
      if (runtime[runtimeKey] !== undefined) {
        delete runtime[runtimeKey];
        changed = true;
        removedFields += 1;
      }
    }
    if (Object.keys(activeRuntimeState).length === 0) delete runtime[activeRuntime];
    if (Object.keys(general).length === 0) delete runtime.general;
    if (Object.keys(runtime).length === 0) delete value.runtime;

    if (migratedRuntime) {
      migratedSessions += 1;
      changed = true;
    }

    if (!readString(value, 'id')) {
      value.id = key;
      changed = true;
    }

    const removed = removeFields(value, RETIRED_SESSION_FIELDS);
    if (removed > 0) {
      removedFields += removed;
      changed = true;
    }
  }

  return { changed, migratedSessions, removedFields };
}

function migrateChannelChats(
  bindings: Record<string, unknown>,
  sessions: Record<string, unknown>,
): Pick<StorageMigrationResult, 'migratedChannelRuntimeBindings'> & { bindingsChanged: boolean } {
  let bindingsChanged = false;
  let migratedChannelRuntimeBindings = 0;

  for (const value of Object.values(bindings)) {
    if (!isRecord(value)) continue;
    const bridgeSessionId = readString(value, 'bridgeSessionId');
    if (!bridgeSessionId) continue;
    const session = isRecord(sessions[bridgeSessionId]) ? sessions[bridgeSessionId] as Record<string, unknown> : null;
    const runtime = isRecord(session?.runtime) && session?.runtime.activeRuntime === 'claude'
      ? 'claude'
      : isRecord(session?.runtime) && session?.runtime.activeRuntime === 'kimi'
        ? 'kimi'
        : isRecord(session?.runtime) && session?.runtime.activeRuntime === 'cursor'
          ? 'cursor'
        : 'codex';
    const runtimeBridgeSessionIds = normalizeRuntimeBridgeSessionIds(value.runtimeBridgeSessionIds);
    if (!runtimeBridgeSessionIds[runtime]) {
      runtimeBridgeSessionIds[runtime] = bridgeSessionId;
      value.runtimeBridgeSessionIds = runtimeBridgeSessionIds;
      migratedChannelRuntimeBindings += 1;
      bindingsChanged = true;
    }
  }

  return { bindingsChanged, migratedChannelRuntimeBindings };
}

interface RemovedDuplicateBinding {
  binding: Record<string, unknown>;
  keptBindingId: string;
  reason: 'auto_create_prebound' | 'duplicate_bridge_session';
}

function bindingAuditKey(channelType: string, chatId: string, bridgeSessionId: string): string {
  return `${channelType}\u0000${chatId}\u0000${bridgeSessionId}`;
}

function findAutoPreboundBindings(auditEntries: Record<string, unknown>[]): Set<string> {
  const result = new Set<string>();
  for (const entry of auditEntries) {
    const channelType = readString(entry, 'channelType');
    const chatId = readString(entry, 'chatId');
    const summary = readString(entry, 'summary');
    const bridgeSessionId = summary?.match(/to=\[session=([^\]]+)\]/u)?.[1]?.trim();
    if (channelType && chatId && bridgeSessionId && summary?.includes('action=auto_create_prebound')) {
      result.add(bindingAuditKey(channelType, chatId, bridgeSessionId));
    }
  }
  return result;
}

function bindingCreatedAt(binding: Record<string, unknown>): number {
  const parsed = Date.parse(readString(binding, 'createdAt') || '');
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function repairDuplicateChannelBindings(
  bindings: Record<string, unknown>,
  autoPreboundBindingKeys: Set<string>,
): { changed: boolean; removed: RemovedDuplicateBinding[] } {
  const isAutoPrebound = (binding: Record<string, unknown>): boolean => autoPreboundBindingKeys.has(bindingAuditKey(
    readString(binding, 'channelType') || '',
    readString(binding, 'chatId') || '',
    readString(binding, 'bridgeSessionId') || '',
  ));
  const bySession = new Map<string, Array<{ key: string; binding: Record<string, unknown> }>>();
  for (const [key, value] of Object.entries(bindings)) {
    if (!isRecord(value)) continue;
    const bridgeSessionId = readString(value, 'bridgeSessionId');
    if (!bridgeSessionId) continue;
    const entries = bySession.get(bridgeSessionId) || [];
    entries.push({ key, binding: value });
    bySession.set(bridgeSessionId, entries);
  }

  const removed: RemovedDuplicateBinding[] = [];
  for (const entries of bySession.values()) {
    if (entries.length < 2) continue;
    entries.sort((left, right) => {
      const leftAuto = isAutoPrebound(left.binding) ? 1 : 0;
      const rightAuto = isAutoPrebound(right.binding) ? 1 : 0;
      if (leftAuto !== rightAuto) return leftAuto - rightAuto;
      const timeDiff = bindingCreatedAt(left.binding) - bindingCreatedAt(right.binding);
      if (timeDiff !== 0) return timeDiff;
      return left.key.localeCompare(right.key);
    });
    const kept = entries[0];
    for (const duplicate of entries.slice(1)) {
      removed.push({
        binding: { ...duplicate.binding },
        keptBindingId: readString(kept.binding, 'id') || kept.key,
        reason: isAutoPrebound(duplicate.binding) ? 'auto_create_prebound' : 'duplicate_bridge_session',
      });
      delete bindings[duplicate.key];
    }
  }
  return { changed: removed.length > 0, removed };
}

function migrateUiSessionMeta(
  uiSessionMeta: Record<string, unknown>,
  sessions: Record<string, unknown>,
  nowIso: string,
): Pick<StorageMigrationResult, 'createdSessions' | 'migratedUiSessionNames'> & { sessionsChanged: boolean } {
  let sessionsChanged = false;
  let createdSessions = 0;
  let migratedUiSessionNames = 0;

  for (const [metaKey, value] of Object.entries(uiSessionMeta)) {
    if (!isRecord(value)) continue;
    const name = readString(value, 'name');
    if (!name) continue;

    if (metaKey.startsWith('session:')) {
      const sessionId = metaKey.slice('session:'.length);
      const session = isRecord(sessions[sessionId]) ? sessions[sessionId] as Record<string, unknown> : null;
      if (!session) continue;
      if (readString(session, 'name') !== name) {
        session.name = name;
        session.updated_at = readString(session, 'updated_at') || nowIso;
        sessionsChanged = true;
      }
      migratedUiSessionNames += 1;
      continue;
    }

    // Retired selector keys such as desktop:<threadId> are intentionally not
    // materialized into new BridgeSession records.
  }

  return { sessionsChanged, createdSessions, migratedUiSessionNames };
}

export function runStartupStorageMigrations(options: MigrationOptions = {}): StorageMigrationResult {
  const codelarkHome = options.codelarkHome || CODELARK_HOME;
  const logger = options.logger === undefined ? console : options.logger;
  const nowIso = (options.now ? options.now() : new Date()).toISOString();
  const dataDir = path.join(codelarkHome, 'data');
  const sessionsPath = path.join(dataDir, 'sessions.json');
  const channelDefaultTargetsPath = path.join(dataDir, 'channel-default-targets.json');
  const channelChatsPath = path.join(dataDir, 'channel-chats.json');
  const channelRoutingRecoveryPath = path.join(dataDir, 'channel-routing-recovery.jsonl');
  const auditPath = path.join(dataDir, 'audit.json');
  const auditJsonlPath = path.join(dataDir, 'audit.jsonl');
  const uiSessionMetaPath = path.join(dataDir, 'ui-session-meta.json');
  const result: StorageMigrationResult = {
    changed: false,
    changedFiles: [],
    createdSessions: 0,
    migratedSessions: 0,
    retiredChannelDefaultTargets: 0,
    repairedDuplicateBindings: 0,
    migratedUiSessionNames: 0,
    migratedChannelRuntimeBindings: 0,
    removedFields: 0,
    errors: [],
  };

  const sessionsExists = fs.existsSync(sessionsPath);
  const channelChatsExists = fs.existsSync(channelChatsPath);
  const channelDefaultTargetsExists = fs.existsSync(channelDefaultTargetsPath);
  const uiSessionMetaExists = fs.existsSync(uiSessionMetaPath);
  const sessions = sessionsExists ? readJsonRecord(sessionsPath) : {};
  const channelChats = channelChatsExists ? readJsonRecord(channelChatsPath) : {};
  const parsedChannelDefaultTargets = channelDefaultTargetsExists ? readJsonRecord(channelDefaultTargetsPath) : {};
  const unparsedChannelDefaultTargets = channelDefaultTargetsExists && !parsedChannelDefaultTargets
    ? fs.readFileSync(channelDefaultTargetsPath, 'utf-8')
    : null;
  const channelDefaultTargets = parsedChannelDefaultTargets || {};
  const uiSessionMeta = uiSessionMetaExists ? readJsonRecord(uiSessionMetaPath) : {};

  if (sessionsExists && !sessions) {
    result.errors.push(`Cannot parse ${sessionsPath}`);
  }
  if (channelChatsExists && !channelChats) {
    result.errors.push(`Cannot parse ${channelChatsPath}`);
  }
  if (uiSessionMetaExists && !uiSessionMeta) {
    result.errors.push(`Cannot parse ${uiSessionMetaPath}`);
  }
  if (!sessions || !channelChats || !uiSessionMeta) {
    for (const error of result.errors) logger && logger.warn(`[CodeLark] Storage migration skipped: ${error}`);
    return result;
  }

  const sessionMigration = migrateSessions(sessions);
  const channelChatsMigration = migrateChannelChats(channelChats, sessions);
  const auditEntries = [
    ...readJsonArray(auditPath).filter(isRecord),
    ...readJsonLines(auditJsonlPath),
  ];
  const duplicateBindingRepair = repairDuplicateChannelBindings(
    channelChats,
    findAutoPreboundBindings(auditEntries),
  );
  const retiredChannelDefaultTargets = unparsedChannelDefaultTargets === null
    ? Object.entries(channelDefaultTargets).map(([storageKey, value]) => (
      isRecord(value) ? { storageKey, ...value } : { storageKey, rawValue: value }
    ))
    : [{ storageKey: '__unparsed__', rawText: unparsedChannelDefaultTargets }];
  const uiSessionMetaMigration = migrateUiSessionMeta(uiSessionMeta, sessions, nowIso);
  result.createdSessions += uiSessionMetaMigration.createdSessions;
  result.migratedSessions += sessionMigration.migratedSessions;
  result.retiredChannelDefaultTargets += retiredChannelDefaultTargets.length;
  result.repairedDuplicateBindings += duplicateBindingRepair.removed.length;
  result.migratedUiSessionNames += uiSessionMetaMigration.migratedUiSessionNames;
  result.migratedChannelRuntimeBindings += channelChatsMigration.migratedChannelRuntimeBindings;
  result.removedFields += sessionMigration.removedFields;

  if (retiredChannelDefaultTargets.length > 0 || duplicateBindingRepair.removed.length > 0) {
    const recoveryKey = [
      ...retiredChannelDefaultTargets.map((target) => `default:${String(target.storageKey)}`),
      ...duplicateBindingRepair.removed.map((entry) => (
        `binding:${readString(entry.binding, 'id') || ''}:${entry.keptBindingId}`
      )),
    ].sort().join('|');
    const existingRecoveryKeys = new Set(readJsonLines(channelRoutingRecoveryPath)
      .map((entry) => readString(entry, 'recoveryKey'))
      .filter((value): value is string => Boolean(value)));
    if (!existingRecoveryKeys.has(recoveryKey)) {
      appendJsonLine(channelRoutingRecoveryPath, {
        schemaVersion: 1,
        recoveryKey,
        migratedAt: nowIso,
        retiredChannelDefaultTargets,
        removedDuplicateBindings: duplicateBindingRepair.removed,
      });
      result.changedFiles.push(channelRoutingRecoveryPath);
    }

    const existingAuditMessageIds = new Set(auditEntries
      .map((entry) => readString(entry, 'messageId'))
      .filter((value): value is string => Boolean(value)));
    for (const retired of retiredChannelDefaultTargets) {
      const storageKey = String(retired.storageKey);
      const messageId = `storage-migration:retire-channel-default:${storageKey}`;
      if (existingAuditMessageIds.has(messageId)) continue;
      appendJsonLine(auditJsonlPath, {
        id: messageId,
        channelType: readString(retired, 'channelType') || storageKey,
        chatId: '*',
        direction: 'inbound',
        messageId,
        summary: `Binding recovery: action=startup_retire_channel_default; channel=${storageKey}; reason=wildcard_new_chat_routing_removed`,
        createdAt: nowIso,
      });
      existingAuditMessageIds.add(messageId);
      if (!result.changedFiles.includes(auditJsonlPath)) result.changedFiles.push(auditJsonlPath);
    }
    for (const removed of duplicateBindingRepair.removed) {
      const removedBindingId = readString(removed.binding, 'id') || 'unknown';
      const messageId = `storage-migration:repair-binding:${removedBindingId}`;
      if (existingAuditMessageIds.has(messageId)) continue;
      appendJsonLine(auditJsonlPath, {
        id: messageId,
        channelType: readString(removed.binding, 'channelType') || 'unknown',
        chatId: readString(removed.binding, 'chatId') || 'unknown',
        direction: 'inbound',
        messageId,
        summary: `Binding recovery: action=startup_repair_duplicate_binding; removed=[binding=${removedBindingId}]; kept=[binding=${removed.keptBindingId}]; reason=${removed.reason}`,
        createdAt: nowIso,
      });
      existingAuditMessageIds.add(messageId);
      if (!result.changedFiles.includes(auditJsonlPath)) result.changedFiles.push(auditJsonlPath);
    }
  }

  if (
    sessionMigration.changed
    || uiSessionMetaMigration.sessionsChanged
  ) {
    atomicWriteJson(sessionsPath, sessions);
    result.changedFiles.push(sessionsPath);
  }
  if (channelDefaultTargetsExists) {
    fs.rmSync(channelDefaultTargetsPath, { force: true });
    result.changedFiles.push(channelDefaultTargetsPath);
  }
  if (channelChatsMigration.bindingsChanged || duplicateBindingRepair.changed) {
    atomicWriteJson(channelChatsPath, channelChats);
    result.changedFiles.push(channelChatsPath);
  }
  if (uiSessionMetaExists) {
    fs.rmSync(uiSessionMetaPath, { force: true });
    result.changedFiles.push(uiSessionMetaPath);
  }

  result.changed = result.changedFiles.length > 0;
  if (result.changed) {
    logger && logger.log(
      `[CodeLark] 已自动迁移旧存储数据：sessions=${result.migratedSessions}, retired_channel_defaults=${result.retiredChannelDefaultTargets}, repaired_duplicate_bindings=${result.repairedDuplicateBindings}, channel_runtime_bindings=${result.migratedChannelRuntimeBindings}, ui_names=${result.migratedUiSessionNames}, created_sessions=${result.createdSessions}, removed_fields=${result.removedFields}`,
    );
  }

  return result;
}
