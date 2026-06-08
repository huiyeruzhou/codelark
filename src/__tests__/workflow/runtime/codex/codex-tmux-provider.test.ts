import '../../../setup/test-setup.js';
import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  buildCodexTuiShellCommand,
  buildCodexTuiArgs,
  buildCodexTuiSelectionChoiceActions,
  compactCodexTuiUpdateProgress,
  createCodexTuiSelectionPromptMonitor,
  hasCodexTuiTrustPrompt,
  hasCodexTuiSelectionPrompt,
  injectPromptIntoTmuxPane,
  isTruthyEnv,
  markCodexTuiSelectionPromptActionSent,
  observeStableCodexTuiSelectionPrompt,
  parseCodexTuiSelectionPrompt,
  parsePositiveIntEnv,
  requestCodexTuiTrustConfirmation,
  requestCodexTuiUpdateConfirmation,
  shouldUseCodexTmuxTui,
} from '../../../../runtime/codex/tmux-provider.js';
import { PendingPermissions } from '../../../../runtime/permission-gateway.js';
import {
  buildShellSnapshotLaunchCommand,
  buildShellSnapshotContent,
  detectCodexShellType,
  resolveDefaultUserShell,
} from '../../../../runtime/codex/shell-snapshot.js';

const execFileAsync = promisify(execFile);

async function tmuxAvailable(): Promise<boolean> {
  try {
    await execFileAsync('tmux', ['-V']);
    return true;
  } catch {
    return false;
  }
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function waitForFile(filePath: string, timeoutMs = 5_000): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (fs.existsSync(filePath)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

describe('codex-tmux-provider', () => {
  it('parses truthy env values for the tmux TUI switch', () => {
    assert.equal(isTruthyEnv('true'), true);
    assert.equal(isTruthyEnv('1'), true);
    assert.equal(isTruthyEnv('yes'), true);
    assert.equal(isTruthyEnv('on'), true);
    assert.equal(isTruthyEnv('false'), false);
    assert.equal(isTruthyEnv(undefined), false);
  });

  it('uses env fallbacks when optional integer values are unset or empty', () => {
    const oldValue = process.env.CODELARK_TEST_INT;
    try {
      delete process.env.CODELARK_TEST_INT;
      assert.equal(parsePositiveIntEnv('CODELARK_TEST_INT', 1200, 0), 1200);

      process.env.CODELARK_TEST_INT = '';
      assert.equal(parsePositiveIntEnv('CODELARK_TEST_INT', 1200, 0), 1200);

      process.env.CODELARK_TEST_INT = '0';
      assert.equal(parsePositiveIntEnv('CODELARK_TEST_INT', 1200, 0), 0);

      process.env.CODELARK_TEST_INT = '2500';
      assert.equal(parsePositiveIntEnv('CODELARK_TEST_INT', 1200, 0), 2500);
    } finally {
      if (oldValue === undefined) delete process.env.CODELARK_TEST_INT;
      else process.env.CODELARK_TEST_INT = oldValue;
    }
  });

  it('enables the tmux TUI provider path from supported env aliases', () => {
    const oldUseTmux = process.env.CODELARK_CODEX_USE_TMUX_TUI;
    const oldTmuxTui = process.env.CODELARK_CODEX_TMUX_TUI;
    const oldTui = process.env.CODELARK_CODEX_TUI;
    try {
      delete process.env.CODELARK_CODEX_USE_TMUX_TUI;
      delete process.env.CODELARK_CODEX_TMUX_TUI;
      delete process.env.CODELARK_CODEX_TUI;
      assert.equal(shouldUseCodexTmuxTui(), false);

      process.env.CODELARK_CODEX_USE_TMUX_TUI = 'true';
      assert.equal(shouldUseCodexTmuxTui(), true);

      delete process.env.CODELARK_CODEX_USE_TMUX_TUI;
      process.env.CODELARK_CODEX_TMUX_TUI = '1';
      assert.equal(shouldUseCodexTmuxTui(), true);

      delete process.env.CODELARK_CODEX_TMUX_TUI;
      process.env.CODELARK_CODEX_TUI = 'yes';
      assert.equal(shouldUseCodexTmuxTui(), true);
    } finally {
      if (oldUseTmux === undefined) delete process.env.CODELARK_CODEX_USE_TMUX_TUI;
      else process.env.CODELARK_CODEX_USE_TMUX_TUI = oldUseTmux;
      if (oldTmuxTui === undefined) delete process.env.CODELARK_CODEX_TMUX_TUI;
      else process.env.CODELARK_CODEX_TMUX_TUI = oldTmuxTui;
      if (oldTui === undefined) delete process.env.CODELARK_CODEX_TUI;
      else process.env.CODELARK_CODEX_TUI = oldTui;
    }
  });

  it('detects Codex TUI trust prompts from captured terminal text', () => {
    assert.equal(hasCodexTuiTrustPrompt('Do you trust the contents of this directory?\nPress enter to continue'), true);
    assert.equal(hasCodexTuiTrustPrompt('OpenAI Codex\n› Explain this codebase'), false);
  });

  it('detects and summarizes Codex TUI update prompts', () => {
    const screen = [
      'Update available! 0.135.0 -> 0.136.0',
      'Release notes: https://github.com/openai/codex/releases/latest',
      '› 1. Update now',
      '  2. Skip',
      '  3. Skip until next version',
    ].join('\n');

    assert.equal(hasCodexTuiSelectionPrompt(screen), true);
    assert.equal(hasCodexTuiSelectionPrompt('OpenAI Codex\n› Explain this codebase'), false);
    assert.equal(
      compactCodexTuiUpdateProgress('\x1b[32mUpdating Codex via npm\x1b[0m\r\nDone\n'),
      'Updating Codex via npm\nDone',
    );
  });

  it('parses ratatui-rendered Codex update prompt choices and selected row', () => {
    const screen = [
      '  ✨ Update available! 0.0.0 -> 9.9.9',
      '',
      '  Release notes: https://github.com/openai/codex/releases/latest',
      '',
      '  1. Update now (runs `npm install -g @openai/codex@latest`)',
      '› 2. Skip',
      '  3. Skip until next version',
      '',
      '  Press enter to continue',
    ].join('\n');

    const prompt = parseCodexTuiSelectionPrompt(screen);
    assert.ok(prompt);
    assert.equal(prompt.kind, 'update');
    assert.equal(prompt.selectedIndex, 1);
    assert.deepEqual(prompt.options.map((option) => option.choice), [
      'update_now',
      'skip',
      'skip_until_next_version',
    ]);
    assert.match(prompt.summary, /Update available/);
    assert.match(prompt.summary, /Skip until next version/);
  });

  it('parses Codex permission selection prompts', () => {
    const screen = [
      'Codex wants to edit files.',
      '→ Yes, proceed (y)',
      "  Yes and don't ask again for these files (a)",
      '  No, and tell Codex what to do differently (esc)',
    ].join('\n');

    const prompt = parseCodexTuiSelectionPrompt(screen);
    assert.ok(prompt);
    assert.equal(prompt.kind, 'permission');
    assert.equal(prompt.selectedIndex, 0);
    assert.deepEqual(prompt.options.map((option) => option.choice), [
      'yes_proceed',
      'yes_always',
      'no',
    ]);
    assert.match(prompt.summary, /Yes, proceed/);
  });

  it('parses unrecognized numbered TUI selections from a highlighted first row', () => {
    const screen = [
      'Choose a profile',
      '› 1. Experimental profile',
      '  2. Default profile',
      '  3. Cancel',
    ].join('\n');

    const prompt = parseCodexTuiSelectionPrompt(screen);
    assert.ok(prompt);
    assert.equal(prompt.kind, 'generic');
    assert.equal(prompt.selectedIndex, 0);
    assert.deepEqual(prompt.options.map((option) => option.choice), [
      'option_1',
      'option_2',
      'option_3',
    ]);
    assert.match(prompt.summary, /Experimental profile/);
    assert.deepEqual(buildCodexTuiSelectionChoiceActions(prompt, 'not_selection'), []);
  });

  it('requires two unchanged selection prompt captures before reporting a stall', () => {
    const monitor = createCodexTuiSelectionPromptMonitor();
    const screen = [
      'Update available! 0.135.0 -> 0.136.0',
      '› 1. Update now (runs `npm install -g @openai/codex`)',
      '  2. Skip',
      '  3. Skip until next version',
    ].join('\n');

    assert.equal(observeStableCodexTuiSelectionPrompt(screen, monitor, 2, 100), null);
    assert.equal(observeStableCodexTuiSelectionPrompt(screen, monitor, 2, 499), null);
    const stable = observeStableCodexTuiSelectionPrompt(screen, monitor, 2, 600);
    assert.ok(stable);
    assert.equal(stable.options.length, 3);
  });

  it('waits two seconds after an action before treating a still-visible prompt as the next prompt', () => {
    const monitor = createCodexTuiSelectionPromptMonitor();
    const screen = [
      'Codex wants to edit files.',
      '› 1. Yes, proceed (y)',
      "  2. Yes, and don't ask again for these files (a)",
      '  3. No, and tell Codex what to do differently (esc)',
    ].join('\n');

    assert.equal(observeStableCodexTuiSelectionPrompt(screen, monitor, 2, 100), null);
    assert.ok(observeStableCodexTuiSelectionPrompt(screen, monitor, 2, 600));

    monitor.pending = true;
    assert.equal(observeStableCodexTuiSelectionPrompt(screen, monitor, 2, 5_000), null);

    markCodexTuiSelectionPromptActionSent(monitor, 5_000);
    assert.equal(observeStableCodexTuiSelectionPrompt(screen, monitor, 2, 6_999), null);
    assert.ok(observeStableCodexTuiSelectionPrompt(screen, monitor, 2, 7_000));
  });

  it('builds direction-key actions from the highlighted Codex update prompt row', () => {
    const prompt = parseCodexTuiSelectionPrompt([
      'Update available! 0.135.0 -> 0.136.0',
      '› 1. Update now (runs `npm install -g @openai/codex`)',
      '  2. Skip',
      '  3. Skip until next version',
    ].join('\n'));
    assert.ok(prompt);

    assert.deepEqual(buildCodexTuiSelectionChoiceActions(prompt, 'update_now'), [
      { type: 'key', key: 'Enter' },
    ]);
    assert.deepEqual(buildCodexTuiSelectionChoiceActions(prompt, 'skip'), [
      { type: 'key', key: 'Down' },
      { type: 'key', key: 'Enter' },
    ]);
    assert.deepEqual(buildCodexTuiSelectionChoiceActions(prompt, 'skip_until_next_version'), [
      { type: 'key', key: 'Down' },
      { type: 'key', key: 'Down' },
      { type: 'key', key: 'Enter' },
    ]);
  });

  it('builds direction-key actions from Codex permission prompt choices', () => {
    const prompt = parseCodexTuiSelectionPrompt([
      'Codex wants to edit files.',
      '› 1. Yes, proceed (y)',
      "  2. Yes, and don't ask again for these files (a)",
      '  3. No, and tell Codex what to do differently (esc)',
    ].join('\n'));
    assert.ok(prompt);

    assert.deepEqual(buildCodexTuiSelectionChoiceActions(prompt, 'yes_proceed'), [
      { type: 'key', key: 'Enter' },
    ]);
    assert.deepEqual(buildCodexTuiSelectionChoiceActions(prompt, 'yes_always'), [
      { type: 'key', key: 'Down' },
      { type: 'key', key: 'Enter' },
    ]);
    assert.deepEqual(buildCodexTuiSelectionChoiceActions(prompt, 'no'), [
      { type: 'key', key: 'Down' },
      { type: 'key', key: 'Down' },
      { type: 'key', key: 'Enter' },
    ]);
  });

  it('returns the selected Codex update prompt choice from permission resolution', async () => {
    const permissions = new PendingPermissions();
    const requests: string[] = [];
    const prompt = parseCodexTuiSelectionPrompt([
      'Update available! 0.135.0 -> 0.136.0',
      '› 1. Update now (runs `npm install -g @openai/codex`)',
      '  2. Skip',
      '  3. Skip until next version',
    ].join('\n'));
    assert.ok(prompt);
    setTimeout(() => {
      assert.equal(requests.length, 1);
      permissions.resolve(requests[0], { behavior: 'allow', message: 'skip_until_next_version' });
    }, 0);

    const choice = await requestCodexTuiUpdateConfirmation({
      controller: {
        enqueue(data: string) {
          const outer = JSON.parse(data.match(/data: (.*)\n/)?.[1] || '{}') as { type?: string; data?: string };
          assert.equal(outer.type, 'permission_request');
          const body = JSON.parse(outer.data || '{}') as {
            permissionRequestId?: string;
            toolName?: string;
            toolInput?: { prompt?: string };
          };
          assert.equal(body.toolName, 'Codex TUI Selection Prompt');
          assert.match(body.permissionRequestId || '', /^codex-selection:update:tmux:bridge-session-tmux:/);
          assert.match(body.toolInput?.prompt || '', /Skip until next version/);
          requests.push(body.permissionRequestId || '');
        },
      } as ReadableStreamDefaultController<string>,
      pendingPerms: permissions,
      provider: 'tmux',
      bridgeSessionId: 'bridge-session-tmux',
      screenCommand: '/tmux-screen 80',
      prompt,
    });

    assert.equal(choice, 'skip_until_next_version');
  });

  it('requests user confirmation before trusting a Codex TUI directory', async () => {
    const permissions = new PendingPermissions();
    const requests: string[] = [];
    setTimeout(() => {
      assert.equal(requests.length, 1);
      permissions.resolve(requests[0], { behavior: 'allow' });
    }, 0);

    await requestCodexTuiTrustConfirmation({
      controller: {
        enqueue(data: string) {
          const outer = JSON.parse(data.match(/data: (.*)\n/)?.[1] || '{}') as { type?: string; data?: string };
          assert.equal(outer.type, 'permission_request');
          const body = JSON.parse(outer.data || '{}') as { permissionRequestId?: string; toolName?: string };
          assert.equal(body.toolName, 'Codex Trust Directory');
          assert.match(body.permissionRequestId || '', /^codex-trust:tmux:bridge-session-tmux:/);
          requests.push(body.permissionRequestId || '');
        },
      } as ReadableStreamDefaultController<string>,
      pendingPerms: permissions,
      provider: 'tmux',
      bridgeSessionId: 'bridge-session-tmux',
      workingDirectory: '/tmp/tmux-trust',
      screenCommand: '/tmux-screen 80',
    });
  });

  it('builds TUI args for resume without the exec-only skip-git flag', () => {
    const oldSkipGit = process.env.CODELARK_CODEX_SKIP_GIT_REPO_CHECK;
    const oldBaseUrl = process.env.CODELARK_CODEX_BASE_URL;
    const oldApiKey = process.env.CODELARK_CODEX_API_KEY;
    try {
      process.env.CODELARK_CODEX_SKIP_GIT_REPO_CHECK = 'true';
      process.env.CODELARK_CODEX_BASE_URL = 'https://codex.example.test/v1';
      process.env.CODELARK_CODEX_API_KEY = 'test-key';

      const args = buildCodexTuiArgs({
        prompt: 'hello',
        sessionId: 'bridge-session',
        codexThreadId: '019e46bc-f466-71d3-a186-a2ce89051958',
        model: 'gpt-5-codex',
        forceModel: true,
        sandboxMode: 'workspace-write',
        networkAccessEnabled: true,
        modelReasoningEffort: 'high',
        workingDirectory: '/tmp/work',
        permissionMode: 'acceptEdits',
      }, ['/tmp/a.png']);

      assert.deepEqual(args.slice(0, 6), [
        '--model',
        'gpt-5-codex',
        '--sandbox',
        'workspace-write',
        '--cd',
        '/tmp/work',
      ]);
      assert.equal(args.includes('--skip-git-repo-check'), false);
      assert.ok(args.includes('skip_git_repo_check=true'));
      assert.ok(args.includes('sandbox_workspace_write.network_access=true'));
      assert.ok(args.includes('model_reasoning_effort="high"'));
      assert.ok(args.includes('openai_base_url="https://codex.example.test/v1"'));
      assert.ok(args.includes('preferred_auth_method="apikey"'));
      assert.deepEqual(args.slice(-4), [
        '--image',
        '/tmp/a.png',
        'resume',
        '019e46bc-f466-71d3-a186-a2ce89051958',
      ]);
    } finally {
      if (oldSkipGit === undefined) delete process.env.CODELARK_CODEX_SKIP_GIT_REPO_CHECK;
      else process.env.CODELARK_CODEX_SKIP_GIT_REPO_CHECK = oldSkipGit;
      if (oldBaseUrl === undefined) delete process.env.CODELARK_CODEX_BASE_URL;
      else process.env.CODELARK_CODEX_BASE_URL = oldBaseUrl;
      if (oldApiKey === undefined) delete process.env.CODELARK_CODEX_API_KEY;
      else process.env.CODELARK_CODEX_API_KEY = oldApiKey;
    }
  });

  it('builds TUI args for yolo mode with the dangerous bypass flag', () => {
    const args = buildCodexTuiArgs({
      prompt: 'hello',
      sessionId: 'bridge-session',
      sandboxMode: 'workspace-write',
      workingDirectory: '/tmp/work',
      permissionMode: 'never',
      codexMode: 'yolo',
    }, []);

    assert.ok(args.includes('--dangerously-bypass-approvals-and-sandbox'));
    assert.equal(args.includes('--ask-for-approval'), false);
    assert.equal(args.includes('--sandbox'), false);
  });

  it('detects default shell using Codex-compatible platform fallback rules', () => {
    const fileExists = (filePath: string) => [
      '/usr/bin/fish',
      '/bin/bash',
      '/bin/zsh',
      '/bin/sh',
      '/opt/homebrew/bin/zsh',
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    ].includes(filePath);

    assert.equal(detectCodexShellType('/usr/bin/bash'), 'bash');
    assert.equal(detectCodexShellType('pwsh.exe'), 'powershell');
    assert.equal(
      detectCodexShellType('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'),
      'powershell',
    );
    assert.equal(detectCodexShellType('/usr/bin/fish'), null);

    assert.deepEqual(resolveDefaultUserShell({
      platform: 'linux',
      userShellPath: '/usr/bin/fish',
      pathEnv: '',
      fileExists,
    }), { type: 'bash', path: '/bin/bash' });

    assert.deepEqual(resolveDefaultUserShell({
      platform: 'darwin',
      userShellPath: null,
      pathEnv: '/opt/homebrew/bin',
      fileExists,
    }), { type: 'zsh', path: '/opt/homebrew/bin/zsh' });

    assert.deepEqual(resolveDefaultUserShell({
      platform: 'win32',
      userShellPath: null,
      pathEnv: 'C:\\Program Files\\PowerShell\\7',
      fileExists,
    }), { type: 'powershell', path: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' });
  });

  it('renders shell-specific current-process environment snapshots', () => {
    const env = {
      CODELARK_KEEP: "value with spaces and 'quotes'",
      OLDPWD: '/old',
      PWD: '/pwd',
      'BAD-NAME': 'ignored',
    };

    const bash = buildShellSnapshotContent('bash', env);
    assert.match(bash, /^# Snapshot file/m);
    assert.match(bash, /declare -x CODELARK_KEEP='value with spaces and '\\''quotes'\\'''/);
    assert.doesNotMatch(bash, /OLDPWD|BAD-NAME/);

    const zsh = buildShellSnapshotContent('zsh', env);
    assert.match(zsh, /typeset -gx CODELARK_KEEP=/);

    const sh = buildShellSnapshotContent('sh', env);
    assert.match(sh, /export CODELARK_KEEP=/);

    const powershell = buildShellSnapshotContent('powershell', env);
    assert.match(powershell, /Set-Item -LiteralPath 'Env:CODELARK_KEEP' -Value 'value with spaces and ''quotes'''/);
  });

  it('builds shell launch commands that source the snapshot before execing codex', () => {
    const bashCommand = buildShellSnapshotLaunchCommand('codex', ['--cd', '/tmp/work dir'], {
      shell: { type: 'bash', path: '/bin/bash' },
      path: '/tmp/clk env.sh',
      content: '',
    });
    assert.match(bashCommand, /^\/bin\/bash -c /);
    assert.match(bashCommand, /\/tmp\/clk env\.sh/);
    assert.match(bashCommand, /exec codex --cd/);
    assert.match(bashCommand, /\/tmp\/work dir/);

    const powershellCommand = buildShellSnapshotLaunchCommand('codex', ['--model', 'gpt-5-codex'], {
      shell: { type: 'powershell', path: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' },
      path: 'C:\\Temp\\clk env.ps1',
      content: '',
    });
    assert.match(powershellCommand, /-NoProfile -Command/);
    assert.match(powershellCommand, /C:\\Temp\\clk env\.ps1/);
    assert.match(powershellCommand, /gpt-5-codex/);
  });

  it('starts a real tmux session with the shell snapshot command form', async (t: TestContext) => {
    if (!(await tmuxAvailable())) {
      t.skip('tmux is not available');
      return;
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-tmux-command-'));
    const sessionName = `clk-test-command-${process.pid}-${Date.now()}`;
    const outputPath = path.join(tempDir, 'result.json');
    const scriptPath = path.join(tempDir, 'write-result.cjs');
    const envValue = "value with spaces and 'quotes'";
    fs.writeFileSync(scriptPath, [
      "const fs = require('node:fs');",
      'const [, , outputPath, argValue] = process.argv;',
      'fs.writeFileSync(outputPath, JSON.stringify({',
      '  envValue: process.env.CODELARK_TMUX_COMMAND_TEST,',
      '  argValue,',
      '}));',
      '',
    ].join('\n'), 'utf-8');

    const shellCommand = buildCodexTuiShellCommand(process.execPath, [
      scriptPath,
      outputPath,
      'arg with spaces',
    ], {
      CODELARK_TMUX_COMMAND_TEST: envValue,
      PATH: process.env.PATH || '',
    });

    try {
      await execFileAsync('tmux', [
        'new-session',
        '-d',
        '-s',
        sessionName,
        '--',
        shellCommand,
      ]);

      assert.equal(await waitForFile(outputPath), true, 'tmux shell command should write output');
      const parsed = JSON.parse(fs.readFileSync(outputPath, 'utf-8')) as {
        envValue: string;
        argValue: string;
      };
      assert.equal(parsed.envValue, envValue);
      assert.equal(parsed.argValue, 'arg with spaces');
    } finally {
      await execFileAsync('tmux', ['kill-session', '-t', sessionName]).catch(() => undefined);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('injects prompt into a real tmux pane with Option+Enter newlines and Enter submit', async (t: TestContext) => {
    if (!(await tmuxAvailable())) {
      t.skip('tmux is not available');
      return;
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-tmux-inject-'));
    const sessionName = `clk-test-${process.pid}-${Date.now()}`;
    const readyPath = path.join(tempDir, 'ready');
    const outputPath = path.join(tempDir, 'output.hex');
    const scriptPath = path.join(tempDir, 'capture-stdin.cjs');
    const expectedHex = Buffer.from('hello').toString('hex') + '1b0d' + Buffer.from('world').toString('hex') + '0d';
    const expectedLength = expectedHex.length / 2;

    fs.writeFileSync(scriptPath, [
      "const fs = require('node:fs');",
      `const readyPath = ${JSON.stringify(readyPath)};`,
      `const outputPath = ${JSON.stringify(outputPath)};`,
      `const expectedLength = ${expectedLength};`,
      'const chunks = [];',
      'process.stdin.setRawMode(true);',
      'process.stdin.resume();',
      "fs.writeFileSync(readyPath, '1');",
      "process.stdin.on('data', (chunk) => {",
      '  chunks.push(...chunk);',
      '  if (chunks.length >= expectedLength) {',
      "    fs.writeFileSync(outputPath, Buffer.from(chunks).toString('hex'));",
      '    process.exit(0);',
      '  }',
      '});',
      'setTimeout(() => {',
      "  fs.writeFileSync(outputPath, Buffer.from(chunks).toString('hex'));",
      '  process.exit(2);',
      '}, 5000);',
      '',
    ].join('\n'), 'utf-8');

    try {
      await execFileAsync('tmux', [
        'new-session',
        '-d',
        '-s',
        sessionName,
        '--',
        `${shellQuote(process.execPath)} ${shellQuote(scriptPath)}`,
      ]);

      assert.equal(await waitForFile(readyPath), true, 'capture process should become ready');
      await injectPromptIntoTmuxPane(`${sessionName}:0.0`, 'hello\nworld');
      assert.equal(await waitForFile(outputPath), true, 'capture process should write received bytes');

      const receivedHex = fs.readFileSync(outputPath, 'utf-8').trim();
      assert.equal(receivedHex, expectedHex);
    } finally {
      await execFileAsync('tmux', ['kill-session', '-t', sessionName]).catch(() => undefined);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('injects a long prompt into a real tmux pane without losing or reordering bytes', async (t: TestContext) => {
    if (!(await tmuxAvailable())) {
      t.skip('tmux is not available');
      return;
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-tmux-long-inject-'));
    const sessionName = `clk-test-long-${process.pid}-${Date.now()}`;
    const readyPath = path.join(tempDir, 'ready');
    const outputPath = path.join(tempDir, 'output.txt');
    const scriptPath = path.join(tempDir, 'capture-raw-input.mjs');
    const longPrompt = `clk-long-start ${Array.from({ length: 720 }, (_, index) => `token${String(index).padStart(4, '0')}`).join(' ')} clk-long-end`;

    fs.writeFileSync(scriptPath, [
      "import fs from 'node:fs';",
      '',
      'const [, , readyPath, outputPath] = process.argv;',
      'let received = "";',
      'let done = false;',
      '',
      'function finish() {',
      '  if (done) return;',
      '  done = true;',
      '  fs.writeFileSync(outputPath, received, "utf-8");',
      '  process.exit(0);',
      '}',
      '',
      'process.stdin.setEncoding("utf-8");',
      'process.stdin.setRawMode?.(true);',
      'process.stdin.resume();',
      'fs.writeFileSync(readyPath, "1", "utf-8");',
      '',
      'const timeout = setTimeout(() => process.exit(2), 10000);',
      'timeout.unref?.();',
      '',
      'process.stdin.on("data", (chunk) => {',
      '  const text = String(chunk);',
      '  const newlineIndex = text.search(/[\\r\\n]/);',
      '  if (newlineIndex >= 0) {',
      '    received += text.slice(0, newlineIndex);',
      '    clearTimeout(timeout);',
      '    finish();',
      '    return;',
      '  }',
      '  received += text;',
      '});',
      '',
    ].join('\n'), 'utf-8');
    fs.chmodSync(scriptPath, 0o755);

    try {
      await execFileAsync('tmux', [
        'new-session',
        '-d',
        '-s',
        sessionName,
        '--',
        `${shellQuote(process.execPath)} ${shellQuote(scriptPath)} ${shellQuote(readyPath)} ${shellQuote(outputPath)}`,
      ]);

      assert.equal(await waitForFile(readyPath), true, 'capture process should become ready');
      await injectPromptIntoTmuxPane(`${sessionName}:0.0`, longPrompt);
      assert.equal(await waitForFile(outputPath, 12_000), true, 'capture process should write received bytes');

      const received = fs.readFileSync(outputPath, 'utf-8').replace(/\x1B\[4~/g, '');
      assert.equal(received, longPrompt);
    } finally {
      await execFileAsync('tmux', ['kill-session', '-t', sessionName]).catch(() => undefined);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
