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
import { prepareCodexAppServerSession, getCodexAppServerSession, closeCodexAppServerSessions } from '../../../../runtime/codex/app-server-registry.js';

it('clear retains the original thread after an early interrupt ack and detaches only after refresh confirms idle', async (t) => {
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
  wss.on('connection', (socket) => socket.on('message', (data) => {
    const message = JSON.parse(String(data)); calls.push(message.method);
    const reply = (result: unknown) => socket.send(JSON.stringify({ id: message.id, result }));
    if (message.method === 'initialize') reply({ codexHome: process.env.CODEX_HOME });
    else if (message.method === 'thread/loaded/list') reply({ data: [] });
    else if (['thread/start', 'thread/read', 'thread/resume'].includes(message.method)) reply({ thread });
    else if (message.method === 'turn/start') {
      thread.turns.push(turn);
      socket.send(JSON.stringify({ method: 'turn/started', params: { threadId: thread.id, turn } }));
      reply({ turn });
    }
    else if (message.method === 'turn/interrupt') reply({}); // acknowledgement deliberately precedes completion
    else if (message.method === 'thread/unsubscribe') reply({ status: 'unsubscribed' });
  }));
  const store = initBridgeTestContext();
  const address = { channelType: 'feishu', chatId: 'clear-protocol' };
  const binding = router.createBinding(address, root);
  const handle = await prepareCodexAppServerSession({ sessionId: binding.bridgeSessionId, endpoint }); assert(handle);
  store.updateSession(binding.bridgeSessionId, { runtime: { codex: { threadId: handle.threadId, appServerEndpoint: endpoint } } });
  await handle.lifecycle.submit(handle.threadId, [{ type: 'text', text: 'work' }]);
  let queueCancellations = 0;
  const options = {
    adapter: new RecordingAdapter(), msg: { address, text: '/clear --yes', messageId: 'clear', timestamp: Date.now() },
    args: '--yes', currentBinding: binding, store, markdown: true, threadDisplay: new CommandThreadDisplay(store),
    deps: { getActiveTask: () => undefined, forceStopSession: async () => assert.fail('clear must not force a protocol terminal'),
      recordInteractiveHealthEnd: () => assert.fail('clear must not synthesize terminal health'),
      cancelQueuedSessionMessages: () => { queueCancellations++; } },
  };
  const pending = await handleClearSessionCommand(options);
  assert.match(pending.response, /尚未确认原轮次结束/);
  assert.equal(queueCancellations, 1);
  assert.equal(store.getChannelChat(address.channelType, address.chatId)?.bridgeSessionId, binding.bridgeSessionId);
  assert.equal(getCodexAppServerSession(binding.bridgeSessionId), handle);
  assert.equal(calls.includes('thread/unsubscribe'), false);
  turn.status = 'completed';
  await handleClearSessionCommand(options);
  assert.equal(calls.includes('thread/unsubscribe'), true);
  assert.equal(getCodexAppServerSession(binding.bridgeSessionId), undefined);
  const replacement = store.getChannelChat(address.channelType, address.chatId);
  assert.notEqual(replacement?.bridgeSessionId, binding.bridgeSessionId);
  assert.equal(store.getSession(replacement!.bridgeSessionId)?.runtime?.codex?.appServerEndpoint, undefined);
});
