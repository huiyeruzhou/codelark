import '../../../setup/test-setup.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { BaseChannelAdapter } from '../../../../channels/contracts.js';
import { _testOnlyWaitForDeliveryQueuesForTests } from '../../../../channels/delivery/deliver.js';
import type { InboundMessage, OutboundMessage, SendResult } from '../../../../domain/index.js';
import { initBridgeContext } from '../../../../bridge/host/context.js';
import { JsonFileStore } from '../../../../storage/json-store.js';
import {
  buildVersionUpdateCard,
  createDailyVersionUpdateRuntime,
  MANUAL_VERSION_UPDATE_COMMAND,
  parseVersionUpdateCallbackData,
} from '../../../../bridge/update/runtime.js';
import type { DailyVersionChecker, VersionCheckState } from '../../../../bridge/update/version-check.js';

initBridgeContext({
  store: new JsonFileStore(new Map()),
  llm: {
    streamChat() {
      return new ReadableStream({ start(controller) { controller.close(); } });
    },
  },
  permissions: { resolvePendingPermission: () => false },
  lifecycle: {},
});

function fakeChecker(notice: { currentVersion: string; latestVersion: string } | null) {
  let state: VersionCheckState = {
    latestVersion: notice?.latestVersion || null,
    ignoredUntilVersion: null,
    lastCheckedDate: '2026-07-25',
  };
  const checker: DailyVersionChecker = {
    async checkOnFirstMessage() { return notice; },
    ignoreVersion(version) {
      state = { ...state, ignoredUntilVersion: version };
      return { ...state };
    },
    stateSnapshot() { return { ...state }; },
  };
  return { checker, state: () => state };
}

function fakeAdapter(provider = 'feishu') {
  const sent: OutboundMessage[] = [];
  const callbackAnswers: string[] = [];
  const adapter = {
    provider,
    channelType: provider === 'feishu' ? 'feishu-default' : 'telegram-default',
    isRunning: () => true,
    async send(message: OutboundMessage): Promise<SendResult> {
      sent.push(message);
      return { ok: true, messageId: `sent-${sent.length}` };
    },
    async answerCallback(_messageId: string, text: string): Promise<void> {
      callbackAnswers.push(text);
    },
  } as unknown as BaseChannelAdapter;
  return { adapter, sent, callbackAnswers };
}

function inbound(callbackData?: string): InboundMessage {
  return {
    messageId: 'message-1',
    callbackMessageId: callbackData ? 'card-message-1' : undefined,
    callbackData,
    address: {
      channelType: 'feishu-default',
      channelProvider: 'feishu',
      chatId: 'chat-1',
      userId: 'user-1',
    },
    text: callbackData ? '' : 'hello',
    timestamp: Date.now(),
  };
}

describe('daily version update user stories', () => {
  it('returns immediately while the registry is still pending', () => {
    let release: ((value: null) => void) | undefined;
    const checker = fakeChecker(null).checker;
    checker.checkOnFirstMessage = () => new Promise((resolve) => { release = resolve; });
    const { adapter } = fakeAdapter();
    const runtime = createDailyVersionUpdateRuntime({ checker, currentVersion: '1.2.3' });

    assert.equal(runtime.onFirstUserMessage(adapter, inbound()), undefined);
    assert.ok(release, 'the check was scheduled without being awaited by the caller');
    release?.(null);
  });

  it('sends a compact first-message card with update and ignore actions', async () => {
    const { checker } = fakeChecker({ currentVersion: '1.2.3', latestVersion: '1.3.0' });
    const { adapter, sent } = fakeAdapter();
    const runtime = createDailyVersionUpdateRuntime({ checker, currentVersion: '1.2.3' });

    runtime.onFirstUserMessage(adapter, inbound());
    await _testOnlyWaitForDeliveryQueuesForTests(adapter);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.replyToMessageId, 'message-1');
    assert.equal(sent[0]?.richCard?.title, 'CodeLark v1.3.0 可用');
    assert.equal(sent[0]?.richCard?.updateKey, 'version-update:chat-1:1.3.0');
    assert.equal(sent[0]?.richCard?.updateTtlMs, null);
    assert.equal(sent[0]?.richCard?.sections[1]?.code?.text, MANUAL_VERSION_UPDATE_COMMAND);
    assert.deepEqual(sent[0]?.richCard?.actions?.[0]?.map((button) => button.text), [
      '立即更新并重启',
      '忽略此版本',
    ]);
  });

  it('does not claim the daily check for a non-Feishu adapter', async () => {
    let checks = 0;
    const fixture = fakeChecker(null);
    fixture.checker.checkOnFirstMessage = async () => { checks += 1; return null; };
    const { adapter } = fakeAdapter('telegram');
    createDailyVersionUpdateRuntime({ checker: fixture.checker, currentVersion: '1.2.3' })
      .onFirstUserMessage(adapter, inbound());
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(checks, 0);
  });

  it('persists ignore-until-version and replaces the original card', async () => {
    const fixture = fakeChecker({ currentVersion: '1.2.3', latestVersion: '1.3.0' });
    const { adapter, sent, callbackAnswers } = fakeAdapter();
    const runtime = createDailyVersionUpdateRuntime({ checker: fixture.checker, currentVersion: '1.2.3' });

    assert.equal(runtime.handleCallback(adapter, inbound('clk-version-update:ignore:1.3.0')), true);
    await _testOnlyWaitForDeliveryQueuesForTests(adapter);
    assert.equal(fixture.state().ignoredUntilVersion, '1.3.0');
    assert.deepEqual(callbackAnswers, ['已忽略 v1.3.0']);
    assert.equal(sent[0]?.richCardUpdateMessageId, 'card-message-1');
    assert.equal(sent[0]?.richCard?.title, '已忽略 v1.3.0');
    assert.equal(sent[0]?.richCard?.updateKey, 'version-update:chat-1:1.3.0');
    assert.equal(sent[0]?.richCard?.updateTtlMs, null);
    assert.equal(sent[0]?.richCard?.actions, undefined);
  });

  it('returns from update callback before the background dispatcher settles', async () => {
    const fixture = fakeChecker({ currentVersion: '1.2.3', latestVersion: '1.3.0' });
    const { adapter, sent, callbackAnswers } = fakeAdapter();
    let release: ((value: { pid: number; logPath: string }) => void) | undefined;
    const dispatched = new Promise<{ pid: number; logPath: string }>((resolve) => { release = resolve; });
    const runtime = createDailyVersionUpdateRuntime({
      checker: fixture.checker,
      currentVersion: '1.2.3',
      dispatchUpdate: () => dispatched,
    });

    assert.equal(runtime.handleCallback(adapter, inbound('clk-version-update:update:1.3.0')), true);
    assert.deepEqual(callbackAnswers, ['已开始后台更新']);
    await _testOnlyWaitForDeliveryQueuesForTests(adapter);
    assert.equal(sent[0]?.richCard?.title, '正在准备更新到 v1.3.0');

    release?.({ pid: 42, logPath: '/tmp/version-update.log' });
    await _testOnlyWaitForDeliveryQueuesForTests(adapter);
    assert.equal(sent.at(-1)?.richCard?.title, '正在更新到 v1.3.0');
    assert.equal(sent.at(-1)?.richCard?.sections[1]?.fields?.[0]?.[1], '/tmp/version-update.log');
  });

  it('rejects stale, forged, duplicate, and shell-shaped callback data', async () => {
    const fixture = fakeChecker({ currentVersion: '1.2.3', latestVersion: '1.3.0' });
    const { adapter, callbackAnswers } = fakeAdapter();
    let dispatches = 0;
    const runtime = createDailyVersionUpdateRuntime({
      checker: fixture.checker,
      currentVersion: '1.2.3',
      dispatchUpdate: async () => {
        dispatches += 1;
        return { pid: 42, logPath: '/tmp/version-update.log' };
      },
    });

    assert.equal(runtime.handleCallback(adapter, inbound('clk-version-update:update:9.9.9')), true);
    assert.equal(runtime.handleCallback(adapter, inbound('clk-version-update:update:1.3.0;rm -rf /')), true);
    assert.equal(runtime.handleCallback(adapter, inbound('unrelated')), false);
    assert.equal(runtime.handleCallback(adapter, inbound('clk-version-update:update:1.3.0')), true);
    assert.equal(runtime.handleCallback(adapter, inbound('clk-version-update:update:1.3.0')), true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(dispatches, 1);
    assert.deepEqual(callbackAnswers, [
      '这个版本提示已过期',
      '这个更新按钮已失效',
      '已开始后台更新',
      '更新已经在进行中',
    ]);
    assert.equal(parseVersionUpdateCallbackData('clk-version-update:update:1.3.0;rm -rf /'), null);
    assert.equal(parseVersionUpdateCallbackData('unrelated'), undefined);
  });

  it('renders one manual command and no duplicate success label', () => {
    const card = buildVersionUpdateCard({ currentVersion: '1.2.3', latestVersion: '1.3.0' });
    assert.equal(
      MANUAL_VERSION_UPDATE_COMMAND,
      'npm install -g --yes codelark && codelark stop && codelark start',
    );
    assert.equal(card.sections.filter((section) => section.code).length, 1);
    assert.doesNotMatch(JSON.stringify(card), /success|成功/iu);
  });
});
