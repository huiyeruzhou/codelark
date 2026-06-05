import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { getCodexHome } from './paths.js';

export interface VisibleCodexThreadRow {
  id: string;
  updatedAtMs: number;
}

function getCodexStateDbPath(): string | null {
  const codexHome = getCodexHome();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(codexHome, { withFileTypes: true });
  } catch {
    return null;
  }

  const candidates = entries
    .filter((entry) => entry.isFile() && /^state_\d+\.sqlite$/i.test(entry.name))
    .map((entry) => path.join(codexHome, entry.name))
    .sort((left, right) => {
      try {
        return fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs;
      } catch {
        return 0;
      }
    });

  return candidates[0] || null;
}

export function parseCodexUpdatedAtValue(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1_000_000_000_000 ? value : value * 1000;
  }
  if (typeof value === 'string') {
    const numeric = Number(value.trim());
    if (Number.isFinite(numeric)) {
      return numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
    }
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

export function loadVisibleCodexThreads(limit?: number): VisibleCodexThreadRow[] | null {
  const dbPath = getCodexStateDbPath();
  if (!dbPath || !fs.existsSync(dbPath)) return null;

  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const hasLimit = typeof limit === 'number' && Number.isFinite(limit) && limit > 0;
    const sql = `
      SELECT id, updated_at
      FROM threads
      WHERE archived = 0
      ORDER BY updated_at DESC
      ${hasLimit ? 'LIMIT ?' : ''}
    `;
    const rows = hasLimit
      ? db.prepare(sql).all(Math.max(1, Math.floor(limit!))) as Array<{ id?: string; updated_at?: string | number }>
      : db.prepare(sql).all() as Array<{ id?: string; updated_at?: string | number }>;

    const ids = rows
      .map((row) => {
        const id = typeof row.id === 'string' ? row.id.trim() : '';
        if (!id) return null;
        return {
          id,
          updatedAtMs: parseCodexUpdatedAtValue(row.updated_at),
        } satisfies VisibleCodexThreadRow;
      })
      .filter((row): row is VisibleCodexThreadRow => Boolean(row));

    return ids.length > 0 ? ids : null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}
