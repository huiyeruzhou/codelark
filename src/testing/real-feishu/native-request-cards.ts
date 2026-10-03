import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { AppServerMessage } from '../../runtime/codex/app-server-client.js';
import { feishuChatUrl, userReadbackMessages, type LifecycleDriver, type LifecycleReport, type ModelBody, type ModelOutput, type NativeThread, type NativeTurn } from './app-server-lifecycle.js';

export interface NativeCardReport {
  kind: 'mcp-form' | 'file' | 'permissions' | 'mcp-url';
  status: 'waiting' | 'unverified' | 'passed';
  chatUrl: string;
  button?: string;
  deadline?: string;
  request: AppServerMessage;
  card: Record<string, any>;
  callback?: unknown;
  detail: string;
}
interface Context {
  driver: LifecycleDriver;
  report: LifecycleReport;
  chatId: string;
  threadId: string;
  wait<T>(label: string, read: () => T | undefined | false | Promise<T | undefined | false>, timeout?: number): Promise<T>;
  read(chat: string): Promise<unknown>;
  send(chat: string, text: string): Promise<string>;
  thread(id: string): Promise<NativeThread>;
  terminal(id: string, turnId: string, status?: string): Promise<NativeTurn>;
  visible(chat: string, marker: string): Promise<unknown>;
  stage(name: string): void;
  check(name: string, detail?: unknown): void;
  save(): void;
}

export function mcpTool(body: ModelBody, name: string): Extract<ModelOutput, { tool: string }> {
  // 新 CLI 的发现结果在 input.tool_search_output.tools，不能只查 body.tools。
  const tools = [...(body.tools || []), ...(body.input || []).flatMap((item: any) => item.type === 'tool_search_output' ? item.tools || [] : [])];
  const namespace = tools.find((tool) => tool.type === 'namespace' && tool.name.includes('codelark_cards'));
  const tool = namespace?.tools?.find((tool: any) => tool.name === name)
    || tools.find((tool) => tool.name?.includes('codelark_cards') && tool.name.endsWith(`_${name}`));
  assert(tool, `原生 MCP 未发现 ${name}`);
  return { tool: tool.name, ...(namespace ? { namespace: namespace.name } : {}), arguments: {} };
}
export function assertCardContains(card: Record<string, any>, parts: string[]): void {
  const text = (value: unknown): string => typeof value === 'string' ? value
    : value && typeof value === 'object' ? Object.values(value).map(text).join('\n') : '';
  const content = text(card.content ?? card.body?.content);
  for (const part of parts) assert(content.includes(part), `真实用户回读卡片缺少 ${part}`);
}
export function newAnswerFeedback(payload: unknown, beforeIds: Set<unknown>, appId: string, text: string): Record<string, any> | undefined {
  return userReadbackMessages(payload).find((m) => m.sender?.id === appId && m.sender.sender_type === 'app'
    && !beforeIds.has(m.message_id) && String(m.content).includes(text));
}

/** CLI 把 MCP 输出放在 input_text 数组，权限工具则直接返回 JSON 字符串。 */
export function decodedToolResults(value: unknown): Array<Record<string, any>> {
  if (typeof value === 'string') {
    try { return decodedToolResults(JSON.parse(value)); } catch { return []; }
  }
  if (!value || typeof value !== 'object') return [];
  return [...(Array.isArray(value) ? [] : [value as Record<string, any>]), ...Object.values(value).flatMap(decodedToolResults)];
}

export function assertFormResult(output: unknown): void {
  const result = decodedToolResults(output).find((v) => v.action === 'accept');
  assert(result, '原生 MCP 缺少接受表单结果');
  assert.deepEqual(result.content, { count: 3, enabled: false }, '必须保留数字/布尔类型，不得带入越界回答');
}

export function assertPermissionResult(output: unknown, permissionPath: string): void {
  const result = decodedToolResults(output).find((v) => v.scope !== undefined);
  assert(result, '必须有权限工具原生结果');
  assert.equal(result.scope, 'turn', '不得授予 session 范围');
  assert.deepEqual(result.permissions, { network: null, file_system: { write: [permissionPath] } }, '不得扩大已请求的单一写入范围');
}

/** 后端只做观察；文件/权限/URL 按钮必须来自真实客户端，文字问答走真实用户消息。 */
export async function runNativeRequestCards(c: Context): Promise<void> {
  const { driver: d, report, chatId, threadId } = c;
  const mark = (name: string) => `LIFECYCLE_${name}_${d.runId}`;
  const start = async (kind: NativeCardReport['kind'], method: string, parts: string[], enqueue: () => void) => {
    c.stage(`原生卡片 ${kind}`);
    const offset = report.protocol.length;
    enqueue();
    await c.send(chatId, mark(`${kind}_INPUT`));
    const request = await c.wait(`原生 ${kind} 请求`, () => report.protocol.slice(offset).find((m) => m.method === method));
    const turn = await c.wait('请求所属活动轮次', async () => (await c.thread(threadId)).turns.find((t) => t.status === 'inProgress'));
    const card = await c.wait(`真实用户可见 ${kind} 卡片`, async () => userReadbackMessages(await c.read(chatId)).find((m) => {
      if (m.sender?.id !== d.botAppId) return false;
      try { assertCardContains(m, parts); return true; } catch { return false; }
    }));
    const evidence: NativeCardReport = { kind, status: 'unverified', chatUrl: feishuChatUrl(chatId), request, card,
      detail: '原生请求与用户回读卡片已确认；尚未验证真实客户端按钮。' };
    report.nativeCards!.push(evidence);
    c.check(`native_${kind}_card_user_readback`, { messageId: card.message_id, turnId: turn.id });
    return { evidence, turn };
  };
  const enqueueMcp = (name: string) => {
    d.model.enqueue({ search: `codelark_cards ${name}` });
    d.model.enqueue((body) => ({ ...mcpTool(body, name), callId: `cards_${name}_${d.runId}` }));
  };
  const toolOutputs = () => d.model.requests.flatMap((r) => (r.body.input || []).filter((i: any) =>
    i.type === 'function_call_output' || i.type === 'custom_tool_call_output')) as Array<Record<string, any>>;
  const cancel = async (turnId: string) => {
    await c.send(chatId, '/stop'); await c.terminal(threadId, turnId, 'interrupted');
  };
  const manual = async (entry: Awaited<ReturnType<typeof start>>, button: string, decision: 'accept' | 'cancel', verify: () => void) => {
    const { evidence, turn } = entry;
    evidence.button = button;
    if (!d.approvalWaitMs) {
      await cancel(turn.id);
      evidence.detail = '真实用户已回读卡片；自动运行通过真实 /stop 取消，按钮未验收。'; c.save(); return true;
    }
    evidence.status = 'waiting';
    evidence.deadline = new Date(Date.now() + d.approvalWaitMs).toISOString();
    evidence.detail = `请从真实客户端点击“${button}”；URL 步骤无需打开链接。Bridge 保留至截止时间。`;
    d.progress(`${evidence.detail} ${evidence.chatUrl}`); c.save();
    d.model.enqueue({ text: mark(`${evidence.kind}_RESULT`) });
    try {
      evidence.callback = await c.wait(`真实 ${button} callback`, () => d.callbackEvidence(chatId, String(evidence.card.message_id), decision), d.approvalWaitMs);
      await c.terminal(threadId, turn.id);
      verify();
      await c.visible(chatId, mark(`${evidence.kind}_RESULT`));
      evidence.status = 'passed'; evidence.detail = '真实 callback、原生结果、完成终态与用户最终回读均通过。';
      c.check(`native_${evidence.kind}_real_client_terminal`); return true;
    } catch (error) {
      evidence.status = 'unverified'; evidence.detail = String(error);
      const current = (await c.thread(threadId)).turns.find((t) => t.id === turn.id);
      if (current?.status === 'inProgress') await cancel(turn.id);
      // 未消费的 fixture 结果仍在队列中；结束人工序列，不让它污染后续故事。
      c.save(); return false;
    }
  };

  const form = await start('mcp-form', 'mcpServer/elicitation/request', [mark('MCP_FORM'), 'count', 'enabled'], () => enqueueMcp('form'));
  const requestCount = d.model.requests.length;
  const answerFeedback = async (text: string, expected: string) => {
    const beforeIds = new Set(userReadbackMessages(await c.read(chatId)).map((m) => m.message_id));
    await c.send(chatId, text);
    // 原生问答提示投递到群，不要求产品使用 reply_to；必须是本次输入后的新增机器人消息。
    await c.wait(expected, async () => newAnswerFeedback(await c.read(chatId), beforeIds, d.botAppId, expected));
  };
  await answerFeedback('0', '回答不符合此项要求');
  assert.equal(d.model.requests.length, requestCount, '无效回答不能作为工具结果发给模型');
  assert.equal((await c.thread(threadId)).turns.find((t) => t.id === form.turn.id)?.status, 'inProgress');
  await answerFeedback('3', '已记录此项');
  d.model.enqueue({ text: mark('MCP_FORM_RESULT') });
  await c.send(chatId, 'false');
  await c.terminal(threadId, form.turn.id);
  const output = toolOutputs().find((i) => i.call_id === `cards_form_${d.runId}`);
  assertFormResult(output);
  await c.visible(chatId, mark('MCP_FORM_RESULT'));
  form.evidence.status = 'passed'; form.evidence.detail = '真实用户文字 0 被拒绝、3 被接受，false 保持布尔类型，原生工具完成且用户回读。';
  c.check('native_mcp_form_boundary_user_answers');

  assert(d.workspace, '扩展卡片必须使用隔离 workspace');
  const patchPath = path.join(d.workspace, 'approved-card-file.txt');
  const lines = [mark('FILE_DIFF'), '中文 <tag> & markdown', '```typescript', 'const boundary = "three lines";', '```'];
  const patch = `*** Begin Patch\n*** Add File: ${patchPath}\n${lines.map((line) => `+${line}`).join('\n')}\n*** End Patch`;
  const file = await start('file', 'item/fileChange/requestApproval', ['Codex 请求修改文件', patchPath, ...lines], () => {
    d.model.enqueue((body) => {
      const tool = body.tools?.find((tool) => tool.name === 'apply_patch');
      assert(tool, '0.153 fixture 必须公开 apply_patch');
      return { tool: 'apply_patch', arguments: tool.type === 'custom' ? patch : { input: patch } };
    });
  });
  assert(!fs.existsSync(patchPath), '用户批准前不得写入文件');
  const fileEvent = report.protocol.find((m) => m.method === 'item/started' && (m.params as any)?.turnId === file.turn.id
    && (m.params as any)?.item?.id === (file.evidence.request.params as any)?.itemId);
  assert(fileEvent && JSON.stringify((fileEvent.params as any).item.changes).includes(mark('FILE_DIFF')), 'diff 必须来自对应的原生 item/started');
  if (!await manual(file, '允许', 'accept', () => assert.equal(fs.readFileSync(patchPath, 'utf8').trimEnd(), lines.join('\n')))) return;
  if (!d.approvalWaitMs) assert(!fs.existsSync(patchPath), '取消文件审批后不得写入文件');

  const permissionPath = path.join(d.workspace, 'permission-only-this-turn');
  const permissionCall = `cards_permissions_${d.runId}`;
  const permissions = await start('permissions', 'item/permissions/requestApproval', ['仅本轮允许', permissionPath], () => {
    d.model.enqueue((body) => {
      assert(body.tools?.some((tool) => tool.name === 'request_permissions'), '0.153 fixture 必须公开 request_permissions');
      return { tool: 'request_permissions', callId: permissionCall, arguments: {
        reason: mark('PERMISSION_SCOPE'), permissions: { file_system: { write: [permissionPath] } },
      } };
    });
  });
  assertCardContains(permissions.evidence.card, ['允许写入']);
  if (!await manual(permissions, '仅本轮允许', 'accept', () => {
    const output = toolOutputs().find((i) => i.call_id === permissionCall);
    assertPermissionResult(output, permissionPath);
  })) return;

  const url = await start('mcp-url', 'mcpServer/elicitation/request', [mark('MCP_URL'), 'http://127.0.0.1:9/codelark-fixture', '已完成', '取消'], () => enqueueMcp('url'));
  const target = new URL(String((url.evidence.request.params as any).url));
  assert.equal(target.hostname, '127.0.0.1'); assert.equal(target.port, '9');
  assertCardContains(url.evidence.card, ['%3Ctest%3E']);
  await manual(url, '取消', 'cancel', () => {
    const output = toolOutputs().find((i) => i.call_id === `cards_url_${d.runId}`);
    assert(decodedToolResults(output).some((v) => v.action === 'cancel'), '原生 MCP 必须收到此 URL 请求的取消结果');
  });
}
