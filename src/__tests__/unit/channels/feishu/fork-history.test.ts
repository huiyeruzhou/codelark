import '../../../setup/test-setup.js';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { FeishuAdapter } from '../../../../channels/feishu/adapter.js';

function adapterWith(messages: Record<string, unknown>): FeishuAdapter {
  const adapter = new FeishuAdapter({ id: 'feishu-test', alias: 'test', provider: 'feishu', enabled: true, config: {} });
  (adapter as any).restClient = { im: { message: {
    get: async ({ path }: any) => ({ code: 0, data: { items: [{ message_id: path.message_id,
      chat_id: 'source', create_time: '1793101140892', msg_type: 'interactive' }] } }),
    ...messages,
  } } };
  return adapter;
}

it('reads backwards from the exact boundary and returns chronological history, ignoring newer, duplicate, system and deleted messages', async () => {
  const pages = [
    { items: [{ message_id: 'later-in-same-second' }, { message_id: 'card-a' },
      { message_id: 'system', msg_type: 'system' }, { message_id: 'user' },
      { message_id: 'deleted', deleted: true }], has_more: true, page_token: 'next' },
    { items: [{ message_id: 'user' }, { message_id: 'older' }], has_more: false },
  ];
  const requests: any[] = [];
  const adapter = adapterWith({ list: async (input: any) => {
    requests.push(input);
    return { code: 0, data: pages.shift() };
  } });
  assert.deepEqual(await adapter.listChatMessageIdsThrough('source', 'card-a', 10), ['older', 'user', 'card-a']);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].params.sort_type, 'ByCreateTimeDesc');
  assert.equal(requests[0].params.end_time, '1793101141');
  assert.equal(requests[1].params.page_token, 'next');
});

it('for an 810-message history reads one page and returns only the ten preceding messages plus the card', async () => {
  const messages = Array.from({ length: 810 }, (_, i) => ({ message_id: `message-${i}` }));
  let calls = 0;
  const adapter = adapterWith({ list: async () => {
    calls++;
    assert.equal(calls, 1, 'must stop without walking older pages');
    return { code: 0, data: { items: messages.slice(-50).reverse(), has_more: true, page_token: 'older' } };
  } });
  assert.deepEqual(await adapter.listChatMessageIdsThrough('source', 'message-809', 10),
    messages.slice(-11).map(m => m.message_id));
  assert.equal(calls, 1);
});

it('continues across pages to collect ten valid predecessors and stops before the next page', async () => {
  const predecessors = Array.from({ length: 10 }, (_, i) => ({ message_id: `previous-${9 - i}` }));
  const pages = [
    { items: [{ message_id: 'later' }], has_more: true, page_token: 'boundary' },
    { items: [{ message_id: 'card' }, ...predecessors.slice(0, 4), { message_id: 'deleted', deleted: true }], has_more: true, page_token: 'older' },
    { items: [predecessors[3], { message_id: 'system', msg_type: 'system' }, ...predecessors.slice(4)], has_more: true, page_token: 'unused' },
  ];
  const adapter = adapterWith({ list: async () => { assert.ok(pages.length); return { code: 0, data: pages.shift() }; } });
  assert.deepEqual(await adapter.listChatMessageIdsThrough('source', 'card', 10),
    [...predecessors].reverse().map(m => m.message_id).concat('card'));
  assert.equal(pages.length, 0);
});

it('missing/deleted boundaries, permission errors and stalled pagination never produce a truncated success', async () => {
  await assert.rejects(adapterWith({ list: async () => ({ code: 0, data: { items: [] } }) })
    .listChatMessageIdsThrough('source', 'card', 10), /找不到分叉卡片/);
  await assert.rejects(adapterWith({ list: async () => ({ code: 0, data: { items: [{ message_id: 'card', deleted: true }] } }) })
    .listChatMessageIdsThrough('source', 'card', 10), /已删除/);
  await assert.rejects(adapterWith({ list: async () => ({ code: 99991672, msg: 'permission denied' }) })
    .listChatMessageIdsThrough('source', 'card', 10), /permission denied/);
  await assert.rejects(adapterWith({ list: async () => ({ code: 0, data: { items: [], has_more: true, page_token: 'same' } }) })
    .listChatMessageIdsThrough('source', 'card', 10), /分页未前进/);
});

it('validates boundary lookup, ownership and timestamp before listing history', async () => {
  for (const boundary of [undefined, { chat_id: 'other' }, { chat_id: 'source', deleted: true },
    { chat_id: 'source', create_time: 'invalid' }]) {
    const adapter = adapterWith({ get: async () => ({ code: 0, data: {
      items: boundary ? [{ message_id: 'card', ...boundary }] : [],
    } }), list: async () => assert.fail('invalid boundary must not list') });
    await assert.rejects(adapter.listChatMessageIdsThrough('source', 'card', 10), /找不到|已删除|创建时间/);
  }
  await assert.rejects(adapterWith({ get: async () => ({ code: 99991672, msg: 'get permission denied' }) })
    .listChatMessageIdsThrough('source', 'card', 10), /get permission denied/);
});

it('uses native single-message forwarding with destination-scoped idempotency and validates the receipt', async () => {
  const requests: any[] = [];
  const adapter = adapterWith({ forward: async (input: any) => {
    requests.push(input);
    return { code: 0, data: { message_id: 'copy' } };
  } });
  assert.equal(await adapter.forwardChatMessage('original', 'branch'), 'copy');
  await adapter.forwardChatMessage('original', 'branch');
  await adapter.forwardChatMessage('original', 'other-branch');
  assert.equal(requests[0].path.message_id, 'original');
  assert.equal(requests[0].data.receive_id, 'branch');
  assert.equal(requests[0].params.receive_id_type, 'chat_id');
  assert.equal(requests[0].params.uuid, requests[1].params.uuid);
  assert.notEqual(requests[0].params.uuid, requests[2].params.uuid);
  await assert.rejects(adapterWith({ forward: async () => ({ code: 0, data: {} }) })
    .forwardChatMessage('original', 'branch'), /缺少 message_id/);
});
