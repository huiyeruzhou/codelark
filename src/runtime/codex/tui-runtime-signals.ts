const ANSI_ESCAPE = /\u001b\[[0-?]*[ -/]*[@-~]/g;

export interface CodexTuiReconnectSignal {
  attempt: number;
  maxAttempts: number;
}

function terminalLines(screenText: string): string[] {
  return screenText
    .replace(ANSI_ESCAPE, '')
    .split(/\r?\n/);
}

function isCompleteJson(value: string): boolean {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

export function parseCodexTuiReconnectSignal(
  screenText: string,
): CodexTuiReconnectSignal | null {
  const lines = terminalLines(screenText);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = lines[index]?.match(/^\s*(?:[•●◦·]\s*)?Reconnecting(?:\.{3}|…)?\s*(\d+)\s*\/\s*(\d+)\b/i);
    if (!match) continue;
    const attempt = Number(match[1]);
    const maxAttempts = Number(match[2]);
    if (attempt > 0 && maxAttempts > 0) return { attempt, maxAttempts };
  }
  return null;
}

export function extractCodexTuiErrorMessages(screenText: string): string[] {
  const messages: string[] = [];
  const lines = terminalLines(screenText);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] || '';
    const match = line.match(/^\s*■(?:\s*(\S.*))?$/u);
    if (!match) continue;
    const fragments = match[1] ? [match[1].trim()] : [];
    let looksStructured = /^(?:\{|\[)/u.test(fragments[0] || '');
    let continuationIndex = index + 1;
    while (
      continuationIndex < lines.length
      && !(looksStructured && isCompleteJson(fragments.join('')))
    ) {
      const continuation = (lines[continuationIndex] || '').trim();
      if (!continuation || /^[■›•●◦·╭╰│]/u.test(continuation)) break;
      fragments.push(continuation);
      if (fragments.length === 1) {
        looksStructured = /^(?:\{|\[)/u.test(fragments[0] || '');
      }
      continuationIndex += 1;
    }
    index = continuationIndex - 1;
    if (fragments.length === 0) continue;
    messages.push(looksStructured ? fragments.join('') : fragments.join(' '));
  }
  return messages;
}

export function findNewCodexTuiErrorMessage(
  beforeScreenText: string,
  afterScreenText: string,
): string | null {
  const remaining = new Map<string, number>();
  for (const message of extractCodexTuiErrorMessages(beforeScreenText)) {
    remaining.set(message, (remaining.get(message) || 0) + 1);
  }
  for (const message of extractCodexTuiErrorMessages(afterScreenText)) {
    const previousCount = remaining.get(message) || 0;
    if (previousCount <= 0) return message;
    remaining.set(message, previousCount - 1);
  }
  return null;
}
