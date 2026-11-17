import '../../../setup/test-setup.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { CursorLoginManager, cursorLoginUrl } from '../../../../runtime/cursor/login.js';

const url = 'https://cursor.com/loginDeepControl?challenge=test&uuid=test&mode=login';

it('shares one login across chats and stopping one waiter does not cancel another', { timeout: 10_000 }, async () => {
  const children: ReturnType<typeof spawn>[] = [];
  const manager = new CursorLoginManager(() => {
    const child = spawn(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(url.slice(0, 45))}); setTimeout(() => { console.log(${JSON.stringify(url.slice(45))}); }, 20); process.on('message', () => process.exit(0));`], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    children.push(child); return child;
  });
  const first = new AbortController(), second = new AbortController();
  let received!: () => void;
  const published = new Promise<void>(resolve => { received = resolve; });
  const links: string[] = [];
  const a = manager.wait('isolated-cursor', link => links.push(link), first.signal);
  const b = manager.wait('isolated-cursor', link => { links.push(link); received(); }, second.signal);
  try {
    await published;
    assert.deepEqual(links, [url, url]); assert.equal(children.length, 1);
    first.abort(new Error('stop first chat'));
    await assert.rejects(a, /stop first chat/);
    assert.equal(children[0]!.killed, false);
    children[0]!.send!('complete'); // IPC works on Windows as well as POSIX.
    await b;
  } finally { first.abort(); second.abort(); for (const child of children) child.kill(); await Promise.allSettled([a, b]); }
});

it('stopping all login waiters kills only that attempt and a later request starts anew', async () => {
  const children: ReturnType<typeof spawn>[] = [];
  const manager = new CursorLoginManager(() => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child); return child;
  });
  for (let i = 0; i < 2; i++) {
    const abort = new AbortController();
    const pending = manager.wait('isolated-cursor', () => {}, abort.signal);
    abort.abort(new Error('stop'));
    await assert.rejects(pending, /stop/);
    assert.equal(children.length, i + 1); assert.equal(children[i]!.killed, true);
  }
});

it('does not replace an environment API credential with a browser login', async () => {
  const previous = process.env.CURSOR_API_KEY;
  process.env.CURSOR_API_KEY = 'invalid-test-key';
  try {
    const manager = new CursorLoginManager(() => { throw Error('must not launch'); });
    await assert.rejects(manager.wait('isolated-cursor', () => {}), /CURSOR_API_KEY/);
  } finally { if (previous === undefined) delete process.env.CURSOR_API_KEY; else process.env.CURSOR_API_KEY = previous; }
});

it('only forwards official Cursor login challenges', () => {
  assert.equal(cursorLoginUrl(`Open: ${url}\n`), url);
  for (const candidate of ['https://cursor.com.evil.test/loginDeepControl?challenge=x&uuid=x',
    'https://evil.test/loginDeepControl?challenge=x&uuid=x', 'https://cursor.com/loginDeepControl']) {
    assert.equal(cursorLoginUrl(candidate), undefined);
  }
});
