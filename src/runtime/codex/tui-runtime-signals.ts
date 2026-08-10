const ANSI_ESCAPE = /\u001b\[[0-?]*[ -/]*[@-~]/g;

export interface CodexTuiReconnectSignal {
  attempt: number;
  maxAttempts: number;
}

export interface CodexTuiModelMismatchWarning {
  recordedModel: string;
  resumingModel: string;
}

export type CodexTuiDiagnosticImpact = 'operation' | 'turn' | 'session';

export interface CodexTuiDiagnostic {
  message: string;
  impact: CodexTuiDiagnosticImpact;
  terminal: boolean;
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

export function parseCodexTuiModelMismatchWarning(
  screenText: string,
): CodexTuiModelMismatchWarning | null {
  const lines = terminalLines(screenText);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!/^\s*⚠\s*This session was recorded with model\b/iu.test(lines[index] || '')) continue;
    const fragments = [lines[index] || ''];
    for (let continuationIndex = index + 1; continuationIndex < lines.length; continuationIndex += 1) {
      const continuation = lines[continuationIndex] || '';
      if (!/^\s{2,}\S/u.test(continuation)) break;
      fragments.push(continuation);
    }
    const candidate = fragments.join('\n');
    const match = candidate.match(
      /^\s*⚠\s*This session was recorded with model\s+`([^`]+)`\s+but is resuming with\s+`([^`]+)`\s*\./iu,
    );
    if (!match) continue;
    const recordedModel = match[1].replace(/\s+/gu, '').trim();
    const resumingModel = match[2].replace(/\s+/gu, '').trim();
    if (recordedModel && resumingModel) return { recordedModel, resumingModel };
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
  return findNewCodexTuiErrorMessages(beforeScreenText, afterScreenText)[0] || null;
}

export function findNewCodexTuiErrorMessages(
  beforeScreenText: string,
  afterScreenText: string,
): string[] {
  const remaining = new Map<string, number>();
  for (const message of extractCodexTuiErrorMessages(beforeScreenText)) {
    remaining.set(message, (remaining.get(message) || 0) + 1);
  }
  const added: string[] = [];
  for (const message of extractCodexTuiErrorMessages(afterScreenText)) {
    const previousCount = remaining.get(message) || 0;
    if (previousCount <= 0) {
      added.push(message);
    } else {
      remaining.set(message, previousCount - 1);
    }
  }
  return added;
}

function isStructuredTerminalError(message: string): boolean {
  if (!/^(?:\{|\[)/u.test(message)) return false;
  try {
    const parsed = JSON.parse(message) as unknown;
    if (!parsed || typeof parsed !== 'object') return false;
    return 'error' in parsed || 'message' in parsed;
  } catch {
    return false;
  }
}

export function classifyCodexTuiDiagnostic(message: string): CodexTuiDiagnostic {
  const normalized = message.replace(/\s+/gu, ' ').trim();
  if (/app-server event stream disconnected|fatal exit|session (?:ended|terminated|is no longer available)/iu.test(normalized)) {
    return { message: normalized, impact: 'session', terminal: true };
  }
  if (
    isStructuredTerminalError(normalized)
    || /conversation interrupted|goal budget reached - the turn was stopped|failed to start turn|exceeded retry limit|(?:usage limit|credits?) reached|out of credits/iu.test(normalized)
  ) {
    return { message: normalized, impact: 'turn', terminal: true };
  }
  return { message: normalized, impact: 'operation', terminal: false };
}

export function findNewCodexTuiDiagnostic(
  beforeScreenText: string,
  afterScreenText: string,
): CodexTuiDiagnostic | null {
  const message = findNewCodexTuiErrorMessage(beforeScreenText, afterScreenText);
  return message ? classifyCodexTuiDiagnostic(message) : null;
}

export function findNewCodexTuiDiagnostics(
  beforeScreenText: string,
  afterScreenText: string,
): CodexTuiDiagnostic[] {
  return findNewCodexTuiErrorMessages(beforeScreenText, afterScreenText)
    .map(classifyCodexTuiDiagnostic);
}
