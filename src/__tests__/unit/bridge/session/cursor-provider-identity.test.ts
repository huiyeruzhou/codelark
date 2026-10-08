import '../../../setup/test-setup.js';
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  migrateCursorDesktopSessionIdentities,
  resolveCursorExecutionProvider,
} from '../../../../bridge/session/cursor-provider-identity.js';
import { JsonFileStore } from '../../../../storage/json-store.js';
import { makeBridgeSettings, resetBridgeTestState } from '../../../helpers/bridge/test-bridge-utils.js';

describe('Cursor provider identity compatibility', () => {
  beforeEach(() => resetBridgeTestState());

  it('migrates a persisted tmux identity when the same thread exists in Cursor Desktop', () => {
    const store = new JsonFileStore(makeBridgeSettings());
    const session = store.createSession('Legacy Cursor binding', 'default', undefined, '/tmp/cursor');
    store.updateSession(session.id, {
      runtime: {
        activeRuntime: 'cursor',
        cursor: { sessionId: 'cursor-thread', cwd: '/tmp/cursor', provider: 'tmux' },
      },
    });

    const migrated = migrateCursorDesktopSessionIdentities(store, () => ({
      sessionId: 'cursor-thread',
      cwd: '/tmp/cursor',
      title: 'Desktop thread',
      sessionDir: '/tmp/cursor-session',
      provider: 'desktop',
    }));

    assert.equal(migrated, 1);
    assert.equal(store.getSession(session.id)?.runtime?.cursor?.provider, 'desktop');
  });

  it('routes a legacy identity to Desktop immediately while honoring an explicit tmux override', () => {
    const store = new JsonFileStore(makeBridgeSettings());
    const session = store.createSession('Legacy Cursor binding', 'default', undefined, '/tmp/cursor');
    store.updateSession(session.id, {
      runtime: {
        activeRuntime: 'cursor',
        cursor: { sessionId: 'cursor-thread', cwd: '/tmp/cursor', provider: 'tmux' },
      },
    });
    const persisted = store.getSession(session.id)!;
    const findDesktop = () => ({
      sessionId: 'cursor-thread',
      cwd: '/tmp/cursor',
      title: 'Desktop thread',
      sessionDir: '/tmp/cursor-session',
      provider: 'desktop' as const,
    });

    assert.equal(resolveCursorExecutionProvider(persisted, {
      findThread: findDesktop,
      readSessionOverride: () => undefined,
    }), 'desktop');
    assert.equal(resolveCursorExecutionProvider(persisted, {
      findThread: findDesktop,
      readSessionOverride: () => 'tmux',
    }), 'tmux');
  });
});
