import '../../setup/test-setup.js';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { createRuntimeShardIsolation } from '../../../../scripts/real-runtime-e2e-isolation.js';

describe('real runtime E2E isolation', () => {
  it('gives each Unix shard an independent tmux socket directory', {
    skip: process.platform === 'win32' ? 'Unix socket paths are not valid on Windows' : false,
  }, () => {
    const baseEnv = { PATH: process.env.PATH, TMUX: '/tmp/shared,1,0', TMUX_TMPDIR: '/tmp/shared' };
    const codex = createRuntimeShardIsolation('codex', { RUNTIME: 'codex' }, baseEnv, 'linux');
    const kimi = createRuntimeShardIsolation('kimi-provider', { RUNTIME: 'kimi' }, baseEnv, 'darwin');

    try {
      assert.ok(codex.tmuxTmpDir);
      assert.ok(kimi.tmuxTmpDir);
      assert.notEqual(codex.tmuxTmpDir, kimi.tmuxTmpDir);
      assert.equal(codex.env.TMUX, undefined);
      assert.equal(kimi.env.TMUX, undefined);
      assert.equal(codex.env.TMUX_TMPDIR, codex.tmuxTmpDir);
      assert.equal(kimi.env.TMUX_TMPDIR, kimi.tmuxTmpDir);
      assert.match(kimi.tmuxTmpDir, /^\/tmp\/clk-tmux-kimi-provider-/u);
      assert.ok(Buffer.byteLength(path.join(kimi.tmuxTmpDir, 'tmux-501', 'default')) < 104);
      assert.equal(codex.env.RUNTIME, 'codex');
      assert.equal(kimi.env.RUNTIME, 'kimi');
      assert.equal(fs.existsSync(codex.tmuxTmpDir), true);
      assert.equal(fs.existsSync(kimi.tmuxTmpDir), true);
    } finally {
      codex.cleanup();
      kimi.cleanup();
    }

    assert.equal(fs.existsSync(codex.tmuxTmpDir), false);
    assert.equal(fs.existsSync(kimi.tmuxTmpDir), false);
  });

  it('does not inject Unix tmux socket variables into Windows psmux shards', () => {
    const isolation = createRuntimeShardIsolation(
      'codex',
      { RUNTIME: 'codex' },
      { PATH: process.env.PATH, TMUX: 'inherited', TMUX_TMPDIR: 'inherited' },
      'win32',
    );

    assert.equal(isolation.tmuxTmpDir, undefined);
    assert.equal(isolation.env.TMUX, undefined);
    assert.equal(isolation.env.TMUX_TMPDIR, undefined);
    isolation.cleanup();
  });
});
