import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  _testOnly,
  buildLargeFileUploadConfirmationCard,
  clearPendingLargeFileUpload,
  consumePendingLargeFileUpload,
  LARGE_FILE_UPLOAD_CONFIRMATION_TTL_MS,
  registerPendingLargeFileUpload,
} from '../../../../bridge/command/file-upload-confirmations.js';
import { parseCommandCallbackData } from '../../../../bridge/command/callbacks.js';

describe('large file upload confirmations', () => {
  it('expires unanswered confirmations without uploading', () => {
    _testOnly.clear();
    const address = { channelType: 'feishu', chatId: 'chat-1' };
    const attachment = { kind: 'file' as const, path: '/tmp/large.bin', name: 'large.bin' };
    const now = 10_000;

    const id = registerPendingLargeFileUpload(address, attachment, 21 * 1024 * 1024, now);

    assert.equal(_testOnly.pendingCount(now), 1);
    assert.equal(
      consumePendingLargeFileUpload(address, id, now + LARGE_FILE_UPLOAD_CONFIRMATION_TTL_MS + 1),
      null,
    );
    assert.equal(_testOnly.pendingCount(now + LARGE_FILE_UPLOAD_CONFIRMATION_TTL_MS + 1), 0);
  });

  it('clears manually cancelled confirmations', () => {
    _testOnly.clear();
    const address = { channelType: 'feishu', chatId: 'chat-1' };
    const attachment = { kind: 'file' as const, path: '/tmp/large.bin', name: 'large.bin' };
    const id = registerPendingLargeFileUpload(address, attachment, 21 * 1024 * 1024, 10_000);

    assert.equal(clearPendingLargeFileUpload(address, id), true);
    assert.equal(consumePendingLargeFileUpload(address, id, 10_001), null);
  });

  it('builds confirm and cancel command callbacks', () => {
    const card = buildLargeFileUploadConfirmationCard({
      id: 'upload-1',
      attachment: { kind: 'file', path: '/tmp/large.bin', name: 'large.bin' },
      size: 21 * 1024 * 1024,
    });
    const callbacks = card.actions
      ?.flat()
      .map((action) => parseCommandCallbackData(action.callbackData)?.commandText)
      .filter(Boolean);

    assert.deepEqual(callbacks, [
      '/file --confirm-large upload-1',
      '/file --cancel-large upload-1',
    ]);
  });
});
