import '../../../setup/test-setup.js';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { FeishuAdapter } from '../../../../channels/feishu/adapter.js';

const chat = 'timeout-chat';
const stream = 'timeout-stream';
const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'fixture did not reach expected state');
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

function fixture(code = 200850, failContinuation = false) {
  const continuationStarted = deferred();
  const releaseContinuation = deferred();
  const requests: Array<{ kind: string; payload: any }> = [];
  let cards = 0;
  let rejected = false;
  const adapter = new FeishuAdapter({ id: 'timeout-test', provider: 'feishu', enabled: true,
    alias: 'test', config: { appId: 'test-app', appSecret: 'test-secret', streamingEnabled: true } });
  const internal = adapter as any;
  internal.cardFlushBaseIntervalMs = 1;
  internal.cardFlushFirstFailureIntervalMs = 1;
  internal.cardFlushMaxFailureIntervalMs = 1;
  internal.cardRequestTimeoutMs = 1_000;
  internal.cardFinalizeFlushWaitExtraMs = 0;
  const record = (kind: string) => async (payload: any) => { requests.push({ kind, payload }); return {}; };
  internal.restClient = {
    cardkit: { v1: {
      card: {
        create: async (payload: any) => {
          const index = ++cards;
          requests.push({ kind: 'create', payload });
          if (index === 2) {
            continuationStarted.resolve();
            await releaseContinuation.promise;
            if (failContinuation) return { code: 500, msg: 'injected continuation failure' };
          }
          return { data: { card_id: `card-${index}` } };
        },
        update: record('update'), settings: record('settings'),
      },
      cardElement: {
        content: async (payload: any) => {
          requests.push({ kind: 'content', payload });
          if (!rejected && payload.path.card_id === 'card-1' && payload.path.element_id === 'streaming_content') {
            rejected = true;
            return { code, msg: 'card streaming timeout' };
          }
          return {};
        },
        create: record('element-create'), patch: record('patch'),
      },
    } },
    im: { message: {
      create: async () => ({ data: { message_id: `message-${cards}` } }),
      reply: async () => ({ data: { message_id: `message-${cards}` } }),
    } },
  };
  return { adapter, internal, requests, continuationStarted, releaseContinuation,
    state: () => internal.activeCards.get(stream),
    cleanup: () => { releaseContinuation.resolve(); adapter.onMessageEnd(chat, stream); },
  };
}

for (const code of [200850, 200860]) {
  it(`resumes live updates after asynchronous content error ${code} creates a continuation`, { timeout: 5_000 }, async () => {
    const f = fixture(code);
    try {
      await f.internal.createStreamingCard(chat, undefined, stream);
      f.adapter.onStreamText(chat, 'text that times out', stream);
      await f.continuationStarted.promise;
      const pending = f.state().backgroundFlushInFlight;
      assert.ok(pending, 'must exercise the background content request');
      let settled = false;
      void pending.then(() => { settled = true; });
      // Force the original request's microtasks to run while card.create is blocked.
      await nextTurn();
      f.adapter.onStreamText(chat, 'arrived during continuation creation', stream);
      f.releaseContinuation.resolve();
      await until(() => f.state().cardId === 'card-2');
      await nextTurn();
      const idle = await f.internal.awaitCardFlushCompletion(stream, 100);
      console.log('[timeout-rollover-evidence]', JSON.stringify({ code, idle, settled,
        staleBackgroundPromise: f.state().backgroundFlushInFlight === pending,
        queued: f.state().flushQueued,
        continuationWrites: f.requests.filter(r => r.payload.path?.card_id === 'card-2').length }));
      assert.equal(idle, true, 'continuation retained a settled background promise and blocked live updates');
      assert.equal(f.state().backgroundFlushInFlight, null);
      assert.ok(f.requests.some(r => r.payload.path?.card_id === 'card-2'
        && JSON.stringify(r.payload).includes('arrived during continuation creation')));

      // Updates must reach Feishu before finalization, rather than accumulating until the end.
      for (let index = 1; index <= 20; index++) {
        const text = `live progress ${index}`;
        f.adapter.onStreamText(chat, text, stream);
        await until(() => f.requests.some(r => r.payload.path?.card_id === 'card-2'
          && JSON.stringify(r.payload).includes(text)));
      }
      assert.equal(await f.internal.finalizeCard(chat, 'completed', 'done', stream), true);
      assert.equal(f.requests.filter(r => r.kind === 'create').length, 2);
    } finally { f.cleanup(); }
  });
}

it('finalization waits for timeout recovery and adopts the continuation with the latest output', { timeout: 5_000 }, async () => {
  const f = fixture();
  try {
    await f.internal.createStreamingCard(chat, undefined, stream);
    f.adapter.onStreamText(chat, 'timeout', stream);
    await f.continuationStarted.promise;
    await nextTurn();
    f.adapter.onStreamText(chat, 'latest while creating', stream);
    let finalized = false;
    const result = f.internal.finalizeCard(chat, 'completed', 'final response', stream).then((value: boolean) => {
      finalized = true; return value;
    });
    await nextTurn();
    const finishedBeforeContinuation = finalized;
    f.releaseContinuation.resolve();
    assert.equal(await result, true);
    assert.equal(finishedBeforeContinuation, false, 'must not finalize the old card while recovery is still creating the new card');
    const final = f.requests.filter(r => r.kind === 'update').at(-1)!;
    assert.equal(final.payload.path.card_id, 'card-2');
    assert.match(final.payload.data.card.data, /latest while creating/);
    assert.match(final.payload.data.card.data, /final response/);
  } finally { f.cleanup(); }
});

it('releases the background request and retries the source card when continuation creation fails', { timeout: 5_000 }, async () => {
  const f = fixture(200850, true);
  try {
    await f.internal.createStreamingCard(chat, undefined, stream);
    f.adapter.onStreamText(chat, 'timeout', stream);
    await f.continuationStarted.promise;
    f.adapter.onStreamText(chat, 'latest after failed continuation', stream);
    f.releaseContinuation.resolve();
    await until(() => f.requests.some(r => r.kind === 'update'
      && JSON.stringify(r.payload).includes('latest after failed continuation')));
    assert.equal(await f.internal.awaitCardFlushCompletion(stream, 100), true);
    assert.equal(f.state().cardId, 'card-1');
  } finally { f.cleanup(); }
});
