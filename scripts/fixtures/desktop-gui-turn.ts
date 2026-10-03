import assert from 'node:assert/strict';
import type { AppServerMessage } from '../../src/runtime/codex/app-server-client.js';

/** 只接受本次观察期间同一 thread/turn 的真实输入、回复和成功终态。 */
export function completedDesktopGuiTurn(messages: AppServerMessage[], threadId: string, input: string, output: string): string | false {
  const items = messages.filter((message) => message.method === 'item/completed')
    .map((message) => message.params as any).filter((params) => params.threadId === threadId);
  const users = items.filter(({ item }) => item.type === 'userMessage'
    && item.content.map((part: any) => part.type === 'text' ? part.text : '').join('').trimEnd() === input);
  const replies = items.filter(({ item }) => item.type === 'agentMessage' && item.text === output);
  assert(users.length <= 1, '本次 GUI 输入必须只在原 thread 完成一次');
  assert(replies.length <= 1, '本次 GUI 回复必须只在原 thread 完成一次');
  if (!users.length || !replies.length) return false;
  const turnId = users[0].turnId;
  assert(turnId && replies[0].turnId === turnId, 'GUI 输入和回复必须属于同一个原生 turn');
  const completed = messages.filter((message) => message.method === 'turn/completed')
    .map((message) => message.params as any).find((params) => params.threadId === threadId && params.turn.id === turnId);
  if (!completed) return false;
  assert.equal(completed.turn.status, 'completed', 'GUI 恢复后的原生 turn 必须成功完成');
  assert.equal(completed.turn.error, null);
  return turnId;
}
