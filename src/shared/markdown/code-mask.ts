import MarkdownIt from 'markdown-it';

const markdown = new MarkdownIt({ html: false, linkify: false });

/** Keep source offsets while hiding fenced/indented blocks and inline code. */
export function maskMarkdownCode(text: string): string {
  const offsets = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') offsets.push(i + 1);
  offsets.push(text.length);
  const characters = text.split('');
  for (const token of markdown.parse(text, {})) {
    if (!token.map || (token.type !== 'fence' && token.type !== 'code_block')) continue;
    for (let i = offsets[token.map[0]]; i < offsets[token.map[1]]; i++) {
      if (characters[i] !== '\n' && characters[i] !== '\r') characters[i] = ' ';
    }
  }
  let masked = characters.join('').replace(/\\[\s\S]|(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/gu, (match, ticks: string | undefined) =>
    ticks ? match.replace(/[^\r\n]/g, ' ') : match);
  // While a code span is arriving, its closing delimiter may not exist yet.
  // Be conservative about implicit side effects until the span is complete.
  for (const match of masked.matchAll(/\\[\s\S]|`+/gu)) {
    if (!match[0].startsWith('`')) continue;
    masked = masked.slice(0, match.index) + masked.slice(match.index).replace(/[^\r\n]/g, ' ');
    break;
  }
  return masked;
}
