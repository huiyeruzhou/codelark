import '../../../setup/test-setup.js';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CursorAcpProvider, closeAllCursorAcpSessions, closeCursorAcpSession, interruptCursorAcpSession, getCursorAcpSessionActivity } from '../../../../runtime/cursor/acp-provider.js';
import type { CursorAcpMessage } from '../../../../runtime/cursor/acp-client.js';
import { PendingPermissions } from '../../../../runtime/permission-gateway.js';
import { buildToolProgressBlocks } from '../../../../shared/progress/tool-rendering.js';
import { buildTaskProgressMarkdown } from '../../../../channels/feishu/markdown.js';

class FakeAcp {
  connected = true;
  nativeId = `native-${randomUUID()}`;
  calls: Array<{method: string; params: any}> = [];
  responses: Array<{id: string | number; result: any}> = [];
  listeners = new Set<(message: CursorAcpMessage) => void>();
  disconnectListeners = new Set<(error: Error) => void>();
  pending?: { resolve(value: any): void; reject(error: Error): void };
  onPrompt?: (params: any, index: number) => void;
  onCancel?: () => void;
  count = 0;
  startArgs?: string[];
  configOptions: Array<Record<string, any>> = [];
  request<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    this.calls.push({method, params});
    if (method === 'initialize') return Promise.resolve({agentCapabilities: {loadSession: true}} as T);
    if (method === 'session/new') return Promise.resolve({sessionId: this.nativeId, configOptions: this.configOptions} as T);
    if (method === 'session/load') {
      this.nativeId = (params as any).sessionId;
      this.update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'OLD HISTORY MUST NOT REPLAY'}});
      this.update({sessionUpdate:'tool_call',toolCallId:'historical-tool',kind:'execute'});
    }
    if (method === 'session/prompt') {
      assert.equal(this.pending, undefined, 'only one native prompt at a time');
      const promise = new Promise<T>((resolve, reject) => { this.pending = {resolve,reject}; });
      const count = ++this.count;
      queueMicrotask(() => this.onPrompt?.(params, count));
      return promise;
    }
    if (method === 'session/set_config_option') {
      const {configId, value} = params as any;
      const option = this.configOptions.find(option=>option.id===configId);
      if (!option || !option.options.some((option:any)=>option.value===value)) return Promise.reject(new Error('Invalid params'));
      option.currentValue = value;
    }
    return Promise.resolve({configOptions:this.configOptions} as T);
  }
  notify(method: string, params: unknown = {}) {
    this.calls.push({method,params});
    if (method === 'session/cancel') this.onCancel?.();
  }
  respond(id: string | number, result: unknown) { this.responses.push({id,result}); }
  reject(id: string | number, code: number, message: string) { this.responses.push({id,result:{error:{code,message}}}); }
  onMessage(listener: (message: CursorAcpMessage) => void) { this.listeners.add(listener); return () => {this.listeners.delete(listener)}; }
  onDisconnect(listener: (error: Error) => void) { this.disconnectListeners.add(listener); return () => {this.disconnectListeners.delete(listener)}; }
  send(message: CursorAcpMessage) { for (const listener of this.listeners) listener(message); }
  update(update: unknown) { this.send({method:'session/update',params:{sessionId:this.nativeId,update}}); }
  end(stopReason = 'end_turn') { const pending = this.pending; this.pending = undefined; pending?.resolve({stopReason}); }
  close() { this.disconnect(new Error('test process exited')); }
  disconnect(error: Error) {
    if (!this.connected) return;
    this.connected = false;
    const pending = this.pending; this.pending = undefined; pending?.reject(error);
    for (const listener of this.disconnectListeners) listener(error);
  }
}
interface Event {type:string; data:any}
async function collect(stream: ReadableStream<string>, onEvent?: (event: Event) => void): Promise<Event[]> {
  const reader = stream.getReader(); const events: Event[] = [];
  for (;;) {
    const next = await reader.read(); if (next.done) break;
    const raw = JSON.parse(next.value.slice(6));
    let data: unknown = raw.data; try {data = JSON.parse(raw.data)} catch {}
    const event = {type:raw.type,data}; events.push(event); onEvent?.(event);
  }
  return events;
}
async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 2_000;
  while (!check()) { if (Date.now() > end) throw new Error('condition not reached'); await new Promise(resolve => setImmediate(resolve)); }
}
function setup(perms?: PendingPermissions) {
  const client = new FakeAcp();
  const provider = new CursorAcpProvider(perms, {clientFactory:async options=>{client.startArgs=options.args;return client;},cancelTimeoutMs:100,retryDelayMs:0});
  const sessionId = `bridge-${randomUUID()}`;
  return {client,provider,sessionId};
}

afterEach(async () => { await closeAllCursorAcpSessions(); });

describe('Cursor ACP direct provider', () => {
  const transient = 'RetriableError: [canceled] http/2 stream closed with error code CANCEL (0x8)';
  const nativeError = (client: FakeAcp, message = transient) => {
    client.update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:`\n\nError: ${message}`}});
    client.end();
  };

  for (const failure of [transient, 'RetriableError: [resource_exhausted] Error']) {
    it(`resumes after ${failure}: same native session after a diagnostic error plus end_turn without repeating completed tools or the original input`, async () => {
      const {client,provider,sessionId}=setup();
      client.onPrompt=(_params,index)=>{
        if(index===1){
          client.update({sessionUpdate:'tool_call',toolCallId:'once',kind:'execute',rawInput:{command:'side effect'}});
          client.update({sessionUpdate:'tool_call_update',toolCallId:'once',status:'completed',rawOutput:'done'});
          nativeError(client, failure);
        }else{client.update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'已续接完成'}});client.end();}
      };
      let accepted=0;
      const events=await collect(provider.streamChat({sessionId,prompt:'original input',onInputAccepted:()=>accepted++}));
      const prompts=client.calls.filter(call=>call.method==='session/prompt');
      assert.equal(prompts.length,2);assert.equal(new Set(prompts.map(call=>call.params.sessionId)).size,1);
      assert.equal(prompts[0].params.prompt[0].text,'original input');assert.match(prompts[1].params.prompt[0].text,/不要重复已完成/);
      assert.equal(accepted,1);assert.equal(events.filter(e=>e.type==='tool_use').length,1);
      assert.equal(events.filter(e=>e.type==='text').map(e=>e.data).join(''),'已续接完成');
      assert.equal(events.filter(e=>e.type==='error').length,0);assert.equal(events.find(e=>e.type==='result')?.data.outcome,'completed');
      assert.ok(events.some(e=>e.type==='status'&&/自动续接（1\/2）/.test(e.data.reasoning||'')));
    });

    it(`exhausts two continuations for ${failure} despite native end_turn`, async () => {
      const {client,provider,sessionId}=setup();client.onPrompt=()=>nativeError(client, failure);
      const events=await collect(provider.streamChat({sessionId,prompt:'original'}));
      assert.equal(client.count,3);assert.equal(events.filter(e=>e.type==='result').length,1);
      assert.equal(events.find(e=>e.type==='result')?.data.outcome,'failed');
      assert.equal(events.find(e=>e.type==='error')?.data,failure);assert.equal(events.filter(e=>e.type==='text').length,0);
    });

  }

  for(const reason of ['authentication','unfinished tool','resource exhausted with unfinished tool']) it(`does not retry ${reason}`,async()=>{
    const {client,provider,sessionId}=setup();client.onPrompt=()=>{
      if(reason.includes('unfinished tool'))client.update({sessionUpdate:'tool_call',toolCallId:'pending',kind:'execute'});
      nativeError(client,reason==='authentication'?'[unauthenticated] Backend rejected authentication.':reason.startsWith('resource')?'RetriableError: [resource_exhausted] Error':transient);
    };
    const events=await collect(provider.streamChat({sessionId,prompt:'original'}));
    assert.equal(client.count,1);assert.equal(events.find(e=>e.type==='result')?.data.outcome,'failed');
  });

  for (const failure of [transient, 'RetriableError: [resource_exhausted] Error']) it(`cancels ${failure} backoff and accepts the next user input without stale continuation`, async()=>{
    const client=new FakeAcp();const sessionId=randomUUID();
    const provider=new CursorAcpProvider(undefined,{clientFactory:async()=>client,retryDelayMs:60_000});
    client.onPrompt=()=>nativeError(client, failure);const events:Event[]=[];
    const running=collect(provider.streamChat({sessionId,prompt:'old'}),e=>events.push(e));
    await until(()=>events.some(e=>e.type==='status'&&/自动续接/.test(e.data.reasoning||'')));
    assert.equal(await interruptCursorAcpSession(sessionId),true);await running;
    assert.equal(client.count,1);assert.equal(events.find(e=>e.type==='result')?.data.outcome,'aborted');
    client.onPrompt=()=>client.end();await collect(provider.streamChat({sessionId,cursorSessionId:client.nativeId,prompt:'new'}));
    assert.deepEqual(client.calls.filter(c=>c.method==='session/prompt').map(c=>c.params.prompt[0].text),['old','new']);
  });

  it('waits 30 then 60 seconds on resource exhaustion instead of rapid retry', async t => {
    t.mock.timers.enable({apis:['setTimeout']});
    const client=new FakeAcp();const sessionId=randomUUID();
    const provider=new CursorAcpProvider(undefined,{clientFactory:async()=>client});
    client.onPrompt=()=>nativeError(client,'RetriableError: [resource_exhausted] Error');
    const events:Event[]=[];
    const running=collect(provider.streamChat({sessionId,prompt:'original'}),e=>events.push(e));
    const retries=()=>events.filter(e=>e.type==='status'&&/自动续接/.test(e.data.reasoning||''));
    await until(()=>retries().length===1);
    assert.match(retries()[0].data.reasoning,/资源或额度受限，30 秒/);
    t.mock.timers.tick(29_999);assert.equal(client.count,1);
    t.mock.timers.tick(1);await until(()=>retries().length===2);
    assert.match(retries()[1].data.reasoning,/60 秒/);
    t.mock.timers.tick(59_999);assert.equal(client.count,2);
    t.mock.timers.tick(1);await running;
    assert.equal(client.count,3);assert.equal(events.find(e=>e.type==='result')?.data.outcome,'failed');
  });

  it('leaves quoted diagnostic examples and tool output as ordinary content', async()=>{
    const {client,provider,sessionId}=setup();const example=`示例：\n\nError: ${transient}`;
    client.onPrompt=()=>{client.update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:example}});client.end();};
    const events=await collect(provider.streamChat({sessionId,prompt:'explain'}));
    assert.equal(client.count,1);assert.equal(events.find(e=>e.type==='text')?.data,example);
    assert.equal(events.find(e=>e.type==='result')?.data.outcome,'completed');
  });

  it('normalizes native Todo titles and merges partial updates by ID without dropping earlier tasks', async () => {
    const {client,provider,sessionId}=setup();
    const result=collect(provider.streamChat({sessionId,prompt:'track tasks'}));
    await until(()=>client.count===1);
    const full=Array.from({length:5},(_,i)=>({id:`task-${i}`,content:`任务 ${i}`,status:i<3?'completed':'pending'}));
    const send=(id:number,todos:unknown[],merge:boolean)=>client.send({id,method:'cursor/update_todos',params:{sessionId:client.nativeId,todos,merge}});
    send(1,full,false);
    const delta=[{...full[3],status:'completed'},{...full[4],status:'in_progress'}];
    send(2,delta,true);send(3,delta,true);
    send(4,[{id:'task-4',status:'cancelled'}],true);
    send(5,[{id:'replacement',content:'下一阶段',status:'pending'},{id:'malformed',status:'pending'}],false);
    client.end();const events=await result;
    const snapshots=events.filter(event=>event.type==='task_update').map(event=>event.data.tasks);
    assert.equal(snapshots.length,5);
    assert.deepEqual(snapshots[1],full.map((task,i)=>({text:task.content,status:i<4?'completed' as const:'in_progress' as const})));
    assert.deepEqual(snapshots[2],snapshots[1]);
    assert.equal(snapshots[3].length,4);
    assert.deepEqual(snapshots[4],[{text:'下一阶段',status:'pending'}]);
    const rendered=buildTaskProgressMarkdown(snapshots[1]);
    for(const task of full) assert.ok(rendered.includes(task.content));
    assert.doesNotMatch(rendered,/undefined/);
    assert.equal(client.responses.length,5);
  });

  it('normalizes standard ACP plans without requiring Cursor Todo IDs', async () => {
    const {client,provider,sessionId}=setup();
    const result=collect(provider.streamChat({sessionId,prompt:'plan'}));
    await until(()=>client.count===1);
    client.update({sessionUpdate:'plan',entries:[
      {content:'读取记录',priority:'medium',status:'completed'},
      {content:'修复问题',priority:'medium',status:'in_progress'},
      {content:'验证结果',priority:'medium',status:'pending'},
      {content:'取消事项',status:'cancelled'},
      {content:' '},{status:'pending'},
    ]});
    client.end();const events=await result;
    assert.deepEqual(events.find(event=>event.type==='task_update')!.data.tasks,[
      {text:'读取记录',status:'completed'},
      {text:'修复问题',status:'in_progress'},
      {text:'验证结果',status:'pending'},
    ]);
  });

  it('unwraps native Read text with real newlines and retains the complete result for the shared preview', async () => {
    const {client,provider,sessionId}=setup();
    const result=collect(provider.streamChat({sessionId,prompt:'read'}));
    await until(()=>client.count===1);
    const file=Array.from({length:450},(_,line)=>`${line}: "quoted value"; literal \\n and C:\\project\\file; 中文内容`).join('\n')+'\nLAST_READ_LINE\n';
    assert.ok(Buffer.byteLength(file)>18_000);
    client.update({sessionUpdate:'tool_call',toolCallId:'read-large',kind:'read',rawInput:{path:'/test/large.txt'}});
    client.update({sessionUpdate:'tool_call_update',toolCallId:'read-large',status:'completed',rawOutput:{content:file}});
    client.end();
    const events=await result;
    const start=events.find(event=>event.type==='tool_use')!.data;
    const finish=events.find(event=>event.type==='tool_result')!.data;
    assert.equal(finish.content,file);
    assert.equal(finish.show_output,true);
    const [block]=buildToolProgressBlocks([{id:start.id,name:start.name,input:JSON.stringify(start.input),output:finish.content,status:'complete',showOutput:finish.show_output}]);
    assert.ok(block!.detail.includes(file.split('\n').slice(0,2).join('\n')));
    assert.doesNotMatch(block!.detail,/\{"content":/);
  });

  it('retains native Grep and Glob statistics and other structured results without fabricating missing bodies', async () => {
    const {client,provider,sessionId}=setup();
    const result=collect(provider.streamChat({sessionId,prompt:'search'}));
    await until(()=>client.count===1);
    const cases=[
      {id:'grep',raw:{totalMatches:31,truncated:true}},
      {id:'glob',raw:{totalFiles:8,truncated:false}},
      {id:'structured',raw:{error:'upstream error',details:{retained:['one','two']}}},
    ];
    for(const {id,raw} of cases){
      client.update({sessionUpdate:'tool_call',toolCallId:id,kind:'search',rawInput:{pattern:'*.ts'}});
      client.update({sessionUpdate:'tool_call_update',toolCallId:id,status:'completed',rawOutput:raw});
    }
    client.end();const events=await result;
    for(const {id,raw} of cases){
      const finish=events.find(event=>event.type==='tool_result'&&event.data.tool_use_id===id)!.data;
      assert.equal(finish.content,JSON.stringify(raw,null,2));
      assert.deepEqual(JSON.parse(finish.content),raw);
      assert.equal(finish.show_output,true);
    }
  });

  it('retains native Shell stdout, stderr and exit status in the actual shared card renderer', async () => {
    const {client,provider,sessionId} = setup();
    const result = collect(provider.streamChat({sessionId,prompt:'run tools'}));
    await until(()=>client.count===1);
    for (const exitCode of [0, 7]) {
      const id = `shell-${exitCode}`;
      client.update({sessionUpdate:'tool_call',toolCallId:id,kind:'execute',rawInput:{command:'printf ACP_%s LIVE_TOOL'}});
      // Real ACP completion has no kind/title; the adapter must retain the initial kind.
      client.update({sessionUpdate:'tool_call_update',toolCallId:id,status:'completed',rawOutput:{exitCode,stdout:'ACP_LIVE_TOOL',stderr:'ACP_WARNING'}});
    }
    client.end();
    const events = await result;
    for (const exitCode of [0, 7]) {
      const start = events.find(event=>event.type==='tool_use' && event.data.id===`shell-${exitCode}`)!.data;
      const finish = events.find(event=>event.type==='tool_result' && event.data.tool_use_id===start.id)!.data;
      assert.equal(finish.is_error,exitCode!==0);
      assert.equal(finish.show_output,true);
      const [block] = buildToolProgressBlocks([{
        id:start.id,name:start.name,input:JSON.stringify(start.input),
        output:finish.content,status:finish.is_error?'error':'complete',showOutput:finish.show_output,
      }]);
      assert.match(block!.detail,/ACP_LIVE_TOOL/);
      assert.match(block!.detail,/ACP_WARNING/);
      assert.equal(block!.tool.detail?.kind,'exec_command');
      if(block!.tool.detail?.kind==='exec_command') {
        assert.equal(block!.tool.detail.exitCode,exitCode);
        assert.equal(block!.tool.detail.output,'ACP_LIVE_TOOL\nACP_WARNING');
      }
      assert.deepEqual(block!.titleMeta,exitCode ? [`exit ${exitCode}`] : []);
    }
  });

  it('renders native edits, new files and deletions as one patch per original tool ID', async () => {
    const {client,provider,sessionId} = setup();
    const result = collect(provider.streamChat({sessionId,prompt:'edit',workingDirectory:'/test'}));
    await until(()=>client.count===1);
    const cases=[
      {id:'edit',kind:'edit',oldText:'same\nbefore\nend\n',newText:'same\nACP_EDIT_RESULT\nend\n',action:'update'},
      {id:'add',kind:'edit',oldText:null,newText:'ACP_NEW_FILE\n',action:'add'},
      {id:'delete',kind:'delete',oldText:'ACP_DELETED_FILE\n',newText:'',action:'delete'},
      {id:'empty',kind:'edit',oldText:'removed\n',newText:'',action:'update'},
    ];
    for(const item of cases){
      const filePath=`/test/${item.id}.txt`;
      client.update({sessionUpdate:'tool_call',toolCallId:item.id,kind:item.kind,rawInput:{path:filePath}});
      const complete={sessionUpdate:'tool_call_update',toolCallId:item.id,status:'completed',content:[{type:'diff',path:filePath,oldText:item.oldText,newText:item.newText}]};
      client.update(complete);client.update(complete);
    }
    client.end();
    const events = await result;
    assert.equal(events.filter(event=>event.type==='tool_use').length,cases.length);
    assert.equal(events.filter(event=>event.type==='tool_result').length,cases.length);
    for(const item of cases){
      const finish=events.find(event=>event.type==='tool_result'&&event.data.tool_use_id===item.id)!.data;
      assert.equal(finish.name,'apply_patch');assert.equal(finish.content,'');assert.equal(finish.show_output,false);
      const [block]=buildToolProgressBlocks([{id:item.id,name:finish.name,input:JSON.stringify(finish.input),output:finish.content,status:'complete',showOutput:finish.show_output}]);
      assert.equal(block!.tool.detail?.kind,'patch_apply');
      if(block!.tool.detail?.kind==='patch_apply') assert.deepEqual(block!.tool.detail.files,[{path:`${item.id}.txt`,action:item.action}]);
      if(item.oldText?.includes('before')) assert.match(block!.detail,/-before\n\+ACP_EDIT_RESULT/);
      if(item.id==='add') assert.match(block!.detail,/\+ACP_NEW_FILE/);
      if(item.id==='delete') assert.match(block!.detail,/-ACP_DELETED_FILE/);
      if(item.id==='empty') assert.match(block!.detail,/-removed/);
      assert.equal(block!.detail.split('ACP_EDIT_RESULT').length,item.id==='edit'?2:1,'new text appears in the patch only once');
    }
  });

  it('keeps a late edit in a large file visible by removing unchanged outer context from the diff', async () => {
    const {client,provider,sessionId}=setup();
    const result=collect(provider.streamChat({sessionId,prompt:'edit',workingDirectory:'/test'}));await until(()=>client.count===1);
    const prefix=Array.from({length:1000},(_,i)=>`unchanged ${i}`).join('\n');
    const suffix=Array.from({length:1000},(_,i)=>`tail ${i}`).join('\n');
    client.update({sessionUpdate:'tool_call',toolCallId:'late-edit',kind:'edit',rawInput:{path:'/test/large.ts'}});
    client.update({sessionUpdate:'tool_call_update',toolCallId:'late-edit',status:'completed',content:[{type:'diff',path:'/test/large.ts',oldText:`${prefix}\nOLD_VALUE\n${suffix}\n`,newText:`${prefix}\nNEW_VALUE\n${suffix}\n`}]});
    client.end();const events=await result;
    const finish=events.find(event=>event.type==='tool_result')!.data;
    assert.ok(finish.input.patch.length<300);
    const [block]=buildToolProgressBlocks([{id:'late-edit',name:finish.name,input:JSON.stringify(finish.input),output:finish.content,status:'complete',showOutput:finish.show_output}]);
    assert.match(block!.detail,/-OLD_VALUE\n\+NEW_VALUE/);
    assert.match(block!.detail,/unchanged 999/);assert.match(block!.detail,/tail 0/);
  });

  it('does not invent deleted content from the native Delete path placeholder', async () => {
    const {client,provider,sessionId}=setup();
    const result=collect(provider.streamChat({sessionId,prompt:'delete',workingDirectory:'/test'}));await until(()=>client.count===1);
    const filePath='/test/removed.py';
    client.update({sessionUpdate:'tool_call',toolCallId:'delete-native',kind:'delete',rawInput:{path:filePath}});
    // Native ACP erroneously uses deletedFile (path) instead of prevContent.
    client.update({sessionUpdate:'tool_call_update',toolCallId:'delete-native',status:'completed',content:[{type:'diff',path:filePath,oldText:filePath,newText:''}]});
    client.end();const events=await result;
    const finish=events.find(event=>event.type==='tool_result')!.data;
    assert.equal(finish.input.patch,'*** Begin Patch\n*** Delete File: /test/removed.py\n*** End Patch');
    assert.match(finish.content,/未提供删除前文件内容/);
    const [block]=buildToolProgressBlocks([{id:'delete-native',name:finish.name,input:JSON.stringify(finish.input),output:finish.content,status:'complete',showOutput:finish.show_output}]);
    assert.match(block!.detail,/Delete File: removed.py/);
    assert.doesNotMatch(block!.detail,/-\/test\/removed.py/);
    assert.match(block!.detail,/未提供删除前文件内容/);
  });

  it('streams new text before completion, ignores load replay and pairs native tool events once', async () => {
    const {client,provider,sessionId} = setup();
    const events: Event[] = [];
    const result = collect(provider.streamChat({sessionId,cursorSessionId:client.nativeId,prompt:'new turn'}), event=>events.push(event));
    await until(()=>client.count===1);
    client.update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'live '}});
    client.update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'answer'}});
    client.update({sessionUpdate:'tool_call',toolCallId:'tool-1',kind:'execute',title:'printf hello',rawInput:{command:'printf hello'}});
    client.update({sessionUpdate:'tool_call_update',toolCallId:'tool-1',status:'in_progress'});
    client.update({sessionUpdate:'tool_call_update',toolCallId:'tool-1',status:'completed',rawOutput:{stdout:'hello'}});
    client.update({sessionUpdate:'tool_call_update',toolCallId:'tool-1',status:'completed',rawOutput:{stdout:'hello'}});
    await until(()=>events.some(event=>event.type==='tool_result'));
    assert.equal(events.some(event=>event.type==='done'), false);
    client.end(); await result;
    assert.deepEqual(events.filter(event=>event.type==='text').map(event=>event.data), ['live ','answer']);
    assert.equal(events.filter(event=>event.type==='tool_use').length,1);
    assert.equal(events.filter(event=>event.type==='tool_result').length,1);
    assert.equal(events.find(event=>event.type==='result')?.data.session_id,client.nativeId);
    assert.equal(events.find(event=>event.type==='result')?.data.outcome,'completed');
    assert.equal(client.calls.filter(call=>call.method==='session/new').length,0);
  });

  it('inserts a paragraph break when agent_message_chunk resumes after agent_thought_chunk', async () => {
    const {client,provider,sessionId} = setup();
    const events: Event[] = [];
    const result = collect(provider.streamChat({sessionId,prompt:'two thoughts'}), event=>events.push(event));
    await until(()=>client.count===1);
    client.update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'第一段完成！'}});
    client.update({sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'thinking again'}});
    client.update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'第二段跟进说明。'}});
    client.update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'继续同一段。'}});
    client.end(); await result;
    assert.equal(
      events.filter(event=>event.type==='text').map(event=>event.data).join(''),
      '第一段完成！\n\n第二段跟进说明。继续同一段。',
    );
  });

  it('rejects overlap without resubmission and waits for native cancellation before releasing the turn', async () => {
    const {client,provider,sessionId} = setup();
    const abortController = new AbortController();
    const events: Event[] = [];
    const first = collect(provider.streamChat({sessionId,prompt:'first',abortController}),event=>events.push(event));
    await until(()=>client.count===1);
    const overlapping = await collect(provider.streamChat({sessionId,prompt:'must not be submitted'}));
    assert.match(overlapping.find(event=>event.type==='error')?.data,/上一轮/);
    assert.equal(client.count,1);
    abortController.abort('codelark:cursor-acp-follow-up');
    await until(()=>client.calls.some(call=>call.method==='session/cancel'));
    assert.equal(events.some(event=>event.type==='done'),false);
    assert.equal(getCursorAcpSessionActivity(sessionId),'active');
    client.end('cancelled');
    assert.equal((await first).find(event=>event.type==='result')?.data.outcome,'aborted');
    assert.equal(getCursorAcpSessionActivity(sessionId),'idle');
    client.onPrompt=()=>client.end();
    const second = await collect(provider.streamChat({sessionId,cursorSessionId:client.nativeId,prompt:'second'}));
    assert.equal(second.find(event=>event.type==='result')?.data.outcome,'completed');
    assert.deepEqual(client.calls.filter(call=>call.method==='session/prompt').map(call=>call.params.prompt[0].text),['first','second']);
    assert.equal(client.calls.filter(call=>call.method==='session/new').length,1);
  });

  it('accepts consecutive interrupted turns in order without replaying earlier prompts', async () => {
    const {client,provider,sessionId} = setup();
    client.onCancel=()=>client.end('cancelled');
    const first=collect(provider.streamChat({sessionId,prompt:'initial'})); await until(()=>client.count===1);
    assert.equal(await interruptCursorAcpSession(sessionId),true); await first;
    const second=collect(provider.streamChat({sessionId,cursorSessionId:client.nativeId,prompt:'followup one'})); await until(()=>client.count===2);
    assert.equal(await interruptCursorAcpSession(client.nativeId),true); await second;
    client.onPrompt=()=>client.end();
    await collect(provider.streamChat({sessionId,cursorSessionId:client.nativeId,prompt:'followup two'}));
    assert.deepEqual(client.calls.filter(call=>call.method==='session/prompt').map(call=>call.params.prompt[0].text),['initial','followup one','followup two']);
  });

  it('fails promptly when the owning process disconnects, without silently resending input', async () => {
    const {client,provider,sessionId} = setup();
    const result=collect(provider.streamChat({sessionId,prompt:'one'})); await until(()=>client.count===1);
    client.disconnect(new Error('own process exited'));
    const events=await result;
    assert.equal(events.find(event=>event.type==='result')?.data.outcome,'failed');
    assert.match(events.find(event=>event.type==='error')?.data,/own process exited/);
    assert.equal(events.at(-1)?.type,'done'); assert.equal(client.count,1);
  });

  it('maps permission choice to the native option and preserves question option IDs', async () => {
    const perms=new PendingPermissions(); const {client,provider,sessionId}=setup(perms);
    const result=collect(provider.streamChat({sessionId,prompt:'work'}),event=>{
      if(event.type==='permission_request') perms.resolve(event.data.permissionRequestId,{behavior:'allow',
        message:event.data.toolName==='Cursor AskQuestion'?JSON.stringify({answers:[{questionId:'q',selectedOptionIds:['b']}]}):undefined});
    });
    await until(()=>client.count===1);
    client.send({id:101,method:'session/request_permission',params:{sessionId:client.nativeId,toolCall:{title:'Read a'},options:[{optionId:'yes',kind:'allow_once'},{optionId:'no',kind:'reject_once'}]}});
    await until(()=>client.responses.some(response=>response.id===101));
    assert.deepEqual(client.responses[0]?.result,{outcome:{outcome:'selected',optionId:'yes'}});
    client.send({id:102,method:'cursor/ask_question',params:{toolCallId:'ask',title:'Question',questions:[{id:'q',prompt:'Choose',options:[{id:'a',label:'A'},{id:'b',label:'B'}],allowMultiple:false}]}});
    await until(()=>client.responses.some(response=>response.id===102));
    assert.deepEqual(client.responses.at(-1)?.result,{outcome:{outcome:'answered',answers:[{questionId:'q',selectedOptionIds:['b']}]}});
    client.end(); await result; assert.equal(perms.size,0);
  });

  it('continues freeform answers as a new user message only after cancellation, without repeating the original prompt', async () => {
    const perms=new PendingPermissions(); const {client,provider,sessionId}=setup(perms);
    client.onPrompt=(_params,index)=>{ if(index===2) client.end(); };
    const result=collect(provider.streamChat({sessionId,prompt:'ORIGINAL TASK SHOULD NOT REPEAT'}),event=>{
      if(event.type==='permission_request') perms.resolve(event.data.permissionRequestId,{behavior:'allow',message:JSON.stringify({answers:[{questionId:'q',selectedOptionIds:[],freeformText:'Use fully async'}]})});
    });
    await until(()=>client.count===1);
    client.send({id:105,method:'cursor/ask_question',params:{title:'Question',questions:[{id:'q',prompt:'Which approach?',options:[{id:'a',label:'Sync'}]}]}});
    await until(()=>client.calls.some(call=>call.method==='session/cancel'));
    assert.equal(client.count,1);
    assert.deepEqual(client.responses.find(response=>response.id===105)?.result,{outcome:{outcome:'cancelled'}});
    client.end('cancelled'); const events=await result;
    const prompts=client.calls.filter(call=>call.method==='session/prompt').map(call=>call.params.prompt[0].text);
    assert.equal(prompts.length,2); assert.match(prompts[1],/Use fully async/); assert.doesNotMatch(prompts[1],/ORIGINAL TASK/);
    assert.equal(events.find(event=>event.type==='result')?.data.outcome,'completed');
    assert.equal(perms.size,0);
  });

  it('cancels outstanding questions and bounds a backend that never confirms cancellation', async () => {
    const perms=new PendingPermissions(); const {client,provider,sessionId}=setup(perms);
    const result=collect(provider.streamChat({sessionId,prompt:'work'})); await until(()=>client.count===1);
    client.send({id:106,method:'cursor/ask_question',params:{title:'Question',questions:[{id:'q',prompt:'Choose',options:[{id:'a',label:'A'}]}]}});
    await until(()=>perms.size===1);
    await assert.rejects(interruptCursorAcpSession(sessionId),/尚未确认中断/);
    const events=await result; assert.equal(client.connected,false); assert.equal(perms.size,0);
    assert.equal(events.at(-1)?.type,'done');
  });

  it('does not start a second executor for the same native session through another bridge ID', async () => {
    const {client,provider,sessionId}=setup(); client.onPrompt=()=>client.end();
    await collect(provider.streamChat({sessionId,prompt:'work'}));
    const events=await collect(provider.streamChat({sessionId:`bridge-${randomUUID()}`,cursorSessionId:client.nativeId,prompt:'duplicate'}));
    assert.match(events.find(event=>event.type==='error')?.data,/已有执行者/);
    assert.equal(client.count,1);
    await closeCursorAcpSession(client.nativeId); assert.equal(client.connected,false);
  });

  it('treats a cleared native binding as new and waits for the old process to exit before creating it', async () => {
    const firstClient=new FakeAcp();const secondClient=new FakeAcp();
    firstClient.onPrompt=()=>firstClient.end();secondClient.onPrompt=()=>secondClient.end();
    const created: FakeAcp[]=[];
    const provider=new CursorAcpProvider(undefined,{clientFactory:async()=>{const client=created.length?secondClient:firstClient;created.push(client);return client}});
    const sessionId=`bridge-${randomUUID()}`;
    await collect(provider.streamChat({sessionId,prompt:'initial'}));
    let release!:()=>void;let closing=false;
    const originalClose=firstClient.close.bind(firstClient);
    firstClient.close=async()=>{closing=true;await new Promise<void>(resolve=>{release=resolve});originalClose()};
    const next=collect(provider.streamChat({sessionId,prompt:'after provider reset'}));
    await until(()=>closing);assert.equal(created.length,1);
    release();const events=await next;
    assert.equal(created.length,2);assert.equal(firstClient.connected,false);
    assert.equal(events.find(event=>event.type==='result')?.data.session_id,secondClient.nativeId);
    assert.equal(secondClient.calls.filter(call=>call.method==='session/new').length,1);
    assert.equal(secondClient.calls.filter(call=>call.method==='session/load').length,0);
  });

  it('reconnects changed cwd and force before loading the explicitly requested native session', async () => {
    const clients: FakeAcp[]=[];const launches: any[]=[];
    const provider=new CursorAcpProvider(undefined,{clientFactory:async options=>{
      launches.push(options);const client=new FakeAcp();client.onPrompt=()=>client.end();clients.push(client);return client;
    }});
    const sessionId=`bridge-${randomUUID()}`;
    await collect(provider.streamChat({sessionId,prompt:'initial',workingDirectory:'/tmp',cursorForce:false}));
    const nativeId=clients[0]!.nativeId;
    await collect(provider.streamChat({sessionId,cursorSessionId:nativeId,prompt:'same history',workingDirectory:'/',cursorForce:true}));
    assert.equal(clients[0]!.connected,false);assert.equal(clients.length,2);
    assert.equal(launches[1].cwd,path.resolve('/'));assert.ok(launches[1].args.includes('--force'));
    assert.equal(clients[1]!.calls.find(call=>call.method==='session/load')?.params.sessionId,nativeId);
    const denied=await collect(provider.streamChat({sessionId,cursorSessionId:nativeId,prompt:'restrict',workingDirectory:'/',cursorForce:false}));
    assert.match(denied.find(event=>event.type==='error')?.data,/不能.*关闭.*Run Everything/);
    assert.equal(clients.length,2);assert.equal(clients[1]!.connected,false);
  });

  it('keeps the executor blocked if process exit could not be confirmed', async () => {
    const {client,provider,sessionId}=setup();client.onPrompt=()=>client.end();
    await collect(provider.streamChat({sessionId,prompt:'initial'}));
    const originalClose=client.close.bind(client);
    client.close=async()=>{throw new Error('exit not confirmed')};
    try {
      const events=await collect(provider.streamChat({sessionId,prompt:'must not create another executor'}));
      assert.match(events.find(event=>event.type==='error')?.data,/exit not confirmed/);
      assert.equal(client.count,1);assert.equal(getCursorAcpSessionActivity(sessionId),'unknown');
    } finally { client.close=originalClose; }
  });

  it('uses the native thought_level config ID and rejects unsupported effort without submitting a prompt', async () => {
    const {client,provider,sessionId}=setup();client.onPrompt=()=>client.end();
    client.configOptions=[{id:'thinking_budget',category:'thought_level',options:[{value:'low'},{value:'high'}]}];
    await collect(provider.streamChat({sessionId,prompt:'work',model:'native-base-model',cursorReasoningEffort:'high'}));
    const configs=client.calls.filter(call=>call.method==='session/set_config_option').map(call=>call.params);
    assert.deepEqual(client.startArgs,['--model','native-base-model','acp']);
    assert.deepEqual(configs.map(config=>[config.configId,config.value]),[['thinking_budget','high']]);
    const events=await collect(provider.streamChat({sessionId,cursorSessionId:client.nativeId,prompt:'do not run',model:'native-base-model',cursorReasoningEffort:'impossible'}));
    assert.match(events.find(event=>event.type==='error')?.data,/不支持思考强度/);assert.equal(client.count,1);
  });

  it('delegates the exact variant ID to native CLI and retains its returned high effort without a base-model setter', async () => {
    const {client,provider,sessionId}=setup();client.onPrompt=()=>client.end();
    client.configOptions=[
      {id:'model',category:'model',currentValue:'gemini-4-carbon',options:[{value:'gemini-4-carbon'}]},
      {id:'reasoning_effort',category:'thought_level',currentValue:'high',options:[{value:'low'},{value:'medium'},{value:'high'}]},
    ];
    const events=await collect(provider.streamChat({sessionId,cursorSessionId:client.nativeId,prompt:'continue',model:'gemini-4-carbon-high'}));
    assert.equal(events.find(event=>event.type==='result')?.data.outcome,'completed');
    assert.deepEqual(client.startArgs,['--model','gemini-4-carbon-high','acp']);
    assert.equal(client.calls.some(call=>call.method==='session/set_config_option'),false);
    assert.equal(client.configOptions[1]!.currentValue,'high');
    assert.equal(client.calls.filter(call=>call.method==='session/load').length,1);
  });

  it('waits for process exit and reloads the same history with the exact newly requested model', async () => {
    const clients:FakeAcp[]=[];const args:Array<string[]|undefined>=[];
    let release!:()=>void;
    const provider=new CursorAcpProvider(undefined,{clientFactory:async options=>{
      const client=new FakeAcp();client.onPrompt=()=>client.end();clients.push(client);args.push(options.args);return client;
    }});
    const sessionId=`bridge-${randomUUID()}`;
    await collect(provider.streamChat({sessionId,prompt:'first',model:'gemini-4-carbon-high'}));
    const first=clients[0]!;const nativeId=first.nativeId;
    const originalClose=first.close.bind(first);
    first.close=async()=>{await new Promise<void>(resolve=>{release=resolve});originalClose()};
    const result=collect(provider.streamChat({sessionId,cursorSessionId:nativeId,prompt:'second',model:'different-model-low'}));
    await until(()=>Boolean(release));assert.equal(clients.length,1);
    release();
    const events=await result;
    assert.equal(events.find(event=>event.type==='result')?.data.outcome,'completed');
    assert.equal(clients.length,2);assert.equal(first.connected,false);
    assert.deepEqual(args,[['--model','gemini-4-carbon-high','acp'],['--model','different-model-low','acp']]);
    assert.equal(clients[1]!.nativeId,nativeId);
    assert.equal(clients[1]!.calls.some(call=>call.method==='session/new'),false);
    assert.equal(events.some(event=>event.type==='text'&&String(event.data).includes('OLD HISTORY')),false);
  });

  it('checks persisted Run Everything before an explicitly restrictive resume', async () => {
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'codelark-acp-policy-'));
    const nativeId=randomUUID();const dbPath=path.join(root,'acp-sessions',nativeId,'store.db');
    fs.mkdirSync(path.dirname(dbPath),{recursive:true});
    const db=new DatabaseSync(dbPath);db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY,value TEXT)');
    db.prepare('INSERT INTO meta VALUES (?,?)').run('0',Buffer.from(JSON.stringify({agentId:nativeId,isRunEverything:true})).toString('hex'));db.close();
    let launches=0;
    const provider=new CursorAcpProvider(undefined,{env:{CURSOR_CONFIG_DIR:root},clientFactory:async()=>{launches++;return new FakeAcp()}});
    try {
      const events=await collect(provider.streamChat({sessionId:`bridge-${randomUUID()}`,cursorSessionId:nativeId,cursorForce:false,prompt:'restricted'}));
      assert.match(events.find(event=>event.type==='error')?.data,/保存了 Run Everything/);assert.equal(launches,0);
    } finally {fs.rmSync(root,{recursive:true,force:true})}
  });

});
