import { spawn } from 'node:child_process';
import fs from 'node:fs';

import type { CodexReasoningEffort, CodexSandboxMode } from '../options.js';
import { resolveCodexCliExecutable } from './cli-executable.js';
import {
  buildShellSnapshotLaunchArgs,
  ensureShellSnapshot,
} from './shell-snapshot.js';
import { findSessionFileByThreadId } from './tmux-provider.js';

const LOCAL_BOOTSTRAP_BASE_URL = 'http://127.0.0.1:9/v1';
const LOCAL_BOOTSTRAP_TIMEOUT_MS = 15_000;
const BOOTSTRAP_THREAD_VISIBILITY_TIMEOUT_MS = 2_000;
const BOOTSTRAP_THREAD_VISIBILITY_POLL_MS = 50;
const LOCAL_BOOTSTRAP_PROMPT = 'CodeLark local thread bootstrap. This request is expected to fail before reaching a model.';

export interface LocalCodexThreadBootstrapOptions {
  bridgeSessionId?: string;
  model?: string;
  workingDirectory?: string;
  mode: string;
  sandboxMode?: CodexSandboxMode;
  networkAccessEnabled?: boolean;
  modelReasoningEffort?: CodexReasoningEffort;
  skipGitRepoCheck?: boolean;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function commandPreview(command: string, args: string[]): string {
  return [command, ...args].map(shellQuote).join(' ');
}

function buildLocalBootstrapArgs(options: LocalCodexThreadBootstrapOptions): string[] {
  const args = ['exec', '--json'];
  if (options.model) args.push('--model', options.model);
  if (options.mode === 'yolo') {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  } else if (options.sandboxMode) {
    args.push('--sandbox', options.sandboxMode);
  }
  if (options.workingDirectory) args.push('--cd', options.workingDirectory);
  if (options.skipGitRepoCheck) args.push('--skip-git-repo-check');
  if (options.modelReasoningEffort) {
    args.push('--config', `model_reasoning_effort="${options.modelReasoningEffort}"`);
  }
  if (typeof options.networkAccessEnabled === 'boolean') {
    args.push('--config', `sandbox_workspace_write.network_access=${options.networkAccessEnabled}`);
  }
  args.push('--config', 'preferred_auth_method="apikey"');
  args.push('--config', `openai_base_url="${LOCAL_BOOTSTRAP_BASE_URL}"`);
  args.push(LOCAL_BOOTSTRAP_PROMPT);
  return args;
}

function buildLocalBootstrapEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const apiKey = env.CODELARK_CODEX_API_KEY || env.CODEX_API_KEY || env.OPENAI_API_KEY || 'clk-local-bootstrap-dummy-key';
  env.CODEX_API_KEY = apiKey;
  env.OPENAI_API_KEY = apiKey;
  return env;
}

function buildLocalBootstrapInvocation(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): { command: string; args: string[] } {
  if (process.platform !== 'win32') return { command: executable, args };
  const definedEnv = Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const launchArgs = buildShellSnapshotLaunchArgs(
    executable,
    args,
    ensureShellSnapshot(definedEnv),
    { platform: process.platform },
  );
  return { command: launchArgs[0]!, args: launchArgs.slice(1) };
}

function readThreadIdFromCodexExecLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as { type?: unknown; thread_id?: unknown };
    return parsed.type === 'thread.started' && typeof parsed.thread_id === 'string' && parsed.thread_id.trim()
      ? parsed.thread_id.trim()
      : null;
  } catch {
    return null;
  }
}

async function waitForSessionFileByThreadId(threadId: string): Promise<string | null> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < BOOTSTRAP_THREAD_VISIBILITY_TIMEOUT_MS) {
    const filePath = findSessionFileByThreadId(threadId);
    if (filePath && isBootstrapSessionFileReady(filePath, threadId)) return filePath;
    await delay(BOOTSTRAP_THREAD_VISIBILITY_POLL_MS);
  }
  return null;
}

function readFirstSessionLine(filePath: string): string {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const chunks: Buffer[] = [];
    const buffer = Buffer.alloc(4096);
    let offset = 0;
    while (offset < 1024 * 1024) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, offset);
      if (bytesRead <= 0) break;
      const slice = Buffer.from(buffer.subarray(0, bytesRead));
      chunks.push(slice);
      offset += bytesRead;
      if (slice.includes(0x0a)) break;
    }
    return Buffer.concat(chunks).toString('utf-8').split(/\r?\n/, 1)[0] || '';
  } catch {
    return '';
  } finally {
    if (fd != null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function isBootstrapSessionFileReady(filePath: string, threadId: string): boolean {
  const firstLine = readFirstSessionLine(filePath);
  if (!firstLine) return false;
  try {
    const parsed = JSON.parse(firstLine) as { type?: unknown; payload?: { id?: unknown } };
    return parsed.type === 'session_meta' && parsed.payload?.id === threadId;
  } catch {
    return false;
  }
}

function isLocalBootstrapPromptLine(line: string): boolean {
  try {
    const parsed = JSON.parse(line) as {
      type?: unknown;
      payload?: {
        type?: unknown;
        role?: unknown;
        message?: unknown;
        content?: Array<{ text?: unknown }>;
      };
    };
    if (parsed.type === 'event_msg' && parsed.payload?.type === 'user_message') {
      return parsed.payload.message === LOCAL_BOOTSTRAP_PROMPT;
    }
    if (parsed.type === 'response_item' && parsed.payload?.role === 'user') {
      return Array.isArray(parsed.payload.content)
        && parsed.payload.content.some((part) => part.text === LOCAL_BOOTSTRAP_PROMPT);
    }
    return false;
  } catch {
    return false;
  }
}

export function trimLocalBootstrapSessionToContextPrefix(filePath: string, threadId: string): void {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split(/\r?\n/).filter((line) => line.trim());
  const firstLine = lines[0] || '';
  if (!firstLine) {
    throw new Error(`本地 Codex thread bootstrap 已创建 thread ${threadId}，但 session 文件为空。`);
  }
  try {
    const parsed = JSON.parse(firstLine) as { type?: unknown; payload?: { id?: unknown } };
    if (parsed.type !== 'session_meta' || parsed.payload?.id !== threadId) {
      throw new Error('session_meta mismatch');
    }
  } catch (error) {
    throw new Error(`本地 Codex thread bootstrap 无法校验 session_meta：${error instanceof Error ? error.message : String(error)}`);
  }

  const bootstrapPromptIndex = lines.findIndex(isLocalBootstrapPromptLine);
  const keptLines = bootstrapPromptIndex > 0 ? lines.slice(0, bootstrapPromptIndex) : [firstLine];
  fs.writeFileSync(filePath, `${keptLines.join('\n')}\n`, 'utf-8');
}

export async function bootstrapLocalCodexThread(options: LocalCodexThreadBootstrapOptions): Promise<string> {
  const env = buildLocalBootstrapEnv();
  const executable = resolveCodexCliExecutable({ env: env as Record<string, string> });
  const args = buildLocalBootstrapArgs(options);
  console.log('[codex-thread-bootstrap] Local Codex thread bootstrap start:', {
    bridge_session_id: options.bridgeSessionId,
    command: commandPreview(executable, args),
    base_url: LOCAL_BOOTSTRAP_BASE_URL,
  });
  const invocation = buildLocalBootstrapInvocation(executable, args, env);

  const { threadId, sessionFile } = await new Promise<{ threadId: string; sessionFile: string }>((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: process.platform === 'win32',
    });
    let pending = '';
    let stderr = '';
    let settled = false;
    let resolvingThread = false;
    let childClosed = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      fn();
    };
    const waitForChildClose = async () => {
      if (childClosed) return;
      await new Promise<void>((resolveClose) => {
        const closeTimeout = setTimeout(resolveClose, 500);
        closeTimeout.unref?.();
        child.once('close', () => {
          clearTimeout(closeTimeout);
          resolveClose();
        });
      });
    };
    const resolveAfterSessionFile = (foundThreadId: string) => {
      if (settled || resolvingThread) return;
      resolvingThread = true;
      void (async () => {
        const foundSessionFile = await waitForSessionFileByThreadId(foundThreadId);
        if (!foundSessionFile) {
          settle(() => {
            child.kill('SIGTERM');
            reject(new Error(`本地 Codex thread bootstrap 已创建 thread ${foundThreadId}，但未找到可用 session JSONL。`));
          });
          return;
        }
        child.kill('SIGTERM');
        await waitForChildClose();
        settle(() => {
          resolve({ threadId: foundThreadId, sessionFile: foundSessionFile });
        });
      })();
    };
    const timeout = setTimeout(() => {
      settle(() => {
        child.kill('SIGTERM');
        reject(new Error(`本地 Codex thread bootstrap 超时：未收到 thread.started。${stderr.trim() ? `\n${stderr.trim()}` : ''}`));
      });
    }, LOCAL_BOOTSTRAP_TIMEOUT_MS);
    timeout.unref?.();

    child.stdout?.on('data', (chunk) => {
      pending += chunk.toString('utf-8');
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || '';
      for (const line of lines) {
        const foundThreadId = readThreadIdFromCodexExecLine(line);
        if (foundThreadId) {
          resolveAfterSessionFile(foundThreadId);
          return;
        }
      }
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString('utf-8');
      if (stderr.length > 8_000) stderr = stderr.slice(-8_000);
    });
    child.on('error', (error) => {
      settle(() => reject(error));
    });
    child.on('close', (code) => {
      childClosed = true;
      const foundThreadId = readThreadIdFromCodexExecLine(pending);
      if (foundThreadId) {
        resolveAfterSessionFile(foundThreadId);
        return;
      }
      if (resolvingThread) return;
      settle(() => reject(new Error(`本地 Codex thread bootstrap 失败：codex exec exited with ${code ?? 'unknown'}。${stderr.trim() ? `\n${stderr.trim()}` : ''}`)));
    });
  });
  trimLocalBootstrapSessionToContextPrefix(sessionFile, threadId);
  console.log('[codex-thread-bootstrap] Local Codex thread bootstrap complete:', {
    bridge_session_id: options.bridgeSessionId,
    thread_id: threadId,
    session_file: sessionFile,
  });
  return threadId;
}

export const _testOnlyCodexThreadBootstrap = {
  readThreadIdFromCodexExecLine,
  isBootstrapSessionFileReady,
  waitForSessionFileByThreadId,
  trimLocalBootstrapSessionToContextPrefix,
  LOCAL_BOOTSTRAP_PROMPT,
  LOCAL_BOOTSTRAP_TIMEOUT_MS,
};
