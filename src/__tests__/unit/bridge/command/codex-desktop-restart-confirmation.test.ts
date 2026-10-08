import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BridgeSession, ChannelChat } from '../../../../domain/index.js';
import { parseCommandCallbackData } from '../../../../bridge/command/callbacks.js';
import {
  cancelCodexDesktopRestart,
  consumeCodexDesktopRestart,
  requestCodexDesktopRestart,
} from '../../../../bridge/command/codex-desktop-restart-confirmation.js';

function fixture() {
  const binding = { id: 'binding', bridgeSessionId: 'session' } as ChannelChat;
  const session = { id: 'session', runtime: { codex: { threadId: 'thread' } } } as BridgeSession;
  return { binding, session };
}

test('restart card grants one scoped retry only after its button is clicked', () => {
  const { binding, session } = fixture();
  const requested = requestCodexDesktopRestart({
    binding, session, threadId: 'thread', retryText: 'original input', retryContextText: 'quoted context',
  });
  assert.match(requested.response, /中断 Desktop 中正在运行的其他任务/);
  const parsed = parseCommandCallbackData(requested.richCard.actions![0]![0]!.callbackData)!;
  assert(parsed && parsed.scopeSessionId === session.id);
  const id = parsed.commandText.match(/^\/codex-desktop-restart --confirm=([0-9a-f-]+)$/)![1]!;
  const pending = consumeCodexDesktopRestart(id, binding, session);
  assert(pending);
  assert.equal(pending.bindingId, binding.id);
  assert.equal(pending.sessionId, session.id);
  assert.equal(pending.threadId, 'thread');
  assert.equal(pending.retryText, 'original input');
  assert.equal(pending.retryContextText, 'quoted context');
  assert.equal(typeof pending.createdAt, 'number');
  assert.equal(consumeCodexDesktopRestart(id, binding, session), undefined);
});

test('restart confirmation is invalid after the binding or thread changes', () => {
  const { binding, session } = fixture();
  const requested = requestCodexDesktopRestart({ binding, session, threadId: 'thread' });
  const parsed = parseCommandCallbackData(requested.richCard.actions![0]![0]!.callbackData)!;
  const id = parsed && parsed.commandText.split('=').at(-1)!;
  const changed = { ...session, runtime: { codex: { threadId: 'other' } } } as BridgeSession;
  assert.equal(consumeCodexDesktopRestart(id, binding, changed), undefined);
});

test('restart confirmation can be cancelled without side effects', () => {
  const { binding, session } = fixture();
  const requested = requestCodexDesktopRestart({ binding, session, threadId: 'thread' });
  const parsed = parseCommandCallbackData(requested.richCard.actions![0]![1]!.callbackData)!;
  const id = parsed && parsed.commandText.split('=').at(-1)!;
  assert.equal(cancelCodexDesktopRestart(id), true);
  assert.equal(consumeCodexDesktopRestart(id, binding, session), undefined);
});
