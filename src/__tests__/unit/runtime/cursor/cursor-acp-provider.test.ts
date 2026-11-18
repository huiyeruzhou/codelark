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
  const provider = new CursorAcpProvider(perms, {clientFactory:async options=>{client.startArgs=options.args;return client;},cancelTimeoutMs:100});
  const sessionId = `bridge-${randomUUID()}`;
  return {client,provider,sessionId};
}

afterEach(async () => { await closeAllCursorAcpSessions(); });

describe('Cursor ACP direct provider', () => {
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

  it('preserves non-Shell diff content and makes it available in the shared card', async () => {
    const {client,provider,sessionId} = setup();
    const result = collect(provider.streamChat({sessionId,prompt:'edit'}));
    await until(()=>client.count===1);
    client.update({sessionUpdate:'tool_call',toolCallId:'edit-1',kind:'edit',rawInput:{path:'/test/example.txt',old_string:'before',new_string:'after'}});
    client.update({sessionUpdate:'tool_call_update',toolCallId:'edit-1',status:'completed',content:[{type:'diff',path:'/test/example.txt',oldText:'before',newText:'ACP_EDIT_RESULT'}],rawOutput:{exitCode:9,stdout:'not a Shell output'}});
    client.end();
    const events = await result;
    const start = events.find(event=>event.type==='tool_use')!.data;
    const finish = events.find(event=>event.type==='tool_result')!.data;
    assert.equal(finish.content,'ACP_EDIT_RESULT');
    assert.equal(finish.is_error,false);
    const [block] = buildToolProgressBlocks([{id:start.id,name:start.name,input:JSON.stringify(start.input),output:finish.content,status:'complete',showOutput:finish.show_output}]);
    assert.match(block!.detail,/ACP_EDIT_RESULT/);
    assert.doesNotMatch(block!.detail,/not a Shell output/);
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
    assert.equal(launches[1].cwd,'/');assert.ok(launches[1].args.includes('--force'));
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
