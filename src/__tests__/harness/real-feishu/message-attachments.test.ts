import '../../setup/test-setup.js';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { inflateSync } from 'node:zlib';
import { assertAttachmentAcceptance, solidColorPng, type AttachmentEvidence } from '../../../testing/real-feishu/attachments.js';

const accepted = (): AttachmentEvidence => ({ transport: 'websocket', runtime: 'cursor', chatId: 'oc_test', initialThread: 'native', finalThread: 'native',
  replies: Array.from({ length: 5 }, (_, i) => ({ inputId: `input-${i}`, replyId: `reply-${i}`, userReadback: true, botAuthored: true })),
  imageAnswer: true, fileAnswer: true, quotedFileAnswer: true, mergedAnswer: true, imageBytesEqual: true, fileBytesEqual: true,
  activeSteer: true, extraSdkStream: false, automaticOutput: true });
it('rejects incomplete, manually delivered, wrong-thread and corrupted attachment acceptance evidence', () => {
  assertAttachmentAcceptance(accepted());
  for (const patch of [{ transport: 'replay' }, { finalThread: 'other' }, { automaticOutput: false }, { extraSdkStream: true },
    { activeSteer: false }, { imageBytesEqual: false }, { fileBytesEqual: false }, { mergedAnswer: false },
    { replies: [{ inputId: 'x', replyId: 'y', userReadback: false, botAuthored: true }] }]) {
    assert.throws(() => assertAttachmentAcceptance({ ...accepted(), ...patch } as AttachmentEvidence));
  }
});
it('builds a real PNG fixture whose pixel bytes match the hidden expected color', () => {
  const png = solidColorPng([1, 2, 3]);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  let offset = 8; const compressed: Buffer[] = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset), tag = png.toString('ascii', offset + 4, offset + 8);
    if (tag === 'IDAT') compressed.push(png.subarray(offset + 8, offset + 8 + length)); offset += length + 12;
  }
  const rows = inflateSync(Buffer.concat(compressed)); assert.equal(rows.length, 64 * 193);
  for (let y = 0; y < 64; y++) {
    assert.equal(rows[y * 193], 0);
    for (let x = 0; x < 64; x++) assert.deepEqual([...rows.subarray(y * 193 + 1 + x * 3, y * 193 + 4 + x * 3)], [1, 2, 3]);
  }
});
