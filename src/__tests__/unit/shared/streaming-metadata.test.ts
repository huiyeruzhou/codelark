import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRuntimeStreamTags,
  buildStreamContextTags,
  formatStreamTagLabel,
} from '../../../shared/streaming-metadata.js';

test('buildStreamContextTags emits bridge identity and stream mode tags', () => {
  assert.deepEqual(buildStreamContextTags({
    bindingId: 'binding-123456789',
    bridgeSessionId: 'bridge-session-123456789',
    threadId: 'codex-thread-123456789',
    executionProvider: 'tmux',
    creatorKind: 'vscode',
    source: 'sdk',
  }), [
    'bridge_id:bridge-s',
    'sdk',
  ]);

  assert.deepEqual(buildStreamContextTags({
    bindingId: 'binding-123456789',
    bridgeSessionId: 'bridge-session-123456789',
    threadId: 'codex-thread-123456789',
    executionProvider: 'tmux',
    creatorKind: 'vscode',
    source: 'mirror',
  }), [
    'bridge_id:bridge-s',
    'mirror',
  ]);
});

test('buildRuntimeStreamTags emits runtime, effort, and model tags first-class', () => {
  assert.deepEqual(buildRuntimeStreamTags({
    runtime: 'codex',
    reasoningEffort: 'high',
    model: 'gpt-5-codex',
  }), [
    'codex',
    'effort:high',
    'model:gpt-5-codex',
  ]);

  assert.deepEqual(buildRuntimeStreamTags({
    runtime: 'claude',
    reasoningEffort: 'max',
    model: 'claude-sonnet-test',
  }), [
    'claude',
    'effort:max',
    'model:claude-sonnet-test',
  ]);
});

test('formatStreamTagLabel strips only runtime tag prefixes', () => {
  assert.equal(formatStreamTagLabel('effort:medium'), 'medium');
  assert.equal(formatStreamTagLabel('reasoning:medium'), 'medium');
  assert.equal(formatStreamTagLabel('model:default'), 'default');
  assert.equal(formatStreamTagLabel('bridge_id:bridge-s'), 'bridge_id:bridge-s');
});
