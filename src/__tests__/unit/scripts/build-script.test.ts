import '../../setup/test-setup.js';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';

import {
  findMissingPackageJsonRuntimeDependencies,
  formatMissingRuntimeDependenciesMessage,
} from '../../../../scripts/build-preflight.js';

describe('build script', () => {
  it('keeps build runtime checks and bundled defaults in the publish path', () => {
    const buildSource = fs.readFileSync(path.join(process.cwd(), 'scripts', 'build.js'), 'utf-8');
    const packCheckSource = fs.readFileSync(path.join(process.cwd(), 'scripts', 'check-npm-pack.js'), 'utf-8');

    assert.match(buildSource, /nodeMajor\s*<\s*24/);
    assert.match(buildSource, /requires Node\.js 24 or newer/);
    assert.match(buildSource, /target:\s*'node24'/);
    assert.doesNotMatch(buildSource, /target:\s*'node20'/);
    assert.match(buildSource, /findMissingPackageJsonRuntimeDependencies/);
    assert.match(buildSource, /await import\('esbuild'\)/);
    assert.ok(
      buildSource.indexOf('findMissingPackageJsonRuntimeDependencies') < buildSource.indexOf("await import('esbuild')"),
    );
    assert.match(buildSource, /copyFile\('src\/configuration\/defaults\.toml', 'dist\/defaults\.toml'\)/);
    assert.match(buildSource, /dist\/defaults\.toml/);
    assert.match(packCheckSource, /dist\/defaults\.toml/);
  });

  it('reports missing package.json runtime dependencies by installed package directory', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'codelark-build-preflight-'));

    try {
      await mkdir(path.join(tempDir, 'node_modules', 'installed-package'), { recursive: true });
      await mkdir(path.join(tempDir, 'node_modules', '@scope', 'installed-package'), { recursive: true });
      await writeFile(path.join(tempDir, 'node_modules', 'installed-package', 'package.json'), '{}\n');
      await writeFile(path.join(tempDir, 'node_modules', '@scope', 'installed-package', 'package.json'), '{}\n');
      await writeFile(
        path.join(tempDir, 'package.json'),
        JSON.stringify(
          {
            dependencies: {
              '@scope/installed-package': '1.0.0',
              'installed-package': '1.0.0',
              'missing-package': '1.0.0',
            },
          },
          null,
          2,
        ),
      );

      assert.deepEqual(
        await findMissingPackageJsonRuntimeDependencies(pathToFileURL(path.join(tempDir, 'package.json'))),
        ['missing-package'],
      );
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  it('formats missing dependency install guidance', () => {
    const message = formatMissingRuntimeDependenciesMessage(['pino']);

    assert.match(message, /package\.json runtime dependencies are not installed/);
    assert.match(message, /  - pino/);
    assert.match(message, /npm ci/);
    assert.match(message, /npm install/);
    assert.match(message, /npm run build/);
  });
});
