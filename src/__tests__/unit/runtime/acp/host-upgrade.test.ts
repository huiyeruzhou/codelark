import '../../../setup/test-setup.js';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startAcpHostServer } from '../../../../runtime/acp/host-server.js';
import { acpHostEndpoint } from '../../../../runtime/acp/host-protocol.js';
import { tryConnectExistingAcpHost, getSharedAcpHostClient, detachSharedAcpHostClient, type AcpHostClient } from '../../../../runtime/acp/host-client.js';

async function shutdownTestHost(client: AcpHostClient | null): Promise<void> {
  if (!client?.connected) return;
  const { pid } = await client.hello();
  await client.shutdownHost(true);
  await client.waitForShutdown();
  if (pid === process.pid) return;
  // Socket closure precedes process exit. Windows retains the log file until
  // the detached child exits, so only then may its private home be removed.
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(`Test ACP host ${pid} did not exit after shutdown`);
}

it('rechecks a cached old host and upgrades only after active turns are finished and acknowledged', { timeout: 30000 }, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codelark-host-upgrade-'));
  let release!: () => void; const wait = new Promise<void>(r => release = r);
  const server = await startAcpHostServer({ socketPath: acpHostEndpoint(home), codeHash: 'previous-build', clientFactory: async () => ({
    connected: true, async request<T>(method: string): Promise<T> { if (method === 'session/new') return { sessionId: 'native' } as T; if (method === 'session/prompt') { await wait; return { stopReason: 'end_turn' } as T; } return {} as T; },
    notify() {}, respond() {}, reject() {}, onMessage() { return () => {}; }, onDisconnect() { return () => {}; }, close() {},
  }) });
  let current = await tryConnectExistingAcpHost(home); assert.ok(current);
  t.after(async () => { release(); await shutdownTestHost(current); detachSharedAcpHostClient(); await server.close(true); fs.rmSync(home, { recursive: true, force: true }); });
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

it('waits for a slow old host to finish closing before returning the replacement', { timeout: 15000 }, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codelark-host-slow-upgrade-'));
  let oldClosed = false;
  const server = await startAcpHostServer({ socketPath: acpHostEndpoint(home), codeHash: 'slow-previous-build', clientFactory: async () => ({
    connected: true,
    async request<T>(method: string): Promise<T> { return (method === 'session/new' ? { sessionId: 'native' } : {}) as T; },
    notify() {}, respond() {}, reject() {}, onMessage() { return () => {}; }, onDisconnect() { return () => {}; },
    async close() { await new Promise(resolve => setTimeout(resolve, 900)); oldClosed = true; },
  }) });
  let current = await tryConnectExistingAcpHost(home); assert.ok(current);
  t.after(async () => {
    await shutdownTestHost(current);
    await server.close(true);
    detachSharedAcpHostClient();
    fs.rmSync(home, { recursive: true, force: true });
  });
  await current.ensureSession({ sessionKey: 'doubao:slow', runtime: 'doubao', bridgeSessionId: 'slow', executable: 'fake', args: [], cwd: home, label: 'Test', fingerprint: 'slow', initializeParams: { protocolVersion: 1 } });
  current = await getSharedAcpHostClient(home);
  assert.equal(oldClosed, true, 'the old CLI must exit before a replacement is returned');
  assert.notEqual((await current.hello()).codeHash, 'slow-previous-build');
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(current.connected, true, 'the replacement must stay connected after old cleanup');
  if (process.platform !== 'win32') assert.equal(fs.existsSync(acpHostEndpoint(home)), true, 'old cleanup must not unlink the new socket');
});

it('does not retire a host while another client is loading a session', { timeout: 10000 }, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codelark-host-loading-'));
  let release!: () => void;
  let began!: () => void;
  const waiting = new Promise<void>(r => release = r);
  const loading = new Promise<void>(r => began = r);
  const server = await startAcpHostServer({ socketPath: acpHostEndpoint(home), clientFactory: async () => ({
    connected: true,
    async request<T>(method: string): Promise<T> { if (method === 'session/new') { began(); await waiting; return { sessionId: 'native' } as T; } return {} as T; },
    notify() {}, respond() {}, reject() {}, onMessage() { return () => {}; }, onDisconnect() { return () => {}; }, close() {},
  }) });
  const current = await tryConnectExistingAcpHost(home); assert.ok(current);
  let ready: Promise<unknown> | undefined;
  t.after(async () => { release(); await ready?.catch(() => {}); detachSharedAcpHostClient(); await server.close(true); fs.rmSync(home, { recursive: true, force: true }); });
  ready = current.ensureSession({ sessionKey: 'doubao:loading', runtime: 'doubao', bridgeSessionId: 'loading', executable: 'fake', args: [], cwd: home, label: 'Test', fingerprint: 'loading', initializeParams: { protocolVersion: 1 } });
  void ready.catch(() => {});
  await loading;
  assert.equal((await current.shutdownHost(false)).ok, false);
  release(); await ready;
  assert.equal((await current.getSessionStatus('doubao:loading'))?.state, 'ready');
});

it('rejects new work after accepting shutdown while the old CLI is still closing', { timeout: 10000 }, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codelark-host-draining-'));
  let release!: () => void;
  const closing = new Promise<void>(r => release = r);
  let starts = 0;
  const server = await startAcpHostServer({ socketPath: acpHostEndpoint(home), clientFactory: async () => {
    starts += 1;
    return {
      connected: true,
      async request<T>(method: string): Promise<T> { return (method === 'session/new' ? { sessionId: 'native' } : {}) as T; },
      notify() {}, respond() {}, reject() {}, onMessage() { return () => {}; }, onDisconnect() { return () => {}; },
      async close() { await closing; },
    };
  } });
  const current = await tryConnectExistingAcpHost(home); assert.ok(current);
  t.after(async () => { release(); detachSharedAcpHostClient(); await server.close(true); fs.rmSync(home, { recursive: true, force: true }); });
  const params = { sessionKey: 'doubao:draining', runtime: 'doubao' as const, bridgeSessionId: 'draining', executable: 'fake', args: [], cwd: home, label: 'Test', fingerprint: 'draining', initializeParams: { protocolVersion: 1 } };
  await current.ensureSession(params);
  assert.equal((await current.shutdownHost()).ok, true);
  await assert.rejects(current.ensureSession({ ...params, sessionKey: 'doubao:new' }), /正在关闭/);
  assert.equal(starts, 1);
  release();
  await current.waitForShutdown();
});
