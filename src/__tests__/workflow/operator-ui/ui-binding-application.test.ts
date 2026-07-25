import '../../setup/test-setup.js';
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getClaudeProjectDir } from '../../../runtime/claude/session-jsonl.js';
import { getSessionWorkingDirectory } from '../../../domain/session-runtime.js';
import { createConfigService } from '../../../configuration/service.js';
import { JsonFileStore } from '../../../storage/json-store.js';
import { UiBindingApplication } from '../../../operator-ui/application/binding.js';
import { makeBridgeSettings, resetBridgeTestState } from '../../helpers/bridge/test-bridge-utils.js';

function withClaudeJsonl<T>(run: (input: { homeDir: string; cwd: string; sessionId: string }) => T): T {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-ui-binding-claude-home-'));
  const previousHome = process.env.HOME;
  const previousClaudeHome = process.env.CODELARK_CLAUDE_HOME;
  process.env.HOME = homeDir;
  process.env.CODELARK_CLAUDE_HOME = homeDir;
  const cwd = path.join(homeDir, 'workspace');
  const sessionId = 'claude-binding-session';
  const projectDir = getClaudeProjectDir(cwd, homeDir);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), `${JSON.stringify({
    type: 'assistant',
    uuid: 'assistant-binding-1',
    sessionId,
    cwd,
    timestamp: '2026-06-02T00:00:00.000Z',
    message: { role: 'assistant', content: [{ type: 'text', text: 'binding reply' }] },
  })}\n`, 'utf-8');

  try {
    return run({ homeDir, cwd, sessionId });
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousClaudeHome === undefined) delete process.env.CODELARK_CLAUDE_HOME;
    else process.env.CODELARK_CLAUDE_HOME = previousClaudeHome;
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
}

function withKimiWire<T>(run: (input: { homeDir: string; cwd: string; sessionId: string }) => T): T {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-ui-binding-kimi-home-'));
  const previousKimiHome = process.env.KIMI_CODE_HOME;
  process.env.KIMI_CODE_HOME = homeDir;
  const cwd = path.join(homeDir, 'workspace');
  const sessionId = 'session_kimi-binding-session';
  const sessionDir = path.join(homeDir, 'sessions', 'wd_workspace_test', sessionId);
  const wireDir = path.join(sessionDir, 'agents', 'main');
  fs.mkdirSync(wireDir, { recursive: true });
  fs.writeFileSync(path.join(wireDir, 'wire.jsonl'), `${JSON.stringify({
    type: 'context.append_loop_event',
    time: Date.parse('2026-06-27T00:00:00.000Z'),
    event: { type: 'content.part', part: { type: 'text', text: 'binding reply' } },
  })}\n`, 'utf-8');
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
    createdAt: '2026-06-27T00:00:00.000Z',
    updatedAt: '2026-06-27T00:00:01.000Z',
    title: 'Kimi binding session',
  }), 'utf-8');
  fs.writeFileSync(path.join(homeDir, 'session_index.jsonl'), `${JSON.stringify({
    sessionId,
    sessionDir,
    workDir: cwd,
  })}\n`, 'utf-8');

  try {
    return run({ homeDir, cwd, sessionId });
  } finally {
    if (previousKimiHome === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = previousKimiHome;
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
}

describe('UiBindingApplication', () => {
  beforeEach(() => {
    resetBridgeTestState();
  });

  it('materializes Claude Code sessions when assigning a binding or channel default', () => {
    withClaudeJsonl(({ cwd, sessionId }) => {
      const store = new JsonFileStore(makeBridgeSettings());
      createConfigService({ migrate: false, env: {} }).set({ kind: 'home' }, {
        runtime: {
          codex: { model: 'codex-binding-model' },
          claude: { model: 'claude-binding-model' },
        },
      });
      const oldSession = store.createSession('Old target', 'test-model', undefined, '/tmp/old');
      const binding = store.upsertChannelChat({
        channelType: 'feishu',
        chatId: 'chat-claude-binding',
        bridgeSessionId: oldSession.id,
      });
      const app = new UiBindingApplication(store);

      const defaultTarget = app.setChannelDefaultTarget({
        channelType: 'feishu',
        claudeSessionId: sessionId,
        claudeCwd: cwd,
      });
      const defaultSession = store.getSession(defaultTarget.targetSessionId);
      assert.ok(defaultSession);
      assert.equal(defaultSession.runtime?.activeRuntime, 'claude');
      assert.equal(defaultSession.runtime?.claude?.sessionId, sessionId);
      assert.equal(defaultTarget.targetRuntime, 'claude');
      assert.equal(defaultTarget.targetRuntimeThreadId, sessionId);
      assert.equal(defaultTarget.targetClaudeCwd, cwd);
      assert.equal(defaultTarget.mode, 'normal');
      assert.equal(defaultTarget.executionProvider, 'tmux');
      assert.equal(store.getChannelDefaultTarget('feishu')?.bridgeSessionId, defaultSession.id);

      const updated = app.switchBindingTarget({
        bindingId: binding.id,
        claudeSessionId: sessionId,
        claudeCwd: cwd,
      });
      const claudeSession = store.getSession(updated.currentSessionId);
      assert.ok(claudeSession);
      assert.equal(claudeSession.runtime?.activeRuntime, 'claude');
      assert.equal(claudeSession.runtime?.claude?.sessionId, sessionId);
      assert.equal(updated.currentRuntime, 'claude');
      assert.equal(updated.currentRuntimeThreadId, sessionId);
      assert.equal(updated.currentClaudeCwd, cwd);
      assert.equal(updated.mode, 'normal');
      assert.equal(updated.executionProvider, 'tmux');
      assert.equal(updated.model, 'claude-binding-model');
      assert.equal(getSessionWorkingDirectory(claudeSession), cwd);
      assert.equal(store.getChannelChat('feishu', 'chat-claude-binding')?.bridgeSessionId, claudeSession.id);
      assert.equal(defaultTarget.targetSessionId, claudeSession.id);
    });
  });

  it('materializes Kimi Code sessions when assigning a binding or channel default', () => {
    withKimiWire(({ cwd, sessionId }) => {
      const store = new JsonFileStore(makeBridgeSettings());
      createConfigService({ migrate: false, env: {} }).set({ kind: 'home' }, {
        runtime: {
          codex: { model: 'codex-binding-model', yoloMode: 'on' },
          kimi: { model: 'kimi-binding-model' },
        },
      });
      const oldSession = store.createSession('Old target', 'test-model', undefined, '/tmp/old');
      const binding = store.upsertChannelChat({
        channelType: 'feishu',
        chatId: 'chat-kimi-binding',
        bridgeSessionId: oldSession.id,
      });
      const app = new UiBindingApplication(store);

      const defaultTarget = app.setChannelDefaultTarget({
        channelType: 'feishu',
        kimiSessionId: sessionId,
        kimiCwd: cwd,
      });
      const defaultSession = store.getSession(defaultTarget.targetSessionId);
      assert.ok(defaultSession);
      assert.equal(defaultSession.runtime?.activeRuntime, 'kimi');
      assert.equal(defaultSession.runtime?.kimi?.sessionId, sessionId);
      assert.equal(defaultSession.runtime?.kimi?.provider, 'tmux');
      assert.equal(defaultTarget.targetRuntime, 'kimi');
      assert.equal(defaultTarget.targetRuntimeThreadId, sessionId);
      assert.equal(defaultTarget.targetKimiCwd, cwd);
      assert.equal(defaultTarget.mode, 'normal');
      assert.equal(defaultTarget.codexProvider, 'default');
      assert.equal(defaultTarget.executionProvider, 'tmux');
      assert.equal(store.getChannelDefaultTarget('feishu')?.bridgeSessionId, defaultSession.id);

      const updated = app.switchBindingTarget({
        bindingId: binding.id,
        kimiSessionId: sessionId,
        kimiCwd: cwd,
      });
      const kimiSession = store.getSession(updated.currentSessionId);
      assert.ok(kimiSession);
      assert.equal(kimiSession.runtime?.activeRuntime, 'kimi');
      assert.equal(kimiSession.runtime?.kimi?.sessionId, sessionId);
      assert.equal(updated.currentRuntime, 'kimi');
      assert.equal(updated.currentRuntimeThreadId, sessionId);
      assert.equal(updated.currentKimiCwd, cwd);
      assert.equal(updated.mode, 'normal');
      assert.equal(updated.codexProvider, 'default');
      assert.equal(updated.executionProvider, 'tmux');
      assert.equal(updated.model, 'kimi-binding-model');
      assert.equal(getSessionWorkingDirectory(kimiSession), cwd);
      assert.equal(store.getChannelChat('feishu', 'chat-kimi-binding')?.bridgeSessionId, kimiSession.id);
      assert.equal(defaultTarget.targetSessionId, kimiSession.id);
    });
  });
});
