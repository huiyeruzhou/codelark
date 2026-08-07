import '../../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildWindowsRuntimeCommandArgs } from '../../../helpers/runtime/real-codex-e2e-utils.js';

describe('real runtime command helpers', () => {
  it('wraps the full cmd /s /c command line outside individually quoted arguments', () => {
    assert.deepEqual(buildWindowsRuntimeCommandArgs('tmux', ['-V']), [
      '/d',
      '/s',
      '/c',
      '""tmux" "-V""',
    ]);
    assert.deepEqual(
      buildWindowsRuntimeCommandArgs('C:\\Program Files\\runtime\\kimi.cmd', ['--version']),
      [
        '/d',
        '/s',
        '/c',
        '""C:\\Program Files\\runtime\\kimi.cmd" "--version""',
      ],
    );
  });
});
