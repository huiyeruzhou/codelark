import '../../../setup/test-setup.js';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { FeishuCardMath, findMarkdownFormulas } from '../../../../channels/feishu/math.js';
import { renderMathPng } from '../../../../channels/feishu/math-renderer.js';
import { inlineMathMarkdown } from '../../../../channels/feishu/math-inline.js';
import MarkdownIt from 'markdown-it';
import { splitMathMarkdown } from '../../../../channels/feishu/math-emphasis.js';

it('closes and reopens real emphasis at image boundaries without leaving empty markers', () => {
  const formula = String.raw`$\frac{a}{b}$`;
  const markdown = new MarkdownIt();
  for (const [source, expected] of [
    [`**前 ${formula} 后**`, ['<strong>前</strong>', '<strong>后</strong>']],
    [`*前 ${formula} 后*`, ['<em>前</em>', '<em>后</em>']],
    [`___前 ${formula} 后___`, ['<em><strong>前</strong></em>', '<em><strong>后</strong></em>']],
    [`**粗 *斜 ${formula} 继续* 尾**`, ['<strong>粗 <em>斜</em></strong>', '<strong><em>继续</em> 尾</strong>']],
    [`**${formula}**尾`, ['', '尾']],
    [`**前${formula}**`, ['<strong>前</strong>', '']],
    [`**${formula} ${formula}**`, ['', '', '']],
    [`**前 \\*星号 ${formula} 后**`, ['<strong>前 *星号</strong>', '<strong>后</strong>']],
    [`**前 \`*代码*\` ${formula} 后**`, ['<strong>前 <code>*代码*</code></strong>', '<strong>后</strong>']],
  ] as Array<[string, string[]]>) {
    const slices = splitMathMarkdown(source, findMarkdownFormulas(source));
    assert.deepEqual(slices.map(s => markdown.renderInline(s.trim())), expected, source);
  }
});

it('keeps block boundaries, literal markers, links and multiline quote/list emphasis intact', () => {
  const formula = String.raw`$\frac{a}{b}$`;
  for (const [source, expected] of [
    [`* item **前 ${formula} 后**`, ['* item **前** ', ' **后**']],
    [`> **前\n> 中 ${formula} 后**`, ['> **前\n> 中** ', ' **后**']],
    [`> **前\r\n> 中 ${formula} 后**`, ['> **前\r\n> 中** ', ' **后**']],
    [`**前\n\n${formula} 后**`, ['**前\n\n', ' 后**']],
    [`a_b_c \\*${formula}\\* [链接](https://x.test/a_b)`, ['a_b_c \\*', '\\* [链接](https://x.test/a_b)']],
    [`**[链接 *标记*](https://x.test/a_b) ${formula} 后**`, ['**[链接 *标记*](https://x.test/a_b)** ', ' **后**']],
  ] as Array<[string, string[]]>) {
    assert.deepEqual(splitMathMarkdown(source, findMarkdownFormulas(source)), expected, source);
  }
});

it('renders every valid formula beyond the old 32-image cutoff and preserves source text', async () => {
  const math = new FeishuCardMath(async () => 'img_formula');
  const source = { tag: 'markdown', content: Array.from({ length: 59 }, (_, i) => `**第${i + 1}项 $\\frac{a}{b}$ 解释**`).join('\n\n') };
  const original = structuredClone(source);
  const result = await math.element(source);
  const elements: any[] = (result.columns as any[])[0].elements;
  assert.equal(elements.filter(e => e.tag === 'img').length, 59);
  assert.doesNotMatch(JSON.stringify(result), /```latex/);
  assert.deepEqual(source, original);
  for (const element of elements.filter(e => e.tag === 'markdown')) {
    const tokens = new MarkdownIt().parseInline(element.content, {})[0].children!;
    assert.ok(tokens.some(t => t.type === 'strong_open'));
    assert.ok(tokens.every(t => t.type !== 'text' || !t.content.includes('*')), 'no leaked emphasis markers');
  }
});

it('keeps simple math readable inline without losing scripts or Greek letter variants', () => {
  const markdown = new MarkdownIt({ html: true });
  for (const [tex, expected] of [
    [String.raw`\alpha + \beta = 1`, 'α + β = 1'], ['E=mc^2', 'E=mc²'],
    ['a_1+b^{12}', 'a₁+b¹²'], ['x_i^{n+1}', 'xᵢⁿ⁺¹'], ['p_{ij}', 'pᵢⱼ'],
    [String.raw`\epsilon\varepsilon\phi\varphi`, 'ϵεϕφ'],
    [String.raw`0 \le x < 1`, '0 ≤ x &lt; 1'], ['a*b+[c]', 'a*b+[c]'],
    [String.raw`\alpha ^2`, 'α²'], ['<img src=x>', '&lt;img src=x&gt;'],
  ]) {
    const converted = inlineMathMarkdown(tex);
    assert.notEqual(converted, null, tex);
    assert.equal(markdown.renderInline(converted!), expected, tex);
  }
});

it('keeps unsupported scripts, grouped powers, styling and layout in the TeX renderer', () => {
  for (const tex of [String.raw`\frac{a}{b}`, String.raw`\sqrt{x}`, String.raw`\mathbf{x}`,
    String.raw`\begin{matrix}a&b\end{matrix}`, String.raw`\sum_i x_i`, String.raw`\unknown{x}`,
    String.raw`\alphafoo`, String.raw`\constructor`, 'x_b', 'x^{y+1}', '{ab}^2', 'x_{i_{j}}',
    'x^2^3', '^2', 'x^', 'x_{}', 'x_{12', 'x&y']) {
    assert.equal(inlineMathMarkdown(tex), null, tex);
  }
});

it('preserves the original Markdown node, paragraph, table and code when all formulas fit inline', async () => {
  const math = new FeishuCardMath(async () => { throw new Error('simple math must not upload'); },
    async () => { throw new Error('simple math must not render'); });
  const source = { tag: 'markdown', element_id: 'answer', text_align: 'center', margin: '4px', text_size: 'large',
    content: '**能量 $E=mc^2$。** 与 $x_i$ 连在原句。\n\n|变量|值|\n|---|---|\n|$x^2$|1|\n\n`$x^2$`，价格 $5 和 $10。' };
  const original = structuredClone(source);
  assert.deepEqual(await math.element(source), { ...source,
    content: '**能量 E=mc²。** 与 xᵢ 连在原句。\n\n|变量|值|\n|---|---|\n|x²|1|\n\n`$x^2$`，价格 $5 和 $10。' });
  assert.deepEqual(source, original, 'canonical LaTeX stays untouched');
});

it('only splits complex and display formulas into images, even after many simple formulas', async () => {
  let uploads = 0;
  const math = new FeishuCardMath(async () => `img_formula_${++uploads}`);
  const simple = '$x^2$ '.repeat(40);
  const result = await math.element({ tag: 'markdown', content: simple + String.raw`且 $\alpha$ 满足 $\frac{a}{b}$，得到 $x_i$。$$x=1$$` });
  const elements: any[] = (result.columns as any[])[0].elements;
  assert.deepEqual(elements.map(e => e.tag), ['markdown', 'img', 'markdown', 'img']);
  assert.equal(elements[0].content, 'x² '.repeat(40) + '且 α 满足');
  assert.equal(elements[2].content, '，得到 xᵢ。');
  assert.equal(uploads, 2, 'simple formulas neither upload nor consume the image budget');
  assert.equal(elements[1].alt.content, String.raw`\frac{a}{b}`);
  assert.equal(elements[3].alt.content, 'x=1', 'explicit block math keeps its layout');
});

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
