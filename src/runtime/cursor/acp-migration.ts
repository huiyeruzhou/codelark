import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';

/** Caller must first stop the source execution and confirm it is no longer writing.
 * Clone to a new native identity; never make TUI and ACP share a live database.
 */
export async function cloneCursorCliSessionForAcp(options: { storePath: string; cwd: string }): Promise<{ sessionId: string; storePath: string }> {
  const source = fs.realpathSync(options.storePath);
  const chats = path.dirname(path.dirname(path.dirname(source)));
  if (path.basename(source) !== 'store.db' || path.basename(chats) !== 'chats') {
    throw new Error('仅支持从 Cursor CLI chats 中复制已停止的会话。');
  }
  const sessionId = randomUUID();
  const directory = path.join(path.dirname(chats), 'acp-sessions', sessionId);
  fs.mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 });
  fs.mkdirSync(directory, { mode: 0o700 });
  const storePath = path.join(directory, 'store.db');
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(source, { readOnly: true });
    if (!database.prepare("SELECT value FROM meta WHERE key = '0'").get()) throw new Error('Cursor 源会话没有可恢复的原生状态。');
    await backup(database, storePath);
    fs.chmodSync(storePath, 0o600);
    fs.writeFileSync(path.join(directory, 'meta.json'), JSON.stringify({ schemaVersion: 1, cwd: fs.realpathSync(options.cwd) }), { mode: 0o600 });
    return { sessionId, storePath };
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  } finally { database?.close(); }
}
