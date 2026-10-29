import '../../../setup/test-setup.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, it } from 'node:test';
import { CODELARK_HOME } from '../../../../configuration/paths.js';
import { createConfigService } from '../../../../configuration/service.js';
import { handleForkSessionCommand } from '../../../../bridge/session/command-use-cases/fork-session.js';
import { readCardForkCheckpoint, saveCardForkCheckpoint } from '../../../../storage/card-fork-checkpoints.js';
import { initBridgeTestContext, resetBridgeTestState, RecordingAdapter, inboundMessage } from '../../../helpers/bridge/test-bridge-utils.js';
import * as router from '../../../../bridge/session/channel-router.js';
import { scopedConfigForRuntime } from '../../../../bridge/session/support.js';

beforeEach(() => resetBridgeTestState());

function omitPersistedActiveRuntime(sessionId: string): void {
  const file = path.join(CODELARK_HOME, 'data', 'sessions.json');
  const sessions = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete sessions[sessionId].runtime.activeRuntime;
  fs.writeFileSync(file, JSON.stringify(sessions));
}

class ForkAdapter extends RecordingAdapter {
  historyIds: string[] = [];
  forwarded: string[] = [];
  async listChatMessageIdsThrough(_chatId: string, messageId: string, precedingLimit: number): Promise<string[]> {
    assert.ok(this.historyIds.includes(messageId));
    assert.equal(precedingLimit, 10);
    return this.historyIds.slice(0, this.historyIds.indexOf(messageId) + 1).slice(-(precedingLimit + 1));
  }
  async forwardChatMessage(messageId: string, _chatId: string): Promise<string> {
    this.forwarded.push(messageId);
    return `forwarded-${messageId}`;
  }
}

function setup() {
  const store = initBridgeTestContext();
  const address = { channelType: 'feishu', chatId: 'source-chat', userId: 'ou_test', chatKind: 'group' as const };
  const binding = router.createBinding(address, CODELARK_HOME, 'source');
  store.updateSessionCodexThreadId(binding.bridgeSessionId, 'source-thread');
  store.updateSession(binding.bridgeSessionId, { runtime_status: 'running' });
  createConfigService({ migrate: false }).set({ kind: 'session', sessionId: binding.bridgeSessionId }, {
    session: { requireMention: false }, runtime: { agent: 'codex', codex: { model: 'source-model', provider: 'tmux' } },
  });
  const checkpoint = { channelType: 'feishu', chatId: address.chatId, messageId: `card-${binding.id}`,
    sessionId: binding.bridgeSessionId, threadId: 'source-thread', signature: 'a'.repeat(40),
    status: 'completed' as const, sealedAt: 10 };
  saveCardForkCheckpoint(checkpoint);
  const adapter = new ForkAdapter();
  adapter.historyIds = ['user-a', checkpoint.messageId, 'user-after-boundary'];
  const msg = { ...inboundMessage(address, '/fork branch'), replyToMessageId: checkpoint.messageId };
  const remapSignatures = (_source: string, _fork: string, signatures: string[]) =>
    new Map(signatures.map(s => [s, s.replaceAll('a', 'c').replaceAll('b', 'd')]));
  return { store, adapter, msg, args: 'branch', commandBinding: binding, checkpoint, remapSignatures };
}

it('fork creates an independent group and session, inherits configuration, and leaves a running source untouched', async () => {
  const options = setup();
  const before = options.store.getSession(options.commandBinding.bridgeSessionId)!;
  let called = 0;
  const result = await handleForkSessionCommand({ ...options, forkThread: async (input) => {
    called++;
    assert.deepEqual(input, { threadId: 'source-thread', signature: options.checkpoint.signature, workingDirectory: CODELARK_HOME });
    return { threadId: 'child-thread' };
  } });
  assert.match(result.response, /已创建分支/);
  assert.equal(called, 1);
  assert.equal(options.adapter.createdGroups.length, 1);
  const group = options.adapter.createdGroups[0]!;
  const binding = options.store.getChannelChat('feishu', group.chatId)!;
  assert.notEqual(binding.bridgeSessionId, before.id);
  const child = options.store.getSession(binding.bridgeSessionId)!;
  assert.equal(child.runtime?.codex?.threadId, 'child-thread');
  assert.equal(child.runtime?.general?.tmuxSessionName, undefined);
  assert.deepEqual(options.adapter.forwarded, ['user-a', options.checkpoint.messageId]);
  assert.deepEqual(readCardForkCheckpoint('feishu', group.chatId, `forwarded-${options.checkpoint.messageId}`),
    { ...options.checkpoint, chatId: group.chatId, messageId: `forwarded-${options.checkpoint.messageId}`,
      sessionId: child.id, threadId: 'child-thread', signature: 'c'.repeat(40) });
  assert.ok(child.mirror_last_event_at);
  assert.deepEqual(options.store.getSession(before.id), before);
  assert.equal(options.store.getChannelChat('feishu', options.msg.address.chatId)?.bridgeSessionId, before.id);
  assert.deepEqual(scopedConfigForRuntime(binding, child).config.runtime,
    scopedConfigForRuntime(options.commandBinding, before).config.runtime);
  assert.equal(scopedConfigForRuntime(binding, child).config.session.requireMention, false);
  assert.deepEqual(readCardForkCheckpoint('feishu', options.msg.address.chatId, options.checkpoint.messageId), options.checkpoint);
  assert.equal(readCardForkCheckpoint('other-bot', options.msg.address.chatId, options.checkpoint.messageId), null);
  assert.equal(readCardForkCheckpoint('feishu', 'other-chat', options.checkpoint.messageId), null);
});

it('standalone fork selects the latest completed card in the current thread, ignoring newer unfinished and other-session cards', async () => {
  const options = setup();
  omitPersistedActiveRuntime(options.commandBinding.bridgeSessionId);
  assert.equal(options.store.getSession(options.commandBinding.bridgeSessionId)?.runtime?.activeRuntime, undefined);
  const latest = { ...options.checkpoint, messageId: 'latest-done', signature: 'b'.repeat(40), sealedAt: 20 };
  saveCardForkCheckpoint(latest);
  for (const status of ['continued', 'interrupted', 'error'] as const) {
    saveCardForkCheckpoint({ ...latest, messageId: status, sealedAt: 30, status });
  }
  saveCardForkCheckpoint({ ...latest, messageId: 'old-thread', threadId: 'old-thread', sealedAt: 40 });
  saveCardForkCheckpoint({ ...latest, messageId: 'other-session', sessionId: 'other-session', sealedAt: 50 });
  options.adapter.historyIds.push(latest.messageId, 'active-card');
  const result = await handleForkSessionCommand({ ...options,
    msg: { ...options.msg, replyToMessageId: undefined }, forkThread: async input => {
      assert.equal(input.signature, latest.signature);
      return { threadId: 'child-thread' };
    } });
  assert.match(result.response, /已创建分支/);
  assert.equal(options.adapter.forwarded.at(-1), latest.messageId);
  assert.ok(!options.adapter.forwarded.includes('active-card'));
});

for (const reply of [true, false]) it(`limits Feishu copies but preserves the native checkpoint with 810 messages (${reply ? 'reply' : 'standalone'})`, async () => {
  const options = setup();
  const older = Array.from({ length: 809 }, (_, i) => `message-${i}`);
  options.adapter.historyIds = [...older, options.checkpoint.messageId, 'later'];
  let nativeForks = 0;
  const result = await handleForkSessionCommand({ ...options,
    msg: { ...options.msg, replyToMessageId: reply ? options.checkpoint.messageId : undefined },
    forkThread: async input => {
      nativeForks++;
      assert.equal(input.signature, options.checkpoint.signature);
      assert.equal(input.threadId, 'source-thread');
      return { threadId: 'child-thread' };
    },
  });
  assert.equal(nativeForks, 1);
  assert.deepEqual(options.adapter.forwarded, [...older.slice(-10), options.checkpoint.messageId]);
  assert.match(result.response, /完整对话历史/);
  assert.match(result.response, /本次共 11 条/);
  const group = options.adapter.createdGroups[0]!;
  assert.ok(readCardForkCheckpoint('feishu', group.chatId, `forwarded-${options.checkpoint.messageId}`));
  assert.equal(readCardForkCheckpoint('feishu', group.chatId, 'forwarded-message-0'), null);
});

it('rejects an effectively non-Codex session even when it has an old Codex checkpoint', async () => {
  const options = setup();
  omitPersistedActiveRuntime(options.commandBinding.bridgeSessionId);
  createConfigService({ migrate: false }).set({ kind: 'session', sessionId: options.commandBinding.bridgeSessionId }, {
    runtime: { agent: 'claude' },
  });
  const result = await handleForkSessionCommand({ ...options, forkThread: async () => assert.fail('must not fork') });
  assert.match(result.response, /不是 Codex/);
  assert.equal(options.adapter.createdGroups.length, 0);
});

it('rejects missing completed cards and unknown explicit boundaries before creating anything', async () => {
  const options = setup();
  saveCardForkCheckpoint({ ...options.checkpoint, status: 'continued' });
  const forkThread = async () => { assert.fail('must not fork'); };
  const missing = await handleForkSessionCommand({ ...options, forkThread, msg: { ...options.msg, replyToMessageId: undefined } });
  assert.match(missing.response, /尚无可用的已完成卡片/);
  const unknown = await handleForkSessionCommand({ ...options, forkThread, msg: { ...options.msg, replyToMessageId: 'unknown' } });
  assert.match(unknown.response, /没有可用的历史边界/);
  assert.equal(options.adapter.createdGroups.length, 0);
});

it('history read failures happen before fork and partial forwarding failures retain the branch with an explicit count', async () => {
  const options = setup();
  const list = options.adapter.listChatMessageIdsThrough;
  options.adapter.listChatMessageIdsThrough = async () => { throw new Error('history permission denied'); };
  const denied = await handleForkSessionCommand({ ...options, forkThread: async () => assert.fail('must not fork') });
  assert.match(denied.response, /读取待转发历史失败.*history permission denied/);
  assert.equal(options.adapter.createdGroups.length, 0);
  options.adapter.listChatMessageIdsThrough = list;
  options.adapter.forwardChatMessage = async (id) => {
    if (id === options.checkpoint.messageId) throw new Error('forward denied');
    return `forwarded-${id}`;
  };
  const failed = await handleForkSessionCommand({ ...options, forkThread: async () => ({ threadId: 'child-thread' }) });
  assert.match(failed.response, /分支已创建.*打开分支群/);
  assert.match(failed.response, /转发未完成（1\/2 条）.*forward denied/);
  assert.equal(options.adapter.createdGroups.length, 1);
});

it('reports native fork and group failures without claiming completion or changing the source binding', async () => {
  const options = setup();
  const failed = await handleForkSessionCommand({ ...options, forkThread: async () => { throw new Error('missing history'); } });
  assert.match(failed.response, /分叉历史失败.*missing history/);
  assert.equal(options.adapter.createdGroups.length, 0);
  options.adapter.createGroupChat = async () => { throw new Error('permission denied'); };
  const groupFailed = await handleForkSessionCommand({ ...options, forkThread: async () => ({ threadId: 'recoverable-thread' }) });
  assert.match(groupFailed.response, /recoverable-thread.*建群失败.*permission denied/);
  assert.equal(options.store.getChannelChat('feishu', options.msg.address.chatId)?.bridgeSessionId, options.commandBinding.bridgeSessionId);
});

it('prefers the site-aware chat link exposed by the adapter over the feishu default', async () => {
  const options = setup();
  options.adapter.buildChatOpenLink = (chatId) => `https://applink.larksuite.com/client/chat/open?openChatId=${chatId}`;
  const result = await handleForkSessionCommand({ ...options, forkThread: async () => ({ threadId: 'child-thread' }) });
  const group = options.adapter.createdGroups[0]!;
  assert.ok(result.response.includes(`applink.larksuite.com/client/chat/open?openChatId=${group.chatId}`));
  assert.ok(!result.response.includes('applink.feishu.cn'));
});

it('forks from an app-server protocol checkpoint signature', async () => {
  const options = setup();
  const appSignature = `app:source-thread:turn-1:item-42:true:${'a'.repeat(20)}`;
  saveCardForkCheckpoint({ ...options.checkpoint, messageId: 'app-card', signature: appSignature, sealedAt: 30 });
  options.adapter.historyIds = [options.checkpoint.messageId, 'app-card', 'after-app-card'];
  const result = await handleForkSessionCommand({
    ...options,
    msg: { ...options.msg, replyToMessageId: 'app-card' },
    forkThread: async (input) => {
      assert.equal(input.threadId, 'source-thread');
      assert.equal(input.signature, appSignature);
      return { threadId: 'app-child-thread' };
    },
  });
  assert.match(result.response, /已创建分支/);
  const group = options.adapter.createdGroups[0]!;
  assert.equal(options.store.getSession(options.store.getChannelChat('feishu', group.chatId)!.bridgeSessionId)
    ?.runtime?.codex?.threadId, 'app-child-thread');
});
