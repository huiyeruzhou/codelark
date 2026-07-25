import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createTmuxCliCore, type TmuxCore } from '../../../../bridge/tmux/core.js';

function installFakeTmux(): { binDir: string; logPath: string; core: TmuxCore } {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-unit-fake-tmux-core-'));
  const logPath = path.join(binDir, 'tmux.log');
  const scriptPath = path.join(binDir, 'fake-tmux.cjs');
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
  return {
    binDir,
    logPath,
    core: createTmuxCliCore({ executable: process.execPath, prefixArgs: [scriptPath] }),
  };
}

describe('TmuxCore', () => {
  it('enables extended keys for TUIs that distinguish Enter from newline', async () => {
    const fakeTmux = installFakeTmux();
    const oldFakeLog = process.env.TMUX_FAKE_LOG;
    process.env.TMUX_FAKE_LOG = fakeTmux.logPath;

    try {
      assert.equal(await fakeTmux.core.ensureExtendedKeys?.(), 'tmux set-option -g extended-keys on');
      assert.equal(fs.readFileSync(fakeTmux.logPath, 'utf-8').trim(), 'set-option -g extended-keys on');
    } finally {
      if (oldFakeLog === undefined) delete process.env.TMUX_FAKE_LOG;
      else process.env.TMUX_FAKE_LOG = oldFakeLog;
      fs.rmSync(fakeTmux.binDir, { recursive: true, force: true });
    }
  });

  it('captures only the extra history needed for the requested final screen lines', async () => {
    const fakeTmux = installFakeTmux();
    const oldFakeLog = process.env.TMUX_FAKE_LOG;
    const oldPaneHeight = process.env.TMUX_FAKE_PANE_HEIGHT;
    process.env.TMUX_FAKE_LOG = fakeTmux.logPath;
    process.env.TMUX_FAKE_PANE_HEIGHT = '10';

    try {
      const capture = await fakeTmux.core.capturePane('alpha', 20);

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
      if (oldFakeLog === undefined) delete process.env.TMUX_FAKE_LOG;
      else process.env.TMUX_FAKE_LOG = oldFakeLog;
      if (oldPaneHeight === undefined) delete process.env.TMUX_FAKE_PANE_HEIGHT;
      else process.env.TMUX_FAKE_PANE_HEIGHT = oldPaneHeight;
      fs.rmSync(fakeTmux.binDir, { recursive: true, force: true });
    }
  });

  it('does not ask tmux for negative zero history when the pane is already tall enough', async () => {
    const fakeTmux = installFakeTmux();
    const oldFakeLog = process.env.TMUX_FAKE_LOG;
    const oldPaneHeight = process.env.TMUX_FAKE_PANE_HEIGHT;
    process.env.TMUX_FAKE_LOG = fakeTmux.logPath;
    process.env.TMUX_FAKE_PANE_HEIGHT = '30';

    try {
      const capture = await fakeTmux.core.capturePane('alpha', 20);

      assert.equal(capture.screen.split('\n').length, 20);
      assert.match(capture.command, /tmux capture-pane -t alpha -p -S 0/);
      assert.doesNotMatch(capture.command, /-S -0/);
      assert.deepEqual(fs.readFileSync(fakeTmux.logPath, 'utf-8').trim().split(/\r?\n/), [
        'display-message -p -t alpha #{pane_height}',
        'capture-pane -t alpha -p -S 0',
      ]);
    } finally {
      if (oldFakeLog === undefined) delete process.env.TMUX_FAKE_LOG;
      else process.env.TMUX_FAKE_LOG = oldFakeLog;
      if (oldPaneHeight === undefined) delete process.env.TMUX_FAKE_PANE_HEIGHT;
      else process.env.TMUX_FAKE_PANE_HEIGHT = oldPaneHeight;
      fs.rmSync(fakeTmux.binDir, { recursive: true, force: true });
    }
  });

  it('sends chunk-leading whitespace literally instead of passing it through paste-buffer', async () => {
    const fakeTmux = installFakeTmux();
    const oldFakeLog = process.env.TMUX_FAKE_LOG;
    process.env.TMUX_FAKE_LOG = fakeTmux.logPath;

    try {
      const result = await fakeTmux.core.sendActions('alpha', [{
        type: 'literal',
        text: `${'a'.repeat(512)} leading-space`,
      }]);

      assert.ok(result.commands.includes("tmux send-keys -t alpha -l ' '"));
      assert.equal(result.commands.filter((command) => command.includes('paste-buffer')).length, 2);
    } finally {
      if (oldFakeLog === undefined) delete process.env.TMUX_FAKE_LOG;
      else process.env.TMUX_FAKE_LOG = oldFakeLog;
      fs.rmSync(fakeTmux.binDir, { recursive: true, force: true });
    }
  });
});
