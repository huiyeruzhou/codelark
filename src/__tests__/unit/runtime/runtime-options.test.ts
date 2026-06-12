import '../../setup/test-setup.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  normalizeReasoningEffort,
  normalizeSandboxMode,
  parseClaudeReasoningEffort,
  parseReasoningEffort,
  parseSandboxMode,
} from '../../../runtime/options.js';

describe('runtime-options', () => {
  it('parses runtime option enums and fallbacks through the shared schemas', () => {
    assert.equal(parseSandboxMode('read-only'), 'read-only');
    assert.equal(parseSandboxMode('workspace-write'), 'workspace-write');
    assert.equal(parseSandboxMode('danger-full-access'), 'danger-full-access');
    assert.equal(parseSandboxMode('invalid'), undefined);
    assert.equal(normalizeSandboxMode('invalid'), 'workspace-write');
    assert.equal(normalizeSandboxMode(undefined, 'read-only'), 'read-only');

    assert.equal(parseReasoningEffort('minimal'), 'minimal');
    assert.equal(parseReasoningEffort('low'), 'low');
    assert.equal(parseReasoningEffort('medium'), 'medium');
    assert.equal(parseReasoningEffort('high'), 'high');
    assert.equal(parseReasoningEffort('xhigh'), 'xhigh');
    assert.equal(parseReasoningEffort('invalid'), undefined);
    assert.equal(normalizeReasoningEffort('invalid'), 'medium');
    assert.equal(normalizeReasoningEffort(undefined, 'low'), 'low');

    assert.equal(parseClaudeReasoningEffort('low'), 'low');
    assert.equal(parseClaudeReasoningEffort('medium'), 'medium');
    assert.equal(parseClaudeReasoningEffort('high'), 'high');
    assert.equal(parseClaudeReasoningEffort('xhigh'), 'xhigh');
    assert.equal(parseClaudeReasoningEffort('max'), 'max');
    assert.equal(parseClaudeReasoningEffort('m'), 'max');
    assert.equal(parseClaudeReasoningEffort('5'), 'max');
    assert.equal(parseClaudeReasoningEffort('invalid'), undefined);
  });
});
