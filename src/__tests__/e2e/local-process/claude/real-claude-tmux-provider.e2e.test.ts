import '../../../setup/test-setup.js';
import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { streamClaudeTmuxTui } from '../../../../runtime/claude/tmux-provider.js';
import {
  claudeTmuxSessionName,
  sendTmuxActions,
  startClaudeTmuxSession,
} from '../../../../bridge/tmux/runtime.js';
import { requestRuntimeTuiSelectionViaPermissionBroker } from '../../../../bridge/command/codex-tui-selection.js';
import { handlePermissionCallback } from '../../../../bridge/permission/broker.js';
import { listClaudeSessionJsonlFiles } from '../../../../runtime/claude/session-jsonl.js';
import type { ClaudeExecutable } from '../../../../runtime/options.js';
import { initBridgeTestContext } from '../../../helpers/bridge/test-bridge-utils.js';
import {
  commandAvailable,
  removeRuntimeTestDirectory,
  startLocalResponsesProxy,
  waitForCondition,
} from '../../../helpers/runtime/real-codex-e2e-utils.js';

const execFileAsync = promisify(execFile);

async function readStream(stream: ReadableStream<string>): Promise<string> {
  let output = '';
  for await (const chunk of stream) output += chunk;
  return output;
}

function findClaudeSessionId(output: string): string | undefined {
  for (const line of output.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const event = JSON.parse(line.slice('data: '.length)) as { data?: string };
    if (!event.data) continue;
    try {
      const data = JSON.parse(event.data) as { session_id?: string };
      if (data.session_id) return data.session_id;
    } catch {
      // Text events are not JSON objects.
    }
  }
  return undefined;
}

function writeClaudeOnboardingState(homeDir: string): void {
  fs.writeFileSync(path.join(homeDir, '.claude.json'), `${JSON.stringify({
    numStartups: 1,
    installMethod: 'npm',
    theme: 'light',
    hasCompletedOnboarding: true,
    lastOnboardingVersion: '2.0.0',
    hasIdeOnboardingBeenShown: { vscode: true },
  }, null, 2)}\n`, { mode: 0o600 });
}

describe('real Claude Code tmux provider e2e', () => {
  it('continues provider auto-forward after accepting the Claude YOLO warning card', { timeout: 120_000 }, async (t: TestContext) => {
    const claudeExecutable = (process.env.CODELARK_REAL_CLAUDE_E2E_EXECUTABLE || 'claude') as ClaudeExecutable;
    if (!(await commandAvailable('tmux', ['-V']))) {
      t.skip('tmux is not available');
      return;
    }
    if (!(await commandAvailable(claudeExecutable, ['--version']))) {
      t.skip('claude executable is not available');
      return;
    }

    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-real-claude-auto-forward-home-'));
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-real-claude-auto-forward-work-'));
    const tmuxTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-real-claude-auto-forward-socket-'));
    const prompt = `CODELARK_CLAUDE_AUTO_FORWARD_${process.pid}_${Date.now()}`;
    const proxy = await startLocalResponsesProxy({ responseText: 'ok' });
    const sessionName = `claude_auto_forward_${process.pid}_${Date.now()}`;
    const bridgeSessionId = `bridge-${sessionName}`;
    const address = { channelType: 'feishu', chatId: `chat-${sessionName}` } as const;
    const sent: any[] = [];
    initBridgeTestContext();
    const adapter: any = {
      channelType: 'feishu',
      send: async (message: any) => {
        const messageId = `reply-${sent.length + 1}`;
        sent.push({ ...message, messageId });
        if (message.richCard?.title === 'Claude TUI Selection') {
          assert.deepEqual(message.richCard.selects?.[0]?.options.map((option: any) => option.text), [
            'No, exit',
            'Yes, I accept',
          ]);
          assert.match(message.richCard.selects?.[0]?.selectedCallbackData || '', /:no$/u);
          const callbackData = message.richCard.selects?.[0]?.options.find(
            (option: { callbackData?: string }) => option.callbackData?.endsWith(':yes_proceed'),
          )?.callbackData;
          assert.ok(callbackData, 'Claude selection card should include the explicit acceptance callback');
          setTimeout(() => {
            assert.equal(handlePermissionCallback(callbackData, address.chatId, messageId), true);
          }, 0);
        }
        return { ok: true, messageId };
      },
    };
    const previousEnv = new Map<string, string | undefined>();
    const env = {
      HOME: homeDir,
      USERPROFILE: homeDir,
      CODELARK_CLAUDE_HOME: homeDir,
      TMUX_TMPDIR: tmuxTmpDir,
      ANTHROPIC_BASE_URL: proxy.baseUrl.replace(/\/v1$/u, ''),
      ANTHROPIC_AUTH_TOKEN: 'codelark-local-mock-token',
      ANTHROPIC_API_KEY: '',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CODELARK_CLAUDE_TMUX_POLL_INTERVAL_MS: '100',
    } satisfies Record<string, string>;
    writeClaudeOnboardingState(homeDir);
    for (const key of ['TMUX', 'TMUX_PANE']) {
      previousEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    for (const [key, value] of Object.entries(env)) {
      previousEnv.set(key, process.env[key]);
      process.env[key] = value;
    }

    try {
      const started = await startClaudeTmuxSession({
        sessionName,
        bridgeSessionId,
        workingDirectory: workDir,
        executable: claudeExecutable,
        permissionMode: 'bypassPermissions',
        waitReady: true,
        onSelectionPrompt: (selectionPrompt) => requestRuntimeTuiSelectionViaPermissionBroker({
          adapter,
          msg: {
            address,
            text: prompt,
            messageId: 'incoming-claude-yolo-card',
            timestamp: Date.now(),
          },
          selectionPrompt,
          sessionId: bridgeSessionId,
          requestScope: 'real-claude-auto-forward',
          reasonContext: 'before forwarding the original message',
        }),
      });
      assert.equal(started.ready, true);
      assert.equal(sent.filter((message) => message.richCard?.title === 'Claude TUI Selection').length, 1);

      await sendTmuxActions(`${sessionName}:0.0`, [
        { type: 'literal', text: prompt },
        { type: 'key', key: 'Enter' },
      ], { delayMs: 500 });

      const submitted = await waitForCondition(
        () => proxy.requests.some((request) => (
          /\/messages(?:\?|$)/u.test(request.url) && request.rawBody.includes(prompt)
        )),
        15_000,
        100,
      );
      if (!submitted) {
        const screen = await execFileAsync('tmux', [
          'capture-pane', '-p', '-t', `${sessionName}:0.0`, '-S', '-120',
        ]).catch((error) => ({ stdout: String(error), stderr: '' }));
        assert.fail([
          'Claude provider auto-forward did not submit the prompt',
          `messages requests: ${proxy.requests.filter((request) => /\/messages(?:\?|$)/u.test(request.url)).length}`,
          `screen: ${screen.stdout.slice(-3_000)}`,
        ].join('\n'));
      }
    } finally {
      await execFileAsync('tmux', ['kill-session', '-t', sessionName]).catch(() => undefined);
      await proxy.close().catch(() => undefined);
      for (const [key, value] of previousEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      removeRuntimeTestDirectory(homeDir);
      removeRuntimeTestDirectory(workDir);
      removeRuntimeTestDirectory(tmuxTmpDir);
    }
  });

  it('runs and resumes the real Claude executable through tmux against a fake Anthropic backend', { timeout: 180_000 }, async (t: TestContext) => {
    const claudeExecutable = process.env.CODELARK_REAL_CLAUDE_E2E_EXECUTABLE || 'claude';
    if (!(await commandAvailable('tmux', ['-V']))) {
      t.skip('tmux is not available');
      return;
    }
    if (!(await commandAvailable(claudeExecutable, ['--version']))) {
      t.skip('claude executable is not available');
      return;
    }

    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-real-claude-tmux-home-'));
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-real-claude-tmux-work-'));
    const tmuxTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-real-claude-tmux-socket-'));
    const expected = `CODELARK_REAL_CLAUDE_TMUX_${process.pid}_${Date.now()}`;
    const proxy = await startLocalResponsesProxy({ responseText: expected });
    const sessionId = `real-claude-tmux-${process.pid}-${Date.now()}`;
    const freshTmuxSessionName = claudeTmuxSessionName(sessionId);
    let resumedTmuxSessionName = '';
    const previousEnv = new Map<string, string | undefined>();
    const env = {
      HOME: homeDir,
      USERPROFILE: homeDir,
      CODELARK_CLAUDE_HOME: homeDir,
      TMUX_TMPDIR: tmuxTmpDir,
      ANTHROPIC_BASE_URL: proxy.baseUrl.replace(/\/v1$/u, ''),
      ANTHROPIC_AUTH_TOKEN: 'codelark-local-mock-token',
      ANTHROPIC_API_KEY: '',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CODELARK_CLAUDE_TMUX_PROMPT_DELAY_MS: '0',
      CODELARK_CLAUDE_TMUX_POLL_INTERVAL_MS: '100',
      CODELARK_CLAUDE_TMUX_SESSION_FILE_TIMEOUT_MS: '30000',
    } satisfies Record<string, string>;
    writeClaudeOnboardingState(homeDir);
    for (const key of ['TMUX', 'TMUX_PANE']) {
      previousEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    for (const [key, value] of Object.entries(env)) {
      previousEnv.set(key, process.env[key]);
      process.env[key] = value;
    }

    try {
      const output = await readStream(streamClaudeTmuxTui({
        prompt: `Reply with exactly: ${expected}`,
        sessionId,
        runtime: 'claude',
        claudeExecutable: 'claude',
        workingDirectory: workDir,
      }));
      assert.match(output, new RegExp(expected));
      const claudeSessionId = findClaudeSessionId(output);
      assert.ok(claudeSessionId, 'real Claude turn should publish its persisted session identity');
      assert.equal(listClaudeSessionJsonlFiles(workDir, homeDir).length, 1);

      await execFileAsync('tmux', ['kill-session', '-t', freshTmuxSessionName]);
      resumedTmuxSessionName = claudeTmuxSessionName(claudeSessionId);
      const resumedOutput = await readStream(streamClaudeTmuxTui({
        prompt: `Resume this session and reply with exactly: ${expected}`,
        sessionId,
        claudeSessionId,
        runtime: 'claude',
        claudeExecutable: 'claude',
        workingDirectory: workDir,
      }));
      assert.match(resumedOutput, new RegExp(expected));
      assert.equal(findClaudeSessionId(resumedOutput), claudeSessionId);
      assert.equal(listClaudeSessionJsonlFiles(workDir, homeDir).length, 1);
      assert.ok(proxy.requests.some((request) => /\/messages(?:\?|$)/u.test(request.url)));
    } finally {
      await execFileAsync('tmux', ['kill-session', '-t', freshTmuxSessionName]).catch(() => undefined);
      if (resumedTmuxSessionName) {
        await execFileAsync('tmux', ['kill-session', '-t', resumedTmuxSessionName]).catch(() => undefined);
      }
      await proxy.close().catch(() => undefined);
      for (const [key, value] of previousEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      removeRuntimeTestDirectory(homeDir);
      removeRuntimeTestDirectory(workDir);
      removeRuntimeTestDirectory(tmuxTmpDir);
    }
  });
});
