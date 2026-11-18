import '../../../setup/test-setup.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { initBridgeTestContext, RecordingAdapter, resetBridgeTestState, writeCodexSessionJsonlFixture } from '../../../helpers/bridge/test-bridge-utils.js';
import { _testOnly as manager } from '../../../../bridge/host/manager.js';
import * as router from '../../../../bridge/session/channel-router.js';
import { buildCommandCallbackData } from '../../../../bridge/command/callbacks.js';
import { getCursorChatsRoot, getCursorTranscriptCandidates } from '../../../../runtime/cursor/session-index.js';
import { userInputTurnCountCache } from '../../../../bridge/session/command-use-cases/user-input-turn-cache.js';
import { listCommandLocalRuntimeSessions } from '../../../../bridge/session/command-use-cases/source.js';
import { handleThreadSwitchCommand } from '../../../../bridge/session/command-use-cases/thread-switch.js';
import { CommandThreadDisplay } from '../../../../bridge/command/thread-display.js';

it('takes over Cursor from a Codex card without reading unrelated histories, retaining stop confirmation', async (t) => {
  resetBridgeTestState({ cleanRuntimeHomes: true });
  const store = initBridgeTestContext();
  const adapter = new RecordingAdapter();
  const address = { channelType: 'feishu', chatId: 'large-history-takeover', chatKind: 'group' } as const;
  const original = router.createBinding(address, process.cwd());
  for (let n = 0; n < 128; n++) writeCodexSessionJsonlFixture({
    threadId: `01234567-1234-1234-1234-${String(n).padStart(12, '0')}`, workDir: process.cwd(),
  });
  const nativeId = 'abcdefab-1234-1234-1234-123456789abc';
  const dir = path.join(getCursorChatsRoot(process.cwd()), nativeId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ cwd: process.cwd(), title: 'Cursor takeover' }));
  const transcript = getCursorTranscriptCandidates(nativeId, process.cwd())[0]!;
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  const user = (text: string) => JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text }] } }) + '\n';
  fs.writeFileSync(transcript, user('First real question') + JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(2 * 1024 * 1024) }] } }) + '\n');
  t.after(async () => {
    await userInputTurnCountCache.waitForIdle();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(path.dirname(transcript), { recursive: true, force: true });
  });
  const opened: string[] = [];
  const open = fs.openSync;
  t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
    opened.push(String(args[0]));
    return open(...args);
  });
  const send = async (callbackData: string) => manager.handleMessage(adapter, {
    address, messageId: 'large-history-card', callbackMessageId: 'large-history-card', text: '', callbackData, timestamp: Date.now(),
  });
  assert.equal(listCommandLocalRuntimeSessions(20, 'cursor')?.find(s => s.threadId === nativeId)?.userInputTurns, undefined);
  await send(buildCommandCallbackData('/t cursor'));
  assert.equal(store.getChannelChat(address.channelType, address.chatId)?.bridgeSessionId, original.bridgeSessionId, 'list filtering must not attach');
  await userInputTurnCountCache.waitForIdle();
  assert.equal(listCommandLocalRuntimeSessions(20, 'cursor')?.find(s => s.threadId === nativeId)?.userInputTurns, 1);
  assert.equal(opened.includes(transcript), false, 'large Cursor histories must not be read synchronously just to count user turns');
  fs.appendFileSync(transcript, user('Second question'));
  listCommandLocalRuntimeSessions(20, 'cursor');
  await userInputTurnCountCache.waitForIdle();
  assert.equal(listCommandLocalRuntimeSessions(20, 'cursor')?.find(s => s.threadId === nativeId)?.userInputTurns, 2);

  // The actual callback path must keep the target's native identity and update
  // the whole Cursor list, even though the active binding still belongs to Codex.
  await send(`clk-thread-select:${nativeId}`);
  await send('clk-thread-action:global:switch');
  const binding = store.getChannelChat(address.channelType, address.chatId)!;
  const session = store.getSession(binding.bridgeSessionId)!;
  assert.equal(session.runtime?.activeRuntime, 'cursor');
  assert.equal(session.runtime?.cursor?.sessionId, nativeId);
  assert.equal(binding.runtimeBridgeSessionIds?.codex, original.bridgeSessionId);
  assert.ok(adapter.sent.some(message => /已切换到本地 Cursor Agent/.test(message.text)));
  assert.equal(opened.some(p => p.startsWith(path.join(process.env.CODEX_HOME!, 'sessions'))), false, 'exact cross-runtime attach must not open Codex rollouts');

  // Resolve the same ID through the command use case while the old turn is busy.
  router.attachToSession(address, original.bridgeSessionId);
  const active = { abortController: new AbortController() };
  const deps = { getActiveTask: (id: string) => id === original.bridgeSessionId ? active : undefined };
  const result = await handleThreadSwitchCommand({
    msg: { address, text: `/t ${nativeId}`, messageId: 'busy-attach', timestamp: Date.now() },
    args: nativeId, currentBinding: store.getChannelChat(address.channelType, address.chatId),
    commandBinding: store.getChannelChat(address.channelType, address.chatId), store, deps,
    threadDisplay: new CommandThreadDisplay(store), markdown: true,
  });
  assert.match(result.response, /确认停止并切换会话/);
  assert.equal(store.getChannelChat(address.channelType, address.chatId)?.bridgeSessionId, original.bridgeSessionId);
  assert.equal(active.abortController.signal.aborted, false);
});
