import '../../../setup/test-setup.js';
import { beforeEach, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { initBridgeTestContext, resetBridgeTestState, RecordingAdapter } from '../../../helpers/bridge/test-bridge-utils.js';
import { createAdapterRuntime } from '../../../../channels/adapter-runtime/runtime.js';
import { createConfigService } from '../../../../configuration/service.js';
import { _testOnly as manager } from '../../../../bridge/host/manager.js';
import * as router from '../../../../bridge/session/channel-router.js';
import { buildCommandCallbackData } from '../../../../bridge/command/callbacks.js';
import type { InboundMessage } from '../../../../domain/index.js';

beforeEach(() => resetBridgeTestState());
async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) { if (check()) return; await delay(5); }
  assert(check(), '配置操作不能等待旧任务结束');
}

for (const observed of ['idle', 'running'] as const) it(`settings remain available while an old task is held and the saved state says ${observed}`, async (t) => {
  const store = initBridgeTestContext();
  const address = { channelType: 'feishu', chatId: `settings-control-${observed}` };
  const binding = router.createBinding(address, os.tmpdir());
  const service = createConfigService({ migrate: false, env: {} });
  const scope = { kind: 'session' as const, sessionId: binding.bridgeSessionId };
  service.set(scope, { runtime: { codex: { provider: 'sdk', yoloMode: 'off' } } });
  store.updateSession(binding.bridgeSessionId, { runtime_status: observed, health_status: observed === 'running' ? 'running_active' : 'completed' });
  class QueuedAdapter extends RecordingAdapter {
    running = true;
    isRunning() { return this.running; }
    consumeOne() { return this.consumeInboundMessage(this.running); }
    async stop() { this.running = false; this.rejectPendingInboundConsumers(); }
  }
  const adapter = new QueuedAdapter();
  const state = { adapters: new Map(), adapterMeta: new Map(), invalidAdapters: new Map(), loopAborts: new Map(), running: true };
  let release!: () => void;
  const unfinished = new Promise<void>((resolve) => { release = resolve; });
  let locks = 0;
  const runtime = createAdapterRuntime(() => state, {
    notifyAdapterSetChanged: () => {},
    handleMessage: async (a, msg) => { if (msg.messageId !== 'old-job') await manager.handleMessage(a, msg); },
    processWithSessionLock: async (_id, fn) => { locks++; await unfinished; await fn(); },
    isCommandMessage: (msg) => manager.isBridgeCommandText(msg.text),
    shouldBypassSessionLock: manager.shouldBypassSessionLock,
    getImmediateLane: manager.adapterImmediateLane,
    getSessionLane: manager.adapterSessionLane,
    resolveSessionIdForMessage: () => binding.bridgeSessionId,
  });
  t.after(async () => { state.running = false; release(); await adapter.stop(); });
  runtime.runAdapterLoop(adapter);
  let sequence = 0;
  const send = (text: string, extra: Partial<InboundMessage> = {}) => adapter.enqueueManualInboundMessage({ address, text, messageId: `settings-${++sequence}`, timestamp: Date.now(), ...extra });
  send('old task', { messageId: 'old-job' });
  await until(() => locks === 1);
  for (const command of ['/model gpt-5.4', '/yolo', '/yolo', '/yolo off', '/reasoning high', `/cd ${os.tmpdir()}`]) send(command);
  await until(() => adapter.sent.length >= 6);
  assert.equal(locks, 1);
  assert.equal(service.get('runtime.codex.model', scope), 'gpt-5.4');
  assert.equal(service.get('runtime.codex.yoloMode', scope), 'off');
  assert.equal(service.get('runtime.codex.reasoningEffort', scope), 'high');
  assert.equal(store.getChannelChat(address.channelType, address.chatId)?.bridgeSessionId, binding.bridgeSessionId);

  // 模拟旧卡：切换聊天绑定之后再提交，不能将旧配置写到新会话。
  const replacement = router.createBinding(address, os.tmpdir());
  send('', { callbackData: buildCommandCallbackData('/current-config codex', binding.bridgeSessionId), raw: { action: { form_value: { codexDefaultModel: 'wrong-model' } } } });
  await until(() => adapter.sent.some((message) => /这个按钮对应的会话已不再绑定/.test(message.text)));
  assert.notEqual(service.get('runtime.codex.model', { kind: 'session', sessionId: replacement.bridgeSessionId }), 'wrong-model');
  assert.equal(locks, 1);
});
