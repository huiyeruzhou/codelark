import '../../setup/test-setup.js';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
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
    assert.match(packCheckSource, /process\.env\.npm_execpath/);
    assert.match(packCheckSource, /spawnSync\(process\.execPath/);
    assert.match(packCheckSource, /if \(result\.error\)/);
  });

  it('leaves native PTY binaries in their npm package for every bundled entrypoint', { timeout: 30000 }, async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'codelark-native-build-'));
    try {
      const scripts = path.join(tempDir, 'scripts');
      await mkdir(scripts, { recursive: true });
      const esbuildUrl = pathToFileURL(createRequire(import.meta.url).resolve('esbuild')).href;
      const source = fs.readFileSync(path.join(process.cwd(), 'scripts/build.js'), 'utf8')
        .replace("await import('esbuild')", `await import(${JSON.stringify(esbuildUrl)})`);
      await writeFile(path.join(scripts, 'build.js'), source);
      fs.copyFileSync(path.join(process.cwd(), 'scripts/build-preflight.js'), path.join(scripts, 'build-preflight.js'));
      await writeFile(path.join(tempDir, 'package.json'), JSON.stringify({ type: 'module', dependencies: { '@homebridge/node-pty-prebuilt-multiarch': '1' } }));
      const native = path.join(tempDir, 'node_modules/@homebridge/node-pty-prebuilt-multiarch');
      await mkdir(native, { recursive: true });
      await writeFile(path.join(native, 'package.json'), JSON.stringify({ main: 'index.cjs' }));
      await writeFile(path.join(native, 'index.cjs'), "module.exports = require('./pty.node');");
      await writeFile(path.join(native, 'pty.node'), 'native-binary-fixture');
      const entries = ['entrypoints/daemon', 'entrypoints/acp-host', 'operator-ui/server', 'entrypoints/cli', 'entrypoints/update-worker'];
      for (const entry of entries) {
        const file = path.join(tempDir, `src/${entry}.ts`);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, "export const load = () => import('@homebridge/node-pty-prebuilt-multiarch');");
      }
      await mkdir(path.join(tempDir, 'src/configuration'), { recursive: true });
      await writeFile(path.join(tempDir, 'src/configuration/defaults.toml'), '');
      const result = spawnSync(process.execPath, ['scripts/build.js'], { cwd: tempDir, encoding: 'utf8', timeout: 20000 });
      assert.equal(result.status, 0, result.stderr || String(result.error));
      for (const entry of ['daemon', 'acp-host', 'ui-server', 'cli', 'update-global-codelark']) {
        const output = fs.readFileSync(path.join(tempDir, `dist/${entry}.mjs`), 'utf8');
        assert.match(output, /import\(["']@homebridge\/node-pty-prebuilt-multiarch["']\)/);
        assert.doesNotMatch(output, /native-binary-fixture/);
      }
    } finally { await rm(tempDir, { recursive: true, force: true }); }
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
