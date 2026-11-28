import '../../../setup/test-setup.js';
import assert from 'node:assert/strict';
import { it, type TestContext } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startAcpHostServer } from '../../../../runtime/acp/host-server.js';
import { acpHostEndpoint, type AcpRuntimeKind } from '../../../../runtime/acp/host-protocol.js';
import { detachSharedAcpHostClient, tryConnectExistingAcpHost } from '../../../../runtime/acp/host-client.js';
import { CursorAcpProvider } from '../../../../runtime/cursor/acp-provider.js';
import { DoubaoAcpProvider } from '../../../../runtime/doubao/acp-provider.js';

async function runningTurn(t: TestContext, runtime: AcpRuntimeKind = 'cursor') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-host-recovery-'));
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  let prompts = 0;
  const server = await startAcpHostServer({ socketPath: acpHostEndpoint(home), codeHash: 'old-build', clientFactory: async () => ({
    connected: true,
    async request<T>(method: string): Promise<T> {
      if (method === 'session/new') return { sessionId: 'native' } as T;
      if (method === 'session/prompt') { prompts++; await waiting; return { stopReason: 'end_turn' } as T; }
      return {} as T;
    },
    notify() {}, respond() {}, reject() {}, onMessage() { return () => {}; }, onDisconnect() { return () => {}; }, close() {},
  }) });
  const client = await tryConnectExistingAcpHost(home);
  assert.ok(client);
  t.after(async () => { release(); detachSharedAcpHostClient(); await server.close(true); fs.rmSync(home, { recursive: true, force: true }); });
  const sessionKey = `${runtime}:recovery`;
  await client.ensureSession({ sessionKey, runtime, bridgeSessionId: 'recovery', executable: 'fixture', args: [], cwd: home,
    label: 'Test', fingerprint: 'test', initializeParams: { protocolVersion: 1 } });
  const { turn } = await client.startTurn({ sessionKey, prompt: [{ type: 'text', text: 'original input' }],
    meta: { runtime, bridgeSessionId: 'recovery' } });
  return { client, turn, release, home, promptCount: () => prompts };
}

it('does not acknowledge a native turn when only its Bridge delivery failed', async t => {
  const { client, turn } = await runningTurn(t);
  assert.deepEqual(await client.ackTurn(turn.turnId), { ok: false });
  assert.deepEqual(await client.request('turn/ack', { turnId: turn.turnId }), { ok: false }, 'host also protects against old clients');
  assert.equal((await client.getTurn(turn.turnId))?.acked, false);
  assert.equal((await client.listUnackedTurns()).some(item => item.turnId === turn.turnId), true);
});

it('recovers an active turn omitted from an old host unacked list', async t => {
  const { client, turn } = await runningTurn(t);
  const request = client.request.bind(client);
  t.mock.method(client, 'request', async (method: string, params?: unknown, timeout?: number) => {
    if (method === 'turn/list_unacked') return { turns: [] };
    const result: any = await request(method, params, timeout);
    if (method === 'turn/get' && result.turn) result.turn.acked = true;
    return result;
  });
  const recovered = await client.listUnackedTurns();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].turnId, turn.turnId);
  assert.equal(recovered[0].status, 'running');
  assert.equal(recovered[0].acked, true, 'active session ownership overrides the legacy acknowledgement');
});

for (const runtime of ['cursor', 'doubao'] as const) it(`reattaches ${runtime} without another upgrade handshake or prompt`, async t => {
  const { client, turn, release, home, promptCount } = await runningTurn(t, runtime);
  t.mock.method(client, 'hello', async () => { throw new Error('unexpected recovery handshake'); });
  let didSubscribe!: () => void;
  const subscribed = new Promise<void>(resolve => { didSubscribe = resolve; });
  const subscribe = client.subscribeTurn.bind(client);
  t.mock.method(client, 'subscribeTurn', async (params: Parameters<typeof client.subscribeTurn>[0]) => {
    const result = await subscribe(params);
    didSubscribe();
    return result;
  });
  const provider = runtime === 'cursor' ? new CursorAcpProvider(undefined, { useHost: true }) : new DoubaoAcpProvider(undefined, { useHost: true });
  const stream = provider.streamChat({ sessionId: 'recovery', prompt: 'original input', workingDirectory: home,
    reattachAcpTurnId: turn.turnId, abortController: new AbortController() });
  const output = (async () => { let text = ''; for await (const chunk of stream) text += chunk; return text; })();
  await subscribed;
  assert.equal(promptCount(), 1);
  release();
  assert.match(await output, /completed/);
  assert.equal(promptCount(), 1, 'recovery must not repeat the original input');
  assert.deepEqual(await client.ackTurn(turn.turnId), { ok: true });
});
