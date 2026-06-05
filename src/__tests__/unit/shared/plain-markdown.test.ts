import '../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { markdownToPlainText } from '../../../shared/markdown/plain.js';

describe('markdownToPlainText', () => {
  it('preserves lists and line breaks while removing markdown markers', () => {
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
  });

  it('keeps link labels and appends href in plain text mode', () => {
    const plain = markdownToPlainText('See [OpenAI](https://openai.com/docs) for details.');
    assert.equal(plain, 'See OpenAI (https://openai.com/docs) for details.');
  });

  it('decodes escaped angle brackets in markdown headers', () => {
    const plain = markdownToPlainText('**&lt;Current Thread&gt; codex:**\n\nCodex answer');
    assert.equal(plain, '<Current Thread> codex:\n\nCodex answer');
  });
});
