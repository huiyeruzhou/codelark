import '../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseOutboundArtifacts,
  stripOutboundArtifactBlocksForStreaming,
  supportsOutboundArtifacts,
} from '../../../channels/delivery/artifacts.js';

describe('outbound-artifacts', () => {
  it('extracts attachments and strips send blocks from final text', () => {
    const parsed = parseOutboundArtifacts([
      '这里是说明文字。',
      '',
      '<clk-send>',
      '{"type":"image","path":"D:\\\\work\\\\demo.png","caption":"结果图"}',
      '</clk-send>',
    ].join('\n'));

    assert.equal(parsed.cleanText, '这里是说明文字。');
    assert.deepEqual(parsed.attachments, [
      {
        kind: 'image',
        path: 'D:\\work\\demo.png',
        caption: '结果图',
        name: undefined,
      },
    ]);
    assert.deepEqual(parsed.questions, []);
    assert.deepEqual(parsed.errors, []);
  });

  it('keeps supporting legacy clk send blocks', () => {
    const parsed = parseOutboundArtifacts(
      '<clk-send>{"items":[{"type":"image","path":"D:\\\\a.png"},{"type":"file","path":"D:\\\\report.pdf"}]}</clk-send>',
    );

    assert.equal(parsed.cleanText, '');
    assert.deepEqual(parsed.attachments, [
      {
        kind: 'image',
        path: 'D:\\a.png',
        caption: undefined,
        name: undefined,
      },
      {
        kind: 'file',
        path: 'D:\\report.pdf',
        caption: undefined,
        name: undefined,
      },
    ]);
    assert.deepEqual(parsed.questions, []);
  });

  it('extracts question cards and strips ask blocks from final text', () => {
    const parsed = parseOutboundArtifacts([
      '我需要确认。',
      '<clk-ask>{"question":"请选择部署环境","options":["测试","生产"],"allowTextReply":false}</clk-ask>',
    ].join('\n'));

    assert.equal(parsed.cleanText, '我需要确认。');
    assert.deepEqual(parsed.attachments, []);
    assert.deepEqual(parsed.questions, [
      {
        question: '请选择部署环境',
        options: ['测试', '生产'],
        allowTextReply: false,
      },
    ]);
    assert.deepEqual(parsed.errors, []);
  });

  it('extracts question forms with options and optional free text input', () => {
    const parsed = parseOutboundArtifacts([
      '需要更多信息。',
      '<clk-ask>{"question":"请选择发布策略","options":["灰度","全量"],"input":{"label":"补充说明","placeholder":"可留空"},"submitText":"确认提交","allowTextReply":true}</clk-ask>',
    ].join('\n'));

    assert.equal(parsed.cleanText, '需要更多信息。');
    assert.deepEqual(parsed.questions, [
      {
        question: '请选择发布策略',
        options: ['灰度', '全量'],
        allowTextReply: true,
        input: {
          label: '补充说明',
          placeholder: '可留空',
        },
        submitText: '确认提交',
      },
    ]);
    assert.deepEqual(parsed.errors, []);
  });

  it('hides completed and incomplete send blocks from streaming text', () => {
    const full = stripOutboundArtifactBlocksForStreaming([
      '先说明一下结果。',
      '',
      '<clk-send>{"type":"image","path":"D:\\\\work\\\\demo.png"}</clk-send>',
      '',
      '补充说明',
      '',
      '<clk-ask>{"question":"是否继续","options":["继续"]}</clk-ask>',
      '',
      '<clk-send>{"type":"file","path":"D:\\\\work\\\\report.pdf"',
    ].join('\n'));

    assert.equal(full, '先说明一下结果。\n\n补充说明');
  });

  it('tracks which channels support outbound artifacts', () => {
    assert.equal(supportsOutboundArtifacts('feishu'), true);
    assert.equal(supportsOutboundArtifacts('unknown'), false);
  });
});
