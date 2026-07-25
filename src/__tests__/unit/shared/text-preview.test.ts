import '../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createTextPreview } from '../../../shared/text-preview.js';

describe('createTextPreview', () => {
  it('treats character and line limits as independent hard upper bounds', () => {
    const preview = createTextPreview('12345\n67890\nabcde\nfghij', {
      maxChars: 12,
      maxLines: 2,
    });

    assert.equal(preview.text, '12345\n67890');
    assert.equal(preview.shownChars, 11);
    assert.equal(preview.shownLines, 2);
    assert.ok(preview.shownChars <= 12);
    assert.ok(preview.shownLines <= 2);
    assert.deepEqual(preview.truncatedBy, ['lines']);
  });

  it('stops at the character bound even when more lines are allowed', () => {
    const preview = createTextPreview('abcdef\nghijkl', {
      maxChars: 5,
      maxLines: 20,
    });

    assert.equal(preview.text, 'abcde');
    assert.equal(preview.shownChars, 5);
    assert.equal(preview.shownLines, 1);
    assert.deepEqual(preview.truncatedBy, ['chars']);
  });

  it('counts Unicode code points without splitting surrogate pairs', () => {
    const preview = createTextPreview('甲😀乙😀丙', {
      maxChars: 4,
      maxLines: 1,
    });

    assert.equal(preview.text, '甲😀乙😀');
    assert.equal(preview.shownChars, 4);
    assert.equal(preview.text.endsWith('\ud83d'), false);
  });

  it('normalizes CRLF before applying limits', () => {
    const preview = createTextPreview('a\r\nb\r\nc', {
      maxChars: 100,
      maxLines: 2,
    });

    assert.equal(preview.text, 'a\nb');
    assert.equal(preview.totalLines, 3);
    assert.equal(preview.shownLines, 2);
  });
});
