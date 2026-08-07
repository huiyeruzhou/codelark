import '../../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildWindowsRuntimeCommandLine,
  shouldPreserveRuntimeTestDirectoryAfterCleanupError,
} from '../../../helpers/runtime/real-codex-e2e-utils.js';

describe('real runtime command helpers', () => {
  it('quotes each Windows shell command argument without building a second cmd argv envelope', () => {
    assert.equal(buildWindowsRuntimeCommandLine('tmux', ['-V']), '"tmux" "-V"');
    assert.equal(
      buildWindowsRuntimeCommandLine('C:\\Program Files\\runtime\\kimi.cmd', ['--version']),
      '"C:\\Program Files\\runtime\\kimi.cmd" "--version"',
    );
  });

  it('preserves only Windows directories still held by a runtime process', () => {
    assert.equal(
      shouldPreserveRuntimeTestDirectoryAfterCleanupError({ code: 'EPERM' }, 'win32'),
      true,
    );
    assert.equal(
      shouldPreserveRuntimeTestDirectoryAfterCleanupError({ code: 'EBUSY' }, 'win32'),
      true,
    );
    assert.equal(
      shouldPreserveRuntimeTestDirectoryAfterCleanupError({ code: 'EACCES' }, 'win32'),
      false,
    );
    assert.equal(
      shouldPreserveRuntimeTestDirectoryAfterCleanupError({ code: 'EPERM' }, 'linux'),
      false,
    );
  });
});
