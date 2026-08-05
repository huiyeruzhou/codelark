import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function createRuntimeShardIsolation(
  shardName,
  shardEnv,
  baseEnv = process.env,
  platform = process.platform,
) {
  const env = { ...baseEnv, ...shardEnv };
  delete env.TMUX;
  delete env.TMUX_TMPDIR;

  if (platform === 'win32') {
    return { env, tmuxTmpDir: undefined, cleanup() {} };
  }

  const safeName = shardName.replace(/[^a-z0-9_-]+/giu, '-');
  const tmuxTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `codelark-runtime-${safeName}-tmux-`));
  env.TMUX_TMPDIR = tmuxTmpDir;
  return {
    env,
    tmuxTmpDir,
    cleanup() {
      spawnSync('tmux', ['kill-server'], { env, stdio: 'ignore', windowsHide: true });
      fs.rmSync(tmuxTmpDir, { recursive: true, force: true });
    },
  };
}
