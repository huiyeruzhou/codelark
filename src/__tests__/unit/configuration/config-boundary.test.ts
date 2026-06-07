import '../../setup/test-setup.js';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

function listSourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') return [];
      return listSourceFiles(fullPath);
    }
    return entry.isFile() && entry.name.endsWith('.ts') ? [fullPath] : [];
  });
}

describe('configuration module boundaries', () => {
  it('keeps the legacy config facade out of production imports', () => {
    const sourceRoot = path.join(process.cwd(), 'src');
    const offenders = listSourceFiles(sourceRoot)
      .filter((file) => path.relative(sourceRoot, file) !== path.join('configuration', 'index.ts'))
      .filter((file) => {
        const source = fs.readFileSync(file, 'utf-8');
        return /from\s+['"][^'"]*configuration\/index\.js['"]/.test(source);
      })
      .map((file) => path.relative(process.cwd(), file));

    assert.deepEqual(offenders, []);
  });
});
