import '../../setup/test-setup.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readBridgeRuntimeStatus, startBridgeControlService, type BridgeControlService } from '../../../bridge/control/service-discovery.js';
import { projectCodexBackendStatus, type BridgeRuntimeStatus } from '../../../bridge/session/display/codex-backend-status.js';

const roots: string[] = [];
const services: BridgeControlService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-runtime-status-'));
  roots.push(root);
  return { root, codelarkHome: path.join(root, 'home'), discoveryDirectory: path.join(root, 'discovery') };
}

it('authenticates one runtime status read without invoking session discovery or input handlers', async () => {
  const options = fixture();
  const session = { id: 'shared', runtime: { codex: { threadId: 'thread', appServerEndpoint: 'unix:///tmp/status.sock' } } };
  let reads = 0;
  let status: BridgeRuntimeStatus = {
    codexDefault: 'app-server-auto',
    sessions: { shared: projectCodexBackendStatus(session, { threadId: 'thread', connection: 'ready', activity: 'waiting' }) },
    appServers: [{ id: 'private', owner: 'bridge', state: 'running', connection: 'ready', pid: 123,
      sessionIds: ['shared'], endpoint: 'unix:///tmp/status.sock' }],
  };
  const service = await startBridgeControlService({
    ...options, runId: 'status-run',
    handlers: {
      listSessions: () => { throw new Error('runtime status must not list external sessions'); },
      receiveInput: () => { throw new Error('runtime status must not send input'); },
      runtimeStatus: () => { reads++; return status; },
    },
  });
  services.push(service);
  assert.equal((await fetch(`${service.descriptor.endpoint}/v1/runtime-status`)).status, 401);
  assert.equal(reads, 0);
  assert.deepEqual(await readBridgeRuntimeStatus(options), status);
  assert.equal(reads, 1);
  status = { codexDefault: 'legacy', sessions: {} };
  assert.deepEqual(await readBridgeRuntimeStatus(options), status, 'a new read must not retain the previous live snapshot');
  assert.equal(reads, 2);
});

it('only reads the requested Home and leaves unavailable descriptors untouched', async () => {
  const options = fixture();
  const calls = [0, 0];
  for (const index of [0, 1]) {
    const home = path.join(options.root, `home-${index}`);
    services.push(await startBridgeControlService({
      ...options, codelarkHome: home, runId: `run-${index}`,
      handlers: {
        listSessions: () => [], receiveInput: () => {},
        runtimeStatus: () => { calls[index]++; return { codexDefault: 'legacy', sessions: {} }; },
      },
    }));
  }
  assert.equal((await readBridgeRuntimeStatus({ ...options, codelarkHome: path.join(options.root, 'home-1') }))?.codexDefault, 'legacy');
  assert.deepEqual(calls, [0, 1]);
  assert.equal(await readBridgeRuntimeStatus(options), undefined);
  assert.deepEqual(calls, [0, 1]);
  const name = fs.readdirSync(options.discoveryDirectory).find((file) => {
    const descriptor = JSON.parse(fs.readFileSync(path.join(options.discoveryDirectory, file), 'utf8'));
    return descriptor.runId === 'run-1';
  })!;
  const descriptorPath = path.join(options.discoveryDirectory, name);
  const original = fs.readFileSync(descriptorPath, 'utf8');
  await services.pop()!.close();
  fs.writeFileSync(descriptorPath, original);
  assert.equal(await readBridgeRuntimeStatus({ ...options, codelarkHome: path.join(options.root, 'home-1') }), undefined);
  assert.equal(fs.readFileSync(descriptorPath, 'utf8'), original, 'a read must not probe PIDs or remove stale discovery records');
});

it('returns undefined for a previous Bridge without the optional handler', async () => {
  const options = fixture();
  services.push(await startBridgeControlService({
    ...options, runId: 'old-bridge', handlers: { listSessions: () => [], receiveInput: () => {} },
  }));
  assert.equal(await readBridgeRuntimeStatus(options), undefined);
});
