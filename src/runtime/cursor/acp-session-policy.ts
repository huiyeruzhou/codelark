import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';

/** Read only the requested ACP session's permission flag before a restrictive resume. */
export function assertCursorAcpRestrictiveResume(sessionId: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error('Cursor ACP 会话 ID 无效。');
  const root = env.CURSOR_CONFIG_DIR?.trim() || (env.XDG_CONFIG_HOME?.trim() ? path.join(env.XDG_CONFIG_HOME, 'cursor') : path.join(os.homedir(), '.cursor'));
  let db: DatabaseSync | undefined;
  let runEverything: unknown;
  try {
    db = new DatabaseSync(path.join(root, 'acp-sessions', sessionId, 'store.db'), { readOnly: true });
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
