import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  assembleCodexFinalResponse,
  assembleSdkFinalResponse,
  mergeFinalResponses,
  stripFinalOnlyBlocksForStreaming,
} from '../../../../bridge/turn/response-assembler.js';

describe('response-assembler', () => {
  it('strips final-only send blocks and deduplicates attachments', () => {
    const response = assembleSdkFinalResponse({
      text: [
        '最终说明',
        '',
        '<clk-send>{"type":"image","path":"D:\\\\work\\\\out.png","caption":"图"}</clk-send>',
      ].join('\n'),
      attachments: [
        {
          kind: 'image',
          path: 'D:\\work\\out.png',
          caption: '图',
        },
      ],
    });

    assert.equal(response.text, '最终说明');
    assert.equal(response.source, 'sdk_result');
    assert.deepEqual(response.attachments, [
      {
        kind: 'image',
        path: 'D:\\work\\out.png',
        caption: '图',
      },
    ]);
    assert.deepEqual(response.questions, []);
  });

  it('extracts question cards from final text', () => {
    const response = assembleSdkFinalResponse({
      text: [
        '先说明原因。',
        '<clk-ask>{"question":"是否继续？","options":["继续","停止"]}</clk-ask>',
      ].join('\n'),
    });

    assert.equal(response.text, '先说明原因。');
    assert.deepEqual(response.attachments, []);
    assert.deepEqual(response.questions, [
      {
        question: '是否继续？',
        options: ['继续', '停止'],
        allowTextReply: true,
      },
    ]);
  });

  it('uses Codex final text as primary while preserving SDK attachments', () => {
    const sdk = assembleSdkFinalResponse({
      text: 'SDK 回复',
      attachments: [{ kind: 'file', path: 'D:\\work\\sdk.txt' }],
    });
    const codexFinal = assembleCodexFinalResponse({
      text: [
        'Codex 最终回复',
        '<clk-send>{"type":"image","path":"D:\\\\work\\\\codex.png"}</clk-send>',
      ].join('\n'),
    });

    const merged = mergeFinalResponses(codexFinal, sdk);

    assert.equal(merged.text, 'Codex 最终回复');
    assert.equal(merged.source, 'codex_task_complete');
    assert.deepEqual(merged.attachments, [
      { kind: 'file', path: 'D:\\work\\sdk.txt' },
      {
        kind: 'image',
        path: 'D:\\work\\codex.png',
        caption: undefined,
        name: undefined,
      },
    ]);
    assert.deepEqual(merged.questions, []);
  });

  it('strips complete and incomplete final-only blocks from streaming text', () => {
    assert.equal(
      stripFinalOnlyBlocksForStreaming([
        '正文',
        '<clk-send>{"type":"file","path":"D:\\\\a.txt"}</clk-send>',
        '继续',
        '<clk-send>{"type":"file"',
      ].join('\n')),
      '正文\n\n继续',
    );
  });
});
