import '../../../setup/test-setup.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { createTmuxCliCore, _testOnlyTmuxCore } from '../../../../bridge/tmux/core.js';
import { startClaudeTmuxSession, waitForRuntimeTmuxReady, readClaudeTmuxSessionId } from '../../../../bridge/tmux/runtime.js';
import { resetRuntimeTmuxInputStatesForTests } from '../../../../bridge/tmux/input-state-machine.js';
import { getClaudeProjectDir } from '../../../../runtime/claude/session-jsonl.js';
import { hasClaudePtyInputPrompt } from '../../../../runtime/claude/pty-provider.js';
import { handleBridgeCommand } from '../../../../bridge/command/index.js';
import { createConfigService } from '../../../../configuration/service.js';
import * as router from '../../../../bridge/host/channel-router.js';
import { initBridgeTestContext } from '../../../helpers/bridge/test-bridge-utils.js';
import { _testOnlyWaitForDeliveryQueuesForTests } from '../../../../channels/delivery/deliver.js';
import { commandAvailable, createShortTmuxTempDirectory, removeRuntimeTestDirectory, startLocalResponsesProxy, waitForCondition } from '../../../helpers/runtime/real-codex-e2e-utils.js';

const exec = promisify(execFile);

it('persists Claude replies under polluted parent/server environments and auto-upgrades a real legacy window', { timeout: 120_000 }, async (t) => {
  if (process.platform === 'win32') return t.skip('requires Unix tmux sockets');
  const executable = process.env.CODELARK_REAL_CLAUDE_E2E_EXECUTABLE || 'claude';
  if (!await commandAvailable('tmux', ['-V']) || !await commandAvailable(executable, ['--version'], { ...process.env, CLAUDE_CODE_SIMPLE: '1' })) {
    return t.skip('requires real Claude Code and tmux');
  }
  const root = createShortTmuxTempDirectory();
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'cwd');
  const socket = path.join(root, 'tmux.sock');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(cwd);
  const onboarding = JSON.stringify({ numStartups: 1, theme: 'dark', hasCompletedOnboarding: true,
    lastOnboardingVersion: '2.1.175', projects: { [cwd]: { hasTrustDialogAccepted: true } } });
  fs.writeFileSync(path.join(home, '.claude.json'), onboarding);
  fs.writeFileSync(path.join(home, '.claude/.claude.json'), onboarding);
  const answer = 'PERSISTENT_UPGRADE_REPLY';
  const proxy = await startLocalResponsesProxy({ responseText: answer });
  const previous = { ...process.env };
  Object.assign(process.env, {
    HOME: home, USERPROFILE: home, CODELARK_CLAUDE_HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    ANTHROPIC_BASE_URL: proxy.baseUrl.replace(/\/v1$/u, ''), ANTHROPIC_AUTH_TOKEN: 'local-mock-token', ANTHROPIC_API_KEY: '',
    CLAUDE_CODE_SIMPLE: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1',
  });
  delete process.env.TMUX;
  delete process.env.TMUX_PANE;
  const tmux = async (args: string[]) => (await exec('tmux', ['-S', socket, ...args], { env: process.env })).stdout;
  const core = createTmuxCliCore({ prefixArgs: ['-S', socket] });
  _testOnlyTmuxCore.replace(core);
  const names = ['keeper'];
  const project = getClaudeProjectDir(fs.realpathSync(cwd), home);
  const jsonls = () => fs.existsSync(project) ? fs.readdirSync(project).filter((name) => name.endsWith('.jsonl')) : [];
  const records = (id: string): any[] => {
    const file = path.join(project, `${id}.jsonl`);
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  };
  const sentToApi = (prompt: string) => proxy.requests.some((r) => /\/messages(?:\?|$)/u.test(r.url) && r.rawBody.includes(prompt));
  async function sendDirect(name: string, prompt: string) {
    await core.sendActions(name, [{ type: 'literal', text: prompt }, { type: 'key', key: 'Enter' }], { delayMs: 100 });
    assert.equal(await waitForCondition(() => sentToApi(prompt), 15_000, 100), true);
    assert.equal(await waitForCondition(async () => {
      const screen = (await core.capturePane(name, 80)).screen;
      return screen.includes(answer) && hasClaudePtyInputPrompt(screen);
    }, 10_000, 100), true);
  }
  async function waitForTranscript(id: string, prompt: string) {
    assert.equal(await waitForCondition(() => records(id).some((r) => r.type === 'user' && JSON.stringify(r.message?.content).includes(prompt))
      && records(id).some((r) => r.type === 'assistant' && JSON.stringify(r.message?.content).includes(answer)), 10_000, 100), true,
    'the real CLI must persist both input and response, not merely accept the prompt');
  }
  try {
    // Keep a tmux server born with the inherited flags alive throughout this test.
    await tmux(['-f', '/dev/null', 'new-session', '-d', '-s', 'keeper', '-x', '100', '-y', '24', 'cat']);
    assert.ok(fs.statSync(socket).isSocket());

    const badId = randomUUID();
    const bad = 'claude-polluted-baseline';
    names.push(bad);
    await tmux(['new-session', '-d', '-s', bad, '-x', '100', '-y', '24', '-c', cwd,
      'env', '-u', 'CLAUDECODE', executable, '--session-id', badId, '--model', 'claude-sonnet-4-5', '--tools', '']);
    assert.equal((await waitForRuntimeTmuxReady({ runtime: 'claude', sessionName: bad, core })).ready, true);
    await sendDirect(bad, 'BASELINE_CHILD_SESSION');
    assert.equal(fs.existsSync(path.join(project, `${badId}.jsonl`)), false,
      'negative control: inherited child-session marker must reproduce missing transcripts');
    await tmux(['kill-session', '-t', bad]);
    names.splice(names.indexOf(bad), 1);

    const clean = 'claude-polluted-parent-fixed';
    names.push(clean);
    const started = await startClaudeTmuxSession({ sessionName: clean, bridgeSessionId: randomUUID(), workingDirectory: cwd,
      model: 'claude-sonnet-4-5', core, waitReady: true });
    const cleanId = await readClaudeTmuxSessionId(clean, core);
    assert.equal(started.ready, true);
    await sendDirect(clean, 'CLEAN_CHILD_SESSION');
    await waitForTranscript(cleanId, 'CLEAN_CHILD_SESSION');
    assert.equal(process.env.CLAUDE_CODE_CHILD_SESSION, '1', 'the parent remains polluted for the migration regression');

    const store = initBridgeTestContext({ dynamicSettings: true });
    const address = { channelType: 'feishu', chatId: 'real-legacy-claude-upgrade' } as const;
    const binding = router.createBinding(address, cwd);
    const legacy = `claude_${binding.bridgeSessionId}`;
    names.push(legacy);
    const beforeFiles = new Set(jsonls());
    // This is the old launch shape: no --session-id or --resume argument.
    await tmux(['new-session', '-d', '-s', legacy, '-x', '100', '-y', '24', '-c', cwd,
      'env', '-u', 'CLAUDECODE', '-u', 'CLAUDE_CODE_CHILD_SESSION', executable, '--model', 'claude-sonnet-4-5', '--tools', '']);
    assert.equal((await waitForRuntimeTmuxReady({ runtime: 'claude', sessionName: legacy, core })).ready, true);
    await sendDirect(legacy, 'ORIGINAL_LEGACY_HISTORY');
    const created = jsonls().filter((file) => !beforeFiles.has(file));
    assert.equal(created.length, 1, 'fixture identity comes from the isolated legacy CLI itself');
    const originalId = created[0]!.replace(/\.jsonl$/u, '');
    await waitForTranscript(originalId, 'ORIGINAL_LEGACY_HISTORY');
    const pid = async () => (await tmux(['display-message', '-p', '-t', legacy, '#{pane_pid}'])).trim();
    const oldPid = await pid();
    store.updateSession(binding.bridgeSessionId, { runtime: { activeRuntime: 'claude', claude: { sessionId: originalId, cwd }, general: { tmuxSessionName: legacy } } });
    createConfigService({ migrate: false, env: {} }).set({ kind: 'session', sessionId: binding.bridgeSessionId }, { runtime: { claude: { provider: 'tmux', model: 'claude-sonnet-4-5' } } });
    resetRuntimeTmuxInputStatesForTests();
    const replies: string[] = [];
    let forwarded = 0;
    const adapter: any = { channelType: 'feishu', send: async (m: { text: string }) => { replies.push(m.text); return { ok: true, messageId: `reply-${replies.length}` }; } };
    async function forward(prompt: string) {
      await handleBridgeCommand(adapter, { address, text: prompt, messageId: prompt, timestamp: Date.now() }, `/tmux ${prompt}`, {
        getActiveTask: () => undefined, diagnoseSessionHealth: async () => null, diagnoseAllActiveSessions: async () => [],
        tmuxProviderAutoForward: true,
        onTmuxProviderAutoForwarded: () => { forwarded += 1; },
      });
      await _testOnlyWaitForDeliveryQueuesForTests(adapter);
      assert.deepEqual(replies, [], 'the original input must recover automatically without a manual /p tmux error');
      assert.equal(await waitForCondition(() => sentToApi(prompt), 15_000, 100), true);
      await waitForTranscript(originalId, prompt);
      assert.equal(records(originalId).filter((r) => r.type === 'user' && JSON.stringify(r.message?.content).includes(prompt)).length, 1);
    }
    await forward('AUTOMATIC_UPGRADE_ORIGINAL_MESSAGE');
    const newPid = await pid();
    assert.notEqual(newPid, oldPid);
    assert.equal(await readClaudeTmuxSessionId(legacy, core), originalId);
    await forward('AUTOMATIC_UPGRADE_SECOND_MESSAGE');
    assert.equal(await pid(), newPid, 'subsequent input must not trigger another restart');
    assert.equal(forwarded, 2);
    const resumedRequest = proxy.requests.find((r) => r.rawBody.includes('AUTOMATIC_UPGRADE_ORIGINAL_MESSAGE'));
    assert.ok(resumedRequest?.rawBody.includes('ORIGINAL_LEGACY_HISTORY'), 'the resumed model request must include original history');
    t.diagnostic(`real child-session failure reproduced; clean launch persisted; legacy ${originalId} resumed with history and two inputs`);
  } finally {
    try {
      if (fs.existsSync(socket) && fs.statSync(socket).isSocket()) {
        const live = (await tmux(['list-sessions', '-F', '#{session_name}'])).trim().split('\n');
        for (const name of names.reverse()) if (live.includes(name)) await tmux(['kill-session', '-t', name]);
      }
    } finally {
      _testOnlyTmuxCore.reset();
      resetRuntimeTmuxInputStatesForTests();
      for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
      Object.assign(process.env, previous);
      await proxy.close();
      removeRuntimeTestDirectory(root);
    }
  }
});
