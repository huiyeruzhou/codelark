import '../../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

describe('cross-platform fake tmux CLI', () => {
  it('persists session lifecycle and exposes a ready capture', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-fake-tmux-cli-'));
    const helperPath = path.resolve('src', '__tests__', 'helpers', 'fake-tmux-cli.cjs');
    const logPath = path.join(tempDir, 'tmux.log');
    const statePath = path.join(tempDir, 'sessions');
    const env = {
      ...process.env,
      TMUX_FAKE_LOG: logPath,
      TMUX_FAKE_STATE_PATH: statePath,
    };
    const run = (args: string[]) => execFileAsync(process.execPath, [helperPath, ...args], { env });

    try {
      await run(['new-session', '-d', '-s', 'test-session', '--', 'ignored command']);
      await run(['has-session', '-t', 'test-session']);
      const capture = await run(['capture-pane', '-t', 'test-session', '-p', '-S', '-20']);
      assert.match(capture.stdout, /OpenAI Codex/);

      await run(['kill-session', '-t', 'test-session']);
      await assert.rejects(run(['has-session', '-t', 'test-session']));
      assert.match(fs.readFileSync(logPath, 'utf-8'), /new-session -d -s test-session/);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('never writes capture counters into the working directory when TMUX_FAKE_LOG is unset', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-fake-tmux-cwd-'));
    const helperPath = path.resolve('src', '__tests__', 'helpers', 'fake-tmux-cli.cjs');
    const statePath = path.join(cwd, '..', `${path.basename(cwd)}.sessions`);
    const env: NodeJS.ProcessEnv = { ...process.env, TMUX_FAKE_STATE_PATH: statePath };
    delete env.TMUX_FAKE_LOG;
    const run = (args: string[]) => execFileAsync(process.execPath, [helperPath, ...args], { env, cwd });

    try {
      await run(['new-session', '-d', '-s', 'codex_0000:0.0', '--', 'ignored']);
      await run(['capture-pane', '-t', 'codex_0000:0.0', '-p']);
      assert.deepEqual(fs.readdirSync(cwd), [], 'fake tmux leaked files into the working directory');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(statePath, { force: true });
    }
  });
});
