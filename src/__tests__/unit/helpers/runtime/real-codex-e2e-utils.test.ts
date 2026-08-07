import '../../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildWindowsRuntimeCommandLine } from '../../../helpers/runtime/real-codex-e2e-utils.js';

describe('real runtime command helpers', () => {
  it('quotes each Windows shell command argument without building a second cmd argv envelope', () => {
    assert.equal(buildWindowsRuntimeCommandLine('tmux', ['-V']), '"tmux" "-V"');
    assert.equal(
      buildWindowsRuntimeCommandLine('C:\\Program Files\\runtime\\kimi.cmd', ['--version']),
      '"C:\\Program Files\\runtime\\kimi.cmd" "--version"',
    );
  });
});
