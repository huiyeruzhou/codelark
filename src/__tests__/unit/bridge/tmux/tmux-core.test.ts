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

function installExecutable(filePath: string, source: string): void {
  fs.writeFileSync(filePath, `#!/usr/bin/env node\n${source}`, 'utf-8');
  fs.chmodSync(filePath, 0o755);
}

describe('TmuxCore', () => {
  it('treats a missing isolated tmux socket as no session', async () => {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-unit-tmux-no-server-'));
    const executablePath = path.join(binDir, 'tmux');
    installExecutable(executablePath, `
process.stderr.write('error connecting to /tmp/codelark-test/tmux/default (No such file or directory)\\n');
process.exit(1);
`);
    const core = createTmuxCliCore({ executable: executablePath });

    try {
      assert.deepEqual(await core.hasSession('alpha'), {
        exists: false,
        command: 'tmux has-session -t alpha',
      });
      const listed = await core.listSessions();
      assert.deepEqual(listed.sessions, []);
      assert.match(listed.command, /^tmux list-sessions -F /);
    } finally {
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  });

  it('falls back when capture-pane reports a client/server mismatch with exit code 0', async () => {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-unit-tmux-compat-'));
    const incompatiblePath = path.join(binDir, 'tmux-new');
    const compatiblePath = path.join(binDir, 'tmux-old');
    const logPath = path.join(binDir, 'compatible.log');
    installExecutable(incompatiblePath, `
if (process.argv[2] === 'list-panes') {
  process.stdout.write('%1\\n');
} else if (process.argv[2] === 'capture-pane') {
  process.stderr.write('server version is too old for client\\n');
  process.exit(0);
}
`);
    installExecutable(compatiblePath, `
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, args.join(' ') + '\\n');
if (args[0] === 'list-panes') process.stdout.write('%1\\n');
if (args[0] === 'display-message') process.stdout.write('10\\n');
if (args[0] === 'capture-pane' && args.includes('-t')) process.stdout.write('OpenAI Codex\\n\\n› \\n');
`);
    const core = createTmuxCliCore({ candidateExecutables: [incompatiblePath, compatiblePath] });

    try {
      const capture = await core.capturePane('alpha', 20);

      assert.match(capture.screen, /OpenAI Codex/);
      assert.match(capture.command, new RegExp(compatiblePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(fs.readFileSync(logPath, 'utf-8'), /capture-pane -p -S 0 -t %1/);
    } finally {
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  });

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

  it('continues when an older tmux does not support extended-keys', async () => {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-unit-tmux-old-keys-'));
    const executablePath = path.join(binDir, 'tmux');
    installExecutable(executablePath, `
process.stderr.write('invalid option: extended-keys\\n');
process.exit(1);
`);
    const core = createTmuxCliCore({ executable: executablePath });

    try {
      assert.equal(await core.ensureExtendedKeys?.(), '');
    } finally {
      fs.rmSync(binDir, { recursive: true, force: true });
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
