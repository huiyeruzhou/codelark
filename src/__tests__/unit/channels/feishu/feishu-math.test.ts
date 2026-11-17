import '../../../setup/test-setup.js';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { FeishuCardMath, findMarkdownFormulas } from '../../../../channels/feishu/math.js';
import { renderMathPng } from '../../../../channels/feishu/math-renderer.js';

it('recognizes paired math without treating code, currency, escaped dollars or URLs as formulas', () => {
  const source = String.raw`行内 $a_1+b^2$，\(x=1\)，块 $$\frac{a}{b}$$，\[\sum_i x_i\]`;
  assert.deepEqual(findMarkdownFormulas(source).map(f => [f.tex, f.display]), [
    ['a_1+b^2', false], ['x=1', false], [String.raw`\frac{a}{b}`, true], [String.raw`\sum_i x_i`, true],
  ]);
  const literal = '价格 $5 和 $10，金额 $5$，\\$x$；`$code$`\n```latex\n$$x=1$$\n```\n\n    $indented$\n\nhttps://example.com/?q=$x$\n[链接](/path/$x$)';
  assert.deepEqual(findMarkdownFormulas(literal), []);
  assert.deepEqual(findMarkdownFormulas('尚未完成 \\[x +'), []);
  assert.deepEqual(findMarkdownFormulas('尚未完成 $$x + $y$'), []);
});

it('renders real fractions, sums, matrices and aligned equations into bounded PNGs', () => {
  for (const tex of [String.raw`\frac{a_1+b^2}{\sqrt{n}}`, String.raw`\sum_{i=1}^n i^2`,
    String.raw`\begin{bmatrix}1&2\\3&4\end{bmatrix}`, String.raw`\begin{aligned}a&=b+c\\d&=e-f\end{aligned}`]) {
    const png = renderMathPng(tex, true);
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.ok(png.readUInt32BE(16) > 32 && png.readUInt32BE(16) < 1000);
    assert.ok(png.readUInt32BE(20) > 32 && png.readUInt32BE(20) < 400);
  }
  assert.throws(() => renderMathPng(String.raw`\notARealCommand{x}`, true));
});

it('uses explicit image dimensions, deduplicates concurrent uploads and leaves source/callbacks intact', async () => {
  let uploads = 0;
  const math = new FeishuCardMath(async () => { uploads++; return 'img_v3_formula'; });
  const source = { tag: 'markdown', element_id: 'answer', content: String.raw`前文 \[x=\frac{a}{b}\] 后文` };
  const original = structuredClone(source);
  const [a, b] = await Promise.all([math.element(source), math.element(source)]);
  assert.equal(uploads, 1);
  assert.deepEqual(a, b);
  assert.deepEqual(source, original);
  assert.equal(a.element_id, 'answer');
  const elements = (a.columns as any[])[0].elements;
  assert.equal(elements[0].content, '前文');
  const img = elements[1];
  assert.equal(img.tag, 'img');
  assert.equal(img.scale_type, 'crop_center');
  const [width, height] = img.size.match(/\d+/g).map(Number);
  assert.ok(width > 16 && width <= 320 && height < 100, 'use CSS size, never stretch to card width');
  assert.equal(img.alt.content, String.raw`x=\frac{a}{b}`);
  assert.equal(elements[2].content, '后文');
  const card = { body: { elements: [source] }, header: { title: { tag: 'markdown', content: '$title$' } }, value: { query: '$query$' } };
  const result = JSON.parse(await math.json(JSON.stringify(card)));
  assert.deepEqual(result.header, card.header);
  assert.deepEqual(result.value, card.value);
  assert.equal(uploads, 1);
});

it('retains exact TeX when rendering or uploading fails and does not retry every streaming revision', async () => {
  let calls = 0;
  const math = new FeishuCardMath(async () => { calls++; throw new Error('upload unavailable'); });
  const node = { tag: 'markdown', content: String.raw`答案 \[\frac{a}{b}\] 继续` };
  for (let i = 0; i < 3; i++) {
    const result = JSON.stringify(await math.element(node));
    assert.ok(result.includes('```latex'));
    assert.ok(result.includes('继续'));
  }
  assert.equal(calls, 1);
});
