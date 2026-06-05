export function buildFencedCodeBlock(content: string, language: string): string {
  const normalized = (content || '').replace(/\r\n/g, '\n');
  const runs = normalized.match(/`+/g) || [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
  const fenceLength = Math.max(3, longest + 1);
  const fence = '`'.repeat(fenceLength);
  return `${fence}${language ? language : ''}\n${normalized}\n${fence}`;
}
