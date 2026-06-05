import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeCaptureLines,
  parseTmuxKeySequence,
  parseTmuxScreenArgs,
  parseTmuxSendActions,
  parseTmuxSetArgs,
  validateTmuxSessionName,
} from '../../../../bridge/command/tmux-args.js';

describe('tmux command args', () => {
  it('normalizes capture line limits and validates session names', () => {
    assert.equal(normalizeCaptureLines('42'), 42);
    assert.equal(normalizeCaptureLines('-1'), 0);
    assert.equal(normalizeCaptureLines('999'), 500);
    assert.equal(normalizeCaptureLines('bad'), 0);

    assert.equal(validateTmuxSessionName(' alpha '), 'alpha');
    assert.equal(validateTmuxSessionName(''), null);
    assert.equal(validateTmuxSessionName('bad\u0000name'), null);
  });

  it('parses tmux screen and set commands', () => {
    assert.deepEqual(parseTmuxScreenArgs(''), { action: 'show' });
    assert.deepEqual(parseTmuxScreenArgs('stop'), { action: 'stop' });
    assert.deepEqual(parseTmuxScreenArgs('120'), { action: 'show', lines: 120 });
    assert.deepEqual(parseTmuxScreenArgs('5s'), { action: 'show', intervalSeconds: 5 });
    assert.deepEqual(parseTmuxScreenArgs('120 1s'), { action: 'show', lines: 120, intervalSeconds: 3 });
    assert.equal(parseTmuxScreenArgs('lines 120 every 5s'), null);

    assert.deepEqual(parseTmuxSetArgs('lines 999'), { key: 'lines', value: 500 });
    assert.deepEqual(parseTmuxSetArgs('enter off'), { key: 'enter', value: false });
    assert.deepEqual(parseTmuxSetArgs('echo yes'), { key: 'echo', value: true });
    assert.equal(parseTmuxSetArgs('echo maybe'), null);
  });

  it('parses special key sequences and mixed literal input', () => {
    assert.deepEqual(parseTmuxKeySequence('<C-c><Enter>'), [
      { type: 'key', key: 'C-c' },
      { type: 'key', key: 'Enter' },
    ]);
    assert.equal(parseTmuxKeySequence('git status<Enter>'), null);

    assert.deepEqual(parseTmuxSendActions('git status<Enter><Option+Enter>').actions, [
      { type: 'literal', text: 'git status' },
      { type: 'key', key: 'Enter' },
      { type: 'key', key: 'M-Enter' },
    ]);
    assert.deepEqual(parseTmuxSendActions('<Cmd+Backspace>').actions, [
      { type: 'key', key: 'C-u' },
    ]);
    assert.match(parseTmuxSendActions('<NotAKey>').error || '', /不支持的特殊键/);
  });
});
