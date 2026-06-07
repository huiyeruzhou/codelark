import fs from 'node:fs';
import path from 'node:path';
import { mergePatch } from '../../merge.js';
import type { ConfigPatch } from '../../schema.js';
import { readTomlConfig, resolveConfigPaths, sessionTomlPath, writeTomlConfig } from '../../sources.js';

// legacy sessions.json 配置迁移：把旧 BridgeSession runtime 覆盖搬到 session TOML。
// 迁移后 sessions.json 只保留身份、生命周期和运行状态字段。

interface PreparedSessionJsonConfigMigration {
  nextSessions: Record<string, unknown>;
  writes: Array<{ file: string; patch: ConfigPatch }>;
  migratedSessions: number;
  prunedSessionsJson: boolean;
}

export interface SessionJsonConfigMigrationResult {
  changed: boolean;
  migratedSessions: number;
  writtenFiles: string[];
  prunedSessionsJson: boolean;
}

export interface SessionJsonConfigMigrationOptions {
  codelarkHome: string;
  pruneSessionJson?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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

function readNonNegativeInteger(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return Number.isInteger(value) && (value as number) >= 0 ? value as number : undefined;
}

function codexYoloMode(value: unknown): 'off' | 'on' | undefined {
  if (value === 'yolo' || value === 'on') return 'on';
  if (value === 'normal' || value === 'code' || value === 'off') return 'off';
  return undefined;
}

function claudeYoloMode(value: unknown): 'off' | 'on' | undefined {
  if (value === 'bypassPermissions' || value === 'on') return 'on';
  if (value === 'default' || value === 'acceptEdits' || value === 'plan' || value === 'off') return 'off';
  return undefined;
}

function claudePermissionMode(value: unknown): 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | undefined {
  if (value === 'default' || value === 'acceptEdits' || value === 'bypassPermissions' || value === 'plan') return value;
  if (value === 'on') return 'bypassPermissions';
  if (value === 'off') return 'default';
  return undefined;
}

function reasoningEffort(value: unknown): 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | undefined {
  if (value === 'minimal' || value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh') return value;
  return undefined;
}

function claudeReasoningEffort(value: unknown): 'low' | 'medium' | 'high' | 'xhigh' | undefined {
  if (value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh') return value;
  if (value === 'max') {
    throw new Error('Cannot migrate legacy Claude reasoningEffort=max; confirm how it maps to runtime.claude.reasoningEffort first.');
  }
  return undefined;
}

function codexProvider(value: unknown): 'sdk' | 'tmux' | 'pty' | undefined {
  return value === 'sdk' || value === 'tmux' || value === 'pty' ? value : undefined;
}

function claudeProvider(value: unknown): 'sdk' | 'pty' | undefined {
  return value === 'sdk' || value === 'pty' ? value : undefined;
}

function sandboxMode(value: unknown): 'read-only' | 'workspace-write' | 'danger-full-access' | undefined {
  return value === 'read-only' || value === 'workspace-write' || value === 'danger-full-access' ? value : undefined;
}

function hasPatchContent(patch: ConfigPatch): boolean {
  return Boolean(
    patch.session
    || patch.runtime?.agent !== undefined
    || patch.runtime?.codex
    || patch.runtime?.claude,
  );
}

function deleteEmptyContainers(session: Record<string, unknown>): void {
  if (!isRecord(session.runtime)) return;
  const runtime = session.runtime;
  for (const key of ['codex', 'claude', 'general']) {
    if (isRecord(runtime[key]) && Object.keys(runtime[key] as Record<string, unknown>).length === 0) {
      delete runtime[key];
    }
  }
  if (Object.keys(runtime).length === 0) delete session.runtime;
}

function extractSessionPatch(sessionId: string, session: Record<string, unknown>): {
  patch: ConfigPatch | null;
  cleanedSession: Record<string, unknown>;
} {
  const cleanedSession = JSON.parse(JSON.stringify(session)) as Record<string, unknown>;
  const runtime = isRecord(cleanedSession.runtime) ? cleanedSession.runtime : {};
  const codex = isRecord(runtime.codex) ? runtime.codex : {};
  const claude = isRecord(runtime.claude) ? runtime.claude : {};
  const general = isRecord(runtime.general) ? runtime.general : {};
  const patch: ConfigPatch = {};

  if (runtime.activeRuntime === 'claude' || runtime.activeRuntime === 'codex') {
    patch.runtime = { agent: runtime.activeRuntime };
    delete runtime.activeRuntime;
  }

  const sessionPatch: NonNullable<ConfigPatch['session']> = {};
  const workspace = readString(general, 'workingDirectory');
  if (workspace !== undefined) {
    sessionPatch.workspace = workspace;
    delete general.workingDirectory;
  }
  const tmuxSessionName = readString(general, 'tmuxSessionName');
  if (tmuxSessionName !== undefined) {
    sessionPatch.tmuxSessionName = tmuxSessionName;
    delete general.tmuxSessionName;
  }
  const tmuxCaptureLines = readPositiveInteger(general, 'captureLines');
  if (tmuxCaptureLines !== undefined) {
    sessionPatch.tmuxCaptureLines = tmuxCaptureLines;
    delete general.captureLines;
  }
  const tmuxAutoEnter = readBoolean(general, 'autoEnter');
  if (tmuxAutoEnter !== undefined) {
    sessionPatch.tmuxAutoEnter = tmuxAutoEnter;
    delete general.autoEnter;
  }
  const tmuxEchoInput = readBoolean(general, 'echoInput');
  if (tmuxEchoInput !== undefined) {
    sessionPatch.tmuxEchoInput = tmuxEchoInput;
    delete general.echoInput;
  }
  if (Object.keys(sessionPatch).length > 0) patch.session = sessionPatch;

  const codexPatch: NonNullable<NonNullable<ConfigPatch['runtime']>['codex']> = {};
  const codexModel = readString(codex, 'model');
  if (codexModel !== undefined) {
    codexPatch.model = codexModel;
    delete codex.model;
  }
  const codexMode = codexYoloMode(codex.mode);
  if (codexMode !== undefined) {
    codexPatch.yoloMode = codexMode;
    delete codex.mode;
  }
  const runtimeCodexProvider = codexProvider(codex.provider);
  if (runtimeCodexProvider !== undefined) {
    codexPatch.provider = runtimeCodexProvider;
    delete codex.provider;
  }
  const runtimeSandboxMode = sandboxMode(codex.sandboxMode);
  if (runtimeSandboxMode !== undefined) {
    codexPatch.sandboxMode = runtimeSandboxMode;
    delete codex.sandboxMode;
  }
  const networkAccess = readBoolean(codex, 'networkAccess');
  if (networkAccess !== undefined) {
    codexPatch.networkAccess = networkAccess;
    delete codex.networkAccess;
  }
  const codexEffort = reasoningEffort(codex.reasoningEffort);
  if (codexEffort !== undefined) {
    codexPatch.reasoningEffort = codexEffort;
    delete codex.reasoningEffort;
  }

  const claudePatch: NonNullable<NonNullable<ConfigPatch['runtime']>['claude']> = {};
  const claudeModel = readString(claude, 'model');
  if (claudeModel !== undefined) {
    claudePatch.model = claudeModel;
    delete claude.model;
  }
  const yoloMode = claudeYoloMode(claude.permissionMode);
  const permissionMode = claudePermissionMode(claude.permissionMode);
  if (yoloMode !== undefined || permissionMode !== undefined) {
    if (yoloMode !== undefined) claudePatch.yoloMode = yoloMode;
    if (permissionMode !== undefined) claudePatch.permissionMode = permissionMode;
    delete claude.permissionMode;
  }
  const runtimeClaudeProvider = claudeProvider(claude.provider);
  if (runtimeClaudeProvider !== undefined) {
    claudePatch.provider = runtimeClaudeProvider;
    delete claude.provider;
  }
  const claudeEffort = claudeReasoningEffort(claude.reasoningEffort);
  if (claudeEffort !== undefined) {
    claudePatch.reasoningEffort = claudeEffort;
    delete claude.reasoningEffort;
  }
  const idleTimeoutMinutes = readNonNegativeInteger(claude, 'idleTimeoutMinutes');
  if (idleTimeoutMinutes !== undefined) {
    claudePatch.idleTimeoutMinutes = idleTimeoutMinutes;
    delete claude.idleTimeoutMinutes;
  }

  if (Object.keys(codexPatch).length > 0 || Object.keys(claudePatch).length > 0) {
    patch.runtime = {
      ...(patch.runtime || {}),
      ...(Object.keys(codexPatch).length > 0 ? { codex: codexPatch } : {}),
      ...(Object.keys(claudePatch).length > 0 ? { claude: claudePatch } : {}),
    };
  }

  deleteEmptyContainers(cleanedSession);
  if (!readString(cleanedSession, 'id')) cleanedSession.id = sessionId;

  return {
    patch: hasPatchContent(patch) ? patch : null,
    cleanedSession,
  };
}

function atomicWriteJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

function prepareLegacySessionJsonConfigMigration(options: SessionJsonConfigMigrationOptions): PreparedSessionJsonConfigMigration | null {
  const dataSessionsJson = path.join(options.codelarkHome, 'data', 'sessions.json');
  let sessions: Record<string, unknown>;
  try {
    const parsed = JSON.parse(fs.readFileSync(dataSessionsJson, 'utf-8')) as unknown;
    sessions = isRecord(parsed) ? parsed : {};
  } catch {
    return null;
  }

  const paths = resolveConfigPaths({ codelarkHome: options.codelarkHome });
  const nextSessions: Record<string, unknown> = {};
  const writes: Array<{ file: string; patch: ConfigPatch }> = [];
  let migratedSessions = 0;

  for (const [sessionId, value] of Object.entries(sessions)) {
    if (!isRecord(value)) {
      nextSessions[sessionId] = value;
      continue;
    }
    const { patch, cleanedSession } = extractSessionPatch(sessionId, value);
    if (!patch) {
      nextSessions[sessionId] = value;
      continue;
    }
    nextSessions[sessionId] = options.pruneSessionJson ? cleanedSession : value;

    const file = sessionTomlPath(paths, sessionId);
    const current = readTomlConfig(file)?.patch || {};
    writes.push({ file, patch: mergePatch(current, patch) });
    migratedSessions += 1;
  }

  const prunedSessionsJson = Boolean(options.pruneSessionJson && JSON.stringify(nextSessions) !== JSON.stringify(sessions));
  if (writes.length === 0 && !prunedSessionsJson) {
    return null;
  }

  return {
    nextSessions,
    writes,
    migratedSessions,
    prunedSessionsJson,
  };
}

export function hasLegacySessionJsonConfig(options: Pick<SessionJsonConfigMigrationOptions, 'codelarkHome'>): boolean {
  return Boolean(prepareLegacySessionJsonConfigMigration({ ...options, pruneSessionJson: true }));
}

export function migrateLegacySessionJsonConfigToToml(options: SessionJsonConfigMigrationOptions): SessionJsonConfigMigrationResult {
  const prepared = prepareLegacySessionJsonConfigMigration(options);
  if (!prepared) return { changed: false, migratedSessions: 0, writtenFiles: [], prunedSessionsJson: false };

  const dataSessionsJson = path.join(options.codelarkHome, 'data', 'sessions.json');
  const writtenFiles: string[] = [];
  for (const write of prepared.writes) {
    writeTomlConfig(write.file, write.patch);
    writtenFiles.push(write.file);
  }

  if (prepared.prunedSessionsJson) atomicWriteJson(dataSessionsJson, prepared.nextSessions);

  return {
    changed: writtenFiles.length > 0 || prepared.prunedSessionsJson,
    migratedSessions: prepared.migratedSessions,
    writtenFiles,
    prunedSessionsJson: prepared.prunedSessionsJson,
  };
}
