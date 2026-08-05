import '../../setup/test-setup.js';
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { UiSessionApplication } from '../../../operator-ui/application/session.js';
import type { UiSessionClaudeSource, UiSessionCodexSource, UiSessionKimiSource } from '../../../operator-ui/application/session-source.js';
import { JsonFileStore } from '../../../storage/json-store.js';
import { makeBridgeSettings, resetBridgeTestState } from '../../helpers/bridge/test-bridge-utils.js';
import { getClaudeProjectDir } from '../../../runtime/claude/session-jsonl.js';
import { createConfigService } from '../../../configuration/service.js';

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

function defaultEmptyClaudeSource(): UiSessionClaudeSource {
  return {
    listSessions: () => [],
    getThread: () => null,
    readJsonlHistory: () => [],
    archiveThread: () => false,
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
    assert.equal(imported.config.model, '');
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

  it('uses the runtime source for unbound Kimi Code list, history, import, rename, and archive use cases', () => {
    const store = new JsonFileStore(makeBridgeSettings());
    const archivedKimiSessions: Array<{ sessionId: string; cwd: string }> = [];
    const cwd = '/tmp/kimi-ui-runtime-source';
    const kimiThread = {
      sessionId: 'session_kimi-ui-runtime-source',
      filePath: '/tmp/kimi-ui-runtime-source/wire.jsonl',
      cwd,
      title: 'Kimi UI Runtime Source',
      firstSeenAt: '2026-06-27T00:00:00.000Z',
      updatedAt: '2026-06-27T00:00:03.000Z',
    };
    const kimiSource: UiSessionKimiSource = {
      listSessions: () => [kimiThread],
      getThread: (sessionId, candidateCwd) => (
        sessionId === kimiThread.sessionId && candidateCwd === kimiThread.cwd ? kimiThread : null
      ),
      readJsonlHistory: (sessionId, candidateCwd) => (
        sessionId === kimiThread.sessionId && candidateCwd === kimiThread.cwd ? [{
          signature: 'kimi-history-1',
          role: 'assistant',
          kind: 'kimi:message',
          content: 'hello **kimi ui**',
          timestamp: '2026-06-27T00:00:04.000Z',
          rawJsonl: '{"type":"assistant"}',
        }] : []
      ),
      archiveThread(sessionId, candidateCwd) {
        archivedKimiSessions.push({ sessionId, cwd: candidateCwd });
        return sessionId === kimiThread.sessionId && candidateCwd === kimiThread.cwd;
      },
    };
    const app = new UiSessionApplication(store, defaultEmptyCodexSource(), defaultEmptyClaudeSource(), kimiSource);

    const list = app.listSessions();
    const listed = list.sessions.find((session) => session.kimiSessionId === kimiThread.sessionId);
    assert.ok(listed);
    assert.equal(listed.kind, 'kimi');
    assert.equal(listed.runtime, 'kimi');
    assert.equal(listed.threadId, kimiThread.sessionId);
    assert.equal(listed.kimiCwd, cwd);

    const history = app.getHistory({ kimiSessionId: kimiThread.sessionId, kimiCwd: cwd });
    assert.equal(history.source, 'kimi');
    assert.equal(history.messages[0]?.rawJsonl, '{"type":"assistant"}');
    assert.match(history.messages[0]?.renderedContent || '', /<strong>kimi ui<\/strong>/);

    const imported = app.importKimiThread(kimiThread.sessionId, cwd);
    assert.equal(imported.config.activeRuntime, 'kimi');
    assert.equal(store.getSession(imported.bridgeSessionId)?.runtime?.kimi?.sessionId, kimiThread.sessionId);
    assert.equal(store.getSession(imported.bridgeSessionId)?.runtime?.kimi?.provider, 'tmux');
    assert.equal(store.getSession(imported.bridgeSessionId)?.runtime?.general?.workingDirectory, cwd);

    const renamed = app.renameSession({ kimiSessionId: kimiThread.sessionId, kimiCwd: cwd }, 'Renamed Kimi');
    assert.equal(renamed.name, 'Renamed Kimi');

    const deleted = app.deleteSession({ kimiSessionId: kimiThread.sessionId, kimiCwd: cwd });
    assert.deepEqual(archivedKimiSessions, [{ sessionId: kimiThread.sessionId, cwd }]);
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

  it('filters user messages from Kimi Bridge fallback history', () => {
    const store = new JsonFileStore(makeBridgeSettings());
    const cwd = '/tmp/kimi-ui-bridge-fallback';
    const session = store.createSession('Kimi UI Bridge Fallback', 'test-model', undefined, cwd);
    store.updateSession(session.id, {
      runtime: {
        activeRuntime: 'kimi',
        kimi: {
          sessionId: 'session_kimi-ui-bridge-fallback',
          cwd,
          provider: 'tmux',
        },
        general: { workingDirectory: cwd },
      },
    });
    store.addMessage(session.id, 'user', 'hello ui kimi');
    store.addMessage(session.id, 'assistant', 'ui kimi **reply**');

    const history = new UiSessionApplication(store).getHistory({ bridgeSessionId: session.id });
    assert.equal(history.source, 'bridge');
    assert.equal(history.messages.length, 1);
    assert.equal(history.messages.some((message) => message.content.includes('hello ui kimi')), false);
    assert.match(history.messages[0]?.renderedContent || '', /<strong>reply<\/strong>/);
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
          model: 'legacy-sonnet',
          reasoningEffort: 'low',
        },
        general: { workingDirectory: '/tmp/claude-config' },
      },
    });
    const configService = createConfigService({ migrate: false, env: {} });
    configService.set(
      { kind: 'session', sessionId: session.id },
      {
        runtime: {
          claude: {
            model: 'initial-sonnet',
            reasoningEffort: 'medium',
          },
        },
      },
    );

    const app = new UiSessionApplication(store);
    const config = app.getConfig(session.id);
    assert.equal(config.activeRuntime, 'claude');
    assert.equal(config.claudeModel, 'initial-sonnet');
    assert.equal(config.claudeReasoningEffort, 'medium');

    const updated = app.updateConfig(session.id, {
      activeRuntime: 'claude',
      claudeModel: 'opus',
      claudeReasoningEffort: 'high',
      model: 'should-not-write-codex',
      preferredMode: 'yolo',
      codexProvider: 'tmux',
    });

    assert.equal(updated.activeRuntime, 'claude');
    assert.equal(updated.claudeModel, 'opus');
    assert.equal(updated.claudeReasoningEffort, 'high');
    const stored = store.getSession(session.id);
    assert.equal(stored?.runtime?.activeRuntime, 'claude');
    assert.equal(stored?.runtime?.claude?.model, 'legacy-sonnet');
    assert.equal(stored?.runtime?.claude?.reasoningEffort, 'low');
    assert.equal(stored?.runtime?.codex, undefined);
    assert.equal(configService.get('runtime.claude.model', { kind: 'session', sessionId: session.id }), 'opus');
    assert.equal(configService.get('runtime.claude.yoloMode', { kind: 'session', sessionId: session.id }), 'off');
    assert.equal(configService.get('runtime.claude.reasoningEffort', { kind: 'session', sessionId: session.id }), 'high');

    store.updateSession(session.id, {
      runtime: {
        activeRuntime: 'claude',
        claude: { model: undefined, reasoningEffort: undefined },
      },
    });
    const tomlBacked = app.getConfig(session.id);
    assert.equal(tomlBacked.claudeModel, 'opus');
    assert.equal(tomlBacked.claudeReasoningEffort, 'high');
  });

  it('writes Codex UI session-level config to session TOML', () => {
    const store = new JsonFileStore(makeBridgeSettings());
    const session = store.createSession('Codex Config Session', 'old-model', undefined, '/tmp/codex-config');
    const app = new UiSessionApplication(store);

    const updated = app.updateConfig(session.id, {
      activeRuntime: 'codex',
      workingDirectory: '/tmp/codex-config-next',
      systemPrompt: 'keep this in session json only',
      model: 'gpt-5.4',
      preferredMode: 'yolo',
      codexProvider: 'tmux',
      reasoningEffort: 'high',
      codexSandboxMode: 'read-only',
      codexNetworkAccess: false,
    });

    assert.equal(updated.workingDirectory, '/tmp/codex-config-next');
    assert.equal(updated.systemPrompt, 'keep this in session json only');
    assert.equal(updated.model, 'gpt-5.4');
    assert.equal(updated.preferredMode, 'yolo');
    assert.equal(updated.codexProvider, 'tmux');
    assert.equal(updated.reasoningEffort, 'high');
    assert.equal(updated.codexSandboxMode, 'read-only');
    assert.equal(updated.codexNetworkAccess, false);
    const stored = store.getSession(session.id);
    assert.equal(stored?.runtime?.codex?.model, undefined);
    assert.equal(stored?.runtime?.codex?.mode, undefined);
    assert.equal(stored?.runtime?.codex?.provider, undefined);
    assert.equal(stored?.runtime?.codex?.reasoningEffort, undefined);
    assert.equal(stored?.runtime?.codex?.sandboxMode, undefined);
    assert.equal(stored?.runtime?.codex?.networkAccess, undefined);
    assert.equal(stored?.runtime?.general?.workingDirectory, undefined);

    const configService = createConfigService({ migrate: false, env: {} });
    assert.equal(configService.get('session.workspace', { kind: 'session', sessionId: session.id }), '/tmp/codex-config-next');
    assert.equal(configService.get('runtime.codex.model', { kind: 'session', sessionId: session.id }), 'gpt-5.4');
    assert.equal(configService.get('runtime.codex.yoloMode', { kind: 'session', sessionId: session.id }), 'on');
    assert.equal(configService.get('runtime.codex.provider', { kind: 'session', sessionId: session.id }), 'tmux');
    assert.equal(configService.get('runtime.codex.reasoningEffort', { kind: 'session', sessionId: session.id }), 'high');
    assert.equal(configService.get('runtime.codex.sandboxMode', { kind: 'session', sessionId: session.id }), 'read-only');
    assert.equal(configService.get('runtime.codex.networkAccess', { kind: 'session', sessionId: session.id }), false);

    store.updateSession(session.id, {
      runtime: {
        codex: {
          model: undefined,
          mode: undefined,
          provider: undefined,
          reasoningEffort: undefined,
          sandboxMode: undefined,
          networkAccess: undefined,
        },
        general: { workingDirectory: undefined },
      },
    });
    const tomlBacked = app.getConfig(session.id);
    assert.equal(tomlBacked.workingDirectory, '/tmp/codex-config-next');
    assert.equal(tomlBacked.systemPrompt, 'keep this in session json only');
    assert.equal(tomlBacked.model, 'gpt-5.4');
    assert.equal(tomlBacked.preferredMode, 'yolo');
    assert.equal(tomlBacked.codexProvider, 'tmux');
    assert.equal(tomlBacked.reasoningEffort, 'high');
    assert.equal(tomlBacked.codexSandboxMode, 'read-only');
    assert.equal(tomlBacked.codexNetworkAccess, false);

    const reset = app.updateConfig(session.id, {
      activeRuntime: 'codex',
      model: '',
      codexProvider: '',
      reasoningEffort: '',
      codexSandboxMode: '',
      codexNetworkAccess: '',
    });
    assert.equal(reset.model, '');
    assert.equal(reset.codexProvider, '');
    assert.equal(reset.reasoningEffort, '');
    assert.equal(reset.codexSandboxMode, '');
    assert.equal(reset.codexNetworkAccess, undefined);
    assert.notEqual(configService.resolve('runtime.codex.model', { kind: 'session', sessionId: session.id }).source, 'session');
    assert.notEqual(configService.resolve('runtime.codex.provider', { kind: 'session', sessionId: session.id }).source, 'session');
    assert.notEqual(configService.resolve('runtime.codex.reasoningEffort', { kind: 'session', sessionId: session.id }).source, 'session');
    assert.notEqual(configService.resolve('runtime.codex.sandboxMode', { kind: 'session', sessionId: session.id }).source, 'session');
    assert.notEqual(configService.resolve('runtime.codex.networkAccess', { kind: 'session', sessionId: session.id }).source, 'session');
  });

  it('round-trips Cursor force and reasoning as inheritable session overrides', () => {
    const store = new JsonFileStore(makeBridgeSettings());
    const session = store.createSession('Cursor Config Session', 'codex-model', undefined, '/tmp/cursor-config');
    store.updateSession(session.id, {
      runtime: {
        activeRuntime: 'cursor',
        cursor: {
          sessionId: 'cursor-config-session',
          cwd: '/tmp/cursor-config',
        },
      },
    });
    const app = new UiSessionApplication(store);
    const configService = createConfigService({ migrate: false, env: {} });

    const enabled = app.updateConfig(session.id, {
      activeRuntime: 'cursor',
      cursorForce: true,
      cursorReasoningEffort: 'xhigh',
    });
    assert.equal(enabled.cursorForce, true);
    assert.equal(enabled.cursorReasoningEffort, 'xhigh');
    assert.equal(configService.resolve('runtime.cursor.force', { kind: 'session', sessionId: session.id }).source, 'session');
    assert.equal(configService.resolve('runtime.cursor.reasoningEffort', { kind: 'session', sessionId: session.id }).source, 'session');

    const inherited = app.updateConfig(session.id, {
      activeRuntime: 'cursor',
      cursorForce: '',
      cursorReasoningEffort: '',
    });
    assert.equal(inherited.cursorForce, undefined);
    assert.equal(inherited.cursorReasoningEffort, '');
    assert.notEqual(configService.resolve('runtime.cursor.force', { kind: 'session', sessionId: session.id }).source, 'session');
    assert.notEqual(configService.resolve('runtime.cursor.reasoningEffort', { kind: 'session', sessionId: session.id }).source, 'session');
  });

  it('writes Kimi UI session-level config to session TOML without writing Codex runtime state', () => {
    const store = new JsonFileStore(makeBridgeSettings());
    const session = store.createSession('Kimi Config Session', 'codex-model', undefined, '/tmp/kimi-config');
    store.updateSession(session.id, {
      runtime: {
        activeRuntime: 'kimi',
        kimi: {
          sessionId: 'session_kimi-config',
          cwd: '/tmp/kimi-config',
          model: 'legacy-kimi',
          provider: 'tmux',
        },
        general: { workingDirectory: '/tmp/kimi-config' },
      },
    });
    const configService = createConfigService({ migrate: false, env: {} });
    configService.set(
      { kind: 'session', sessionId: session.id },
      {
        runtime: {
          kimi: {
            model: 'initial-kimi',
            provider: 'tmux',
          },
        },
      },
    );

    const app = new UiSessionApplication(store);
    const config = app.getConfig(session.id);
    assert.equal(config.activeRuntime, 'kimi');
    assert.equal(config.kimiModel, 'initial-kimi');
    assert.equal(config.kimiProvider, 'tmux');

    const updated = app.updateConfig(session.id, {
      activeRuntime: 'kimi',
      kimiModel: 'kimi-k2',
      kimiProvider: 'tmux',
      model: 'should-not-write-codex',
      preferredMode: 'yolo',
    });

    assert.equal(updated.activeRuntime, 'kimi');
    assert.equal(updated.kimiModel, 'kimi-k2');
    assert.equal(updated.kimiProvider, 'tmux');
    const stored = store.getSession(session.id);
    assert.equal(stored?.runtime?.activeRuntime, 'kimi');
    assert.equal(stored?.runtime?.kimi?.model, 'legacy-kimi');
    assert.equal(stored?.runtime?.codex, undefined);
    assert.equal(configService.get('runtime.kimi.model', { kind: 'session', sessionId: session.id }), 'kimi-k2');
    assert.equal(configService.get('runtime.kimi.provider', { kind: 'session', sessionId: session.id }), 'tmux');
    assert.notEqual(configService.resolve('runtime.codex.model', { kind: 'session', sessionId: session.id }).source, 'session');
  });
});
