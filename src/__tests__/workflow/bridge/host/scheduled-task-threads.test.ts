import '../../../setup/test-setup.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, it } from 'node:test';
import { CODELARK_HOME } from '../../../../configuration/paths.js';
import { createConfigService } from '../../../../configuration/service.js';
import { BaseChannelAdapter } from '../../../../channels/contracts.js';
import type { InboundMessage, OutboundMessage, SendResult, StreamingHistoryItem } from '../../../../domain/index.js';
import type { StreamChatParams } from '../../../../runtime/contracts.js';
import { sseEvent } from '../../../../runtime/sse.js';
import { initBridgeTestContext } from '../../../helpers/bridge/test-bridge-utils.js';
import * as router from '../../../../bridge/host/channel-router.js';
import { _testOnly, registerAdapter } from '../../../../bridge/host/manager.js';
import { listThenTasks } from '../../../../bridge/automation/then-tasks.js';
import { listEveryTasks } from '../../../../bridge/automation/every-tasks.js';

const address = { channelType: 'feishu-scheduled', channelProvider: 'feishu', chatId: 'oc_scheduled', userId: 'ou_test' };
class Adapter extends BaseChannelAdapter {
  readonly channelType = address.channelType;
  readonly provider = 'feishu';
  sent: OutboundMessage[] = [];
  starts: Array<{ chat: string; key?: string; target?: string }> = [];
  histories: StreamingHistoryItem[][] = [];
  titleResult?: SendResult;
  titleCount = 0;
  async start() {} async stop() {} isRunning() { return true; }
  consumeOne(): Promise<InboundMessage | null> { return Promise.resolve(null); }
  validateConfig() { return null; } isAuthorized() { return true; }
  supportsStructuredStreamingUi() { return true; }
  async send(message: OutboundMessage) {
    this.sent.push(message);
    if (message.startNewThread) return this.titleResult || { ok: true, messageId: `om_generated_title_${++this.titleCount}` };
    return { ok: true, messageId: `om_sent_${this.sent.length}` };
  }
  onMessageStart(_chat: string, key?: string, target?: string) { this.starts.push({ chat: _chat, key, target }); }
  onStreamHistory(_chat: string, items: StreamingHistoryItem[]) { this.histories.push(structuredClone(items)); }
  async onStreamEnd() { return false; }
}
async function until(predicate: () => boolean) {
  const end = Date.now() + 5_000;
  while (!predicate()) { assert(Date.now() < end, 'scheduled task did not reach expected state'); await new Promise(r => setTimeout(r, 20)); }
}
function fixture(thread = true, inputAddress = address) {
  const calls: StreamChatParams[] = [];
  const store = initBridgeTestContext({ llm: { streamChat(params) {
    calls.push(params);
    return new ReadableStream({ start(controller) {
      controller.enqueue(sseEvent('text', `result: ${params.prompt}`));
      controller.enqueue(sseEvent('result', { session_id: 'scheduled-native-id' }));
      controller.close();
    } });
  } } });
  _testOnly.resetStateForTests();
  createConfigService({ migrate: false, env: {} }).set({ kind: 'home' }, { channels: [{ id: address.channelType, provider: 'feishu', alias: 'Scheduled', enabled: true,
    config: { threadReplyChats: thread ? [address.chatId] : [], streamingEnabled: true } }] });
  const binding = router.createBinding(inputAddress, '/tmp/scheduled-thread-test');
  createConfigService({ migrate: false, env: {} }).set({ kind: 'session', sessionId: binding.bridgeSessionId }, { runtime: { claude: { provider: 'sdk' } } });
  store.updateSession(binding.bridgeSessionId, { runtime: { activeRuntime: 'claude' }, runtime_status: 'idle' });
  const adapter = new Adapter(); registerAdapter(adapter);
  const send = (text: string, extra: Partial<InboundMessage> = {}) => _testOnly.handleMessage(adapter, {
    address: inputAddress, text, messageId: 'om_command', timestamp: Date.now(), ...extra,
  });
  return { adapter, calls, store, binding, send };
}
beforeEach(() => { fs.rmSync(path.join(CODELARK_HOME, 'data'), { recursive: true, force: true }); fs.rmSync(path.join(CODELARK_HOME, 'config.toml'), { force: true }); });
afterEach(() => _testOnly.resetStateForTests());

for (const origin of ['om_topic_a', 'om_topic_b', undefined]) {
  it(`creates a fresh plain title for /then from ${origin || 'a root message'} and routes input and final output under it`, async () => {
    const f = fixture();
    await f.send('/then summarize the finished run', { threadRootMessageId: origin });
    await until(() => listThenTasks({ statuses: ['completed'] }).length === 1);
    assert(!Object.hasOwn(listThenTasks()[0], 'replyToMessageId'));
    assert.equal(f.calls[0].prompt, 'summarize the finished run');
    const title = f.adapter.sent.find(m => m.startNewThread)!;
    assert.equal(f.adapter.sent.filter(m => m.startNewThread).length, 1);
    assert.equal(title.platformMessage?.msgType, 'text');
    assert.equal(title.replyToMessageId, undefined); assert.equal(title.richCard, undefined);
    assert.deepEqual(f.adapter.starts.map(s => s.target), ['om_generated_title_1']);
    assert.match(f.adapter.starts[0].key!, /then:/);
    assert(f.adapter.histories.some(items => items.some(item => item.type === 'markdown' && item.role === 'user' && item.content === 'summarize the finished run')));
    assert.equal(f.adapter.sent.find(m => m.text.includes('result: summarize'))?.replyToMessageId, 'om_generated_title_1');
  });
}

for (const titleResult of [{ ok: false, error: 'send failed' }, { ok: true }] as SendResult[]) {
  it(`does not call the model when title creation ${titleResult.ok ? 'has no native ID' : 'fails'}`, async () => {
    const f = fixture(); f.adapter.titleResult = titleResult;
    f.store.updateSession(f.binding.bridgeSessionId, { runtime_status: 'running' });
    await f.send('/then cannot start');
    f.store.updateSession(f.binding.bridgeSessionId, { runtime_status: 'idle' });
    await until(() => listThenTasks({ statuses: ['failed'] }).length === 1);
    assert.equal(f.calls.length, 0); assert.equal(f.adapter.starts.length, 0);
    assert.match(listThenTasks()[0].lastError!, /无法创建任务话题/);
  });
}

it('creates a distinct title on every recurring trigger', async () => {
  const f = fixture(); await f.send('/every 1s recurring input', { threadRootMessageId: 'om_creation_topic' });
  await until(() => f.calls.length >= 1 && f.adapter.starts.length >= 1);
  await f.send('/status', { messageId: 'om_newer_outside_input' });
  await until(() => f.calls.length >= 2 && f.adapter.starts.length >= 2);
  assert.equal(f.adapter.sent.filter(m => m.startNewThread).length, 2);
  assert(!Object.hasOwn(listEveryTasks()[0], 'replyToMessageId'));
  assert.deepEqual(f.adapter.starts.map(s => s.target), ['om_generated_title_1', 'om_generated_title_2']);
  assert.deepEqual(f.adapter.sent.filter(m => m.text.includes('result: recurring')).map(m => m.replyToMessageId), ['om_generated_title_1', 'om_generated_title_2']);
  assert.notEqual(f.adapter.starts[0].key, f.adapter.starts[1].key);
});

it('keeps thread-mode off behavior even when the command came from a topic', async () => {
  const f = fixture(false); await f.send('/then ordinary output', { threadRootMessageId: 'om_old_topic' });
  await until(() => listThenTasks({ statuses: ['completed'] }).length === 1);
  assert.equal(f.adapter.sent.filter(m => m.startNewThread).length, 0);
  assert.equal(f.adapter.sent.find(m => m.text.includes('result: ordinary'))?.replyToMessageId, undefined);
});

it('gives monitor manual input a plain title when it has no reply target', async () => {
  const f = fixture();
  await f.send('monitor continuation', { messageId: 'manual:monitor-once', raw: { manualIngress: true } });
  assert.equal(f.calls.length, 1);
  assert.equal(f.adapter.sent.filter(m => m.startNewThread).length, 1);
  assert.equal(f.adapter.sent.find(m => m.startNewThread)?.platformMessage?.msgType, 'text');
  assert.equal(f.adapter.starts[0].target, 'om_generated_title_1');
  assert.match(f.adapter.starts[0].key!, /manual:monitor-once$/);
  assert.equal(f.adapter.sent.find(m => m.text.includes('result: monitor'))?.replyToMessageId, 'om_generated_title_1');
});

it('does not execute manual input if creating its topic fails', async () => {
  const f = fixture(); f.adapter.titleResult = { ok: false, error: 'denied' };
  await f.send('monitor continuation', { messageId: 'manual:monitor-failed', raw: { manualIngress: true } });
  assert.equal(f.calls.length, 0);
  assert.equal(f.adapter.starts.length, 0);
});

it('rejects automatic titles in isolated customer-service topics before sending a title or calling the model', async () => {
  const originalTopic = 'feishu-topic:oc_scheduled:om_original_topic';
  const f = fixture(true, { ...address, chatId: originalTopic });
  await f.send('isolated monitor continuation', { messageId: 'manual:isolated', raw: { manualIngress: true } });
  assert.equal(f.calls.length, 0);
  assert.equal(f.adapter.starts.length, 0);
  assert.equal(f.adapter.sent.filter(m => m.startNewThread).length, 0);
  assert.equal(f.store.getChannelChat(address.channelType, originalTopic)?.bridgeSessionId, f.binding.bridgeSessionId);
  assert(f.adapter.sent.some(m => m.text.includes('隔离客服话题暂不支持自动创建新话题')));
});
