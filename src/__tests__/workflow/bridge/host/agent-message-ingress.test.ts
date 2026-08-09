import '../../../setup/test-setup.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { CODELARK_HOME } from '../../../../configuration/paths.js';
import { BaseChannelAdapter, registerAdapterFactory } from '../../../../channels/contracts.js';
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
    });
    const inbound = await adapter.consumeOne();
    await _testOnlyWaitForDeliveryQueuesForTests(adapter);

    assert.equal(inbound?.address.chatId, 'oc_target');
    assert.equal(inbound?.text, '  /stop\n');
    assert.match(inbound?.contextText || '', /来源群聊："来源群"/u);
    assert.match(inbound?.contextText || '', /来源 Bot："qaq"/u);
    assert.doesNotMatch(inbound?.contextText || '', /来源 Bot："来源群"/u);
    assert.match(inbound?.contextText || '', new RegExp(`回复目标："${source.bridgeSessionId}"`, 'u'));
    assert.deepEqual(adapter.sentMessages.map((message) => ({
      chatId: message.address.chatId,
      title: message.richCard?.title,
    })), [
      { chatId: 'oc_target', title: '收到 Agent 消息' },
      { chatId: 'oc_source', title: 'Agent 消息已发送' },
    ]);

    await sendAgentMessageFromBinding(source.id, { target: 'current', text: '/then-form' });
    const selfInput = await adapter.consumeOne();
    await _testOnlyWaitForDeliveryQueuesForTests(adapter);
    assert.equal(selfInput?.address.chatId, 'oc_source');
    assert.equal(selfInput?.text, '/then-form');
    assert.equal(adapter.sentMessages.length, 2);

    await assert.rejects(
      sendAgentMessageFromBinding(source.id, { target: 'missing-target', text: 'hello' }),
      /没有找到目标/u,
    );
    await _testOnlyWaitForDeliveryQueuesForTests(adapter);
    assert.equal(adapter.sentMessages.at(-1)?.address.chatId, 'oc_source');
    assert.equal(adapter.sentMessages.at(-1)?.richCard?.title, 'Agent 消息发送失败');
    assert.equal(adapter.sentMessages.at(-1)?.richCard?.template, 'red');
  });
});
