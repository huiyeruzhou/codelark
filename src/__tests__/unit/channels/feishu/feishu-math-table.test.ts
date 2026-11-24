import '../../../setup/test-setup.js';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import MarkdownIt from 'markdown-it';
import { FeishuCardMath, findMarkdownMathTables, tableMathFallback } from '../../../../channels/feishu/math.js';
import { renderMathTablePng } from '../../../../channels/feishu/math-table-renderer.js';
import { buildHistoryPage } from '../../../../channels/feishu/streaming-history-page.js';
import { _testOnly } from '../../../../channels/feishu/adapter.js';

const table = '| 方法 | 公式 | 说明 |\n| :--- | :---: | ---: |\n' + String.raw`| **均值** | $\frac{a+b}{2}$ | 与 $x_i$ 对比 |` + '\n';
const children = (node: any): any[] => node.columns[0].elements;

it('recognizes whole math tables with TeX pipes, alignment, code and surrounding blocks', () => {
  const source = '前文\n\n' + table + '\n普通段落\n\n| 普通 | 表格 |\n|---|---|\n|代码 `$x$`|内容|\n\n```md\n' + table + '```';
  const [parsed, ...rest] = findMarkdownMathTables(source);
  assert.deepEqual(rest, []);
  assert.equal(parsed.source, table);
  assert.equal(source.slice(parsed.start, parsed.end), table);
  assert.deepEqual(parsed.align, ['left', 'center', 'right']);
  assert.equal(parsed.rows.length, 2);
  const pipes = findMarkdownMathTables('| 值 | 说明 |\r\n|---|---|\r\n|$\\left|x\\right|$|管道 `a\\|b`|\r\n')[0];
  assert.equal(pipes.rows[1].length, 2);
  assert.equal(pipes.rows[1][0], String.raw`$\left|x\right|$`);
  assert.equal(pipes.rows[1][1], '管道 `a|b`');
});

it('renders a table as one bounded preview image, caches concurrent requests and keeps source intact', async () => {
  let uploads = 0;
  const math = new FeishuCardMath(async png => { uploads++; assert.equal(png.subarray(1, 4).toString(), 'PNG'); return 'img_table'; });
  const node = { tag: 'markdown', element_id: 'answer', content: '前文 $x^2$\n\n' + table + '\n后文' };
  const source = structuredClone(node);
  const [a, b] = await Promise.all([math.element(node), math.element(node)]);
  assert.deepEqual(node, source); assert.deepEqual(a, b); assert.equal(uploads, 1);
  assert.equal(a.element_id, 'answer');
  assert.deepEqual(children(a).map(e => e.tag), ['markdown', 'img', 'markdown']);
  assert.match(children(a)[0].content, /前文 x²/);
  const image = children(a)[1];
  assert.equal(image.preview, true);
  assert.ok(Number(image.size.split('px')[0]) <= 560);
  assert.equal(children(a)[2].content, '\n后文');
});

it('leaves ordinary tables unchanged and uses whole-table images for simple math too', async () => {
  let uploads = 0;
  const math = new FeishuCardMath(async () => { uploads++; return 'img_table'; });
  const ordinary = { tag: 'markdown', content: '| a | b |\n|---|---|\n|1|`$x$`|' };
  assert.equal(await math.element(ordinary), ordinary);
  const simple = { tag: 'markdown', content: '| a | b |\n|---|---|\n|$x^2$|2|' };
  assert.equal(children(await math.element(simple))[0].tag, 'img');
  assert.equal(uploads, 1);
});

it('falls back to one readable table on upload failure, preserving pipes without fenced code', async () => {
  let uploads = 0;
  const math = new FeishuCardMath(async () => { uploads++; throw new Error('offline'); });
  const source = table + String.raw`| 绝对值 | $\left|x\right|$ | $|x|$ |` + '\n';
  for (let n = 0; n < 2; n++) {
    const output = children(await math.element({ tag: 'markdown', content: source }));
    assert.equal(output.length, 1); assert.equal(output[0].tag, 'markdown');
    assert.doesNotMatch(output[0].content, /```|\$/);
    const html = new MarkdownIt().render(output[0].content);
    assert.equal((html.match(/<td/g) || []).length, 6);
    assert.ok(html.includes(String.raw`\frac{a+b}{2}`));
    assert.ok(html.includes(String.raw`\left|x\right|`));
    assert.ok(html.includes('|x|'));
  }
  assert.equal(uploads, 1, 'failed uploads are cached');
  assert.match(tableMathFallback(table), /xᵢ/);
});

it('falls back on invalid TeX and oversized tables without losing rows', async () => {
  const math = new FeishuCardMath(async () => { throw new Error('must not upload invalid images'); });
  for (const source of [table.replace('\\frac{a+b}{2}', '\\notARealCommand{x}'), table + '|正文|$x$|解释|\n'.repeat(40)]) {
    const result = children(await math.element({ tag: 'markdown', content: source }));
    assert.equal(result.length, 1); assert.equal(result[0].tag, 'markdown');
    assert.equal(result[0].content.split('\n').length, source.split('\n').length);
    assert.doesNotMatch(result[0].content, /```latex/);
  }
  const png = renderMathTablePng(findMarkdownMathTables(table)[0]);
  assert.ok(png.readUInt32BE(16) <= 1524 && png.readUInt32BE(20) < 3604);
});

it('counts a dense formula table as one image and moves it intact across card boundaries', () => {
  const dense = table + ('|项|$\\frac{a}{b}$|$\\sqrt{x}$|\n').repeat(20);
  assert.ok(_testOnly.countFeishuCardComponents({ tag: 'markdown', content: dense }) < 10);
  const prefix = '前'.repeat(100) + '\n\n';
  const content = prefix + table + '\n后文';
  const history = [{ type: 'markdown' as const, role: 'assistant' as const, content }];
  const fits = (items: any[]) => items.reduce((n, i) => n + i.content.length, 0) <= 150;
  const first = buildHistoryPage(history, { historyItemOffset: 0, historyToolCallOffset: 0 }, fits);
  assert.equal((first.items[0] as any).content, prefix);
  const second = buildHistoryPage(history, first.next, fits);
  assert.equal((second.items[0] as any).content, table + '\n后文');
  assert.equal(second.hasMore, false);
});
