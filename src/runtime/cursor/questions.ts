import { readCursorNativeMessages, readCursorPendingQuestion, type CursorPendingQuestion } from './cli-store.js';
import { tmuxCore, type TmuxSendAction } from '../tmux/core.js';

export interface CursorQuestionTarget { storePath: string; targetPane: string; nativeSessionId?: string }
export interface CursorQuestionView { request: CursorPendingQuestion; index: number; screen: string }
export interface CursorQuestionAnswer { optionIds?: string[]; text?: string }
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function isCursorQuestionScreen(screen: string): boolean {
  return screen.includes('Enter next/submit') && screen.includes('Esc to skip');
}

export function assertCursorPromptAvailable(screen: string): void {
  if (isCursorQuestionScreen(screen)) throw new Error('Cursor 正在等待问卷回答，未发送新任务或额外 Enter。');
}

export function cursorQuestionIndex(screen: string, request: CursorPendingQuestion): number | null {
  if (!isCursorQuestionScreen(screen)) return null;
  const match = /Question\s+(\d+)\s+of\s+(\d+)/u.exec(screen);
  if (!match || Number(match[2]) !== request.questions.length) return null;
  const index = Number(match[1]) - 1;
  return index >= 0 && index < request.questions.length ? index : null;
}

export async function inspectCursorQuestion(target: CursorQuestionTarget): Promise<CursorQuestionView | null> {
  const request = readCursorPendingQuestion(target.storePath);
  if (!request) return null;
  const { screen } = await tmuxCore.capturePane(target.targetPane, 200);
  const index = cursorQuestionIndex(screen, request);
  return index === null ? null : { request, index, screen };
}

const answering = new Set<string>();

export async function answerCursorQuestion(
  target: CursorQuestionTarget, toolCallId: string, index: number, answer: CursorQuestionAnswer,
): Promise<void> {
  if (answering.has(target.targetPane)) throw new Error('正在提交这个 Cursor 问卷，请勿重复操作。');
  answering.add(target.targetPane);
  try { await submitCursorQuestion(target, toolCallId, index, answer); }
  finally { answering.delete(target.targetPane); }
}

/** Only answer the exact still-active question; never retry a submission key. */
async function submitCursorQuestion(
  target: CursorQuestionTarget, toolCallId: string, index: number, answer: CursorQuestionAnswer,
): Promise<void> {
  const view = await inspectCursorQuestion(target);
  if (!view || view.request.toolCallId !== toolCallId || view.index !== index) throw new Error('这个 Cursor 问题已处理或已改变，未提交旧答复。');
  const question = view.request.questions[index]!;
  const ids = answer.optionIds || [];
  if (!ids.length && !answer.text?.trim()) throw new Error('请先选择选项或填写回答。');
  if (ids.some((id) => !question.options.some((o) => o.id === id)) || (!question.allowMultiple && ids.length > 1)) throw new Error('回答不符合当前问题的选项。');
  if (answer.text && /[\x00-\x1f\x7f]/u.test(answer.text)) throw new Error('请用单行文字回答此问题。');
  const actions: TmuxSendAction[] = [];
  // Cursor clamps Up/Down at the ends. Reset focus without changing selections.
  const focus = (option: number) => {
    for (let i = 0; i <= question.options.length; i++) actions.push({ type: 'key', key: 'Up' });
    for (let i = 0; i < option; i++) actions.push({ type: 'key', key: 'Down' });
  };
  if (question.allowMultiple) {
    const rows = view.screen.split('\n').filter((line) => /^\s*│\s*[›>]?\s*\[[ xX✓]\]/u.test(line));
    if (rows.length !== question.options.length + 1) throw new Error('无法确认 Cursor 多选状态，未发送按键。');
    for (let i = 0; i < question.options.length; i++) {
      const checked = /\[[xX✓]\]/u.test(rows[i]!);
      const desired = ids.includes(question.options[i]!.id);
      if (checked !== desired) { focus(i); actions.push({ type: 'key', key: 'Space' }); }
    }
    if (!answer.text?.trim() && /\[[xX✓]\]/u.test(rows.at(-1)!)) {
      throw new Error('原生问卷已有其他文字回答，不能直接改成多选编号；请回复新的文字覆盖，或在终端调整后再回答。');
    }
  }
  if (answer.text?.trim()) {
    focus(question.options.length);
  } else {
    focus(question.options.findIndex((o) => o.id === ids[0]));
  }
  // Recheck identity immediately before mutation, including manual terminal replies.
  if (readCursorPendingQuestion(target.storePath)?.toolCallId !== toolCallId) throw new Error('Cursor 问题已失效。');
  await tmuxCore.sendActions(target.targetPane, actions, { delayMs: 35, forcePasteLiterals: true });
  const waitForEditor = async (ready: (view: CursorQuestionView) => boolean) => {
    const deadline = Date.now() + 3_000;
    while (true) {
      const current = await inspectCursorQuestion(target);
      if (!current || current.request.toolCallId !== toolCallId || current.index !== index) throw new Error('输入期间 Cursor 问题发生变化，未提交。');
      if (ready(current)) return;
      if (Date.now() >= deadline) throw new Error('未能确认问卷输入框中的完整文字，未提交，请查看 /tmux-screen。');
      await sleep(100);
    }
  };
  const editorText = (view: CursorQuestionView) => view.screen.split('Other:').at(-1)?.split('↑/↓')[0]?.replace(/[│\s]/gu, '') || '';
  if (answer.text?.trim()) {
    // Selecting Other mounts its native editor. Wait for that focus before
    // editing. Ctrl-U only clears up to the cursor, so first move to the end.
    await waitForEditor(view => /^\s*│\s*›\s*\[[ xX✓]\]\s*Other:/mu.test(view.screen));
    await tmuxCore.sendActions(target.targetPane, [{ type: 'key', key: 'C-e' }, { type: 'key', key: 'C-u' }], { delayMs: 35 });
    await waitForEditor(view => ['', '(typetoanswer)'].includes(editorText(view)));
    await tmuxCore.sendActions(target.targetPane, [{ type: 'literal', text: answer.text }], { forcePasteLiterals: true });
    await waitForEditor(view => editorText(view) === answer.text!.trim().replace(/\s/gu, ''));
  } else {
    await waitForEditor(() => true);
  }
  await tmuxCore.sendActions(target.targetPane, [{ type: 'key', key: 'Enter' }]);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const pending = readCursorPendingQuestion(target.storePath);
    if (index < view.request.questions.length - 1 && pending?.toolCallId === toolCallId) {
      const capture = await tmuxCore.capturePane(target.targetPane, 200);
      if (cursorQuestionIndex(capture.screen, pending) === index + 1) return;
    }
    const result = readCursorNativeMessages(target.storePath)?.some((message) => message.role === 'tool'
      && Array.isArray(message.content) && message.content.some((block) => block.type === 'tool-result' && block.toolCallId === toolCallId));
    if (result && pending?.toolCallId !== toolCallId) return;
    await sleep(100);
  }
  throw new Error('已发送回答，但尚未确认 Cursor 接受；没有重复提交，请查看当前问题状态。');
}
