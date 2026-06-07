import '../../setup/test-setup.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  normalizeReasoningEffort,
  normalizeSandboxMode,
  parseReasoningEffort,
  parseSandboxMode,
} from '../../../runtime/options.js';

describe('runtime-options', () => {
  it('parses sandbox modes through the shared zod schema and applies fallback', () => {
    assert.equal(parseSandboxMode('read-only'), 'read-only');
    assert.equal(parseSandboxMode('workspace-write'), 'workspace-write');
    assert.equal(parseSandboxMode('danger-full-access'), 'danger-full-access');
    assert.equal(parseSandboxMode('invalid'), undefined);
    assert.equal(normalizeSandboxMode('invalid'), 'workspace-write');
    assert.equal(normalizeSandboxMode(undefined, 'read-only'), 'read-only');
  });

  it('parses reasoning efforts through the shared zod schema and applies fallback', () => {
    assert.equal(parseReasoningEffort('minimal'), 'minimal');
    assert.equal(parseReasoningEffort('low'), 'low');
    assert.equal(parseReasoningEffort('medium'), 'medium');
    assert.equal(parseReasoningEffort('high'), 'high');
    assert.equal(parseReasoningEffort('xhigh'), 'xhigh');
    assert.equal(parseReasoningEffort('invalid'), undefined);
    assert.equal(normalizeReasoningEffort('invalid'), 'medium');
    assert.equal(normalizeReasoningEffort(undefined, 'low'), 'low');
  });
});
