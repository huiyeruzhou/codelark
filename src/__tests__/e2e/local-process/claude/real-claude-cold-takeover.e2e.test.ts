import '../../../setup/test-setup.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { createTmuxCliCore } from '../../../../runtime/tmux/core.js';
import { readClaudeTmuxSessionId, waitForRuntimeTmuxReady } from '../../../../runtime/tmux/runtime.js';
import { inspectRuntimeTmuxInput, resetRuntimeTmuxInputStatesForTests, sendRuntimeTmuxInput } from '../../../../runtime/tmux/input-state-machine.js';
import { hasClaudePtyInputPrompt } from '../../../../runtime/claude/pty-provider.js';
import { commandAvailable, createShortTmuxTempDirectory, removeRuntimeTestDirectory, startLocalResponsesProxy, waitForCondition } from '../../../helpers/runtime/real-codex-e2e-utils.js';

const exec = promisify(execFile);

it('cold-takes over a real mature Claude without hints and retains its process for subsequent input', { timeout: 120_000 }, async (t) => {
  // This socket-based test targets Unix tmux; Windows launch/paste has separate coverage.
  if (process.platform === 'win32') return t.skip('requires Unix tmux sockets');
  const executable = process.env.CODELARK_REAL_CLAUDE_E2E_EXECUTABLE || 'claude';
  if (!await commandAvailable('tmux', ['-V'])
    || !await commandAvailable(executable, ['--version'], { ...process.env, CLAUDE_CODE_SIMPLE: '1' })) {
    return t.skip('requires tmux and Claude Code');
  }

  const root = createShortTmuxTempDirectory();
  const homeDir = path.join(root, 'home');
  const cwd = path.join(root, 'cwd');
  const socket = path.join(root, 'tmux.sock');
  const session = 'claude-cold-takeover';
  const sessionId = randomUUID();
  fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(homeDir, '.claude.json'), JSON.stringify({
    numStartups: 1, installMethod: 'npm', theme: 'dark', hasCompletedOnboarding: true,
    lastOnboardingVersion: '2.1.175', hasIdeOnboardingBeenShown: { vscode: true },
    projects: { [cwd]: { hasTrustDialogAccepted: true } },
  }));
  fs.writeFileSync(path.join(homeDir, '.claude/settings.json'), JSON.stringify({
    statusLine: { type: 'command', command: 'printf "QA local backend | context 42%%"' },
  }));
  const marker = 'COLD-TAKEOVER-RESPONSE-END';
  const responseText = Array.from({ length: 95 }, (_, i) => `History line ${i + 1}: isolated cold takeover.`).join('\n') + `\n${marker}`;
  const proxy = await startLocalResponsesProxy({ responseText });
  const env: NodeJS.ProcessEnv = {
    ...process.env, HOME: homeDir, USERPROFILE: homeDir, CLAUDE_CONFIG_DIR: path.join(homeDir, '.claude'),
    ANTHROPIC_BASE_URL: proxy.baseUrl.replace(/\/v1$/u, ''),
    ANTHROPIC_AUTH_TOKEN: 'isolated-local-fixture-token', ANTHROPIC_API_KEY: '',
    CLAUDE_CODE_SIMPLE: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
  delete env.TMUX;
  delete env.TMUX_PANE;
  const previousTmux = process.env.TMUX;
  const previousPane = process.env.TMUX_PANE;
  delete process.env.TMUX;
  delete process.env.TMUX_PANE;
  const tmux = async (args: string[]) => (await exec('tmux', ['-S', socket, ...args], { env })).stdout;
  const core = createTmuxCliCore({ prefixArgs: ['-S', socket] });
  const capture = async () => (await core.capturePane(session, 80)).screen;
  const panePid = async () => (await tmux(['display-message', '-p', '-t', session, '#{pane_pid}'])).trim();

  function completedTurns(): number {
    const projects = path.join(homeDir, '.claude/projects');
    if (!fs.existsSync(projects)) return 0;
    const file = fs.readdirSync(projects, { recursive: true, encoding: 'utf8' }).find((name) => name.endsWith(`${sessionId}.jsonl`));
    if (!file) return 0;
    return fs.readFileSync(path.join(projects, file), 'utf8').split('\n').filter((line) => {
      try {
        const record = JSON.parse(line);
        return record.type === 'assistant' && JSON.stringify(record.message?.content).includes(marker);
      } catch { return false; }
    }).length;
  }

  async function waitForReply(turn: number, prompt: string) {
    assert.equal(await waitForCondition(async () => completedTurns() >= turn
      && proxy.requests.some((r) => /\/messages(?:\?|$)/u.test(r.url) && r.rawBody.includes(prompt))
      && hasClaudePtyInputPrompt(await capture()), 20_000, 100), true,
    `turn ${turn} did not finish: ${await capture()}`);
  }
  try {
    await tmux(['-f', '/dev/null', 'new-session', '-d', '-s', session, '-x', '100', '-y', '24', '-c', cwd,
      executable, '--session-id', sessionId, '--model', 'claude-sonnet-4-5', '--tools', '']);
    assert.ok(fs.statSync(socket).isSocket());
    const pid = await panePid();
    assert.equal((await waitForRuntimeTmuxReady({ runtime: 'claude', sessionName: session, core })).ready, true);

    for (let turn = 1; turn <= 3; turn++) {
      const prompt = `LOCAL_HISTORY_ROUND_${turn}`;
      await core.sendActions(session, [{ type: 'literal', text: prompt }, { type: 'key', key: 'Enter' }], { delayMs: 100 });
      await waitForReply(turn, prompt);
    }
    const matureScreen = await capture();
    assert.doesNotMatch(matureScreen, /Claude\s+Code|for shortcuts|\/effort/iu);
    assert.match(matureScreen, /QA local backend/u);

    // Model the Bridge restart boundary, retaining the real Claude and tmux.
    resetRuntimeTmuxInputStatesForTests();
    const cold = await inspectRuntimeTmuxInput({ runtime: 'claude', sessionName: session, hasSession: () => core.hasSession(session) });
    assert.equal(cold.needsReadiness, true);
    const ready = await waitForRuntimeTmuxReady({ runtime: 'claude', sessionName: session, core, autoResolveSelection: false });
    assert.equal(ready.ready, true, ready.lastScreen);
    assert.equal(await readClaudeTmuxSessionId(session, core), sessionId);

    for (let turn = 4; turn <= 5; turn++) {
      const prompt = `AFTER_BRIDGE_RESTART_${turn}`;
      await sendRuntimeTmuxInput({ runtime: 'claude', sessionName: session,
        send: () => core.sendActions(session, [{ type: 'literal', text: prompt }, { type: 'key', key: 'Enter' }], { delayMs: 100 }),
      });
      await waitForReply(turn, prompt);
      assert.equal((await inspectRuntimeTmuxInput({ runtime: 'claude', sessionName: session, hasSession: () => core.hasSession(session) })).needsReadiness, false);
    }
    assert.equal(await panePid(), pid, 'cold takeover must preserve the existing Claude process');
    t.diagnostic(`retained Claude PID ${pid}; 3 history turns + 2 replies after cold takeover`);
  } finally {
    // Only this test owns this socket. Never clean up through an inherited TMUX.
    try {
      if (fs.existsSync(socket) && fs.statSync(socket).isSocket()) {
        const names = (await tmux(['list-sessions', '-F', '#{session_name}'])).trim().split('\n');
        if (names.includes(session)) await tmux(['kill-session', '-t', session]);
      }
    } finally {
      resetRuntimeTmuxInputStatesForTests();
      if (previousTmux === undefined) delete process.env.TMUX; else process.env.TMUX = previousTmux;
      if (previousPane === undefined) delete process.env.TMUX_PANE; else process.env.TMUX_PANE = previousPane;
      await proxy.close();
      removeRuntimeTestDirectory(root);
    }
  }
});
