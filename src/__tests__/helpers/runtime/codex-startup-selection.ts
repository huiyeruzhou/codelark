import type { OutboundCardActionSelect } from '../../../domain/message.js';

/** Only the observed Windows sandbox setup page has an explicit fixture choice. */
export function codexFixtureStartupChoice(text: string, select: OutboundCardActionSelect): string | undefined {
  const labels = [
    'Set up default sandbox (requires Administrator permissions)',
    'Use non-admin sandbox (higher risk if prompt injected)',
    'Quit',
    '这不是TUI选择',
  ];
  if (text.includes('Set up the Codex agent sandbox to protect your files and control network access.')
    && text.includes('https://developers.openai.com/codex/windows')
    && select.options.length === labels.length
    && select.options.every((option, index) => option.text === labels[index])
    && select.options[1].callbackData.endsWith(':option_2')) {
    return select.options[1].callbackData;
  }
  return select.selectedCallbackData || select.options[0]?.callbackData;
}
