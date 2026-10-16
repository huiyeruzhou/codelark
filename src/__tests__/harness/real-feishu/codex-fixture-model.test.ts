import '../../setup/test-setup.js';
import { it } from 'node:test';
import { execFileSync } from 'node:child_process';

it('verifies native title and quoted-input boundaries in the standalone model fixture', () => {
  execFileSync(process.execPath, ['--import', 'tsx', '--test', 'scripts/fixtures/codex-app-server-lifecycle.test.ts'], {
    cwd: process.cwd(), env: process.env, timeout: 15_000, stdio: 'pipe',
  });
});
