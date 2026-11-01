import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { CodexReasoningEffort, CodexSandboxMode } from '../options.js';
import { resolveCodexCliExecutable } from './cli-executable.js';
import { quoteCommandLineArg } from './shell-snapshot.js';
import { buildCodexTuiEnv, findSessionFileByThreadId } from './tmux-provider.js';

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

function buildLocalBootstrapArgs(options: LocalCodexThreadBootstrapOptions, modelProvider = 'openai'): string[] {
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
  // Codex persists provider identity and newer TUIs reject a resume under a
  // different provider. Keep the effective provider, redirect only this exec's
  // endpoint, and never send the synthetic prompt to the configured model.
  args.push('--config', `model_provider=${JSON.stringify(modelProvider)}`);
  args.push('--config', `openai_base_url="${LOCAL_BOOTSTRAP_BASE_URL}"`);
  if (modelProvider !== 'openai') {
    // Older CLIs split dotted override paths without parsing quoted keys.
    // Override the table as TOML so provider names containing dots also work.
    args.push('--config', `model_providers={${JSON.stringify(modelProvider)}={name=${JSON.stringify(modelProvider)},base_url="${LOCAL_BOOTSTRAP_BASE_URL}",wire_api="responses",requires_openai_auth=false}}`);
  }
  args.push(LOCAL_BOOTSTRAP_PROMPT);
  return args;
}

function buildLocalBootstrapEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = buildCodexTuiEnv();
  const apiKey = env.CODELARK_CODEX_API_KEY || env.CODEX_API_KEY || env.OPENAI_API_KEY || 'clk-local-bootstrap-dummy-key';
  env.CODEX_API_KEY = apiKey;
  env.OPENAI_API_KEY = apiKey;
  return env;
}

function buildLocalBootstrapInvocation(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): { command: string; args: string[]; windowsVerbatimArguments?: boolean } {
  if (process.platform !== 'win32') return { command: executable, args };
  if (/\.[cm]?js$/i.test(executable)) return { command: process.execPath, args: [executable, ...args] };
  if (!/\.(cmd|bat)$/i.test(executable)) return { command: executable, args };

  // PowerShell's legacy native argument conversion strips the TOML quotes.
  // Use cmd only for batch launchers, preserving both CRT argument boundaries
  // and cmd metacharacters. npm .bin shims add one more cmd expansion layer.
  const escapeMeta = (value: string) => value.replace(/([()\][%!^"`<>&|;, *?])/g, '^$1');
  const doubleEscape = /[\\/]node_modules[\\/]\.bin[\\/]/i.test(executable);
  const escapedArgs = args.map((arg) => {
    const quoted = quoteCommandLineArg(arg, 'win32');
    const escaped = escapeMeta(quoted.startsWith('"') ? quoted : `"${quoted}"`);
    return doubleEscape ? escapeMeta(escaped) : escaped;
  });
  const command = [escapeMeta(path.win32.normalize(executable)), ...escapedArgs].join(' ');
  return {
    command: env.ComSpec || env.comspec || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${command}"`],
    windowsVerbatimArguments: true,
  };
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

async function waitForBootstrapClose(closed: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      closed.then(() => true),
      new Promise<false>((resolve) => { timeout = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function stopBootstrapProcess(
  child: ChildProcess,
  closed: Promise<void>,
  isClosed: () => boolean,
): Promise<void> {
  if (isClosed()) return;
  try {
    if (process.platform === 'win32' && child.pid) {
      // Killing cmd.exe alone leaves the npm launcher/native Codex descendants
      // holding our output pipes and potentially writing the session after trim.
      await new Promise<void>((resolve, reject) => {
        execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          timeout: 5_000,
        }, (error) => {
          if (error && !isClosed()) reject(error);
          else resolve();
        });
      });
    } else {
      child.kill('SIGTERM');
      if (await waitForBootstrapClose(closed, 500)) return;
      child.kill('SIGKILL');
    }
    if (!await waitForBootstrapClose(closed, 5_000)) {
      throw new Error('bootstrap process output pipes did not close');
    }
  } catch (error) {
    // Report cleanup failure instead of handing a still-written session to TUI.
    // Release our pipe handles even if the OS refused termination.
    child.kill('SIGKILL');
    child.stdout?.destroy();
    child.stderr?.destroy();
    throw new Error('本地 Codex thread bootstrap 子进程清理失败。', { cause: error });
  }
}

async function readBootstrapModelProvider(executable: string, env: NodeJS.ProcessEnv, cwd?: string): Promise<string> {
  // Let Codex resolve user/project configuration and profiles itself. Guessing
  // from one config.toml misses overrides and can stamp the wrong provider.
  const invocation = buildLocalBootstrapInvocation(executable, ['app-server'], env);
  return new Promise<string>((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: process.platform === 'win32',
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    let settled = false;
    let childClosed = false;
    let pending = '';
    let stderr = '';
    const closed = new Promise<void>((done) => child.once('close', () => { childClosed = true; done(); }));
    const finish = (result: string | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      void stopBootstrapProcess(child, closed, () => childClosed).then(() => {
        if (result instanceof Error) reject(result); else resolve(result);
      }, reject);
    };
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const timeout = setTimeout(() => finish(new Error('读取 Codex bootstrap provider 配置超时。')), LOCAL_BOOTSTRAP_TIMEOUT_MS);
    child.stdin.on('error', (error) => finish(error));
    child.on('error', (error) => finish(error));
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-8_000); });
    child.stdout.on('data', (chunk) => {
      pending += chunk.toString();
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim() || settled) continue;
        try {
          const message = JSON.parse(line);
          if (message.id !== 1 && message.id !== 2) continue;
          if (message.error) throw new Error(`读取 Codex bootstrap provider 失败：${message.error.message}`);
          if (message.id === 1) {
            send({ method: 'initialized' });
            send({ id: 2, method: 'config/read', params: { includeLayers: false, ...(cwd ? { cwd } : {}) } });
          } else {
            const config = message.result?.config;
            if (!config || (config.model_provider != null && (typeof config.model_provider !== 'string' || !config.model_provider.trim()))) {
              throw new Error('Codex config/read 未返回有效的 model_provider 配置。');
            }
            finish(config.model_provider || 'openai');
          }
        } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
      }
    });
    child.on('close', (code) => finish(new Error(`读取 Codex bootstrap provider 失败（${code ?? 'unknown'}）：${stderr.trim()}`)));
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'codelark_bootstrap', version: '1' } } });
  });
}

export async function bootstrapLocalCodexThread(options: LocalCodexThreadBootstrapOptions): Promise<string> {
  const env = buildLocalBootstrapEnv();
  const executable = resolveCodexCliExecutable({ env: env as Record<string, string> });
  const modelProvider = await readBootstrapModelProvider(executable, env, options.workingDirectory).catch((error) => {
    throw new Error(`本地 Codex thread bootstrap 失败：${error instanceof Error ? error.message : String(error)}`, { cause: error });
  });
  const args = buildLocalBootstrapArgs(options, modelProvider);
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
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    let pending = '';
    let stderr = '';
    let settled = false;
    let resolvingThread = false;
    let childClosed = false;
    const closed = new Promise<void>((resolveClose) => {
      child.once('close', () => { childClosed = true; resolveClose(); });
    });
    // Reserve exactly one outcome, then complete cleanup before resolving or
    // rejecting. The timeout and session discovery can race while stopping.
    const finish = (result: { threadId: string; sessionFile: string } | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      void stopBootstrapProcess(child, closed, () => childClosed).then(() => {
        if (result instanceof Error) reject(result);
        else resolve(result);
      }, reject);
    };
    const resolveAfterSessionFile = (foundThreadId: string) => {
      if (settled || resolvingThread) return;
      resolvingThread = true;
      void waitForSessionFileByThreadId(foundThreadId).then((foundSessionFile) => {
        if (!foundSessionFile) {
          finish(new Error(`本地 Codex thread bootstrap 已创建 thread ${foundThreadId}，但未找到可用 session JSONL。`));
          return;
        }
        finish({ threadId: foundThreadId, sessionFile: foundSessionFile });
      }, (error: Error) => finish(error));
    };
    const timeout = setTimeout(() => {
      finish(new Error(`本地 Codex thread bootstrap 超时：未收到 thread.started。${stderr.trim() ? `\n${stderr.trim()}` : ''}`));
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
      finish(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      const foundThreadId = readThreadIdFromCodexExecLine(pending);
      if (foundThreadId) {
        resolveAfterSessionFile(foundThreadId);
        return;
      }
      if (resolvingThread) return;
      finish(new Error(`本地 Codex thread bootstrap 失败：codex exec exited with ${code ?? 'unknown'}。${stderr.trim() ? `\n${stderr.trim()}` : ''}`));
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
  buildLocalBootstrapArgs,
  readThreadIdFromCodexExecLine,
  isBootstrapSessionFileReady,
  waitForSessionFileByThreadId,
  trimLocalBootstrapSessionToContextPrefix,
  LOCAL_BOOTSTRAP_PROMPT,
  LOCAL_BOOTSTRAP_TIMEOUT_MS,
};
