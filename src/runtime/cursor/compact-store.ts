import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

// Keep unknown protobuf fields byte-for-byte. Only a private CLI snapshot's
// GoalState status is paused, so opening the TUI cannot resume business work.
function fields(bytes: Buffer): Array<{ no: number; raw: Buffer; value: Buffer }> {
  let pos = 0;
  const varint = () => { let n = 0; for (let shift = 0; shift < 56 && pos < bytes.length; shift += 7) {
    const b = bytes[pos++]!; n += (b & 127) * 2 ** shift; if (b < 128) return n;
  } throw new Error('Invalid Cursor protobuf'); };
  const result = [];
  while (pos < bytes.length) {
    const start = pos, tag = varint(), wire = tag % 8;
    let value: Buffer;
    if (wire === 2) { const length = varint(); value = bytes.subarray(pos, pos + length); pos += length; }
    else { const begin = pos; if (wire === 0) varint(); else if (wire === 1) pos += 8; else if (wire === 5) pos += 4; else throw new Error('Unknown Cursor protobuf'); value = bytes.subarray(begin, pos); }
    if (pos > bytes.length) throw new Error('Truncated Cursor protobuf');
    result.push({ no: Math.floor(tag / 8), raw: bytes.subarray(start, pos), value });
  }
  return result;
}
function varint(n: number): Buffer {
  const bytes = []; while (n > 127) { bytes.push((n & 127) | 128); n = Math.floor(n / 128); } return Buffer.from([...bytes, n]);
}
function field(no: number, value: Buffer): Buffer { return Buffer.concat([varint(no * 8 + 2), varint(value.length), value]); }
function root(db: DatabaseSync) {
  const row = db.prepare("SELECT value FROM meta WHERE key = '0'").get() as { value: string | Uint8Array };
  const raw = typeof row.value === 'string' ? row.value : Buffer.from(row.value).toString('utf8');
  const hex = !raw.startsWith('{'), meta = JSON.parse(hex ? Buffer.from(raw, 'hex').toString('utf8') : raw);
  const blob = db.prepare('SELECT data FROM blobs WHERE id = ?').get(meta.latestRootBlobId) as { data: Uint8Array };
  const bytes = Buffer.from(blob.data);
  if (createHash('sha256').update(bytes).digest('hex') !== meta.latestRootBlobId) throw new Error('无法核实 Cursor 原生状态格式。');
  return { hex, meta, bytes, parts: fields(bytes) };
}
export function readCursorCompactState(file: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const r = root(db), summary = r.parts.find(f => f.no === 6)?.value;
    if (summary && (summary.length !== 32 || !db.prepare('SELECT 1 FROM blobs WHERE id = ?').get(summary.toString('hex')))) throw new Error('Cursor 摘要引用无效。');
    return { root: r.meta.latestRootBlobId as string, summary: summary?.toString('hex'),
      goal: r.parts.find(f => f.no === 32)?.value,
      turns: r.parts.filter(f => f.no === 8).map(f => f.value.toString('hex')),
      messages: r.parts.filter(f => f.no === 1).length };
  } finally { db.close(); }
}
/** Call only on the private compaction copy, never a live ACP store. */
export function setCompactCopyGoal(file: string, goal: Buffer | undefined, pause = false): void {
  if (!goal) return;
  if (pause) {
    const parts = fields(goal); const status = parts.find(f => f.no === 4);
    if (!status || status.value.length !== 1 || ![1, 2, 3, 4].includes(status.value[0]!)) throw new Error('未知的 Cursor 目标状态，未启动 CLI。');
    if (status.value[0] !== 1) return;
    goal = Buffer.concat(parts.map(f => f.no === 4 ? Buffer.from([32, 2]) : f.raw));
  }
  const db = new DatabaseSync(file);
  try {
    const r = root(db);
    if (r.parts.filter(f => f.no === 32).length !== 1) throw new Error('Cursor 压缩副本丢失目标状态。');
    const bytes = Buffer.concat(r.parts.map(f => f.no === 32 ? field(32, goal!) : f.raw));
    r.meta.latestRootBlobId = createHash('sha256').update(bytes).digest('hex');
    const json = JSON.stringify(r.meta);
    db.exec('BEGIN IMMEDIATE');
    db.prepare('INSERT OR IGNORE INTO blobs(id,data) VALUES (?,?)').run(r.meta.latestRootBlobId, bytes);
    db.prepare("UPDATE meta SET value = ? WHERE key = '0'").run(r.hex ? Buffer.from(json).toString('hex') : json);
    db.exec('COMMIT');
  } finally { db.close(); }
}

/** Compare and commit under one writer lock. Preserve original session metadata,
 * permissions and every old blob; only add native summary blobs and move root. */
export function commitCursorCompaction(source: string, copy: string, expectedRoot: string, signal: AbortSignal): void {
  const db = new DatabaseSync(source);
  try {
    db.prepare('ATTACH DATABASE ? AS compact').run(copy);
    db.exec('BEGIN IMMEDIATE');
    const original = root(db);
    if (original.meta.latestRootBlobId !== expectedRoot) throw new Error('压缩期间原始会话已变化，未覆盖新内容。');
    const compacted = readCursorCompactState(copy);
    signal.throwIfAborted();
    db.exec('INSERT OR IGNORE INTO main.blobs(id,data) SELECT id,data FROM compact.blobs');
    original.meta.latestRootBlobId = compacted.root;
    const json = JSON.stringify(original.meta);
    db.prepare("UPDATE main.meta SET value = ? WHERE key = '0'").run(original.hex ? Buffer.from(json).toString('hex') : json);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  } finally { db.close(); }
}
