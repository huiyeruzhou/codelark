import '../../setup/test-setup.js';
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { UiSessionApplication } from '../../../operator-ui/application/session.js';
import type { UiSessionClaudeSource, UiSessionCodexSource } from '../../../operator-ui/application/session-source.js';
import { JsonFileStore } from '../../../storage/json-store.js';
import { makeBridgeSettings, resetBridgeTestState } from '../../helpers/bridge/test-bridge-utils.js';
import { getClaudeProjectDir } from '../../../runtime/claude/session-jsonl.js';

function defaultEmptyCodexSource(): UiSessionCodexSource {
  return {
    listSessions: () => [],
    getSessionsRoot: () => '/tmp/codex-sessions',
    getThread: () => null,
    readJsonlHistory: () => [],
    archiveThread: () => false,
    readDefaultModel: () => 'test-model',
    defaultWorkingDirectory: () => '/tmp',
  };
}

describe('UiSessionApplication', () => {
  beforeEach(() => {
    resetBridgeTestState();
  });

  it('uses one injected Codex source for list, history, import, and archive use cases', () => {
    const store = new JsonFileStore(makeBridgeSettings());
    const archivedThreadIds: string[] = [];
    const thread = {
      threadId: 'codex-thread-ui-source',
      filePath: '/tmp/codex-thread-ui-source.jsonl',
      cwd: '/tmp/codex-ui-source',
      originator: 'Codex CLI',
      source: 'cli',
      firstSeenAt: '2026-05-30T00:00:00.000Z',
      lastEventAt: '2026-05-30T00:00:01.000Z',
      title: 'Codex UI Source',
      activeEstimate: false,
    };
    const codexSource: UiSessionCodexSource = {
      listSessions: () => [thread],
      getSessionsRoot: () => '/tmp/codex-sessions',
      getThread: (codexThreadId) => (codexThreadId === thread.threadId ? thread : null),
      readJsonlHistory: (codexThreadId) => (codexThreadId === thread.threadId ? [{
        signature: 'history-1',
        role: 'user',
        kind: 'codex:user_message',
        content: 'hello **session**',
        timestamp: '2026-05-30T00:00:02.000Z',
        rawJsonl: '{"type":"event_msg"}',
      }] : []),
      archiveThread(codexThreadId) {
        archivedThreadIds.push(codexThreadId);
        return codexThreadId === thread.threadId;
      },
      readDefaultModel: () => 'model-from-ui-source',
      defaultWorkingDirectory: () => '/tmp/default-ui-source',
    };
    const app = new UiSessionApplication(store, codexSource);

    const list = app.listSessions();
    assert.equal(list.root, '/tmp/codex-sessions');
    assert.equal(list.sessions[0]?.codexThreadId, thread.threadId);

    const history = app.getHistory({ codexThreadId: thread.threadId });
    assert.equal(history.source, 'codex');
    assert.equal(history.messages[0]?.rawJsonl, '{"type":"event_msg"}');
    assert.match(history.messages[0]?.renderedContent || '', /<strong>session<\/strong>/);

    const imported = app.importCodexThread(thread.threadId);
    assert.equal(imported.config.model, 'model-from-ui-source');
    assert.equal(store.getSession(imported.bridgeSessionId)?.runtime?.codex?.threadId, thread.threadId);

    const deleted = app.deleteSession({ codexThreadId: thread.threadId });
    assert.deepEqual(archivedThreadIds, [thread.threadId]);
    assert.deepEqual(deleted.deletedBridgeSessionIds, [imported.bridgeSessionId]);
  });

  it('uses the runtime source for unbound Claude Code list, history, import, rename, and archive use cases', () => {
    const store = new JsonFileStore(makeBridgeSettings());
    const archivedClaudeSessions: Array<{ sessionId: string; cwd: string }> = [];
    const cwd = '/tmp/claude-ui-runtime-source';
    const claudeThread = {
      sessionId: 'claude-ui-runtime-source',
      filePath: '/tmp/claude-ui-runtime-source.jsonl',
      cwd,
      title: 'Claude UI Runtime Source',
      firstSeenAt: '2026-06-02T00:00:00.000Z',
      updatedAt: '2026-06-02T00:00:03.000Z',
    };
    const claudeSource: UiSessionClaudeSource = {
      listSessions: () => [claudeThread],
      getThread: (sessionId, candidateCwd) => (
        sessionId === claudeThread.sessionId && candidateCwd === claudeThread.cwd ? claudeThread : null
      ),
      readJsonlHistory: (sessionId, candidateCwd) => (
        sessionId === claudeThread.sessionId && candidateCwd === claudeThread.cwd ? [{
          signature: 'claude-history-1',
          role: 'assistant',
          kind: 'claude:message',
          content: 'hello **claude ui**',
          timestamp: '2026-06-02T00:00:04.000Z',
          rawJsonl: '{"type":"assistant"}',
        }] : []
      ),
      archiveThread(sessionId, candidateCwd) {
        archivedClaudeSessions.push({ sessionId, cwd: candidateCwd });
        return sessionId === claudeThread.sessionId && candidateCwd === claudeThread.cwd;
      },
    };
    const app = new UiSessionApplication(store, defaultEmptyCodexSource(), claudeSource);

    const list = app.listSessions();
    const listed = list.sessions.find((session) => session.claudeSessionId === claudeThread.sessionId);
    assert.ok(listed);
    assert.equal(listed.kind, 'claude');
    assert.equal(listed.runtime, 'claude');
    assert.equal(listed.threadId, claudeThread.sessionId);
    assert.equal(listed.claudeCwd, cwd);

    const history = app.getHistory({ claudeSessionId: claudeThread.sessionId, claudeCwd: cwd });
    assert.equal(history.source, 'claude');
    assert.equal(history.messages[0]?.rawJsonl, '{"type":"assistant"}');
    assert.match(history.messages[0]?.renderedContent || '', /<strong>claude ui<\/strong>/);

    const imported = app.importClaudeThread(claudeThread.sessionId, cwd);
    assert.equal(imported.config.activeRuntime, 'claude');
    assert.equal(store.getSession(imported.bridgeSessionId)?.runtime?.claude?.sessionId, claudeThread.sessionId);
    assert.equal(store.getSession(imported.bridgeSessionId)?.runtime?.general?.workingDirectory, cwd);

    const renamed = app.renameSession({ claudeSessionId: claudeThread.sessionId, claudeCwd: cwd }, 'Renamed Claude');
    assert.equal(renamed.name, 'Renamed Claude');

    const deleted = app.deleteSession({ claudeSessionId: claudeThread.sessionId, claudeCwd: cwd });
    assert.deepEqual(archivedClaudeSessions, [{ sessionId: claudeThread.sessionId, cwd }]);
    assert.deepEqual(deleted.deletedBridgeSessionIds, [imported.bridgeSessionId]);
    assert.equal(store.getSession(imported.bridgeSessionId), null);
  });

  it('reads Claude Code transcript history for Claude runtime Bridge sessions', () => {
    const store = new JsonFileStore(makeBridgeSettings());
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-ui-claude-home-'));
    const previousHome = process.env.HOME;
    const previousClaudeHome = process.env.CODELARK_CLAUDE_HOME;
    process.env.HOME = homeDir;
    process.env.CODELARK_CLAUDE_HOME = homeDir;
    const cwd = path.join(homeDir, 'workspace');
    const session = store.createSession('Claude UI Session', 'test-model', undefined, cwd);
    const claudeSessionId = 'claude-ui-session';
    store.updateSession(session.id, {
      runtime: {
        activeRuntime: 'claude',
        claude: { sessionId: claudeSessionId, cwd },
        general: { workingDirectory: cwd },
      },
    });
    const projectDir = getClaudeProjectDir(cwd, homeDir);
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, `${claudeSessionId}.jsonl`), [
      JSON.stringify({
        type: 'user',
        uuid: 'user-ui-1',
        sessionId: claudeSessionId,
        cwd,
        timestamp: '2026-06-02T00:00:00.000Z',
        message: { role: 'user', content: 'hello ui claude' },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-ui-1',
        parentUuid: 'user-ui-1',
        sessionId: claudeSessionId,
        cwd,
        timestamp: '2026-06-02T00:00:01.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'ui claude **reply**' }] },
      }),
    ].join('\n') + '\n', 'utf-8');

    try {
      const history = new UiSessionApplication(store).getHistory({ bridgeSessionId: session.id });
      assert.equal(history.source, 'claude');
      assert.equal(history.messages.length, 1);
      assert.equal(history.messages.some((message) => message.content.includes('hello ui claude')), false);
      assert.match(history.messages[0]?.renderedContent || '', /<strong>reply<\/strong>/);
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      if (previousClaudeHome === undefined) {
        delete process.env.CODELARK_CLAUDE_HOME;
      } else {
        process.env.CODELARK_CLAUDE_HOME = previousClaudeHome;
      }
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('reads and updates Claude session-level config without writing Codex runtime state', () => {
    const store = new JsonFileStore(makeBridgeSettings());
    const session = store.createSession('Claude Config Session', 'codex-model', undefined, '/tmp/claude-config');
    store.updateSession(session.id, {
      runtime: {
        activeRuntime: 'claude',
        claude: {
          sessionId: 'claude-config-session',
          cwd: '/tmp/claude-config',
          model: 'initial-sonnet',
          permissionMode: 'plan',
          reasoningEffort: 'medium',
        },
        general: { workingDirectory: '/tmp/claude-config' },
      },
    });

    const app = new UiSessionApplication(store);
    const config = app.getConfig(session.id);
    assert.equal(config.activeRuntime, 'claude');
    assert.equal(config.claudeModel, 'initial-sonnet');
    assert.equal(config.claudePermissionMode, 'plan');
    assert.equal(config.claudeReasoningEffort, 'medium');

    const updated = app.updateConfig(session.id, {
      activeRuntime: 'claude',
      claudeModel: 'opus',
      claudePermissionMode: 'bypassPermissions',
      claudeReasoningEffort: 'high',
      model: 'should-not-write-codex',
      preferredMode: 'yolo',
      codexProvider: 'tmux',
    });

    assert.equal(updated.activeRuntime, 'claude');
    assert.equal(updated.claudeModel, 'opus');
    assert.equal(updated.claudePermissionMode, 'bypassPermissions');
    assert.equal(updated.claudeReasoningEffort, 'high');
    const stored = store.getSession(session.id);
    assert.equal(stored?.runtime?.activeRuntime, 'claude');
    assert.equal(stored?.runtime?.claude?.model, 'opus');
    assert.equal(stored?.runtime?.claude?.permissionMode, 'bypassPermissions');
    assert.equal(stored?.runtime?.claude?.reasoningEffort, 'high');
    assert.equal(stored?.runtime?.codex, undefined);
  });
});
