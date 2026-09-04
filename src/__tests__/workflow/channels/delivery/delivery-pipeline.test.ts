import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { BaseChannelAdapter } from '../../../../channels/contracts.js';
import { FeishuAdapter } from '../../../../channels/feishu/adapter.js';
import { initBridgeContext } from '../../../../bridge/host/context.js';
import {
  _testOnlyResetDeliveryQueuesForTests,
  _testOnlyResetDeliveryRateLimiterForTests,
  deliver,
} from '../../../../channels/delivery/deliver.js';
import { enqueueBridgeNotice } from '../../../../channels/delivery/feedback.js';
import {
  deliverFinalResponse,
} from '../../../../bridge/turn/delivery-pipeline.js';
import { assembleSdkFinalResponse } from '../../../../bridge/turn/response-assembler.js';
import type { InboundMessage, OutboundMessage, SendResult } from '../../../../domain/index.js';

class FakeAdapter extends BaseChannelAdapter {
  readonly channelType = 'feishu-default';
  readonly provider = 'feishu';

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  isRunning(): boolean { return true; }
  consumeOne(): Promise<InboundMessage | null> { return Promise.resolve(null); }
  async send(_message: OutboundMessage): Promise<SendResult> { return { ok: true }; }
  validateConfig(): string | null { return null; }
  isAuthorized(): boolean { return true; }

}

describe('delivery-pipeline', () => {
  beforeEach(() => {
    initBridgeContext({
      store: {
        getSetting: () => null,
      } as never,
      llm: {} as never,
      permissions: {} as never,
      lifecycle: {},
    });
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__bridge_context__;
    _testOnlyResetDeliveryQueuesForTests();
    _testOnlyResetDeliveryRateLimiterForTests();
  });

  it('queues same-chat notices without making enqueue wait for remote ACK', async () => {
    const adapter = new FakeAdapter();
    const firstAck = new Promise<SendResult>((resolve) => {
      (adapter as any).resolveFirstAck = resolve;
    });
    const sent: string[] = [];
    adapter.send = async (message: OutboundMessage): Promise<SendResult> => {
      sent.push(message.text);
      if (sent.length === 1) return firstAck;
      return { ok: true, messageId: `message-${sent.length}` };
    };
    const address = { channelType: 'feishu-default', chatId: 'chat-queued-notices' } as const;

    const first = enqueueBridgeNotice(adapter, address, 'first');
    const second = enqueueBridgeNotice(adapter, address, 'second');
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(sent, ['first']);

    (adapter as any).resolveFirstAck({ ok: true, messageId: 'message-1' });
    assert.equal((await first.completion).messageId, 'message-1');
    assert.equal((await second.completion).messageId, 'message-2');
    assert.deepEqual(sent, ['first', 'second']);
  });

  it('does not let a slow ordinary ACK block an interactive card', async () => {
    const adapter = new FakeAdapter();
    let resolveOrdinary!: (result: SendResult) => void;
    const ordinaryAck = new Promise<SendResult>((resolve) => { resolveOrdinary = resolve; });
    const sent: OutboundMessage[] = [];
    adapter.send = async (message: OutboundMessage): Promise<SendResult> => {
      sent.push(message);
      return message.richCard
        ? { ok: true, messageId: 'interactive-card' }
        : ordinaryAck;
    };
    const address = { channelType: 'feishu-default', chatId: 'chat-priority-notices' } as const;

    const ordinary = enqueueBridgeNotice(adapter, address, 'ordinary');
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(sent.map((message) => message.text), ['ordinary']);
    const interactive = enqueueBridgeNotice(adapter, address, 'choose', {
      richCard: { title: 'Choose', sections: [{ markdown: 'choose' }] },
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(sent.map((message) => message.text), ['ordinary', 'choose']);
    assert.equal((await interactive.completion).messageId, 'interactive-card');
    resolveOrdinary({ ok: true, messageId: 'ordinary-message' });
    assert.equal((await ordinary.completion).messageId, 'ordinary-message');
  });

  it('skips text after card finalization but still delivers attachments', async () => {
    const adapter = new FakeAdapter();
    const calls: Array<{ text: string; attachmentCount: number }> = [];
    const response = assembleSdkFinalResponse({
      text: '正文',
      attachments: [{ kind: 'image', path: 'D:\\work\\out.png' }],
    });

    const result = await deliverFinalResponse({
      adapter,
      address: { channelType: 'feishu-default', chatId: 'chat-1' },
      sessionId: 'session-1',
      deliverResponse: async (_adapter, _address, text, _sessionId, _replyTo, attachments = []) => {
        calls.push({ text, attachmentCount: attachments.length });
        return { ok: true };
      },
    }, response, { skipText: true });

    assert.equal(result.ok, true);
    assert.deepEqual(calls, [{ text: '', attachmentCount: 1 }]);
  });

  it('reports an attachment upload failure to the source chat', async () => {
    const adapter = new FakeAdapter();
    const sent: OutboundMessage[] = [];
    adapter.send = async (message: OutboundMessage): Promise<SendResult> => {
      sent.push(message);
      return { ok: true, messageId: 'error-notice-1' };
    };
    const response = assembleSdkFinalResponse({
      attachments: [{ kind: 'image', path: '/tmp/missing-qr.png', caption: '登录二维码' }],
    });

    const result = await deliverFinalResponse({
      adapter,
      address: { channelType: 'feishu-default', chatId: 'chat-1' },
      sessionId: 'session-1',
      replyToMessageId: 'stream-card-1',
      deliverResponse: async () => ({ ok: false, error: 'Attachment not found' }),
    }, response, { skipText: true });

    assert.equal(result.ok, false);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.replyToMessageId, 'stream-card-1');
    assert.match(sent[0]?.text || '', /附件发送失败（missing-qr\.png）：Attachment not found/u);
  });

  it('can suppress an intermediate attachment error before the final retry', async () => {
    const adapter = new FakeAdapter();
    const sent: OutboundMessage[] = [];
    adapter.send = async (message: OutboundMessage): Promise<SendResult> => {
      sent.push(message);
      return { ok: true };
    };
    const response = assembleSdkFinalResponse({
      attachments: [{ kind: 'image', path: '/tmp/retry-qr.png' }],
    });

    const result = await deliverFinalResponse({
      adapter,
      address: { channelType: 'feishu-default', chatId: 'chat-1' },
      sessionId: 'session-1',
      deliverResponse: async () => ({ ok: false, error: 'temporary upload failure' }),
    }, response, { skipText: true, reportAttachmentErrors: false });

    assert.equal(result.ok, false);
    assert.deepEqual(sent, []);
  });

  it('delivers official Feishu payloads and manual inputs as separate final actions', async () => {
    const adapter = new FakeAdapter();
    const sent: OutboundMessage[] = [];
    const inputs: unknown[] = [];
    adapter.send = async (message) => {
      sent.push(message);
      return { ok: true, messageId: `message-${sent.length}` };
    };
    const response = assembleSdkFinalResponse({
      text: [
        '<clk-send>{"msg_type":"text","content":{"text":"<at user_id=\\"ou_x\\">X</at> hello"}}</clk-send>',
        '<clk-input>{"target":"target-chat","text":"/stop"}</clk-input>',
      ].join('\n'),
    });

    const result = await deliverFinalResponse({
      adapter,
      address: { channelType: 'feishu-default', chatId: 'chat-source' },
      sessionId: 'session-source',
      deliverManualInput: async (input) => { inputs.push(input); },
    }, response);

    assert.equal(result.ok, true);
    assert.deepEqual(sent.map((message) => message.platformMessage), [{
      msgType: 'text',
      content: { text: '<at user_id="ou_x">X</at> hello' },
    }]);
    assert.deepEqual(inputs, [{ target: 'target-chat', text: '/stop' }]);
  });

  it('reports a structured Feishu send failure back to the source chat', async () => {
    const adapter = new FakeAdapter();
    const sent: OutboundMessage[] = [];
    adapter.send = async (message) => {
      sent.push(message);
      if (message.platformMessage) {
        return { ok: false, error: 'code=230001; msg=invalid message; log_id=log-1' };
      }
      return { ok: true, messageId: 'diagnostic-message' };
    };
    const response = assembleSdkFinalResponse({
      text: '<clk-send>{"msg_type":"text","content":{"text":"hello"}}</clk-send>',
    });

    const result = await deliverFinalResponse({
      adapter,
      address: { channelType: 'feishu-default', chatId: 'chat-source' },
      sessionId: 'session-source',
    }, response);

    assert.equal(result.ok, false);
    assert.match(result.error || '', /code=230001/u);
    assert.equal(sent.length, 4);
    assert.equal(sent.slice(0, 3).every((message) => message.platformMessage?.msgType === 'text'), true);
    assert.deepEqual(sent[0]?.platformMessage, { msgType: 'text', content: { text: 'hello' } });
    assert.match(sent[3]?.text || '', /飞书消息发送失败：code=230001; msg=invalid message; log_id=log-1/u);
  });

  it('uses a custom text delivery path before sending attachments', async () => {
    const adapter = new FakeAdapter();
    const calls: string[] = [];
    const response = assembleSdkFinalResponse({
      text: '镜像正文',
      attachments: [{ kind: 'file', path: 'D:\\work\\report.pdf' }],
    });

    const result = await deliverFinalResponse({
      adapter,
      address: { channelType: 'feishu-default', chatId: 'chat-1' },
      sessionId: 'session-1',
      deliverText: async (text) => {
        calls.push(`text:${text}`);
        return { ok: true };
      },
      deliverResponse: async (_adapter, _address, text, _sessionId, _replyTo, attachments = []) => {
        calls.push(`attachments:${text}:${attachments.length}`);
        return { ok: true };
      },
    }, response);

    assert.equal(result.ok, true);
    assert.deepEqual(calls, ['text:镜像正文', 'attachments::1']);
  });

  it('sends question cards after final text', async () => {
    const adapter = new FakeAdapter();
    const sent: OutboundMessage[] = [];
    adapter.send = async (message: OutboundMessage): Promise<SendResult> => {
      sent.push(message);
      return { ok: true };
    };
    const calls: string[] = [];
    const response = assembleSdkFinalResponse({
      text: [
        '需要确认。',
        '<clk-ask>{"question":"选哪个环境？","options":["测试","生产"]}</clk-ask>',
      ].join('\n'),
    });

    const result = await deliverFinalResponse({
      adapter,
      address: { channelType: 'feishu-default', chatId: 'chat-1' },
      sessionId: 'session-1',
      deliverResponse: async (_adapter, _address, text) => {
        calls.push(text);
        return { ok: true };
      },
    }, response);

    assert.equal(result.ok, true);
    assert.deepEqual(calls, ['需要确认。']);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].richCard?.title, '需要确认');
    assert.equal(sent[0].richCard?.actions?.[0]?.length, 2);
    assert.match(sent[0].richCard?.actions?.[0]?.[0]?.callbackData || '', /^clk-agent-question:/);
  });

  it('sends question forms when the ask payload includes an input', async () => {
    const adapter = new FakeAdapter();
    const sent: OutboundMessage[] = [];
    adapter.send = async (message: OutboundMessage): Promise<SendResult> => {
      sent.push(message);
      return { ok: true };
    };
    const response = assembleSdkFinalResponse({
      text: [
        '需要确认。',
        '<clk-ask>{"question":"请选择发布策略","options":["灰度","全量"],"input":{"label":"补充说明","placeholder":"可留空"},"submitText":"提交"}</clk-ask>',
      ].join('\n'),
    });

    const result = await deliverFinalResponse({
      adapter,
      address: { channelType: 'feishu-default', chatId: 'chat-1' },
      sessionId: 'session-1',
      deliverResponse: async () => ({ ok: true }),
    }, response);

    assert.equal(result.ok, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].richCard?.form?.optionElementId, 'clk_choice');
    assert.equal(sent[0].richCard?.form?.inputElementId, 'clk_input');
    assert.equal(sent[0].richCard?.form?.inputLabel, '补充说明');
    assert.equal(sent[0].richCard?.form?.options.length, 2);
    assert.equal(sent[0].richCard?.actions, undefined);
  });

  it('renders question form cards through FeishuAdapter interactive payloads', async () => {
    const messageReplyCalls: Array<Record<string, any>> = [];
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
      },
    });
    (adapter as any).restClient = {
      im: {
        message: {
          reply: async (payload: Record<string, any>) => {
            messageReplyCalls.push(payload);
            return { data: { message_id: 'question-card-1' } };
          },
          create: async () => {
            throw new Error('question card should reply to the source message');
          },
        },
      },
    };
    const response = assembleSdkFinalResponse({
      text: [
        '需要确认。',
        '<clk-ask>{"question":"请选择发布策略","options":["灰度","全量"],"input":{"label":"补充说明","placeholder":"可留空"},"submitText":"提交"}</clk-ask>',
      ].join('\n'),
    });

    const result = await deliverFinalResponse({
      adapter,
      address: { channelType: 'feishu-default', chatId: 'chat-1' },
      sessionId: 'session-1',
      replyToMessageId: 'source-message-1',
      deliverResponse: async () => ({ ok: true }),
    }, response);

    assert.equal(result.ok, true);
    assert.equal(result.messageId, 'question-card-1');
    assert.equal(messageReplyCalls.length, 1);
    assert.deepEqual(messageReplyCalls[0]?.path, { message_id: 'source-message-1' });
    assert.equal(messageReplyCalls[0]?.data?.msg_type, 'interactive');

    const card = JSON.parse(messageReplyCalls[0]?.data?.content) as any;
    const elements = JSON.stringify(card.body.elements);
    const form = card.body.elements.find((element: any) => element.tag === 'form');
    const select = form.elements.find((element: any) => element.tag === 'select_static');
    const input = form.elements.find((element: any) => element.tag === 'input');
    assert.equal(form.name, 'clk_form');
    assert.equal(select.name, 'clk_choice');
    assert.equal(input.name, 'clk_input');
    assert.match(elements, /clk-agent-question:/);
    assert.match(elements, /"chatId":"chat-1"/);
    assert.match(elements, /"form_action_type":"submit"/);
  });

  it('routes cloud document responses through comment reply delivery', async () => {
    const adapter = new FakeAdapter();
    const commentReplies: string[] = [];
    const imMessages: OutboundMessage[] = [];
    adapter.send = async (message: OutboundMessage): Promise<SendResult> => {
      imMessages.push(message);
      return { ok: true };
    };
    adapter.sendCloudDocumentReply = async (_target, text): Promise<SendResult> => {
      commentReplies.push(text);
      return { ok: true };
    };
    const response = assembleSdkFinalResponse({
      text: '文档里的回答',
    });

    const result = await deliverFinalResponse({
      adapter,
      address: {
        channelType: 'feishu-default',
        chatId: 'doc:docx:token-1',
        cloudDocument: {
          provider: 'feishu',
          fileToken: 'token-1',
          fileType: 'docx',
          commentId: 'comment-1',
        },
      },
      sessionId: 'session-1',
    }, response);

    assert.equal(result.ok, true);
    assert.deepEqual(commentReplies, ['文档里的回答']);
    assert.deepEqual(imMessages, []);
  });

  it('mentions unsupported attachments in cloud document comment replies', async () => {
    const adapter = new FakeAdapter();
    const commentReplies: string[] = [];
    adapter.sendCloudDocumentReply = async (_target, text): Promise<SendResult> => {
      commentReplies.push(text);
      return { ok: true };
    };
    const response = assembleSdkFinalResponse({
      text: '文档里的回答',
      attachments: [{ kind: 'file', path: '/tmp/report.pdf' }],
    });

    const result = await deliverFinalResponse({
      adapter,
      address: {
        channelType: 'feishu-default',
        chatId: 'doc:docx:token-1',
        cloudDocument: {
          provider: 'feishu',
          fileToken: 'token-1',
          fileType: 'docx',
          commentId: 'comment-1',
        },
      },
      sessionId: 'session-1',
    }, response);

    assert.equal(result.ok, true);
    assert.equal(commentReplies.length, 1);
    assert.match(commentReplies[0], /已省略 1 个附件/);
  });

  it('routes direct delivery for cloud document addresses through comment replies', async () => {
    const adapter = new FakeAdapter();
    const commentReplies: string[] = [];
    const imMessages: OutboundMessage[] = [];
    adapter.send = async (message: OutboundMessage): Promise<SendResult> => {
      imMessages.push(message);
      return { ok: true };
    };
    adapter.sendCloudDocumentReply = async (_target, text): Promise<SendResult> => {
      commentReplies.push(text);
      return { ok: true, messageId: 'doc-comment:token-1:comment-1:reply-2' };
    };

    const result = await deliver(adapter, {
      address: {
        channelType: 'feishu-default',
        chatId: 'doc:docx:token-1',
        cloudDocument: {
          provider: 'feishu',
          fileToken: 'token-1',
          fileType: 'docx',
          commentId: 'comment-1',
        },
      },
      text: '普通发送入口的回答',
      parseMode: 'Markdown',
      replyToMessageId: 'doc-comment:token-1:comment-1:reply-1',
    });

    assert.equal(result.ok, true);
    assert.equal(result.messageId, 'doc-comment:token-1:comment-1:reply-2');
    assert.deepEqual(commentReplies, ['普通发送入口的回答']);
    assert.deepEqual(imMessages, []);
  });

  it('logs delivery sends as structured perf events', async () => {
    const adapter = new FakeAdapter();
    const logs: unknown[][] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args); };
    adapter.send = async (): Promise<SendResult> => ({ ok: true, messageId: 'msg-perf-1' });

    try {
      const result = await deliver(adapter, {
        address: { channelType: 'feishu-default', chatId: 'chat-perf-log' },
        text: 'hello',
      }, { audit: false, sessionId: 'session-perf-log' });

      assert.equal(result.ok, true);
    } finally {
      console.log = originalLog;
    }

    const event = logs.find((entry) => entry[0] === '[delivery] Delivery send:')?.[1] as any;
    assert.equal(event?.event, 'perf.delivery.send');
    assert.equal(event?.status, 'success');
    assert.equal(event?.channel, 'feishu-default');
    assert.equal(event?.chat, 'chat-perf-log');
    assert.equal(event?.kind, 'response');
    assert.equal(event?.message_id, 'msg-perf-1');
    assert.equal(typeof event?.duration_ms, 'number');
    assert.equal(event?.session_id, 'session-perf-log');
    assert.equal(Object.hasOwn(event, 'durationMs'), false);
    assert.equal(Object.hasOwn(event, 'channelType'), false);
    assert.equal(Object.hasOwn(event, 'chatId'), false);
    assert.equal(Object.hasOwn(event, 'ok'), false);
  });

  it('does not retry cloud document comment client errors', async () => {
    const adapter = new FakeAdapter();
    let attempts = 0;
    adapter.sendCloudDocumentReply = async (): Promise<SendResult> => {
      attempts += 1;
      return { ok: false, error: 'code=1069302; msg=Invalid or missing parameters', httpStatus: 400 };
    };

    const result = await deliver(adapter, {
      address: {
        channelType: 'feishu-default',
        chatId: 'doc:docx:token-1',
        cloudDocument: {
          provider: 'feishu',
          fileToken: 'token-1',
          fileType: 'docx',
          commentId: 'comment-1',
        },
      },
      text: '普通发送入口的回答',
      parseMode: 'Markdown',
    });

    assert.equal(result.ok, false);
    assert.equal(result.httpStatus, 400);
    assert.equal(attempts, 1);
  });

  it('logs local outbound rate-limit waits for ordinary messages', async () => {
    const adapter = new FakeAdapter();
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    const previousDisabled = process.env.CODELARK_DISABLE_OUTBOUND_RATE_LIMIT;
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    delete process.env.CODELARK_DISABLE_OUTBOUND_RATE_LIMIT;
    _testOnlyResetDeliveryRateLimiterForTests({ maxMessages: 1, windowMs: 3_100 });

    try {
      await deliver(adapter, {
        address: { channelType: 'feishu-default', chatId: 'chat-rate-limit-log' },
        text: 'first',
      }, { audit: false });
      await deliver(adapter, {
        address: { channelType: 'feishu-default', chatId: 'chat-rate-limit-log' },
        text: 'second',
      }, { audit: false });
    } finally {
      console.warn = originalWarn;
      if (previousDisabled === undefined) delete process.env.CODELARK_DISABLE_OUTBOUND_RATE_LIMIT;
      else process.env.CODELARK_DISABLE_OUTBOUND_RATE_LIMIT = previousDisabled;
    }

    assert.equal(
      warnings.some((args) => String(args[0]).includes('Outbound rate limiter delayed message')),
      true,
    );
    assert.equal(
      warnings.some((args) => String(args[0]).includes('Outbound rate limiter will delay message')),
      true,
    );
    const waitEvent = warnings.find((args) => String(args[0]).includes('Outbound rate limiter delayed message'))?.[1] as any;
    assert.equal(waitEvent?.channel, 'feishu-default');
    assert.equal(waitEvent?.chat, 'chat-rate-limit-log');
    assert.equal(typeof waitEvent?.wait_ms, 'number');
    assert.equal(Object.hasOwn(waitEvent, 'channelType'), false);
    assert.equal(Object.hasOwn(waitEvent, 'waitMs'), false);
  });

  it('sends a high-priority notice when ordinary messages are locally rate limited', async () => {
    const adapter = new FakeAdapter();
    const sent: OutboundMessage[] = [];
    adapter.send = async (message: OutboundMessage): Promise<SendResult> => {
      sent.push(message);
      return { ok: true, messageId: `msg-${sent.length}` };
    };
    const previousDisabled = process.env.CODELARK_DISABLE_OUTBOUND_RATE_LIMIT;
    delete process.env.CODELARK_DISABLE_OUTBOUND_RATE_LIMIT;
    _testOnlyResetDeliveryRateLimiterForTests({ maxMessages: 1, windowMs: 3_100 });

    try {
      await deliver(adapter, {
        address: { channelType: 'feishu-default', chatId: 'chat-rate-limit-notice' },
        text: 'first',
      }, { audit: false, sessionId: 'session-rate-limit' });
      await deliver(adapter, {
        address: { channelType: 'feishu-default', chatId: 'chat-rate-limit-notice' },
        text: 'second',
      }, { audit: false, sessionId: 'session-rate-limit' });
    } finally {
      if (previousDisabled === undefined) delete process.env.CODELARK_DISABLE_OUTBOUND_RATE_LIMIT;
      else process.env.CODELARK_DISABLE_OUTBOUND_RATE_LIMIT = previousDisabled;
    }

    assert.equal(sent.length, 3);
    assert.match(sent[1].text, /普通消息发送过快/);
    assert.match(sent[1].text, /确认卡、按钮和选择卡会优先发送/);
    assert.equal(sent[2].text, 'second');
  });

  it('lets rich cards bypass the ordinary outbound rate limiter', async () => {
    const adapter = new FakeAdapter();
    const sent: OutboundMessage[] = [];
    adapter.send = async (message: OutboundMessage): Promise<SendResult> => {
      sent.push(message);
      return { ok: true, messageId: `msg-${sent.length}` };
    };
    const previousDisabled = process.env.CODELARK_DISABLE_OUTBOUND_RATE_LIMIT;
    delete process.env.CODELARK_DISABLE_OUTBOUND_RATE_LIMIT;
    _testOnlyResetDeliveryRateLimiterForTests({ maxMessages: 1, windowMs: 5_000 });

    try {
      await deliver(adapter, {
        address: { channelType: 'feishu-default', chatId: 'chat-rich-card-bypass' },
        text: 'ordinary',
      }, { audit: false });
      const startedAt = Date.now();
      const result = await deliver(adapter, {
        address: { channelType: 'feishu-default', chatId: 'chat-rich-card-bypass' },
        text: 'choose',
        richCard: {
          title: '需要确认',
          sections: [{ markdown: 'choose' }],
        },
      }, { audit: false });
      assert.equal(result.ok, true);
      assert.equal(Date.now() - startedAt < 100, true);
    } finally {
      if (previousDisabled === undefined) delete process.env.CODELARK_DISABLE_OUTBOUND_RATE_LIMIT;
      else process.env.CODELARK_DISABLE_OUTBOUND_RATE_LIMIT = previousDisabled;
    }

    assert.equal(sent.length, 2);
    assert.equal(sent[1].richCard?.title, '需要确认');
  });

  it('does not retry remote rate-limit responses from IM sends', async () => {
    const adapter = new FakeAdapter();
    let attempts = 0;
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    adapter.send = async (): Promise<SendResult> => {
      attempts += 1;
      return { ok: false, error: 'too many requests', httpStatus: 429 };
    };

    try {
      const result = await deliver(adapter, {
        address: { channelType: 'feishu-default', chatId: 'chat-remote-rate-limit' },
        text: 'hello',
      }, { audit: false });
      assert.equal(result.ok, false);
      assert.equal(result.httpStatus, 429);
      assert.equal(attempts, 1);
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(
      warnings.some((args) => String(args[0]).includes('Remote rate-limit response; not retrying locally')),
      true,
    );
    const rateLimitEvent = warnings.find((args) => (
      String(args[0]).includes('Remote rate-limit response; not retrying locally')
    ))?.[1] as any;
    assert.equal(rateLimitEvent?.http_status, 429);
    assert.equal(Object.hasOwn(rateLimitEvent, 'httpStatus'), false);
  });

  it('does not send attachments through IM for direct cloud document delivery', async () => {
    const adapter = new FakeAdapter();
    const commentReplies: string[] = [];
    const imMessages: OutboundMessage[] = [];
    adapter.send = async (message: OutboundMessage): Promise<SendResult> => {
      imMessages.push(message);
      return { ok: true };
    };
    adapter.sendCloudDocumentReply = async (_target, text): Promise<SendResult> => {
      commentReplies.push(text);
      return { ok: true };
    };

    const result = await deliver(adapter, {
      address: {
        channelType: 'feishu-default',
        chatId: 'doc:docx:token-1',
        cloudDocument: {
          provider: 'feishu',
          fileToken: 'token-1',
          fileType: 'docx',
          commentId: 'comment-1',
        },
      },
      text: '',
      attachments: [{ kind: 'file', path: '/tmp/report.pdf' }],
      replyToMessageId: 'doc-comment:token-1:comment-1:reply-1',
    });

    assert.equal(result.ok, true);
    assert.equal(commentReplies.length, 1);
    assert.match(commentReplies[0], /已省略 1 个附件/);
    assert.deepEqual(imMessages, []);
  });
});
