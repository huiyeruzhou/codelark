import '../../../setup/test-setup.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { startFakeCursorBackend, type FakeCursorStreamEvent } from '../../../helpers/runtime/cursor-fake-backend.js';
import { CursorAcpProvider, closeCursorAcpSession, interruptCursorAcpSession } from '../../../../runtime/cursor/acp-provider.js';
import { CursorAcpClient } from '../../../../runtime/cursor/acp-client.js';
import { cloneCursorCliSessionForAcp } from '../../../../runtime/cursor/acp-migration.js';
import { readCursorNativeMessages } from '../../../../runtime/cursor/cli-store.js';
import type { StreamChatParams } from '../../../../runtime/contracts.js';
import { PendingPermissions } from '../../../../runtime/permission-gateway.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
type Event = { type: string; data: any; at: number };
function observe(stream: ReadableStream<string>) {
  const events: Event[] = [];
  const done = (async () => {
    for await (const chunk of stream) for (const line of chunk.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      const event = JSON.parse(line.slice(6));
      let data = event.data;
      try { data = JSON.parse(data); } catch {}
      events.push({ type: event.type, data, at: Date.now() });
    }
  })();
  return { events, done };
}
const text = (events: Event[]) => events.filter(e => e.type === 'text').map(e => typeof e.data === 'string' ? e.data : e.data.text || '').join('');
const realExecutable = () => process.env.CODELARK_REAL_CURSOR_E2E_EXECUTABLE || [
  path.join(process.env.CODELARK_TEST_ORIGINAL_HOME || os.homedir(), '.local/bin/cursor-agent'),
  path.join(process.env.CODELARK_TEST_ORIGINAL_HOME || os.homedir(), '.local/bin/agent'),
].find(candidate => fs.existsSync(candidate));

for (const code of ['canceled', 'resource_exhausted'] as const) it(`real Cursor ACP recovers ${code}, exhausts bounded retries, and never repeats a completed side effect`, {timeout:60_000}, async t=>{
  const executable=realExecutable();if(!executable){t.skip('real Cursor CLI not installed');return;}
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'clk-acp-retry-'));
  const marker=path.join(root,'side-effect');let failing=false;
  const backend=await startFakeCursorBackend({persistConversationSteps:true,call(prompt){
    if(prompt==='one operation'||failing)return{final:'unreachable',stream:(async function*():AsyncGenerator<FakeCursorStreamEvent>{
      if(!failing)yield{type:'execute_shell',id:'write-once',command:`printf once >> ${marker}`,cwd:root};
      yield{type:'transport_error',code,message:code==='canceled'?'http/2 stream closed with error code CANCEL (0x8)':'Error'};
    })()};
    assert.match(prompt,/不要重复已完成/);return{final:'RECOVERED'};
  }});
  const env={...process.env,HOME:root,USERPROFILE:root,CURSOR_CONFIG_DIR:path.join(root,'config'),CURSOR_DATA_DIR:path.join(root,'data'),CURSOR_API_KEY:undefined,CURSOR_AUTH_TOKEN:undefined,NODE_OPTIONS:undefined};
  const provider=new CursorAcpProvider(undefined,{executable,args:backend.args,env,retryDelayMs:0});
  const params:StreamChatParams={sessionId:randomUUID(),runtime:'cursor',cursorProvider:'acp',cursorForce:true,model:'regression-fake',workingDirectory:root,prompt:'one operation'};
  try{
    const recovered=observe(provider.streamChat(params));await recovered.done;
    assert.equal(recovered.events.find(e=>e.type==='result')?.data.outcome,'completed');
    assert.equal(text(recovered.events),'RECOVERED');assert.equal(fs.readFileSync(marker,'utf8'),'once');
    assert.equal(backend.shellResults.length,1);assert.equal(backend.prompts.length,2);
    assert.equal(backend.prompts.filter(p=>p==='one operation').length,1);
    const native=recovered.events.find(e=>e.type==='status'&&e.data.session_id)?.data.session_id;assert(native);
    assert.equal(recovered.events.find(e=>e.type==='result')?.data.session_id,native);
    failing=true;const exhausted=observe(provider.streamChat({...params,cursorSessionId:native,prompt:'persistent outage'}));await exhausted.done;
    assert.equal(exhausted.events.find(e=>e.type==='result')?.data.outcome,'failed');
    assert.match(exhausted.events.find(e=>e.type==='error')?.data,new RegExp(`RetriableError.*${code}`));
    assert.equal(text(exhausted.events),'');assert.equal(backend.prompts.length,5);
    assert.equal(fs.readFileSync(marker,'utf8'),'once');assert.deepEqual(backend.errors,[]);
  }finally{await closeCursorAcpSession(params.sessionId);await backend.close();fs.rmSync(root,{recursive:true,force:true});}
});

it('real Cursor ACP streams before persistence, cancels, preserves consecutive inputs and resumes without replay', { timeout: 70_000 }, async t => {
  const executable = realExecutable();
  if (!executable) { t.skip('real Cursor CLI is not installed; this test uses no account or real model'); return; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-cursor-acp-e2e-'));
  const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
  const second = deferred(), checkpoint = deferred(), stalled = deferred();
  const backend = await startFakeCursorBackend({
    persistConversationSteps: true,
    call(prompt) {
      if (prompt === '实时正文与工具') return {
        final: '第一段：已开始。第二段：工具已完成。', beforeFinish: checkpoint.promise,
        stream: (async function* (): AsyncGenerator<FakeCursorStreamEvent> {
          yield { type: 'text', text: '第一段：已开始。' };
          await second.promise;
          yield { type: 'execute_shell', id: 'acp-shell-regression', command: 'printf ACP_TOOL', cwd: workspace };
          yield { type: 'text', text: '第二段：工具已完成。' };
        })(),
      };
      if (prompt === '等待用户中断') return {
        final: '不得出现的旧轮结果', beforeFinish: stalled.promise,
        stream: (async function* (): AsyncGenerator<FakeCursorStreamEvent> { yield { type: 'text', text: '旧轮正在执行。' }; })(),
      };
      return { final: `已接收：${prompt}` };
    },
  });
  const calls: string[] = [];
  const replayed: unknown[] = [];
  const env = { ...process.env, HOME: root, USERPROFILE: root, CURSOR_CONFIG_DIR: path.join(root, 'config'), CURSOR_DATA_DIR: path.join(root, 'data'), CURSOR_API_KEY: undefined, CURSOR_AUTH_TOKEN: undefined, NODE_OPTIONS: undefined };
  const provider = new CursorAcpProvider(undefined, {
    executable, args: backend.args, env,
    clientFactory: async options => {
      const client = await CursorAcpClient.start(options);
      const request = client.request.bind(client);
      let loading = false;
      client.onMessage(message => { if (loading && message.method === 'session/update') replayed.push(message.params); });
      client.request = ((method: string, ...args: any[]) => {
        calls.push(method); if (method === 'session/load') loading = true;
        return (request as any)(method, ...args).finally(() => { if (method === 'session/load') loading = false; });
      }) as typeof client.request;
      return client;
    },
  });
  const id = `acp-regression-${path.basename(root)}`;
  const params: StreamChatParams = { sessionId: id, runtime: 'cursor', cursorProvider: 'acp', cursorForce: true, model: 'regression-fake', workingDirectory: workspace, prompt: '' };
  const captured: Record<string, Event[]> = {};
  let passed = false;
  const until = async (check: () => boolean, label: string) => {
    const end = Date.now() + 20_000;
    while (Date.now() < end && !check() && !backend.errors.length) await delay(20);
    assert.ok(check(), `${label}; backend=${JSON.stringify(backend.errors)}; events=${JSON.stringify(captured)}`);
  };
  try {
    const first = observe(provider.streamChat({ ...params, prompt: '实时正文与工具' })); captured.first = first.events;
    await until(() => text(first.events) === '第一段：已开始。', 'first delta must reach provider before second delta');
    const sessionId = first.events.find(e => e.type === 'status' && e.data.session_id)?.data.session_id as string;
    assert.ok(sessionId, 'provider must expose the native ACP session ID');
    const store = path.join(env.CURSOR_CONFIG_DIR, 'acp-sessions', sessionId, 'store.db');
    assert.ok(!fs.existsSync(store) || !JSON.stringify(readCursorNativeMessages(store)).includes('第一段'), 'first visible output must not depend on persisted body');
    assert.ok(!first.events.some(e => e.type === 'result'), 'no premature terminal response');
    second.resolve();
    await until(() => text(first.events).includes('第二段'), 'second delta must arrive while checkpoint remains blocked');
    await until(() => first.events.some(e => e.type === 'tool_result'), 'completed tool result must arrive while checkpoint remains blocked');
    assert.ok(!fs.existsSync(store) || !JSON.stringify(readCursorNativeMessages(store)).includes('第二段'), 'second visible output must not depend on final checkpoint');
    assert.equal(first.events.filter(e => e.type === 'tool_use').length, 1, 'pending and in_progress are one logical tool');
    assert.equal(first.events.filter(e => e.type === 'tool_result').length, 1);
    assert.match(JSON.stringify(first.events.find(e => e.type === 'tool_result')!.data), /ACP_TOOL/);
    assert.deepEqual(backend.shellResults, [{ command: 'printf ACP_TOOL', stdout: 'ACP_TOOL', stderr: '', exitCode: 0 }], 'the real CLI must execute the model-requested shell command');
    checkpoint.resolve(); await first.done;
    assert.ok(fs.existsSync(store), 'final checkpoint must create the saved ACP database');
    assert.equal(text(first.events), '第一段：已开始。第二段：工具已完成。');
    assert.equal(first.events.filter(e => e.type === 'result').length, 1);
    const running = observe(provider.streamChat({ ...params, cursorSessionId: sessionId, prompt: '等待用户中断' })); captured.cancelled = running.events;
    await until(() => text(running.events).includes('旧轮正在执行'), 'cancel must target an active native turn');
    assert.equal(await interruptCursorAcpSession(id), true);
    await running.done;
    stalled.resolve();
    assert.ok(!text(running.events).includes('不得出现'));
    assert.ok(running.events.some(e => e.type === 'result' && JSON.stringify(e.data).includes('aborted')), 'native cancellation must be reported as aborted');
    for (const prompt of ['第一次追加：保留中文和 `x < 2`', '第二次追加：再验证一次']) {
      const next = observe(provider.streamChat({ ...params, cursorSessionId: sessionId, prompt })); captured[prompt] = next.events;
      await next.done; assert.equal(text(next.events), `已接收：${prompt}`);
      assert.ok(next.events.some(e => e.type === 'status' && e.data.session_id === sessionId), 'interruption must retain the same native session');
    }
    await closeCursorAcpSession(id);
    const resumed = observe(provider.streamChat({ ...params, cursorSessionId: sessionId, prompt: '恢复后新消息' })); captured.resumed = resumed.events;
    await resumed.done;
    assert.ok(calls.includes('session/load'), 'fresh native process must load its saved ACP session');
    assert.equal(text(resumed.events), '已接收：恢复后新消息', 'load history must not be emitted as a new answer');
    assert.equal(resumed.events.filter(e => e.type === 'tool_use' || e.type === 'tool_result').length, 0, 'load tools must not be emitted again');
    assert.match(JSON.stringify(replayed), /第一段：已开始/);
    assert.match(JSON.stringify(replayed), /ACP_TOOL/, 'load really replays a populated answer and tool history');
    assert.deepEqual(backend.prompts, ['实时正文与工具', '等待用户中断', '第一次追加：保留中文和 `x < 2`', '第二次追加：再验证一次', '恢复后新消息']);
    assert.deepEqual(backend.errors, []);
    passed = true;
  } finally {
    second.resolve(); checkpoint.resolve();
    await closeCursorAcpSession(id); await backend.close();
    if (!passed || process.env.CODELARK_REAL_CURSOR_E2E_KEEP_ARTIFACTS === '1') {
      fs.writeFileSync(path.join(root, 'evidence.json'), JSON.stringify({ executable: fs.realpathSync(executable), passed, calls, prompts: backend.prompts, errors: backend.errors, captured, replayed, modelEventTimes: backend.streamEvents, shellResults: backend.shellResults }, null, 2));
      console.error(`Cursor ACP evidence: ${root}`);
    } else fs.rmSync(root, { recursive: true, force: true });
  }
});

it('real Cursor ACP loads a SQLite backup of an inactive CLI conversation with user, answer and tool history', { timeout: 45_000 }, async t => {
  const executable = realExecutable();
  if (!executable) { t.skip('real Cursor CLI is not installed'); return; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-cursor-acp-migration-e2e-'));
  const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
  const env = { ...process.env, HOME: root, USERPROFILE: root, CURSOR_CONFIG_DIR: path.join(root, 'config'), CURSOR_DATA_DIR: path.join(root, 'data'), CURSOR_API_KEY: undefined, CURSOR_AUTH_TOKEN: undefined, NODE_OPTIONS: undefined };
  const backend = await startFakeCursorBackend({
    persistConversationSteps: true,
    call() { return { final: '迁移前原始答复', stream: (async function* (): AsyncGenerator<FakeCursorStreamEvent> {
      yield { type: 'text', text: '迁移前原始答复' };
      yield { type: 'tool_started', id: 'migration-shell', command: 'printf MIGRATION_TOOL' };
      yield { type: 'tool_completed', id: 'migration-shell', command: 'printf MIGRATION_TOOL', output: 'MIGRATION_TOOL' };
    })() }; },
  });
  let client: CursorAcpClient | undefined, passed = false;
  const messages: unknown[] = [];
  try {
    // --print uses the same native chats/<workspace>/<id>/store.db format as
    // TUI. Awaiting process exit ensures there is no simultaneous writer.
    const child = spawn(executable, [...backend.args, '--model', 'regression-fake', '--force', '--print', '--output-format', 'stream-json', '迁移前原始提问'], { cwd: workspace, env });
    child.stdout.resume(); child.stderr.resume();
    const timer = setTimeout(() => child.kill('SIGKILL'), 25_000);
    const code = await new Promise<number | null>((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); }).finally(() => clearTimeout(timer));
    assert.equal(code, 0);
    const stores = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
      ? stores(path.join(dir, entry.name)) : entry.name === 'store.db' ? [path.join(dir, entry.name)] : []);
    const source = stores(root).find(file => file.includes(`${path.sep}chats${path.sep}`)); assert.ok(source);
    const hash = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const before = hash(source);
    const { sessionId: id, storePath: destination } = await cloneCursorCliSessionForAcp({ storePath: source, cwd: workspace });
    assert.equal(destination, path.join(env.CURSOR_CONFIG_DIR, 'acp-sessions', id, 'store.db'));
    assert.equal(fs.statSync(destination).mode & 0o777, 0o600);
    client = await CursorAcpClient.start({ executable, args: [...backend.args, '--force', 'acp'], cwd: workspace, env });
    client.onMessage(message => messages.push(message));
    await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    await client.request('session/load', { sessionId: id, cwd: workspace, mcpServers: [] });
    const replay = JSON.stringify(messages);
    assert.match(replay, /迁移前原始提问/); assert.match(replay, /迁移前原始答复/); assert.match(replay, /MIGRATION_TOOL/);
    assert.equal(hash(source), before, 'migration must not rewrite the source conversation');
    assert.deepEqual(backend.prompts, ['迁移前原始提问'], 'history loading must not resubmit the old user input');
    assert.deepEqual(backend.errors, []); passed = true;
  } finally {
    await client?.close(); await backend.close();
    if (!passed || process.env.CODELARK_REAL_CURSOR_E2E_KEEP_ARTIFACTS === '1') {
      fs.writeFileSync(path.join(root, 'evidence.json'), JSON.stringify({ passed, messages, prompts: backend.prompts, errors: backend.errors }, null, 2));
      console.error(`Cursor ACP migration evidence: ${root}`);
    } else fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const freeform of [false, true]) it(`real Cursor ACP question ${freeform ? 'preserves free text via cancel and continuation' : 'returns choices to the original tool'}`, { timeout: 45_000 }, async t => {
  const executable = realExecutable(); if (!executable) { t.skip('real Cursor CLI is not installed'); return; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-cursor-acp-question-e2e-'));
  const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
  const env = { ...process.env, HOME: root, USERPROFILE: root, CURSOR_CONFIG_DIR: path.join(root, 'config'), CURSOR_DATA_DIR: path.join(root, 'data'), CURSOR_API_KEY: undefined, CURSOR_AUTH_TOKEN: undefined, NODE_OPTIONS: undefined };
  const backend = await startFakeCursorBackend({
    allowQuestionCancellation: freeform,
    call(prompt) {
      if (prompt === '请询问实验参数') return { toolCallId: 'acp-question', title: '实验参数', questions: [
        { id: 'tag', prompt: '输入标签', options: [{ id: 'alpha', label: 'Alpha' }, { id: 'beta', label: 'Beta' }] },
      ] };
      assert.ok(freeform); assert.match(prompt, /sample-中文-42/); assert.match(prompt, /输入标签/);
      return { final: '已按自由文本继续' };
    },
    continue(answers) { assert.equal(freeform, false); assert.deepEqual(answers, [{ questionId: 'tag', selectedOptionIds: ['beta'], freeformText: '' }]); return '已按选项继续'; },
  });
  const permissions = new PendingPermissions(), id = randomUUID();
  const provider = new CursorAcpProvider(permissions, { executable, args: backend.args, env });
  const turn = observe(provider.streamChat({ sessionId: id, runtime: 'cursor', cursorProvider: 'acp', cursorForce: true, model: 'regression-fake', workingDirectory: workspace, prompt: '请询问实验参数' }));
  let passed = false;
  try {
    const end = Date.now() + 20_000;
    while (Date.now() < end && !turn.events.some(e => e.type === 'permission_request') && !backend.errors.length) await delay(20);
    const question = turn.events.find(e => e.type === 'permission_request');
    assert.ok(question, `question must reach provider; events=${JSON.stringify(turn.events)}; errors=${JSON.stringify(backend.errors)}`);
    assert.equal(permissions.resolve(question.data.permissionRequestId, { behavior: 'allow', message: JSON.stringify({ answers: [{ questionId: 'tag', selectedOptionIds: freeform ? [] : ['beta'], ...(freeform ? { freeformText: 'sample-中文-42' } : {}) }] }) }), true);
    await turn.done;
    assert.equal(text(turn.events), freeform ? '已按自由文本继续' : '已按选项继续');
    assert.equal(backend.prompts.length, freeform ? 2 : 1);
    assert.equal(backend.answers.length, freeform ? 0 : 1, 'free text must not be falsely reported as native option IDs');
    assert.ok(turn.events.some(e => e.type === 'result' && e.data.outcome === 'completed'));
    assert.deepEqual(backend.errors, []); passed = true;
  } finally {
    permissions.denyAll(); await closeCursorAcpSession(id); await backend.close();
    if (!passed || process.env.CODELARK_REAL_CURSOR_E2E_KEEP_ARTIFACTS === '1') {
      fs.writeFileSync(path.join(root, 'evidence.json'), JSON.stringify({ passed, freeform, events: turn.events, prompts: backend.prompts, answers: backend.answers, errors: backend.errors }, null, 2));
      console.error(`Cursor ACP question evidence: ${root}`);
    } else fs.rmSync(root, { recursive: true, force: true });
  }
});
