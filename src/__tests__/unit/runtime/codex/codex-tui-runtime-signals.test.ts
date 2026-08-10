import '../../../setup/test-setup.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  classifyCodexTuiDiagnostic,
  extractCodexTuiErrorMessages,
  findNewCodexTuiDiagnostic,
  findNewCodexTuiDiagnostics,
  findNewCodexTuiErrorMessage,
  parseCodexTuiModelMismatchWarning,
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

  it('parses the Codex resume model mismatch warning without depending on wrapping', () => {
    assert.deepEqual(parseCodexTuiModelMismatchWarning([
      '\u001b[33m⚠ This session was recorded with model `gpt-5.5-2026-04-24` but is resuming with\u001b[0m',
      '  `gpt-5.6-sol`. Consider switching back to `gpt-5.5-2026-04-24` as it may',
      '  affect Codex performance.',
    ].join('\n')), {
      recordedModel: 'gpt-5.5-2026-04-24',
      resumingModel: 'gpt-5.6-sol',
    });
    assert.deepEqual(parseCodexTuiModelMismatchWarning(
      '⚠ This session was recorded with model `old` but is resuming with `new`. Consider switching back.',
    ), {
      recordedModel: 'old',
      resumingModel: 'new',
    });
    assert.deepEqual(parseCodexTuiModelMismatchWarning([
      '⚠ This session was recorded with model `gpt-5.5-',
      '  2026-04-24` but is resuming with `gpt-',
      '  5.6-sol`.',
    ].join('\n')), {
      recordedModel: 'gpt-5.5-2026-04-24',
      resumingModel: 'gpt-5.6-sol',
    });
  });

  it('does not mistake user text quoting the model mismatch warning for a TUI warning cell', () => {
    assert.equal(parseCodexTuiModelMismatchWarning([
      '› ⚠ This session was recorded with model `old` but is resuming with',
      '  `new`. 这个是什么意思？',
    ].join('\n')), null);
    assert.equal(parseCodexTuiModelMismatchWarning(
      '日志里出现 This session was recorded with model `old` but is resuming with `new`。',
    ), null);
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

  it('separates recoverable TUI operation errors from turn and session termination', () => {
    assert.deepEqual(
      classifyCodexTuiDiagnostic('Failed to update thread goal: thread/goal/set failed in TUI'),
      {
        message: 'Failed to update thread goal: thread/goal/set failed in TUI',
        impact: 'operation',
        terminal: false,
      },
    );
    assert.deepEqual(
      classifyCodexTuiDiagnostic('exceeded retry limit, last status: 429 Too Many Requests'),
      {
        message: 'exceeded retry limit, last status: 429 Too Many Requests',
        impact: 'turn',
        terminal: true,
      },
    );
    assert.deepEqual(
      classifyCodexTuiDiagnostic('app-server event stream disconnected: transport closed'),
      {
        message: 'app-server event stream disconnected: transport closed',
        impact: 'session',
        terminal: true,
      },
    );
    assert.deepEqual(
      findNewCodexTuiDiagnostic('', '■ Failed to save default model: config/batchWrite failed'),
      {
        message: 'Failed to save default model: config/batchWrite failed',
        impact: 'operation',
        terminal: false,
      },
    );
    assert.deepEqual(
      findNewCodexTuiDiagnostics('', [
        '■ Failed to update thread goal: thread/goal/set failed in TUI',
        '■ exceeded retry limit, last status: 429 Too Many Requests',
      ].join('\n')).map(({ impact, terminal }) => ({ impact, terminal })),
      [
        { impact: 'operation', terminal: false },
        { impact: 'turn', terminal: true },
      ],
    );
  });
});
