import '../../../setup/test-setup.js';
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { SessionRegistryService } from '../../../../bridge/session/registry.js';
import { getSessionWorkingDirectory } from '../../../../domain/session-runtime.js';
import { JsonFileStore } from '../../../../storage/json-store.js';
import { makeBridgeSettings, resetBridgeTestState } from '../../../helpers/bridge/test-bridge-utils.js';

describe('SessionRegistryService', () => {
  beforeEach(() => {
    resetBridgeTestState();
  });

  it('binds a chat to a BridgeSession using canonical service vocabulary', () => {
    const store = new JsonFileStore(makeBridgeSettings());
    const registry = new SessionRegistryService(store);
    const session = store.createSession('Bridge target', 'test-model', undefined, '/tmp/bridge-target');

    const binding = registry.attachChatToBridgeSession({
      channelType: 'feishu',
      chatId: 'chat-bridge',
      userId: 'ou_bridge',
      displayName: 'Bridge User',
    }, session.id);

    assert.ok(binding);
    assert.equal(binding.bridgeSessionId, session.id);
    assert.equal(binding.chatUserId, 'ou_bridge');
    assert.equal(store.getSession(session.id)?.name, 'Bridge target');
  });

  it('imports a Codex thread into a BridgeSession before binding the chat', () => {
    const store = new JsonFileStore(makeBridgeSettings());
    const registry = new SessionRegistryService(store);

    const binding = registry.importCodexThreadForChat({
      channelType: 'feishu',
      chatId: 'chat-codex-thread',
      displayName: 'Thread User',
    }, 'codex-thread-registry', {
      workingDirectory: '/tmp/codex-thread',
      displayName: 'Imported Codex Thread',
    });
    const session = store.getSession(binding.bridgeSessionId);

    assert.ok(session);
    assert.equal(session.runtime?.codex?.threadId, 'codex-thread-registry');
    assert.equal(session.name, 'Thread User');
    assert.equal(session.runtime?.codex?.title, 'Imported Codex Thread');
    assert.equal(getSessionWorkingDirectory(session), '/tmp/codex-thread');
  });

  it('materializes, renames, configures, and deletes BridgeSessions by canonical id', () => {
    const store = new JsonFileStore(makeBridgeSettings());
    const registry = new SessionRegistryService(store, {
      codexThreads: {
        getThread: (codexThreadId) => ({
          codexThreadId,
          title: 'Local Codex Thread',
          cwd: '/tmp/local-codex-thread',
        }),
      },
      readDefaultModel: () => 'model-from-port',
    });

    const materialized = registry.materializeCodexThread('codex-thread-materialized');
    assert.equal(materialized.runtime?.codex?.threadId, 'codex-thread-materialized');
    assert.equal(materialized.name, '');
    assert.equal(materialized.runtime?.codex?.title, 'Local Codex Thread');
    assert.equal(materialized.runtime?.codex?.model, undefined);

    const renamed = registry.renameBridgeSession(materialized.id, 'Renamed BridgeSession');
    assert.equal(renamed.name, 'Renamed BridgeSession');

    const configured = registry.updateBridgeSessionConfig(materialized.id, {
      runtime: { general: { systemPrompt: 'registry prompt' } },
    });
    assert.equal(configured.runtime?.general?.systemPrompt, 'registry prompt');

    const deleted = registry.deleteBridgeSession(materialized.id);
    assert.equal(deleted.deleted.id, materialized.id);
    assert.deepEqual(deleted.deletedBridgeSessionIds, [materialized.id]);
    assert.equal(store.getSession(materialized.id), null);
  });

  it('archives a Codex thread and deletes linked BridgeSessions', () => {
    const store = new JsonFileStore(makeBridgeSettings());
    let archivedThreadId = '';
    const registry = new SessionRegistryService(store, {
      codexThreads: {
        getThread: (codexThreadId) => ({
          codexThreadId,
          title: 'Archive target',
          cwd: '/tmp/archive-target',
        }),
        archiveThread: (codexThreadId) => {
          archivedThreadId = codexThreadId;
          return true;
        },
      },
      readDefaultModel: () => 'test-model',
    });
    const first = registry.materializeCodexThread('codex-thread-archive');
    const second = store.createSession('linked duplicate', 'test-model', undefined, '/tmp/archive-target');
    store.updateSessionCodexThreadId(second.id, 'codex-thread-archive');

    const result = registry.archiveCodexThread('codex-thread-archive');

    assert.equal(archivedThreadId, 'codex-thread-archive');
    assert.deepEqual(result.deletedBridgeSessionIds.sort(), [first.id, second.id].sort());
    assert.equal(store.getSession(first.id), null);
    assert.equal(store.getSession(second.id), null);
  });

  it('materializes and archives Claude Code sessions through the registry port', () => {
    const store = new JsonFileStore(makeBridgeSettings());
    const archived: Array<{ sessionId: string; cwd: string }> = [];
    const registry = new SessionRegistryService(store, {
      claudeThreads: {
        getThread: (claudeSessionId, cwd) => (
          claudeSessionId === 'claude-registry-session' && cwd === '/tmp/claude-registry'
            ? { claudeSessionId, title: 'Local Claude Session', cwd }
            : null
        ),
        archiveThread: (claudeSessionId, cwd) => {
          archived.push({ sessionId: claudeSessionId, cwd });
          return claudeSessionId === 'claude-registry-session' && cwd === '/tmp/claude-registry';
        },
      },
      readDefaultModel: () => 'model-from-port',
    });

    const materialized = registry.materializeClaudeThread('claude-registry-session', '/tmp/claude-registry');
    assert.equal(materialized.runtime?.activeRuntime, 'claude');
    assert.equal(materialized.runtime?.claude?.sessionId, 'claude-registry-session');
    assert.equal(getSessionWorkingDirectory(materialized), '/tmp/claude-registry');

    const renamed = registry.renameClaudeThread('claude-registry-session', '/tmp/claude-registry', 'Renamed Claude Session');
    assert.equal(renamed.name, 'Renamed Claude Session');

    const result = registry.archiveClaudeThread('claude-registry-session', '/tmp/claude-registry');
    assert.deepEqual(archived, [{ sessionId: 'claude-registry-session', cwd: '/tmp/claude-registry' }]);
    assert.deepEqual(result.deletedBridgeSessionIds, [materialized.id]);
    assert.equal(store.getSession(materialized.id), null);
  });

  it('materializes and archives Kimi Code sessions through the registry port', () => {
    const store = new JsonFileStore(makeBridgeSettings());
    const archived: Array<{ sessionId: string; cwd: string }> = [];
    const registry = new SessionRegistryService(store, {
      kimiThreads: {
        getThread: (kimiSessionId, cwd) => (
          kimiSessionId === 'session_kimi-registry-session' && cwd === '/tmp/kimi-registry'
            ? { kimiSessionId, title: 'Local Kimi Session', cwd }
            : null
        ),
        archiveThread: (kimiSessionId, cwd) => {
          archived.push({ sessionId: kimiSessionId, cwd });
          return kimiSessionId === 'session_kimi-registry-session' && cwd === '/tmp/kimi-registry';
        },
      },
      readDefaultModel: () => 'model-from-port',
    });

    const materialized = registry.materializeKimiThread('session_kimi-registry-session', '/tmp/kimi-registry');
    assert.equal(materialized.runtime?.activeRuntime, 'kimi');
    assert.equal(materialized.runtime?.kimi?.sessionId, 'session_kimi-registry-session');
    assert.equal(materialized.runtime?.kimi?.provider, 'tmux');
    assert.equal(getSessionWorkingDirectory(materialized), '/tmp/kimi-registry');

    const renamed = registry.renameKimiThread('session_kimi-registry-session', '/tmp/kimi-registry', 'Renamed Kimi Session');
    assert.equal(renamed.name, 'Renamed Kimi Session');

    const result = registry.archiveKimiThread('session_kimi-registry-session', '/tmp/kimi-registry');
    assert.deepEqual(archived, [{ sessionId: 'session_kimi-registry-session', cwd: '/tmp/kimi-registry' }]);
    assert.deepEqual(result.deletedBridgeSessionIds, [materialized.id]);
    assert.equal(store.getSession(materialized.id), null);
  });

  it('materializes and archives Cursor Agent sessions through the registry port', () => {
    const store = new JsonFileStore(makeBridgeSettings());
    const archived: Array<{ sessionId: string; cwd: string }> = [];
    const registry = new SessionRegistryService(store, {
      cursorThreads: {
        getThread: (cursorSessionId, cwd) => cursorSessionId === 'cursor-registry-session'
          ? { cursorSessionId, title: 'Local Cursor Session', cwd }
          : null,
        archiveThread: (cursorSessionId, cwd) => {
          archived.push({ sessionId: cursorSessionId, cwd });
          return true;
        },
      },
    });

    const materialized = registry.materializeCursorThread('cursor-registry-session', '/tmp/cursor-registry');
    assert.equal(materialized.runtime?.activeRuntime, 'cursor');
    assert.equal(materialized.runtime?.cursor?.sessionId, 'cursor-registry-session');
    assert.equal(materialized.runtime?.cursor?.provider, 'tmux');
    const result = registry.archiveCursorThread('cursor-registry-session', '/tmp/cursor-registry');
    assert.deepEqual(archived, [{ sessionId: 'cursor-registry-session', cwd: '/tmp/cursor-registry' }]);
    assert.deepEqual(result.deletedBridgeSessionIds, [materialized.id]);
  });

  it('materializes, renames, and archives ZCode sessions through the registry port', () => {
    const store = new JsonFileStore(makeBridgeSettings());
    const archived: Array<{ sessionId: string; cwd: string }> = [];
    const requestedCwd = '/tmp/zcode-registry';
    const canonicalCwd = '/private/tmp/zcode-registry';
    const registry = new SessionRegistryService(store, {
      zcodeThreads: {
        getThread: (zcodeSessionId) => zcodeSessionId === 'sess_zcode_registry'
          ? { zcodeSessionId, title: 'Local ZCode Session', cwd: canonicalCwd }
          : null,
        archiveThread: (zcodeSessionId, cwd) => {
          archived.push({ sessionId: zcodeSessionId, cwd });
          return true;
        },
      },
    });

    const materialized = registry.materializeZcodeThread('sess_zcode_registry', requestedCwd);
    assert.equal(materialized.runtime?.activeRuntime, 'zcode');
    assert.equal(materialized.runtime?.zcode?.sessionId, 'sess_zcode_registry');
    assert.equal(materialized.runtime?.zcode?.provider, 'tmux');
    assert.equal(getSessionWorkingDirectory(materialized), canonicalCwd);

    const renamed = registry.renameZcodeThread('sess_zcode_registry', requestedCwd, 'Renamed ZCode Session');
    assert.equal(renamed.name, 'Renamed ZCode Session');
    assert.equal(renamed.id, materialized.id);
    assert.equal(store.listSessions().length, 1);

    const result = registry.archiveZcodeThread('sess_zcode_registry', requestedCwd);
    assert.deepEqual(archived, [{ sessionId: 'sess_zcode_registry', cwd: canonicalCwd }]);
    assert.equal(result.cwd, canonicalCwd);
    assert.deepEqual(result.deletedBridgeSessionIds, [materialized.id]);
    assert.equal(store.getSession(materialized.id), null);
  });

});
