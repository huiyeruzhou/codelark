import { maskMarkdownCode } from '../../shared/markdown/code-mask.js';
import { buildFencedCodeBlock } from '../../shared/markdown/fence.js';
import { inlineMathMarkdown } from './math-inline.js';

export interface MarkdownFormula { start: number; end: number; tex: string; display: boolean }

export function formulaInlineMarkdown(formula: MarkdownFormula): string | null {
  return formula.display ? null : inlineMathMarkdown(formula.tex);
}

/** Only paired delimiters outside code. Dollar math cannot start/end with whitespace. */
export function findMarkdownFormulas(text: string): MarkdownFormula[] {
  if (!/[\$\\]/u.test(text)) return [];
  const masked = maskMarkdownCode(text).replace(/https?:\/\/[^\s<>]+|!?\[[^\]\n]*\]\([^\n]*?\)/gu, match => ' '.repeat(match.length));
  const result: MarkdownFormula[] = [];
  const escaped = (i: number) => {
    let slashes = 0;
    while (i > 0 && masked[--i] === '\\') slashes++;
    return slashes % 2 === 1;
  };
  for (let i = 0; i < masked.length; i++) {
    const open = masked.startsWith('\\[', i) ? '\\[' : masked.startsWith('\\(', i) ? '\\('
      : masked.startsWith('$$', i) ? '$$' : masked[i] === '$' ? '$' : '';
    if (!open || escaped(i)) continue;
    const close = open === '\\[' ? '\\]' : open === '\\(' ? '\\)' : open;
    const start = i + open.length;
    if (open === '$' && (/\s/u.test(masked[start] || ' ') || /\d/u.test(masked[i - 1] || ''))) continue;
    let end = masked.indexOf(close, start);
    while (end >= 0 && escaped(end)) end = masked.indexOf(close, end + close.length);
    if (end < 0) {
      if (open.length > 1) break; // An unfinished streaming formula stays literal until it closes.
      continue;
    }
    const tex = text.slice(start, end).trim();
    if (!tex || (open === '$' && (/\s/u.test(masked[end - 1] || ' ') || /[\r\n]/u.test(tex)
      || /\d/u.test(masked[end + 1] || '') || /^\d[\d.,]*$/u.test(tex)))) continue;
    result.push({ start: i, end: end + close.length, tex, display: open === '$$' || open === '\\[' });
    i = end + close.length - 1;
  }
  return result;
}

type FormulaImage = { key: string; width: number; height: number };
type ImageCacheEntry = { promise: Promise<FormulaImage | null>; expiresAt: number };

/** One cache per bot: uploaded image keys cannot be shared between applications. */
export class FeishuCardMath {
  private readonly images = new Map<string, ImageCacheEntry>();
  constructor(private readonly upload: (png: Buffer) => Promise<string>,
    private readonly render = async (tex: string, display: boolean) => (await import('./math-renderer.js')).renderMathPng(tex, display)) {}

  private image(tex: string, display: boolean): Promise<FormulaImage | null> {
    const key = `${display ? 'block' : 'inline'}:${tex}`;
    const cached = this.images.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.promise;
    const entry: ImageCacheEntry = { promise: Promise.resolve(null), expiresAt: Infinity };
    entry.promise = this.render(tex, display).then(async png => {
      const naturalWidth = png.readUInt32BE(16) / 2;
      const naturalHeight = png.readUInt32BE(20) / 2;
      const scale = Math.min(1, 320 / naturalWidth);
      return { key: await this.upload(png), width: Math.round(naturalWidth * scale), height: Math.round(naturalHeight * scale) };
    }).catch(() => {
      entry.expiresAt = Date.now() + 60_000;
      return null; // A failed formula must not prevent the answer/card from being delivered.
    });
    this.images.set(key, entry);
    if (this.images.size > 256) this.images.delete(this.images.keys().next().value!);
    return entry.promise;
  }

  async element(node: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (node.tag !== 'markdown' || typeof node.content !== 'string') return node;
    const text = node.content;
    const formulas = findMarkdownFormulas(text);
    if (!formulas.length) return node;
    const elements: Record<string, unknown>[] = [];
    const appendText = (content: string) => {
      if (content.trim()) elements.push({ tag: 'markdown', content: content.trim(), text_size: node.text_size || 'normal' });
    };
    let offset = 0;
    let pendingText = '';
    let imageCount = 0;
    for (const formula of formulas) {
      pendingText += text.slice(offset, formula.start);
      offset = formula.end;
      const inline = formulaInlineMarkdown(formula);
      if (inline !== null) { pendingText += inline; continue; }
      appendText(pendingText);
      pendingText = '';
      const image = imageCount++ < 32 ? await this.image(formula.tex, formula.display) : null;
      if (image) elements.push({ tag: 'img', img_key: image.key,
        alt: { tag: 'plain_text', content: formula.tex },
        scale_type: 'crop_center', size: `${image.width}px ${image.height}px`, preview: true });
      else appendText(buildFencedCodeBlock(formula.tex, 'latex'));
    }
    pendingText += text.slice(offset);
    if (!imageCount) return { ...node, content: pendingText };
    appendText(pendingText);
    return { tag: 'column_set', flex_mode: 'none', ...(node.element_id ? { element_id: node.element_id } : {}),
      columns: [{ tag: 'column', width: 'weighted', weight: 1, vertical_spacing: '4px', elements }] };
  }

  /** Adapt card/element JSON only at delivery. Canonical conversation text stays unchanged. */
  async json(serialized: string): Promise<string> {
    if (!/[\$\\]/u.test(serialized)) return serialized;
    const value: unknown = JSON.parse(serialized);
    let changed = false;
    const visit = async (node: unknown): Promise<unknown> => {
      if (Array.isArray(node)) return Promise.all(node.map(visit));
      if (!node || typeof node !== 'object') return node;
      const record = node as Record<string, unknown>;
      if (record.tag === 'markdown' && typeof record.content === 'string') {
        const rendered = await this.element(record);
        if (rendered !== record) { changed = true; return rendered; }
      }
      // Do not reinterpret form values, callback payloads or URLs as Markdown.
      for (const key of ['body', 'elements', 'columns']) if (key in record) record[key] = await visit(record[key]);
      return record;
    };
    const rendered = await visit(value);
    return changed ? JSON.stringify(rendered) : serialized;
  }
}

/** The transport may replace a Markdown element with a formula container. */
export function renderedElementHasFormula(node: unknown, elementId: string): boolean {
  if (Array.isArray(node)) return node.some(child => renderedElementHasFormula(child, elementId));
  if (!node || typeof node !== 'object') return false;
  const record = node as Record<string, unknown>;
  if (record.element_id === elementId && typeof record.content === 'string') return findMarkdownFormulas(record.content).length > 0;
  return Object.values(record).some(child => renderedElementHasFormula(child, elementId));
}
