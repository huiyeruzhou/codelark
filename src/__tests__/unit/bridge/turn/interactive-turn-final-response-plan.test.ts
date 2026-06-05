import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildExternalTerminalFinalResponsePlan,
  buildProcessFinalResponsePlan,
} from '../../../../bridge/turn/interactive/final-response-plan.js';

describe('interactive-turn final-response-plan', () => {
  it('uses stale binding notices as the delivered response for external terminal completion', () => {
    const plan = buildExternalTerminalFinalResponsePlan({
      terminal: {
        outcome: 'completed',
        detail: 'done',
        finalText: 'Codex final',
      },
      staleTaskNotice: '旧会话任务已结束，回复已跳过。',
      aborted: false,
      formatErrorCard: (message) => `ERR:${message}`,
    });

    assert.equal(plan.streamEndStatus, 'completed');
    assert.equal(plan.cardText, '旧会话任务已结束，回复已跳过。');
    assert.equal(plan.deliveryResponse?.text, '旧会话任务已结束，回复已跳过。');
    assert.equal(plan.skipTextWhenCardFinalized, true);
  });

  it('merges Codex terminal final text with SDK attachments after the SDK result settles', () => {
    const plan = buildProcessFinalResponsePlan({
      result: {
        responseText: 'SDK final',
        outboundAttachments: [{ kind: 'file', path: 'D:\\work\\sdk.txt' }],
        hasError: false,
        errorMessage: '',
      },
      terminal: {
        outcome: 'completed',
        detail: 'done',
        finalText: 'Codex final',
      },
      aborted: false,
      formatErrorCard: (message) => `ERR:${message}`,
    });

    assert.equal(plan.streamEndStatus, 'completed');
    assert.equal(plan.cardText, 'Codex final');
    assert.equal(plan.deliveryResponse?.text, 'Codex final');
    assert.deepEqual(plan.deliveryResponse?.attachments, [
      { kind: 'file', path: 'D:\\work\\sdk.txt' },
    ]);
  });

  it('keeps fallback SDK errors deliverable even if a stream card finalizes', () => {
    const plan = buildProcessFinalResponsePlan({
      result: {
        responseText: '',
        outboundAttachments: [],
        hasError: true,
        errorMessage: 'boom',
      },
      terminal: null,
      aborted: false,
      formatErrorCard: (message) => `ERR:${message}`,
    });

    assert.equal(plan.streamEndStatus, 'error');
    assert.equal(plan.cardText, 'ERR:boom');
    assert.equal(plan.deliveryResponse?.text, 'ERR:boom');
    assert.equal(plan.skipTextWhenCardFinalized, false);
  });

  it('does not deliver an interrupted empty response', () => {
    const plan = buildProcessFinalResponsePlan({
      result: {
        responseText: '',
        outboundAttachments: [],
        hasError: false,
        errorMessage: '',
      },
      terminal: { outcome: 'aborted', detail: 'stopped' },
      aborted: true,
      formatErrorCard: (message) => `ERR:${message}`,
    });

    assert.equal(plan.streamEndStatus, 'interrupted');
    assert.equal(plan.cardText, '');
    assert.equal(plan.deliveryResponse, null);
  });
});
