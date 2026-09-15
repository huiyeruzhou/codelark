import '../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseOutboundArtifacts,
  stripOutboundArtifactBlocksForStreaming,
  supportsOutboundArtifacts,
} from '../../../channels/delivery/artifacts.js';

describe('outbound-artifacts', () => {
  it('treats local Markdown images as uploadable image attachments', () => {
    const parsed = parseOutboundArtifacts([
      '二维码如下：',
      '![登录二维码](/tmp/lark_auth_run12_layers_qr_2.png)',
      '![远程图片](https://example.com/image.png)',
    ].join('\n'));

    assert.equal(parsed.cleanText, [
      '二维码如下：',
      '',
      '![远程图片](https://example.com/image.png)',
    ].join('\n'));
    assert.deepEqual(parsed.attachments, [{
      kind: 'image',
      path: '/tmp/lark_auth_run12_layers_qr_2.png',
      caption: '登录二维码',
      name: undefined,
    }]);
  });

  it('leaves local Markdown image examples inside code blocks untouched', () => {
    const markdown = [
      '```markdown',
      '![示例](/tmp/example.png)',
      '```',
      '    ![缩进示例](/tmp/indented.png)',
    ].join('\n');

    const parsed = parseOutboundArtifacts(markdown);
    assert.equal(parsed.cleanText, markdown);
    assert.deepEqual(parsed.attachments, []);
  });

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

  it('preserves inline control-tag literals while extracting standalone blocks', () => {
    const parsed = parseOutboundArtifacts([
      '普通说明里的 `<clk-send>`、`<clk-ask>` 和 `<clk-input>` 必须原样保留。',
      '<clk-send>{"msg_type":"text","content":{"text":"real message"}}</clk-send>',
      '真实控制块之后的正文也不能丢。',
    ].join('\n'));

    assert.equal(parsed.cleanText, [
      '普通说明里的 `<clk-send>`、`<clk-ask>` 和 `<clk-input>` 必须原样保留。',
      '',
      '真实控制块之后的正文也不能丢。',
    ].join('\n'));
    assert.deepEqual(parsed.platformMessages, [{
      msgType: 'text',
      content: { text: 'real message' },
    }]);
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

  it('accepts Feishu msg_type and content without inventing message kinds', () => {
    const parsed = parseOutboundArtifacts([
      '<clk-send>{"msg_type":"text","content":{"text":"<at user_id=\\"ou_bot\\">八千代</at> 请检查"}}</clk-send>',
      '<clk-send>{"msg_type":"post","content":{"zh_cn":{"title":"进度","content":[[{"tag":"text","text":"完成"}]]}}}</clk-send>',
      '<clk-send>{"msg_type":"interactive","content":{"header":{"title":{"tag":"plain_text","content":"状态"}},"elements":[]}}</clk-send>',
    ].join('\n'));

    assert.equal(parsed.cleanText, '');
    assert.deepEqual(parsed.attachments, []);
    assert.deepEqual(parsed.platformMessages, [
      { msgType: 'text', content: { text: '<at user_id="ou_bot">八千代</at> 请检查' } },
      { msgType: 'post', content: { zh_cn: { title: '进度', content: [[{ tag: 'text', text: '完成' }]] } } },
      { msgType: 'interactive', content: { header: { title: { tag: 'plain_text', content: '状态' } }, elements: [] } },
    ]);
    assert.deepEqual(parsed.errors, []);
  });

  it('passes future Feishu msg_type values through for the API to validate', () => {
    const parsed = parseOutboundArtifacts(
      '<clk-send>{"msg_type":"Future_Official_Type","content":{"value":"kept"}}</clk-send>',
    );

    assert.deepEqual(parsed.platformMessages, [
      { msgType: 'Future_Official_Type', content: { value: 'kept' } },
    ]);
    assert.deepEqual(parsed.errors, []);
  });

  it('uses local_path only as the upload extension for Feishu image and file', () => {
    const parsed = parseOutboundArtifacts(
      '<clk-send>{"items":[{"msg_type":"image","local_path":"D:\\\\out.png"},{"msg_type":"file","local_path":"/tmp/report.pdf"}]}</clk-send>',
    );

    assert.deepEqual(parsed.attachments, [
      { kind: 'image', path: 'D:\\out.png', caption: undefined, name: undefined },
      { kind: 'file', path: '/tmp/report.pdf', caption: undefined, name: undefined },
    ]);
    assert.deepEqual(parsed.platformMessages, []);
    assert.deepEqual(parsed.errors, []);
  });

  it('extracts generic manual lane inputs separately from Feishu messages', () => {
    const parsed = parseOutboundArtifacts(
      '<clk-input>{"target":"八千代","text":"请检查训练状态","codelark_home":"/srv/yachiyo"}</clk-input>',
    );

    assert.equal(parsed.cleanText, '');
    assert.deepEqual(parsed.manualInputs, [{
      target: '八千代',
      text: '请检查训练状态',
      codelarkHome: '/srv/yachiyo',
    }]);
    assert.deepEqual(parsed.platformMessages, []);
    assert.deepEqual(parsed.errors, []);
  });

  it('accepts a composite target selector for manual lane input', () => {
    const parsed = parseOutboundArtifacts(
      '<clk-input>{"target":{"chat_name":"同名群","bot_name":"agent-1","codelark_home":"/srv/qaq","runtime":"codex","query":"diff"},"text":"检查状态"}</clk-input>',
    );

    assert.deepEqual(parsed.manualInputs, [{
      target: {
        chatName: '同名群',
        botName: 'agent-1',
        codelarkHome: '/srv/qaq',
        runtime: 'codex',
        query: 'diff',
      },
      text: '检查状态',
    }]);
    assert.deepEqual(parsed.errors, []);
  });

  it('rejects mistyped or invalid composite selector fields instead of broadening the target', () => {
    const parsed = parseOutboundArtifacts([
      '<clk-input>{"target":{"chat_name":"目标","bot_nam":"typo"},"text":"first"}</clk-input>',
      '<clk-input>{"target":{"chat_name":42},"text":"second"}</clk-input>',
      '<clk-input>{"target":{"chat_name":"   "},"text":"third"}</clk-input>',
    ].join('\n'));

    assert.deepEqual(parsed.manualInputs, []);
    assert.deepEqual(parsed.errors, [
      'invalid-manual-input-instruction',
      'invalid-manual-input-instruction',
      'invalid-manual-input-instruction',
    ]);
  });

  it('preserves manual input text byte-for-byte while validating it is non-empty', () => {
    const parsed = parseOutboundArtifacts(
      '<clk-input>{"target":"current","text":"  /stop\\n"}</clk-input>',
    );

    assert.equal(parsed.manualInputs[0]?.text, '  /stop\n');
    assert.deepEqual(parsed.errors, []);
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
    assert.equal(supportsOutboundArtifacts('feishu'), true);
    assert.equal(supportsOutboundArtifacts('unknown'), false);
  });

  it('hides local Markdown images from streaming text while they upload separately', () => {
    assert.equal(
      stripOutboundArtifactBlocksForStreaming('结果如下：\n\n![二维码](/tmp/qr.png)'),
      '结果如下：',
    );
  });

  it('keeps inline control-tag literals visible while streaming', () => {
    const inlineOnly = '说明 `<clk-send>` 只是协议名称，后文必须保留。';
    assert.equal(stripOutboundArtifactBlocksForStreaming(inlineOnly), inlineOnly);

    const withRealBlock = stripOutboundArtifactBlocksForStreaming([
      inlineOnly,
      '<clk-send>{"msg_type":"text","content":{"text":"real message"}}</clk-send>',
      '控制块后的正文。',
    ].join('\n'));
    assert.equal(withRealBlock, [inlineOnly, '', '控制块后的正文。'].join('\n'));
  });
});
