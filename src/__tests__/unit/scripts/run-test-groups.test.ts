import '../../setup/test-setup.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

it('runs real CLI tests alone and retains every other test group', { timeout: 15000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-test-scheduling-'));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  fs.copyFileSync('scripts/run-test-groups.js', path.join(root, 'scripts/run-test-groups.js'));
  fs.writeFileSync(path.join(root, 'limit.mjs'), "import os from 'node:os'; os.availableParallelism = () => 2;");
  fs.writeFileSync(path.join(root, 'scripts/run-tests.js'), `
    import fs from 'node:fs';
    import { setTimeout } from 'node:timers/promises';
    const native = process.argv.includes('--local-e2e');
    const active = fs.readdirSync('.').filter(name => name.startsWith('active-'));
    if (native && active.length) process.exit(23);
    if (!native && fs.existsSync('native-running')) process.exit(24);
    const marker = 'active-' + process.pid;
    fs.writeFileSync(marker, '');
    if (native) fs.writeFileSync('native-running', '');
    await setTimeout(200);
    if (!native && fs.existsSync('native-running')) process.exit(25);
    if (native) fs.unlinkSync('native-running');
    fs.unlinkSync(marker);
    console.log('ℹ tests 1\\nℹ pass 1\\nℹ fail 0\\nℹ duration_ms 200');
  `);
  try {
    const result = await promisify(execFile)(process.execPath, ['--import', './limit.mjs', 'scripts/run-test-groups.js'], {
      cwd: root, env: process.env, timeout: 12000,
    });
    assert.match(result.stdout, /total tests=12 .*pass=12 fail=0/);
    const completedNative = result.stderr.indexOf('completed local-e2e exit=0');
    assert.ok(completedNative >= 0);
    assert.ok(result.stderr.indexOf('started unit-1') > completedNative);
    assert.equal((result.stderr.match(/started /g) || []).length, 12);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
