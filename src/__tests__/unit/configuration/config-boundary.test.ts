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

function filesImportingLegacyFacade(root: string, options: { skipTests?: boolean; allowed?: Set<string> } = {}): string[] {
  const allowed = options.allowed || new Set<string>();
  return listSourceFiles(root)
    .filter((file) => {
      if (options.skipTests && path.relative(root, file).split(path.sep).includes('__tests__')) return false;
      return true;
    })
    .filter((file) => !allowed.has(path.relative(process.cwd(), file)))
    .filter((file) => {
      const source = fs.readFileSync(file, 'utf-8');
      return /from\s+['"][^'"]*configuration\/index\.js['"]/.test(source);
    })
    .map((file) => path.relative(process.cwd(), file));
}

describe('configuration module boundaries', () => {
  it('keeps the legacy config facade out of production imports', () => {
    const sourceRoot = path.join(process.cwd(), 'src');
    const offenders = filesImportingLegacyFacade(sourceRoot, {
      skipTests: true,
    });

    assert.deepEqual(offenders, []);
  });

  it('keeps non-facade tests from importing the legacy config facade', () => {
    const sourceRoot = path.join(process.cwd(), 'src');
    const offenders = filesImportingLegacyFacade(path.join(sourceRoot, '__tests__'));

    assert.deepEqual(offenders, []);
  });

  it('keeps scripts from importing the legacy config facade', () => {
    const scriptsRoot = path.join(process.cwd(), 'scripts');
    const offenders = filesImportingLegacyFacade(scriptsRoot);
    assert.deepEqual(offenders, []);
  });

  it('keeps legacy adapter modules independent from the facade re-export', () => {
    const legacySource = fs.readFileSync(path.join(process.cwd(), 'src', 'configuration', 'legacy.ts'), 'utf-8');
    assert.equal(/from\s+['"]\.\/index\.js['"]/.test(legacySource), false);
  });

  it('keeps current config paths from exposing legacy input files', () => {
    const pathsSource = fs.readFileSync(path.join(process.cwd(), 'src', 'configuration', 'paths.ts'), 'utf-8');

    assert.doesNotMatch(pathsSource, /config\.env/);
    assert.doesNotMatch(pathsSource, /config\.json/);
    assert.doesNotMatch(pathsSource, /CONFIG_PATH/);
    assert.doesNotMatch(pathsSource, /CONFIG_JSON_PATH/);
  });
});
