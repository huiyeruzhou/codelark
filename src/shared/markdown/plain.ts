import { markdownToIR } from './ir.js';
import { renderMarkdownWithMarkers } from './render.js';

export function markdownToPlainText(markdown: string): string {
  const ir = markdownToIR(markdown ?? '', {
    enableTables: true,
    linkify: true,
  });

  const rendered = renderMarkdownWithMarkers(ir, {
    styleMarkers: {},
    escapeText: (text) => text,
    buildLink: (link, text) => {
      const label = text.slice(link.start, link.end).trim();
      const href = (link.href || '').trim();
      if (!href || href === label) {
        return null;
      }
      return {
        start: link.start,
        end: link.end,
        open: '',
        close: ` (${href})`,
      };
    },
  });

  return rendered
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
