export function stripTerminalControl(text: string): string {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[PX^_].*?\x1b\\/gs, '')
    .replace(/\x1b[@-_]/g, '');
}

export function normalizeTerminalScreenText(text: string): string {
  return stripTerminalControl(text)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

export function compactTerminalScreenText(text: string): string {
  return normalizeTerminalScreenText(text).replace(/\s+/g, '').toLowerCase();
}

export function hasTuiEnterConfirmFooter(text: string, options: { requireEscape?: boolean } = {}): boolean {
  return normalizeTerminalScreenText(text)
    .split('\n')
    .some((line) => {
      if (!/(?:^|\b)(?:Press\s+)?Enter\s+to\s+confirm\b/i.test(line)) return false;
      return options.requireEscape === true ? /\bEsc\b/i.test(line) : true;
    });
}

export function hasTuiEnterContinueFooter(text: string): boolean {
  return normalizeTerminalScreenText(text)
    .split('\n')
    .some((line) => /(?:^|\b)(?:Press\s+)?Enter\s+to\s+continue\b/i.test(line));
}

export function hasTuiEnterActionFooter(text: string, options: { requireEscapeForConfirm?: boolean } = {}): boolean {
  return hasTuiEnterContinueFooter(text)
    || hasTuiEnterConfirmFooter(text, { requireEscape: options.requireEscapeForConfirm });
}
