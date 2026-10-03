import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { CodexAppServerClient, appServerWebSocketUrl, type AppServerMessage } from '../src/runtime/codex/app-server-client.js';
import { prepareCodexDesktopRemote, disableCodexDesktopRemote } from '../src/runtime/codex/desktop-remote.js';
import { CodexAppServerLifecycle } from '../src/runtime/codex/app-server-lifecycle.js';
import { fixtureEnvironment, fixtureModel, startFixtureModel, textInput } from './fixtures/codex-app-server-lifecycle.js';

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
const root = fs.realpathSync(fs.mkdtempSync('/tmp/clk-desktop-'));
const serviceRoot = path.join(home, '.codelark/codex-desktop');
assert(!fs.existsSync(serviceRoot), 'Refuse to replace an existing shared backend.');
const label = `gui/${os.userInfo().uid}/dev.codelark.codex-app-server`;
const plist = path.join(home, 'Library/LaunchAgents/dev.codelark.codex-app-server.plist');
const app = path.join(home, 'Applications/Codex.app');
const result: Record<string, unknown> = { nativeMacOS: true, fullDesktopGuiTested: false, tuiRequiredForSubmission: false };
const protocol: unknown[] = [];
const clients: Array<{ close(): void }> = [];
const deadline = AbortSignal.timeout(180_000);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check: () => unknown | Promise<unknown>, description: string) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    deadline.throwIfAborted();
    const value = await check();
    if (value) return value;
    await pause(250);
  }
  throw new Error(`Timed out: ${description}`);
}
const run = async (command: string, args: string[]) => (await execute(command, args, {
  env: process.env, timeout: 40_000, signal: deadline, maxBuffer: 4 * 1024 * 1024,
})).stdout.trim();

// Keep CI credentials out of the backend snapshot and uploaded artifacts.
const originalPath = process.env.PATH!;
const executable = process.env.CODELARK_CODEX_CLI_PATH || (await execute('/usr/bin/which', ['codex'])).stdout.trim();
const nodePath = process.execPath;
for (const key of Object.keys(process.env)) delete process.env[key];
const model = await startFixtureModel();
Object.assign(process.env, fixtureEnvironment(root, model.baseUrl), {
  HOME: home, PATH: originalPath, SHELL: '/bin/bash', TERM: 'xterm-256color', LANG: 'en_US.UTF-8',
  CODELARK_DESKTOP_CI: '1', CODELARK_CODEX_CLI_PATH: executable, GIT_TERMINAL_PROMPT: '0',
});
async function backendPid(): Promise<number> {
  const description = await run('/bin/launchctl', ['print', label]);
  const pid = description.match(/\bpid = (\d+)/)?.[1];
  assert(pid, '隔离 LaunchAgent 未报告 backend PID');
  return Number(pid);
}

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
  const bridgeEvents: AppServerMessage[] = [];
  client.onMessage((message) => {
    bridgeEvents.push(message);
    protocol.push({ source: 'codelark', message });
  });
  const originalBackendPid = await backendPid();
  result.backendPid = originalBackendPid;
  assert.equal(client.serverInfo.codexHome, process.env.CODEX_HOME);
  const second = JSON.parse(await run(nodePath, ['--import', 'tsx', script, '--prepare']));
  assert.equal(first.endpoint, second.endpoint);
  assert.equal(await backendPid(), originalBackendPid);
  await client.request('thread/loaded/list');
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
  // 协议拥有执行权，Desktop/TUI 的 UI ready 不是提交前置条件。
  const lifecycle = new CodexAppServerLifecycle(first.endpoint);
  clients.push(lifecycle);
  const threadId = await lifecycle.ensureThread({
    cwd: path.join(root, 'workspace'), model: fixtureModel, approvalPolicy: 'never', sandbox: 'read-only',
  });
  model.enqueue({ text: 'DESKTOP_SHARED_SEED_RESPONSE' });
  const seedTurn = await lifecycle.submit(threadId, textInput('DESKTOP_CI_SEED'));
  await waitFor(() => lifecycle.recordsAfter(threadId).records.some((record) =>
    record.turnId === seedTurn && record.type === 'task_complete' && !record.isError,
  ), '协议 seed turn 完成');
  const resumed = await desktopRequest('thread/resume', { threadId });
  assert.equal(resumed.thread.id, threadId);
  assert(JSON.stringify(resumed.thread.turns).includes('DESKTOP_SHARED_SEED_RESPONSE'));
  model.enqueue({ text: 'BRIDGE_PROTOCOL_RESPONSE' });
  const bridgeTurn = await lifecycle.submit(threadId, textInput('BRIDGE_PROTOCOL_WITHOUT_TUI'));
  const bridgeCompleted = await waitFor(() => desktopEvents.find((event) => event.method === 'turn/completed'
    && event.params.threadId === threadId && event.params.turn.id === bridgeTurn), 'Desktop 观察同线程 Bridge 完成') as any;
  assert.equal(bridgeCompleted.params.turn.status, 'completed');
  model.enqueue({ text: 'DESKTOP_PROTOCOL_RESPONSE' });
  const desktopTurn = await desktopRequest('turn/start', { threadId, input: textInput('DESKTOP_PROTOCOL_INPUT') });
  await waitFor(() => lifecycle.recordsAfter(threadId).records.some((record) =>
    record.turnId === desktopTurn.turn.id && record.type === 'task_complete' && !record.isError,
  ), 'Bridge 观察同线程 Desktop 完成');
  assert(model.requests.some((request) => JSON.stringify(request.body.input).includes('BRIDGE_PROTOCOL_WITHOUT_TUI')));
  assert(model.requests.some((request) => JSON.stringify(request.body.input).includes('DESKTOP_PROTOCOL_INPUT')));
  result.threadId = threadId;
  result.protocolSubmissionWithoutTui = true;
  result.officialDesktopTransportSharesThread = true;
  result.protocolLifecycle = desktopEvents.filter((event) => ['thread/status/changed', 'turn/started', 'turn/completed'].includes(event.method));
  lifecycle.close();
  client.close();
  socket.close();
  const afterDetach = await CodexAppServerClient.connect(first.endpoint);
  clients.push(afterDetach);
  assert.equal(await backendPid(), originalBackendPid);
  assert.equal((await afterDetach.request<any>('thread/read', { threadId })).thread.id, threadId);
  result.backendSurvivesClientExit = true;
  afterDetach.close();

  // Re-bootstrap the persisted login job without running any Bridge preparation code.
  await run('/bin/launchctl', ['bootout', label]);
  // bootout acknowledges removal before the job and its process finish exiting.
  await waitFor(async () => {
    const registered = await run('/bin/launchctl', ['print', label]).then(() => true, () => false);
    if (registered) return false;
    try { process.kill(originalBackendPid, 0); return false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; return true; }
  }, 'previous LaunchAgent and owned backend process exit');
  await run('/bin/launchctl', ['unsetenv', 'CODEX_APP_SERVER_WS_URL']);
  await run('/bin/launchctl', ['bootstrap', `gui/${os.userInfo().uid}`, plist]);
  const restored = await waitFor(async () => {
    try { return await CodexAppServerClient.connect(first.endpoint, 500); } catch { return false; }
  }, 'persisted LaunchAgent restart') as CodexAppServerClient;
  clients.push(restored);
  assert.notEqual(await backendPid(), originalBackendPid);
  await checkLaunchServicesEnvironment(wsUrl, 2);
  assert.equal((await restored.request<any>('thread/resume', { threadId })).thread.id, threadId);
  result.persistedLaunchAgentRestarts = true;
  result.restoresEnvironmentWithoutBridge = true;
  result.resumesAfterBackendRestart = true;
  fs.copyFileSync(plist, path.join(evidence, 'launchagent.plist'));
  await disableCodexDesktopRemote();
  assert.equal(await run('/bin/launchctl', ['getenv', 'CODEX_APP_SERVER_WS_URL']).catch(() => ''), '');
  assert.equal(await prepareCodexDesktopRemote({ executable, env: process.env }), undefined);
  result.disableRestoresDesktopDefault = true;
  assert.deepEqual(model.unexpected, []);
  result.success = true;
} catch (error) {
  result.error = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
} finally {
  for (const client of clients) client.close();
  if (fs.existsSync(path.join(serviceRoot, 'installation.json'))) await disableCodexDesktopRemote().catch((error) => { result.cleanupError = String(error); process.exitCode = 1; });
  const log = path.join(serviceRoot, 'app-server.log');
  if (fs.existsSync(log)) fs.copyFileSync(log, path.join(evidence, 'backend.log'));
  await model.close();
  fs.writeFileSync(path.join(evidence, 'model-requests.json'), JSON.stringify(model.requests, null, 2));
  fs.writeFileSync(path.join(evidence, 'protocol.jsonl'), protocol.map((entry) => JSON.stringify(entry)).join('\n'));
  fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}
