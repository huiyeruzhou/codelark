import '../../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { initBridgeContext } from '../../../../bridge/host/context.js';
import {
  finalizeStreamFeedback,
  pushStreamFeedbackActions,
} from '../../../../channels/delivery/stream-feedback.js';

describe('stream-feedback-controller', () => {
  it('stores action rows before starting structured stream UI', () => {
    const calls: string[] = [];
    const adapter = {
      onStreamActions() {
        calls.push('actions');
      },
    };

    const ok = pushStreamFeedbackActions({
      adapter: adapter as any,
      channelType: 'feishu',
      chatId: 'chat-1',
      streamKey: 'stream-1',
      ensureStarted() {
        calls.push('start');
      },
    }, [[{
      text: '停止',
      callbackData: 'clk-command:session-1:%2Fstop',
      type: 'danger',
    }]]);

    assert.equal(ok, true);
    assert.deepEqual(calls, ['actions', 'start']);
  });

  it('finalizes stream feedback through the adapter', async () => {
    initBridgeContext({
      store: {
        getSetting: () => null,
      } as never,
      llm: {} as never,
      permissions: {} as never,
      lifecycle: {},
    });
    const streamEnds: Array<{ status: 'completed' | 'interrupted' | 'error'; text: string; streamKey?: string }> = [];
    const adapter = {
      onStreamEnd(
        _chatId: string,
        status: 'completed' | 'interrupted' | 'error',
        responseText: string,
        streamKey?: string,
      ): Promise<boolean> {
        streamEnds.push({ status, text: responseText, streamKey });
        return Promise.resolve(true);
      },
    };

    try {
      const finalized = await finalizeStreamFeedback(
        {
          adapter: adapter as any,
          channelType: 'feishu-default',
          chatId: 'chat-1',
          streamKey: 'stream-1',
        },
        'completed',
        '最终回复',
      );

      assert.equal(finalized, true);
      assert.deepEqual(streamEnds, [{
        status: 'completed',
        text: '最终回复',
        streamKey: 'stream-1',
      }]);
    } finally {
      delete (globalThis as Record<string, unknown>).__bridge_context__;
    }
  });
});
