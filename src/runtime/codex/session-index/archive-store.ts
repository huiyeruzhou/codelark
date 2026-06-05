import fs from 'node:fs';
import path from 'node:path';

import { getArchivedSessionsRoot } from './paths.js';

export function extractThreadIdFromRolloutName(name: string): string | null {
  const match = name.match(/-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  return match?.[1] || null;
}

export function loadArchivedThreadIds(): Set<string> {
  const archivedRoot = getArchivedSessionsRoot();
  if (!fs.existsSync(archivedRoot)) return new Set();

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(archivedRoot, { withFileTypes: true });
  } catch {
    return new Set();
  }

  const ids = new Set<string>();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const threadId = extractThreadIdFromRolloutName(entry.name);
    if (threadId) ids.add(threadId);
  }
  return ids;
}

function uniqueArchivedSessionPath(filePath: string): string {
  const archivedRoot = getArchivedSessionsRoot();
  fs.mkdirSync(archivedRoot, { recursive: true });

  const parsed = path.parse(path.basename(filePath));
  let candidate = path.join(archivedRoot, path.basename(filePath));
  let suffix = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(archivedRoot, `${parsed.name}.${suffix}${parsed.ext}`);
    suffix += 1;
  }
  return candidate;
}

export function moveSessionFileToArchive(filePath: string): string {
  const archivedPath = uniqueArchivedSessionPath(filePath);
  try {
    fs.renameSync(filePath, archivedPath);
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error
      ? (error as { code?: string }).code
      : '';
    if (code !== 'EXDEV') throw error;
    fs.copyFileSync(filePath, archivedPath);
    fs.unlinkSync(filePath);
  }
  return archivedPath;
}
