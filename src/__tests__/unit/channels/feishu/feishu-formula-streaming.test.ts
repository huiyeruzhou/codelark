import '../../../setup/test-setup.js';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { FeishuAdapter } from '../../../../channels/feishu/adapter.js';

for (const mode of ['text', 'history', 'summary'] as const) {
  it(`keeps one ${mode} card while a formula arrives, changes to text and finalizes`, async () => {
    const calls: { kind: string; payload: any }[] = [];
    let uploads = 0;
    const adapter = new FeishuAdapter({ id: 'formula-test', provider: 'feishu', alias: 'test', enabled: true, config: { streamingEnabled: true } });
    const internal = adapter as any;
    internal.cardFlushBaseIntervalMs = 1;
    const record = (kind: string, data = {}) => async (payload: any) => { calls.push({ kind, payload }); return { code: 0, data }; };
    internal.restClient = {
      cardkit: { v1: {
        card: { create: record('create', { card_id: 'math-card' }), update: record('card-update'), settings: record('settings'), batchUpdate: record('batch') },
        cardElement: { create: record('element-create'), update: record('element-update'), patch: record('patch'), content: record('content') },
      } },
      im: { image: { create: async ({ data }: any) => {
        uploads++; assert.ok(Buffer.isBuffer(data.image));
        return { code: 0, data: { image_key: 'img_v3_formula' } };
      } }, message: { create: record('message', { message_id: 'math-message' }) } },
    };
    const update = (content: string) => {
      if (mode === 'text') adapter.onStreamText('math-chat', content, 'math-stream');
      else adapter.onStreamHistory('math-chat', [
        { type: 'markdown', role: 'user', content: '解释这个公式' },
        { type: 'markdown', role: mode === 'summary' ? 'thinking' : 'assistant',
          ...(mode === 'summary' ? { variant: 'thinking_summary' as const } : {}), content },
      ], 'math-stream');
    };
    const flush = async () => {
      await Promise.all([...internal.cardCreatePromises.values(), ...internal.scheduledCardCreatePromises.values()]);
      for (let i = 0; i < 3; i++) {
        await internal.awaitCardFlushCompletion('math-stream');
        internal.enqueueCardFlush('math-stream');
        await internal.awaitCardFlushCompletion('math-stream');
      }
    };
    try {
      update(String.raw`结果 \[\frac{a}{b}`);
      await flush();
      assert.equal(uploads, 0, 'incomplete formulas do not upload images');
      update(String.raw`原句 $E=mc^2$ 与 $x_i$ 继续。`); await flush();
      assert.equal(uploads, 0, 'simple formulas stay in the same Markdown paragraph');
      assert.ok(calls.filter(c => c.kind === 'element-update').some(c => {
        const element = JSON.parse(c.payload.data.element);
        return element.tag === 'markdown' && element.content.includes('原句 E=mc² 与 xᵢ 继续。');
      }));
      const complete = String.raw`结果 \[\frac{a}{b}\] 解释仍可复制`;
      update(complete); await flush();
      assert.equal(uploads, 1);
      const replacements = calls.filter(c => c.kind === 'element-update').map(c => JSON.parse(c.payload.data.element));
      assert.ok(replacements.some(e => e.tag === 'column_set'), 'replace Markdown with a sized image container');
      const state = internal.activeCards.get('math-stream');
      assert.ok(mode === 'text' ? state.pendingText === complete : state.historyItems.some((i: any) => i.content === complete));
      const beforeSimple = calls.length;
      update('回到行内 $x^2$，继续。'); await flush();
      assert.ok(calls.slice(beforeSimple).filter(c => c.kind === 'element-update').some(c => {
        const element = JSON.parse(c.payload.data.element);
        return element.tag === 'markdown' && element.content.includes('回到行内 x²，继续。');
      }), 'replace the old image container with inline Markdown');
      const finalText = complete + '\n\n简单公式：' + '$x^2$ '.repeat(80);
      update(finalText); await flush();
      assert.equal(await adapter.onStreamEnd('math-chat', 'completed', finalText, 'math-stream'), true);
      assert.equal(uploads, 1, 'reuse uploaded image through finalization');
      assert.equal(calls.filter(c => c.kind === 'message').length, 1);
      assert.equal(calls.find(c => c.kind === 'message')!.payload.data.msg_type, 'interactive');
      const final = JSON.parse(calls.filter(c => c.kind === 'card-update').at(-1)!.payload.data.card.data);
      assert.match(JSON.stringify(final), /img_v3_formula/);
      assert.match(JSON.stringify(final), /\d+px \d+px/);
      assert.match(JSON.stringify(final), /解释仍可复制/);
      assert.match(JSON.stringify(final), /简单公式：x² x²/);
      assert.doesNotMatch(JSON.stringify(final), /\$x\^2\$/);
    } finally { await adapter.stop(); }
  });
}
