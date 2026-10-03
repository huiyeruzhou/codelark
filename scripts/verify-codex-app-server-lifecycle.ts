import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { CodexAppServerClient, AppServerRpcError, isUnsupportedAppServerMethod } from '../src/runtime/codex/app-server-client.js';
import { CodexAppServerLifecycle, type AppServerSubmission } from '../src/runtime/codex/app-server-lifecycle.js';
import { fixtureEnvironment, fixtureModel, startFixtureAppServer, startFixtureModel, textInput, waitFor } from './fixtures/codex-app-server-lifecycle.js';
import { requestedPermissions, mcpSchema } from '../src/bridge/permission/app-server-request-types.js';

const execute = promisify(execFile);

export async function verifyLifecycle(executable: string, evidence: string, expectedVersion?: string) {
  assert(path.isAbsolute(executable), '必须指定实际 CLI 的绝对路径');
  fs.mkdirSync(evidence, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-rpc-'));
  const model = await startFixtureModel();
  const env = fixtureEnvironment(root, model.baseUrl);
  const result: Record<string, unknown> = { success: false, platform: process.platform, executable, fixtureRoot: root };
  const wire: Array<{ direction: string; connection: number; message: unknown }> = [];
  const submissions = new Map<string, AppServerSubmission>();
  const saved: unknown[] = [];
  let backend: Awaited<ReturnType<typeof startFixtureAppServer>> | undefined;
  let lifecycle: CodexAppServerLifecycle | undefined;
  const clients: CodexAppServerClient[] = [];
  let dropNextStartReply = false;
  let beforeNextStart: (() => Promise<void>) | undefined;
  let afterNextStartReply: (() => void) | undefined;
  const completed = (threadId: string, turnId: string, status = 'completed') => wire.find((entry) => {
    const m = entry.message as any;
    return entry.direction === 'received' && m.method === 'turn/completed' && m.params.threadId === threadId
      && m.params.turn.id === turnId && m.params.turn.status === status;
  });
  const sent = (method: string, marker?: string) => wire.filter((entry) => entry.direction === 'sent'
    && (entry.message as any).method === method && (!marker || JSON.stringify(entry.message).includes(marker)));
  let timeout: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('验收总超时：180 秒')), 180_000); });
  try {
    await Promise.race([(async () => {
      result.sourceHashes = Object.fromEntries(['app-server-client', 'app-server-lifecycle', 'app-server-events', 'app-server-provider', 'app-server-registry'].map((name) => [name, createHash('sha256').update(fs.readFileSync(new URL(`../src/runtime/codex/${name}.ts`, import.meta.url))).digest('hex')]));
      result.version = (await execute(executable, ['--version'], { env })).stdout.trim();
      if (expectedVersion) assert.equal(result.version, `codex-cli ${expectedVersion}`);
      result.revision = (await execute('git', ['rev-parse', 'HEAD'])).stdout.trim();
      backend = await startFixtureAppServer(executable, root, env);
      result.backendPid = backend.child.pid;
      const endpoint = backend.endpoint;
      const connect = async () => {
        const client = await CodexAppServerClient.connect(endpoint, 15_000);
        const connection = clients.push(client);
        let hidingLostReplyEvents = false;
        assert.equal(client.serverInfo.codexHome, env.CODEX_HOME, '旧版也必须返回服务端 codexHome');
        const send = client.send.bind(client);
        client.send = (message) => { wire.push({ direction: 'sent', connection, message }); send(message); };
        const onMessage = client.onMessage.bind(client);
        onMessage((message) => wire.push({ direction: 'received', connection, message }));
        client.onMessage = (listener) => onMessage((message) => { if (!hidingLostReplyEvents) listener(message); });
        const request = client.request.bind(client);
        client.request = async <T>(method: string, params?: unknown): Promise<T> => {
          if (method === 'turn/start' && beforeNextStart) {
            const before = beforeNextStart; beforeNextStart = undefined;
            await before();
          }
          const lose = dropNextStartReply && method === 'turn/start';
          if (lose) { dropNextStartReply = false; hidingLostReplyEvents = true; }
          const response = await request<T>(method, params);
          wire.push({ direction: 'response', connection, message: { method, result: response } });
          if (method === 'turn/start' && afterNextStartReply) {
            const after = afterNextStartReply; afterNextStartReply = undefined;
            after();
          }
          if (lose) {
            // 故障注入仅丢弃客户端收到的结果；真实 CLI 已接受输入，随后真实断开连接。
            client.close();
            throw new Error('FIXTURE_LOST_REPLY_AFTER_NATIVE_ACCEPTANCE');
          }
          return response;
        };
        return client;
      };
      lifecycle = new CodexAppServerLifecycle(endpoint, {
        connect, loadSubmission: (id) => submissions.get(id),
        saveSubmission: (id, submission) => {
          saved.push({ threadId: id, submission });
          if (submission) submissions.set(id, submission); else submissions.delete(id);
        },
      });
      const options = { cwd: path.join(root, 'workspace'), model: fixtureModel, approvalPolicy: 'never', sandbox: 'read-only' };
      const threadId = await lifecycle.ensureThread(options);
      result.threadId = threadId;
      assert.equal(await lifecycle.ensureThread({ threadId }), threadId);
      assert.equal(sent('thread/start').length, 1, 'ensure 已知线程不能再创建线程');

      model.enqueue({ text: 'FIRST_PROTOCOL_RESPONSE' });
      const firstTurn = await lifecycle.submit(threadId, textInput('FIRST_PROTOCOL_INPUT'));
      await waitFor(() => completed(threadId, firstTurn), '首轮真实完成');
      await waitFor(() => lifecycle!.snapshot(threadId).activity === 'idle' || undefined, '完成驱动 lifecycle idle');
      assert(lifecycle.recordsAfter(threadId).records.some((r) => r.role === 'assistant' && r.content.includes('FIRST_PROTOCOL_RESPONSE')));
      const firstInput = (sent('turn/start', 'FIRST_PROTOCOL_INPUT')[0].message as any).params;
      const user = wire.map((entry) => entry.message as any).find((m) => m.method === 'item/completed'
        && m.params.threadId === threadId && m.params.item.type === 'userMessage' && m.params.item.clientId === firstInput.clientUserMessageId);
      assert(user, 'clientUserMessageId 必须通过 userMessage.clientId 回传');
      assert.notEqual(user.params.item.id, firstInput.clientUserMessageId, 'item.id 是服务端 ID');
      result.userMessageIdentity = { id: user.params.item.id, clientId: user.params.item.clientId };
      result.completionItemsView = ((completed(threadId, firstTurn)!.message as any).params.turn).itemsView;

      const beforeSteer = model.requests.length;
      const slow = model.enqueue({ text: 'BEFORE_STEER_RESPONSE' }, true);
      model.enqueue({ text: 'AFTER_STEER_RESPONSE' });
      const activeTurn = await lifecycle.submit(threadId, textInput('RUNNING_PROTOCOL_INPUT'));
      await waitFor(() => model.requests.length > beforeSteer || undefined, '模型确实运行中');
      assert.equal(await lifecycle.submit(threadId, textInput('STEER_PROTOCOL_INPUT')), activeTurn, 'steer 必须进入同一 turn');
      assert.equal(sent('turn/steer', 'STEER_PROTOCOL_INPUT').length, 1);
      slow.release();
      await waitFor(() => completed(threadId, activeTurn), 'steer 后同轮完成');
      assert(model.requests.some((r) => JSON.stringify(r.body.input).includes('STEER_PROTOCOL_INPUT')));
      result.steerSameTurn = true;

      // 另一真实客户端在 idle 判断后抢先开始：0.145 的响应 ID 会是非原生 submission ID。
      const racingClient = await CodexAppServerClient.connect(endpoint);
      const beforeRace = model.requests.length;
      const racingResponse = model.enqueue({ text: 'OTHER_CLIENT_RACE_RESPONSE' }, true);
      model.enqueue({ text: 'RACE_APPEND_RESPONSE' });
      let racingTurn = '';
      try {
        beforeNextStart = async () => {
          const started = await racingClient.request<any>('turn/start', { threadId, input: textInput('OTHER_CLIENT_RACE_INPUT') });
          racingTurn = started.turn.id;
          await waitFor(() => model.requests.length > beforeRace || undefined, '另一客户端真实活动 turn');
        };
        // 旧版在消费排队输入时才发 userMessage.clientId；模型不能反过来等待这个确认。
        afterNextStartReply = racingResponse.release;
        assert.equal(await lifecycle.submit(threadId, textInput('RACE_INCOMING_INPUT')), racingTurn,
          'start 竞态必须关联到实际活动 turn，不能返回旧版伪 submission ID');
        assert.equal(sent('turn/start', 'RACE_INCOMING_INPUT').length, 1);
        assert.equal(sent('turn/steer', 'RACE_INCOMING_INPUT').length, 0, '确实覆盖原生 start-or-steer 竞态');
        const rpcTurn = (wire.filter((entry) => entry.direction === 'response' && (entry.message as any).method === 'turn/start').at(-1)!.message as any).result.turn.id;
        if (expectedVersion === '0.145.0') assert.notEqual(rpcTurn, racingTurn, '真实复现旧版 start 响应伪 ID');
        result.startRaceIdentity = { rpcTurnId: rpcTurn, actualTurnId: racingTurn };
        racingResponse.release();
        await waitFor(() => completed(threadId, racingTurn), 'start 竞态同轮完成');
        result.startRaceUsesNativeTurn = true;
      } finally { beforeNextStart = undefined; afterNextStartReply = undefined; racingResponse.release(); racingClient.close(); }

      const beforeInterrupt = model.requests.length;
      const interruptedResponse = model.enqueue({ text: 'MUST_NOT_COMPLETE_INTERRUPTED_TURN' }, true);
      const interruptedTurn = await lifecycle.submit(threadId, textInput('INTERRUPT_PROTOCOL_INPUT'));
      await waitFor(() => model.requests.length > beforeInterrupt || undefined, '中断前模型请求');
      assert.equal(await lifecycle.interrupt(threadId), true);
      await waitFor(() => completed(threadId, interruptedTurn, 'interrupted'), '协议 interrupted 终态');
      interruptedResponse.release();
      result.interruptTerminal = true;

      const beforeLostReply = model.requests.length;
      const lost = model.enqueue({ text: 'RECOVERED_WITHOUT_RESUBMIT' }, true);
      const connectionCount = clients.length;
      dropNextStartReply = true;
      await assert.rejects(lifecycle.submit(threadId, textInput('LOST_REPLY_PROTOCOL_INPUT')), /FIXTURE_LOST_REPLY/);
      await waitFor(() => model.requests.length > beforeLostReply || undefined, '已接受但客户端未获得响应');
      await waitFor(() => clients.length > connectionCount && lifecycle!.snapshot(threadId).connection === 'ready' || undefined, '真实断线后 resume');
      assert.equal(sent('turn/start', 'LOST_REPLY_PROTOCOL_INPUT').length, 1, '恢复不能重发副作用');
      const recoveredTurn = lifecycle.snapshot(threadId).turnId;
      assert(recoveredTurn, '恢复必须找回实际活动 turn');
      lost.release();
      await waitFor(() => completed(threadId, recoveredTurn), '重连后原 turn 完成');
      await lifecycle.refresh(threadId);
      assert.equal(sent('turn/start', 'LOST_REPLY_PROTOCOL_INPUT').length, 1);
      result.reconnectWithoutResubmit = true;
      result.unknownSubmissionAfterRecovery = lifecycle.snapshot(threadId).submission || null;

      // 真实服务端 request 重放：不 mock RPC 服务，只让模型调用受控的客户端工具。
      const toolThread = await lifecycle.ensureThread({ ...options, ...{
        dynamicTools: [{ type: 'function', name: 'ci_gate', description: '隔离生命周期门闩', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }],
      } });
      model.enqueue({ tool: 'ci_gate', arguments: {}, callId: 'ci_gate_replay' });
      const toolTurn = await lifecycle.submit(toolThread, textInput('DYNAMIC_TOOL_REPLAY'));
      const pending = await waitFor(() => lifecycle!.snapshot(toolThread).requests.find((r) => r.method === 'item/tool/call'), '真实动态工具待答');
      const beforeReplay = clients.length;
      clients.at(-1)!.close();
      const replay = await waitFor(() => clients.length > beforeReplay
        && lifecycle!.snapshot(toolThread).requests.find((r) => r.id === pending.id && r.key !== pending.key), 'warm resume 重放服务端请求');
      assert.deepEqual(replay.params, pending.params);
      assert.equal(lifecycle.reply(pending.key, { contentItems: [], success: false }), false, '旧连接回调失效');
      model.enqueue({ text: 'DYNAMIC_TOOL_REPLAY_FINISHED' });
      assert.equal(lifecycle.reply(replay.key, { contentItems: [{ type: 'inputText', text: 'EXECUTED_ONCE' }], success: true }), true);
      await waitFor(() => completed(toolThread, toolTurn), '重放工具答复后完成');
      assert.equal(sent('turn/start', 'DYNAMIC_TOOL_REPLAY').length, 1);
      result.pendingRequestReplay = true;

      const fixtureBridgeHome = path.join(root, 'thread-bridge-identity');
      const approvalThread = await lifecycle.ensureThread({ ...options, approvalPolicy: 'on-request', config: {
        'shell_environment_policy.set.CODELARK_HOME': fixtureBridgeHome,
      } });
      const enqueueEnvironmentCommand = () => model.enqueue((body) => {
        const names = (body.tools || []).map((tool) => tool.name);
        const command = 'printf "FIXTURE_BRIDGE_HOME=%s\\n" "$CODELARK_HOME"';
        const tool = ['exec_command', 'shell_command', 'shell'].find((name) => names.includes(name));
        assert(tool, `fixture 需要原生命令工具，实际工具：${names.join(',')}`);
        return { tool, callId: 'ci_environment_approval', arguments: {
          ...(tool === 'exec_command' ? { cmd: command } : tool === 'shell_command' ? { command } : { command: ['/bin/sh', '-c', command] }),
          sandbox_permissions: 'require_escalated', justification: '仅读取隔离 fixture 的线程环境变量',
        } };
      });
      enqueueEnvironmentCommand();
      const approvalTurn = await lifecycle.submit(approvalThread, textInput('THREAD_ENVIRONMENT_APPROVAL'));
      const approval = await waitFor(() => lifecycle!.snapshot(approvalThread).requests.find((r) => r.method === 'item/commandExecution/requestApproval'), '真实命令审批');
      const beforeApprovalReplay = clients.length;
      clients.at(-1)!.close();
      const replayedApproval = await waitFor(() => clients.length > beforeApprovalReplay
        && lifecycle!.snapshot(approvalThread).requests.find((r) => r.id === approval.id && r.key !== approval.key), 'warm resume 重放原审批');
      assert.deepEqual(replayedApproval.params, approval.params);
      model.enqueue({ text: 'THREAD_ENVIRONMENT_CONFIRMED' });
      assert.equal(lifecycle.reply(replayedApproval.key, { decision: 'accept' }), true);
      await waitFor(() => completed(approvalThread, approvalTurn), '审批后的真实环境命令完成');
      const environmentItem = wire.map((entry) => entry.message as any).find((m) => m.method === 'item/completed'
        && m.params.threadId === approvalThread && m.params.item.type === 'commandExecution'
        && m.params.item.aggregatedOutput?.includes(`FIXTURE_BRIDGE_HOME=${fixtureBridgeHome}`));
      assert(environmentItem, 'thread config 必须传递到真实工具进程');
      assert.equal(environmentItem.params.item.exitCode, 0);
      assert(sent('thread/resume').filter((entry) => (entry.message as any).params.threadId === approvalThread)
        .every((entry) => !(entry.message as any).params.config), 'warm resume 不重复覆盖线程环境');
      result.commandApprovalReplay = true;
      result.threadScopedToolEnvironment = true;

      // 新版 CLI 已移除旧 fixture 模型的工具元数据；从该 CLI 的目录选一个实际支持工具的模型。
      // 模型仍由本机确定性 fixture 回答，不访问任何远端模型服务。
      const catalog = await clients.at(-1)!.request<{ data: Array<{ id: string }> }>('model/list', {});
      const toolModel = catalog.data.find((model) => model.id === fixtureModel)?.id || catalog.data.find((model) => model.id === 'gpt-5.5')?.id;
      assert(toolModel, 'CLI 必须提供 fixture 支持的普通 Responses 工具模型');
      const patchThread = await lifecycle.ensureThread({ ...options, model: toolModel, approvalPolicy: 'on-request' });
      const patchPath = path.join(root, 'workspace', 'approved-file.txt');
      const patch = `*** Begin Patch\n*** Add File: ${patchPath}\n+NATIVE_FILE_APPROVAL\n*** End Patch`;
      model.enqueue((body) => {
        const tool = body.tools?.find((tool) => tool.name === 'apply_patch');
        assert(tool, '真实 CLI 必须公开 apply_patch');
        return { tool: 'apply_patch', callId: 'native_file_approval', arguments: tool.type === 'custom' ? patch : { input: patch } };
      });
      const patchTurn = await lifecycle.submit(patchThread, textInput('NATIVE_FILE_APPROVAL'));
      const fileApproval = await waitFor(() => lifecycle!.snapshot(patchThread).requests.find((r) => r.method === 'item/fileChange/requestApproval'), '真实文件修改审批');
      const fileItem = lifecycle.item(patchThread, patchTurn, String(fileApproval.params.itemId));
      assert.equal(fileItem?.type, 'fileChange', '审批上下文必须来自对应的原生 item 事件');
      assert(JSON.stringify(fileItem?.changes).includes('NATIVE_FILE_APPROVAL'), '审批前必须能读取真实文件 diff');
      assert.equal(fs.existsSync(patchPath), false, '审批前不能写文件');
      model.enqueue({ text: 'FILE_APPROVAL_FINISHED' });
      assert.equal(lifecycle.reply(fileApproval.key, { decision: 'accept' }), true);
      await waitFor(() => completed(patchThread, patchTurn), '真实文件审批完成');
      assert.equal(fs.readFileSync(patchPath, 'utf8').trim(), 'NATIVE_FILE_APPROVAL');
      result.fileApprovalContext = true;
      result.requestFixtureModel = toolModel;

      const permissionsThread = await lifecycle.ensureThread({ ...options, model: toolModel, approvalPolicy: 'on-request', config: { 'features.request_permissions_tool': true } });
      model.enqueue((body) => {
        assert(body.tools?.some((tool) => tool.name === 'request_permissions'), '原生权限请求工具必须可用');
        return { tool: 'request_permissions', arguments: { reason: 'NATIVE_PERMISSIONS', permissions: { file_system: { write: [path.join(root, 'permission-output')] } } } };
      });
      const permissionsTurn = await lifecycle.submit(permissionsThread, textInput('NATIVE_PERMISSIONS'));
      const permissionRequest = await waitFor(() => lifecycle!.snapshot(permissionsThread).requests.find((r) => r.method === 'item/permissions/requestApproval'), '原生额外权限审批');
      const permissions = requestedPermissions(permissionRequest.params.permissions);
      assert(permissions, 'CodeLark 必须能完整识别原生权限范围');
      model.enqueue({ text: 'PERMISSIONS_FINISHED' });
      assert.equal(lifecycle.reply(permissionRequest.key, { permissions, scope: 'turn' }), true);
      await waitFor(() => completed(permissionsThread, permissionsTurn), '额外权限审批完成');
      result.additionalPermissions = true;

      const mcpThread = await lifecycle.ensureThread({ ...options, model: toolModel, approvalPolicy: 'on-request', config: {
        'mcp_servers.codelark_fixture.command': process.execPath,
        'mcp_servers.codelark_fixture.args': [fileURLToPath(new URL('./fixtures/codex-app-server-elicitation.mjs', import.meta.url))],
      } });
      model.enqueue({ search: 'codelark_fixture ask' });
      model.enqueue((body) => {
        const tools = [...(body.tools || []), ...(body.input || []).flatMap((item: any) => item.type === 'tool_search_output' ? item.tools || [] : [])];
        const namespace = tools.find((tool) => tool.type === 'namespace' && tool.name.includes('codelark_fixture'));
        const tool = namespace?.tools?.find((tool: any) => tool.name.includes('ask'))
          || tools.find((tool) => tool.name?.includes('codelark_fixture') && tool.name.includes('ask'));
        assert(tool, '原生 MCP 工具必须可见');
        return { tool: tool.name, ...(namespace ? { namespace: namespace.name } : {}), arguments: {} };
      });
      const mcpTurn = await lifecycle.submit(mcpThread, textInput('NATIVE_MCP_FORM'));
      const elicitation = await waitFor(() => lifecycle!.snapshot(mcpThread).requests.find((r) => r.method === 'mcpServer/elicitation/request'), '原生 MCP 表单');
      const content = mcpSchema(elicitation)?.parse({ count: 2, enabled: false });
      assert(content, 'CodeLark 必须识别原生 MCP 表单 schema');
      model.enqueue({ text: 'MCP_FORM_FINISHED' });
      assert.equal(lifecycle.reply(elicitation.key, { action: 'accept', content, _meta: null }), true);
      await waitFor(() => completed(mcpThread, mcpTurn), 'MCP 表单完成');
      result.mcpForm = true;

      const probe = clients.at(-1)!;
      const resumedBridgeHome = path.join(root, 'resumed-bridge-identity');
      const verifyEnvironment = async (marker: string, expected: string) => {
        enqueueEnvironmentCommand();
        model.enqueue({ text: `${marker}_CONFIRMED` });
        const turnId = await lifecycle!.submit(approvalThread, textInput(marker));
        const pending = await waitFor(() => lifecycle!.snapshot(approvalThread).requests.find((r) =>
          r.method === 'item/commandExecution/requestApproval'), `${marker} 审批`);
        assert.equal(lifecycle!.reply(pending.key, { decision: 'accept' }), true);
        await waitFor(() => completed(approvalThread, turnId), `${marker} 完成`);
        assert(wire.some((entry) => {
          const m = entry.message as any;
          return m.method === 'item/completed' && m.params.threadId === approvalThread && m.params.turnId === turnId
            && m.params.item.type === 'commandExecution' && m.params.item.exitCode === 0
            && m.params.item.aggregatedOutput?.includes(`FIXTURE_BRIDGE_HOME=${expected}`);
        }), `${marker} 的真实工具环境值必须符合后端 resume 语义`);
      };
      await probe.request('thread/resume', { threadId: approvalThread, config: {
        'shell_environment_policy.set.CODELARK_HOME': resumedBridgeHome,
      } });
      await verifyEnvironment('LOADED_RESUME_IGNORES_CONFIG', fixtureBridgeHome);
      await lifecycle.detach(approvalThread);
      await lifecycle.ensureThread({ threadId: approvalThread, config: {
        'shell_environment_policy.set.CODELARK_HOME': resumedBridgeHome,
        // 0.145 冷恢复会重新取全局策略；环境测试显式保持本 fixture 原有的审批选择。
        approval_policy: 'on-request',
      } });
      await verifyEnvironment('DETACHED_IDLE_RESUME_APPLIES_CONFIG', resumedBridgeHome);
      result.resumeEnvironmentContract = { subscribedIgnoresOverrides: true, detachedIdleAppliesOverrides: true };

      assert((await probe.request<{ data: string[] }>('thread/loaded/list')).data.includes(threadId));
      const unknownMethod = 'codelark/fixture/unsupported';
      let unknownError: unknown;
      try { await probe.request(unknownMethod); } catch (error) { unknownError = error; }
      assert(unknownError instanceof AppServerRpcError);
      assert.match(unknownError.message, /Invalid request: unknown variant `codelark\/fixture\/unsupported`, expected /);
      assert.equal(isUnsupportedAppServerMethod(unknownError, unknownMethod), true);
      assert.equal(isUnsupportedAppServerMethod(unknownError, 'thread/unsubscribe'), false, '未知方法错误必须匹配本次请求的方法');
      let invalidParams: unknown;
      try { await probe.request('turn/steer', { threadId, input: [], expectedTurnId: '' }); } catch (error) { invalidParams = error; }
      assert(invalidParams instanceof AppServerRpcError);
      assert.equal(isUnsupportedAppServerMethod(invalidParams, 'turn/steer'), false);
      result.legacyOptionalErrors = { unknownMethod: unknownError.message, invalidParams: invalidParams.message };
      await lifecycle.detach(toolThread);
      const metadata = await probe.request<any>('thread/read', { threadId: toolThread });
      assert.equal(metadata.thread.id, toolThread, 'unsubscribe 不能删除线程');
      assert.equal(backend.child.exitCode, null, '客户端生命周期结束不能终止 backend');
      result.backendSurvives = true;
      // 两个真实 Bridge provider 子进程共享持久化 registry；这里只 mock 模型。
      const providerScript = fileURLToPath(new URL('./fixtures/codex-app-server-provider-client.ts', import.meta.url));
      const runProvider = async (action: string) => {
        const providerHome = path.join(root, `provider-${action}`, 'home');
        fs.mkdirSync(providerHome, { recursive: true });
        const providerEnv = { ...env, HOME: providerHome, CODELARK_HOME: path.join(root, 'codelark'),
          CODELARK_NATIVE_FIXTURE: '1', CODELARK_NATIVE_FIXTURE_ROOT: root };
        const child = await execute(process.execPath, ['--import', 'tsx', providerScript, endpoint, options.cwd, action], {
          env: providerEnv, timeout: 40_000, maxBuffer: 2 * 1024 * 1024,
        });
        fs.writeFileSync(path.join(evidence, `provider-${action}.log`), child.stdout + child.stderr);
        return JSON.parse(child.stdout.trim().split('\n').at(-1)!);
      };
      model.enqueue({ text: 'NATIVE_PROVIDER_RESPONSE' });
      const providerFirst = await runProvider('submit');
      const beforeProviderResume = model.requests.length;
      const providerSecond = await runProvider('resume');
      assert.equal(providerFirst.threadId, providerSecond.threadId, '新进程必须恢复 registry 的同一线程');
      assert.equal(model.requests.length, beforeProviderResume, 'registry 恢复不应提交新输入');
      assert.equal(backend.child.exitCode, null);
      result.providerRegistry = { threadId: providerFirst.threadId, survivesProcessExit: true, reusedWithoutInput: true };

      assert.deepEqual(model.unexpected, [], '隔离模型不接受未编排调用');
      result.success = true;
    })(), deadline]);
  } catch (error) {
    result.error = error instanceof Error ? error.stack : String(error);
    throw error;
  } finally {
    clearTimeout(timeout!);
    lifecycle?.close();
    for (const client of clients) client.close();
    await backend?.close();
    await model.close();
    fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2));
    fs.writeFileSync(path.join(evidence, 'protocol.jsonl'), wire.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
    fs.writeFileSync(path.join(evidence, 'submissions.json'), JSON.stringify(saved, null, 2));
    fs.writeFileSync(path.join(evidence, 'model-requests.json'), JSON.stringify(model.requests, null, 2));
    if (fs.existsSync(path.join(root, 'backend.log'))) fs.copyFileSync(path.join(root, 'backend.log'), path.join(evidence, 'backend.log'));
    console.log(JSON.stringify(result));
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const value = (flag: string) => process.argv[process.argv.indexOf(flag) + 1];
  assert(process.argv.includes('--cli'), '用 --cli 指定实际 Codex 二进制绝对路径');
  await verifyLifecycle(path.resolve(value('--cli')),
    process.argv.includes('--evidence') ? path.resolve(value('--evidence')) : fs.mkdtempSync(path.join(os.tmpdir(), 'clk-rpc-evidence-')),
    process.argv.includes('--expect-version') ? value('--expect-version') : undefined);
}
