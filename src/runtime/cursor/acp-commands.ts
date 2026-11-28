import type { StreamChatParams } from '../contracts.js';
import { prepareTextAttachmentPrompt } from '../local-attachments.js';

export function isCursorGoalPrompt(text: string): boolean {
  return /^\/goal(?:\s|$)/i.test(text.trim());
}

export function isCursorCompactPrompt(text: string): boolean {
  return /^\/(?:compact|compress|summarize)\s*$/i.test(text.trim());
}
export function isCursorControlPrompt(text: string): boolean {
  return isCursorGoalPrompt(text) || isCursorCompactPrompt(text);
}

/** Invalid commands must never become ordinary model requests. */
export function cursorAcpCommandNotice(text: string): string | undefined {
  const prompt = text.trim();
  if (/^\/(?:compact|compress|summarize)\s+\S/i.test(prompt)) {
    return '用法：`//compact`，在原 Cursor 会话中执行原生上下文压缩。';
  }
  if (/^\/goal\s*$/i.test(prompt)) {
    return '用法：`//goal <目标及完成条件>`，例如 `//goal 修复登录问题，通过回归测试后结束`。目标交由当前 Cursor 原生会话执行。';
  }
  return undefined;
}

export function prepareCursorAcpPrompt(params: StreamChatParams): string {
  const prompt = prepareTextAttachmentPrompt(params);
  if (isCursorCompactPrompt(params.prompt)) return params.prompt.trim();
  if (params.cursorSessionId || !params.systemPrompt) return prompt;
  // Cursor discovers the builtin goal skill from the leading slash command.
  // Keep the first-turn session instructions, but do not hide that command.
  return isCursorGoalPrompt(prompt)
    ? `${prompt}\n\n<session_instructions>\n${params.systemPrompt}\n</session_instructions>`
    : `${params.systemPrompt}\n\n${prompt}`;
}

export function cursorCliModel(args: string[] = []): string | undefined {
  const index = args.indexOf('--model');
  return index >= 0 ? args[index + 1] : args.find(arg => arg.startsWith('--model='))?.slice('--model='.length);
}
