import '../../../setup/test-setup.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { FeishuAdapter, _testOnly } from '../../../../channels/feishu/adapter.js';
import { buildToolProgressBlocks } from '../../../../shared/progress/tool-rendering.js';
import type { StreamingHistoryItem } from '../../../../domain/index.js';

function harness() {
  const adapter = new FeishuAdapter({ id: 'test', provider: 'feishu', alias: 'test', enabled: true, config: {} }) as any;
  const cards = new Map<string, any>();
  const closed = new Set<string>();
  const operations: string[] = [];
  const sent: any[] = [];
  let serial = 0;
  let failNext = false;
  let duringCreate: (() => void) | undefined;
  const check = (json: string) => {
    assert.ok(Buffer.byteLength(json) < 28_000, `oversized payload: ${Buffer.byteLength(json)}`);
    const body = JSON.parse(json);
    assert.ok(_testOnly.countFeishuCardComponents(body) <= 160);
    return body;
  };
  adapter.scheduleCardFlush = () => {};
  adapter.restClient = {
    cardkit: { v1: {
      card: {
        create: async ({ data }: any) => {
          operations.push('create');
          const body = check(data.data);
          duringCreate?.();
          duringCreate = undefined;
          if (failNext) { failNext = false; return { code: 200860, msg: 'card over max size' }; }
          const id = `card-${++serial}`;
          cards.set(id, body);
          return { data: { card_id: id } };
        },
        update: async ({ path, data }: any) => {
          const body = check(data.card.data);
          assert.ok(!(closed.has(path.card_id) && body.config?.streaming_mode), 'updated a closed card');
          cards.set(path.card_id, body);
          operations.push(`update:${path.card_id}`);
          return {};
        },
        settings: async ({ path }: any) => {
          closed.add(path.card_id);
          operations.push(`close:${path.card_id}`);
          return {};
        },
      },
      cardElement: {
        content: async ({ path }: any) => {
          assert.ok(!closed.has(path.card_id), 'streaming update after close');
          return {};
        },
        create: async () => ({}),
      },
    } },
    im: { message: { create: async (payload: any) => {
      sent.push(payload);
      operations.push('send');
      return { data: { message_id: `message-${serial}` } };
    } } },
  };
  return { adapter, cards, closed, operations, sent,
    failCreate: () => { failNext = true; },
    duringCreate: (fn: () => void) => { duringCreate = fn; },
  };
}

function history(count = 40): StreamingHistoryItem[] {
  return Array.from({ length: count }, (_, i) => ({
    type: 'markdown', role: 'assistant', content: `RECORD_${i}_BEGIN ${'恢复中文🙂\\"'.repeat(70)} RECORD_${i}_END`,
  }));
}

it('recovers a large current turn in order and drains every page before finalization', async () => {
  const { adapter, cards } = harness();
  await adapter.createStreamingCard('new-chat', undefined, 'mirror');
  adapter.onStreamHistory('new-chat', history(), 'mirror');
  // 先只投递一页，模拟接管后立刻收到task_complete。
  await adapter.flushCardUpdate('mirror');
  assert.equal(await adapter.finalizeCard('new-chat', 'completed', '', 'mirror'), true);
  const all = [...cards.values()].map(x => JSON.stringify(x)).join('\n');
  for (let i = 0; i < 40; i++) {
    assert.equal(all.split(`RECORD_${i}_BEGIN`).length - 1, 1, `missing/duplicated record ${i}`);
    assert.ok(all.indexOf(`RECORD_${i}_END`) > all.indexOf(`RECORD_${i}_BEGIN`));
    if (i) assert.ok(all.indexOf(`RECORD_${i}_BEGIN`) > all.indexOf(`RECORD_${i - 1}_END`));
  }
  assert.ok(cards.size > 2);
});

it('keeps the original card open on rejected continuation and preserves input arriving during retry', async () => {
  const h = harness();
  await h.adapter.createStreamingCard('new-chat', undefined, 'mirror');
  const items = history();
  h.adapter.onStreamHistory('new-chat', items, 'mirror');
  await h.adapter.flushCardUpdate('mirror');
  const original = h.adapter.activeCards.get('mirror');
  h.failCreate();
  await h.adapter.flushCardUpdate('mirror');
  assert.equal(h.adapter.activeCards.get('mirror'), original);
  assert.equal(h.closed.size, 0);
  h.duringCreate(() => h.adapter.onStreamHistory('new-chat', [...items,
    { type: 'markdown', role: 'assistant', content: 'ARRIVED_DURING_CREATE' }], 'mirror'));
  await h.adapter.flushCardUpdate('mirror');
  assert.equal(h.closed.size, 1);
  assert.ok(h.operations.lastIndexOf('send') < h.operations.indexOf('close:card-1'));
  assert.equal(await h.adapter.finalizeCard('new-chat', 'completed', '', 'mirror'), true);
  const all = [...h.cards.values()].map(x => JSON.stringify(x)).join('\n');
  assert.match(all, /ARRIVED_DURING_CREATE/);
  for (let i = 0; i < 40; i++) assert.equal(all.split(`RECORD_${i}_BEGIN`).length - 1, 1);
});

it('splits an oversized group of bounded patch previews without losing its lines or code fences', async () => {
  const { adapter, cards } = harness();
  const tools = ['A', 'B'].map(label => {
    const lines = Array.from({ length: 900 }, (_, i) => `+PATCH_${label}_LINE_${i}_END ${'中文🙂'.repeat(80)}`);
    const patch = ['*** Begin Patch', `*** Update File: ${label}.py`, '@@', ...lines, '*** End Patch'].join('\n');
    return { id: `patch-${label}`, name: 'apply_patch', status: 'complete' as const,
      detail: { kind: 'patch_apply' as const, patchText: patch } };
  });
  await adapter.createStreamingCard('new-chat', undefined, 'mirror');
  const expected = buildToolProgressBlocks(tools, { maxItems: null }).map(block => block.detail).join('\n');
  assert.ok(Buffer.byteLength(expected) > 28_000, 'the bounded patch group must still exceed the actual byte budget');
  adapter.onStreamHistory('new-chat', [{ type: 'tool_panel', tools }], 'mirror');
  assert.equal(await adapter.finalizeCard('new-chat', 'completed', '', 'mirror'), true);
  const contents: string[] = [];
  const visit = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (node.tag === 'markdown' && typeof node.content === 'string' && node.content.includes('PATCH_')) contents.push(node.content);
    Object.values(node).forEach(visit);
  };
  [...cards.values()].forEach(visit);
  const all = contents.join('\n');
  const expectedLines = expected.match(/PATCH_[AB]_LINE_\d+_END/g)!;
  for (const line of expectedLines) assert.equal(all.split(line).length - 1, 1, line);
  assert.ok(cards.size > 1);
  for (const content of contents) assert.equal((content.match(/^```/gm) || []).length % 2, 0);
});

for (const size of [200, 40_000]) {
  it(`delivers the complete revised answer after a long snapshot was paginated (${size} chars)`, async () => {
    const { adapter, cards } = harness();
    await adapter.createStreamingCard('chat', undefined, 'revision');
    const prefix: StreamingHistoryItem[] = [{ type: 'markdown', role: 'user', content: 'CHECK_REVISION' }];
    const old = 'INTERIM_BEGIN ' + 'interim '.repeat(5_000) + ' INTERIM_END';
    adapter.onStreamHistory('chat', [...prefix, { type: 'markdown', role: 'assistant', content: old }], 'revision');
    for (let i = 0; i < 5 && !adapter.activeCards.get('revision').historyTextOffset; i++) {
      await adapter.flushCardUpdate('revision');
    }
    assert.ok(adapter.activeCards.get('revision').historyTextOffset > 1_000);
    const answer = 'REVISED_BEGIN ' + '新'.repeat(size) + ' REVISED_END';
    adapter.onStreamHistory('chat', [...prefix, { type: 'markdown', role: 'assistant', content: answer }], 'revision');
    assert.equal(await adapter.onStreamEnd('chat', 'completed', answer, 'revision'), true);
    const all = [...cards.values()].map(x => JSON.stringify(x)).join('\n');
    assert.equal(all.split('CHECK_REVISION').length - 1, 1, 'do not replay the already delivered user input');
    assert.equal(all.split('REVISED_BEGIN').length - 1, 1);
    assert.equal(all.split('REVISED_END').length - 1, 1);
    assert.equal((all.match(/新/g) || []).length, size, 'do not drop the rewritten prefix or tail');
    assert.notEqual([...cards.values()].at(-1).config.streaming_mode, true);
    assert.equal(adapter.hasActiveCard('chat', 'revision'), false);
  });
}

it('preserves the page position when the same snapshot only grows', async () => {
  const { adapter, cards } = harness();
  await adapter.createStreamingCard('chat', undefined, 'append');
  const old = 'APPEND_BEGIN ' + '字'.repeat(12_000);
  adapter.onStreamHistory('chat', [{ type: 'markdown', role: 'assistant', content: old }], 'append');
  for (let i = 0; i < 5 && !adapter.activeCards.get('append').historyTextOffset; i++) await adapter.flushCardUpdate('append');
  const offset = adapter.activeCards.get('append').historyTextOffset;
  assert.ok(offset > 0);
  const answer = old + ' APPEND_END';
  adapter.onStreamHistory('chat', [{ type: 'markdown', role: 'assistant', content: answer }], 'append');
  assert.equal(adapter.activeCards.get('append').historyTextOffset, offset);
  assert.equal(await adapter.onStreamEnd('chat', 'completed', answer, 'append'), true);
  const all = [...cards.values()].map(x => JSON.stringify(x)).join('\n');
  assert.equal(all.split('APPEND_BEGIN').length - 1, 1);
  assert.equal(all.split('APPEND_END').length - 1, 1);
  assert.equal((all.match(/字/g) || []).length, 12_000);
});

it('recovers the answer when local pagination throws before terminal card update', async () => {
  const { adapter, sent } = harness();
  await adapter.createStreamingCard('chat', undefined, 'failed-render');
  adapter.onStreamHistory('chat', [{ type: 'markdown', role: 'assistant', content: 'RECOVER_LOCAL_RENDER_FAILURE' }], 'failed-render');
  adapter.currentStreamingCardRender = () => { throw new Error('local pagination failed'); };
  assert.equal(await adapter.onStreamEnd('chat', 'completed', '', 'failed-render'), true);
  assert.ok(sent.some(p => p.data.msg_type === 'interactive' && p.data.content.includes('RECOVER_LOCAL_RENDER_FAILURE')));
  assert.equal(adapter.hasActiveCard('chat', 'failed-render'), false);
});

it('rebases a rewritten snapshot that arrives while the continuation is being created', async () => {
  const h = harness();
  await h.adapter.createStreamingCard('chat', undefined, 'concurrent-revision');
  const old: StreamingHistoryItem[] = [{ type: 'markdown', role: 'assistant', content: 'DRAFT ' + '旧'.repeat(15_000) }];
  h.adapter.onStreamHistory('chat', old, 'concurrent-revision');
  await h.adapter.flushCardUpdate('concurrent-revision');
  assert.ok(h.adapter.activeCards.get('concurrent-revision').renderedPageHasMore);
  h.duringCreate(() => h.adapter.onStreamHistory('chat', [{ type: 'markdown', role: 'assistant', content: 'CONCURRENT_FINAL' }], 'concurrent-revision'));
  await h.adapter.flushCardUpdate('concurrent-revision');
  assert.equal(await h.adapter.onStreamEnd('chat', 'completed', '', 'concurrent-revision'), true);
  const all = [...h.cards.values()].map(x => JSON.stringify(x)).join('\n');
  assert.equal(all.split('CONCURRENT_FINAL').length - 1, 1);
});

it('keeps six ordinary 3 KB tool results on one bounded card', async () => {
  const { adapter, cards } = harness();
  await adapter.createStreamingCard('chat', undefined, 'tools');
  const tools = Array.from({ length: 6 }, (_, index) => ({
    id: `ordinary-${index}`, name: 'Shell', status: 'complete' as const, showOutput: true,
    input: JSON.stringify({ command: `inspect-result-${index}` }),
    output: `TOOL_${index}_BEGIN ` + 'x'.repeat(3_000) + ` TOOL_${index}_END`,
  }));
  for (let count = 1; count <= tools.length; count++) {
    adapter.onStreamHistory('chat', [{ type: 'tool_panel', tools: tools.slice(0, count) }], 'tools');
    await adapter.flushCardUpdate('tools');
  }
  assert.equal(await adapter.finalizeCard('chat', 'completed', '', 'tools'), true);
  assert.equal(cards.size, 1, 'several normal tool outputs should not cause an early continuation');
  const body = [...cards.values()][0];
  const json = JSON.stringify(body);
  assert.ok(Buffer.byteLength(json) > 18_000, 'the scenario must exceed the old conservative byte threshold');
  assert.ok(Buffer.byteLength(json) < 28_000);
  assert.ok(_testOnly.countFeishuCardComponents(body) < 160);
  for (let i = 0; i < tools.length; i++) {
    assert.equal(json.split(`TOOL_${i}_BEGIN`).length - 1, 1);
    assert.equal(json.split(`TOOL_${i}_END`).length - 1, 1);
  }
});
