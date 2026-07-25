import '../../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  isNodeModulesBinPath,
  resolveCodexCliExecutable,
} from '../../../../runtime/codex/cli-executable.js';

describe('codex-cli-executable', () => {
  it('prefers a global Codex CLI over project node_modules bins', () => {
    const existing = new Set([
      '/repo/node_modules/.bin/codex',
      '/home/user/.local/bin/codex',
    ]);

    assert.equal(
      resolveCodexCliExecutable({
        env: { PATH: '/repo/node_modules/.bin:/home/user/.local/bin' },
        platform: 'linux',
        fileExists: (filePath) => existing.has(filePath),
      }),
      '/home/user/.local/bin/codex',
    );
  });

  it('rejects node_modules even when it is the only Codex CLI on PATH', () => {
    assert.throws(
      () => resolveCodexCliExecutable({
        env: { PATH: '/repo/node_modules/.bin' },
        platform: 'linux',
        fileExists: (filePath) => filePath === '/repo/node_modules/.bin/codex',
      }),
      /must be installed globally.*node_modules\/\.bin\/codex/,
    );
  });

  it('rejects package-local node_modules when Codex is missing from PATH', () => {
    assert.throws(
      () => resolveCodexCliExecutable({
        env: { PATH: '/usr/bin:/bin' },
        platform: 'linux',
        packageSearchRoots: ['/repo/apps/codelark/dist/runtime/codex'],
        fileExists: (filePath) => filePath === '/repo/apps/codelark/node_modules/.bin/codex',
      }),
      /Refused local candidates: \/repo\/apps\/codelark\/node_modules\/\.bin\/codex/,
    );
  });

  it('does not override a global Codex CLI with the package-local fallback', () => {
    const existing = new Set([
      '/home/user/.local/bin/codex',
      '/repo/apps/codelark/node_modules/.bin/codex',
    ]);

    assert.equal(
      resolveCodexCliExecutable({
        env: { PATH: '/home/user/.local/bin' },
        platform: 'linux',
        packageSearchRoots: ['/repo/apps/codelark/dist/runtime/codex'],
        fileExists: (filePath) => existing.has(filePath),
      }),
      '/home/user/.local/bin/codex',
    );
  });

  it('honors explicit Codex CLI overrides while still rejecting node_modules paths', () => {
    assert.equal(
      resolveCodexCliExecutable({
        env: {
          CODELARK_CODEX_CLI_PATH: '/custom/codex',
          PATH: '/repo/node_modules/.bin:/home/user/.local/bin',
        },
        platform: 'linux',
        fileExists: () => false,
      }),
      '/custom/codex',
    );
    assert.throws(
      () => resolveCodexCliExecutable({
        env: {
          CODELARK_CODEX_CLI_PATH: '/repo/node_modules/.bin/codex',
          PATH: '/home/user/.local/bin',
        },
        platform: 'linux',
        fileExists: () => true,
      }),
      /Refused local candidates: \/repo\/node_modules\/\.bin\/codex/,
    );

    const oldOverride = process.env.CODELARK_CODEX_CLI_PATH;
    try {
      process.env.CODELARK_CODEX_CLI_PATH = '/env/codex';
      assert.equal(resolveCodexCliExecutable(), '/env/codex');
    } finally {
      if (oldOverride === undefined) delete process.env.CODELARK_CODEX_CLI_PATH;
      else process.env.CODELARK_CODEX_CLI_PATH = oldOverride;
    }
  });

  it('recognizes node_modules .bin directories on POSIX and Windows paths', () => {
    assert.equal(isNodeModulesBinPath('/repo/node_modules/.bin'), true);
    assert.equal(isNodeModulesBinPath('C:\\repo\\node_modules\\.bin'), true);
    assert.equal(isNodeModulesBinPath('/home/user/.local/bin'), false);
  });

  it('reads the case-preserved Windows Path environment key', () => {
    assert.equal(resolveCodexCliExecutable({
      env: { Path: 'C:\\ci-bin;C:\\repo\\node_modules\\.bin' },
      platform: 'win32',
      fileExists: (filePath) => filePath === 'C:\\ci-bin\\codex.cmd',
    }), 'C:\\ci-bin\\codex.cmd');
  });
});
