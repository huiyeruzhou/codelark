import '../../../setup/test-setup.js';
import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { streamClaudeTmuxTui } from '../../../../runtime/claude/tmux-provider.js';
import { claudeTmuxSessionName } from '../../../../bridge/tmux/runtime.js';
import {
  commandAvailable,
  removeRuntimeTestDirectory,
  startLocalResponsesProxy,
} from '../../../helpers/runtime/real-codex-e2e-utils.js';

const execFileAsync = promisify(execFile);

async function readStream(stream: ReadableStream<string>): Promise<string> {
  let output = '';
  for await (const chunk of stream) output += chunk;
  return output;
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
  it('runs the real Claude executable through tmux against a fake Anthropic backend', { timeout: 180_000 }, async (t: TestContext) => {
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
    const expected = `CODELARK_REAL_CLAUDE_TMUX_${process.pid}_${Date.now()}`;
    const proxy = await startLocalResponsesProxy({ responseText: expected });
    const sessionId = `real-claude-tmux-${process.pid}-${Date.now()}`;
    const tmuxSessionName = claudeTmuxSessionName(sessionId);
    const previousEnv = new Map<string, string | undefined>();
    const env = {
      HOME: homeDir,
      USERPROFILE: homeDir,
      CODELARK_CLAUDE_HOME: homeDir,
      ANTHROPIC_BASE_URL: proxy.baseUrl.replace(/\/v1$/u, ''),
      ANTHROPIC_AUTH_TOKEN: 'codelark-local-mock-token',
      ANTHROPIC_API_KEY: '',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CODELARK_CLAUDE_TMUX_PROMPT_DELAY_MS: '0',
      CODELARK_CLAUDE_TMUX_POLL_INTERVAL_MS: '100',
      CODELARK_CLAUDE_TMUX_SESSION_FILE_TIMEOUT_MS: '30000',
    } satisfies Record<string, string>;
    writeClaudeOnboardingState(homeDir);
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
      assert.ok(proxy.requests.some((request) => /\/messages(?:\?|$)/u.test(request.url)));
    } finally {
      await execFileAsync('tmux', ['kill-session', '-t', tmuxSessionName]).catch(() => undefined);
      await proxy.close().catch(() => undefined);
      for (const [key, value] of previousEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      removeRuntimeTestDirectory(homeDir);
      removeRuntimeTestDirectory(workDir);
    }
  });
});
