import crypto from 'node:crypto';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';

export interface CursorLegacyCliToAcpMigrationResult {
  migrated: boolean;
  alreadyPresent?: boolean;
  storePath?: string;
  cwd?: string;
  runEverything?: boolean;
}

function resolveCursorConfigRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.CURSOR_CONFIG_DIR?.trim()
    || (env.XDG_CONFIG_HOME?.trim() ? path.join(env.XDG_CONFIG_HOME, 'cursor') : path.join(os.homedir(), '.cursor'));
}

export function cursorAcpSessionStorePath(sessionId: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error('Cursor ACP 会话 ID 无效。');
  return path.join(resolveCursorConfigRoot(env), 'acp-sessions', sessionId, 'store.db');
}

function readCursorStoreMetadata(storePath: string): { name?: string; isRunEverything?: boolean } {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(storePath, { readOnly: true });
    const row = db.prepare("SELECT value FROM meta WHERE key = '0'").get() as { value?: string | Uint8Array } | undefined;
    if (!row?.value) return {};
    const raw = typeof row.value === 'string' ? row.value : Buffer.from(row.value).toString('utf8');
    const metadata = JSON.parse(raw.startsWith('{') ? raw : Buffer.from(raw, 'hex').toString('utf8'));
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
    return {
      name: typeof metadata.name === 'string' && metadata.name.trim() ? metadata.name.trim() : undefined,
      isRunEverything: typeof metadata.isRunEverything === 'boolean' ? metadata.isRunEverything : undefined,
    };
  } finally {
    db?.close();
  }
}

function findLegacyCursorCliStorePath(
  sessionId: string,
  preferredCwd?: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const chatsRoot = path.join(resolveCursorConfigRoot(env), 'chats');
  if (!fs.existsSync(chatsRoot)) return null;
  if (preferredCwd?.trim()) {
    const resolvedCwd = path.resolve(preferredCwd.trim());
    const cwdHash = crypto.createHash('md5').update(resolvedCwd).digest('hex');
    const directCandidate = path.join(chatsRoot, cwdHash, sessionId, 'store.db');
    if (fs.existsSync(directCandidate)) return directCandidate;
  }
  try {
    for (const entry of fs.readdirSync(chatsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(chatsRoot, entry.name, sessionId, 'store.db');
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    return null;
  }
  return null;
}

function writeAcpSessionMetaJson(acpDir: string, cwd?: string, title?: string): void {
  const metaPath = path.join(acpDir, 'meta.json');
  if (fs.existsSync(metaPath)) return;
  const payload: Record<string, unknown> = {
    schemaVersion: 1,
    cwd: cwd?.trim() ? path.resolve(cwd.trim()) : '',
  };
  if (title?.trim()) payload.title = title.trim();
  const tmpPath = `${metaPath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmpPath, metaPath);
}

/**
 * Losslessly copy a legacy Cursor CLI/tmux SQLite session store into Cursor's
 * ACP session directory (`~/.cursor/acp-sessions/<sessionId>/store.db` + `meta.json`).
 * Never mutates or deletes the original `~/.cursor/chats/...` session store.
 */
export function migrateLegacyCursorCliSessionToAcp(
  sessionId: string,
  preferredCwd?: string,
  env: NodeJS.ProcessEnv = process.env,
): CursorLegacyCliToAcpMigrationResult {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) return { migrated: false };
  const acpStorePath = cursorAcpSessionStorePath(sessionId, env);
  const acpDir = path.dirname(acpStorePath);
  const resolvedCwd = preferredCwd?.trim() ? path.resolve(preferredCwd.trim()) : undefined;

  if (fs.existsSync(acpStorePath)) {
    let meta: { name?: string; isRunEverything?: boolean } = {};
    try {
      meta = readCursorStoreMetadata(acpStorePath);
    } catch {
      // Keep existing store readable even if optional metadata cannot be parsed here.
    }
    writeAcpSessionMetaJson(acpDir, resolvedCwd, meta.name);
    return {
      migrated: true,
      alreadyPresent: true,
      storePath: acpStorePath,
      cwd: resolvedCwd,
      runEverything: meta.isRunEverything === true,
    };
  }

  const legacyStorePath = findLegacyCursorCliStorePath(sessionId, resolvedCwd, env);
  if (!legacyStorePath) return { migrated: false };

  let meta: { name?: string; isRunEverything?: boolean } = {};
  try {
    meta = readCursorStoreMetadata(legacyStorePath);
  } catch {
    return { migrated: false };
  }

  fs.mkdirSync(acpDir, { recursive: true, mode: 0o700 });
  const tmpStorePath = path.join(acpDir, `.store.db.migrating.${process.pid}.${Date.now()}`);
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(legacyStorePath, { readOnly: true });
    const escapedTarget = tmpStorePath.replaceAll("'", "''");
    db.exec(`VACUUM INTO '${escapedTarget}'`);
    db.close();
    db = undefined;
    fs.chmodSync(tmpStorePath, 0o600);
    fs.renameSync(tmpStorePath, acpStorePath);
    writeAcpSessionMetaJson(acpDir, resolvedCwd, meta.name);
    return {
      migrated: true,
      alreadyPresent: false,
      storePath: acpStorePath,
      cwd: resolvedCwd,
      runEverything: meta.isRunEverything === true,
    };
  } catch {
    try {
      if (fs.existsSync(tmpStorePath)) fs.unlinkSync(tmpStorePath);
    } catch {
      // best effort cleanup
    }
    return { migrated: false };
  } finally {
    db?.close();
  }
}

/** Read only the requested ACP session's permission flag before a restrictive resume. */
export function assertCursorAcpRestrictiveResume(sessionId: string, env: NodeJS.ProcessEnv = process.env): void {
  const storePath = cursorAcpSessionStorePath(sessionId, env);
  let db: DatabaseSync | undefined;
  let runEverything: unknown;
  try {
    db = new DatabaseSync(storePath, { readOnly: true });
    const row = db.prepare("SELECT value FROM meta WHERE key = '0'").get() as { value?: string | Uint8Array } | undefined;
    if (!row?.value) throw new Error('missing metadata');
    const raw = typeof row.value === 'string' ? row.value : Buffer.from(row.value).toString('utf8');
    const metadata = JSON.parse(raw.startsWith('{') ? raw : Buffer.from(raw, 'hex').toString('utf8'));
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('invalid metadata');
    runEverything = metadata.isRunEverything;
    if (runEverything !== undefined && typeof runEverything !== 'boolean') throw new Error('unknown permission metadata');
  } catch {
    throw new Error('无法确认此 Cursor ACP 会话保存的权限策略，未在 cursorForce=false 下恢复或提交输入。');
  } finally { db?.close(); }
  if (runEverything === true) {
    throw new Error('此 Cursor ACP 会话保存了 Run Everything；当前原生版本不能在保留历史时关闭它，未假装降低权限或提交输入。');
  }
}
