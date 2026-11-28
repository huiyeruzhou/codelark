import '../../../setup/test-setup.js';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startAcpHostServer } from '../../../../runtime/acp/host-server.js';
import { acpHostEndpoint } from '../../../../runtime/acp/host-protocol.js';
import { tryConnectExistingAcpHost, getSharedAcpHostClient, detachSharedAcpHostClient } from '../../../../runtime/acp/host-client.js';

it('rechecks a cached old host and upgrades only after active turns are finished and acknowledged', { timeout: 30000 }, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codelark-host-upgrade-'));
  let release!: () => void; const wait = new Promise<void>(r => release = r);
  const server = await startAcpHostServer({ socketPath: acpHostEndpoint(home), codeHash: 'previous-build', clientFactory: async () => ({
    connected: true, async request<T>(method: string): Promise<T> { if (method === 'session/new') return { sessionId: 'native' } as T; if (method === 'session/prompt') { await wait; return { stopReason: 'end_turn' } as T; } return {} as T; },
    notify() {}, respond() {}, reject() {}, onMessage() { return () => {}; }, onDisconnect() { return () => {}; }, close() {},
  }) });
  let current = await tryConnectExistingAcpHost(home); assert.ok(current);
  t.after(async () => { release(); await current?.shutdownHost(true).catch(() => {}); detachSharedAcpHostClient(); await server.close(true); fs.rmSync(home, { recursive: true, force: true }); });
  await current.ensureSession({ sessionKey: 'doubao:test', runtime: 'doubao', bridgeSessionId: 'test', executable: 'fake', args: [], cwd: home, label: 'Test', fingerprint: 'test', initializeParams: { protocolVersion: 1 } });
  const turn = await current.startTurn({ sessionKey: 'doubao:test', prompt: [{ type: 'text', text: 'test' }], meta: { runtime: 'doubao', bridgeSessionId: 'test' } });
  assert.equal(await getSharedAcpHostClient(home), current);
  release();
  for (let i = 0; i < 100 && (await current.getTurn(turn.turn.turnId))?.status === 'running'; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(await getSharedAcpHostClient(home), current); // unacked final card must survive
  await current.ackTurn(turn.turn.turnId);
  current = await getSharedAcpHostClient(home);
  assert.notEqual((await current.hello()).codeHash, 'previous-build');
});
