import '../../../setup/test-setup.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cursorNativeStore, cursorQuestionFixture, pendingCursorQuestion, cursorQuestionScreen } from '../../../helpers/runtime/cursor-native-store.js';
import { readCursorNativeMessages, readCursorPendingQuestion } from '../../../../runtime/cursor/cli-store.js';
import { answerCursorQuestion, cursorQuestionIndex } from '../../../../runtime/cursor/questions.js';
import { tmuxCore, type TmuxSendAction } from '../../../../runtime/tmux/core.js';
import { isCursorInputReadyScreen, waitForCursorInputSubmitted } from '../../../../runtime/cursor/tmux-provider.js';
import { computeBaseDiagnosis, applyProcessProbeDiagnosis } from '../../../../bridge/health/reducer.js';
import { formatStreamRuntimeStatus } from '../../../../bridge/turn/stream-state.js';
import { formatHealthStatusLabel } from '../../../../bridge/command/presentation/diagnostics.js';
import { buildCursorQuestionCard } from '../../../../bridge/permission/cursor-questions.js';
import { buildRichCardContent } from '../../../../channels/feishu/markdown.js';
import type { BridgeSession } from '../../../../domain/session.js';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-question-unit-'));
let seq = 0;
after(() => fs.rmSync(root, { recursive: true, force: true }));
function fixture(t: { after: (fn: () => void) => void }) {
  const storePath = path.join(root, `${seq++}.db`);
  const db = cursorNativeStore(storePath);
  t.after(() => { db.close(); fs.rmSync(storePath, { force: true }); });
  return { db, storePath, targetPane: 'isolated-question:0.0' };
}
test('native long choices stay complete above short buttons, without squeezing the question', () => {
  const label = 't_min=0.6, t_max=1.0（整体 +0.2，前 60 步约 1.00→0.88）(Recommended)';
  const card = buildCursorQuestionCard({ index: 0, screen: '', request: {
    toolCallId: 'native-call', title: '采样温度实验配置确认',
    questions: [{ id: 'temperature', prompt: '新实验的去噪采样温度设为多少？', allowMultiple: false,
      options: Array.from({ length: 4 }, (_, i) => ({ id: `t${i}`, label: `${label} ${i}` })) }],
  } }, 'cursor-question:long-label');
  const rendered = JSON.parse(buildRichCardContent(card, 'question-chat'));
  const content = rendered.body.elements[0];
  assert.equal(content.columns.length, 1, 'question and choices must have the full card width');
  const text = content.columns[0].elements[0].content;
  for (let i = 0; i < 4; i++) assert.ok(text.includes(`${label} ${i}`), 'native option descriptions must not be truncated');
  const row = rendered.body.elements.at(-1);
  assert.deepEqual(row.columns.map((c: any) => c.elements[0].text.content), ['选 1', '选 2', '选 3', '选 4']);
  assert.deepEqual(card.actions![0].map(b => b.callbackData), Array.from({ length: 4 }, (_, i) => `cursor-question:long-label:${i}`));
});
test('pending AskQuestion is read before transcript checkpointing, and disappears at completion', (t) => {
  const { db, storePath } = fixture(t);
  db.checkpoint([{ role: 'user', content: 'test' }], [pendingCursorQuestion(), { role: 'assistant', content: [] }]);
  assert.deepEqual(readCursorPendingQuestion(storePath), { toolCallId: 'question-1', ...cursorQuestionFixture });
  assert.equal(readCursorNativeMessages(storePath)?.length, 1);
  db.checkpoint([{ role: 'user', content: 'test' }, pendingCursorQuestion()]);
  assert.equal(readCursorPendingQuestion(storePath), null, 'old AskQuestion in history is not pending');
  db.checkpoint([{ role: 'user', content: 'test' }], ['malformed', pendingCursorQuestion('bad', { questions: [null] })]);
  assert.equal(readCursorPendingQuestion(storePath), null);
  assert.equal(readCursorNativeMessages(storePath)?.length, 1, 'unknown pending data must not erase committed messages');
});
test('native question panel cannot be treated as an editable prompt or receive retry Enter', async (t) => {
  const screen = cursorQuestionScreen();
  assert.equal(isCursorInputReadyScreen(screen), false);
  assert.equal(cursorQuestionIndex(screen, { toolCallId: 'q', ...cursorQuestionFixture }), 0);
  t.mock.method(tmuxCore, 'capturePane', async () => ({ screen }));
  const sends = t.mock.method(tmuxCore, 'sendActions', async () => { throw Error('unexpected Enter'); });
  const readPaneDead = tmuxCore.readPaneDead;
  tmuxCore.readPaneDead = async () => false;
  t.after(() => { tmuxCore.readPaneDead = readPaneDead; });
  await waitForCursorInputSubmitted('isolated-question:0.0');
  assert.equal(sends.mock.callCount(), 0);
});
test('stale question and invalid answers cannot send keys', async (t) => {
  const f = fixture(t); f.db.checkpoint([], [pendingCursorQuestion()]);
  t.mock.method(tmuxCore, 'capturePane', async () => ({ screen: cursorQuestionScreen() }));
  const sends = t.mock.method(tmuxCore, 'sendActions', async () => {});
  await assert.rejects(answerCursorQuestion(f, 'old', 0, { optionIds: ['high'] }), /已处理或已改变/);
  await assert.rejects(answerCursorQuestion(f, 'question-1', 1, { optionIds: ['high'] }), /已处理或已改变/);
  await assert.rejects(answerCursorQuestion(f, 'question-1', 0, { optionIds: ['unknown'] }), /选项/);
  await assert.rejects(answerCursorQuestion(f, 'question-1', 0, { text: 'bad\ntext' }), /单行/);
  assert.equal(sends.mock.callCount(), 0);
});
test('accepted first answer must advance the native question before success', async (t) => {
  const f = fixture(t); f.db.checkpoint([], [pendingCursorQuestion()]);
  let index = 0;
  t.mock.method(tmuxCore, 'capturePane', async () => ({ screen: cursorQuestionScreen(index) }));
  t.mock.method(tmuxCore, 'sendActions', async (_target: string, actions: TmuxSendAction[]) => {
    assert.deepEqual(actions.map(a => a.type === 'key' ? a.key : a.text), actions.length === 1 ? ['Enter'] : ['Up', 'Up', 'Up', 'Down']); if (actions.length === 1) index = 1;
  });
  await answerCursorQuestion(f, 'question-1', 0, { optionIds: ['high'] });
});
test('38 minute pending question reports waiting_input and hides the stale response timer', () => {
  const session = { id: 'test', runtime_status: 'running', last_progress_at: new Date(Date.now() - 38 * 60_000).toISOString(), pending_user_input: '实验参数（第 1/2 题）' } as BridgeSession;
  const diagnosis = computeBaseDiagnosis(session, Date.now());
  assert.equal(diagnosis.healthStatus, 'waiting_input');
  assert.equal(formatHealthStatusLabel(diagnosis.healthStatus), '等待回答');
  assert.match(diagnosis.healthReason, /等待你的回答/);
  assert.equal(applyProcessProbeDiagnosis(diagnosis, { status: 'alive' } as never).healthStatus, 'waiting_input');
  const status = formatStreamRuntimeStatus(38 * 60_000, 38 * 60_000, undefined, undefined, undefined, undefined, session.pending_user_input);
  assert.match(status, /等待你的回答/); assert.doesNotMatch(status, /上次响应/);
});

test('two chats answering one native pane cannot interleave keys', async (t) => {
  const f = fixture(t); f.db.checkpoint([], [pendingCursorQuestion()]);
  let index = 0, release!: () => void, started!: () => void;
  const blocked = new Promise<void>(r => { release = r; });
  const sending = new Promise<void>(r => { started = r; });
  t.mock.method(tmuxCore, 'capturePane', async () => ({ screen: cursorQuestionScreen(index) }));
  const sends = t.mock.method(tmuxCore, 'sendActions', async (_target: string, actions: TmuxSendAction[]) => { if (actions.length === 1) { index = 1; return; } started(); await blocked; });
  const first = answerCursorQuestion(f, 'question-1', 0, { optionIds: ['high'] });
  await sending;
  await assert.rejects(answerCursorQuestion(f, 'question-1', 0, { optionIds: ['low'] }), /请勿重复操作/);
  release(); await first;
  assert.equal(sends.mock.callCount(), 2);
});
