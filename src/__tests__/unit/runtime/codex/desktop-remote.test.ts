import '../../../setup/test-setup.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test, describe, type TestContext } from 'node:test';
import { WebSocketServer } from 'ws';

import { prepareCodexDesktopRemote, codexDesktopRemoteNotice, disableCodexDesktopRemote } from '../../../../runtime/codex/desktop-remote.js';
import { appServerWebSocketUrl, appServerCliUrl } from '../../../../runtime/codex/app-server-client.js';

function fixture(t: TestContext) {
  const home = fs.mkdtempSync('/tmp/clk-d-');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const info = path.join(home, 'Applications/Codex.app/Contents/Info.plist');
  fs.mkdirSync(path.dirname(info), { recursive: true });
  fs.writeFileSync(info, 'fixture bundle');
  const calls: [string, string[]][] = [];
  const launchEnv = new Map<string, string>();
  let loaded = false;
  const run = async (file: string, args: string[]) => {
    calls.push([file, args]);
    if (file.endsWith('/mdfind')) return '';
    if (file.endsWith('/plutil')) return args.at(-1) === info ? 'com.openai.codex' : '';
    if (file.endsWith('/launchctl')) {
      if (args[0] === 'getenv') return launchEnv.get(args[1]!) || '';
      if (args[0] === 'setenv') { launchEnv.set(args[1]!, args[2]!); return ''; }
      if (args[0] === 'unsetenv') { launchEnv.delete(args[1]!); return ''; }
      if (args[0] === 'print' && !loaded) throw new Error('service not loaded');
      if (args[0] === 'bootstrap') loaded = true;
      return '';
    }
    return '--remote unix://';
  };
  const probes: string[] = [];
  const env = {
    HOME: home, CODEX_HOME: path.join(home, '.codex'), PATH: '/usr/bin:/bin',
    OPENAI_API_KEY: 'fixture-only-key', CODELARK_CHAT_ID: 'must-not-be-shared', TMUX: 'must-not-be-shared',
  };
  const options = { home, env, platform: 'darwin' as const, executable: "/Applications/My ' Codex/bin/codex", run,
    probe: async (url: string) => { probes.push(url); } };
  return { home, info, calls, launchEnv, probes, options, root: path.join(home, '.codelark/codex-desktop') };
}

describe('macOS Desktop provisioning', { skip: process.platform === 'win32' }, () => {

test('Linux and explicit opt-out do not detect Desktop, probe or install anything', async (t) => {
  const f = fixture(t);
  assert.equal(await prepareCodexDesktopRemote({ ...f.options, platform: 'linux' }), undefined);
  assert.equal(await prepareCodexDesktopRemote({ ...f.options, env: { ...f.options.env, CODELARK_CODEX_DESKTOP_REMOTE: '0' } }), undefined);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.probes, []);
  assert.equal(fs.existsSync(f.root), false);
});

test('a bundle name alone does not count as Codex Desktop', async (t) => {
  const f = fixture(t);
  const original = f.options.run;
  f.options.run = (file, args) => file.endsWith('/plutil') ? Promise.resolve('com.openai.chat') : original(file, args);
  assert.equal(await prepareCodexDesktopRemote(f.options), undefined);
  assert.equal(fs.existsSync(f.root), false);
});

test('installs a persistent private backend, verifies RPC, and preserves the first environment on reuse', async (t) => {
  const f = fixture(t);
  const first = await prepareCodexDesktopRemote(f.options);
  assert(first?.managed);
  assert(first.desktopEnvironmentChanged);
  assert.equal(f.launchEnv.get('CODEX_APP_SERVER_WS_URL'), appServerWebSocketUrl(first.endpoint));
  assert.equal(appServerCliUrl(appServerWebSocketUrl(first.endpoint)), first.endpoint);
  assert.deepEqual(f.probes, [first.endpoint]);
  const snapshot = path.join(f.root, 'environment.sh');
  assert.equal(fs.statSync(f.root).mode & 0o777, 0o700);
  assert.equal(fs.statSync(snapshot).mode & 0o777, 0o600);
  assert(!fs.readFileSync(snapshot, 'utf8').includes('must-not-be-shared'));
  const script = fs.readFileSync(path.join(f.root, 'start.sh'), 'utf8');
  assert(script.includes('launchctl setenv CODEX_APP_SERVER_WS_URL'));
  execFileSync('/bin/sh', ['-n', path.join(f.root, 'start.sh')]);
  const actualKey = execFileSync('/bin/sh', ['-c', '. "$1"; printf %s "$OPENAI_API_KEY"', 'sh', snapshot], { env: {} }).toString();
  assert.equal(actualKey, 'fixture-only-key');
  const before = fs.readFileSync(snapshot, 'utf8');
  const second = await prepareCodexDesktopRemote({ ...f.options, env: { ...f.options.env, OPENAI_API_KEY: 'other-instance-key' } });
  assert.equal(second?.desktopEnvironmentChanged, false);
  assert.equal(fs.readFileSync(snapshot, 'utf8'), before);
  assert.equal(f.calls.filter(([, a]) => a[0] === 'bootstrap').length, 1);
  assert(!f.calls.some(([, a]) => ['bootout', 'kickstart'].includes(a[0]!)));
});

test('simultaneous Bridge startups publish one complete installation', async (t) => {
  const f = fixture(t);
  const [a, b] = await Promise.all([prepareCodexDesktopRemote(f.options), prepareCodexDesktopRemote(f.options)]);
  assert.equal(a?.endpoint, b?.endpoint);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'installation.json'), 'utf8')).codexHome, f.options.env.CODEX_HOME);
});

test('different CODEX_HOME cannot replace the Desktop backend environment', async (t) => {
  const f = fixture(t);
  await prepareCodexDesktopRemote(f.options);
  const before = fs.readFileSync(path.join(f.root, 'environment.sh'), 'utf8');
  await assert.rejects(prepareCodexDesktopRemote({ ...f.options, env: { ...f.options.env, CODEX_HOME: path.join(f.home, 'other') } }), /另一份 CODEX_HOME/);
  assert.equal(fs.readFileSync(path.join(f.root, 'environment.sh'), 'utf8'), before);
});

test('prefers a configured reachable Desktop backend without installing or changing launchd', async (t) => {
  const f = fixture(t);
  f.launchEnv.set('CODEX_APP_SERVER_WS_URL', 'ws://127.0.0.1:9876');
  const remote = await prepareCodexDesktopRemote(f.options);
  assert.equal(remote?.managed, false);
  assert.equal(remote?.endpoint, 'ws://127.0.0.1:9876');
  assert.deepEqual(f.probes, ['ws://127.0.0.1:9876']);
  assert.equal(fs.existsSync(f.root), false);
  assert(!f.calls.some(([, a]) => ['setenv', 'bootstrap', 'bootout'].includes(a[0]!)));
});

test('an unavailable explicit backend fails instead of silently creating another writer', async (t) => {
  const f = fixture(t);
  f.launchEnv.set('CODEX_APP_SERVER_WS_URL', 'ws://127.0.0.1:9876');
  await assert.rejects(prepareCodexDesktopRemote({ ...f.options, probe: async () => { throw new Error('unavailable'); } }), /unavailable/);
  assert.equal(fs.existsSync(f.root), false);
});

test('checks the actual backend home before adopting an existing Desktop endpoint', async (t) => {
  const f = fixture(t);
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  f.launchEnv.set('CODEX_APP_SERVER_WS_URL', `ws://127.0.0.1:${address.port}`);
  server.on('connection', (socket) => socket.on('message', (data) => {
    const message = JSON.parse(String(data));
    if (message.method === 'initialize') socket.send(JSON.stringify({ id: message.id, result: { codexHome: '/another/home' } }));
  }));
  await assert.rejects(prepareCodexDesktopRemote({ ...f.options, probe: undefined }), /CODEX_HOME.*不一致/);
  assert.equal(fs.existsSync(f.root), false);
});

test('does not connect to an external host or override conflicting Desktop configuration', async (t) => {
  const f = fixture(t);
  f.launchEnv.set('CODEX_APP_SERVER_WS_URL', 'wss://example.invalid');
  await assert.rejects(prepareCodexDesktopRemote(f.options), /不是本机地址/);
  f.launchEnv.set('CODEX_APP_SERVER_WS_URL', 'ws://localhost:9876');
  await assert.rejects(prepareCodexDesktopRemote({ ...f.options, env: { ...f.options.env, CODEX_APP_SERVER_WS_URL: 'ws://localhost:9877' } }), /地址不一致/);
  assert.deepEqual(f.probes, []);
});

test('respects Desktop force-CLI and leaves unsupported old CLI on the legacy adapter', async (t) => {
  const f = fixture(t);
  f.launchEnv.set('CODEX_APP_SERVER_FORCE_CLI', '1');
  assert.equal(await prepareCodexDesktopRemote(f.options), undefined);
  f.launchEnv.clear();
  const original = f.options.run;
  f.options.run = (file, args) => file === f.options.executable ? Promise.resolve('old CLI') : original(file, args);
  assert.equal(await prepareCodexDesktopRemote(f.options), undefined);
  assert.equal(fs.existsSync(f.root), false);
});

test('first-start notice accurately asks an already running Desktop to restart once', () => {
  assert.match(codexDesktopRemoteNotice({ endpoint: 'unix:///tmp/c.sock', managed: true, desktopEnvironmentChanged: true }), /--remote.*如果 Desktop 已在运行.*重新打开一次/);
  assert(!codexDesktopRemoteNotice({ endpoint: 'unix:///tmp/c.sock', managed: true, desktopEnvironmentChanged: false }).includes('已自动配置'));
});

test('disable stops only the managed service and prevents the next tmux from reinstalling it', async (t) => {
  const f = fixture(t);
  await prepareCodexDesktopRemote(f.options);
  await disableCodexDesktopRemote(f.options);
  assert(f.calls.some(([, args]) => args[0] === 'bootout' && args[1]?.endsWith('/dev.codelark.codex-app-server')));
  assert.equal(f.launchEnv.has('CODEX_APP_SERVER_WS_URL'), false);
  f.calls.length = 0;
  assert.equal(await prepareCodexDesktopRemote(f.options), undefined);
  assert.deepEqual(f.calls, []);
});

test('disable preserves an independently configured Desktop endpoint', async (t) => {
  const f = fixture(t);
  await prepareCodexDesktopRemote(f.options);
  f.launchEnv.set('CODEX_APP_SERVER_WS_URL', 'ws://localhost:4321');
  await disableCodexDesktopRemote(f.options);
  assert.equal(f.launchEnv.get('CODEX_APP_SERVER_WS_URL'), 'ws://localhost:4321');
});

});
