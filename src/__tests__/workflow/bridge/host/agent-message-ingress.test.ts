import '../../../setup/test-setup.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { CODELARK_HOME } from '../../../../configuration/paths.js';
import {
  BaseChannelAdapter,
  registerAdapterFactory,
  type CreateGroupChatOptions,
  type CreatedGroupChat,
} from '../../../../channels/contracts.js';
import type {
  AgentMessageSentInfo,
  InboundMessage,
  OutboundMessage,
  PermissionGateway,
  SendResult,
} from '../../../../domain/index.js';
import type { LifecycleHooks, LLMProvider, StreamChatParams } from '../../../../runtime/contracts.js';
import { JsonFileStore } from '../../../../storage/json-store.js';
import { initBridgeContext } from '../../../../bridge/host/context.js';
import * as router from '../../../../bridge/host/channel-router.js';
import {
  _testOnly,
  listActiveBridgeSessions,
  receiveAgentInput,
  receiveManualInput,
  sendAgentMessageFromBinding,
  sendPlatformMessage,
  stop,
} from '../../../../bridge/host/manager.js';
import {
  deliverAgentInputFromSession,
  startBridgeControlService,
  type BridgeControlService,
} from '../../../../bridge/control/service-discovery.js';
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
  readonly createdGroups: CreatedGroupChat[] = [];
  readonly createGroupRequests: CreateGroupChatOptions[] = [];
  readonly reactions: Array<{ messageId: string; emojiType: string }> = [];
  readonly agentMessageEvents: Array<{ chatId: string; event: AgentMessageSentInfo }> = [];
  mergeAgentMessageEvents = true;
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
  async addMessageReaction(messageId: string, emojiType: string): Promise<string> {
    this.reactions.push({ messageId, emojiType });
    return `reaction-${this.reactions.length}`;
  }
  onAgentMessageSent(chatId: string, event: AgentMessageSentInfo): boolean {
    if (!this.mergeAgentMessageEvents) return false;
    this.agentMessageEvents.push({ chatId, event });
    return true;
  }
  async createGroupChat(options: CreateGroupChatOptions): Promise<CreatedGroupChat> {
    this.createGroupRequests.push(options);
    const group = {
      chatId: `oc_created_${this.createdGroups.length + 1}`,
      chatKind: 'group' as const,
      name: options.name,
    };
    this.createdGroups.push(group);
    return group;
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

  it('accepts through discovery, preserves ordinary input, and merges only the source receipt', async () => {
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
      userId: 'ou_agent_owner',
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
        sendAgentInput: receiveAgentInput,
      },
    });

    const deliveredTarget = await deliverAgentInputFromSession({
      source: source.bridgeSessionId,
      sourceHome: CODELARK_HOME,
      target: target.bridgeSessionId,
      targetHome: CODELARK_HOME,
      text: '  /stop\n',
      idempotencyKey: 'condition-monitor-stable-id',
    });
    assert.equal(deliveredTarget.bridgeSessionId, target.bridgeSessionId);
    const inbound = await adapter.consumeOne();
    await _testOnlyWaitForDeliveryQueuesForTests(adapter);

    assert.equal(inbound?.address.chatId, 'oc_target');
    assert.equal(inbound?.text, '  /stop\n');
    assert.match(inbound?.contextText || '', /来源群聊："来源群"/u);
    assert.match(inbound?.contextText || '', /来源 Bot："qaq"/u);
    assert.doesNotMatch(inbound?.contextText || '', /来源 Bot："来源群"/u);
    assert.match(inbound?.contextText || '', new RegExp(`来源会话 ID："${source.bridgeSessionId}"`, 'u'));
    assert.match(inbound?.contextText || '', new RegExp(`当前会话 ID："${target.bridgeSessionId}"`, 'u'));
    assert.equal(adapter.sentMessages.length, 0, 'successful delivery must not create separate receive/send cards');
    assert.deepEqual(adapter.agentMessageEvents, [{
      chatId: 'oc_source',
      event: { targetChatName: '目标群', messageText: '  /stop\n' },
    }]);
    assert.equal(
      listActiveBridgeSessions().find((session) => session.internalChatId === target.id)?.agentName,
      'qaq',
      'discovery must expose the adapter Bot name instead of copying the chat name',
    );
    await sendAgentMessageFromBinding(source.id, {
      target: target.id,
      text: '  /stop\n',
      idempotencyKey: 'condition-monitor-stable-id',
    });
    await _testOnlyWaitForDeliveryQueuesForTests(adapter);
    assert.equal(adapter.agentMessageEvents.length, 1, 'same persistent key must not enqueue input or events twice');

    await sendAgentMessageFromBinding(source.id, { target: 'current', text: '/then-form' });
    const selfInput = await adapter.consumeOne();
    await _testOnlyWaitForDeliveryQueuesForTests(adapter);
    assert.equal(selfInput?.address.chatId, 'oc_source');
    assert.equal(selfInput?.text, '/then-form');
    assert.equal(adapter.agentMessageEvents.length, 1);

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
    assert.deepEqual(adapter.agentMessageEvents.at(-1), {
      chatId: 'oc_source',
      event: { targetChatName: '目标群', messageText: longText },
    });

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

    adapter.mergeAgentMessageEvents = false;
    await sendAgentMessageFromBinding(source.id, { target: target.id, text: '无活动卡兜底' });
    const fallbackInbound = await adapter.consumeOne();
    await _testOnlyWaitForDeliveryQueuesForTests(adapter);
    assert.equal(fallbackInbound?.text, '无活动卡兜底');
    const fallbackCard = adapter.sentMessages.at(-1)?.richCard;
    assert.equal(fallbackCard?.title, 'Agent 消息已发送');
    assert.deepEqual(fallbackCard?.sections[0]?.fields, [['目标群聊', '目标群']]);
    assert.doesNotMatch(JSON.stringify(fallbackCard), /Bot/u);
    adapter.mergeAgentMessageEvents = true;

    const delegatedWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-agent-delegate-'));
    await sendAgentMessageFromBinding(source.id, {
      target: 'current',
      text: `/new agent-review ${delegatedWorkDir}`,
    });
    const newCommand = await adapter.consumeOne();
    assert.ok(newCommand);
    assert.equal(newCommand.text, `/new agent-review ${delegatedWorkDir}`);
    assert.equal(newCommand.address.userId, 'ou_agent_owner');
    await _testOnly.handleMessage(adapter, newCommand);
    assert.deepEqual(
      adapter.reactions,
      [],
      'synthetic manual commands must not call the platform reaction API with a manual: message ID',
    );

    assert.deepEqual(adapter.createGroupRequests, [{
      name: 'agent-review',
      ownerUserId: 'ou_agent_owner',
      userIds: ['ou_agent_owner'],
    }]);
    const createdGroup = adapter.createdGroups.at(-1);
    assert.ok(createdGroup);
    const delegatedBinding = router.resolve({
      channelType: 'manual-ingress-main',
      chatId: createdGroup.chatId,
    });
    assert.notEqual(delegatedBinding.id, source.id, 'new delegated work must have a dedicated chat');
    const discoveredAgent = listActiveBridgeSessions()
      .filter((session) => session.chatName === 'agent-review');
    assert.equal(discoveredAgent.length, 1, 'the dedicated chat must be discoverable by exact name');
    assert.equal(discoveredAgent[0]?.bridgeSessionId, delegatedBinding.bridgeSessionId);

    const delegatedTask = '请独立审查当前改动，并把结论回复给来源群。';
    await sendAgentMessageFromBinding(source.id, {
      target: discoveredAgent[0]!.bridgeSessionId,
      text: delegatedTask,
    });
    const delegatedInput = await adapter.consumeOne();
    assert.equal(delegatedInput?.address.chatId, createdGroup.chatId);
    assert.equal(delegatedInput?.text, delegatedTask);

    await assert.rejects(
      sendAgentMessageFromBinding(source.id, { target: 'missing-target', text: 'hello' }),
      /没有找到目标/u,
    );
    await _testOnlyWaitForDeliveryQueuesForTests(adapter);
    assert.equal(adapter.sentMessages.at(-1)?.address.chatId, 'oc_source');
    assert.equal(adapter.sentMessages.at(-1)?.richCard?.title, 'Agent 消息发送失败');
    assert.equal(adapter.sentMessages.at(-1)?.richCard?.template, 'red');
    assert.deepEqual(adapter.sentMessages.at(-1)?.richCard?.sections[0]?.fields, [
      ['来源群聊', '来源群'],
      ['来源 Bot', 'qaq'],
    ]);
    assert.deepEqual(adapter.sentMessages.at(-1)?.richCard?.sections[1]?.fields, [
      ['目标', 'missing-target'],
      ['错误', '没有找到目标：missing-target'],
    ]);
    assert.match(adapter.sentMessages.at(-1)?.richCard?.sections[2]?.markdown || '', /hello/u);
  });
});
