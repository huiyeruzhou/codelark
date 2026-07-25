export interface TextPreviewOptions {
  maxChars: number;
  maxLines: number;
}

export interface TextPreview {
  text: string;
  totalChars: number;
  totalLines: number;
  shownChars: number;
  shownLines: number;
  truncated: boolean;
  truncatedBy: Array<'chars' | 'lines'>;
}

function safeLimit(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function countLines(text: string): number {
  return text ? text.split('\n').length : 0;
}

/**
 * Keeps a stable prefix while treating both character and line limits as hard
 * upper bounds. Characters are Unicode code points, so a surrogate pair is
 * never split. The omission label belongs outside `text` and cannot consume
 * or overflow either content budget.
 */
export function createTextPreview(value: string, options: TextPreviewOptions): TextPreview {
  const source = String(value || '').replace(/\r\n?/g, '\n');
  const maxChars = safeLimit(options.maxChars);
  const maxLines = safeLimit(options.maxLines);
  const sourceChars = Array.from(source);
  const totalChars = sourceChars.length;
  const totalLines = countLines(source);
  const previewChars: string[] = [];
  let shownLines = source ? 1 : 0;

  if (maxChars > 0 && maxLines > 0) {
    for (const char of sourceChars) {
      if (previewChars.length >= maxChars) break;
      if (char === '\n' && shownLines >= maxLines) break;
      previewChars.push(char);
      if (char === '\n') shownLines += 1;
    }
  }

  const text = previewChars.join('');
  const shownChars = previewChars.length;
  shownLines = countLines(text);
  const truncated = shownChars < totalChars;
  const truncatedBy: Array<'chars' | 'lines'> = [];
  if (truncated && shownChars >= maxChars) truncatedBy.push('chars');
  if (truncated && shownLines >= maxLines) truncatedBy.push('lines');

  return {
    text,
    totalChars,
    totalLines,
    shownChars,
    shownLines,
    truncated,
    truncatedBy,
  };
}
