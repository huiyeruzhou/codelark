import '../../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { BaseChannelAdapter, type StructuredStreamingUiMetadata } from '../../../../channels/contracts.js';
import { initBridgeContext } from '../../../../bridge/host/context.js';
import { createMirrorFeedbackController } from '../../../../bridge/mirror/feedback-controller.js';
import { createMirrorSubscription } from '../../../../bridge/mirror/subscription-state.js';
import { consumeMirrorRecords } from '../../../../bridge/mirror/turns.js';
import type { InboundMessage, OutboundMessage, SendResult, TaskProgressInfo, ToolCallInfo } from '../../../../domain/index.js';
import { JsonFileStore } from '../../../../storage/json-store.js';

class FakeMirrorFeishuAdapter extends BaseChannelAdapter {
  readonly channelType = 'feishu-default';
  readonly provider = 'feishu';
  readonly texts: string[] = [];
  readonly statuses: string[] = [];
  readonly streamEnds: Array<{ status: 'completed' | 'interrupted' | 'error'; text: string }> = [];
  readonly tools: ToolCallInfo[][] = [];
  readonly tasks: TaskProgressInfo[][] = [];
  readonly sent: OutboundMessage[] = [];
  readonly metadata: Array<{ chatId: string; streamKey?: string; metadata: StructuredStreamingUiMetadata }> = [];
  streamEndResult = true;
  private active = false;

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  isRunning(): boolean { return true; }
  consumeOne(): Promise<InboundMessage | null> { return Promise.resolve(null); }
  send(message: OutboundMessage): Promise<SendResult> {
    this.sent.push(message);
    return Promise.resolve({ ok: true });
  }
  validateConfig(): string | null { return null; }
  isAuthorized(): boolean { return true; }

  supportsStructuredStreamingUi(): boolean {
    return true;
  }

  hasActiveStreamingUi(): boolean {
    return this.active;
  }

  getStructuredStreamingUiMessageId(): string | null {
    return this.active ? 'mirror-stream-message-1' : null;
  }

  onMirrorStreamStart(): void {
    this.active = true;
  }

  onStreamMetadata(chatId: string, metadata: StructuredStreamingUiMetadata, streamKey?: string): void {
    this.metadata.push({ chatId, streamKey, metadata });
  }

  onStreamText(_chatId: string, text: string): void {
    this.active = true;
    this.texts.push(text);
  }

  onStreamStatus(_chatId: string, statusText: string): void {
    this.active = true;
    this.statuses.push(statusText);
  }

  onToolEvent(_chatId: string, tools: ToolCallInfo[]): void {
    this.tools.push(tools.map((tool) => ({ ...tool })));
  }

  onTaskEvent(_chatId: string, tasks: TaskProgressInfo[]): void {
    this.tasks.push(tasks.map((task) => ({ ...task })));
  }

  onStreamEnd(_chatId: string, status: 'completed' | 'interrupted' | 'error', text: string): Promise<boolean> {
    this.streamEnds.push({ status, text });
    this.active = false;
    return Promise.resolve(this.streamEndResult);
  }
}

describe('mirror-feedback-controller', () => {
  it('builds mirror stream card title and tags from subscription metadata', () => {
    initBridgeContext({
      store: new JsonFileStore(new Map()),
      llm: {
        streamChat() {
          return new ReadableStream({
            start(controller) {
              controller.close();
            },
          });
        },
      },
      permissions: {
        resolvePendingPermission: () => false,
      },
      lifecycle: {},
    });

    const adapter = new FakeMirrorFeishuAdapter();
    const baseMs = Date.parse('2026-05-14T00:00:00.000Z');
    const controller = createMirrorFeedbackController({
      getAdapter: () => adapter,
      getThreadTitle: () => 'Mirror Thread',
      nowIso: () => new Date(baseMs).toISOString(),
      eventBatchLimit: 10,
      deliverResponse: async () => ({ ok: true }),
    });
    const subscription = createMirrorSubscription({
      bindingId: 'binding-123456789',
      sessionId: 'session-123456789',
      channelType: 'feishu-default',
      chatId: 'chat-1',
      threadId: 'thread-123456789',
      filePath: 'rollout.jsonl',
      lastDeliveredAt: null,
    });

    consumeMirrorRecords(subscription, [
      {
        signature: 'message-1',
        type: 'message',
        role: 'assistant',
        content: '第一段输出',
        timestamp: new Date(baseMs).toISOString(),
        turnId: 'turn-1',
      },
    ], controller.hooks);

    assert.equal(adapter.metadata.length, 1);
    assert.equal(adapter.metadata[0]?.chatId, 'chat-1');
    assert.equal(adapter.metadata[0]?.streamKey, 'mirror:session-123456789:turn-1');
    assert.equal(adapter.metadata[0]?.metadata.title, 'Mirror Thread');
    assert.deepEqual(adapter.metadata[0]?.metadata.tags, [
      'bridge_id:session-',
      'mirror',
    ]);
  });

  it('keeps last response age visible when mirror tool progress updates the status area', () => {
    initBridgeContext({
      store: new JsonFileStore(new Map()),
      llm: {
        streamChat() {
          return new ReadableStream({
            start(controller) {
              controller.close();
            },
          });
        },
      },
      permissions: {
        resolvePendingPermission: () => false,
      },
      lifecycle: {},
    });

    const adapter = new FakeMirrorFeishuAdapter();
    const baseMs = Date.parse('2026-05-14T00:00:00.000Z');
    let nowMs = baseMs;
    const originalDateNow = Date.now;
    Date.now = () => nowMs;

    try {
      const controller = createMirrorFeedbackController({
        getAdapter: () => adapter,
        getThreadTitle: () => '测试线程',
        getStructuredStreamStatusConfig: () => ({
          idleStartMs: 10_000,
          heartbeatMs: 10_000,
        }),
        nowIso: () => new Date(nowMs).toISOString(),
        eventBatchLimit: 10,
        deliverResponse: async () => ({ ok: true }),
      });
      const subscription = createMirrorSubscription({
        bindingId: 'binding-1',
        sessionId: 'session-1',
        channelType: 'feishu-default',
        chatId: 'chat-1',
        threadId: 'thread-1',
        filePath: 'rollout.jsonl',
        lastDeliveredAt: null,
      });

      consumeMirrorRecords(subscription, [
        {
          signature: 'start-1',
          type: 'task_started',
          content: '',
          timestamp: new Date(baseMs).toISOString(),
          turnId: 'turn-1',
        },
        {
          signature: 'message-1',
          type: 'message',
          role: 'assistant',
          content: '第一段输出',
          timestamp: new Date(baseMs).toISOString(),
          turnId: 'turn-1',
        },
      ], controller.hooks);

      nowMs = baseMs + 15_000;
      consumeMirrorRecords(subscription, [
        {
          signature: 'tool-1',
          type: 'tool_started',
          content: '',
          timestamp: new Date(nowMs).toISOString(),
          turnId: 'turn-1',
          toolId: 'tool-1',
          toolName: 'Bash',
        },
      ], controller.hooks);

      assert.equal(adapter.statuses.at(-1), '已运行 15秒，上次响应距今 15秒');
    } finally {
      Date.now = originalDateNow;
    }
  });

  it('passes the global tool detail setting into mirror tool rendering', () => {
    initBridgeContext({
      store: new JsonFileStore(new Map()),
      llm: {
        streamChat() {
          return new ReadableStream({
            start(controller) {
              controller.close();
            },
          });
        },
      },
      permissions: {
        resolvePendingPermission: () => false,
      },
      lifecycle: {},
    });

    const adapter = new FakeMirrorFeishuAdapter();
    const baseMs = Date.parse('2026-05-14T00:00:00.000Z');
    const controller = createMirrorFeedbackController({
      getAdapter: () => adapter,
      getThreadTitle: () => '测试线程',
      nowIso: () => new Date(baseMs).toISOString(),
      eventBatchLimit: 10,
      deliverResponse: async () => ({ ok: true }),
    });
    const subscription = createMirrorSubscription({
      bindingId: 'binding-1',
      sessionId: 'session-1',
      channelType: 'feishu-default',
      chatId: 'chat-1',
      threadId: 'thread-1',
      filePath: 'rollout.jsonl',
      lastDeliveredAt: null,
    });

    consumeMirrorRecords(subscription, [
      {
        signature: 'tool-start-1',
        type: 'tool_started',
        content: '',
        timestamp: new Date(baseMs).toISOString(),
        turnId: 'turn-1',
        toolId: 'tool-1',
        toolName: 'Bash',
        toolInput: { command: 'pwd' },
      },
      {
        signature: 'tool-end-1',
        type: 'tool_finished',
        content: '/tmp/project',
        timestamp: new Date(baseMs + 1000).toISOString(),
        turnId: 'turn-1',
        toolId: 'tool-1',
      },
    ], controller.hooks);

    assert.equal(adapter.tools.at(-1)?.[0]?.input, 'pwd');
    assert.equal(adapter.tools.at(-1)?.[0]?.output, '/tmp/project');

  });

  it('shows mirror context and turn token usage in the stream status area and final card', async () => {
    initBridgeContext({
      store: new JsonFileStore(new Map()),
      llm: {
        streamChat() {
          return new ReadableStream({
            start(controller) {
              controller.close();
            },
          });
        },
      },
      permissions: {
        resolvePendingPermission: () => false,
      },
      lifecycle: {},
    });

    const adapter = new FakeMirrorFeishuAdapter();
    const baseMs = Date.parse('2026-05-14T00:00:00.000Z');
    const controller = createMirrorFeedbackController({
      getAdapter: () => adapter,
      getThreadTitle: () => '测试线程',
      nowIso: () => new Date(baseMs).toISOString(),
      eventBatchLimit: 10,
      deliverResponse: async () => ({ ok: true }),
    });
    const subscription = createMirrorSubscription({
      bindingId: 'binding-1',
      sessionId: 'session-1',
      channelType: 'feishu-default',
      chatId: 'chat-1',
      threadId: 'thread-1',
      filePath: 'rollout.jsonl',
      lastDeliveredAt: null,
    });

    const finalized = consumeMirrorRecords(subscription, [
      {
        signature: 'start-1',
        type: 'task_started',
        content: '',
        timestamp: new Date(baseMs).toISOString(),
        turnId: 'turn-1',
      },
      {
        signature: 'usage-1',
        type: 'context_usage',
        content: '',
        timestamp: new Date(baseMs + 1000).toISOString(),
        turnId: 'turn-1',
        contextUsage: {
          modelContextWindow: 200_000,
          lastTokenUsage: {
            inputTokens: 125_300,
            outputTokens: 4_600,
          },
        },
      },
      {
        signature: 'complete-1',
        type: 'task_complete',
        content: '最终回答',
        timestamp: new Date(baseMs + 2000).toISOString(),
        turnId: 'turn-1',
      },
    ], controller.hooks);

    assert.match(adapter.statuses.at(-1) || '', /125k\(63%\)/);
    assert.match(adapter.statuses.at(-1) || '', /↑125k ↓4\.6k/);
    await controller.deliverMirrorTurns(subscription, finalized);
    assert.equal(adapter.streamEnds[0]?.status, 'completed');
    assert.equal(adapter.streamEnds[0]?.text, '');
  });

  it('delivers clk ask question cards after mirror stream finalization', async () => {
    initBridgeContext({
      store: new JsonFileStore(new Map()),
      llm: {
        streamChat() {
          return new ReadableStream({
            start(controller) {
              controller.close();
            },
          });
        },
      },
      permissions: {
        resolvePendingPermission: () => false,
      },
      lifecycle: {},
    });

    const adapter = new FakeMirrorFeishuAdapter();
    const baseMs = Date.parse('2026-05-14T00:00:00.000Z');
    const controller = createMirrorFeedbackController({
      getAdapter: () => adapter,
      getThreadTitle: () => '测试线程',
      nowIso: () => new Date(baseMs).toISOString(),
      eventBatchLimit: 10,
      deliverResponse: async () => ({ ok: true }),
    });
    const subscription = createMirrorSubscription({
      bindingId: 'binding-1',
      sessionId: 'session-1',
      channelType: 'feishu-default',
      chatId: 'chat-1',
      threadId: 'thread-1',
      filePath: 'rollout.jsonl',
      lastDeliveredAt: null,
    });

    const finalized = consumeMirrorRecords(subscription, [
      {
        signature: 'message-ask',
        type: 'message',
        role: 'assistant',
        content: '需要确认。',
        timestamp: new Date(baseMs).toISOString(),
        turnId: 'turn-1',
      },
      {
        signature: 'complete-ask',
        type: 'task_complete',
        content: [
          '需要确认。',
          '<clk-ask>{"question":"请选择环境","options":["测试","生产"],"input":{"label":"补充说明","placeholder":"可留空"},"submitText":"提交"}</clk-ask>',
        ].join('\n'),
        timestamp: new Date(baseMs).toISOString(),
        turnId: 'turn-1',
      },
    ], controller.hooks);

    await controller.deliverMirrorTurns(subscription, finalized);

    assert.equal(adapter.streamEnds[0]?.status, 'completed');
    assert.equal(adapter.streamEnds[0]?.text, '');
    assert.doesNotMatch(adapter.streamEnds[0]?.text || '', /clk-ask/);
    assert.equal(adapter.sent.length, 1);
    assert.equal(adapter.sent[0]?.text, '请选择环境');
    assert.equal(adapter.sent[0]?.replyToMessageId, 'mirror-stream-message-1');
    assert.equal(adapter.sent[0]?.richCard?.title, '需要确认');
    assert.equal(adapter.sent[0]?.richCard?.form?.optionElementId, 'clk_choice');
    assert.equal(adapter.sent[0]?.richCard?.form?.inputLabel, '补充说明');
  });

  it('preserves clk ask question cards when mirror falls back to message delivery', async () => {
    initBridgeContext({
      store: new JsonFileStore(new Map()),
      llm: {
        streamChat() {
          return new ReadableStream({
            start(controller) {
              controller.close();
            },
          });
        },
      },
      permissions: {
        resolvePendingPermission: () => false,
      },
      lifecycle: {},
    });

    const adapter = new FakeMirrorFeishuAdapter();
    adapter.streamEndResult = false;
    const baseMs = Date.parse('2026-05-14T00:00:00.000Z');
    const controller = createMirrorFeedbackController({
      getAdapter: () => adapter,
      getThreadTitle: () => '测试线程',
      nowIso: () => new Date(baseMs).toISOString(),
      eventBatchLimit: 10,
      deliverResponse: async () => ({ ok: true }),
    });
    const subscription = createMirrorSubscription({
      bindingId: 'binding-1',
      sessionId: 'session-1',
      channelType: 'feishu-default',
      chatId: 'chat-1',
      threadId: 'thread-1',
      filePath: 'rollout.jsonl',
      lastDeliveredAt: null,
    });

    const finalized = consumeMirrorRecords(subscription, [
      {
        signature: 'complete-ask-fallback',
        type: 'task_complete',
        content: [
          '需要确认。',
          '<clk-ask>{"question":"请选择策略","options":["灰度","全量"]}</clk-ask>',
        ].join('\n'),
        timestamp: new Date(baseMs).toISOString(),
        turnId: 'turn-1',
      },
    ], controller.hooks);

    await controller.deliverMirrorTurns(subscription, finalized);

    assert.equal(adapter.streamEnds[0]?.status, 'completed');
    assert.equal(adapter.sent.length, 2);
    assert.match(adapter.sent[0]?.text || '', /需要确认。/);
    assert.doesNotMatch(adapter.sent[0]?.text || '', /clk-ask/);
    assert.equal(adapter.sent[1]?.text, '请选择策略');
    assert.equal(adapter.sent[1]?.richCard?.actions?.[0]?.length, 2);
  });
});
