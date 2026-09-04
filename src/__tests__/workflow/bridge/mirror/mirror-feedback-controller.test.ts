import '../../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { BaseChannelAdapter, type StructuredStreamingUiMetadata } from '../../../../channels/contracts.js';
import { _testOnlyWaitForDeliveryQueuesForTests } from '../../../../channels/delivery/deliver.js';
import { initBridgeContext } from '../../../../bridge/host/context.js';
import {
  createMirrorFeedbackController,
  formatMirrorTerminalErrorStatus,
} from '../../../../bridge/mirror/feedback-controller.js';
import { createMirrorSubscription } from '../../../../bridge/mirror/subscription-state.js';
import { consumeMirrorRecords } from '../../../../bridge/mirror/turns.js';
import type { InboundMessage, OutboundManualInput, OutboundMessage, RuntimeNoticeInfo, SendResult, StreamingHistoryItem, TaskProgressInfo, ToolCallInfo } from '../../../../domain/index.js';
import { JsonFileStore } from '../../../../storage/json-store.js';
import { formatFooterClockTime } from '../../../../shared/progress/footer.js';

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

class FakeMirrorFeishuAdapter extends BaseChannelAdapter {
  readonly channelType = 'feishu-default';
  readonly provider = 'feishu';
  readonly texts: string[] = [];
  readonly statuses: string[] = [];
  readonly streamEnds: Array<{ status: 'completed' | 'interrupted' | 'error'; text: string }> = [];
  readonly tools: ToolCallInfo[][] = [];
  readonly tasks: TaskProgressInfo[][] = [];
  readonly histories: StreamingHistoryItem[][] = [];
  readonly notices: RuntimeNoticeInfo[] = [];
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

  onStreamHistory(_chatId: string, items: StreamingHistoryItem[]): void {
    this.histories.push(items.map((item) => (
      item.type === 'tool_panel'
        ? { ...item, tools: item.tools.map((tool) => ({ ...tool })) }
        : { ...item }
    )));
  }

  onRuntimeNotice(_chatId: string, notice: RuntimeNoticeInfo): void {
    this.notices.push({ ...notice });
  }

  onStreamEnd(_chatId: string, status: 'completed' | 'interrupted' | 'error', text: string): Promise<boolean> {
    this.streamEnds.push({ status, text });
    this.active = false;
    return Promise.resolve(this.streamEndResult);
  }
}

class DelayedMirrorCardAdapter extends FakeMirrorFeishuAdapter {
  readonly cardCreateStarted = createDeferred();
  readonly cardCreated = createDeferred();
  private cardMessageId: string | null = null;

  onMirrorStreamStart(): void {}

  getStructuredStreamingUiMessageId(): string | null {
    return this.cardMessageId;
  }

  async waitForStructuredStreamingUiMessageId(): Promise<string | null> {
    this.cardCreateStarted.resolve();
    await this.cardCreated.promise;
    this.cardMessageId = 'delayed-mirror-card-message';
    return this.cardMessageId;
  }
}

describe('mirror-feedback-controller', () => {
  it('resolves the completed lifecycle before rendering one terminal card state', async () => {
    const adapter = new FakeMirrorFeishuAdapter();
    const controller = createMirrorFeedbackController({
      getAdapter: () => adapter,
      getThreadTitle: () => '测试线程',
      resolveFinalizedTurnStatus: async (_subscription, turn) => {
        assert.equal(turn.status, 'completed');
        return 'error' as const;
      },
      nowIso: () => '2026-05-14T00:00:00.000Z',
      eventBatchLimit: 10,
      deliverResponse: async () => ({ ok: true }),
    });
    const subscription = createMirrorSubscription({
      bindingId: 'binding-error',
      sessionId: 'session-error',
      channelType: 'feishu-default',
      chatId: 'chat-error',
      threadId: 'thread-error',
      filePath: 'rollout.jsonl',
      lastDeliveredAt: null,
    });

    const turn = {
      streamKey: 'mirror:session-error:turn-error',
      userText: '触发错误',
      text: '请求失败',
      signature: 'complete-error',
      timestamp: '2026-05-14T00:00:01.000Z',
      startedAt: new Date(Date.now() - 2_000).toISOString(),
      status: 'completed' as const,
      errorText: '{"error":{"type":"invalid_request_error","message":"CODELARK_MOCK_FATAL"}}',
      contextUsage: {
        modelContextWindow: 200_000,
        lastTokenUsage: { inputTokens: 125_300, outputTokens: 4_600 },
      },
    };
    const result = await controller.deliverMirrorTurns(subscription, [turn]);

    assert.equal(result.deliveredCount, 1);
    assert.equal(turn.status, 'error');
    assert.deepEqual(adapter.streamEnds.map((entry) => entry.status), ['error']);
    assert.equal(adapter.streamEnds[0]?.text, '');
    assert.match(adapter.statuses.at(-1) || '', /invalid_request_error · CODELARK_MOCK_FATAL/);
    assert.match(adapter.statuses.at(-1) || '', /已运行 2s/);
    assert.match(adapter.statuses.at(-1) || '', /125k\(63%\) · ↑125k ↓4\.6k/);
    assert.doesNotMatch(adapter.statuses.at(-1) || '', /处理中/);
  });

  it('pushes a recoverable runtime notice into card history without changing completed status', async () => {
    const adapter = new FakeMirrorFeishuAdapter();
    const controller = createMirrorFeedbackController({
      getAdapter: () => adapter,
      getThreadTitle: () => '测试线程',
      resolveFinalizedTurnStatus: async (_subscription, turn) => {
        turn.runtimeNotices = [
          {
            level: 'error',
            title: '操作未完成',
            message: 'goal 更新失败\n当前任务仍在继续。',
            source: 'codex_tui',
          },
        ];
        return turn.status;
      },
      nowIso: () => '2026-05-14T00:00:00.000Z',
      eventBatchLimit: 10,
      deliverResponse: async () => ({ ok: true }),
    });
    const subscription = createMirrorSubscription({
      bindingId: 'binding-runtime-notice',
      sessionId: 'session-runtime-notice',
      channelType: 'feishu-default',
      chatId: 'chat-runtime-notice',
      threadId: 'thread-runtime-notice',
      filePath: 'rollout.jsonl',
      lastDeliveredAt: null,
    });
    const turn = {
      streamKey: 'mirror:session-runtime-notice:turn',
      userText: '继续任务',
      text: '任务输出',
      signature: 'runtime-notice-complete',
      timestamp: '2026-05-14T00:00:01.000Z',
      startedAt: '2026-05-14T00:00:00.000Z',
      status: 'completed' as const,
    };

    const result = await controller.deliverMirrorTurns(subscription, [turn]);

    assert.equal(result.deliveredCount, 1);
    assert.equal(turn.status, 'completed');
    assert.deepEqual(adapter.streamEnds.map((entry) => entry.status), ['completed']);
    assert.deepEqual(adapter.notices, [{
      level: 'error',
      title: '操作未完成',
      message: 'goal 更新失败\n当前任务仍在继续。',
      source: 'codex_tui',
    }]);
  });

  it('falls back to an inline quote when the channel has no runtime notice interface', async () => {
    const adapter = new FakeMirrorFeishuAdapter();
    (adapter as { onRuntimeNotice?: unknown }).onRuntimeNotice = undefined;
    const controller = createMirrorFeedbackController({
      getAdapter: () => adapter,
      getThreadTitle: () => '测试线程',
      resolveFinalizedTurnStatus: async (_subscription, turn) => {
        turn.runtimeNotices = [{
          level: 'error',
          title: '操作未完成',
          message: 'goal 更新失败\n当前任务仍在继续。',
          source: 'codex_tui',
        }];
        return turn.status;
      },
      nowIso: () => '2026-05-14T00:00:00.000Z',
      eventBatchLimit: 10,
      deliverResponse: async () => ({ ok: true }),
    });
    const subscription = createMirrorSubscription({
      bindingId: 'binding-runtime-notice-fallback',
      sessionId: 'session-runtime-notice-fallback',
      channelType: 'feishu-default',
      chatId: 'chat-runtime-notice-fallback',
      threadId: 'thread-runtime-notice-fallback',
      filePath: 'rollout.jsonl',
      lastDeliveredAt: null,
    });

    const result = await controller.deliverMirrorTurns(subscription, [{
      streamKey: 'mirror:session-runtime-notice-fallback:turn',
      userText: '继续任务',
      text: '任务输出',
      signature: 'runtime-notice-fallback',
      timestamp: '2026-05-14T00:00:01.000Z',
      startedAt: '2026-05-14T00:00:00.000Z',
      status: 'completed',
    }]);

    assert.equal(result.deliveredCount, 1);
    assert.equal(adapter.streamEnds[0]?.status, 'completed');
    assert.match(adapter.streamEnds[0]?.text || '', /> ⚠️ \*\*操作未完成\*\*/u);
    assert.match(adapter.streamEnds[0]?.text || '', /> goal 更新失败/u);
    assert.match(adapter.streamEnds[0]?.text || '', /> 当前任务仍在继续。/u);
  });

  it('keeps terminal error status single-line and bounded', () => {
    const formatted = formatMirrorTerminalErrorStatus(JSON.stringify({
      error: {
        type: 'invalid_request_error',
        message: `first line\n${'x'.repeat(1_000)}`,
      },
    }));

    assert.match(formatted, /^❌ invalid_request_error · first line /);
    assert.equal(formatted.includes('\n'), false);
    assert.equal(Array.from(formatted).length, 600);
    assert.ok(formatted.endsWith('…'));
  });

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

  it('never exposes final-only artifact protocol blocks in mirror card history', () => {
    const adapter = new FakeMirrorFeishuAdapter();
    const controller = createMirrorFeedbackController({
      getAdapter: () => adapter,
      getThreadTitle: () => '测试线程',
      nowIso: () => '2026-05-14T00:00:00.000Z',
      eventBatchLimit: 10,
      deliverResponse: async () => ({ ok: true }),
    });
    const subscription = createMirrorSubscription({
      bindingId: 'binding-artifact-history',
      sessionId: 'session-artifact-history',
      channelType: 'feishu-default',
      chatId: 'chat-artifact-history',
      threadId: 'thread-artifact-history',
      filePath: 'rollout.jsonl',
      lastDeliveredAt: null,
    });

    consumeMirrorRecords(subscription, [{
      signature: 'message-artifact-history',
      type: 'message',
      role: 'assistant',
      content: [
        '普通说明中的 `<clk-send>` 只是协议名称，必须完整显示。',
        '<clk-send>{"type":"file","path":"/tmp/visible.txt"}</clk-send>',
        '![本地图片](/tmp/visible.png)',
        '终态不重复。',
      ].join('\n'),
      timestamp: '2026-05-14T00:00:00.000Z',
      turnId: 'turn-artifact-history',
    }], controller.hooks);

    const renderedHistory = adapter.histories.at(-1) || [];
    const renderedText = renderedHistory
      .flatMap((item) => item.type === 'markdown' ? [item.content] : [])
      .join('\n');
    assert.match(renderedText, /普通说明中的 `<clk-send>` 只是协议名称，必须完整显示。/);
    assert.match(renderedText, /终态不重复。/);
    assert.doesNotMatch(renderedText, /visible\.txt/);
    assert.doesNotMatch(renderedText, /visible\.png/);
    assert.match(subscription.pendingTurn?.streamedText || '', /clk-send/);
  });

  it('waits for the real mirror card message before delivering an intermediate artifact', { timeout: 1_000 }, async () => {
    const adapter = new DelayedMirrorCardAdapter();
    const controller = createMirrorFeedbackController({
      getAdapter: () => adapter,
      getThreadTitle: () => '测试线程',
      nowIso: () => '2026-05-14T00:00:00.000Z',
      eventBatchLimit: 10,
      deliverResponse: async (_adapter, _address, _text, _sessionId, replyToMessageId, attachments) => {
        adapter.sent.push({
          address: { channelType: 'feishu-default', chatId: 'chat-delayed-card' },
          text: '',
          attachments,
          replyToMessageId,
        });
        return { ok: true };
      },
    });
    const subscription = createMirrorSubscription({
      bindingId: 'binding-delayed-card',
      sessionId: 'session-delayed-card',
      channelType: 'feishu-default',
      chatId: 'chat-delayed-card',
      threadId: 'thread-delayed-card',
      filePath: 'rollout.jsonl',
      lastDeliveredAt: null,
    });

    consumeMirrorRecords(subscription, [{
      signature: 'message-delayed-card',
      type: 'message',
      role: 'assistant',
      content: '![延迟图片](/tmp/delayed-card.png)',
      timestamp: '2026-05-14T00:00:01.000Z',
      turnId: 'turn-delayed-card',
    }], controller.hooks);

    await adapter.cardCreateStarted.promise;
    assert.equal(adapter.sent.length, 0);
    adapter.cardCreated.resolve();
    await _testOnlyWaitForDeliveryQueuesForTests(adapter);

    assert.equal(adapter.sent.length, 1);
    assert.equal(adapter.sent[0]?.replyToMessageId, 'delayed-mirror-card-message');
    assert.equal(adapter.sent[0]?.attachments?.[0]?.path, '/tmp/delayed-card.png');
  });

  it('replays stream metadata when a configured adapter is replaced mid-turn', () => {
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

    let adapter = new FakeMirrorFeishuAdapter();
    const firstAdapter = adapter;
    const baseMs = Date.parse('2026-05-14T00:00:00.000Z');
    const controller = createMirrorFeedbackController({
      getAdapter: () => adapter,
      getThreadTitle: () => 'Persistent title',
      nowIso: () => new Date(baseMs).toISOString(),
      eventBatchLimit: 10,
      deliverResponse: async () => ({ ok: true }),
    });
    const subscription = createMirrorSubscription({
      bindingId: 'binding-restart',
      sessionId: 'session-restart',
      channelType: 'feishu-default',
      chatId: 'chat-restart',
      threadId: 'thread-restart',
      filePath: 'rollout.jsonl',
      lastDeliveredAt: null,
    });

    consumeMirrorRecords(subscription, [{
      signature: 'message-before-restart',
      type: 'message',
      role: 'assistant',
      content: 'first chunk',
      timestamp: new Date(baseMs).toISOString(),
      turnId: 'turn-restart',
    }], controller.hooks);
    assert.equal(firstAdapter.metadata.length, 1);
    assert.equal(subscription.pendingTurn?.streamStarted, true);

    adapter = new FakeMirrorFeishuAdapter();
    consumeMirrorRecords(subscription, [{
      signature: 'message-after-restart',
      type: 'message',
      role: 'assistant',
      content: 'second chunk',
      timestamp: new Date(baseMs + 1_000).toISOString(),
      turnId: 'turn-restart',
    }], controller.hooks);

    assert.equal(adapter.metadata.length, 1);
    assert.equal(adapter.metadata[0]?.metadata.title, 'Persistent title');
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

      assert.equal(adapter.statuses.at(-1), `${formatFooterClockTime(15_000)} · 已运行 15s · 上次响应 0s`);
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

  it('delivers clk-send and clk-input side effects after mirror stream finalization', async () => {
    initBridgeContext({
      store: new JsonFileStore(new Map()),
      llm: {} as never,
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });
    const adapter = new FakeMirrorFeishuAdapter();
    const manualInputs: Array<{ sourceBindingId: string; target: OutboundManualInput['target']; text: string }> = [];
    const baseMs = Date.parse('2026-05-14T00:00:00.000Z');
    const controller = createMirrorFeedbackController({
      getAdapter: () => adapter,
      getThreadTitle: () => '测试线程',
      nowIso: () => new Date(baseMs).toISOString(),
      eventBatchLimit: 10,
      deliverResponse: async () => ({ ok: true }),
      deliverManualInput: async (sourceBindingId, input) => {
        manualInputs.push({ sourceBindingId, target: input.target, text: input.text });
      },
    });
    const subscription = createMirrorSubscription({
      bindingId: 'binding-source',
      sessionId: 'session-1',
      channelType: 'feishu-default',
      chatId: 'chat-1',
      threadId: 'thread-1',
      filePath: 'rollout.jsonl',
      lastDeliveredAt: null,
    });
    const finalized = consumeMirrorRecords(subscription, [{
      signature: 'complete-side-effects',
      type: 'task_complete',
      content: [
        '<clk-send>{"msg_type":"text","content":{"text":"mirror hello"}}</clk-send>',
        '<clk-input>{"target":"target-chat","text":"/stop"}</clk-input>',
      ].join('\n'),
      timestamp: new Date(baseMs).toISOString(),
      turnId: 'turn-1',
    }], controller.hooks);

    await controller.deliverMirrorTurns(subscription, finalized);

    assert.equal(adapter.streamEnds[0]?.status, 'completed');
    assert.doesNotMatch(adapter.streamEnds[0]?.text || '', /clk-send|clk-input/u);
    assert.deepEqual(adapter.sent.map((message) => message.platformMessage).filter(Boolean), [{
      msgType: 'text',
      content: { text: 'mirror hello' },
    }]);
    assert.deepEqual(manualInputs, [{ sourceBindingId: 'binding-source', target: 'target-chat', text: '/stop' }]);
  });

  it('does not replay earlier mirror side effects when a later action fails', async () => {
    initBridgeContext({
      store: new JsonFileStore(new Map()),
      llm: {} as never,
      permissions: { resolvePendingPermission: () => false },
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
      deliverManualInput: async () => { throw new Error('target bridge offline'); },
    });
    const subscription = createMirrorSubscription({
      bindingId: 'binding-source',
      sessionId: 'session-1',
      channelType: 'feishu-default',
      chatId: 'chat-1',
      threadId: 'thread-1',
      filePath: 'rollout.jsonl',
      lastDeliveredAt: null,
    });
    const finalized = consumeMirrorRecords(subscription, [{
      signature: 'complete-partial-failure',
      type: 'task_complete',
      content: [
        '<clk-send>{"msg_type":"text","content":{"text":"send once"}}</clk-send>',
        '<clk-input>{"target":"offline-target","text":"hello"}</clk-input>',
      ].join('\n'),
      timestamp: new Date(baseMs).toISOString(),
      turnId: 'turn-1',
    }], controller.hooks);

    await controller.deliverMirrorTurns(subscription, finalized);

    assert.equal(adapter.sent.filter((message) => message.platformMessage).length, 1);
    assert.equal(subscription.lastDeliveredAt, new Date(baseMs).toISOString());
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
