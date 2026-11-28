import '../../../setup/test-setup.js';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { withCursorGoalContinuation } from '../../../../runtime/cursor/goal-continuation.js';
import { readCursorNativeGoal } from '../../../../runtime/cursor/cli-store.js';
import { startAcpHostServer } from '../../../../runtime/acp/host-server.js';
import { AcpHostClient } from '../../../../runtime/acp/host-client.js';
import { acpHostEndpoint } from '../../../../runtime/acp/host-protocol.js';
import type { AcpConnection, AcpMessage } from '../../../../runtime/acp/client.js';

const varint=(n:number):Buffer=>{const a=[];while(n>127){a.push((n&127)|128);n=Math.floor(n/128);}return Buffer.from([...a,n]);};
const field=(n:number,v:string|Buffer|number):Buffer=>typeof v==='number'?Buffer.concat([varint(n*8),varint(v)]):Buffer.concat([varint(n*8+2),varint(Buffer.byteLength(v)),Buffer.from(v)]);
function fixture(t: any) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'clk-goal-'));const id=randomUUID(),goalId=randomUUID();
 const config=path.join(root,'.cursor');const dir=path.join(config,'acp-sessions',id);fs.mkdirSync(dir,{recursive:true});
 const file=path.join(dir,'store.db');const db=new DatabaseSync(file);db.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);CREATE TABLE blobs(id TEXT PRIMARY KEY,data BLOB)');
 db.prepare('INSERT INTO meta VALUES (?,?)').run('0',JSON.stringify({latestRootBlobId:'a'.repeat(64)}));
 const save=(status:number, pending=false, owner=id)=>{
  const goal=Buffer.concat([field(1,owner),field(2,goalId),field(3,'执行两步后完成'),field(4,status)]);
  db.prepare('INSERT OR REPLACE INTO blobs VALUES (?,?)').run('a'.repeat(64),Buffer.concat([field(32,goal),...(pending?[field(4,JSON.stringify({role:'assistant',content:[{type:'tool-call',toolCallId:'pending'}]}))]:[])]));
 };
 save(1);t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});
 return {root,id,goalId,file,env:{...process.env,CURSOR_CONFIG_DIR:config},save};
}
function fake(id:string, onPrompt:(params:any,count:number)=>Promise<any>|any) {
 let connected=true,count=0;const calls:any[]=[];const listeners=new Set<(m:AcpMessage)=>void>();
 const connection:AcpConnection={get connected(){return connected;},async request<T>(method:string,params:any):Promise<T>{
  if(method==='initialize')return {agentCapabilities:{loadSession:true}} as T;
  if(method==='session/new')return {sessionId:id} as T;
  if(method==='session/prompt'){calls.push(params);return await onPrompt(params,++count) as T;}
  return {} as T;
 },notify(){},respond(){},reject(){},onMessage(fn){listeners.add(fn);return()=>{listeners.delete(fn);};},onDisconnect(){return()=>{};},close(){connected=false;}};
 return {connection,calls,emit:(update:any)=>{for(const f of listeners)f({method:'session/update',params:{sessionId:id,update}});}};
}
const turn=(id:string)=>({sessionId:id,prompt:[{type:'text',text:'/goal 执行两步后完成'}]});
const tick=()=>new Promise<void>(r=>setImmediate(r));

it('reads native goal state and continues multiple real prompt boundaries until COMPLETE',async t=>{
 const f=fixture(t);const native=fake(f.id,(_p,n)=>{f.save(n===3?3:1);return {stopReason:'end_turn'};});
 const c=withCursorGoalContinuation(native.connection,f.env);t.after(()=>c.close());const updates:any[]=[];c.onMessage(m=>updates.push(m));
 assert.equal((await c.request<any>('session/prompt',turn(f.id))).stopReason,'end_turn');
 assert.equal(native.calls.length,3);assert.equal(native.calls.filter(p=>p.prompt[0].text.startsWith('/goal')).length,1);
 assert.ok(native.calls.every(p=>p.sessionId===f.id));assert.match(native.calls[1].prompt[0].text,/不创建或替换目标/);
 assert.equal(readCursorNativeGoal(f.file)?.goal?.status,3);
 assert.deepEqual(updates.map(m=>m.params.update.continuing),[true,true,false]);
});
for(const status of [2,4])it(`native goal status ${status} stops without another prompt`,async t=>{
 const f=fixture(t);const native=fake(f.id,()=>{f.save(status);return {stopReason:'end_turn'};});const c=withCursorGoalContinuation(native.connection,f.env);t.after(()=>c.close());
 await c.request('session/prompt',turn(f.id));assert.equal(native.calls.length,1);
});
it('stop at the completion boundary prevents goal from resurrecting',async t=>{
 const f=fixture(t);let c:AcpConnection;const native=fake(f.id,()=>{queueMicrotask(()=>c.notify('session/cancel',{sessionId:f.id}));return {stopReason:'end_turn'};});c=withCursorGoalContinuation(native.connection,f.env);t.after(()=>c.close());
 assert.equal((await c.request<any>('session/prompt',turn(f.id))).stopReason,'cancelled');assert.equal(native.calls.length,1);
});
it('pending tools and foreign goals fail closed rather than launching duplicate work',async t=>{
 const f=fixture(t);const native=fake(f.id,()=>({stopReason:'end_turn'}));const c=withCursorGoalContinuation(native.connection,f.env);t.after(()=>c.close());
 f.save(1,true);await assert.rejects(c.request('session/prompt',turn(f.id)),/未确认的工具调用/);
 f.save(1,false,randomUUID());await assert.rejects(c.request('session/prompt',turn(f.id)),/不属于当前会话/);
 assert.equal(native.calls.length,2);
});
it('native diagnostic errors never become unlimited goal retries',async t=>{
 const f=fixture(t);const native=fake(f.id,()=>{native.emit({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'\n\nError: RetriableError: [resource_exhausted] Error'}});return {stopReason:'end_turn'};});
 const c=withCursorGoalContinuation(native.connection,f.env);t.after(()=>c.close());await c.request('session/prompt',turn(f.id));assert.equal(native.calls.length,1);
});
it('host keeps goal running while bridge disconnects, then replays one terminal turn',async t=>{
 const f=fixture(t);let release!:()=>void;const waiting=new Promise<void>(r=>release=r);
 const native=fake(f.id,async(_p,n)=>{if(n===1)await waiting;f.save(n===2?3:1);return {stopReason:'end_turn'};});
 const socketPath=acpHostEndpoint(f.root);const server=await startAcpHostServer({socketPath,clientFactory:async()=>native.connection});
 const connect=async()=>{const socket=net.createConnection(socketPath);await new Promise<void>((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject);});return new AcpHostClient(socket,socketPath);};
 const one=await connect();let two:AcpHostClient|undefined;
 t.after(async()=>{release();one.detach();two?.detach();await server.close(true);});
 await one.ensureSession({sessionKey:'cursor:test',runtime:'cursor',bridgeSessionId:'test',executable:'fake',args:[],cwd:f.root,env:f.env,label:'Cursor',fingerprint:'test',initializeParams:{protocolVersion:1}});
 const started=await one.startTurn({sessionKey:'cursor:test',prompt:turn(f.id).prompt,meta:{runtime:'cursor',bridgeSessionId:'test'}});
 one.detach();release();for(let i=0;i<100&&native.calls.length<2;i++)await tick();
 assert.equal(native.calls.length,2);two=await connect();
 const events:any[]=[];two.onTurnEvent(started.turn.turnId,e=>events.push(e));const sub=await two.subscribeTurn({turnId:started.turn.turnId});
 for(let i=0;i<100&&!events.some(e=>e.kind==='turn_end');i++)await tick();
 assert.equal(sub.turn.status,'completed');assert.equal(events.filter(e=>e.kind==='turn_end').length,1);
 assert.equal(events.filter(e=>e.kind==='session_update').length,2);
});
