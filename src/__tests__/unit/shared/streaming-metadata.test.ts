import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRuntimeStreamTags,
  buildStreamContextTags,
  formatStreamTagLabel,
} from '../../../shared/streaming-metadata.js';

test('builds and formats streaming metadata tags', () => {
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

  assert.deepEqual(buildRuntimeStreamTags({
    runtime: 'kimi',
    reasoningEffort: 'default',
    model: 'moonshot-v1',
  }), [
    'kimi',
    'effort:default',
    'model:moonshot-v1',
  ]);

  assert.equal(formatStreamTagLabel('effort:medium'), 'medium');
  assert.equal(formatStreamTagLabel('reasoning:medium'), 'medium');
  assert.equal(formatStreamTagLabel('model:default'), 'default');
  assert.equal(formatStreamTagLabel('bridge_id:bridge-s'), 'bridge_id:bridge-s');
});
