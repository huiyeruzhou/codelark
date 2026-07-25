import fs from 'node:fs';
import path from 'node:path';

export function resolveInstalledCodelarkVersion(options: {
  entrypoint?: string;
  cwd?: string;
} = {}): string | null {
  const entrypoint = options.entrypoint || process.argv[1] || '';
  const candidates = [
    entrypoint ? path.resolve(path.dirname(entrypoint), '..', 'package.json') : '',
    path.resolve(options.cwd || process.cwd(), 'package.json'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf-8')) as {
        name?: unknown;
        version?: unknown;
      };
      if (parsed.name === 'codelark' && typeof parsed.version === 'string' && parsed.version.trim()) {
        return parsed.version.trim();
      }
    } catch {
      // Try the next package location.
    }
  }
  return null;
}
