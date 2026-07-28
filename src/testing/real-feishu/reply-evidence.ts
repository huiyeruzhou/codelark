export function stripEchoedSourceText(content: string, sourceText: string): string {
  if (!sourceText) return content;
  if (content.trim() === sourceText.trim()) return '';
  return [
    '**用户**：',
    '**用户**:',
    '**User**：',
    '**User**:',
  ].reduce(
    (cleaned, prefix) => cleaned.split(`${prefix}${sourceText}`).join(''),
    content,
  );
}

export function containsGeneratedReplyTexts(
  content: string,
  sourceText: string,
  expectedTexts: string[],
): boolean {
  const generatedContent = stripEchoedSourceText(content, sourceText);
  return expectedTexts.filter(Boolean).every((expectedText) => generatedContent.includes(expectedText));
}
