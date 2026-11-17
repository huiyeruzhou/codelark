import { spawn, type ChildProcess } from 'node:child_process';

export const CURSOR_AUTH_FAILURE = /Authentication (?:failed|required|error)|(?:credentials|API key).*(?:invalid|expired)|Press any key to log in/i;
export class CursorLoginError extends Error {}

/** Only forward the official browser challenge, never CLI output or credentials. */
export function cursorLoginUrl(output: string): string | undefined {
  for (const candidate of output.match(/https:\/\/[^\s\x1b<>"']+/g) || []) {
    try {
      const url = new URL(candidate);
      if (url.origin === 'https://cursor.com' && url.pathname === '/loginDeepControl'
        && url.searchParams.has('challenge') && url.searchParams.has('uuid')) return url.toString();
    } catch { /* Wait for the rest of a split stdout chunk. */ }
  }
  return undefined;
}

interface LoginAttempt {
  child: ChildProcess;
  done: Promise<void>;
  listeners: Set<(url: string) => void>;
  url?: string;
}

/** One official login per credential directory; each waiting chat can stop independently. */
export class CursorLoginManager {
  private attempts = new Map<string, LoginAttempt>();

  constructor(private launch: (executable: string) => ChildProcess = executable => spawn(executable, ['login'], {
    env: { ...process.env, NO_OPEN_BROWSER: '1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })) {}

  async wait(executable: string, notify: (url: string) => void, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (process.env.CURSOR_API_KEY || process.env.CURSOR_AUTH_TOKEN) {
      throw new CursorLoginError('Cursor 的环境变量认证失效；请更新 CURSOR_API_KEY / CURSOR_AUTH_TOKEN。网页登录无法覆盖这些变量，本条消息尚未发送。');
    }
    const key = JSON.stringify([executable, process.env.HOME, process.env.USERPROFILE,
      process.env.CURSOR_CONFIG_DIR, process.env.CURSOR_DATA_DIR, process.env.XDG_CONFIG_HOME]);
    let attempt = this.attempts.get(key);
    if (!attempt) {
      const child = this.launch(executable);
      const listeners = new Set<(url: string) => void>();
      const created: LoginAttempt = { child, listeners, done: Promise.resolve() };
      let output = '';
      const read = (chunk: Buffer | string) => {
        output = (output + chunk.toString()).slice(-32_768);
        // Require a complete line so split URL query parameters are not lost.
        const end = output.lastIndexOf('\n');
        const url = cursorLoginUrl(end < 0 ? '' : output.slice(0, end));
        if (url && url !== created.url) {
          created.url = url;
          for (const listener of listeners) listener(url);
        }
      };
      created.done = new Promise<void>((resolve, reject) => {
        child.stdout?.on('data', read); child.stderr?.on('data', read);
        child.once('error', () => reject(new CursorLoginError('无法启动 Cursor 官方登录进程；请检查 agent 是否可执行。')));
        child.once('close', code => code === 0 ? resolve()
          : reject(new CursorLoginError('Cursor 登录未完成或已过期；本条消息尚未发送，再次发送消息可重新发起登录。')));
      }).finally(() => { if (this.attempts.get(key) === created) this.attempts.delete(key); });
      this.attempts.set(key, created);
      attempt = created;
    }
    const active = attempt;
    active.listeners.add(notify);
    let abort: (() => void) | undefined;
    try {
      if (active.url) notify(active.url);
      await Promise.race([active.done, new Promise<never>((_, reject) => {
        abort = () => reject(signal?.reason || new Error('Cursor login aborted.'));
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      })]);
    } finally {
      if (abort) signal?.removeEventListener('abort', abort);
      active.listeners.delete(notify);
      if (active.listeners.size === 0) {
        if (this.attempts.get(key) === active) this.attempts.delete(key);
        if (active.child.exitCode === null && active.child.signalCode === null) active.child.kill();
      }
    }
  }
}

export const cursorLoginManager = new CursorLoginManager();
