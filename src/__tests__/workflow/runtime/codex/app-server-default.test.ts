import '../../../setup/test-setup.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test, type TestContext } from 'node:test';
import { codexLocalAppServerEndpoint, prepareCodexLocalAppServer, closeCodexLocalAppServers, localAppServerInvocation } from '../../../../runtime/codex/app-server-local.js';
import { prepareCodexAppServerSession, closeCodexAppServerSessions } from '../../../../runtime/codex/app-server-registry.js';
import { CodexAppServerClient } from '../../../../runtime/codex/app-server-client.js';

const execFileAsync = promisify(execFile);

function fixture(t: TestContext, mode = 'ok') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codelark-local-fixture-'));
  const executable = path.join(root, 'codex.mjs');
  const log = path.join(root, 'requests.jsonl');
  const stateFile = path.join(root, 'threads.json');
  const env: NodeJS.ProcessEnv = { ...process.env, CODELARK_CODEX_APP_SERVER: '1', CODELARK_CODEX_DESKTOP_REMOTE: '0', CODELARK_CODEX_CLI_PATH: executable };
  const source = `import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
const { WebSocketServer } = createRequire(import.meta.url)(${JSON.stringify(createRequire(import.meta.url).resolve('ws'))});
const args = process.argv.slice(2);
const mode = ${JSON.stringify(mode)};
const record = (data) => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ pid: process.pid, ...data }) + '\\n');
if (args.includes('--help')) {
  record({ help: true });
  if (mode === 'no-app-server') { console.error("error: unrecognized subcommand 'app-server'"); process.exit(2); }
  if (mode === 'broken-help') { console.error('mock authentication failure'); process.exit(1); }
  console.log('Usage: codex app-server [OPTIONS]' + (mode === 'no-listen' ? '' : '\\n  --listen <URL>'));
  process.exit(0);
}
if (mode === 'startup-failure') { console.error('mock invalid configuration'); process.exit(23); }
if (mode === 'delayed-start') await new Promise(r => setTimeout(r, 500));
const endpoint = args[args.indexOf('--listen') + 1];
record({ started: endpoint, args, bridgeKeySelected: process.env.CODEX_API_KEY === 'fixture-bridge-key' && process.env.OPENAI_API_KEY === 'fixture-bridge-key' });
const threads = fs.existsSync(${JSON.stringify(stateFile)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}, 'utf8')) : {};
const server = http.createServer();
const wss = new WebSocketServer({ server });
wss.on('connection', socket => socket.on('message', data => {
  const m = JSON.parse(String(data)); record(m);
  if (m.method === 'fixture/exit') process.exit(7);
  if (m.id === undefined) return;
  const reply = result => socket.send(JSON.stringify({ id: m.id, result }));
  if (mode === 'rpc-error') { socket.send(JSON.stringify({ id: m.id, error: { code: -32000, message: 'fixture permission denied' } })); return; }
  if (m.method === 'initialize') reply({ codexHome: mode === 'wrong-home' ? ${JSON.stringify(path.join(root, 'other-home'))} : process.env.CODEX_HOME });
  else if (m.method === 'thread/loaded/list') reply({ data: Object.keys(threads) });
  else if (m.method === 'config/read') reply({ config: { cli_auth_credentials_store: mode === 'persistent-auth' ? 'file' : 'ephemeral' } });
  else if (m.method === 'account/login/start' && mode === 'login-error') socket.send(JSON.stringify({ id: m.id, error: { code: -32000, message: 'mock login rejected' } }));
  else if (m.method === 'thread/start') {
    const thread = { id: 'thread-' + Object.keys(threads).length, turns: [] };
    threads[thread.id] = thread; fs.writeFileSync(${JSON.stringify(stateFile)}, JSON.stringify(threads)); reply({ thread });
  } else if (['thread/resume', 'thread/read'].includes(m.method)) reply({ thread: threads[m.params.threadId] });
  else reply({ status: 'unsubscribed' });
}));
if (endpoint.startsWith('unix://')) server.listen(endpoint.slice(7));
else { const url = new URL(endpoint); server.listen(Number(url.port), url.hostname); }
process.on('SIGTERM', () => { for (const s of wss.clients) s.terminate(); server.close(() => process.exit(0)); });
`;
  fs.writeFileSync(executable, source);
  const endpoint = codexLocalAppServerEndpoint(root);
  t.after(async () => {
    await closeCodexAppServerSessions();
    if (endpoint.startsWith('unix://')) fs.rmSync(path.dirname(endpoint.slice(7)), { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, executable, env, endpoint, source,
    records: () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((s) => JSON.parse(s)) : [],
    prepare: () => prepareCodexLocalAppServer({ executable, env, codelarkHome: root }) };
}

test('default registry selects one private backend without an endpoint and restores pinned threads after shutdown', async (t) => {
  const f = fixture(t);
  const keys = ['CODELARK_CODEX_CLI_PATH', 'CODELARK_CODEX_APP_SERVER', 'CODELARK_CODEX_DESKTOP_REMOTE', 'CODELARK_CODEX_APP_SERVER_URL'] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, f.env); delete process.env.CODELARK_CODEX_APP_SERVER_URL;
  t.after(() => { for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } });
  const [a, b] = await Promise.all(['default-a', 'default-b'].map((sessionId) => prepareCodexAppServerSession({ sessionId })));
  assert(a && b);
  assert.equal(a.endpoint, codexLocalAppServerEndpoint()); assert.equal(b.endpoint, a.endpoint);
  assert.notEqual(a.threadId, b.threadId);
  assert.equal(f.records().filter((m) => m.started).length, 1);
  const otherClient = await CodexAppServerClient.connect(a.endpoint); otherClient.close();
  await a.lifecycle.refresh(a.threadId);
  assert.equal(f.records().filter((m) => m.started).length, 1);
  const inherited = await prepareCodexAppServerSession({ sessionId: 'default-inherited', endpoint: a.endpoint });
  assert(inherited); assert.notEqual(inherited.threadId, a.threadId);
  await closeCodexAppServerSessions();
  process.env.CODELARK_CODEX_APP_SERVER = '0';
  const restored = await prepareCodexAppServerSession({ sessionId: 'default-a', threadId: a.threadId });
  assert(restored); assert.equal(restored.threadId, a.threadId); assert.equal(restored.endpoint, a.endpoint);
  assert.equal(f.records().filter((m) => m.started).length, 2);
  assert.equal(f.records().filter((m) => m.method === 'thread/start').length, 3);
  const restoredInherited = await prepareCodexAppServerSession({ sessionId: 'default-inherited' });
  assert(restoredInherited); assert.equal(restoredInherited.endpoint, a.endpoint); assert.equal(restoredInherited.threadId, inherited.threadId);
  assert(f.records().some((m) => m.method === 'thread/resume' && m.params.threadId === a.threadId));
  assert.equal(await prepareCodexAppServerSession({ sessionId: 'opt-out-new' }), undefined);
  process.env.CODELARK_CODEX_APP_SERVER = '1';
  assert.equal(await prepareCodexAppServerSession({ sessionId: 'legacy-id', threadId: 'legacy-thread' }), undefined);
  await closeCodexAppServerSessions();
  fs.writeFileSync(f.executable, f.source.replace("const mode = \"ok\"", "const mode = \"no-listen\""));
  await assert.rejects(prepareCodexAppServerSession({ sessionId: 'default-a' }), /未回退/);
  assert.equal(f.records().filter((m) => m.started).length, 2);
  if (a.endpoint.startsWith('unix://')) fs.rmSync(path.dirname(a.endpoint.slice(7)), { recursive: true, force: true });
});

test('concurrent prepares reuse one child; another process reuses the server and cannot close its owner', async (t) => {
  const f = fixture(t);
  assert.deepEqual(await Promise.all([f.prepare(), f.prepare(), f.prepare()]), [f.endpoint, f.endpoint, f.endpoint]);
  const module = new URL('../../../../runtime/codex/app-server-local.ts', import.meta.url).href;
  const script = `import { prepareCodexLocalAppServer, closeCodexLocalAppServers } from ${JSON.stringify(module)};
const endpoint = await prepareCodexLocalAppServer({ executable: 'must-not-execute', env: process.env, codelarkHome: ${JSON.stringify(f.root)} });
await closeCodexLocalAppServers(); console.log(endpoint);`;
  const result = await execFileAsync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { env: f.env });
  assert.equal(result.stdout.trim(), f.endpoint);
  const client = await CodexAppServerClient.connect(f.endpoint); client.close();
  assert.equal(f.records().filter((m) => m.started).length, 1);
  await closeCodexLocalAppServers();
  await assert.rejects(CodexAppServerClient.connect(f.endpoint));
});

for (const mode of ['no-app-server', 'no-listen'] as const) test(`only definite unsupported CLI falls back: ${mode}`, async (t) => {
  const f = fixture(t, mode); assert.equal(await f.prepare(), undefined);
  assert.equal(f.records().some((m) => m.started), false);
});

for (const mode of ['broken-help', 'startup-failure', 'rpc-error', 'wrong-home'] as const) test(`does not disguise ${mode} as unsupported`, async (t) => {
  const f = fixture(t, mode); await assert.rejects(f.prepare());
});

for (const mode of ['persistent-auth', 'login-error'] as const) test(`private key injection fails closed for ${mode}`, async (t) => {
  const f = fixture(t, mode); f.env.CODELARK_CODEX_API_KEY = 'fixture-bridge-key';
  await assert.rejects(f.prepare(), mode === 'persistent-auth' ? /未启用内存认证/ : /mock login rejected/);
  if (mode === 'persistent-auth') assert.equal(f.records().some((m) => m.method === 'account/login/start'), false);
  await assert.rejects(CodexAppServerClient.connect(f.endpoint));
});

test('reusing an existing backend does not replace its authentication', async (t) => {
  const f = fixture(t); await f.prepare();
  f.env.CODELARK_CODEX_API_KEY = 'fixture-new-key';
  assert.equal(await f.prepare(), f.endpoint);
  assert.equal(f.records().some((m) => m.method === 'account/login/start'), false);
});

test('without an explicit key startup preserves Codex provider and authentication selection', async (t) => {
  const f = fixture(t);
  for (const key of ['CODELARK_CODEX_API_KEY', 'CODEX_API_KEY', 'OPENAI_API_KEY']) delete f.env[key];
  await f.prepare();
  const started = f.records().find((m) => m.started);
  assert(!started.args.some((arg: string) => /model_provider|auth|env_key/.test(arg)));
  assert.equal(f.records().some((m) => m.method === 'account/login/start'), false);
});

test('a different CODEX_HOME is rejected while prepare is in flight and after it is ready', async (t) => {
  const f = fixture(t);
  const pending = f.prepare();
  const wrong = () => prepareCodexLocalAppServer({ executable: f.executable, env: { ...f.env, CODEX_HOME: path.join(f.root, 'other') }, codelarkHome: f.root });
  await assert.rejects(wrong(), /CODEX_HOME/); await pending;
  await assert.rejects(wrong(), /CODEX_HOME/);
  assert.equal(f.records().filter((m) => m.started).length, 1);
});

test('shutdown during delayed startup cancels preparation and does not leave a listener', async (t) => {
  const f = fixture(t, 'delayed-start');
  const pending = f.prepare();
  const rejected = assert.rejects(pending, /Bridge 已关闭/);
  while (!f.records().some((m) => m.help)) await new Promise((r) => setTimeout(r, 5));
  await closeCodexLocalAppServers(); await rejected;
  await assert.rejects(CodexAppServerClient.connect(f.endpoint));
});

test('unexpected owned child exit permits same-address reconnect without changing its threads', async (t) => {
  const f = fixture(t); await f.prepare();
  const client = await CodexAppServerClient.connect(f.endpoint);
  const before = await client.request<{ thread: { id: string } }>('thread/start');
  await assert.rejects(client.request('fixture/exit')); client.close();
  assert.equal(await f.prepare(), f.endpoint);
  const resumed = await CodexAppServerClient.connect(f.endpoint);
  try {
    const after = await resumed.request<{ thread: { id: string } }>('thread/resume', { threadId: before.thread.id });
    assert.equal(after.thread.id, before.thread.id);
  } finally { resumed.close(); }
  assert.equal(f.records().filter((m) => m.started).length, 2);
});

test('exited owner does not delete a replaced socket path', { skip: process.platform === 'win32' }, async (t) => {
  const f = fixture(t); await f.prepare();
  const client = await CodexAppServerClient.connect(f.endpoint);
  const socket = f.endpoint.slice(7);
  fs.renameSync(socket, socket + '.original'); fs.writeFileSync(socket, 'replacement');
  const replacement = fs.lstatSync(socket);
  await assert.rejects(client.request('fixture/exit')); client.close();
  await closeCodexLocalAppServers();
  assert.equal(fs.readFileSync(socket, 'utf8'), 'replacement');
  // macOS rejects a regular file during connect with ENOTSOCK; Linux reaches the explicit refusal.
  await assert.rejects(f.prepare(), (error: NodeJS.ErrnoException) => error.code === 'ENOTSOCK' || /未删除或替换/.test(error.message));
  assert.equal(fs.readFileSync(socket, 'utf8'), 'replacement');
  assert.deepEqual([fs.lstatSync(socket).dev, fs.lstatSync(socket).ino], [replacement.dev, replacement.ino]);
  assert.equal(f.records().filter((record) => record.started).length, 1, 'must not start a replacement backend');
});

test('private startup preserves the existing custom base URL and API key precedence', async (t) => {
  const f = fixture(t);
  Object.assign(f.env, { CODELARK_CODEX_BASE_URL: 'http://127.0.0.1:12345/v1',
    CODELARK_CODEX_API_KEY: 'fixture-bridge-key', CODEX_API_KEY: 'fixture-codex-key', OPENAI_API_KEY: 'fixture-openai-key' });
  await f.prepare();
  const started = f.records().find((m) => m.started);
  assert.equal(started.bridgeKeySelected, true);
  assert(started.args.includes('openai_base_url="http://127.0.0.1:12345/v1"'));
  assert(started.args.includes('preferred_auth_method="apikey"'));
  assert(started.args.includes('cli_auth_credentials_store="ephemeral"'));
  assert.equal(f.records().filter((m) => m.method === 'account/login/start' && m.params.apiKey === 'fixture-bridge-key').length, 1);
  assert(!started.args.some((arg: string) => arg.includes('fixture-bridge-key')));
});

test('an occupied Unix socket path is never removed or replaced', { skip: process.platform === 'win32' }, async (t) => {
  const f = fixture(t);
  const socket = f.endpoint.slice(7); fs.mkdirSync(path.dirname(socket), { mode: 0o700 });
  fs.writeFileSync(socket, 'belongs to someone else');
  const occupied = fs.lstatSync(socket);
  await assert.rejects(f.prepare(), (error: NodeJS.ErrnoException) => error.code === 'ENOTSOCK' || /socket.*未删除或替换/.test(error.message));
  assert.equal(fs.readFileSync(socket, 'utf8'), 'belongs to someone else');
  assert.deepEqual([fs.lstatSync(socket).dev, fs.lstatSync(socket).ino], [occupied.dev, occupied.ino]);
  assert.deepEqual(f.records(), []);
});

test('an existing non-Codex listener is not replaced after a failed WebSocket handshake', { skip: process.platform === 'win32' }, async (t) => {
  const f = fixture(t);
  const socket = f.endpoint.slice(7); fs.mkdirSync(path.dirname(socket), { mode: 0o700 });
  const server = http.createServer((_req, res) => res.writeHead(401).end());
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  try {
    await assert.rejects(f.prepare(), /401/);
    assert.deepEqual(f.records(), []);
    assert.equal(server.listening, true);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('environment endpoints override auto startup; pinned endpoints survive opt-out and reject replacement', async (t) => {
  const f = fixture(t);
  await f.prepare();
  const previous = { url: process.env.CODELARK_CODEX_APP_SERVER_URL, flag: process.env.CODELARK_CODEX_APP_SERVER };
  t.after(() => {
    if (previous.url === undefined) delete process.env.CODELARK_CODEX_APP_SERVER_URL; else process.env.CODELARK_CODEX_APP_SERVER_URL = previous.url;
    if (previous.flag === undefined) delete process.env.CODELARK_CODEX_APP_SERVER; else process.env.CODELARK_CODEX_APP_SERVER = previous.flag;
  });
  process.env.CODELARK_CODEX_APP_SERVER_URL = f.endpoint;
  process.env.CODELARK_CODEX_APP_SERVER = '0';
  const first = await prepareCodexAppServerSession({ sessionId: 'environment-endpoint' }); assert(first);
  assert.equal(first.endpoint, f.endpoint);
  await assert.rejects(prepareCodexAppServerSession({ sessionId: 'environment-endpoint', endpoint: 'ws://127.0.0.1:9' }), /绑定另一/);
  assert.equal(f.records().filter((m) => m.started).length, 1);
});

test('stable addresses are short on Unix and deterministic loopback on Windows', () => {
  const home = path.join(os.tmpdir(), ...Array(4).fill('x'.repeat(90)));
  const unix = codexLocalAppServerEndpoint(home, 'darwin');
  assert(Buffer.byteLength(unix.slice(7)) < 104); assert(!/[ %?#]/.test(unix));
  const windows = codexLocalAppServerEndpoint(home, 'win32');
  assert.match(windows, /^ws:\/\/127\.0\.0\.1:[45]\d{4}$/);
  assert.equal(windows, codexLocalAppServerEndpoint(home, 'win32'));
  assert.notEqual(windows, codexLocalAppServerEndpoint(home + '-other', 'win32'));
});

test('endpoint stays stable when a missing home beneath a symlink parent is created', async (t) => {
  const f = fixture(t);
  const real = path.join(f.root, 'real'); const link = path.join(f.root, 'link');
  fs.mkdirSync(real); fs.symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
  const home = path.join(link, 'missing', 'home');
  const before = codexLocalAppServerEndpoint(home);
  fs.mkdirSync(home, { recursive: true });
  assert.equal(codexLocalAppServerEndpoint(home), before);
  assert.equal(codexLocalAppServerEndpoint(path.join(real, 'missing', 'home')), before);
});

test('Windows npm shim resolves its installed native binary without a shell or copied binary', async (t) => {
  const f = fixture(t);
  const entry = path.join(f.root, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  const triple = `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-pc-windows-msvc`;
  const binary = path.join(f.root, 'node_modules', '@openai', 'codex', 'vendor', triple, 'bin', 'codex.exe');
  fs.mkdirSync(path.dirname(entry), { recursive: true }); fs.writeFileSync(entry, 'fixture');
  fs.mkdirSync(path.dirname(binary), { recursive: true }); fs.writeFileSync(binary, 'fixture');
  assert.deepEqual(localAppServerInvocation(path.join(f.root, 'codex.cmd'), 'win32'), { command: binary, args: [] });
  fs.rmSync(binary);
  assert.throws(() => localAppServerInvocation(path.join(f.root, 'codex.cmd'), 'win32'), /缺少原生/);
});
