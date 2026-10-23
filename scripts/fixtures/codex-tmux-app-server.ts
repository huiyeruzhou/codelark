import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createTmuxCliCore } from '../../src/runtime/tmux/core.js';
import { startCodexAppServerView } from '../../src/bridge/tmux/runtime.js';
import type { CodexAppServerSession } from '../../src/runtime/codex/app-server-registry.js';
import { CodexAppServerClient } from '../../src/runtime/codex/app-server-client.js';
import type { AppServerThread } from '../../src/runtime/codex/app-server-events.js';
import { buildCodexTuiSelectionChoiceActions, parseCodexTuiSelectionPrompt } from '../../src/runtime/codex/tmux-provider.js';
import { startFixtureModel, textInput, waitFor } from './codex-app-server-lifecycle.js';

/** Real remote TUI view: observing or closing it must not take over execution. */
export async function verifyCodexTmuxAppServerView(
  session: CodexAppServerSession,
  model: Awaited<ReturnType<typeof startFixtureModel>>,
  evidence: string,
) {
  assert.notEqual(process.platform, 'win32', 'this verifier requires native tmux');
  const directory = fs.mkdtempSync(path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'clk-view-'));
  const socket = path.join(directory, 'tmux.sock');
  const prefix = ['-u', 'TMUX', '-u', 'TMUX_PANE', 'tmux', '-S', socket];
  const exec = promisify(execFile);
  const tmux = (...args: string[]) => exec('/usr/bin/env', [...prefix, ...args], { timeout: 10_000 });
  const core = createTmuxCliCore({ executable: '/usr/bin/env', prefixArgs: prefix });
  const anchor = 'compat_anchor', view = 'compat_remote_view';
  const initialRequests = model.requests.length;
  let verified = false;
  let held: { release(): void } | undefined;
  let steered: { release(): void } | undefined;
  try {
    // Native TUI creates a separate hidden model thread to title unnamed chats.
    // This fixture tests execution ownership; give it a name before attaching
    // so background title generation cannot consume scripted turn responses.
    const namingClient = await CodexAppServerClient.connect(session.endpoint);
    try {
      await namingClient.request('thread/name/set', { threadId: session.threadId, name: 'CodeLark remote view compatibility' });
    } finally { namingClient.close(); }
    await tmux('new-session', '-d', '-s', anchor, '-x', '140', '-y', '40');
    const actualSocket = (await tmux('display-message', '-p', '-t', anchor, '#{socket_path}')).stdout.trim();
    assert.equal(fs.realpathSync(actualSocket), fs.realpathSync(socket));
    assert(fs.statSync(socket).isSocket()); verified = true;
    const launch = await startCodexAppServerView({ sessionName: view, bridgeSessionId: 'default-native',
      threadId: session.threadId, remoteEndpoint: session.endpoint, workingDirectory: process.cwd() }, core);
    assert(launch.codexCommand.includes('--remote'));
    let acceptedFixtureMigration = false;
    const screen = await waitFor(async () => {
      const { screen } = await core.capturePane(`${view}:0.0`, 100);
      fs.writeFileSync(path.join(evidence, 'remote-view-last-screen.txt'), screen);
      const prompt = parseCodexTuiSelectionPrompt(screen);
      if (!acceptedFixtureMigration && prompt?.kind === 'model_migration') {
        // Explicit test-user choice for this isolated fixture, never a product default.
        await core.sendActions(`${view}:0.0`, buildCodexTuiSelectionChoiceActions(prompt, prompt.options[0].choice));
        acceptedFixtureMigration = true;
      }
      return screen.includes('DEFAULT_PRIVATE_NATIVE_REPLY') && screen;
    }, 'remote tmux renders the existing app-server thread');
    fs.writeFileSync(path.join(evidence, 'remote-view.txt'), screen);
    assert.equal(model.requests.length, initialRequests, 'opening a view must not submit another turn');

    held = model.enqueue({ text: 'VIEW_MUST_NOT_COMPLETE_INTERRUPTED_TURN' }, true);
    steered = model.enqueue({ text: 'STEER_MUST_NOT_COMPLETE_INTERRUPTED_TURN' }, true);
    const turnId = await session.lifecycle.submit(session.threadId, textInput('RUN_WITH_REMOTE_VIEW'));
    await waitFor(() => model.requests.length > initialRequests, 'model running with remote view');
    assert.equal(await session.lifecycle.submit(session.threadId, textInput('STEER_WITH_REMOTE_VIEW')), turnId);
    held.release();
    await waitFor(() => model.requests.length === initialRequests + 2, 'model consumes the steered input');
    assert(JSON.stringify(model.requests.at(-1)?.body.input).includes('STEER_WITH_REMOTE_VIEW'));
    await core.killSession(`=${view}`);
    await session.lifecycle.refresh(session.threadId);
    assert.equal(session.lifecycle.snapshot(session.threadId).activity, 'active', 'closing the view must preserve the running backend turn');
    assert.equal(session.lifecycle.snapshot(session.threadId).turnId, turnId);
    assert.equal(await session.lifecycle.interrupt(session.threadId, turnId), true);
    await waitFor(() => session.lifecycle.snapshot(session.threadId).activity === 'idle', 'interrupt after view exits');
    const client = await CodexAppServerClient.connect(session.endpoint);
    try {
      const response = await client.request<{ thread: AppServerThread }>('thread/read', { threadId: session.threadId, includeTurns: true });
      assert.equal(response.thread.turns?.find(turn => turn.id === turnId)?.status, 'interrupted');
      fs.writeFileSync(path.join(evidence, 'remote-view-interrupted.json'), JSON.stringify(response, null, 2));
    } finally { client.close(); }
    assert.equal(model.requests.length, initialRequests + 2, 'only the initial input and its steer reached the model');
    return { socket: actualSocket, threadId: session.threadId, turnId, acceptedFixtureMigration, existingHistoryRendered: true,
      steerSameTurn: true, viewExitPreservedRunningTurn: true, interruptAfterViewExit: true, extraModelRequests: 2 };
  } finally {
    held?.release();
    steered?.release();
    if (verified) {
      await core.killSession(`=${view}`, { ignoreMissing: true });
      await core.killSession(`=${anchor}`, { ignoreMissing: true });
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
}
