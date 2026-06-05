import '../../setup/test-setup.js';
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getClaudeProjectDir } from '../../../runtime/claude/session-jsonl.js';
import { getSessionWorkingDirectory } from '../../../domain/session-runtime.js';
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

describe('UiBindingApplication', () => {
  beforeEach(() => {
    resetBridgeTestState();
  });

  it('materializes Claude Code sessions when assigning a binding or channel default', () => {
    withClaudeJsonl(({ cwd, sessionId }) => {
      const store = new JsonFileStore(makeBridgeSettings());
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
      assert.equal(getSessionWorkingDirectory(claudeSession), cwd);
      assert.equal(store.getChannelChat('feishu', 'chat-claude-binding')?.bridgeSessionId, claudeSession.id);
      assert.equal(defaultTarget.targetSessionId, claudeSession.id);
    });
  });
});
