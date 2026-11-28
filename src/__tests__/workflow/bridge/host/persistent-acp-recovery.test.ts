import '../../../setup/test-setup.js';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { initBridgeTestContext, RecordingAdapter } from '../../../helpers/bridge/test-bridge-utils.js';
import { _testOnly as manager, registerAdapter } from '../../../../bridge/host/manager.js';
import { createConfigService } from '../../../../configuration/service.js';
import { startAcpHostServer } from '../../../../runtime/acp/host-server.js';
import { acpHostEndpoint } from '../../../../runtime/acp/host-protocol.js';
import { detachSharedAcpHostClient, tryConnectExistingAcpHost } from '../../../../runtime/acp/host-client.js';
import { sseEvent } from '../../../../runtime/sse.js';
import type { StreamChatParams } from '../../../../runtime/contracts.js';

async function until(check: () => boolean) {
  for (let i = 0; i < 400; i++) { if (check()) return; await delay(5); }
  assert.ok(check(), 'recovery did not reach its next state');
}

it('recovers a failed attachment once, preserves the native input, and leaves pending terminal delivery alone', { timeout: 15000 }, async t => {
  const disabled = process.env.CODELARK_ACP_HOST_DISABLE;
  process.env.CODELARK_ACP_HOST_DISABLE = '0';
  t.after(() => {
    if (disabled === undefined) delete process.env.CODELARK_ACP_HOST_DISABLE;
    else process.env.CODELARK_ACP_HOST_DISABLE = disabled;
  });
  const calls: StreamChatParams[] = [];
  let attached!: ReadableStreamDefaultController<string>;
  const store = initBridgeTestContext({ llm: { streamChat(params) {
    calls.push(params);
    return new ReadableStream({ start(controller) {
      if (calls.length === 1) {
        controller.enqueue(sseEvent('error', 'fixture transport unavailable'));
        controller.enqueue(sseEvent('result', { outcome: 'failed' }));
        controller.close();
      } else {
        attached = controller;
        controller.enqueue(sseEvent('status', { session_id: 'native' }));
      }
    } });
  } } });
  manager.resetStateForTests();
  const session = store.createSession('ACP recovery', 'model', undefined, os.tmpdir());
  store.updateSession(session.id, { runtime: { activeRuntime: 'cursor', cursor: { provider: 'acp', sessionProvider: 'acp' } } });
  createConfigService({ migrate: false }).set({ kind: 'session', sessionId: session.id }, { runtime: { cursor: { provider: 'acp' } } });
  const address = { channelType: 'feishu', chatId: 'oc_acp_recovery' };
  store.upsertChannelChat({ ...address, bridgeSessionId: session.id });
  registerAdapter(new RecordingAdapter());
  const state = (globalThis as any).__bridge_manager__;
  state.running = true;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-reattach-story-'));
  let finishNative!: () => void;
  const nativeWait = new Promise<void>(resolve => { finishNative = resolve; });
  let nativePrompts = 0;
  const server = await startAcpHostServer({ socketPath: acpHostEndpoint(home), clientFactory: async () => ({
    connected: true, async request<T>(method: string): Promise<T> {
      if (method === 'session/new') return { sessionId: 'native' } as T;
      if (method === 'session/prompt') { nativePrompts++; await nativeWait; return { stopReason: 'end_turn' } as T; }
      return {} as T;
    },
    notify() {}, respond() {}, reject() {}, onMessage() { return () => {}; }, onDisconnect() { return () => {}; }, close() {},
  }) });
  const host = await tryConnectExistingAcpHost(home); assert.ok(host);
  t.after(async () => {
    state.running = false;
    try { attached?.close(); } catch { /* already completed */ }
    finishNative();
    detachSharedAcpHostClient();
    await server.close(true);
    manager.resetStateForTests();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const sessionKey = `cursor:${session.id}`;
  await host.ensureSession({ sessionKey, runtime: 'cursor', bridgeSessionId: session.id, executable: 'fixture', args: [], cwd: home,
    label: 'Test', fingerprint: 'test', initializeParams: { protocolVersion: 1 } });
  const { turn } = await host.startTurn({ sessionKey, prompt: [{ type: 'text', text: 'original' }],
    meta: { runtime: 'cursor', bridgeSessionId: session.id, channelType: address.channelType, chatId: address.chatId, userText: 'original' } });
  await manager.schedulePersistentAcpTurnReattachments();
  await until(() => calls.length === 1 && state.activeTasks.size === 0);
  assert.equal((await host.getTurn(turn.turnId))?.acked, false);
  await manager.schedulePersistentAcpTurnReattachments(true);
  await until(() => calls.length === 2 && state.activeTasks.size === 1);
  await Promise.all([manager.schedulePersistentAcpTurnReattachments(true), manager.schedulePersistentAcpTurnReattachments(true)]);
  assert.equal(calls.length, 2, 'concurrent scans must not duplicate the active attachment');
  assert(calls.every(call => call.reattachAcpTurnId === turn.turnId));
  assert.equal(nativePrompts, 1, 'attachment never repeats the native prompt');
  finishNative();
  attached.enqueue(sseEvent('result', { outcome: 'completed' })); attached.close();
  await until(() => state.activeTasks.size === 0);
  // Simulate a terminal card still waiting for its delivery acknowledgement.
  const terminal = { ...(await host.getTurn(turn.turnId))!, status: 'completed' as const, acked: false };
  t.mock.method(host, 'listUnackedTurns', async () => [terminal]);
  await manager.schedulePersistentAcpTurnReattachments(true);
  assert.equal(calls.length, 2);
});
