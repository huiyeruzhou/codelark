import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { tmuxCore } from '../../../../bridge/tmux/core.js';

function installFakeTmux(): { binDir: string; logPath: string } {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-unit-fake-tmux-core-'));
  const logPath = path.join(binDir, 'tmux.log');
  const scriptPath = path.join(binDir, 'fake-tmux.cjs');
  const tmuxPath = path.join(binDir, process.platform === 'win32' ? 'tmux.cmd' : 'tmux');
  fs.writeFileSync(logPath, '', 'utf-8');
  fs.writeFileSync(scriptPath, `
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TMUX_FAKE_LOG, args.join(' ') + '\\n');
if (args[0] === 'display-message') {
  process.stdout.write((process.env.TMUX_FAKE_PANE_HEIGHT || '10') + '\\n');
} else if (args[0] === 'capture-pane') {
  for (let index = 1; index <= 25; index += 1) {
    process.stdout.write('line-' + String(index).padStart(2, '0') + '\\n');
  }
}
`, 'utf-8');
  if (process.platform === 'win32') {
    fs.writeFileSync(tmuxPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`, 'utf-8');
  } else {
    fs.writeFileSync(tmuxPath, `#!/usr/bin/env sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`, 'utf-8');
    fs.chmodSync(tmuxPath, 0o755);
  }
  return { binDir, logPath };
}

describe('TmuxCore', () => {
  it('enables extended keys for TUIs that distinguish Enter from newline', async () => {
    const fakeTmux = installFakeTmux();
    const oldPath = process.env.PATH || '';
    const oldFakeLog = process.env.TMUX_FAKE_LOG;
    process.env.PATH = `${fakeTmux.binDir}${path.delimiter}${oldPath}`;
    process.env.TMUX_FAKE_LOG = fakeTmux.logPath;

    try {
      assert.equal(await tmuxCore.ensureExtendedKeys?.(), 'tmux set-option -g extended-keys on');
      assert.equal(fs.readFileSync(fakeTmux.logPath, 'utf-8').trim(), 'set-option -g extended-keys on');
    } finally {
      process.env.PATH = oldPath;
      if (oldFakeLog === undefined) delete process.env.TMUX_FAKE_LOG;
      else process.env.TMUX_FAKE_LOG = oldFakeLog;
      fs.rmSync(fakeTmux.binDir, { recursive: true, force: true });
    }
  });

  it('captures only the extra history needed for the requested final screen lines', async () => {
    const fakeTmux = installFakeTmux();
    const oldPath = process.env.PATH || '';
    const oldFakeLog = process.env.TMUX_FAKE_LOG;
    const oldPaneHeight = process.env.TMUX_FAKE_PANE_HEIGHT;
    process.env.PATH = `${fakeTmux.binDir}${path.delimiter}${oldPath}`;
    process.env.TMUX_FAKE_LOG = fakeTmux.logPath;
    process.env.TMUX_FAKE_PANE_HEIGHT = '10';

    try {
      const capture = await tmuxCore.capturePane('alpha', 20);

      assert.equal(capture.screen.split('\n').length, 20);
      assert.match(capture.screen, /^line-06\n/);
      assert.match(capture.screen, /line-25$/);
      assert.match(capture.command, /tmux display-message -p -t alpha '#\{pane_height\}'/);
      assert.match(capture.command, /tmux capture-pane -t alpha -p -S -10/);
      assert.deepEqual(fs.readFileSync(fakeTmux.logPath, 'utf-8').trim().split(/\r?\n/), [
        'display-message -p -t alpha #{pane_height}',
        'capture-pane -t alpha -p -S -10',
      ]);
    } finally {
      process.env.PATH = oldPath;
      if (oldFakeLog === undefined) delete process.env.TMUX_FAKE_LOG;
      else process.env.TMUX_FAKE_LOG = oldFakeLog;
      if (oldPaneHeight === undefined) delete process.env.TMUX_FAKE_PANE_HEIGHT;
      else process.env.TMUX_FAKE_PANE_HEIGHT = oldPaneHeight;
      fs.rmSync(fakeTmux.binDir, { recursive: true, force: true });
    }
  });

  it('does not ask tmux for negative zero history when the pane is already tall enough', async () => {
    const fakeTmux = installFakeTmux();
    const oldPath = process.env.PATH || '';
    const oldFakeLog = process.env.TMUX_FAKE_LOG;
    const oldPaneHeight = process.env.TMUX_FAKE_PANE_HEIGHT;
    process.env.PATH = `${fakeTmux.binDir}${path.delimiter}${oldPath}`;
    process.env.TMUX_FAKE_LOG = fakeTmux.logPath;
    process.env.TMUX_FAKE_PANE_HEIGHT = '30';

    try {
      const capture = await tmuxCore.capturePane('alpha', 20);

      assert.equal(capture.screen.split('\n').length, 20);
      assert.match(capture.command, /tmux capture-pane -t alpha -p -S 0/);
      assert.doesNotMatch(capture.command, /-S -0/);
      assert.deepEqual(fs.readFileSync(fakeTmux.logPath, 'utf-8').trim().split(/\r?\n/), [
        'display-message -p -t alpha #{pane_height}',
        'capture-pane -t alpha -p -S 0',
      ]);
    } finally {
      process.env.PATH = oldPath;
      if (oldFakeLog === undefined) delete process.env.TMUX_FAKE_LOG;
      else process.env.TMUX_FAKE_LOG = oldFakeLog;
      if (oldPaneHeight === undefined) delete process.env.TMUX_FAKE_PANE_HEIGHT;
      else process.env.TMUX_FAKE_PANE_HEIGHT = oldPaneHeight;
      fs.rmSync(fakeTmux.binDir, { recursive: true, force: true });
    }
  });
});
