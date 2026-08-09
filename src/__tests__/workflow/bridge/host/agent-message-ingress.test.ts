import '../../../setup/test-setup.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { CODELARK_HOME } from '../../../../configuration/paths.js';
import { BaseChannelAdapter, registerAdapterFactory } from '../../../../channels/contracts.js';
import { buildRichCardContent } from '../../../../channels/feishu/markdown.js';
import type { InboundMessage, OutboundMessage, PermissionGateway, SendResult } from '../../../../domain/index.js';
import type { LifecycleHooks, LLMProvider, StreamChatParams } from '../../../../runtime/contracts.js';
import { JsonFileStore } from '../../../../storage/json-store.js';
import { initBridgeContext } from '../../../../bridge/host/context.js';
import * as router from '../../../../bridge/host/channel-router.js';
import {
  _testOnly,
  listActiveBridgeSessions,
  receiveManualInput,
  sendAgentMessageFromBinding,
  sendPlatformMessage,
  stop,
} from '../../../../bridge/host/manager.js';
import { startBridgeControlService, type BridgeControlService } from '../../../../bridge/control/service-discovery.js';
import { _testOnlyWaitForDeliveryQueuesForTests } from '../../../../channels/delivery/deliver.js';

const CONFIG_PATH = path.join(CODELARK_HOME, 'config.toml');

const noopLlm: LLMProvider = {
  streamChat(_params: StreamChatParams): ReadableStream<string> {
    return new ReadableStream({ start(controller) { controller.close(); } });
  },
};
const noopPermissions: PermissionGateway = { resolvePendingPermission: () => false };
const noopLifecycle: LifecycleHooks = {};

class ManualIngressAdapter extends BaseChannelAdapter {
  readonly channelType: string;
  readonly provider = 'feishu';
  readonly sentMessages: OutboundMessage[] = [];
  private running = false;

  constructor(instance?: { id?: string }) {
    super();
    this.channelType = instance?.id || 'manual-ingress-main';
  }

  async start(): Promise<void> { this.running = true; }
  async stop(): Promise<void> {
    this.running = false;
    this.rejectPendingInboundConsumers();
  }
  isRunning(): boolean { return this.running; }
  consumeOne(): Promise<InboundMessage | null> { return this.consumeInboundMessage(this.running); }
  async send(message: OutboundMessage): Promise<SendResult> {
    this.sentMessages.push(message);
    return { ok: true, messageId: `manual-${this.sentMessages.length}` };
  }
  override getBotDisplayName(): string { return 'qaq'; }
  validateConfig(): string | null { return null; }
  isAuthorized(): boolean { return true; }
}

describe('agent message manual ingress', () => {
  let service: BridgeControlService | null = null;

  afterEach(async () => {
    await service?.close();
    service = null;
    await stop();
    fs.rmSync(path.join(CODELARK_HOME, 'data'), { recursive: true, force: true });
    fs.rmSync(CONFIG_PATH, { force: true });
  });

  it('accepts through discovery, preserves the ordinary input, and notifies both chats', async () => {
    fs.mkdirSync(CODELARK_HOME, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, [
      'schema_version = 2',
      '',
      '[[channels]]',
      'id = "manual-ingress-main"',
      'alias = "Manual ingress"',
      'provider = "feishu"',
      'enabled = true',
      '',
      '[channels.config]',
      '',
    ].join('\n'));
    const adapters: ManualIngressAdapter[] = [];
    registerAdapterFactory('feishu', (instance) => {
      const created = new ManualIngressAdapter(instance);
      adapters.push(created);
      return created;
    });
    initBridgeContext({
      store: new JsonFileStore(new Map([
        ['remote_bridge_enabled', 'true'],
        ['bridge_default_model', 'test-model'],
        ['bridge_default_mode', 'code'],
      ])),
      llm: noopLlm,
      permissions: noopPermissions,
      lifecycle: noopLifecycle,
    });
    _testOnly.resetStateForTests();
    const source = router.createBinding({
      channelType: 'manual-ingress-main',
      channelProvider: 'feishu',
      chatId: 'oc_source',
      chatKind: 'group',
      displayName: '来源群',
    }, os.tmpdir(), '来源群');
    const target = router.createBinding({
      channelType: 'manual-ingress-main',
      channelProvider: 'feishu',
      chatId: 'oc_target',
      chatKind: 'group',
      displayName: '目标群',
    }, os.tmpdir(), '目标群');
    await _testOnly.syncConfiguredAdapters({ startLoops: false });
    const adapter = adapters.at(-1);
    assert.ok(adapter);
    service = await startBridgeControlService({
      codelarkHome: CODELARK_HOME,
      runId: `test-${process.pid}-${Date.now()}`,
      handlers: {
        listSessions: listActiveBridgeSessions,
        receiveInput: receiveManualInput,
      },
    });

    await sendAgentMessageFromBinding(source.id, {
      target: target.id,
      text: '  /stop\n',
      idempotencyKey: 'condition-monitor-stable-id',
    });
    const inbound = await adapter.consumeOne();
    await _testOnlyWaitForDeliveryQueuesForTests(adapter);

    assert.equal(inbound?.address.chatId, 'oc_target');
    assert.equal(inbound?.text, '  /stop\n');
    assert.match(inbound?.contextText || '', /来源群聊："来源群"/u);
    assert.match(inbound?.contextText || '', /来源 Bot："qaq"/u);
    assert.doesNotMatch(inbound?.contextText || '', /来源 Bot："来源群"/u);
    assert.match(inbound?.contextText || '', new RegExp(`来源会话 ID："${source.bridgeSessionId}"`, 'u'));
    assert.deepEqual(adapter.sentMessages.map((message) => ({
      chatId: message.address.chatId,
      title: message.richCard?.title,
    })), [
      { chatId: 'oc_target', title: '收到 Agent 消息' },
      { chatId: 'oc_source', title: 'Agent 消息已发送' },
    ]);

    await sendAgentMessageFromBinding(source.id, {
      target: target.id,
      text: '  /stop\n',
      idempotencyKey: 'condition-monitor-stable-id',
    });
    await _testOnlyWaitForDeliveryQueuesForTests(adapter);
    assert.equal(adapter.sentMessages.length, 2, 'same persistent key must not enqueue input or cards twice');
    for (const message of adapter.sentMessages) {
      assert.equal(message.richCard?.panels, undefined);
      assert.match(message.richCard?.sections[1]?.markdown || '', /  \/stop\n/u);
    }

    await sendAgentMessageFromBinding(source.id, { target: 'current', text: '/then-form' });
    const selfInput = await adapter.consumeOne();
    await _testOnlyWaitForDeliveryQueuesForTests(adapter);
    assert.equal(selfInput?.address.chatId, 'oc_source');
    assert.equal(selfInput?.text, '/then-form');
    assert.equal(adapter.sentMessages.length, 2);

    const longText = [
      '请核对下面的完整多行消息：',
      '```json',
      JSON.stringify({ value: '跨 Agent 原文' }),
      '```',
      '正文'.repeat(420),
    ].join('\n');
    await sendAgentMessageFromBinding(source.id, { target: target.id, text: longText });
    const longInbound = await adapter.consumeOne();
    await _testOnlyWaitForDeliveryQueuesForTests(adapter);
    assert.equal(longInbound?.text, longText);
    const longCards = adapter.sentMessages.slice(2, 4).map((message) => message.richCard);
    assert.equal(longCards.length, 2);
    for (const card of longCards) {
      assert.equal(card?.sections.length, 1);
      assert.equal(card?.panels?.length, 1);
      assert.equal(card?.panels?.[0]?.expanded, false);
      assert.equal(card?.panels?.[0]?.title, '消息内容（点击展开）');
      assert.ok(card?.panels?.[0]?.sections?.[0]?.markdown?.includes(longText));
    }
    const renderedLongCard = JSON.parse(buildRichCardContent(longCards[0]!)) as any;
    const renderedMessagePanel = renderedLongCard.body.elements.find(
      (element: any) => element.tag === 'collapsible_panel',
    );
    assert.equal(renderedMessagePanel?.expanded, false);
    const renderedMessageContent = renderedMessagePanel?.elements?.[0]?.columns?.[0]?.elements?.[0]?.content;
    assert.ok(String(renderedMessageContent || '').replace(/\u200b/gu, '').includes(longText));

    const beforePlatformMessage = adapter.sentMessages.length;
    const platformRequest = {
      targetInternalChatId: target.id,
      platformMessage: { msgType: 'interactive', content: { schema: '2.0', body: { elements: [] } } },
      idempotencyKey: 'condition-monitor-platform-id',
    };
    await sendPlatformMessage(platformRequest);
    await sendPlatformMessage(platformRequest);
    assert.equal(adapter.sentMessages.length, beforePlatformMessage + 1);
    assert.equal(
      adapter.sentMessages.at(-1)?.platformMessage?.uuid,
      'condition-monitor-platform-id',
    );

    await assert.rejects(
      sendAgentMessageFromBinding(source.id, { target: 'missing-target', text: 'hello' }),
      /没有找到目标/u,
    );
    await _testOnlyWaitForDeliveryQueuesForTests(adapter);
    assert.equal(adapter.sentMessages.at(-1)?.address.chatId, 'oc_source');
    assert.equal(adapter.sentMessages.at(-1)?.richCard?.title, 'Agent 消息发送失败');
    assert.equal(adapter.sentMessages.at(-1)?.richCard?.template, 'red');
    assert.match(adapter.sentMessages.at(-1)?.richCard?.sections[1]?.markdown || '', /hello/u);
  });
});
