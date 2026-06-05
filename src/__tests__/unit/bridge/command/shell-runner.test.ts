import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCodexSandboxArgs,
  detectCodexSandboxCliStyleFromHelp,
} from '../../../../bridge/command/shell-runner.js';

describe('shell command runner args', () => {
  it('builds codex sandbox args with the network profile', () => {
    const request = {
      command: 'curl baidu.com',
      cwd: '/tmp/codelark-shell',
      networkAccess: true,
      sandboxMode: 'workspace-write',
      shell: '/bin/bash',
      timeoutMs: 60_000,
    } as const;

    assert.deepEqual(buildCodexSandboxArgs(request), [
      'sandbox',
      '-c',
      'permissions.codelark_shell_workspace_network.extends=":workspace"',
      '-c',
      'permissions.codelark_shell_workspace_network.network.enabled=true',
      '-c',
      'permissions.codelark_shell_workspace_network.network.mode="full"',
      '--permissions-profile',
      'codelark_shell_workspace_network',
      '--cd',
      '/tmp/codelark-shell',
      '/bin/bash',
      '-lc',
      'curl baidu.com',
    ]);

    assert.deepEqual(buildCodexSandboxArgs(request, 'linux-subcommand').slice(0, 2), ['sandbox', 'linux']);
  });

  it('detects current and legacy codex sandbox CLI help forms', () => {
    assert.equal(detectCodexSandboxCliStyleFromHelp([
      'Usage: codex sandbox [OPTIONS]',
      '  --permissions-profile <PROFILE>',
    ].join('\n')), 'top-level');

    assert.equal(detectCodexSandboxCliStyleFromHelp([
      'Usage: codex sandbox [COMMAND]',
      'Commands:',
      '  linux',
    ].join('\n')), 'linux-subcommand');
  });
});
