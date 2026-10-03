import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { CodexAppServerClient } from '../../src/runtime/codex/app-server-client.js';

// 三个 CLI 均内置此模型的普通 Responses 工具格式；请求只到本地 fixture。
export const fixtureModel = 'gpt-5.4';
export const textInput = (text: string) => [{ type: 'text' as const, text, text_elements: [] }];

export async function waitFor<T>(read: () => T | undefined | false | Promise<T | undefined | false>, label: string, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await read();
    if (result !== undefined && result !== false) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`等待超时：${label}`);
}

type ModelBody = { model?: string; input?: unknown[]; tools?: Array<Record<string, any>>; [key: string]: unknown };
export type MockOutput = { text: string } | { search: string } | { tool: string; arguments: Record<string, unknown> | string; callId?: string; namespace?: string };
interface Step {
  output: MockOutput | ((body: ModelBody) => MockOutput);
  gate: Promise<void>;
  release(): void;
}

/** 只返回预先编排的 SSE；不转发任何请求，也不读取模型凭证。 */
export async function startFixtureModel() {
  const requests: Array<{ method: string; url: string; body: ModelBody }> = [];
  const unexpected: string[] = [];
  const steps: Step[] = [];
  const allSteps: Step[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      if (req.method !== 'POST' || req.url?.split('?')[0] !== '/v1/responses') {
        unexpected.push(`${req.method} ${req.url}`);
        res.writeHead(404).end(); return;
      }
      let body: ModelBody;
      try { body = JSON.parse(raw); } catch { res.writeHead(400).end(); return; }
      requests.push({ method: req.method, url: req.url!, body });
      const step = steps.shift();
      if (!step) {
        unexpected.push('没有编排的模型调用');
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'UNSCRIPTED_MODEL_REQUEST' } })); return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const responseId = `resp_${randomUUID()}`;
      const emit = (type: string, value: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
      emit('response.created', { response: { id: responseId, object: 'response', status: 'in_progress', output: [] } });
      void step.gate.then(() => {
        if (res.destroyed) return;
        const output = typeof step.output === 'function' ? step.output(body) : step.output;
        const itemId = `item_${randomUUID()}`;
        const item = 'text' in output
          ? { id: itemId, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: output.text }] }
          : 'search' in output ? { id: itemId, type: 'tool_search_call', call_id: `search_${randomUUID()}`, execution: 'client', arguments: { query: output.search } }
          : typeof output.arguments === 'string'
            ? { id: itemId, type: 'custom_tool_call', name: output.tool, call_id: output.callId || `call_${randomUUID()}`, input: output.arguments, status: 'completed' }
            : { id: itemId, type: 'function_call', name: output.tool, ...(output.namespace ? { namespace: output.namespace } : {}), call_id: output.callId || `call_${randomUUID()}`, arguments: JSON.stringify(output.arguments), status: 'completed' };
        emit('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress' } });
        if ('text' in output) emit('response.output_text.delta', { item_id: itemId, output_index: 0, content_index: 0, delta: output.text });
        emit('response.output_item.done', { output_index: 0, item });
        emit('response.completed', { response: {
          id: responseId, object: 'response', status: 'completed', model: body.model || fixtureModel,
          output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        } });
        res.end();
      }).catch((error) => { unexpected.push(String(error)); res.destroy(error); });
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`, requests, unexpected,
    enqueue(output: Step['output'], hold = false) {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const step: Step = { output, gate, release };
      steps.push(step); allSteps.push(step);
      if (!hold) release();
      return step;
    },
    async close() {
      for (const step of allSteps) step.release();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

export function fixtureEnvironment(root: string, baseUrl: string): NodeJS.ProcessEnv {
  const codexHome = path.join(root, 'codex');
  const userHome = path.join(root, 'home');
  const workspace = path.join(root, 'workspace');
  for (const directory of [codexHome, userHome, workspace]) fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'config.toml'), `
check_for_update_on_startup = false
model_provider = "lifecycle_fixture"
model = "${fixtureModel}"
approval_policy = "never"
sandbox_mode = "read-only"
[analytics]
enabled = false
[features]
plugins = false
[model_providers.lifecycle_fixture]
name = "隔离验收模型"
base_url = "${baseUrl}"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
`);
  // 不继承代理、真实认证、MCP、IM 或运行中 Bridge 的环境。
  return {
    HOME: userHome, CODEX_HOME: codexHome, PATH: process.env.PATH, SHELL: '/bin/bash',
    TMPDIR: root, LANG: 'en_US.UTF-8', TERM: 'xterm-256color', RUST_LOG: 'info',
    OPENAI_API_KEY: 'isolated-fixture-key', GIT_TERMINAL_PROMPT: '0',
  };
}

export async function startFixtureAppServer(executable: string, root: string, env: NodeJS.ProcessEnv) {
  // 短路径避免 macOS sockaddr_un 长度限制；这是本 fixture 独占的 socket。
  const endpoint = `unix://${path.join(root, 'rpc.sock')}`;
  const log = fs.openSync(path.join(root, 'backend.log'), 'w');
  const child = spawn(executable, ['app-server', '--listen', endpoint], {
    env, cwd: path.join(root, 'workspace'), stdio: ['ignore', log, log],
  });
  fs.closeSync(log);
  let spawnError: Error | undefined;
  child.once('error', (error) => { spawnError = error; });
  let lastConnectionError: unknown;
  try {
    await waitFor(async () => {
      if (spawnError) throw spawnError;
      assert.equal(child.exitCode, null, `app-server 提前退出，检查 ${root}/backend.log`);
      try { const client = await CodexAppServerClient.connect(endpoint, 1_000); client.close(); return true; }
      catch (error) { lastConnectionError = error; return false; }
    }, '真实 app-server Unix socket');
  } catch (error) { await stopFixtureChild(child); throw new Error(`${String(error)}; 最后连接错误：${String(lastConnectionError)}`); }
  return { endpoint, child, close: () => stopFixtureChild(child) };
}

async function stopFixtureChild(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  // 只停止本 fixture 持有的子进程，不查找或终止任何既有服务。
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 3_000);
  try { await exited; } finally { clearTimeout(timer); }
}
