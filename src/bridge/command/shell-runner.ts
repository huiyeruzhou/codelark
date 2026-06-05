import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

import { resolveCodexCliExecutable } from '../../runtime/codex/cli-executable.js';
import type { ShellSandboxMode } from './shell-args.js';

const execFileAsync = promisify(execFile);

const SHELL_COMMAND_MAX_OUTPUT_BYTES = 96_000;
const CODEX_SHELL_WORKSPACE_NETWORK_PROFILE = 'codelark_shell_workspace_network';
const CODEX_SHELL_READ_ONLY_NETWORK_PROFILE = 'codelark_shell_read_only_network';
const CODEX_SANDBOX_HELP_TIMEOUT_MS = 5_000;
const DEFAULT_SHELL_REFRESH_INTERVAL_SECONDS = 5;
const MIN_SHELL_REFRESH_INTERVAL_SECONDS = 5;

export type CodexSandboxCliStyle = 'top-level' | 'linux-subcommand';

export interface ShellCommandRunRequest {
  command: string;
  cwd: string;
  sandboxMode: ShellSandboxMode;
  networkAccess: boolean;
  shell: string;
  timeoutMs: number;
  refreshIntervalSeconds?: number;
  onProgress?: (progress: ShellCommandProgress) => void;
}

export interface ShellCommandRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  outputTruncated?: boolean;
}

export interface ShellCommandProgress {
  exitCode?: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  outputTruncated?: boolean;
}

export type ShellCommandRunner = (request: ShellCommandRunRequest) => Promise<ShellCommandRunResult>;

function codexSandboxPermissionProfile(request: ShellCommandRunRequest): string {
  if (!request.networkAccess) {
    return request.sandboxMode === 'read-only' ? ':read-only' : ':workspace';
  }
  return request.sandboxMode === 'read-only'
    ? CODEX_SHELL_READ_ONLY_NETWORK_PROFILE
    : CODEX_SHELL_WORKSPACE_NETWORK_PROFILE;
}

function buildCodexNetworkProfileConfigArgs(request: ShellCommandRunRequest): string[] {
  if (!request.networkAccess) return [];
  const profile = codexSandboxPermissionProfile(request);
  const parentProfile = request.sandboxMode === 'read-only' ? ':read-only' : ':workspace';
  return [
    '-c',
    `permissions.${profile}.extends=${JSON.stringify(parentProfile)}`,
    '-c',
    `permissions.${profile}.network.enabled=true`,
    '-c',
    `permissions.${profile}.network.mode="full"`,
  ];
}

export function buildCodexSandboxArgs(
  request: ShellCommandRunRequest,
  cliStyle: CodexSandboxCliStyle = 'top-level',
): string[] {
  return [
    'sandbox',
    ...(cliStyle === 'linux-subcommand' ? ['linux'] : []),
    ...buildCodexNetworkProfileConfigArgs(request),
    '--permissions-profile',
    codexSandboxPermissionProfile(request),
    '--cd',
    request.cwd,
    request.shell,
    '-lc',
    request.command,
  ];
}

export function detectCodexSandboxCliStyleFromHelp(helpText: string): CodexSandboxCliStyle {
  if (/(^|\n)\s+--permissions-profile\b/.test(helpText)) return 'top-level';
  if (/(^|\n)Commands:\s*[\s\S]*\n\s+linux\b/.test(helpText)) return 'linux-subcommand';
  return 'top-level';
}

async function resolveCodexSandboxCliStyle(executable: string): Promise<CodexSandboxCliStyle> {
  try {
    const help = await execFileAsync(executable, ['sandbox', '--help'], {
      timeout: CODEX_SANDBOX_HELP_TIMEOUT_MS,
      maxBuffer: 48_000,
      env: process.env,
    });
    return detectCodexSandboxCliStyleFromHelp(String(help.stdout || ''));
  } catch {
    return 'top-level';
  }
}

async function execCodexSandbox(
  executable: string,
  request: ShellCommandRunRequest,
  cliStyle: CodexSandboxCliStyle,
): Promise<ShellCommandRunResult> {
  const args = buildCodexSandboxArgs(request, cliStyle);
  if (!request.onProgress) {
    const result = await execFileAsync(executable, args, {
      cwd: request.cwd,
      timeout: request.timeoutMs,
      maxBuffer: SHELL_COMMAND_MAX_OUTPUT_BYTES,
      env: process.env,
    });
    return {
      exitCode: 0,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
    };
  }

  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      cwd: request.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let outputTruncated = false;
    let timedOut = false;
    let settled = false;

    const appendOutput = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
      if (outputTruncated) return;
      outputBytes += chunk.byteLength;
      if (outputBytes > SHELL_COMMAND_MAX_OUTPUT_BYTES) {
        outputTruncated = true;
        child.kill('SIGTERM');
        return;
      }
      const text = chunk.toString('utf8');
      if (stream === 'stdout') stdout += text;
      else stderr += text;
    };

    const emitProgress = () => {
      request.onProgress?.({ stdout, stderr, timedOut, outputTruncated });
    };

    const progressTimer = setInterval(
      emitProgress,
      Math.max(MIN_SHELL_REFRESH_INTERVAL_SECONDS, request.refreshIntervalSeconds || DEFAULT_SHELL_REFRESH_INTERVAL_SECONDS) * 1000,
    );
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, request.timeoutMs);

    const finish = (result: ShellCommandRunResult) => {
      if (settled) return;
      settled = true;
      clearInterval(progressTimer);
      clearTimeout(timeout);
      emitProgress();
      resolve(result);
    };

    child.stdout?.on('data', (chunk: Buffer) => appendOutput('stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer) => appendOutput('stderr', chunk));
    child.on('error', (error) => {
      finish({
        exitCode: null,
        stdout,
        stderr: stderr || error.message,
        timedOut,
        outputTruncated,
      });
    });
    child.on('close', (code) => {
      const exitCode = typeof code === 'number' ? code : null;
      const finalStderr = outputTruncated
        ? `${stderr}${stderr ? '\n' : ''}输出超过 ${SHELL_COMMAND_MAX_OUTPUT_BYTES} bytes，已终止。`
        : stderr;
      request.onProgress?.({ exitCode, stdout, stderr: finalStderr, timedOut, outputTruncated });
      finish({
        exitCode,
        stdout,
        stderr: finalStderr,
        timedOut,
        outputTruncated,
      });
    });
  });
}

function shouldRetryWithLegacyLinuxSandbox(error: unknown): boolean {
  const err = error as { stderr?: string | Buffer; message?: string };
  const stderr = err.stderr ? String(err.stderr) : '';
  const message = err.message || '';
  return /unexpected argument ['"]--permissions-profile['"]/.test(stderr)
    || /unexpected argument ['"]--permissions-profile['"]/.test(message)
    || /bwrap: execvp .*\/codex\/codex: No such file or directory/.test(stderr)
    || /bwrap: execvp .*\/codex\/codex: No such file or directory/.test(message);
}

export const defaultShellCommandRunner: ShellCommandRunner = async (request) => {
  const executable = resolveCodexCliExecutable();
  const cliStyle = await resolveCodexSandboxCliStyle(executable);
  try {
    let result: ShellCommandRunResult;
    try {
      result = await execCodexSandbox(executable, request, cliStyle);
    } catch (error) {
      if (!shouldRetryWithLegacyLinuxSandbox(error)) throw error;
      result = await execCodexSandbox(executable, request, 'linux-subcommand');
    }
    if (
      result.exitCode !== 0
      && cliStyle !== 'linux-subcommand'
      && shouldRetryWithLegacyLinuxSandbox({ stderr: result.stderr, message: result.stderr })
    ) {
      result = await execCodexSandbox(executable, request, 'linux-subcommand');
    }
    return result;
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {
      code?: number | string;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      killed?: boolean;
    };
    return {
      exitCode: typeof err.code === 'number' ? err.code : null,
      stdout: err.stdout ? String(err.stdout) : '',
      stderr: err.stderr ? String(err.stderr) : (err.message || String(error)),
      timedOut: err.killed === true || /timed out/i.test(err.message || ''),
    };
  }
};
