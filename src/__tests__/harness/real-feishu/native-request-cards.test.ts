import '../../setup/test-setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertCardContains, assertFormResult, assertPermissionResult, mcpTool, newAnswerFeedback } from '../../../testing/real-feishu/native-request-cards.js';

test('原生 MCP 同时识别发现输出中的 namespace 与旧平面工具名', () => {
  assert.deepEqual(mcpTool({ input: [{ type: 'tool_search_output', tools: [{ type: 'namespace', name: 'mcp__codelark_cards', tools: [{ name: 'form' }] }] }] }, 'form'),
    { tool: 'form', namespace: 'mcp__codelark_cards', arguments: {} });
  assert.deepEqual(mcpTool({ tools: [{ name: 'mcp__codelark_cards__url' }] }, 'url'), { tool: 'mcp__codelark_cards__url', arguments: {} });
  assert.throws(() => mcpTool({ tools: [{ name: 'mcp__another__form' }] }, 'form'));
  assert.throws(() => mcpTool({ input: [{ type: 'tool_search_output', tools: [{ type: 'namespace', name: 'mcp__codelark_cards', tools: [{ name: 'url' }] }] }] }, 'form'));
});

test('真实卡片内容校验保留多行 diff 的围栏、引号与中文，拒绝截断', () => {
  const lines = ['中文 <tag> & markdown', '```typescript', 'const boundary = "three lines";', '```'];
  assertCardContains({ content: lines.join('\n') }, lines);
  assertCardContains({ body: { content: { elements: lines.map((text) => ({ text })) } } }, lines);
  assert.throws(() => assertCardContains({ content: lines.slice(0, 2).join('\n') }, lines));
  assert.throws(() => assertCardContains({ content: '只显示文件名' }, lines));
});
test('问答校验提示允许群内普通消息，只接受本次新增的机器人提示', () => {
  const message = { message_id: 'new', sender: { id: 'app', sender_type: 'app' }, content: '回答不符合此项要求' };
  const payload = { ok: true, identity: 'user', data: { messages: [message] } };
  assert.equal(newAnswerFeedback(payload, new Set(['old']), 'app', '回答不符合'), message);
  assert.equal(newAnswerFeedback(payload, new Set(['new']), 'app', '回答不符合'), undefined);
  assert.equal(newAnswerFeedback(payload, new Set(), 'another', '回答不符合'), undefined);
});

test('原生工具结果拒绝布尔字符串、越界回答及扩大权限范围', () => {
  const form = (content: unknown) => ({ output: [{ type: 'input_text', text: JSON.stringify({ action: 'accept', content }) }] });
  assertFormResult(form({ count: 3, enabled: false }));
  assert.throws(() => assertFormResult(form({ count: 3, enabled: 'false' })));
  assert.throws(() => assertFormResult(form({ count: 0, enabled: false })));
  const permission = (scope: string, write: string[]) => ({ output: JSON.stringify({ scope, permissions: { network: null, file_system: { write } } }) });
  assertPermissionResult(permission('turn', ['/owned']), '/owned');
  assert.throws(() => assertPermissionResult(permission('session', ['/owned']), '/owned'));
  assert.throws(() => assertPermissionResult(permission('turn', ['/owned', '/other']), '/owned'));
});

test('本地 MCP fixture 发布表单和 URL 原生请求并回传对应工具结果', () => {
  const requests = [
    { id: 1, method: 'initialize' }, { id: 2, method: 'tools/list' },
    { id: 3, method: 'tools/call', params: { name: 'form' } },
    { id: 'elicitation-1', result: { action: 'accept', content: { count: 3, enabled: false } } },
    { id: 4, method: 'tools/call', params: { name: 'url' } },
    { id: 'elicitation-2', result: { action: 'cancel' } },
  ];
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('../../../testing/real-feishu/native-card-mcp.mjs', import.meta.url)), 'unit'], {
    input: requests.map((r) => JSON.stringify({ jsonrpc: '2.0', ...r })).join('\n') + '\n', encoding: 'utf8', timeout: 5_000,
  });
  assert.equal(child.status, 0, child.stderr);
  const messages = child.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(messages.find((m) => m.id === 2).result.tools.map((t: any) => t.name), ['form', 'url']);
  const form = messages.find((m) => m.id === 'elicitation-1').params;
  assert.equal(form.mode, 'form'); assert.deepEqual(form.requestedSchema.required, ['count', 'enabled']);
  assertFormResult(messages.find((m) => m.id === 3).result);
  const url = messages.find((m) => m.id === 'elicitation-2').params;
  assert.equal(url.mode, 'url'); assert.equal(url.elicitationId, 'elicitation-2');
  assert.equal(new URL(url.url).origin, 'http://127.0.0.1:9');
  assert.equal(JSON.parse(messages.find((m) => m.id === 4).result.content[0].text).action, 'cancel');
});
