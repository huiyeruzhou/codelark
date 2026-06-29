import '../../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { _testOnlyClaudePty, buildClaudePtyEnv } from '../../../../runtime/claude/pty-provider.js';
import { getClaudeProjectDir } from '../../../../runtime/claude/session-jsonl.js';

describe('claude-pty-provider', () => {
  it('prepends the CodeLark runtime bin when building the Claude pty env', () => {
    const oldPath = process.env.PATH;
    try {
      const runtimeBin = path.join(process.env.CODELARK_HOME!, 'runtime', 'bin');
      process.env.PATH = ['/usr/bin', runtimeBin, '/bin'].join(path.delimiter);

      const env = buildClaudePtyEnv();

      assert.equal(env.PATH, [runtimeBin, '/usr/bin', '/bin'].join(path.delimiter));
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
    }
  });

  it('builds Claude Code pty commands from the configured executable', () => {
    assert.deepEqual(_testOnlyClaudePty.buildClaudePtyCommand('ccr', {
      env: {},
      platform: process.platform,
    }), {
      command: process.platform === 'win32' ? 'ccr.cmd' : 'ccr',
      args: ['code'],
    });
    assert.deepEqual(_testOnlyClaudePty.buildClaudePtyCommand('claude', {
      env: {},
      platform: process.platform,
    }), {
      command: process.platform === 'win32' ? 'claude.cmd' : 'claude',
      args: [],
    });
  });

  it('passes Claude startup settings as pty launch arguments', () => {
    assert.deepEqual(_testOnlyClaudePty.buildClaudePtyCommand('ccr', {
      model: 'sonnet',
      permissionMode: 'bypassPermissions',
      reasoningEffort: 'high',
      env: {},
      platform: process.platform,
    }), {
      command: process.platform === 'win32' ? 'ccr.cmd' : 'ccr',
      args: ['code', '--model', 'sonnet', '--permission-mode', 'bypassPermissions', '--effort', 'high'],
    });
    assert.deepEqual(_testOnlyClaudePty.buildClaudePtyCommand('claude', {
      permissionMode: 'default',
      env: {},
      platform: process.platform,
    }), {
      command: process.platform === 'win32' ? 'claude.cmd' : 'claude',
      args: [],
    });
  });

  it('prefers global Claude Code executables over project node_modules bins', () => {
    const existing = new Set([
      '/repo/node_modules/.bin/claude',
      '/repo/node_modules/.bin/ccr',
      '/home/user/.local/bin/claude',
      '/home/user/.local/bin/ccr',
    ]);

    assert.deepEqual(_testOnlyClaudePty.buildClaudePtyCommand('claude', {
      env: { PATH: '/repo/node_modules/.bin:/home/user/.local/bin' },
      platform: 'linux',
      fileExists: (filePath) => existing.has(filePath),
    }), {
      command: '/home/user/.local/bin/claude',
      args: [],
    });
    assert.deepEqual(_testOnlyClaudePty.buildClaudePtyCommand('ccr', {
      env: { PATH: '/repo/node_modules/.bin:/home/user/.local/bin' },
      platform: 'linux',
      fileExists: (filePath) => existing.has(filePath),
    }), {
      command: '/home/user/.local/bin/ccr',
      args: ['code'],
    });
  });

  it('allows explicit Claude Code executable path overrides', () => {
    assert.deepEqual(_testOnlyClaudePty.buildClaudePtyCommand('claude', {
      env: {
        CODELARK_CLAUDE_CLI_PATH: '/custom/claude',
        PATH: '/repo/node_modules/.bin:/home/user/.local/bin',
      },
      platform: 'linux',
      fileExists: () => false,
    }), {
      command: '/custom/claude',
      args: [],
    });
    assert.deepEqual(_testOnlyClaudePty.buildClaudePtyCommand('ccr', {
      env: {
        CODELARK_CCR_CLI_PATH: '/custom/ccr',
        PATH: '/repo/node_modules/.bin:/home/user/.local/bin',
      },
      platform: 'linux',
      fileExists: () => false,
    }), {
      command: '/custom/ccr',
      args: ['code'],
    });
  });

  it('parses Claude Code Router activation environment output', () => {
    assert.deepEqual(_testOnlyClaudePty.parseClaudeCodeRouterActivateEnv([
      'export ANTHROPIC_BASE_URL="http://127.0.0.1:3456"',
      "export ANTHROPIC_AUTH_TOKEN='ccr-token'",
      'ANTHROPIC_API_KEY=',
      '$env:CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1"',
    ].join('\n')), {
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:3456',
      ANTHROPIC_AUTH_TOKEN: 'ccr-token',
      ANTHROPIC_API_KEY: '',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    });
  });

  it('parses Claude Code Router status from explicit running signals only', () => {
    assert.equal(_testOnlyClaudePty.parseClaudeCodeRouterStatus([
      '📊 Claude Code Router Status',
      '✅ Status: Running',
      '🆔 Process ID: 2087011',
      '🌐 Port: 3456',
      '🚀 Ready to use!',
    ].join('\n')), true);
    assert.equal(_testOnlyClaudePty.parseClaudeCodeRouterStatus('❌ Status: Not Running'), false);
    assert.equal(_testOnlyClaudePty.parseClaudeCodeRouterStatus('Status: not running'), false);
    assert.equal(_testOnlyClaudePty.parseClaudeCodeRouterStatus('status command completed without details'), false);
    assert.equal(_testOnlyClaudePty.parseClaudeCodeRouterStatus(''), false);
  });

  it('recognizes Claude Code trust and input screens despite terminal spacing', () => {
    assert.equal(_testOnlyClaudePty.hasClaudePtyTrustPrompt([
      'Accessing workspace:',
      '/tmp/project',
      'Quick safety check: Is this a project you created or one you trust?',
      '1. Yes, I trust this folder',
      'Enter to confirm',
    ].join('\n')), true);
    assert.equal(_testOnlyClaudePty.hasClaudePtyTrustPrompt('ordinary output'), false);

    assert.equal(_testOnlyClaudePty.hasClaudePtyInputPrompt([
      '╭─── Claude Code v2.1.159 ───╮',
      '❯ ',
      '? for shortcuts · ← for agents ● high · /effort',
    ].join('\n')), true);
    assert.equal(_testOnlyClaudePty.hasClaudePtyInputPrompt('Quick safety check'), false);
  });

  it('recognizes first-run Claude Code onboarding screens before prompt injection', () => {
    const onboardingScreen = [
      'Welcome to Claude Code v2.1.160',
      'Security notes:',
      '1. Claude can make mistakes.',
      '2. Due to prompt injection risks, only use it with code you trust',
      '❯ 1. Dark mode',
      'Press Enter to continue...',
    ].join('\n');
    assert.equal(_testOnlyClaudePty.hasClaudePtyOnboardingPrompt(onboardingScreen), true);
    assert.equal(_testOnlyClaudePty.hasClaudePtyInputPrompt(onboardingScreen), false);
    const themeSelectionScreen = [
      'Syntax theme: Monokai Extended (ctrl+t to disable)',
      '❯ 2. Dark mode',
      '3. Light mode',
      '4. Dark mode (colorblind-friendly)',
      'Welcome to Claude Code v2.1.160',
    ].join('\n');
    assert.equal(_testOnlyClaudePty.hasClaudePtyOnboardingPrompt(themeSelectionScreen), true);
    assert.equal(_testOnlyClaudePty.hasClaudePtyInputPrompt(themeSelectionScreen), false);
    assert.equal(_testOnlyClaudePty.hasClaudePtyOnboardingPrompt([
      'Welcome to Claude Code v2.1.160',
      '❯ ',
      '? for shortcuts',
    ].join('\n')), false);
  });

  it('injects prompts into a registered active Claude pty session', async () => {
    const writes: string[] = [];
    const previousInputTimeout = process.env.CODELARK_CLAUDE_PTY_INPUT_READY_TIMEOUT_MS;
    try {
      process.env.CODELARK_CLAUDE_PTY_INPUT_READY_TIMEOUT_MS = '0';
      _testOnlyClaudePty.clear();
      _testOnlyClaudePty.registerSession('bridge-session-active-claude-pty', {
        child: {
          write(data: string) {
            writes.push(data);
          },
          kill() {},
          onData() {},
          onExit() {},
        },
        executable: 'claude',
        cwd: '/tmp/claude-pty-active',
        buffer: [
          'Claude Code v2.1.160',
          '❯ ',
          '? for shortcuts',
        ].join('\n'),
      });

      assert.equal(
        await _testOnlyClaudePty.injectPromptIntoClaudePtySession('bridge-session-active-claude-pty', 'append now'),
        true,
      );
      assert.deepEqual(writes, ['append now', '\r']);

      _testOnlyClaudePty.registerSession('bridge-session-exited-claude-pty', {
        child: {
          write(data: string) {
            writes.push(data);
          },
          kill() {},
          onData() {},
          onExit() {},
        },
        executable: 'claude',
        cwd: '/tmp/claude-pty-exited',
        exited: true,
      });
      assert.equal(
        await _testOnlyClaudePty.injectPromptIntoClaudePtySession('bridge-session-exited-claude-pty', 'ignored'),
        false,
      );
    } finally {
      if (previousInputTimeout === undefined) delete process.env.CODELARK_CLAUDE_PTY_INPUT_READY_TIMEOUT_MS;
      else process.env.CODELARK_CLAUDE_PTY_INPUT_READY_TIMEOUT_MS = previousInputTimeout;
      _testOnlyClaudePty.clear();
    }
  });

  it('waits for late first-run onboarding before prompt injection', async () => {
    const previousTrustTimeout = process.env.CODELARK_CLAUDE_PTY_TRUST_PROMPT_TIMEOUT_MS;
    const previousInputTimeout = process.env.CODELARK_CLAUDE_PTY_INPUT_READY_TIMEOUT_MS;
    const previousAfterTrustDelay = process.env.CODELARK_CLAUDE_PTY_AFTER_TRUST_DELAY_MS;
    const writes: string[] = [];
    const session: any = {
      child: {
        write: (data: string) => {
          writes.push(data);
          session.buffer = [
            'Claude Code v2.1.160',
            '❯ ',
            '? for shortcuts',
          ].join('\n');
        },
      },
      executable: 'ccr',
      cwd: '/tmp/claude-pty-late-onboarding',
      buffer: '',
      startedAtMs: Date.now(),
      updatedAtMs: Date.now(),
      exited: false,
    };
    try {
      process.env.CODELARK_CLAUDE_PTY_TRUST_PROMPT_TIMEOUT_MS = '50';
      process.env.CODELARK_CLAUDE_PTY_INPUT_READY_TIMEOUT_MS = '500';
      process.env.CODELARK_CLAUDE_PTY_AFTER_TRUST_DELAY_MS = '0';
      setTimeout(() => {
        session.buffer = [
          'Welcome to Claude Code v2.1.160',
          'Security notes:',
          'Press Enter to continue...',
        ].join('\n');
      }, 100);

      await _testOnlyClaudePty.prepareClaudePtyForPrompt(session);

      assert.deepEqual(writes, ['\r']);
      assert.equal(_testOnlyClaudePty.hasClaudePtyInputPrompt(session.buffer), true);
    } finally {
      if (previousTrustTimeout === undefined) delete process.env.CODELARK_CLAUDE_PTY_TRUST_PROMPT_TIMEOUT_MS;
      else process.env.CODELARK_CLAUDE_PTY_TRUST_PROMPT_TIMEOUT_MS = previousTrustTimeout;
      if (previousInputTimeout === undefined) delete process.env.CODELARK_CLAUDE_PTY_INPUT_READY_TIMEOUT_MS;
      else process.env.CODELARK_CLAUDE_PTY_INPUT_READY_TIMEOUT_MS = previousInputTimeout;
      if (previousAfterTrustDelay === undefined) delete process.env.CODELARK_CLAUDE_PTY_AFTER_TRUST_DELAY_MS;
      else process.env.CODELARK_CLAUDE_PTY_AFTER_TRUST_DELAY_MS = previousAfterTrustDelay;
    }
  });

  it('confirms the multi-step Claude Code first-run setup wizard before prompt injection', async () => {
    const previousTrustTimeout = process.env.CODELARK_CLAUDE_PTY_TRUST_PROMPT_TIMEOUT_MS;
    const previousInputTimeout = process.env.CODELARK_CLAUDE_PTY_INPUT_READY_TIMEOUT_MS;
    const previousAfterTrustDelay = process.env.CODELARK_CLAUDE_PTY_AFTER_TRUST_DELAY_MS;
    const screens = [
      [
        'Welcome to Claude Code v2.1.160',
        'Choose the text style that looks best with your terminal',
        '❯ 2. Dark mode',
        'Syntax theme: Monokai Extended (ctrl+t to disable)',
      ].join('\n'),
      [
        'Welcome to Claude Code v2.1.160',
        'Security notes:',
        'Press Enter to continue...',
      ].join('\n'),
      [
        "Use Claude Code's terminal setup?",
        '❯ 1. Yes, use recommended settings',
        'Enter to confirm · Esc to skip',
      ].join('\n'),
      [
        'Claude Code v2.1.160',
        '❯ ',
        '? for shortcuts',
      ].join('\n'),
    ];
    const writes: string[] = [];
    const session: any = {
      child: {
        write: (data: string) => {
          writes.push(data);
          session.buffer = screens[Math.min(writes.length, screens.length - 1)];
        },
      },
      executable: 'ccr',
      cwd: '/tmp/claude-pty-setup-wizard',
      buffer: screens[0],
      startedAtMs: Date.now(),
      updatedAtMs: Date.now(),
      exited: false,
    };
    try {
      process.env.CODELARK_CLAUDE_PTY_TRUST_PROMPT_TIMEOUT_MS = '50';
      process.env.CODELARK_CLAUDE_PTY_INPUT_READY_TIMEOUT_MS = '500';
      process.env.CODELARK_CLAUDE_PTY_AFTER_TRUST_DELAY_MS = '0';

      await _testOnlyClaudePty.prepareClaudePtyForPrompt(session);

      assert.deepEqual(writes, ['\r', '\r', '\r']);
      assert.equal(_testOnlyClaudePty.hasClaudePtyInputPrompt(session.buffer), true);
    } finally {
      if (previousTrustTimeout === undefined) delete process.env.CODELARK_CLAUDE_PTY_TRUST_PROMPT_TIMEOUT_MS;
      else process.env.CODELARK_CLAUDE_PTY_TRUST_PROMPT_TIMEOUT_MS = previousTrustTimeout;
      if (previousInputTimeout === undefined) delete process.env.CODELARK_CLAUDE_PTY_INPUT_READY_TIMEOUT_MS;
      else process.env.CODELARK_CLAUDE_PTY_INPUT_READY_TIMEOUT_MS = previousInputTimeout;
      if (previousAfterTrustDelay === undefined) delete process.env.CODELARK_CLAUDE_PTY_AFTER_TRUST_DELAY_MS;
      else process.env.CODELARK_CLAUDE_PTY_AFTER_TRUST_DELAY_MS = previousAfterTrustDelay;
    }
  });

  it('does not treat stale Claude JSONL files as the current pty turn identity', () => {
    const previousHome = process.env.CODELARK_CLAUDE_HOME;
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-claude-pty-home-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-claude-pty-cwd-'));
    try {
      process.env.CODELARK_CLAUDE_HOME = homeDir;
      const projectDir = getClaudeProjectDir(cwd, homeDir);
      fs.mkdirSync(projectDir, { recursive: true });
      const stalePath = path.join(projectDir, 'stale-session.jsonl');
      fs.writeFileSync(stalePath, `${JSON.stringify({
        type: 'user',
        sessionId: 'stale-session',
        cwd,
        timestamp: '2026-06-02T04:20:00.000Z',
        message: { role: 'user', content: 'old prompt' },
      })}\n`, 'utf-8');
      const oldTime = new Date('2026-06-02T04:20:00.000Z');
      fs.utimesSync(stalePath, oldTime, oldTime);

      assert.equal(_testOnlyClaudePty.findLatestClaudeSessionJsonlUpdatedAfter(cwd, Date.now()), null);

      const freshPath = path.join(projectDir, 'fresh-session.jsonl');
      fs.writeFileSync(freshPath, `${JSON.stringify({
        type: 'user',
        sessionId: 'fresh-session',
        cwd,
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: 'new prompt' },
      })}\n`, 'utf-8');
      assert.equal(
        _testOnlyClaudePty.findLatestClaudeSessionJsonlUpdatedAfter(cwd, Date.now() - 1_000)?.sessionId,
        'fresh-session',
      );
    } finally {
      if (previousHome === undefined) delete process.env.CODELARK_CLAUDE_HOME;
      else process.env.CODELARK_CLAUDE_HOME = previousHome;
      fs.rmSync(homeDir, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
