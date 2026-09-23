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
  let serial = 0;
  let failNext = false;
  let duringCreate: (() => void) | undefined;
  const check = (json: string) => {
    assert.ok(Buffer.byteLength(json) < 18_000, `oversized payload: ${Buffer.byteLength(json)}`);
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
    im: { message: { create: async () => {
      operations.push('send');
      return { data: { message_id: `message-${serial}` } };
    } } },
  };
  return { adapter, cards, closed, operations,
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

it('splits one oversized patch across bounded cards without losing its lines or code fences', async () => {
  const { adapter, cards } = harness();
  const lines = Array.from({ length: 900 }, (_, i) => `+PATCH_LINE_${i}_END ${'中文🙂'.repeat(80)}`);
  const patch = ['*** Begin Patch', '*** Update File: x.py', '@@', ...lines, '*** End Patch'].join('\n');
  await adapter.createStreamingCard('new-chat', undefined, 'mirror');
  const tool = { id: 'patch', name: 'apply_patch', status: 'complete' as const, detail: { kind: 'patch_apply' as const, patchText: patch } };
  const expected = buildToolProgressBlocks([tool], { maxItems: null })[0]!.detail;
  adapter.onStreamHistory('new-chat', [{ type: 'tool_panel', tools: [tool] }], 'mirror');
  assert.equal(await adapter.finalizeCard('new-chat', 'completed', '', 'mirror'), true);
  const contents: string[] = [];
  const visit = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (node.tag === 'markdown' && typeof node.content === 'string' && node.content.includes('PATCH_LINE_')) contents.push(node.content);
    Object.values(node).forEach(visit);
  };
  [...cards.values()].forEach(visit);
  const all = contents.join('\n');
  const expectedLines = expected.match(/PATCH_LINE_\d+_END/g)!;
  for (const line of expectedLines) assert.equal(all.split(line).length - 1, 1, line);
  assert.ok(cards.size > 1);
  for (const content of contents) assert.equal((content.match(/^```/gm) || []).length % 2, 0);
});
