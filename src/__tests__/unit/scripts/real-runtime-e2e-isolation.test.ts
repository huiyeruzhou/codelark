import '../../setup/test-setup.js';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

import { createRuntimeShardIsolation } from '../../../../scripts/real-runtime-e2e-isolation.js';

describe('real runtime E2E isolation', () => {
  it('keeps nested macOS fixture sockets short even when the inherited TMPDIR is long', {
    skip: process.platform === 'win32' ? 'Unix socket paths are not valid on Windows' : false,
  }, () => {
    const inheritedTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-long-runner-tmp-'));
    const longTmpDir = path.join(inheritedTmpDir, 'runner-private-var-folders-'.repeat(3));
    fs.mkdirSync(longTmpDir);
    const baseEnv = { ...process.env, TMPDIR: longTmpDir };
    const isolation = createRuntimeShardIsolation('codex', {}, baseEnv, 'darwin');
    try {
      // 真实子进程的 os.tmpdir()，与 Codex/Claude 在 shard 内再次创建 socket 的入口相同。
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
        const paths = [];
        for (const prefix of ['clk-real-codex-socket-first-chat-', 'clk-real-codex-socket-new-group-',
          'clk-real-claude-auto-forward-socket-', 'clk-real-claude-tmux-socket-']) {
          const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
          try { paths.push(path.join(fs.realpathSync(root), 'tmux-501', 'default')); }
          finally { fs.rmSync(root, { recursive: true, force: true }); }
        }
        process.stdout.write(JSON.stringify(paths));
      `], { env: isolation.env, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      const sockets = JSON.parse(result.stdout) as string[];
      assert.equal(sockets.length, 4);
      for (const socket of sockets) assert.ok(Buffer.byteLength(socket) < 104, socket);
      assert.equal(baseEnv.TMPDIR, longTmpDir, '不能改写调用者环境');
    } finally {
      isolation.cleanup();
      fs.rmSync(inheritedTmpDir, { recursive: true, force: true });
    }
  });

  it('gives each Unix shard an independent tmux socket directory', {
    skip: process.platform === 'win32' ? 'Unix socket paths are not valid on Windows' : false,
  }, () => {
    const baseEnv = { PATH: process.env.PATH, TMUX: '/tmp/shared,1,0', TMUX_TMPDIR: '/tmp/shared', TMPDIR: '/unchanged-linux-tmp' };
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
      assert.equal(codex.env.TMPDIR, baseEnv.TMPDIR);
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
      { PATH: process.env.PATH, TMUX: 'inherited', TMUX_TMPDIR: 'inherited', TMPDIR: 'unchanged', TEMP: 'C:\\fixture-temp', TMP: 'C:\\fixture-tmp' },
      'win32',
    );

    assert.equal(isolation.tmuxTmpDir, undefined);
    assert.equal(isolation.env.TMUX, undefined);
    assert.equal(isolation.env.TMUX_TMPDIR, undefined);
    assert.equal(isolation.env.TMPDIR, 'unchanged');
    assert.equal(isolation.env.TEMP, 'C:\\fixture-temp');
    assert.equal(isolation.env.TMP, 'C:\\fixture-tmp');
    isolation.cleanup();
  });
});
