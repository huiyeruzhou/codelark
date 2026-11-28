import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
import { cursorAcpSessionStorePath } from './acp-session-policy.js';
import { commitCursorCompaction, readCursorCompactState, setCompactCopyGoal } from './compact-store.js';

export interface CursorCompactOptions {
  executable: string; cwd: string; env?: NodeJS.ProcessEnv;
  sessionId: string; model?: string; signal: AbortSignal;
  timeoutMs?: number;
}
async function copyStore(source: string, target: string): Promise<void> {
  const db = new DatabaseSync(source, { readOnly: true });
  try { await backup(db, target); fs.chmodSync(target, 0o600); } finally { db.close(); }
}

/** ACP's writer must already be closed. TUI owns only a private copy. */
export async function compactCursorSession(options: CursorCompactOptions): Promise<{ before: number; after: number }> {
  const env = options.env || process.env;
  const source = cursorAcpSessionStorePath(options.sessionId, env);
  const before = readCursorCompactState(source);
  if (!before.turns.length) throw new Error('当前会话还没有可压缩的历史。');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'codelark-cursor-compact-'));
  fs.chmodSync(scratch, 0o700);
  try {
    const config = path.resolve(source, '../../..');
    // Isolate Cursor's mutable settings and chat index. Authentication keeps the
    // normal OS credential location; never log or change credential contents.
    for (const name of ['cli-config.json', 'agent-cli-state.json', 'statsig-cache.json']) {
      const from = path.join(config, name);
      if (fs.existsSync(from)) { fs.copyFileSync(from, path.join(scratch, name)); fs.chmodSync(path.join(scratch, name), 0o600); }
    }
    const directory = path.join(scratch, 'chats', createHash('md5').update(path.resolve(options.cwd)).digest('hex'), options.sessionId);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const copy = path.join(directory, 'store.db');
    await copyStore(source, copy);
    setCompactCopyGoal(copy, before.goal, true);
    const initial = readCursorCompactState(copy);
    options.signal.throwIfAborted();
    const loaded = await import('@homebridge/node-pty-prebuilt-multiarch');
    const pty = loaded.default || loaded;
    const args = ['--resume', options.sessionId, '--trust', '--disable-auto-update'];
    if (options.model) args.push('--model', options.model);
    const child = pty.spawn(options.executable, args, { cwd: options.cwd,
      env: { ...env, CURSOR_CONFIG_DIR: scratch, NODE_OPTIONS: undefined }, cols: 120, rows: 32, name: 'xterm-256color' });
    let exited = false;
    const exit = new Promise<void>(resolve => child.onExit(() => { exited = true; resolve(); }));
    const stop = async () => {
      if (!exited) child.kill('SIGTERM');
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([exit, new Promise<void>(resolve => { timer = setTimeout(resolve, 2_000); })]);
        if (!exited) { child.kill('SIGKILL'); await Promise.race([exit, new Promise<void>((_, reject) => { timer = setTimeout(() => reject(new Error('Cursor 压缩进程尚未确认退出，未写回会话。')), 2_000); })]); }
      } finally { if (timer) clearTimeout(timer); }
    };
    try {
      await new Promise<void>((resolve, reject) => {
        let screen = '', typed = false, submitted = false, finished = false;
        const finish = (error?: Error) => {
          if (finished) return; finished = true; clearInterval(poll); clearTimeout(timeout);
          data.dispose(); death.dispose(); options.signal.removeEventListener('abort', abort);
          if (error) reject(error); else resolve();
        };
        const abort = () => finish(new Error('Cursor 压缩已取消，原始会话保持不变。'));
        const data = child.onData(chunk => {
          screen = (screen + chunk).slice(-32_000);
          const plain = screen.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
          if (!typed && (plain.includes('Add a follow-up') || / · \d+(?:\.\d+)?%/.test(plain))) {
            typed = true; screen = ''; child.write('/summarize');
            return;
          }
          // Submit only after Cursor identifies the selected builtin action.
          // A slow render must never turn /summarize into an ordinary prompt.
          if (typed && !submitted && /→\s*\/summarize\s+Summarize the conversation to reduce context/.test(plain)) {
            submitted = true; child.write('\r');
          }
        });
        const death = child.onExit(() => finish(new Error('Cursor CLI 在完成压缩前退出，原始会话保持不变。')));
        const poll = setInterval(() => {
          if (!submitted) return;
          try {
            const state = readCursorCompactState(copy);
            if (state.summary && state.summary !== initial.summary && state.root !== initial.root) finish();
          } catch { /* An in-flight checkpoint is not success. */ }
        }, 250);
        const timeout = setTimeout(() => finish(new Error('Cursor 原生压缩在 180 秒内未完成，原始会话保持不变。')), options.timeoutMs ?? 180_000);
        options.signal.addEventListener('abort', abort, { once: true });
        if (options.signal.aborted) abort();
      });
    } finally { await stop(); }
    options.signal.throwIfAborted();
    setCompactCopyGoal(copy, before.goal);
    const after = readCursorCompactState(copy);
    if (!after.summary || after.summary === before.summary || JSON.stringify(before.turns) !== JSON.stringify(after.turns)
      || !Buffer.from(before.goal || []).equals(Buffer.from(after.goal || []))) throw new Error('Cursor 压缩校验失败，未替换原始会话。');
    commitCursorCompaction(source, copy, before.root, options.signal);
    return { before: before.messages, after: after.messages };
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}
