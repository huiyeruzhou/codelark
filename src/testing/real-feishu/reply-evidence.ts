export function stripEchoedSourceText(content: string, sourceText: string): string {
  if (!sourceText) return content;
  return content.split(sourceText).join('');
}

export function containsGeneratedReplyTexts(
  content: string,
  sourceText: string,
  expectedTexts: string[],
): boolean {
  const generatedContent = stripEchoedSourceText(content, sourceText);
  return expectedTexts.filter(Boolean).every((expectedText) => generatedContent.includes(expectedText));
}
