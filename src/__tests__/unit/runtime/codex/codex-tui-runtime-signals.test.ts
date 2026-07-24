import '../../../setup/test-setup.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  extractCodexTuiErrorMessages,
  findNewCodexTuiErrorMessage,
  parseCodexTuiReconnectSignal,
} from '../../../../runtime/codex/tui-runtime-signals.js';

describe('Codex TUI runtime signals', () => {
  it('parses reconnect progress without depending on the dynamic footer', () => {
    assert.deepEqual(
      parseCodexTuiReconnectSignal('  \u001b[33m• Reconnecting... 1/2 (0s • esc to interrupt)\u001b[0m'),
      { attempt: 1, maxAttempts: 2 },
    );
    assert.deepEqual(
      parseCodexTuiReconnectSignal('Reconnecting… 12 / 20 — waiting for transport'),
      { attempt: 12, maxAttempts: 20 },
    );
  });

  it('does not mistake prose or a composer prompt for reconnect status', () => {
    assert.equal(parseCodexTuiReconnectSignal('The log says Reconnecting... 1/2.'), null);
    assert.equal(parseCodexTuiReconnectSignal('› Reconnecting... 1/2 是什么意思？'), null);
  });

  it('extracts line-start error markers while preserving arbitrary error text', () => {
    assert.deepEqual(extractCodexTuiErrorMessages([
      '■ Conversation interrupted - tell the model what to do differently.',
      '  ■ {"error":{"message":"CODELARK_MOCK_FATAL"}}',
      '正文提到 ■ 但不是 TUI error cell',
      '■',
    ].join('\n')), [
      'Conversation interrupted - tell the model what to do differently.',
      '{"error":{"message":"CODELARK_MOCK_FATAL"}}',
    ]);
  });

  it('reassembles a Codex error cell wrapped by the TUI layout', () => {
    assert.deepEqual(extractCodexTuiErrorMessages([
      '› CODELARK_FATAL_SIGNAL',
      '',
      '■ {"error":',
      '{"type":"invalid_request_error","message":"CODELARK_MOCK_FAT',
      'AL"}}',
      '',
      '› Use /skills to list available skills',
    ].join('\n')), [
      '{"error":{"type":"invalid_request_error","message":"CODELARK_MOCK_FATAL"}}',
    ]);

    assert.deepEqual(extractCodexTuiErrorMessages([
      '■ Conversation interrupted - tell the model what to do',
      'differently.',
      '',
    ].join('\n')), [
      'Conversation interrupted - tell the model what to do differently.',
    ]);

    assert.deepEqual(extractCodexTuiErrorMessages([
      '■',
      '{"error":{"message":"extremely narrow"}}',
      '',
    ].join('\n')), [
      '{"error":{"message":"extremely narrow"}}',
    ]);
  });

  it('finds only an error occurrence added after the turn baseline', () => {
    const historical = '■ Conversation interrupted\n■ repeated error';
    assert.equal(
      findNewCodexTuiErrorMessage(historical, `${historical}\n■ {"message":"fatal"}`),
      '{"message":"fatal"}',
    );
    assert.equal(findNewCodexTuiErrorMessage(historical, historical), null);
    assert.equal(
      findNewCodexTuiErrorMessage('■ repeated error', '■ repeated error\n■ repeated error'),
      'repeated error',
    );
  });
});
