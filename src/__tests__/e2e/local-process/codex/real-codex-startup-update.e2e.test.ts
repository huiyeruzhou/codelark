import '../../../setup/test-setup.js';
import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  startCodexResumeTmuxSession,
  tmuxCore,
  type RuntimeTmuxSelectionPrompt,
} from '../../../../bridge/tmux/runtime.js';

const execFileAsync = promisify(execFile);
const OLD_CODEX_VERSION = '0.145.0';

function enabled(): boolean {
  return process.env.CODELARK_REAL_CODEX_UPDATE_E2E === '1';
}

function copyIfPresent(source: string, destination: string): void {
  if (!fs.existsSync(source)) return;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function restoreEnvironment(snapshot: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function codexVersion(executable: string, env: NodeJS.ProcessEnv): Promise<string> {
  const { stdout, stderr } = await execFileAsync(executable, ['--version'], { env });
  return `${stdout}\n${stderr}`.trim();
}

async function latestCodexVersion(): Promise<string> {
  const { stdout } = await execFileAsync('npm', ['view', '@openai/codex', 'version', '--json'], {
    timeout: 30_000,
  });
  const parsed = JSON.parse(stdout) as unknown;
  if (typeof parsed === 'string') return parsed;
  if (Array.isArray(parsed) && typeof parsed.at(-1) === 'string') return parsed.at(-1) as string;
  throw new Error(`npm returned an invalid latest @openai/codex version: ${stdout.slice(0, 300)}`);
}

describe('real Codex startup update lifecycle', () => {
  it('updates an isolated old global install, relaunches once, and reaches ready', { timeout: 8 * 60_000 }, async (t: TestContext) => {
    if (!enabled()) {
      t.skip('set CODELARK_REAL_CODEX_UPDATE_E2E=1 to run the real npm/Codex update gate');
      return;
    }
    if (process.platform === 'win32') {
      t.skip('the real startup-update gate currently requires a native tmux host');
      return;
    }
    try {
      await execFileAsync('tmux', ['-V']);
    } catch {
      t.skip('tmux is not available');
      return;
    }

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-real-codex-update-'));
    const npmPrefix = path.join(root, 'npm-prefix');
    const codexHome = path.join(root, 'codex-home');
    const tmuxTmpdir = path.join(root, 'tmux');
    const executable = path.join(npmPrefix, 'bin', 'codex');
    const sessionName = `clk-real-codex-update-${process.pid}`;
    const environmentKeys = [
      'PATH',
      'CODEX_HOME',
      'CODELARK_CODEX_CLI_PATH',
      'NPM_CONFIG_PREFIX',
      'TMUX_TMPDIR',
      'TMUX',
      'TMUX_PANE',
      'CODELARK_CODEX_RESUME_TMUX_READY_TIMEOUT_MS',
      'CODELARK_CODEX_RESUME_TMUX_READY_POLL_MS',
    ] as const;
    const environmentSnapshot = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
    fs.mkdirSync(codexHome, { recursive: true });
    fs.mkdirSync(tmuxTmpdir, { recursive: true });
    const isolatedTmuxEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      TMUX_TMPDIR: tmuxTmpdir,
    };
    delete isolatedTmuxEnvironment.TMUX;
    delete isolatedTmuxEnvironment.TMUX_PANE;
    copyIfPresent(path.join(os.homedir(), '.codex', 'auth.json'), path.join(codexHome, 'auth.json'));
    copyIfPresent(path.join(os.homedir(), '.codex', 'config.toml'), path.join(codexHome, 'config.toml'));

    try {
      const latestVersion = await latestCodexVersion();
      assert.notEqual(latestVersion, OLD_CODEX_VERSION, 'the fixture version must remain older than npm latest');
      await execFileAsync('npm', [
        'install',
        '--global',
        '--prefix',
        npmPrefix,
        `@openai/codex@${OLD_CODEX_VERSION}`,
      ], {
        env: process.env,
        timeout: 3 * 60_000,
        maxBuffer: 10 * 1024 * 1024,
      });
      assert.match(await codexVersion(executable, process.env), new RegExp(`\\b${OLD_CODEX_VERSION.replace(/\./g, '\\.')}\\b`));

      process.env.PATH = `${path.join(npmPrefix, 'bin')}${path.delimiter}${environmentSnapshot.PATH || ''}`;
      process.env.CODEX_HOME = codexHome;
      process.env.CODELARK_CODEX_CLI_PATH = executable;
      process.env.NPM_CONFIG_PREFIX = npmPrefix;
      process.env.TMUX_TMPDIR = tmuxTmpdir;
      delete process.env.TMUX;
      delete process.env.TMUX_PANE;
      process.env.CODELARK_CODEX_RESUME_TMUX_READY_TIMEOUT_MS = '15000';
      process.env.CODELARK_CODEX_RESUME_TMUX_READY_POLL_MS = '250';

      const prompts: RuntimeTmuxSelectionPrompt[] = [];
      const statuses: string[] = [];
      const result = await startCodexResumeTmuxSession({
        sessionName,
        bridgeSessionId: 'real-codex-old-version-update',
        workingDirectory: '/opt/tiger/codelark',
        skipGitRepoCheck: true,
        onSelectionPrompt: (prompt) => {
          prompts.push(prompt);
          if (prompt.runtime !== 'codex') return null;
          if (prompt.kind === 'update') return 'update_now';
          return prompt.defaultChoice;
        },
        onStatus: (message) => {
          statuses.push(message);
        },
      }, tmuxCore);

      assert.equal(result.ready, true);
      assert.equal(result.updateRestartCount, 1);
      assert.equal(prompts.some((prompt) => prompt.runtime === 'codex' && prompt.kind === 'update'), true);
      assert.equal(statuses.some((message) => message.includes('正在安装')), true);
      assert.equal(statuses.some((message) => message.includes('正在重新启动 Codex tmux')), true);
      assert.match(
        await codexVersion(executable, process.env),
        new RegExp(`\\b${latestVersion.replace(/\./g, '\\.')}\\b`),
      );
    } finally {
      await execFileAsync('tmux', ['kill-server'], { env: isolatedTmuxEnvironment }).catch(() => undefined);
      restoreEnvironment(environmentSnapshot);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
