import '../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { readPathEnv, writeCanonicalPathEnv } from '../../../runtime/path-env.js';

describe('path environment normalization', () => {
  it('reads Windows Path case-insensitively and writes one canonical key', () => {
    const env = { Path: 'C:\\Windows\\System32', HOME: 'C:\\Users\\tester' };

    assert.equal(readPathEnv(env, 'win32'), 'C:\\Windows\\System32');
    writeCanonicalPathEnv(env, 'C:\\CodeLark;C:\\Windows\\System32', 'win32');

    assert.deepEqual(env, {
      HOME: 'C:\\Users\\tester',
      PATH: 'C:\\CodeLark;C:\\Windows\\System32',
    });
  });

  it('does not reinterpret a mixed-case Path key on POSIX', () => {
    assert.equal(readPathEnv({ Path: '/custom/bin' }, 'linux'), '');
  });
});
