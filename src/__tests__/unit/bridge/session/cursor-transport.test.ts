import '../../../setup/test-setup.js';
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { migrateCursorDesktopSessionIdentities, resolveCursorTransport, resolveCursorCapabilities } from '../../../../bridge/session/cursor-transport.js';
import { getSessionRuntimeProviderIdentity, setSessionCursorIdentityUpdate } from '../../../../domain/session-runtime.js';
import { createConfigService } from '../../../../configuration/service.js';
import { JsonFileStore } from '../../../../storage/json-store.js';
import { makeBridgeSettings, resetBridgeTestState } from '../../../helpers/bridge/test-bridge-utils.js';

describe('Cursor tmux provider and internal transport', () => {
  beforeEach(() => resetBridgeTestState());

  for (const legacyProvider of ['tmux', 'desktop'] as const) {
    it(`migrates ${legacyProvider} session state without changing the bound Desktop conversation`, () => {
      const store = new JsonFileStore(makeBridgeSettings());
      const session = store.createSession('Legacy Cursor', 'default', undefined, '/tmp/cursor');
      store.updateSession(session.id, { runtime: {
        activeRuntime: 'cursor', cursor: { sessionId: 'desktop-thread', cwd: '/tmp/cursor', provider: legacyProvider },
      } });
      const findThread = () => ({ sessionId: 'desktop-thread', sessionDir: '/tmp/cursor', transport: 'desktop' as const });
      assert.equal(migrateCursorDesktopSessionIdentities(store, findThread), 1);
      const migrated = store.getSession(session.id)!;
      assert.equal(migrated.runtime?.cursor?.provider, 'tmux');
      assert.equal(migrated.runtime?.cursor?.transport, 'desktop');
      assert.equal(migrated.runtime?.cursor?.sessionId, 'desktop-thread');
      assert.equal(getSessionRuntimeProviderIdentity(migrated), 'cursor:tmux');
      assert.equal(migrateCursorDesktopSessionIdentities(store, findThread), 0);
      assert.equal(resolveCursorTransport(migrated, () => { throw new Error('index offline'); }), 'desktop');
    });
  }

  it('clears the previous Desktop transport when resetting the Cursor identity for a fresh conversation', () => {
    const store = new JsonFileStore(makeBridgeSettings());
    const session = store.createSession('Reset Cursor', 'default', undefined, '/tmp/cursor');
    store.updateSession(session.id, { runtime: { activeRuntime: 'cursor', cursor: { sessionId: 'old-thread', provider: 'desktop' } } });
    store.updateSession(session.id, setSessionCursorIdentityUpdate(undefined, undefined));
    const fresh = store.getSession(session.id)!;
    assert.equal(resolveCursorTransport(fresh), 'cli');
    assert.equal(getSessionRuntimeProviderIdentity(fresh), 'cursor:tmux');
  });

  it('provider configuration cannot override a Desktop transport discovered from the bound thread', () => {
    const store = new JsonFileStore(makeBridgeSettings());
    const session = store.createSession('Cursor', 'default', undefined, '/tmp/cursor');
    store.updateSession(session.id, { runtime: { activeRuntime: 'cursor', cursor: { sessionId: 'thread', provider: 'tmux' } } });
    const persisted = store.getSession(session.id)!;
    createConfigService({ migrate: false }).set({ kind: 'session', sessionId: session.id }, { runtime: { cursor: { provider: 'tmux' } } });
    const findThread = () => ({ sessionId: 'thread', sessionDir: '/tmp/cursor', transport: 'desktop' as const });
    assert.deepEqual(resolveCursorCapabilities(persisted, findThread), {
      provider: 'tmux', transport: 'desktop', modelCatalog: 'unavailable', modelConfiguration: 'external',
    });
    assert.deepEqual(resolveCursorCapabilities(persisted, () => null), {
      provider: 'tmux', transport: 'cli', modelCatalog: 'cli', modelConfiguration: 'process-launch',
    });
  });
});
