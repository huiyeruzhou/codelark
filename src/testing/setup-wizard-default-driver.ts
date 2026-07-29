function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[PX^_].*?\x1b\\/gs, '')
    .replace(/\x1b[@-_]/g, '');
}

/**
 * Drives only completed Clack prompts. Long-running work between prompts (for
 * example QR authorization) must not consume future default confirmations.
 */
export class SetupWizardDefaultDriver {
  private lastSubmittedPromptStart = -1;
  private readonly maxSubmissions: number;
  submissionCount = 0;

  constructor(maxSubmissions = 40) {
    this.maxSubmissions = maxSubmissions;
  }

  shouldSubmit(output: string): boolean {
    if (this.submissionCount >= this.maxSubmissions) return false;

    const visible = stripAnsi(output).replace(/\r/gu, '');
    const promptStart = visible.lastIndexOf('\n◆');
    const normalizedPromptStart = promptStart >= 0
      ? promptStart + 1
      : visible.startsWith('◆')
        ? 0
        : -1;
    if (normalizedPromptStart < 0 || normalizedPromptStart <= this.lastSubmittedPromptStart) return false;

    const prompt = visible.slice(normalizedPromptStart);
    const promptEnd = prompt.lastIndexOf('\n└');
    if (promptEnd < 0 || prompt.slice(promptEnd + 2).trim() !== '') return false;

    if (this.lastSubmittedPromptStart >= 0) {
      const sinceLastSubmission = visible.slice(this.lastSubmittedPromptStart, normalizedPromptStart);
      if (!sinceLastSubmission.includes('\n◇')) return false;
    }

    this.lastSubmittedPromptStart = normalizedPromptStart;
    this.submissionCount += 1;
    return true;
  }
}
