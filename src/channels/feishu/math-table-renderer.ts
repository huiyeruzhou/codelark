import MarkdownIt from 'markdown-it';
import { Resvg } from '@resvg/resvg-js';
import { findMarkdownFormulas, type MarkdownMathTable } from './math.js';
import { renderMathSvg } from './math-renderer.js';

const markdown = new MarkdownIt({ html: false, linkify: false });
const escape = (s: string) => s.replace(/[&<>"']/gu, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]!));
const font = 16, padding = 12;
type Run = { text?: string; svg?: string; width: number; ascent: number; descent: number; bold?: boolean; italic?: boolean; code?: boolean; newline?: boolean };

function cellRuns(source: string, maxWidth: number, heading: boolean): Run[] {
  const formulas = findMarkdownFormulas(source);
  let prefix = 'CLKCELL'; while (source.includes(prefix)) prefix += 'X';
  let masked = source;
  for (let i = formulas.length - 1; i >= 0; i--) {
    const f = formulas[i]!; masked = masked.slice(0, f.start) + prefix + i + 'END' + masked.slice(f.end);
  }
  const tokens = markdown.parseInline(masked.replace(/<br\s*\/?\s*>/giu, '\n'), {})[0]?.children || [];
  const runs: Run[] = [];
  let bold = 0, italic = 0;
  const addText = (text: string, code = false) => {
    // Latin words remain together when possible; CJK wraps at character boundaries.
    for (const part of text.match(/[\x21-\x7e]+|[^\x21-\x7e]/gu) || []) {
      const width = [...part].reduce((sum, char) => sum + (/\p{Mark}/u.test(char) ? 0 : char.codePointAt(0)! > 255 ? font : font / 2), 0);
      if (width > maxWidth && part.length > 1) { for (const char of part) addText(char, code); continue; }
      runs.push({ text: part, width, ascent: 18, descent: 6, bold: heading || bold > 0, italic: italic > 0, code });
    }
  };
  for (const token of tokens) {
    if (token.type === 'strong_open') bold++;
    else if (token.type === 'strong_close') bold--;
    else if (token.type === 'em_open') italic++;
    else if (token.type === 'em_close') italic--;
    else if (['softbreak', 'hardbreak'].includes(token.type)) runs.push({ width: 0, ascent: 18, descent: 6, newline: true });
    else if (token.type === 'text') {
      let offset = 0;
      for (const match of token.content.matchAll(new RegExp(`${prefix}(\\d+)END`, 'g'))) {
        addText(token.content.slice(offset, match.index));
        const formula = formulas[Number(match[1])]!;
        const image = renderMathSvg(formula.tex, formula.display);
        const scale = Math.min(1, maxWidth / image.width);
        runs.push({ svg: `<g transform="scale(${scale})">${image.svg}</g>`, width: image.width * scale,
          ascent: image.baseline * scale + 2, descent: (image.height - image.baseline) * scale + 2 });
        offset = match.index! + match[0].length;
      }
      addText(token.content.slice(offset));
    } else if (token.type === 'code_inline') addText(token.content, true);
    else if (token.type === 'image') addText(token.content);
  }
  return runs;
}

function layout(runs: Run[], width: number, align: string) {
  const lines: Run[][] = [[]]; let used = 0;
  for (const run of runs) {
    if (run.newline || (used + run.width > width && lines.at(-1)!.length)) { lines.push([]); used = 0; }
    if (run.newline || (!used && run.text === ' ')) continue;
    lines.at(-1)!.push(run); used += run.width;
  }
  let y = 0; const elements: string[] = [];
  for (const line of lines) {
    const ascent = Math.max(18, ...line.map(r => r.ascent));
    const descent = Math.max(6, ...line.map(r => r.descent));
    const used = line.reduce((sum, r) => sum + r.width, 0);
    let x = align === 'right' ? width - used : align === 'center' ? (width - used) / 2 : 0;
    for (const r of line) {
      if (r.svg) elements.push(`<g transform="translate(${x},${y + ascent - r.ascent + 2})">${r.svg}</g>`);
      // Resvg does not synthesize bold for CJK fonts with only a regular face.
      else elements.push(`<text x="${x}" y="${y + ascent}"${r.bold ? ' font-weight="bold" stroke="currentColor" stroke-width="0.35" paint-order="stroke"' : ''}${r.italic ? ' font-style="italic"' : ''}${r.code ? ' fill="#475569" color="#475569"' : ''}>${escape(r.text || '')}</text>`);
      x += r.width;
    }
    y += ascent + descent + 3;
  }
  return { svg: elements.join(''), height: y };
}

/** Bounded, local rendering using the same MathJax/Resvg stack as individual formulas. */
export function renderMathTablePng(table: MarkdownMathTable): Buffer {
  const columns = table.rows[0]?.length || 0;
  if (columns < 1 || columns > 8 || table.rows.length > 40 || table.source.length > 16000) throw new Error('Table exceeds image limits');
  // Give prose columns more room while keeping short labels readable.
  const desired = table.rows[0]!.map((_, c) => Math.max(...table.rows.map(row => Math.min(360, Math.max(120, [...(row[c] || '')].length * 8)))));
  const width = Math.min(760, desired.reduce((sum, n) => sum + n + padding * 2, 0));
  const available = width - columns * padding * 2;
  const total = desired.reduce((sum, n) => sum + n, 0);
  const widths = desired.map(n => n / total * available);
  const shapes: string[] = []; let y = 1;
  for (const [index, row] of table.rows.entries()) {
    const cells = widths.map((w, c) => layout(cellRuns(row[c] || '', w, index === 0), w, table.align[c] || 'left'));
    const height = Math.max(...cells.map(c => c.height)) + padding * 2;
    if (y + height > 1800) throw new Error('Table exceeds image height limit');
    let x = 1;
    for (const [c, cell] of cells.entries()) {
      const cellWidth = widths[c]! + padding * 2;
      shapes.push(`<rect x="${x}" y="${y}" width="${cellWidth}" height="${height}" fill="${index === 0 ? '#eaf1f8' : index % 2 ? '#ffffff' : '#f8fafc'}" stroke="#cbd5e1"/>`);
      shapes.push(`<g transform="translate(${x + padding},${y + padding})">${cell.svg}</g>`);
      x += cellWidth;
    }
    y += height;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width + 2}" height="${y + 1}" font-family="WenQuanYi Zen Hei Mono, Noto Sans Mono CJK SC, Microsoft YaHei, PingFang SC, monospace" font-size="${font}" fill="#1e293b" color="#1e293b">${shapes.join('')}</svg>`;
  return Buffer.from(new Resvg(svg, { background: '#ffffff', fitTo: { mode: 'zoom', value: 2 } }).render().asPng());
}
