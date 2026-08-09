import '../../setup/test-setup.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  buildSpawnSpec,
  findNpmExecutable,
  runGlobalUpdateWorker,
} from '../../../bridge/update/update-worker.js';

describe('global CodeLark version update worker', () => {
  it('builds native Unix commands and cmd.exe wrappers for Windows npm.cmd', () => {
    assert.deepEqual(buildSpawnSpec('/usr/bin/npm', ['view', 'codelark'], 'linux'), {
      command: '/usr/bin/npm',
      args: ['view', 'codelark'],
    });
    const windows = buildSpawnSpec('C:\\Node\\npm.cmd', ['install', '-g', 'codelark@1.2.3'], 'win32', 'cmd.exe');
    assert.equal(windows.command, 'cmd.exe');
    assert.deepEqual(windows.args.slice(0, 3), ['/d', '/s', '/c']);
    assert.match(windows.args[3] || '', /npm\.cmd/iu);
    assert.match(windows.args[3] || '', /codelark@1\.2\.3/u);
  });

  it('prefers npm next to Node and supports npm.cmd discovery on Windows', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-update-npm-'));
    try {
      const nodePath = path.join(root, 'node.exe');
      const npmPath = path.join(root, 'npm.cmd');
      fs.writeFileSync(nodePath, '');
      fs.writeFileSync(npmPath, '');
      assert.equal(findNpmExecutable({ nodePath, pathValue: '', platform: 'win32' }), npmPath);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('checks latest, installs globally, refreshes the bundled skill, then restarts only the new CLI', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-global-update-'));
    const logPath = path.join(root, 'commands.jsonl');
    const globalRoot = path.join(root, 'global');
    const cliPath = path.join(globalRoot, 'codelark', 'dist', 'cli.mjs');
    const npmPath = path.join(root, 'fake-npm.mjs');
    fs.mkdirSync(path.dirname(cliPath), { recursive: true });
    fs.writeFileSync(npmPath, [
      "import fs from 'node:fs';",
      `fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(['npm', ...process.argv.slice(2)]) + '\\n');`,
      `if (process.argv[2] === 'view') process.stdout.write(JSON.stringify('9.9.10'));`,
      `if (process.argv[2] === 'root') process.stdout.write(${JSON.stringify(globalRoot)} + '\\n');`,
    ].join('\n'));
    fs.writeFileSync(cliPath, [
      "import fs from 'node:fs';",
      `fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(['codelark', ...process.argv.slice(2)]) + '\\n');`,
    ].join('\n'));
    try {
      await runGlobalUpdateWorker({ expectedVersion: '9.9.9', npmExecutable: npmPath });
      const commands = fs.readFileSync(logPath, 'utf-8').trim().split(/\r?\n/u).map((line) => JSON.parse(line));
      assert.deepEqual(commands, [
        ['npm', 'view', 'codelark', 'version', '--json'],
        ['npm', 'install', '-g', '--yes', 'codelark@9.9.10'],
        ['npm', 'root', '-g'],
        ['codelark', 'install-skills', 'codelark', 'condition-monitor'],
        ['codelark', 'stop'],
        ['codelark', 'start'],
      ]);
      assert.doesNotMatch(JSON.stringify(commands), /git|pull|build|test/iu);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects callback-supplied shell syntax before running npm', async () => {
    await assert.rejects(
      runGlobalUpdateWorker({ expectedVersion: '1.2.3;touch /tmp/nope', npmExecutable: '/missing' }),
      /invalid expected CodeLark version/u,
    );
  });
});
