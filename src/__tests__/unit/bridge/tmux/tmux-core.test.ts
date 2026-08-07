import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createTmuxCliCore,
  usesFileBackedTmuxPasteBuffer,
  type TmuxCore,
} from '../../../../bridge/tmux/core.js';

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

function createScriptedTmuxCore(binDir: string, source: string): TmuxCore {
  const scriptPath = path.join(binDir, 'fake-tmux.cjs');
  fs.writeFileSync(scriptPath, source, 'utf-8');
  return createTmuxCliCore({ executable: process.execPath, prefixArgs: [scriptPath] });
}

describe('TmuxCore', () => {
  it('uses file-backed paste buffers for Windows psmux', () => {
    assert.equal(usesFileBackedTmuxPasteBuffer('win32'), true);
    assert.equal(usesFileBackedTmuxPasteBuffer('linux'), false);
    assert.equal(usesFileBackedTmuxPasteBuffer('darwin'), false);
  });

  it('keeps a file-backed paste buffer until tmux loads it and then removes it', async () => {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-unit-tmux-file-buffer-'));
    const logPath = path.join(binDir, 'tmux.log');
    const contentPath = path.join(binDir, 'loaded-content.txt');
    const scriptPath = path.join(binDir, 'fake-tmux.cjs');
    fs.writeFileSync(scriptPath, `
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, args.join(' ') + '\\n');
if (args[0] === 'load-buffer') {
  fs.writeFileSync(${JSON.stringify(contentPath)}, fs.readFileSync(args[3], 'utf8'));
}
`, 'utf-8');
    const core = createTmuxCliCore({
      executable: process.execPath,
      prefixArgs: [scriptPath],
      fileBackedPasteBuffer: true,
    });

    try {
      await core.sendActions(
        'windows-file-buffer',
        [{ type: 'literal', text: '第一行\nsecond line' }],
        { forcePasteLiterals: true },
      );
      assert.equal(fs.readFileSync(contentPath, 'utf-8'), '第一行\nsecond line');
      const loadLine = fs.readFileSync(logPath, 'utf-8')
        .split(/\r?\n/u)
        .find((line) => line.startsWith('load-buffer '));
      assert.ok(loadLine);
      const bufferFilePath = loadLine.split(' ').at(-1) || '';
      assert.equal(fs.existsSync(bufferFilePath), false);
    } finally {
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  });

  it('retries when new-session is lost while the previous tmux server shuts down', async () => {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-unit-tmux-start-race-'));
    const statePath = path.join(binDir, 'launch-count');
    const logPath = path.join(binDir, 'tmux.log');
    const core = createScriptedTmuxCore(binDir, `
const fs = require('node:fs');
const args = process.argv.slice(2);
const statePath = ${JSON.stringify(statePath)};
fs.appendFileSync(${JSON.stringify(logPath)}, args.join(' ') + '\\n');
if (args[0] === 'new-session') {
  const count = fs.existsSync(statePath) ? Number(fs.readFileSync(statePath, 'utf8')) : 0;
  fs.writeFileSync(statePath, String(count + 1));
  process.exit(0);
}
if (args[0] === 'has-session') {
  const count = fs.existsSync(statePath) ? Number(fs.readFileSync(statePath, 'utf8')) : 0;
  if (count < 2) {
    process.stderr.write('no server running on /tmp/clk-test/tmux/default\\n');
    process.exit(1);
  }
}
`);

    try {
      const result = await core.ensureDetachedSession({ name: 'race', command: 'kimi -r session_1' });
      const log = fs.readFileSync(logPath, 'utf-8');
      assert.equal(result.existed, false);
      assert.equal((log.match(/new-session -d -s race/g) || []).length, 2);
      assert.equal((log.match(/has-session -t race/g) || []).length, 3);
    } finally {
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  });

  it('treats a missing isolated tmux socket as no session', async () => {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-unit-tmux-no-server-'));
    const core = createScriptedTmuxCore(binDir, `
process.stderr.write('error connecting to /tmp/codelark-test/tmux/default (No such file or directory)\\n');
process.exit(1);
`);

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

  it('falls back when capture-pane reports a client/server mismatch with exit code 0', {
    skip: process.platform === 'win32' ? 'native tmux client/server fallback is Unix-only; Windows CI uses psmux' : false,
  }, async () => {
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
    const core = createScriptedTmuxCore(binDir, `
process.stderr.write('invalid option: extended-keys\\n');
process.exit(1);
`);

    try {
      assert.equal(await core.ensureExtendedKeys?.(), '');
    } finally {
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  });

  it('uses bracketed paste for a medium literal when the caller requires reliable TUI input', async () => {
    const fakeTmux = installFakeTmux();
    const oldFakeLog = process.env.TMUX_FAKE_LOG;
    process.env.TMUX_FAKE_LOG = fakeTmux.logPath;
    const prompt = [
      '我想和你讨论庄子为什么在尧见四子之前插入宋人卖章甫的故事。',
      '',
      '请结合无用之用、真知视野和小大之辩分析这一段。'.repeat(6),
    ].join('\n');

    try {
      assert.ok(Array.from(prompt).length < 512);
      const result = await fakeTmux.core.sendActions(
        'codex-medium-prompt',
        [{ type: 'literal', text: prompt }, { type: 'key', key: 'Enter' }],
        { delayMs: 0, forcePasteLiterals: true },
      );

      assert.match(result.commands.join('\n'), /tmux load-buffer -b clk-paste-/);
      assert.match(result.commands.join('\n'), /tmux paste-buffer -d -p -b clk-paste-/);
      assert.match(result.commands.join('\n'), /tmux send-keys -t codex-medium-prompt End/);
      assert.match(result.commands.join('\n'), /tmux send-keys -t codex-medium-prompt Enter/);
      assert.doesNotMatch(result.commands.join('\n'), /send-keys -t codex-medium-prompt -l/);
    } finally {
      if (oldFakeLog === undefined) delete process.env.TMUX_FAKE_LOG;
      else process.env.TMUX_FAKE_LOG = oldFakeLog;
      fs.rmSync(fakeTmux.binDir, { recursive: true, force: true });
    }
  });

  it('reloads and retries a psmux paste buffer until it becomes available', async () => {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-unit-tmux-buffer-race-'));
    const statePath = path.join(binDir, 'paste-count');
    const logPath = path.join(binDir, 'tmux.log');
    const core = createScriptedTmuxCore(binDir, `
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, args.join(' ') + '\\n');
if (args[0] === 'paste-buffer') {
  const count = fs.existsSync(${JSON.stringify(statePath)}) ? Number(fs.readFileSync(${JSON.stringify(statePath)}, 'utf8')) : 0;
  fs.writeFileSync(${JSON.stringify(statePath)}, String(count + 1));
  if (count < 2) {
    process.stderr.write('psmux: no buffer clk-paste-test\\n');
    process.exit(1);
  }
}
`);

    try {
      await core.sendActions(
        'kimi-buffer-race',
        [{ type: 'literal', text: 'retry this prompt' }, { type: 'key', key: 'Enter' }],
        { delayMs: 0, forcePasteLiterals: true },
      );
      const log = fs.readFileSync(logPath, 'utf-8');
      assert.equal((log.match(/load-buffer -b clk-paste-/g) || []).length, 3);
      assert.equal((log.match(/paste-buffer -d -p -b clk-paste-/g) || []).length, 3);
      assert.match(log, /send-keys -t kimi-buffer-race Enter/);
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
