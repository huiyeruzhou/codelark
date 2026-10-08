import '../../setup/test-setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initBridgeTestContext } from '../../helpers/bridge/test-bridge-utils.js';
import { getRuntimeStatus } from '../../../bridge/host/manager.js';

test('manager projects the current store without preparing runtimes or writing session state', () => {
  const store = initBridgeTestContext();
  const fresh = store.createSession('fresh', 'fixture');
  const shared = store.createSession('shared', 'fixture');
  store.updateSession(shared.id, { runtime: { codex: { threadId: 'thread', appServerEndpoint: 'unix:///tmp/unused-status-fixture.sock' } } });
  store.createSession('other', 'fixture', undefined, undefined, undefined, { activeRuntime: 'claude' });
  store.createSession('hidden', 'fixture', undefined, undefined, undefined, { hidden: true });
  store.createSession('draft', 'fixture', undefined, undefined, undefined, { sessionType: 'draft' });
  const before = structuredClone(store.listSessions());
  const previous = process.env.CODELARK_CODEX_APP_SERVER;
  const previousEndpoint = process.env.CODELARK_CODEX_APP_SERVER_URL;
  try {
    delete process.env.CODELARK_CODEX_APP_SERVER_URL;
    process.env.CODELARK_CODEX_APP_SERVER = '0';
    assert.equal(getRuntimeStatus().codexDefault, 'legacy');
    process.env.CODELARK_CODEX_APP_SERVER_URL = 'unix:///tmp/configured-status-fixture.sock';
    assert.equal(getRuntimeStatus().codexDefault, 'app-server-auto', 'an explicit endpoint still selects app-server when automatic startup is disabled');
    delete process.env.CODELARK_CODEX_APP_SERVER_URL;
    delete process.env.CODELARK_CODEX_APP_SERVER;
    const status = getRuntimeStatus();
    assert.equal(status.codexDefault, 'app-server-auto');
    assert.deepEqual(Object.keys(status.sessions).sort(), [fresh.id, shared.id].sort());
    assert.equal(status.sessions[fresh.id].backend, 'unstarted');
    assert.equal(status.sessions[shared.id].connection, 'unknown');
    assert.equal(status.sessions[shared.id].activity, 'unknown');
    assert.deepEqual(status.appServers?.map((service) => [service.state, service.connection, service.sessionIds]), [['unknown', 'unknown', [shared.id]]]);
    assert.deepEqual(store.listSessions(), before);
  } finally {
    if (previous === undefined) delete process.env.CODELARK_CODEX_APP_SERVER;
    else process.env.CODELARK_CODEX_APP_SERVER = previous;
    if (previousEndpoint === undefined) delete process.env.CODELARK_CODEX_APP_SERVER_URL;
    else process.env.CODELARK_CODEX_APP_SERVER_URL = previousEndpoint;
  }
});
