import assert from 'node:assert/strict';
import childProcess, { execFile, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fixtureEnvironment, fixtureModel, startFixtureModel, textInput, waitFor } from './fixtures/codex-app-server-lifecycle.js';
import { resolveCodexCliExecutable } from '../src/runtime/codex/cli-executable.js';
import type { AppServerThread } from '../src/runtime/codex/app-server-events.js';

const execFileAsync = promisify(execFile);
const args = process.argv.slice(2);
const option = (name: string) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const executable = option('--cli') || resolveCodexCliExecutable({ env: process.env });
const root = path.resolve(option('--evidence') || fs.mkdtempSync(path.join(os.tmpdir(), 'codelark-default-native-')));
fs.mkdirSync(root, { recursive: true });
assert(!fs.existsSync(path.join(root, 'codex')), 'native fixture must use a fresh evidence directory');
const model = await startFixtureModel({ authorization: 'Bearer isolated-fixture-key', rejectWebSockets: true });
const env = fixtureEnvironment(root, model.baseUrl);
// Exercise the production custom-base/key mapping, not only a custom TOML provider.
const configPath = path.join(env.CODEX_HOME!, 'config.toml');
const expectedProvider = args.includes('--custom-provider') ? 'lifecycle_fixture' : 'openai';
if (expectedProvider === 'openai') fs.writeFileSync(configPath,
  fs.readFileSync(configPath, 'utf8').replace('model_provider = "lifecycle_fixture"', 'model_provider = "openai"'));
const authPath = path.join(env.CODEX_HOME!, 'auth.json');
const originalAuth = JSON.stringify({ OPENAI_API_KEY: 'fixture-existing-login-key' });
fs.writeFileSync(authPath, originalAuth, { mode: 0o600 });
const authHash = () => createHash('sha256').update(fs.readFileSync(authPath)).digest('hex');
const originalAuthHash = authHash();
env.CODELARK_CODEX_BASE_URL = model.baseUrl;
env.CODELARK_CODEX_API_KEY = 'isolated-fixture-key';
env.CODEX_API_KEY = 'fixture-lower-codex-key';
env.OPENAI_API_KEY = 'fixture-lower-openai-key';
// Keep only fixture identity and the OS variables required to execute Windows programs.
for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'PATHEXT']) if (process.env[key]) env[key] = process.env[key];
env.USERPROFILE = env.HOME;
env.TEMP = root; env.TMP = root;
env.CODELARK_HOME = path.join(root, 'codelark');
env.CODELARK_CODEX_CLI_PATH = executable;
env.CODELARK_CODEX_APP_SERVER = '1';
env.CODELARK_CODEX_DESKTOP_REMOTE = '0';
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, env);

// Registry paths must be loaded after fixture environment installation.
const { prepareCodexAppServerSession, closeCodexAppServerSessions } = await import('../src/runtime/codex/app-server-registry.js');
const { codexLocalAppServerEndpoint, localAppServerInvocation, prepareCodexLocalAppServer } = await import('../src/runtime/codex/app-server-local.js');
const { CodexAppServerClient, AppServerRpcError } = await import('../src/runtime/codex/app-server-client.js');
const result: Record<string, unknown> = { platform: process.platform, executable, root, success: false };
const endpoint = codexLocalAppServerEndpoint();
// Capture only real children started by this isolated verifier. No PID discovery.
const children: ChildProcess[] = [];
const spawn = childProcess.spawn;
childProcess.spawn = ((...parameters: Parameters<typeof spawn>) => {
  const child = spawn(...parameters);
  if (Array.isArray(parameters[1]) && parameters[1].includes('--listen')) {
    children.push(child);
    child.stderr?.on('data', (data) => fs.appendFileSync(path.join(root, 'backend.log'), data));
  }
  return child;
}) as typeof spawn;
syncBuiltinESMExports();
try {
  const invocation = localAppServerInvocation(executable);
  result.version = (await execFileAsync(invocation.command, [...invocation.args, '--version'], { env, windowsHide: true })).stdout.trim();
  result.invocation = invocation;
  assert.equal(process.env.CODELARK_CODEX_APP_SERVER_URL, undefined);
  assert.equal(process.env.CODEX_APP_SERVER_WS_URL, undefined);
  const first = await prepareCodexAppServerSession({ sessionId: 'default-native', cwd: path.join(root, 'workspace'), model: fixtureModel, approvalPolicy: 'never', sandbox: 'read-only' });
  assert(first, 'new thread must choose app-server without an endpoint or Desktop');
  assert.equal(first.endpoint, endpoint);
  result.endpoint = first.endpoint; result.threadId = first.threadId;
  const configClient = await CodexAppServerClient.connect(endpoint);
  try {
    const { config } = await configClient.request<{ config: { model_provider: string; cli_auth_credentials_store: string } }>('config/read');
    assert.equal(config.model_provider, expectedProvider, 'preserve the configured model provider');
    assert.equal(config.cli_auth_credentials_store, 'ephemeral');
    result.modelProvider = config.model_provider;
  } finally { configClient.close(); }
  const peer = await prepareCodexAppServerSession({ sessionId: 'default-peer', model: fixtureModel });
  assert(peer); assert.equal(peer.endpoint, first.endpoint);
  assert.notEqual(peer.threadId, first.threadId);
  const reply = async (handle: typeof first, marker: string) => {
    model.enqueue({ text: marker });
    const requestCount = model.requests.length;
    const turnId = await handle.lifecycle.submit(handle.threadId, textInput(`fixture input ${requestCount + 1}`));
    await waitFor(() => handle.lifecycle.snapshot(handle.threadId).activity === 'idle', 'native default turn completion');
    const client = await CodexAppServerClient.connect(endpoint);
    try {
      const response = await client.request<{ thread: AppServerThread }>('thread/read', { threadId: handle.threadId, includeTurns: true });
      fs.writeFileSync(path.join(root, `${marker}.json`), JSON.stringify(response, null, 2));
      assert.equal(response.thread.id, handle.threadId);
      const turn = response.thread.turns?.find((candidate) => candidate.id === turnId);
      assert(turn, 'thread/read must include the submitted turn');
      assert.equal(turn.status, 'completed', JSON.stringify(turn.error));
      assert.equal(turn.items?.filter((item) => item.type === 'agentMessage' && item.text === marker).length, 1,
        'exactly one persisted assistant answer for this successful turn');
      assert.equal(model.requests.length, requestCount + 1, 'one actual model request for this turn');
    } finally { client.close(); }
    return turnId;
  };
  result.firstTurn = await reply(first, 'DEFAULT_PRIVATE_NATIVE_REPLY');
  const registryUrl = new URL('../src/runtime/codex/app-server-registry.ts', import.meta.url).href;
  const childSource = `import { prepareCodexAppServerSession, closeCodexAppServerSessions } from ${JSON.stringify(registryUrl)};
try {
  const session = await prepareCodexAppServerSession({ sessionId: 'default-native' });
  if (!session) throw new Error('native reuse fell back');
  console.log(JSON.stringify({ endpoint: session.endpoint, threadId: session.threadId }));
} finally { await closeCodexAppServerSessions(); }`;
  const child = await execFileAsync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', childSource], { env, windowsHide: true, timeout: 60_000 });
  result.reusedProcess = JSON.parse(child.stdout.trim());
  assert.deepEqual(result.reusedProcess, { endpoint, threadId: first.threadId });
  await first.lifecycle.refresh(first.threadId);
  result.peerExitPreservedBackend = true;
  const inherited = await prepareCodexAppServerSession({ sessionId: 'default-inherited', endpoint: first.endpoint,
    cwd: path.join(root, 'workspace'), model: fixtureModel, approvalPolicy: 'never', sandbox: 'read-only' });
  assert(inherited); assert.notEqual(inherited.threadId, first.threadId);
  result.inheritedThreadId = inherited.threadId;
  result.inheritedFirstTurn = await reply(inherited, 'DEFAULT_PRIVATE_INHERITED_REPLY');
  // Pure native RPC control: no registry record and no input for this empty thread.
  const raw = await CodexAppServerClient.connect(endpoint);
  let emptyThread: { id: string };
  try {
    emptyThread = (await raw.request<{ thread: { id: string } }>('thread/start', { model: fixtureModel })).thread;
    result.rawEmptyThreadId = emptyThread.id;
  } finally { raw.close(); }
  await closeCodexAppServerSessions();
  await assert.rejects(CodexAppServerClient.connect(endpoint, 1_000));
  result.ownedBackendStopped = true;
  process.env.CODELARK_CODEX_APP_SERVER = '0';
  const restored = await prepareCodexAppServerSession({ sessionId: 'default-inherited' });
  assert(restored); assert.equal(restored.endpoint, first.endpoint); assert.equal(restored.threadId, inherited.threadId);
  const rawRestored = await CodexAppServerClient.connect(endpoint);
  try {
    await rawRestored.request('thread/resume', { threadId: emptyThread.id });
    result.rawEmptyResume = { supported: true };
  } catch (error) {
    if (!(error instanceof AppServerRpcError) || !error.message.includes('no rollout found')) throw error;
    result.rawEmptyResume = { supported: false, code: error.code, message: error.message };
  } finally { rawRestored.close(); }
  result.restoredTurn = await reply(restored, 'DEFAULT_PRIVATE_RESTORED_REPLY');
  const backend = children.at(-1); assert(backend, 'must hold the actual spawned backend');
  const exited = once(backend, 'exit');
  backend.kill('SIGKILL'); await exited;
  result.unexpectedExit = { pid: backend.pid, signal: backend.signalCode,
    socketRemains: endpoint.startsWith('unix://') && fs.existsSync(endpoint.slice(7)) };
  assert.equal(await prepareCodexLocalAppServer({ executable, env }), endpoint);
  await restored.lifecycle.refresh(restored.threadId);
  result.afterUnexpectedExitTurn = await reply(restored, 'DEFAULT_PRIVATE_AFTER_EXIT_REPLY');
  assert.equal(model.requests.length, 4, 'exactly one model request for each explicit turn');
  assert.deepEqual(model.unexpected, []);
  assert.equal(process.env.CODEX_APP_SERVER_WS_URL, undefined);
  assert.equal(fs.readFileSync(authPath, 'utf8'), originalAuth, 'private key injection must preserve existing login');
  result.success = true;
} catch (error) {
  result.error = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
} finally {
  childProcess.spawn = spawn; syncBuiltinESMExports();
  await closeCodexAppServerSessions();
  result.originalAuthPreserved = fs.readFileSync(authPath, 'utf8') === originalAuth;
  result.authFileSha256 = { before: originalAuthHash, after: authHash() };
  result.closedChildren = children.map((child) => ({ pid: child.pid, exitCode: child.exitCode, signal: child.signalCode }));
  assert(children.every((child) => child.exitCode !== null || child.signalCode !== null), 'all owned native children must have exited');
  await model.close();
  result.modelRequests = model.requests;
  result.unexpectedModelRequests = model.unexpected;
  result.rejectedModelWebSockets = model.rejectedWebSockets;
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(result, null, 2));
  // Production never removes an occupied/stale socket. This directory was created
  // by this isolated test and all its child handles have now been closed.
  if (endpoint.startsWith('unix://')) fs.rmSync(path.dirname(endpoint.slice(7)), { recursive: true, force: true });
  console.log(JSON.stringify({ success: result.success, version: result.version, evidence: path.join(root, 'result.json'), error: result.error }));
}
