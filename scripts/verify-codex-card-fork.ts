// 功能：在隔离目录中验证已登记的原生 Codex 会话按卡片边界分叉及续聊。
// 参数：唯一参数为本机 Codex 可执行文件或 codex.js；模型使用本地模拟服务。
// 示例：node --import tsx scripts/verify-codex-card-fork.ts /path/to/codex.js
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const executable = process.argv[2];
assert.ok(executable, 'Usage: verify-codex-card-fork.ts <codex executable>');
fs.mkdirSync('work', { recursive: true });
const root = fs.mkdtempSync(path.resolve('work/paginated-fork-'));
process.env.CODELARK_HOME = path.join(root, 'bridge');
process.env.CODEX_HOME = path.join(root, 'codex');
for (const dir of [process.env.CODELARK_HOME, process.env.CODEX_HOME]) fs.mkdirSync(dir, { recursive: true });
for (const key of ['CODEX_API_KEY', 'OPENAI_API_KEY']) delete process.env[key];
const { localAppServerInvocation, prepareCodexLocalAppServer, closeCodexLocalAppServers } = await import('../src/runtime/codex/app-server-local.js');
const { CodexAppServerClient } = await import('../src/runtime/codex/app-server-client.js');
const { buildCodexTuiEnv } = await import('../src/runtime/codex/tmux-provider.js');
const { getCodexSessionByThreadId } = await import('../src/runtime/codex/session-index.js');
const { forkCodexThreadAtCheckpoint } = await import('../src/runtime/codex/fork-thread.js');
const { startLocalCodexResponsesProxy } = await import('../src/testing/real-feishu/codex-responses-proxy.js');
process.env.CODELARK_CODEX_CLI_PATH = localAppServerInvocation(executable).command;
const proxy = await startLocalCodexResponsesProxy('NATIVE-ACK');
process.env.CODELARK_CODEX_BASE_URL = proxy.baseUrl;
process.env.CODELARK_CODEX_API_KEY = 'isolated-test';
let client: InstanceType<typeof CodexAppServerClient> | undefined;

async function turn(threadId: string, text: string): Promise<void> {
  let unsubscribe = () => {};
  let timer: NodeJS.Timeout;
  const completed = new Promise<void>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Native turn timed out')), 30_000);
    unsubscribe = client!.onMessage((message) => {
      const params = message.params as { threadId?: string; turn?: { status: string; error?: unknown } };
      if (message.method !== 'turn/completed' || params.threadId !== threadId) return;
      if (params.turn?.status === 'completed') resolve();
      else reject(new Error(JSON.stringify(params.turn)));
    });
  });
  try {
    await Promise.all([completed, client!.request('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }] })]);
  } finally { clearTimeout(timer!); unsubscribe(); }
}

try {
  const endpoint = await prepareCodexLocalAppServer({ executable: process.env.CODELARK_CODEX_CLI_PATH, env: buildCodexTuiEnv() });
  assert.ok(endpoint);
  client = await CodexAppServerClient.connect(endpoint);
  const created = await client.request<{ thread: { id: string } }>('thread/start', {
    cwd: process.cwd(), persistExtendedHistory: true, approvalPolicy: 'never', model: 'gpt-5',
  });
  const sourceId = created.thread.id;
  await turn(sourceId, 'FORK-KEEP-A-7319');
  let source = getCodexSessionByThreadId(sourceId);
  for (let i = 0; !source && i < 100; i++) { await delay(50); source = getCodexSessionByThreadId(sourceId); }
  assert.ok(source);
  const prefix = fs.readFileSync(source.filePath, 'utf8').trimEnd().split('\n');
  const checkpoint = prefix.findLast((line) => {
    const r = JSON.parse(line);
    return r.type === 'event_msg' && r.payload?.type === 'task_complete';
  });
  assert.ok(checkpoint, 'Native completed turn checkpoint must be persisted');
  await turn(sourceId, 'FORK-EXCLUDE-B-8420');
  const before = fs.readFileSync(source.filePath, 'utf8');
  assert.match(before, /FORK-EXCLUDE-B-8420/);
  console.log(JSON.stringify({ phase: 'source-registered', root, sourceId }));
  const fork = await forkCodexThreadAtCheckpoint({ threadId: sourceId,
    signature: crypto.createHash('sha1').update(checkpoint.trim()).digest('hex'), workingDirectory: process.cwd() });
  assert.notEqual(fork.threadId, sourceId);
  assert.equal(fs.readFileSync(source.filePath, 'utf8'), before);
  const loaded = await client.request<{ data: string[] }>('thread/loaded/list');
  assert.ok(!loaded.data.includes(fork.threadId), 'Fork must release its writer before a separate TUI resumes');
  assert.ok(loaded.data.includes(sourceId), 'Releasing the fork must not unload the source');
  await client.request('thread/resume', { threadId: fork.threadId });
  const forkFile = getCodexSessionByThreadId(fork.threadId);
  assert.ok(forkFile);
  const forkHistory = fs.readFileSync(forkFile.filePath, 'utf8');
  assert.match(forkHistory, /FORK-KEEP-A-7319/);
  assert.match(forkHistory, /NATIVE-ACK/);
  assert.doesNotMatch(forkHistory, /FORK-EXCLUDE-B-8420/);
  const start = proxy.requests.length;
  await turn(fork.threadId, 'FORK-CONTINUE-C-9531');
  const request = proxy.requests.slice(start).find((r) => r.rawBody.includes('FORK-CONTINUE-C-9531'));
  assert.ok(request);
  assert.match(request.rawBody, /FORK-KEEP-A-7319/);
  assert.match(request.rawBody, /NATIVE-ACK/);
  assert.doesNotMatch(request.rawBody, /FORK-EXCLUDE-B-8420/);
  assert.equal(fs.readFileSync(source.filePath, 'utf8'), before);
  await turn(sourceId, 'ORIGINAL-CONTINUES-D-0642');
  await client.request('thread/unsubscribe', { threadId: fork.threadId });
  await client.request('thread/unsubscribe', { threadId: sourceId });
  console.log(JSON.stringify({ ok: true, root, sourceId, forkId: fork.threadId,
    verified: 'registered source fork, exact prefix continuation, unchanged source then original continues' }));
} finally {
  client?.close();
  await closeCodexLocalAppServers();
  await proxy.close();
}
