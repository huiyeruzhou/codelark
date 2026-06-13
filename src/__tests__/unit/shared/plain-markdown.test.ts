import '../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { markdownToPlainText } from '../../../shared/markdown/plain.js';

describe('markdownToPlainText', () => {
  it('preserves readable text while removing markdown markers', () => {
    const plain = markdownToPlainText([
      '# Title',
      '',
      '- one',
      '- two',
      '',
      '1. first',
      '2. second',
      '',
      '**bold** and `code`',
    ].join('\n'));

    assert.equal(
      plain,
      [
        'Title',
        '',
        '• one',
        '• two',
        '',
        '1. first',
        '2. second',
        '',
        'bold and code',
      ].join('\n'),
    );
    assert.equal(
      markdownToPlainText('See [OpenAI](https://openai.com/docs) for details.'),
      'See OpenAI (https://openai.com/docs) for details.',
    );
    assert.equal(
      markdownToPlainText('**&lt;Current Thread&gt; codex:**\n\nCodex answer'),
      '<Current Thread> codex:\n\nCodex answer',
    );
  });
});
