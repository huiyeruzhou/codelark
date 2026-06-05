import '../../setup/test-setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
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
  assert.match(output, /\[hot-update\] dispatch command: bash scripts\/hot-update-bridge\.sh --run --pull/);
  assert.match(output, /\[hot-update\] git pull: planned/);
  assert.match(output, /\[hot-update\] npm run build: planned/);
  assert.match(output, /\[hot-update\] npm test: planned/);
  assert.match(output, /\[hot-update\] restart: planned/);
  assert.doesNotMatch(output, /Dispatched CodeLark hot update/);
  assert.doesNotMatch(output, /\[hot-update\] started /);
  assert.ok(output.indexOf('[hot-update] npm run build: planned') < output.indexOf('[hot-update] restart: planned'));
  assert.ok(output.indexOf('[hot-update] npm test: planned') < output.indexOf('[hot-update] restart: planned'));
});
