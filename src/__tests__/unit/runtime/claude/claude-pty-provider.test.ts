import '../../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { _testOnlyClaudePty } from '../../../../runtime/claude/pty-provider.js';

const bypassPermissionsWarning = [
  'WARNING: Claude Code running in Bypass Permissions mode',
  '',
  'In Bypass Permissions mode, Claude Code will not ask for your approval',
  'before running potentially dangerous commands.',
  '',
  '❯ 1. No, exit',
  '  2. Yes, I accept',
  '',
  'Enter to confirm · Esc to cancel',
].join('\n');

describe('Claude PTY startup prompts', () => {
  it('selects acceptance instead of the default exit on the bypass-permissions warning', async () => {
    const envNames = [
      'CODELARK_CLAUDE_PTY_TRUST_PROMPT_TIMEOUT_MS',
      'CODELARK_CLAUDE_PTY_INPUT_READY_TIMEOUT_MS',
      'CODELARK_CLAUDE_PTY_AFTER_TRUST_DELAY_MS',
    ];
    const previous = new Map(envNames.map((name) => [name, process.env[name]]));
    for (const name of envNames) process.env[name] = '0';
    const writes: string[] = [];

    try {
      await (_testOnlyClaudePty.prepareClaudePtyForPrompt as (session: unknown) => Promise<void>)({
        child: { write: (value: string) => writes.push(value) },
        buffer: bypassPermissionsWarning,
      });
      assert.deepEqual(writes, ['\x1b[B', '\r']);
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});
