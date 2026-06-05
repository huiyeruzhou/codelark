import fs from 'node:fs';
import path from 'node:path';

export function walkSessionFiles(dirPath: string, target: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      walkSessionFiles(entryPath, target);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      target.push(entryPath);
    }
  }
}
