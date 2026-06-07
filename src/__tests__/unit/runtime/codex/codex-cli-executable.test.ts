import '../../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

  it('falls back to the bundled OpenAI VS Code extension Codex binary', () => {
    const extensionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-codex-ext-'));
    const olderCodex = path.join(extensionsDir, 'openai.chatgpt-26.602.30954-linux-x64', 'bin', 'linux-x86_64', 'codex');
    const newerCodex = path.join(extensionsDir, 'openai.chatgpt-26.602.40724-linux-x64', 'bin', 'linux-x86_64', 'codex');
    fs.mkdirSync(path.dirname(olderCodex), { recursive: true });
    fs.mkdirSync(path.dirname(newerCodex), { recursive: true });
    fs.writeFileSync(olderCodex, '#!/usr/bin/env sh\nexit 0\n', 'utf-8');
    fs.writeFileSync(newerCodex, '#!/usr/bin/env sh\nexit 0\n', 'utf-8');
    fs.chmodSync(olderCodex, 0o755);
    fs.chmodSync(newerCodex, 0o755);

    try {
      assert.equal(
        resolveCodexCliExecutable({
          env: {
            VSCODE_EXTENSIONS: extensionsDir,
            PATH: '/usr/local/bin:/usr/bin',
          },
          platform: 'linux',
          arch: 'x64',
          fileExists: (filePath) => filePath === olderCodex || filePath === newerCodex,
        }),
        newerCodex,
      );
    } finally {
      fs.rmSync(extensionsDir, { recursive: true, force: true });
    }
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
