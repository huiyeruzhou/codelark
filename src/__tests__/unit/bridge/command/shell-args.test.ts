import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  auditShellCommand,
  normalizeShellCommandTransportMarkdown,
  parseShellCommandArgs,
} from '../../../../bridge/command/shell-args.js';

describe('shell command args', () => {
  it('parses force, sandbox, refresh interval, and command text', () => {
    assert.deepEqual(parseShellCommandArgs('echo default'), {
      command: 'echo default',
      force: false,
      refreshIntervalSeconds: 5,
      sandboxMode: 'workspace-write',
    });
    assert.deepEqual(parseShellCommandArgs('--force --sandbox read-only 12 echo slow'), {
      command: 'echo slow',
      force: true,
      refreshIntervalSeconds: 12,
      sandboxMode: 'read-only',
    });
    assert.deepEqual(parseShellCommandArgs('--sandbox=workspace-write 2 echo floored'), {
      command: 'echo floored',
      force: false,
      refreshIntervalSeconds: 5,
      sandboxMode: 'workspace-write',
    });
  });

  it('rejects unsupported shell options and strips transported markdown links', () => {
    assert.deepEqual(parseShellCommandArgs('--sandbox danger-full-access echo no'), {
      error: 'sandbox 只能是 read-only 或 workspace-write；/shell 不允许 danger-full-access。',
    });
    assert.deepEqual(parseShellCommandArgs('--unknown echo no'), {
      error: '未知 /shell 参数：--unknown',
    });
    assert.equal(
      normalizeShellCommandTransportMarkdown('curl [baidu.com](http://baidu.com/)'),
      'curl baidu.com',
    );
  });

  it('audits blocked and high-risk shell commands', () => {
    assert.deepEqual(auditShellCommand('').map((finding) => finding.level), ['block']);
    assert.match(auditShellCommand('/ tmp')[0]?.message || '', /绝对路径被空格拆开/);

    const warnings = auditShellCommand('rm -rf dist');
    assert.equal(warnings[0]?.level, 'warn');
    assert.match(warnings[0]?.message || '', /rm/);
  });
});
