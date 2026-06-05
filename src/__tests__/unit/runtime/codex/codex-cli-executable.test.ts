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

  it('falls back to node_modules only when it is the only Codex CLI on PATH', () => {
    assert.equal(
      resolveCodexCliExecutable({
        env: { PATH: '/repo/node_modules/.bin' },
        platform: 'linux',
        fileExists: (filePath) => filePath === '/repo/node_modules/.bin/codex',
      }),
      '/repo/node_modules/.bin/codex',
    );
  });

  it('uses CODELARK_CODEX_CLI_PATH as an explicit override', () => {
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
  });

  it('reads process.env when called without arguments', () => {
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
});
