import '../../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createStreamingArtifactDeliveryController } from '../../../../bridge/turn/streaming-artifact-delivery.js';
import { assembleCodexFinalResponse, assembleSdkFinalResponse, stripFinalOnlyBlocksForStreaming } from '../../../../bridge/turn/response-assembler.js';
import type { OutboundAttachment } from '../../../../domain/index.js';

describe('streaming artifact delivery', () => {
  it('retains original image links before and after upload, including failed uploads', async () => {
    for (const ok of [true, false]) {
      for (const bang of ['', '!']) {
        const delivered: OutboundAttachment[][] = [];
        const controller = createStreamingArtifactDeliveryController({
          async deliver(attachments) { delivered.push(attachments); return { ok }; },
        });
        const link = '[图片原链接](</tmp/codelark-link-demo/photo one.PNG> "图片标题")';
        const text = `前文\n${bang}${link}\n后文`;
        const expected = `前文\n${link}\n后文`;
        for (let i = 1; i <= text.length; i++) controller.observeAnswerText(text.slice(0, i));
        assert.equal(stripFinalOnlyBlocksForStreaming(text), expected);
        await controller.close();
        assert.equal(delivered.length, 1);
        for (const assemble of [assembleCodexFinalResponse, assembleSdkFinalResponse]) {
          const final = assemble({ text });
          assert.equal(final.text, expected);
          assert.equal(controller.withoutDelivered(final.attachments || []).length, ok ? 0 : 1);
        }
        assert.equal(stripFinalOnlyBlocksForStreaming(text), expected);
      }
    }
  });

  it('uploads images by extension from both link forms while retaining non-image references', async () => {
    const delivered: OutboundAttachment[][] = [];
    const controller = createStreamingArtifactDeliveryController({
      async deliver(attachments) { delivered.push(attachments); return { ok: true }; },
    });
    const text = [
      '[源码](/tmp/codelark-link-demo/runner.py)',
      '[源码行](/tmp/codelark-link-demo/runner.py:193)',
      '![误用图片语法的文档](/tmp/codelark-link-demo/report.pdf)',
      '![误用图片语法的源码](/tmp/codelark-link-demo/runner.py)',
      '[图片链接](/tmp/codelark-link-demo/photo.PNG)',
      '![图片预览](/tmp/codelark-link-demo/preview.jpg)',
    ].join('\n');
    for (let i = 1; i <= text.length; i++) controller.observeAnswerText(text.slice(0, i));
    await controller.close();
    assert.deepEqual(delivered.flat().map(({ kind, path }) => ({ kind, path })), [
      { kind: 'image', path: '/tmp/codelark-link-demo/photo.PNG' },
      { kind: 'image', path: '/tmp/codelark-link-demo/preview.jpg' },
    ]);
  });

  it('never uploads code examples or source references while text arrives in chunks', async () => {
    const delivered: OutboundAttachment[][] = [];
    const controller = createStreamingArtifactDeliveryController({
      async deliver(attachments) { delivered.push(attachments); return { ok: true }; },
    });
    const text = [
      '```xml',
      '<clk-send>{"type":"file","path":"/tmp/example.txt"}</clk-send>',
      '```',
      '`![示例](/tmp/example.png)`',
      '[源码](/tmp/codelark-source-demo/src/runner.py:193)',
      '<clk-send>{"type":"file","path":"/tmp/runner.py:193"}</clk-send>',
    ].join('\n');
    for (let i = 1; i <= text.length; i++) controller.observeAnswerText(text.slice(0, i));
    await controller.close();
    assert.deepEqual(delivered, []);
  });

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

  it('never uploads an ordinary local link during streaming or final delivery', async () => {
    const delivered: OutboundAttachment[][] = [];
    const controller = createStreamingArtifactDeliveryController({
      async deliver(attachments) {
        delivered.push(attachments);
        return { ok: true, messageId: 'file-1' };
      },
    });

    controller.observeAnswerText('完整稿件：[打开报告](/opt/tiger/project/work/reports/report.html)');
    controller.observeAnswerText('完整稿件：[打开报告](/opt/tiger/project/work/reports/report.html)');
    await controller.close();

    assert.deepEqual(delivered, []);
    assert.deepEqual(controller.withoutDelivered([]), []);
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
