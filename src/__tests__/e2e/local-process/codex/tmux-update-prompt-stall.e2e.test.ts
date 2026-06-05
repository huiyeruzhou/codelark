import '../../../setup/test-setup.js';
import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { tmuxCore } from '../../../../bridge/tmux/core.js';
import { PendingPermissions } from '../../../../runtime/permission-gateway.js';
import {
  createCodexTuiUpdatePromptMonitor,
  observeStableCodexTuiUpdatePrompt,
  parseCodexTuiUpdatePrompt,
  resolveStableCodexTuiUpdatePrompt,
} from '../../../../runtime/codex/tmux-provider.js';

const execFileAsync = promisify(execFile);

async function tmuxAvailable(): Promise<boolean> {
  try {
    await execFileAsync('tmux', ['-V']);
    return true;
  } catch {
    return false;
  }
}

async function waitForFile(filePath: string, timeoutMs = 5_000): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (fs.existsSync(filePath)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

async function waitForUpdatePromptCapture(
  targetPane: string,
  timeoutMs = 5_000,
): Promise<{ screen: string; command: string }> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const capture = await tmuxCore.capturePane(targetPane, 40);
    if (parseCodexTuiUpdatePrompt(capture.screen)) return capture;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return tmuxCore.capturePane(targetPane, 40);
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

describe('tmux Codex update prompt stall e2e', () => {
  it('detects two stable ratatui-like captures and answers with direction keys plus Enter', async (t: TestContext) => {
    if (!(await tmuxAvailable())) {
      t.skip('tmux is not available');
      return;
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-tmux-update-prompt-'));
    const sessionName = `clk-update-prompt-${process.pid}-${Date.now()}`;
    const readyPath = path.join(tempDir, 'ready');
    const outputPath = path.join(tempDir, 'keys.hex');
    const scriptPath = path.join(tempDir, 'ratatui-update-prompt-mock.cjs');

    fs.writeFileSync(scriptPath, [
      "const fs = require('node:fs');",
      `const readyPath = ${JSON.stringify(readyPath)};`,
      `const outputPath = ${JSON.stringify(outputPath)};`,
      "process.stdin.setRawMode(true);",
      "process.stdin.resume();",
      "process.stdout.write([",
      "  '  ✨ Update available! 0.0.0 -> 9.9.9',",
      "  '',",
      "  '  Release notes: https://github.com/openai/codex/releases/latest',",
      "  '',",
      "  '› 1. Update now (runs `npm install -g @openai/codex@latest`)',",
      "  '  2. Skip',",
      "  '  3. Skip until next version',",
      "  '',",
      "  '  Press enter to continue',",
      "].join('\\n') + '\\n');",
      "fs.writeFileSync(readyPath, '1');",
      "const chunks = [];",
      "process.stdin.on('data', (chunk) => {",
      "  chunks.push(...chunk);",
      "  if (chunk.includes(13)) {",
      "    fs.writeFileSync(outputPath, Buffer.from(chunks).toString('hex'));",
      "    process.exit(0);",
      "  }",
      "});",
      "setTimeout(() => {",
      "  fs.writeFileSync(outputPath, Buffer.from(chunks).toString('hex'));",
      "  process.exit(2);",
      "}, 10000);",
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
      assert.equal(await waitForFile(readyPath), true, 'mock TUI should become ready');

      const targetPane = `${sessionName}:0.0`;
      const monitor = createCodexTuiUpdatePromptMonitor();
      const firstCapture = await waitForUpdatePromptCapture(targetPane);
      assert.ok(parseCodexTuiUpdatePrompt(firstCapture.screen), 'mock TUI update prompt should be visible');
      assert.equal(observeStableCodexTuiUpdatePrompt(firstCapture.screen, monitor), null);
      await new Promise((resolve) => setTimeout(resolve, 600));
      const secondCapture = await tmuxCore.capturePane(targetPane, 40);
      const prompt = observeStableCodexTuiUpdatePrompt(secondCapture.screen, monitor);
      assert.ok(prompt, 'second unchanged capture should detect a stable update prompt');

      const permissions = new PendingPermissions();
      const result = await resolveStableCodexTuiUpdatePrompt({
        controller: {
          enqueue(data: string) {
            const outer = JSON.parse(data.match(/data: (.*)\n/)?.[1] || '{}') as { type?: string; data?: string };
            if (outer.type !== 'permission_request') return;
            const body = JSON.parse(outer.data || '{}') as { permissionRequestId?: string };
            setTimeout(() => {
              permissions.resolve(body.permissionRequestId || '', {
                behavior: 'allow',
                message: 'skip_until_next_version',
              });
            }, 0);
          },
        } as ReadableStreamDefaultController<string>,
        pendingPerms: permissions,
        provider: 'tmux',
        bridgeSessionId: 'bridge-session-e2e',
        targetPane,
        prompt,
        screenCommand: '/tmux-screen 80',
      });

      assert.equal(result.choice, 'skip_until_next_version');
      assert.deepEqual(result.commands.map((command) => command.replace(/.*send-keys -t [^ ]+ /, '')), [
        'Down',
        'Down',
        'Enter',
      ]);
      assert.equal(await waitForFile(outputPath), true, 'mock TUI should record key bytes');
      const keyHex = fs.readFileSync(outputPath, 'utf-8').trim();
      assert.match(keyHex, /0d$/, 'selection should end with Enter/CR');
      assert.equal((keyHex.match(/1b/g) || []).length, 2, 'selection should use two arrow-key escape sequences');
      assert.equal((keyHex.match(/42/g) || []).length >= 2, true, 'selection should include two Down arrow bytes');
    } finally {
      await execFileAsync('tmux', ['kill-session', '-t', sessionName]).catch(() => undefined);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
