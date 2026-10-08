import '../../../setup/test-setup.js';
import { beforeEach, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { initBridgeTestContext, resetBridgeTestState, RecordingAdapter } from '../../../helpers/bridge/test-bridge-utils.js';
import { createAdapterRuntime } from '../../../../channels/adapter-runtime/runtime.js';
import { _testOnly as manager } from '../../../../bridge/host/manager.js';
import * as router from '../../../../bridge/session/channel-router.js';
import { buildCommandCallbackData } from '../../../../bridge/command/callbacks.js';

beforeEach(() => resetBridgeTestState());

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 600; i++) { if (check()) return; await delay(5); }
  assert(check(), '只读查询必须在旧任务释放之前返回');
}

for (const backend of ['legacy', 'app-server'] as const) {
  for (const held of [false, true]) {
    it(`${backend} 的 provider/runtime 查询与回调在旧任务 held=${held} 时可回读`, async (t) => {
      const store = initBridgeTestContext();
      const address = { channelType: 'feishu', chatId: `readonly-${backend}-${held}` };
      const binding = router.createBinding(address, os.tmpdir());
      const codex = { threadId: 'readonly-native-thread',
        ...(backend === 'app-server' ? { appServerEndpoint: 'unix:///unstarted-readonly-fixture.sock' } : {}) };
      store.updateSession(binding.bridgeSessionId, { runtime_status: held ? 'running' : 'idle', runtime: { codex } });
      class QueuedAdapter extends RecordingAdapter {
        running = true;
        isRunning() { return this.running; }
        consumeOne() { return this.consumeInboundMessage(this.running); }
        async stop() { this.running = false; this.rejectPendingInboundConsumers(); }
      }
      const adapter = new QueuedAdapter();
      const state = { adapters: new Map(), adapterMeta: new Map(), invalidAdapters: new Map(), loopAborts: new Map(), running: true };
      let release!: () => void;
      const oldTask = new Promise<void>((resolve) => { release = resolve; });
      let locks = 0;
      const runtime = createAdapterRuntime(() => state, {
        notifyAdapterSetChanged: () => {},
        handleMessage: async (a, msg) => { if (msg.messageId !== 'old-job') await manager.handleMessage(a, msg); },
        processWithSessionLock: async (_id, fn) => { locks++; if (held) await oldTask; await fn(); },
        isCommandMessage: (msg) => manager.isBridgeCommandText(msg.text),
        shouldBypassSessionLock: manager.shouldBypassSessionLock,
        getImmediateLane: manager.adapterImmediateLane,
        getSessionLane: manager.adapterSessionLane,
        resolveSessionIdForMessage: () => binding.bridgeSessionId,
      });
      t.after(async () => { state.running = false; release(); await adapter.stop(); });
      runtime.runAdapterLoop(adapter);
      if (held) {
        adapter.enqueueManualInboundMessage({ address, text: 'old task waiting for an answer', messageId: 'old-job', timestamp: Date.now() });
        await until(() => locks === 1);
      }
      const queries = [
        { text: '/p', title: '当前 Codex Provider' },
        { text: '/provider@CodeLark  ', title: '当前 Codex Provider' },
        { text: '/runtime', title: '当前 Runtime' },
        { text: '', callbackData: buildCommandCallbackData('/p', binding.bridgeSessionId), title: '当前 Codex Provider' },
        { text: '', callbackData: buildCommandCallbackData('/runtime', binding.bridgeSessionId), title: '当前 Runtime' },
      ];
      for (const [index, query] of queries.entries()) {
        const previous = adapter.sent.length;
        adapter.enqueueManualInboundMessage({ address, ...query, messageId: `query-${index}`, timestamp: Date.now() });
        await until(() => adapter.sent.slice(previous).some((message) => message.text.includes(query.title)));
      }
      assert.equal(locks, held ? 1 : 0, '状态查询不进入执行队列');
      assert.deepEqual(store.getSession(binding.bridgeSessionId)?.runtime?.codex, codex);
    });
  }
}
