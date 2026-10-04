import '../../../setup/test-setup.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { initBridgeTestContext, RecordingAdapter } from '../../../helpers/bridge/test-bridge-utils.js';
import * as router from '../../../../bridge/session/channel-router.js';
import { CommandThreadDisplay } from '../../../../bridge/command/thread-display.js';
import { handleClearSessionCommand } from '../../../../bridge/session/command-use-cases/clear-session.js';
import { handleProviderCommand } from '../../../../bridge/command/provider-settings.js';
import { scheduleCodexAppServerView } from '../../../../bridge/command/tmux.js';
import { _testOnlyTmuxCore } from '../../../../bridge/tmux/core.js';
import { prepareCodexAppServerSession, getCodexAppServerSession, closeCodexAppServerSessions } from '../../../../runtime/codex/app-server-registry.js';

for (const completion of ['missing-terminal', 'event', 'rebind', 'stop-failure', 'view'] as const) it(`active shared thread permits clear or terminal view: ${completion}`, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codelark-clear-protocol-'));
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  t.after(async () => {
    closeCodexAppServerSessions();
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  const addressInfo = wss.address(); assert(addressInfo && typeof addressInfo === 'object');
  const endpoint = `ws://127.0.0.1:${addressInfo.port}`;
  const turn = { id: 'turn-1', status: 'inProgress', items: [] };
  const thread = { id: 'thread-clear', turns: [] as typeof turn[] };
  const calls: string[] = [];
  let onInterrupt = () => {};
  wss.on('connection', (socket) => socket.on('message', (data) => {
    const message = JSON.parse(String(data)); calls.push(message.method);
    const reply = (result: unknown) => socket.send(JSON.stringify({ id: message.id, result }));
    if (message.method === 'initialize') reply({ codexHome: process.env.CODEX_HOME });
    else if (message.method === 'thread/loaded/list') reply({ data: [] });
    else if (message.method === 'thread/read' && completion === 'stop-failure') socket.send(JSON.stringify({ id: message.id, error: { code: -32603, message: 'state unavailable' } }));
    else if (['thread/start', 'thread/read', 'thread/resume'].includes(message.method)) reply({ thread });
    else if (message.method === 'turn/start') {
      thread.turns.push(turn);
      socket.send(JSON.stringify({ method: 'turn/started', params: { threadId: thread.id, turn } }));
      reply({ turn });
    }
    else if (message.method === 'turn/interrupt') { onInterrupt(); reply({}); } // no completion is needed to create a new context
    else if (message.method === 'thread/unsubscribe') reply({ status: 'unsubscribed' });
  }));
  const store = initBridgeTestContext();
  const address = { channelType: 'feishu', chatId: 'clear-protocol' };
  const binding = router.createBinding(address, root);
  const handle = await prepareCodexAppServerSession({ sessionId: binding.bridgeSessionId, endpoint }); assert(handle);
  store.updateSession(binding.bridgeSessionId, { runtime: { codex: { threadId: handle.threadId, appServerEndpoint: endpoint } } });
  await handle.lifecycle.submit(handle.threadId, [{ type: 'text', text: 'work' }]);
  let queueCancellations = 0;
  let localDeliveryStops = 0;
  const options = {
    adapter: new RecordingAdapter(), msg: { address, text: '/clear --yes', messageId: 'clear', timestamp: Date.now() },
    args: '--yes', currentBinding: binding, store, markdown: true, threadDisplay: new CommandThreadDisplay(store),
    deps: { getActiveTask: () => undefined, forceStopSession: async () => { localDeliveryStops++; return true; },
      recordInteractiveHealthEnd: () => assert.fail('clear must not synthesize terminal health'),
      cancelQueuedSessionMessages: () => { queueCancellations++; } },
  };
  if (completion === 'view') {
    // Legacy persisted Codex sessions may omit activeRuntime. Attaching a view must still bypass restart confirmation.
    store.updateSession(binding.bridgeSessionId, { health_status: 'running_active' });
    _testOnlyTmuxCore.replace({ hasSession: async () => ({ exists: true, command: 'owned fixture' }) } as never);
    t.after(() => _testOnlyTmuxCore.reset());
    const result = await handleProviderCommand({ ...options, args: 'tmux' });
    assert.equal(result.richCard, undefined);
    assert.match(result.response, /共享 Codex 线程已就绪/);
    await scheduleCodexAppServerView({ store, binding, session: store.getSession(binding.bridgeSessionId)!, handle });
    assert.equal(localDeliveryStops, 0);
    assert.equal(calls.includes('turn/interrupt'), false);
    assert.equal(handle.lifecycle.snapshot(handle.threadId).activity, 'active');
    return;
  }
  let reboundSessionId: string | undefined;
  if (completion === 'rebind') onInterrupt = () => { reboundSessionId = router.createBinding(address, root).bridgeSessionId; };
  if (completion === 'event') onInterrupt = () => {
    turn.status = 'interrupted';
    for (const socket of wss.clients) socket.send(JSON.stringify({ method: 'turn/completed', params: { threadId: thread.id, turn } }));
  };
  const prompt = await handleClearSessionCommand({ ...options, args: '' });
  assert.match(prompt.richCard!.actions![0]![0]!.text, /终止并新建/);
  assert.equal(store.getChannelChat(address.channelType, address.chatId)?.bridgeSessionId, binding.bridgeSessionId);
  assert.equal(calls.includes('turn/interrupt'), false);
  const pending = await handleClearSessionCommand(options);
  if (completion === 'rebind') {
    assert.match(pending.response, /未覆盖新的绑定/);
    assert.equal(store.getChannelChat(address.channelType, address.chatId)?.bridgeSessionId, reboundSessionId);
    assert.equal(calls.includes('thread/unsubscribe'), false);
    return;
  }
  assert.match(pending.response, /已清空当前聊天上下文/);
  assert.equal(queueCancellations, 1);
  assert.equal(localDeliveryStops, 1);
  assert.equal(calls.filter((m) => m === 'turn/interrupt').length, completion === 'stop-failure' ? 0 : 1);
  assert.equal(calls.includes('thread/unsubscribe'), true);
  assert.equal(getCodexAppServerSession(binding.bridgeSessionId), undefined);
  const replacement = store.getChannelChat(address.channelType, address.chatId);
  assert.notEqual(replacement?.bridgeSessionId, binding.bridgeSessionId);
  assert.equal(store.getSession(replacement!.bridgeSessionId)?.runtime?.codex?.appServerEndpoint, endpoint);
  assert.equal(store.getSession(replacement!.bridgeSessionId)?.runtime?.codex?.threadId, undefined);
  if (completion === 'missing-terminal') assert.equal(turn.status, 'inProgress', 'new context must not fake a native terminal');
  if (completion === 'stop-failure') assert.match(pending.response, /旧任务未能停止/);
});
