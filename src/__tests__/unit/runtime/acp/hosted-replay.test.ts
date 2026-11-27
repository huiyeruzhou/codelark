import '../../../setup/test-setup.js';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { consumeHostedAcpTurn } from '../../../../runtime/acp/hosted-session.js';
import type { AcpHostClient } from '../../../../runtime/acp/host-client.js';
import type { AcpTurnEvent, AcpTurnSnapshot } from '../../../../runtime/acp/host-protocol.js';

for (const sameRead of [true, false]) it(`emits one replay barrier before live events (same socket read: ${sameRead})`, async () => {
  const seen: string[] = [];
  let receive!: (evt: AcpTurnEvent) => void;
  const turn = { turnId: 'turn', lastSeq: 1, pendingRequests: [], status: 'running' } as unknown as AcpTurnSnapshot;
  const update = (seq: number): AcpTurnEvent => ({ seq, ts: seq, kind: 'session_update', params: { text: `event-${seq}` } });
  const replay = () => {
    receive(update(1)); receive(update(2));
    receive(update(3));
    receive({ seq: 4, ts: 4, kind: 'turn_end', status: 'completed' });
  };
  const host = {
    connected: true,
    onTurnEvent: (_: string, fn: typeof receive) => { receive = fn; return () => {}; },
    onDisconnect: () => () => {},
    subscribeTurn: async () => {
      if (sameRead) replay(); else setImmediate(replay);
      return { turn: { ...turn, lastSeq: 2 } };
    },
    unsubscribeTurn: async () => ({ ok: true }),
  } as unknown as AcpHostClient;
  const result = await consumeHostedAcpTurn(host, turn, {
    onSessionUpdate: p => { seen.push(String(p.text)); },
    onReplayComplete: () => { seen.push('replay-complete'); },
    onServerRequest: async () => {},
  });
  assert.equal(result.status, 'completed');
  assert.deepEqual(seen, ['event-1', 'event-2', 'replay-complete', 'event-3']);
});

it('releases recovery for an empty terminal snapshot', async () => {
  let barriers = 0;
  const turn = { turnId: 'empty', lastSeq: 0, pendingRequests: [], status: 'completed' } as unknown as AcpTurnSnapshot;
  const host = { connected: true, onTurnEvent: () => () => {}, onDisconnect: () => () => {},
    subscribeTurn: async () => ({ turn }), unsubscribeTurn: async () => ({ ok: true }),
  } as unknown as AcpHostClient;
  const result = await consumeHostedAcpTurn(host, turn, {
    onSessionUpdate: () => {}, onServerRequest: async () => {}, onReplayComplete: () => { barriers++; },
  });
  assert.equal(result.status, 'completed'); assert.equal(barriers, 1);
});
