import '../../../setup/test-setup.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { initBridgeTestContext, RecordingAdapter } from '../../../helpers/bridge/test-bridge-utils.js';
import { createAdapterRuntime } from '../../../../channels/adapter-runtime/runtime.js';
import { createConfigService } from '../../../../configuration/service.js';
import { _testOnly as manager } from '../../../../bridge/host/manager.js';
import * as router from '../../../../bridge/session/channel-router.js';
import type { InboundMessage } from '../../../../domain/index.js';

async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) { if (check()) return; await delay(5); }
  assert(check(), 'control operation was blocked by the old task');
}

for (const confirmation of ['text', 'button', 'tmux', 'stale-text'] as const) it(`reset control bypasses an unfinished session job: ${confirmation}`, async (t) => {
  const store = initBridgeTestContext();
  const address = { channelType: 'feishu', chatId: `reset-control-${confirmation}` };
  const binding = router.createBinding(address, os.tmpdir());
  createConfigService({ migrate: false, env: {} }).set({ kind: 'session', sessionId: binding.bridgeSessionId }, { runtime: { codex: { provider: 'sdk' } } });
  store.updateSession(binding.bridgeSessionId, { health_status: 'running_active' });
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
  const send = (text: string, messageId: string, extra: Partial<InboundMessage> = {}) => adapter.enqueueManualInboundMessage({ address, text, messageId, timestamp: Date.now(), ...extra });
  send('old task', 'old-job');
  await until(() => locks === 1);
  send(confirmation === 'tmux' ? '/p tmux' : '/clear', 'reset-command');
  await until(() => adapter.sent.some((message) => !!message.richCard));
  const card = adapter.sent.find((message) => !!message.richCard)!.richCard!;
  assert.match(card.actions![0]![0]!.text, confirmation === 'tmux' ? /结束并重启/ : /终止并新建/);
  assert.equal(locks, 1, 'confirmation card must appear while the old session lock is held');
  if (confirmation === 'tmux') return;
  if (confirmation === 'stale-text') {
    const replacement = router.createBinding(address, os.tmpdir());
    send('是', 'confirm-text');
    await until(() => adapter.sent.some((message) => /这个确认对应的会话已切换/.test(message.text)));
    assert.equal(store.getChannelChat(address.channelType, address.chatId)?.bridgeSessionId, replacement.bridgeSessionId);
    return;
  }
  if (confirmation === 'button') send('', 'confirm-button', { callbackData: card.actions![0]![0]!.callbackData, callbackMessageId: 'reset-card' });
  else send('是', 'confirm-text');
  await until(() => adapter.sent.some((message) => /已清空当前聊天上下文/.test(message.text)));
  assert.notEqual(store.getChannelChat(address.channelType, address.chatId)?.bridgeSessionId, binding.bridgeSessionId);
  assert.equal(locks, 1, 'confirmed reset must complete without releasing the old task');
});
