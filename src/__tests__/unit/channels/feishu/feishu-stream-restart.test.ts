import '../../../setup/test-setup.js';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { FeishuAdapter } from '../../../../channels/feishu/adapter.js';
import type { StreamingHistoryItem, ToolCallInfo } from '../../../../domain/index.js';

const chat = 'restart-chat', key = 'restart-stream';
async function settle(a: any): Promise<void> {
  const deadline = Date.now() + 5000;
  for (;;) {
    assert(await a.awaitCardFlushCompletion(key, 5000));
    const state = a.activeCards.get(key);
    assert(!state?.lastFlushError, state?.lastFlushError);
    if (!state || (!state.throttleTimer && !state.flushInFlight && !state.flushQueued)) return;
    assert(Date.now() < deadline, 'card updates did not settle');
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}

function fixture() {
  const writes: Array<{ kind: string; payload: any }> = [];
  let cards = 0;
  const record = (kind: string) => async (payload: any) => { writes.push({ kind, payload }); return {}; };
  const client = {
    cardkit: { v1: {
      card: {
        create: async (payload: any) => { writes.push({ kind: 'create', payload }); return { data: { card_id: `card-${++cards}` } }; },
        update: record('update'), settings: record('settings'),
      },
      cardElement: { content: record('content'), create: record('element-create'), patch: record('patch') },
    } },
    im: { message: { create: async () => ({ data: { message_id: `message-${cards}` } }) } },
  };
  const make = () => {
    const adapter = new FeishuAdapter({ id: 'restart-test', provider: 'feishu', enabled: true,
      alias: 'test', config: { appId: 'test', appSecret: 'test', streamingEnabled: true } });
    const a = adapter as any;
    a.restClient = client;
    a.cardFlushBaseIntervalMs = 1;
    a.cardFlushFirstFailureIntervalMs = 1;
    a.cardFlushMaxFailureIntervalMs = 1;
    return { adapter, a };
  };
  return { make, writes };
}

for (const legacy of [false, true]) it(`restores a many-page turn without replaying old cards (${legacy ? 'legacy' : 'saved cursor'})`, async () => {
  const f = fixture();
  const first = f.make(), resumed = f.make();
  const tools: ToolCallInfo[] = Array.from({ length: 120 }, (_, i) => ({
    id: `tool-${i}`, name: 'Shell', status: 'complete', showOutput: true,
    input: JSON.stringify({ command: `echo TOOL_${i}_END` }), output: `RESULT_${i}_END ${'x'.repeat(1900)}`,
  }));
  const history = (count: number): StreamingHistoryItem[] => [
    { type: 'markdown', role: 'user', content: '原始用户请求' },
    { type: 'tool_panel', tools: tools.slice(0, count) },
  ];
  try {
    await first.a.createStreamingCard(chat, undefined, key);
    first.adapter.onStreamHistory(chat, history(tools.length), key);
    first.adapter.onTaskEvent(chat, [{ text: '重启待办', status: 'in_progress' }], key);
    await settle(first.a);
    const handle = JSON.parse(JSON.stringify(first.adapter.getStreamingCardHandle(chat, key)!));
    assert(f.writes.filter(w => w.kind === 'create').length > 5, 'fixture must really span many cards');
    if (legacy) delete handle.page;
    first.adapter.onMessageEnd(chat, key);
    const before = f.writes.length;
    assert(resumed.adapter.adoptStreamingCardHandle(chat, key, handle));
    for (const count of [0, 1, 30, 70, 120]) {
      resumed.adapter.onStreamHistory(chat, history(count), key);
      resumed.adapter.onStreamStatus(chat, '正在恢复历史', key);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(f.writes.length, before, 'partial replay must not overwrite the remote card or publish old pages');
      assert.equal(resumed.adapter.getStreamingCardHandle(chat, key), null, 'do not checkpoint a partial replay');
    }
    resumed.adapter.onTaskEvent(chat, [{ text: '重启待办', status: 'completed' }], key);
    resumed.adapter.onStreamHistoryReplayComplete(chat, key);
    await settle(resumed.a);
    assert.equal(f.writes.slice(before).filter(w => w.kind === 'create').length, 0);
    const restored = resumed.adapter.getStreamingCardHandle(chat, key)!;
    assert.equal(restored.cardId, handle.cardId);
    if (!legacy) assert.deepEqual(JSON.parse(JSON.stringify(restored.page)), handle.page);
    const updated = f.writes.filter(w => w.kind === 'update').at(-1)!;
    assert.match(updated.payload.data.card.data, /RESULT_119_END/);
    assert.doesNotMatch(updated.payload.data.card.data, /RESULT_0_END/);
    resumed.adapter.onStreamHistory(chat, [...history(120), { type: 'markdown', role: 'assistant', content: '恢复后的实时结果' }], key);
    assert(await resumed.adapter.onStreamEnd(chat, 'completed', '恢复后的实时结果', key));
    const final = f.writes.filter(w => w.kind === 'update').at(-1)!;
    assert.match(final.payload.data.card.data, /恢复后的实时结果/);
    assert.match(final.payload.data.card.data, /重启待办/);
    assert.equal(f.writes.slice(before).filter(w => w.kind === 'create').length, 0);
  } finally { first.adapter.onMessageEnd(chat, key); resumed.adapter.onMessageEnd(chat, key); }
});

it('retains a text-fragment cursor while replay arrives in smaller chunks', async () => {
  const f = fixture(), first = f.make(), resumed = f.make();
  const content = `${'long text '.repeat(8000)}END_OF_LONG_TEXT`;
  const history = (text: string): StreamingHistoryItem[] => [{ type: 'markdown', role: 'assistant', content: text }];
  try {
    await first.a.createStreamingCard(chat, undefined, key);
    first.adapter.onStreamHistory(chat, history(content), key);
    await settle(first.a);
    const handle = JSON.parse(JSON.stringify(first.adapter.getStreamingCardHandle(chat, key)!));
    assert(handle.page.historyTextOffset > 0);
    first.adapter.onMessageEnd(chat, key);
    const before = f.writes.length;
    resumed.adapter.adoptStreamingCardHandle(chat, key, handle);
    resumed.adapter.onStreamHistory(chat, history(content.slice(0, 100)), key);
    await new Promise(resolve => setImmediate(resolve));
    resumed.adapter.onStreamHistory(chat, history(content), key);
    resumed.adapter.onStreamHistoryReplayComplete(chat, key);
    await settle(resumed.a);
    assert.equal(resumed.adapter.getStreamingCardHandle(chat, key)!.page!.historyTextOffset, handle.page.historyTextOffset);
    assert.equal(f.writes.slice(before).filter(w => w.kind === 'create').length, 0);
    assert.match(f.writes.filter(w => w.kind === 'update').at(-1)!.payload.data.card.data, /END_OF_LONG_TEXT/);
  } finally { first.adapter.onMessageEnd(chat, key); resumed.adapter.onMessageEnd(chat, key); }
});
