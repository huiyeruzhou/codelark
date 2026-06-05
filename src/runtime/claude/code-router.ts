import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

import { sseEvent } from '../sse.js';

const DEFAULT_CCR_START_TIMEOUT_MS = 15_000;
const WINDOWS_HIDE = process.platform === 'win32' ? { windowsHide: true } : {};
const CCR_ENV_READY_STATUS = '已为Claude Code sdk 注入 Router 环境。';

const execFileAsync = promisify(execFile);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePositiveIntEnv(name: string, fallback: number, minValue: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed >= minValue) return Math.floor(parsed);
  return fallback;
}

function unquoteShellValue(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/'\\''/g, "'");
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(["\\$`])/g, '$1');
  }
  return value;
}

export function parseClaudeCodeRouterActivateEnv(output: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of output.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const shellMatch = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u);
    if (shellMatch) {
      env[shellMatch[1]] = unquoteShellValue(shellMatch[2]);
      continue;
    }
    const powershellMatch = trimmed.match(/^\$env:([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u);
    if (powershellMatch) {
      env[powershellMatch[1]] = unquoteShellValue(powershellMatch[2]);
    }
  }
  return env;
}

export function parseClaudeCodeRouterStatus(output: string): boolean {
  if (/(?:not\s+running|status:\s*not\s+running|❌)/iu.test(output)) return false;
  return /(?:status:\s*running|✅|ready\s+to\s+use|process\s+id:|api\s+endpoint:)/iu.test(output);
}

async function readClaudeCodeRouterActivateEnv(
  command: string,
  env: Record<string, string>,
  logPrefix: string,
): Promise<Record<string, string>> {
  try {
    const { stdout } = await execFileAsync(command, ['activate'], {
      env,
      timeout: parsePositiveIntEnv('CODELARK_CLAUDE_CCR_START_TIMEOUT_MS', DEFAULT_CCR_START_TIMEOUT_MS, 1_000),
      ...WINDOWS_HIDE,
    });
    return parseClaudeCodeRouterActivateEnv(stdout);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`${logPrefix} Unable to read Claude Code Router activation env; continuing with bridge env:`, detail);
    return {};
  }
}

async function isClaudeCodeRouterRunning(command: string, env: Record<string, string>): Promise<boolean> {
  try {
    const { stdout, stderr } = await execFileAsync(command, ['status'], {
      env,
      timeout: parsePositiveIntEnv('CODELARK_CLAUDE_CCR_START_TIMEOUT_MS', DEFAULT_CCR_START_TIMEOUT_MS, 1_000),
      ...WINDOWS_HIDE,
    });
    const output = `${stdout}\n${stderr}`;
    return parseClaudeCodeRouterStatus(output);
  } catch {
    return false;
  }
}

async function startClaudeCodeRouter(command: string, env: Record<string, string>): Promise<void> {
  try {
    const timeoutMs = parsePositiveIntEnv(
      'CODELARK_CLAUDE_CCR_START_TIMEOUT_MS',
      DEFAULT_CCR_START_TIMEOUT_MS,
      1_000,
    );
    const child = spawn(command, ['start'], {
      env,
      detached: true,
      stdio: 'ignore',
      ...WINDOWS_HIDE,
    });
    child.unref();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await isClaudeCodeRouterRunning(command, env)) return;
      await sleep(250);
    }
    throw new Error(`timed out waiting for "${command} status" to report running`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Claude Code Router is not running and could not be started with "${command} start": ${detail}`);
  }
}

export async function prepareClaudeCodeRouterEnv(
  command: string,
  env: Record<string, string>,
  options: {
    controller?: ReadableStreamDefaultController<string>;
    logPrefix?: string;
  } = {},
): Promise<Record<string, string>> {
  const { controller, logPrefix = '[claude-router]' } = options;
  const activationEnv = await readClaudeCodeRouterActivateEnv(command, env, logPrefix);
  const nextEnv = { ...env, ...activationEnv };
  if (!(await isClaudeCodeRouterRunning(command, nextEnv))) {
    console.log(`${logPrefix} Claude Code Router is not running; starting it before Claude Code launch`);
    await startClaudeCodeRouter(command, nextEnv);
  }
  controller?.enqueue(sseEvent('status', { reasoning: CCR_ENV_READY_STATUS }));
  return nextEnv;
}
