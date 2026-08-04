import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

describe('test runner tmux isolation', () => {
  it('does not inherit the caller tmux socket', async (t: TestContext) => {
    assert.equal(process.env.TMUX, undefined);
    assert.equal(process.env.TMUX_PANE, undefined);
    assert.equal(process.env.NODE_TEST_CONTEXT, 'child-v8');
    assert.match(process.env.NODE_TEST_WORKER_ID || '', /^\d+$/u);

    const tmuxTempDir = process.env.TMUX_TMPDIR;
    assert.ok(tmuxTempDir);
    assert.equal(fs.existsSync(tmuxTempDir), true);

    if (process.platform === 'win32') return;
    const tmuxAvailable = await execFileAsync('tmux', ['-V'])
      .then(() => true)
      .catch(() => false);
    if (!tmuxAvailable) {
      t.skip('tmux is not available');
      return;
    }

    const sessionName = `codelark-test-isolation-${process.pid}`;
    try {
      await execFileAsync('tmux', ['new-session', '-d', '-s', sessionName, 'sleep 30']);
      const socketPath = (await execFileAsync(
        'tmux',
        ['display-message', '-p', '-t', sessionName, '#{socket_path}'],
      )).stdout.trim();
      const canonicalTmuxTempDir = fs.realpathSync.native(tmuxTempDir);
      const canonicalSocketPath = fs.realpathSync.native(socketPath);
      assert.equal(path.relative(canonicalTmuxTempDir, canonicalSocketPath).startsWith('..'), false);
    } finally {
      await execFileAsync('tmux', ['kill-session', '-t', sessionName]).catch(() => undefined);
    }
  });
});
