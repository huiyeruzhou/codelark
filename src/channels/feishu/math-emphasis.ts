import MarkdownIt from 'markdown-it';

type Range = { start: number; end: number };
type Pair = { open: number; close: number };
type InlineContext = {
  content: string;
  positions: number[];
  runs: Map<Array<{ end: number }>, Map<number, number>>;
};
const markdown = new MarkdownIt({ html: true, linkify: false });

// Observe source positions; let markdown-it decide which * / _ delimiters pair.
markdown.inline.ruler.before('emphasis', 'math_emphasis_positions', (state, silent) => {
  const context: InlineContext | undefined = state.env.mathInline;
  if (silent || !context || state.src !== context.content || !/[*_]/u.test(state.src[state.pos])) return false;
  const run = state.scanDelims(state.pos, state.src[state.pos] === '*');
  let positions = context.runs.get(state.delimiters);
  if (!positions) { positions = new Map(); context.runs.set(state.delimiters, positions); }
  for (let i = 0; i < run.length; i++) positions.set(state.delimiters.length + i, context.positions[state.pos + i]);
  return false;
});
markdown.inline.ruler2.after('balance_pairs', 'math_emphasis_pairs', state => {
  const context: InlineContext | undefined = state.env.mathInline;
  if (!context || state.src !== context.content) return false;
  for (const [delimiters, positions] of context.runs) {
    for (const [index, open] of positions) {
      const close = positions.get(delimiters[index]?.end);
      if (close !== undefined) state.env.mathPairs.push({ open, close });
    }
  }
  return true;
});
markdown.core.ruler.at('inline', state => {
  const source: string = state.env.mathSource;
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') lineStarts.push(i + 1);
  let cursor = 0;
  for (const token of state.tokens) {
    if (token.type !== 'inline') continue;
    if (token.map) cursor = Math.max(cursor, lineStarts[token.map[0]]);
    const positions: number[] = [];
    // Block parsing strips list/quote prefixes. Match each remaining line to its source.
    for (const line of token.content.split('\n')) {
      const start = source.indexOf(line, cursor);
      if (start < 0) break;
      for (let i = 0; i < line.length; i++) positions.push(start + i);
      cursor = start + line.length;
      positions.push(source.indexOf('\n', cursor));
    }
    if (positions.length < token.content.length) continue;
    state.env.mathInline = { content: token.content, positions, runs: new Map() } satisfies InlineContext;
    state.md.inline.parse(token.content, state.md, state.env, token.children!);
  }
});

/** Split around images while keeping only nonempty, independently valid emphasis spans. */
export function splitMathMarkdown(text: string, formulas: Range[]): string[] {
  let masked = '', offset = 0;
  for (const formula of formulas) {
    masked += text.slice(offset, formula.start) + text.slice(formula.start, formula.end).replace(/[^\r\n]/gu, 'x');
    offset = formula.end;
  }
  masked += text.slice(offset);
  const env = { mathSource: masked, mathPairs: [] as Pair[] };
  markdown.parse(masked, env);
  const pairs = env.mathPairs.sort((a, b) => a.open - b.open);
  const markers = new Set(pairs.flatMap(pair => [pair.open, pair.close]));
  const slice = (start: number, end: number): string => {
    const opens = new Map<number, string[]>(), closes = new Map<number, string[]>();
    for (const pair of pairs) {
      let first = Math.max(start, pair.open + 1), last = Math.min(end, pair.close);
      while (first < last && (markers.has(first) || /\s/u.test(text[first]))) first++;
      while (last > first && (markers.has(last - 1) || /\s/u.test(text[last - 1]))) last--;
      if (first >= last) continue;
      opens.set(first, [...(opens.get(first) || []), text[pair.open]]);
      closes.set(last, [text[pair.close], ...(closes.get(last) || [])]);
    }
    let result = '';
    for (let i = start; i <= end; i++) {
      result += (closes.get(i) || []).join('') + (opens.get(i) || []).join('');
      if (i < end && !markers.has(i)) result += text[i];
    }
    return result;
  };
  const result: string[] = [];
  offset = 0;
  for (const formula of formulas) { result.push(slice(offset, formula.start)); offset = formula.end; }
  result.push(slice(offset, text.length));
  return result;
}
