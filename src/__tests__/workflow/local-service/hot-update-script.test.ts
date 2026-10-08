import '../../setup/test-setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

test('hot-update script dry-run validates cwd, node runtime, env paths, and safe order without dispatching', async () => {
  const projectRoot = process.cwd();
  const codelarkHome = path.join(process.env.CODEX_HOME || projectRoot, 'hot-update-dry-run-home');
  const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8')) as { name?: string };

  assert.equal(packageJson.name, 'codelark');
  assert.equal(fs.existsSync(path.join(projectRoot, 'scripts', 'hot-update-bridge.sh')), true);

  const result = await execFileAsync(
    'bash',
    ['scripts/hot-update-bridge.sh', '--dry-run', '--pull'],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        CODELARK_HOME: codelarkHome,
        npm_config_prefix: '/tmp/clk-incompatible-npm-prefix',
      },
      timeout: 30_000,
      maxBuffer: 128 * 1024,
    },
  );

  const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
  assert.match(output, /\[hot-update\] dry-run: yes/);
  assert.match(output, new RegExp(`\\[hot-update\\] project: ${projectRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(output, new RegExp(`\\[hot-update\\] pwd: ${projectRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(output, new RegExp(`\\[hot-update\\] CODELARK_HOME: ${codelarkHome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(output, /\[hot-update\] node: v24\./);
  assert.match(output, /\[hot-update\] worker args: --run --pull/);
  assert.match(output, new RegExp(`\\[hot-update\\] dispatch command: bash ${projectRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\/scripts\/hot-update-bridge\\.sh --run --pull`));
  assert.match(output, /\[hot-update\] git pull: planned/);
  assert.match(output, /\[hot-update\] npm run build: planned/);
  assert.match(output, /\[hot-update\] npm test: planned/);
  assert.match(output, new RegExp(`\\[hot-update\\] global CLI sync: npm install --global --no-audit --no-fund ${projectRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(output, /\[hot-update\] restart: planned/);
  assert.doesNotMatch(output, /Dispatched CodeLark hot update/);
  assert.doesNotMatch(output, /\[hot-update\] started /);
  assert.ok(output.indexOf('[hot-update] npm run build: planned') < output.indexOf('[hot-update] restart: planned'));
  assert.ok(output.indexOf('[hot-update] npm test: planned') < output.indexOf('[hot-update] restart: planned'));
});

test('hot-update dispatcher uses launchd with an absolute worker path on macOS', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-hot-update-launchd-'));
  const bin = path.join(root, 'bin');
  const calls = path.join(root, 'launchctl-args.txt');
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(bin);
  fs.copyFileSync('scripts/hot-update-bridge.sh', path.join(root, 'scripts/hot-update-bridge.sh'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"codelark"}');
  fs.writeFileSync(path.join(bin, 'uname'), '#!/bin/sh\necho Darwin\n', { mode: 0o755 });
  fs.writeFileSync(
    path.join(bin, 'launchctl'),
    '#!/bin/sh\nprintf "%s\\n" "$@" > "$CLK_TEST_LAUNCHCTL_CALLS"\n',
    { mode: 0o755 },
  );
  try {
    const result = await execFileAsync('bash', ['scripts/hot-update-bridge.sh', '--skip-tests'], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        CODELARK_HOME: home,
        CLK_TEST_LAUNCHCTL_CALLS: calls,
      },
      timeout: 30_000,
    });
    const args = fs.readFileSync(calls, 'utf8').trim().split('\n');
    assert.deepEqual(args.slice(0, 2), ['submit', '-l']);
    assert.match(args[2] ?? '', /^com\.codelark\.hot-update\.\d{8}-\d{6}\.\d+$/);
    assert.equal(args.at(-4), '/bin/bash');
    assert.equal(args.at(-3), fs.realpathSync(path.join(root, 'scripts', 'hot-update-bridge.sh')));
    assert.deepEqual(args.slice(-2), ['--run', '--skip-tests']);
    assert.match(result.stdout, /Dispatched CodeLark hot update\./);
    assert.match(result.stdout, /Launchd label: com\.codelark\.hot-update\./);
    assert.doesNotMatch(result.stdout, /PID:/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('hot-update worker preserves the supplied instance environment across stop and start', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-hot-update-env-'));
  const bin = path.join(root, 'bin');
  const calls = path.join(root, 'calls.jsonl');
  for (const dir of ['scripts', 'dist', 'bin']) fs.mkdirSync(path.join(root, dir));
  fs.copyFileSync('scripts/hot-update-bridge.sh', path.join(root, 'scripts/hot-update-bridge.sh'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"codelark"}');
  fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'dist/cli.mjs'), `
    import fs from 'node:fs';
    fs.appendFileSync(process.env.CLK_TEST_CALLS, JSON.stringify({
      action: process.argv[2], home: process.env.CODELARK_HOME,
      key: process.env.LITELLM_KEY, options: process.env.NODE_OPTIONS,
    }) + '\\n');
  `);
  try {
    const home = path.join(root, 'instance');
    const result = await execFileAsync('bash', ['scripts/hot-update-bridge.sh', '--run', '--skip-tests'], {
      cwd: root,
      env: {
        ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        CODELARK_HOME: home, CLK_TEST_CALLS: calls,
        LITELLM_KEY: 'test-instance-secret', NODE_OPTIONS: '--no-warnings',
      },
      timeout: 30_000,
    });
    assert.deepEqual(fs.readFileSync(calls, 'utf8').trim().split('\n').map((line) => JSON.parse(line)), [
      { action: 'stop', home, key: 'test-instance-secret', options: '--no-warnings' },
      { action: 'start', home, key: 'test-instance-secret', options: '--no-warnings' },
    ]);
    assert.match(result.stdout, /\[hot-update\] started \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{4}/);
    assert.match(result.stdout, /\[hot-update\] completed \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{4}/);
    assert.doesNotMatch(result.stdout + result.stderr, /test-instance-secret/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
