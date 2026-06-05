import '../../setup/test-setup.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BaseChannelAdapter } from '../../../channels/contracts.js';
import type { ChannelType, InboundMessage, OutboundMessage, SendResult } from '../../../domain/index.js';

class DummyAdapter extends BaseChannelAdapter {
  readonly channelType: ChannelType = 'feishu-default';
  readonly provider = 'dummy';
  private running = false;

  async start(): Promise<void> {
    this.running = true;
  }

  async stop(): Promise<void> {
    this.running = false;
    this.clearInboundQueue();
    this.rejectPendingInboundConsumers();
  }

  isRunning(): boolean {
    return this.running;
  }

  consumeOne(): Promise<InboundMessage | null> {
    return this.consumeInboundMessage(this.running);
  }

  async send(_message: OutboundMessage): Promise<SendResult> {
    return { ok: true };
  }

  validateConfig(): string | null {
    return null;
  }

  isAuthorized(_userId: string, _chatId: string): boolean {
    return true;
  }

  push(message: InboundMessage): void {
    this.enqueueInboundMessage(message);
  }
}

describe('BaseChannelAdapter queue helpers', () => {
  it('delivers queued messages in order', async () => {
    const adapter = new DummyAdapter();
    await adapter.start();

    adapter.push({
      address: { channelType: 'feishu-default', chatId: 'chat-1' },
      messageId: 'msg-1',
      text: 'first',
      timestamp: Date.now(),
    });
    adapter.push({
      address: { channelType: 'feishu-default', chatId: 'chat-1' },
      messageId: 'msg-2',
      text: 'second',
      timestamp: Date.now() + 1,
    });

    assert.equal((await adapter.consumeOne())?.text, 'first');
    assert.equal((await adapter.consumeOne())?.text, 'second');
  });

  it('wakes pending consumers with null on stop', async () => {
    const adapter = new DummyAdapter();
    await adapter.start();

    const pending = adapter.consumeOne();
    await adapter.stop();

    assert.equal(await pending, null);
  });
});
