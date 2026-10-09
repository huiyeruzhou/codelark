import '../../../setup/test-setup.js';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { FeishuAdapter } from '../../../../channels/feishu/adapter.js';
import { finalizeStreamFeedback } from '../../../../channels/delivery/stream-feedback.js';
import { StructuredStreamDeliveryError } from '../../../../channels/delivery/stream-feedback-error.js';

function fixture() {
  const sent: any[] = [];
  const adapter = new FeishuAdapter({ id: 'recovery', provider: 'feishu', alias: 'test', enabled: true, config: { streamingEnabled: true } });
  let fail = false;
  (adapter as any).restClient = {
    cardkit: { v1: { card: { create: async () => { throw new Error('CardKit timeout'); } } } },
    im: { message: { create: async (payload: any) => {
      sent.push(payload);
      if (fail) throw new Error('IM unavailable');
      return { code: 0, data: { message_id: `m${sent.length}` } };
    } } },
  };
  return { adapter, sent, fail(value: boolean) { fail = value; } };
}

it('keeps tools and long outputs in paginated schema-2 cards after CardKit creation fails', async () => {
  const { adapter, sent } = fixture();
  const tools = Array.from({ length: 70 }, (_, i) => ({ id: `tool-${i}`, name: 'Shell', status: 'complete' as const, showOutput: true,
    input: JSON.stringify({ command: `echo tool-${i}` }), output: `RESULT-${i}\n${'line\n'.repeat(15)}END-${i}` }));
  adapter.onStreamHistory('chat', [{ type: 'tool_panel', tools }, { type: 'markdown', role: 'assistant', content: 'FINAL-SENTINEL' }], 'stream');
  await (adapter as any).cardCreatePromises.get('stream');
  assert.ok((adapter as any).pendingCardCreateStates.has('stream'));
  assert.equal(await adapter.onStreamEnd('chat', 'completed', '', 'stream'), true);
  assert.ok(sent.length > 1);
  const content = sent.map((p) => p.data.content).join('\n');
  for (let i = 0; i < tools.length; i += 1) assert.ok(content.includes(`END-${i}`));
  assert.match(content, /FINAL-SENTINEL/);
  assert.match(content, /collapsible_panel/);
  assert.ok(sent.every((p) => p.data.msg_type === 'interactive' && JSON.parse(p.data.content).schema === '2.0'));
  assert.equal((adapter as any).pendingCardCreateStates.size, 0);
});

it('retains history and a stable page UUID when both delivery paths fail', async () => {
  const { adapter, sent, fail } = fixture();
  adapter.onStreamHistory('chat', [{ type: 'markdown', role: 'assistant', content: 'KEEP-ME' }], 'stream');
  await (adapter as any).cardCreatePromises.get('stream');
  fail(true);
  await assert.rejects(finalizeStreamFeedback({ adapter, channelType: 'feishu', chatId: 'chat', streamKey: 'stream' }, 'completed', ''), StructuredStreamDeliveryError);
  assert.ok((adapter as any).pendingCardCreateStates.has('stream'));
  fail(false);
  assert.equal(await adapter.onStreamEnd('chat', 'completed', '', 'stream'), true);
  assert.equal(sent[0].data.uuid, sent[1].data.uuid);
  assert.ok(sent.every((p) => p.data.msg_type === 'interactive'));
});

it('recovers only the unacknowledged continuation instead of replaying earlier pages', async () => {
  const { adapter, sent } = fixture();
  (adapter as any).pendingCardCreateStates.set('stream', {
    historyDriven: true, historyItemOffset: 1,
    historyItems: [
      { type: 'markdown', role: 'assistant', content: 'ALREADY-DELIVERED' },
      { type: 'markdown', role: 'assistant', content: 'RECOVER-THIS' },
    ],
  });
  assert.equal(await adapter.onStreamEnd('chat', 'completed', '', 'stream'), true);
  assert.match(sent[0].data.content, /RECOVER-THIS/);
  assert.doesNotMatch(sent[0].data.content, /ALREADY-DELIVERED/);
});
