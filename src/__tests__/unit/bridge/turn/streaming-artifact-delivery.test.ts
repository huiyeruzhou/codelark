import '../../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createStreamingArtifactDeliveryController } from '../../../../bridge/turn/streaming-artifact-delivery.js';
import type { OutboundAttachment } from '../../../../domain/index.js';

describe('streaming artifact delivery', () => {
  it('uploads a completed local Markdown image once', async () => {
    const delivered: OutboundAttachment[][] = [];
    const controller = createStreamingArtifactDeliveryController({
      async deliver(attachments) {
        delivered.push(attachments);
        return { ok: true, messageId: 'image-1' };
      },
    });

    controller.observeAnswerText('二维码：\n![登录二维码](/tmp/lark_auth_run12_layers_qr_2.png)');
    controller.observeAnswerText('二维码：\n![登录二维码](/tmp/lark_auth_run12_layers_qr_2.png)');
    await controller.close();

    assert.deepEqual(delivered, [[{
      kind: 'image',
      path: '/tmp/lark_auth_run12_layers_qr_2.png',
      caption: '登录二维码',
      name: undefined,
    }]]);
  });

  it('delivers a completed answer block once and removes it from final delivery', async () => {
    const delivered: OutboundAttachment[][] = [];
    const controller = createStreamingArtifactDeliveryController({
      async deliver(attachments) {
        delivered.push(attachments);
        return { ok: true, messageId: 'artifact-1' };
      },
    });

    controller.observeAnswerText('answer\n<clk-se');
    controller.observeAnswerText('answer\n<clk-send>{"type":"file","path":"/tmp/report.txt"}</clk-send>');
    controller.observeAnswerText('answer\n<clk-send>{"type":"file","path":"/tmp/report.txt"}</clk-send>');
    await controller.close();

    assert.deepEqual(delivered, [[{
      kind: 'file',
      path: '/tmp/report.txt',
      caption: undefined,
      name: undefined,
    }]]);
    assert.deepEqual(controller.withoutDelivered(delivered[0]!), []);
  });

  it('filters successful items independently and keeps a failed item eligible for final retry', async () => {
    const sent: OutboundAttachment = { kind: 'file', path: '/tmp/sent.txt' };
    const retry: OutboundAttachment = { kind: 'file', path: '/tmp/retry.txt' };
    const controller = createStreamingArtifactDeliveryController({
      async deliver(attachments) {
        return attachments[0]?.path === sent.path
          ? { ok: true }
          : { ok: false, error: 'temporary failure' };
      },
    });

    controller.observeAnswerText('<clk-send>{"items":[{"type":"file","path":"/tmp/sent.txt"},{"type":"file","path":"/tmp/retry.txt"}]}</clk-send>');
    await controller.close();

    assert.deepEqual(controller.withoutDelivered([sent, retry]), [retry]);
  });
});
