import '../../../setup/test-setup.js';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { initBridgeTestContext, RecordingAdapter } from '../../../helpers/bridge/test-bridge-utils.js';
import { _testOnly as manager } from '../../../../bridge/host/manager.js';
import { createConfigService } from '../../../../configuration/service.js';
import { sseEvent } from '../../../../runtime/sse.js';
import type { StreamChatParams } from '../../../../runtime/contracts.js';
import type { StreamingHistoryItem } from '../../../../domain/index.js';
import { tmuxCore } from '../../../../runtime/tmux/core.js';

async function until(check: () => boolean) {
  for (let i = 0; i < 600; i++) { if (check()) return; await delay(10); }
  assert.ok(check(), 'ACP input did not reach its next lifecycle state');
}

it('ACP rapid follow-ups cancel once, wait for confirmation, preserve both inputs and use the latest reply target', { timeout: 15_000 }, async t => {
  const calls: StreamChatParams[] = [];
  const streams: ReadableStreamDefaultController<string>[] = [];
  const jobs: Promise<void>[] = [];
  const store = initBridgeTestContext({ llm: { streamChat(params) {
    calls.push(params);
    return new ReadableStream({ start(controller) {
      streams.push(controller);
      controller.enqueue(sseEvent('status', { session_id: 'acp-native-session' }));
      params.onInputAccepted?.();
    } });
  } } });
  manager.resetStateForTests();
  const session = store.createSession('ACP control', 'model', undefined, os.tmpdir());
  store.updateSession(session.id, { runtime: { activeRuntime: 'cursor', cursor: { provider: 'acp', sessionProvider: 'acp' } } });
  createConfigService({ migrate: false }).set({ kind: 'session', sessionId: session.id }, { runtime: { cursor: { provider: 'acp' } } });
  const address = { channelType: 'feishu', chatId: 'oc_cursor_acp_control' };
  store.upsertChannelChat({ ...address, bridgeSessionId: session.id });
  class Adapter extends RecordingAdapter {
    starts: Array<{ key?: string; origin?: string }> = [];
    reactions: string[] = [];
    histories: StreamingHistoryItem[][] = [];
    finalHistories = new Map<string, StreamingHistoryItem[]>();
    historyByStream = new Map<string, StreamingHistoryItem[]>();
    onMessageStart(_chat: string, key?: string, origin?: string) { this.starts.push({ key, origin }); }
    supportsStructuredStreamingUi() { return true; }
    onStreamText() {}
    hasActiveStreamingUi() { return true; }
    onStreamHistory(_chat: string, items: StreamingHistoryItem[], key?: string) {
      this.histories.push(structuredClone(items));
      this.historyByStream.set(key || '', structuredClone(items));
    }
    async onStreamEnd(_chat: string, _status: unknown, _text?: string, key?: string) {
      this.finalHistories.set(key || '', structuredClone(this.historyByStream.get(key || '') || []));
      return true;
    }
    async addMessageReaction(id: string) { this.reactions.push(id); return id; }
  }
  const adapter = new Adapter();
  const originalCapture = tmuxCore.capturePane;
  tmuxCore.capturePane = async () => { throw new Error('ACP must not inspect or drive tmux'); };
  let closed = 0;
  const finish = (index: number, outcome = 'completed') => {
    streams[index]!.enqueue(sseEvent('result', { session_id: 'acp-native-session', outcome }));
    streams[index]!.close(); closed++;
  };
  t.after(async () => {
    for (let i = closed; i < streams.length; i++) { try { finish(i, 'aborted'); } catch {} }
    await Promise.allSettled(jobs);
    tmuxCore.capturePane = originalCapture;
    manager.resetStateForTests();
  });
  const msg = (text: string, id: string) => ({ address, text, messageId: id, timestamp: Date.now() });
  const first = msg('先分析这个问题', 'om_initial');
  assert.equal(manager.shouldBypassSessionLock(first), true, 'ACP has an interruptible intake even before its first turn');
  assert.equal(manager.adapterImmediateLane(first, 'bypass')?.laneKind, 'control');
  jobs.push(manager.handleMessageWithoutDeliveryWait(adapter, first));
  await until(() => calls.length === 1);
  streams[0]!.enqueue(sseEvent('text', '正在分析。'));
  let cancellations = 0;
  calls[0]!.abortController!.signal.addEventListener('abort', () => { cancellations++; });
  jobs.push(manager.handleMessageWithoutDeliveryWait(adapter, msg('先修复吞吐', 'om_followup_1')));
  jobs.push(manager.handleMessageWithoutDeliveryWait(adapter, msg('并保留数值精度', 'om_followup_2')));
  await delay(30);
  assert.equal(cancellations, 1);
  assert.equal(calls.length, 1, 'next prompt cannot start before backend cancellation is confirmed');
  streams[0]!.enqueue(sseEvent('text', '取消确认前已生成的最后一句。'));
  streams[0]!.enqueue(sseEvent('tool_use', { id: 'tail-tool', name: 'Shell', input: { command: 'pwd' } }));
  streams[0]!.enqueue(sseEvent('tool_result', { tool_use_id: 'tail-tool', content: '/isolated', is_error: false }));
  finish(0, 'aborted');
  await until(() => calls.length === 2);
  assert.equal(calls[1]!.cursorProvider, 'acp');
  assert.equal(calls[1]!.cursorSessionId, 'acp-native-session');
  assert.equal(calls[1]!.prompt, '先修复吞吐\n\n并保留数值精度');
  assert.equal(adapter.starts.at(-1)?.origin, 'om_followup_2');
  await until(() => adapter.reactions.length === 3);
  assert.deepEqual(adapter.reactions, ['om_initial', 'om_followup_1', 'om_followup_2']);
  streams[1]!.enqueue(sseEvent('text', '两个要求都已接收。'));
  finish(1);
  await Promise.all(jobs);
  const oldKey = adapter.starts[0]!.key!;
  await until(() => adapter.finalHistories.has(oldKey));
  assert.match(JSON.stringify(adapter.finalHistories.get(oldKey)), /取消确认前已生成的最后一句/,
    'the interrupted card must drain received output through the native terminal response');
  assert.doesNotMatch(JSON.stringify(adapter.finalHistories.get(oldKey)), /两个要求都已接收/);
  assert.match(JSON.stringify(store.getMessages(session.id).messages), /取消确认前已生成的最后一句/,
    'interrupted output remains in local history exactly once');
  assert.equal(calls.length, 2, 'both rapid follow-ups share one next prompt, without replay');
  jobs.push(manager.handleMessageWithoutDeliveryWait(adapter, {
    ...msg('迁移后的追加', 'manual:migration-once'),
    outputReplyToMessageId: 'om_existing_topic', raw: { manualIngress: true },
  }));
  await until(() => calls.length === 3);
  assert.equal(adapter.starts.at(-1)?.origin, 'om_existing_topic', 'manual continuation preserves its explicit real topic');
  assert.match(adapter.starts.at(-1)?.key || '', /manual:migration-once$/, 'execution identity stays independent of the topic');
  assert.equal(calls[2]!.prompt, '迁移后的追加');
  assert.equal(adapter.reactions.length, 3, 'manual delivery cannot react to an unrelated user message');
  finish(2);
  await Promise.all(jobs);
  assert.equal(store.getSession(session.id)?.runtime?.cursor?.sessionProvider, 'acp');
  assert.ok(adapter.histories.some(items => JSON.stringify(items).includes('先修复吞吐')),
    'ACP user input must appear in the card without a transcript mirror');
  await manager.reconcileMirrorSubscriptions();
  assert.equal(store.getSession(session.id)?.runtime?.cursor?.sessionId, 'acp-native-session',
    'the absent TUI transcript must not clear the ACP identity');
});

it('ACP commands stay separate from rapid follow-ups; malformed compact and goal help do not interrupt work', { timeout: 15_000 }, async t => {
  const calls: StreamChatParams[] = [];
  const streams: ReadableStreamDefaultController<string>[] = [];
  const jobs: Promise<void>[] = [];
  const store = initBridgeTestContext({ llm: { streamChat(params) {
    calls.push(params);
    return new ReadableStream({ start(controller) {
      streams.push(controller);
      controller.enqueue(sseEvent('status', { session_id: 'native-goal-session' }));
      params.onInputAccepted?.();
    } });
  } } });
  manager.resetStateForTests();
  const session = store.createSession('ACP commands', 'model', undefined, os.tmpdir());
  store.updateSession(session.id, { runtime: { activeRuntime: 'cursor', cursor: { provider: 'acp', sessionProvider: 'acp' } } });
  createConfigService({ migrate: false }).set({ kind: 'session', sessionId: session.id }, { runtime: { cursor: { provider: 'acp' } } });
  const address = { channelType: 'feishu', chatId: 'oc_cursor_acp_commands' };
  store.upsertChannelChat({ ...address, bridgeSessionId: session.id });
  const adapter = new RecordingAdapter();
  const message = (text: string, id: string) => ({ address, text, messageId: id, timestamp: Date.now() });
  const finish = (index: number) => {
    streams[index]!.enqueue(sseEvent('text', `完成 ${index}`));
    streams[index]!.enqueue(sseEvent('result', { session_id: 'native-goal-session', outcome: 'completed' }));
    streams[index]!.close();
  };
  t.after(async () => {
    for (const stream of streams) { try { stream.close(); } catch {} }
    await Promise.allSettled(jobs);
    manager.resetStateForTests();
  });
  jobs.push(manager.handleMessageWithoutDeliveryWait(adapter, message('当前工作', 'om_work')));
  await until(() => calls.length === 1);
  await manager.handleMessage(adapter, message('//compact extra', 'om_compact'));
  await manager.handleMessage(adapter, message('//goal', 'om_goal_help'));
  assert.equal(calls[0].abortController!.signal.aborted, false);
  assert.equal(calls.length, 1);
  assert.match(JSON.stringify(adapter.sent), /用法/);
  assert.match(JSON.stringify(adapter.sent), /目标及完成条件/);
  jobs.push(manager.handleMessageWithoutDeliveryWait(adapter, message('先记住约束', 'om_before')));
  jobs.push(manager.handleMessageWithoutDeliveryWait(adapter, { ...message('//goal 完成修复并验证', 'om_goal'), contextText: '<quoted_message>thread source</quoted_message>' }));
  jobs.push(manager.handleMessageWithoutDeliveryWait(adapter, { ...message('//compact', 'om_compact_valid'), contextText: '<quoted_message>thread source</quoted_message>' }));
  jobs.push(manager.handleMessageWithoutDeliveryWait(adapter, message('补充说明', 'om_after')));
  await delay(20);
  assert.equal(calls[0].abortController!.signal.aborted, true);
  finish(0);
  await until(() => calls.length === 2);
  assert.equal(calls[1].prompt, '先记住约束');
  finish(1);
  await until(() => calls.length === 3);
  assert.equal(calls[2].prompt, '/goal 完成修复并验证\n\n<quoted_message>thread source</quoted_message>');
  finish(2);
  await until(() => calls.length === 4);
  assert.equal(calls[3].prompt, '/compact');
  jobs.push(manager.handleMessageWithoutDeliveryWait(adapter, message('压缩中追加', 'om_during_compact')));
  await delay(20);
  assert.equal(calls[3].abortController!.signal.aborted, true);
  finish(3);
  await until(() => calls.length === 5);
  assert.equal(calls[4].prompt, '补充说明\n\n压缩中追加');
  finish(4);
  await Promise.all(jobs);
  assert.ok(calls.slice(1).every(call => call.cursorSessionId === 'native-goal-session'));
});
