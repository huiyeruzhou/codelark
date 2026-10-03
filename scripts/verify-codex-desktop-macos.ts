import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { CodexAppServerClient, appServerWebSocketUrl } from '../src/runtime/codex/app-server-client.js';
import { prepareCodexDesktopRemote, disableCodexDesktopRemote } from '../src/runtime/codex/desktop-remote.js';
import { createTmuxCliCore } from '../src/bridge/tmux/core.js';
import { startCodexResumeTmuxSession } from '../src/bridge/tmux/runtime.js';
import { startLocalResponsesProxy } from '../src/__tests__/helpers/runtime/real-codex-e2e-utils.js';

const execute = promisify(execFile);
const script = fileURLToPath(import.meta.url);
const home = os.homedir();
assert.equal(process.platform, 'darwin', 'This verification requires native macOS.');
assert.equal(process.env.CODELARK_DESKTOP_CI, '1', 'Run only in a disposable CI runner.');

if (process.argv.includes('--prepare')) {
  const remote = await prepareCodexDesktopRemote({ executable: process.env.CODELARK_CODEX_CLI_PATH!, env: process.env });
  assert(remote?.managed);
  process.stdout.write(JSON.stringify(remote));
  process.exit(0);
}

const evidence = path.resolve(process.env.CODELARK_DESKTOP_CI_EVIDENCE!);
fs.mkdirSync(evidence, { recursive: true });
const root = fs.mkdtempSync('/tmp/clk-desktop-');
const serviceRoot = path.join(home, '.codelark/codex-desktop');
assert(!fs.existsSync(serviceRoot), 'Refuse to replace an existing shared backend.');
const label = `gui/${os.userInfo().uid}/dev.codelark.codex-app-server`;
const plist = path.join(home, 'Library/LaunchAgents/dev.codelark.codex-app-server.plist');
const app = path.join(home, 'Applications/Codex.app');
const result: Record<string, unknown> = { nativeMacOS: true, fullDesktopGuiTested: false };
const protocol: unknown[] = [];
const clients: Array<{ close(): void }> = [];
const tmux = createTmuxCliCore({ prefixArgs: ['-S', path.join(root, 'tmux.sock')] });
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check: () => unknown | Promise<unknown>, description: string) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const value = await check();
    if (value) return value;
    await pause(250);
  }
  throw new Error(`Timed out: ${description}`);
}
const run = async (command: string, args: string[]) => (await execute(command, args, {
  env: process.env, timeout: 40_000, maxBuffer: 4 * 1024 * 1024,
})).stdout.trim();

// Keep CI credentials out of the backend snapshot and uploaded artifacts.
const originalPath = process.env.PATH!;
const executable = (await execute('/usr/bin/which', ['codex'])).stdout.trim();
const nodePath = process.execPath;
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, {
  HOME: home, PATH: originalPath, SHELL: '/bin/bash', TERM: 'xterm-256color', LANG: 'en_US.UTF-8',
  CODEX_HOME: path.join(root, 'codex'), OPENAI_API_KEY: 'isolated-ci-mock-key',
  CODELARK_DESKTOP_CI: '1', CODELARK_CODEX_CLI_PATH: executable, GIT_TERMINAL_PROMPT: '0',
  CODELARK_CODEX_RESUME_TMUX_READY_TIMEOUT_MS: '30000',
});
const model = await startLocalResponsesProxy({ responseText: 'DESKTOP_SHARED_RESPONSE' });
fs.mkdirSync(process.env.CODEX_HOME!, { recursive: true });
fs.mkdirSync(path.join(root, 'workspace'));
fs.writeFileSync(path.join(process.env.CODEX_HOME!, 'config.toml'), `
check_for_update_on_startup = false
model_provider = "mock"
model = "gpt-5.6-sol"
[features]
plugins = false
[model_providers.mock]
name = "mock"
base_url = "${model.baseUrl}"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
`);

function desktopTransport() {
  // Extract only the bundled main-process JS, without modifying the official code.
  const asar = fs.readFileSync(path.join(app, 'Contents/Resources/app.asar'));
  const header = JSON.parse(asar.subarray(16, 16 + asar.readUInt32LE(12)).toString());
  const dataOffset = 8 + asar.readUInt32LE(4);
  const destination = path.join(root, 'desktop-js');
  function extract(files: Record<string, any>, prefix = '') {
    for (const [name, entry] of Object.entries(files)) {
      const relative = prefix ? `${prefix}/${name}` : name;
      if (entry.files) extract(entry.files, relative);
      else if (relative.startsWith('.vite/build/') && relative.endsWith('.js') && entry.offset !== undefined) {
        const target = path.join(destination, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, asar.subarray(dataOffset + Number(entry.offset), dataOffset + Number(entry.offset) + entry.size));
      }
    }
  }
  extract(header.files);
  const directory = path.join(destination, '.vite/build');
  const filename = fs.readdirSync(directory).find((name) => /^application-network-startup-.*\.js$/.test(name));
  assert(filename, 'Desktop bundle transport layout changed; review the new release.');
  return createRequire(import.meta.url)(path.join(directory, filename));
}

async function checkLaunchServicesEnvironment(expected: string, iteration: number) {
  const probeApp = path.join(root, `EnvironmentProbe${iteration}.app`);
  const output = path.join(root, `environment-${iteration}.txt`);
  fs.mkdirSync(path.join(probeApp, 'Contents/MacOS'), { recursive: true });
  fs.writeFileSync(path.join(probeApp, 'Contents/Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.codelark.ci.environment${iteration}</string>
<key>CFBundleExecutable</key><string>probe</string><key>CFBundlePackageType</key><string>APPL</string>
<key>LSBackgroundOnly</key><true/></dict></plist>`);
  fs.writeFileSync(path.join(probeApp, 'Contents/MacOS/probe'), `#!/bin/sh\nprintf '%s' "$CODEX_APP_SERVER_WS_URL" > '${output}'\n`, { mode: 0o755 });
  assert.equal(process.env.CODEX_APP_SERVER_WS_URL, undefined, 'open must not inherit the tested variable from this driver.');
  await run('/usr/bin/open', ['-n', '-W', probeApp]);
  await waitFor(() => fs.existsSync(output), 'LaunchServices environment probe');
  assert.equal(fs.readFileSync(output, 'utf8'), expected);
}

try {
  await run('/bin/launchctl', ['print', `gui/${os.userInfo().uid}`]);
  result.desktopVersion = await run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', path.join(app, 'Contents/Info.plist')]);
  result.cliVersion = await run(executable, ['--version']);
  // The provisioning process exits; launchd must continue to own the backend.
  const first = JSON.parse(await run(nodePath, ['--import', 'tsx', script, '--prepare']));
  const client = await CodexAppServerClient.connect(first.endpoint);
  clients.push(client);
  client.onMessage((message) => protocol.push({ source: 'codelark', message }));
  const diagnostics = await client.request<any>('server/diagnostics');
  result.backendPid = diagnostics.process.id;
  const second = JSON.parse(await run(nodePath, ['--import', 'tsx', script, '--prepare']));
  assert.equal(first.endpoint, second.endpoint);
  assert.equal((await client.request<any>('server/diagnostics')).process.id, diagnostics.process.id);
  result.survivesBridgeProcessExit = true;
  result.reusesBackend = true;
  const wsUrl = appServerWebSocketUrl(first.endpoint);
  assert.equal(await run('/bin/launchctl', ['getenv', 'CODEX_APP_SERVER_WS_URL']), wsUrl);
  await checkLaunchServicesEnvironment(wsUrl, 1);
  result.launchServicesEnvironment = true;

  const desktop = desktopTransport();
  const socket = await new desktop.E({ hostConfig: { id: 'local', kind: 'local' }, websocketUrl: wsUrl }).connect();
  clients.push(socket);
  const replies = new Map<number, any>();
  const desktopEvents: any[] = [];
  socket.onmessage = (event: any) => {
    const message = typeof event.data === 'string' ? JSON.parse(event.data) : event.data.message;
    protocol.push({ source: 'desktop', message });
    if (message.id !== undefined && !message.method) replies.set(message.id, message);
    else desktopEvents.push(message);
  };
  await waitFor(() => socket.readyState === 1, 'Desktop transport connection');
  let sequence = 0;
  async function desktopRequest(method: string, params: unknown) {
    const id = ++sequence;
    socket.send(JSON.stringify({ id, method, params }));
    await waitFor(() => replies.has(id), `Desktop ${method}`);
    const reply = replies.get(id);
    assert.equal(reply.error, undefined);
    return reply.result;
  }
  await desktopRequest('initialize', { clientInfo: { name: 'codex_desktop_ci', version: '1' }, capabilities: { experimentalApi: true } });
  socket.send(JSON.stringify({ method: 'initialized' }));
  const started = await client.request<any>('thread/start', {
    cwd: path.join(root, 'workspace'), model: 'gpt-5.6-sol', approvalPolicy: 'never', sandbox: 'danger-full-access',
  });
  const threadId = started.thread.id;
  await client.request('turn/start', { threadId, input: [{ type: 'text', text: 'DESKTOP_CI_SEED' }] });
  await waitFor(async () => (await client.request<any>('thread/read', { threadId, includeTurns: true })).thread.turns.some((turn: any) => turn.status === 'completed'), 'seed turn completed');
  await desktopRequest('thread/resume', { threadId, excludeTurns: true });
  const notices: string[] = [];
  const tui = await startCodexResumeTmuxSession({
    sessionName: 'desktop_ci', bridgeSessionId: 'desktop-ci', threadId, workingDirectory: path.join(root, 'workspace'),
    onStatus: (message) => { notices.push(message); },
    onSelectionPrompt: (prompt) => {
      if (prompt.runtime === 'codex' && prompt.prompt.options.some((option) => /Use existing model/i.test(option.label))) {
        const choice = prompt.prompt.options.find((option) => /Use existing model/i.test(option.label));
        assert(choice, 'Unexpected model migration choices');
        return choice.choice;
      }
      throw new Error(`Unexpected startup selection: ${prompt.kind}`);
    },
  }, tmux);
  assert(tui.ready);
  assert.match(tui.codexCommand, /--remote/);
  assert(notices.some((message) => message.includes('已检测到 Codex Desktop')));
  fs.writeFileSync(path.join(evidence, 'tui-ready.txt'), (await tmux.capturePane('desktop_ci', 80)).screen);
  const completedBefore = desktopEvents.filter((event) => event.method === 'turn/completed').length;
  await tmux.injectPromptIntoPane('desktop_ci', 'DESKTOP_CI_TUI_MESSAGE');
  await waitFor(() => desktopEvents.filter((event) => event.method === 'turn/completed').length > completedBefore, 'Desktop observes TUI completion');
  assert(model.requests.some((request) => request.rawBody.includes('DESKTOP_CI_TUI_MESSAGE')));
  result.realRemoteTuiSharesThread = true;
  result.readyNotice = notices;
  result.protocolLifecycle = desktopEvents.filter((event) => ['thread/status/changed', 'turn/started', 'turn/completed'].includes(event.method));
  await tmux.killSession('desktop_ci');
  client.close();
  socket.close();

  // Re-bootstrap the persisted login job without running any Bridge preparation code.
  await run('/bin/launchctl', ['bootout', label]);
  await run('/bin/launchctl', ['unsetenv', 'CODEX_APP_SERVER_WS_URL']);
  await run('/bin/launchctl', ['bootstrap', `gui/${os.userInfo().uid}`, plist]);
  const restored = await waitFor(async () => {
    try { return await CodexAppServerClient.connect(first.endpoint, 500); } catch { return false; }
  }, 'persisted LaunchAgent restart') as CodexAppServerClient;
  clients.push(restored);
  assert.notEqual((await restored.request<any>('server/diagnostics')).process.id, diagnostics.process.id);
  await checkLaunchServicesEnvironment(wsUrl, 2);
  await restored.request('thread/resume', { threadId, excludeTurns: true });
  result.persistedLaunchAgentRestarts = true;
  result.restoresEnvironmentWithoutBridge = true;
  result.resumesAfterBackendRestart = true;
  fs.copyFileSync(plist, path.join(evidence, 'launchagent.plist'));
  await disableCodexDesktopRemote();
  assert.equal(await run('/bin/launchctl', ['getenv', 'CODEX_APP_SERVER_WS_URL']).catch(() => ''), '');
  assert.equal(await prepareCodexDesktopRemote({ executable, env: process.env }), undefined);
  result.disableRestoresDesktopDefault = true;
  result.success = true;
} catch (error) {
  result.error = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
  try { fs.writeFileSync(path.join(evidence, 'tui-failure.txt'), (await tmux.capturePane('desktop_ci', 80)).screen); } catch { /* no TUI */ }
} finally {
  for (const client of clients) client.close();
  await tmux.killSession('desktop_ci', { ignoreMissing: true }).catch(() => undefined);
  if (fs.existsSync(path.join(serviceRoot, 'installation.json'))) await disableCodexDesktopRemote().catch((error) => { result.cleanupError = String(error); process.exitCode = 1; });
  const log = path.join(serviceRoot, 'app-server.log');
  if (fs.existsSync(log)) fs.copyFileSync(log, path.join(evidence, 'backend.log'));
  await model.close();
  fs.writeFileSync(path.join(evidence, 'protocol.jsonl'), protocol.map((entry) => JSON.stringify(entry)).join('\n'));
  fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}
