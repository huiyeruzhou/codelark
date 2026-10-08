import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { findCodexDesktopRestartScript, restartCodexDesktop } from '../../../../runtime/codex/desktop-restart.js';

test('finds the packaged Desktop restart script from the project root', () => {
  assert.equal(findCodexDesktopRestartScript(process.cwd()), path.join(process.cwd(), 'scripts', 'restart-codex-desktop.sh'));
});

test('runs the Desktop restart script through bash without interpolating shell input', async () => {
  let call: { file: string; args: string[]; cwd: string } | undefined;
  const result = await restartCodexDesktop({
    platform: 'darwin',
    cwd: process.cwd(),
    run: async (file, args, options) => {
      call = { file, args, cwd: options.cwd };
      return { stdout: 'restarted' };
    },
  });
  assert.deepEqual(call, {
    file: '/bin/bash',
    args: [path.join(process.cwd(), 'scripts', 'restart-codex-desktop.sh')],
    cwd: process.cwd(),
  });
  assert.equal(result.output, 'restarted');
});

test('rejects Desktop restart on non-macOS hosts', async () => {
  await assert.rejects(restartCodexDesktop({ platform: 'linux' }), /仅支持 macOS/);
});
