import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizePtyScreenLines,
  parsePtyScreenArgs,
} from '../../../../bridge/command/pty-args.js';

describe('pty command args', () => {
  it('normalizes screen line limits', () => {
    assert.equal(normalizePtyScreenLines('42'), 42);
    assert.equal(normalizePtyScreenLines('-1'), 0);
    assert.equal(normalizePtyScreenLines('999'), 500);
    assert.equal(normalizePtyScreenLines('bad'), 0);
  });

  it('parses pty screen show, stop, lines, and interval forms', () => {
    assert.deepEqual(parsePtyScreenArgs(''), { action: 'show' });
    assert.deepEqual(parsePtyScreenArgs('stop'), { action: 'stop' });
    assert.deepEqual(parsePtyScreenArgs('120'), { action: 'show', lines: 120 });
    assert.deepEqual(parsePtyScreenArgs('5s'), { action: 'show', intervalSeconds: 5 });
    assert.deepEqual(parsePtyScreenArgs('120 1s'), { action: 'show', lines: 120, intervalSeconds: 3 });
    assert.deepEqual(parsePtyScreenArgs('1s 999'), { action: 'show', lines: 500, intervalSeconds: 3 });
  });

  it('rejects unsupported pty screen grammar', () => {
    assert.equal(parsePtyScreenArgs('lines 120 every 5s'), null);
    assert.equal(parsePtyScreenArgs('stop 5s'), null);
    assert.equal(parsePtyScreenArgs('a b c'), null);
  });
});
