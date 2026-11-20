import '../../../setup/test-setup.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFakeCursorBackend } from '../../../helpers/runtime/cursor-fake-backend.js';
import { ensureCursorTmuxInputSession, streamCursorTmuxTui, cursorTmuxSessionName } from '../../../../runtime/cursor/tmux-provider.js';
import { tmuxCore, _testOnlyTmuxCore } from '../../../../runtime/tmux/core.js';

const quote=(s:string)=>`'${s.replace(/'/g,"'\\''")}'`;
it('real Cursor bootstrap binds its empty chat before input despite an older workspace transcript', {timeout:60_000}, async t=>{
  const executable=process.env.CODELARK_REAL_CURSOR_E2E_EXECUTABLE || path.join(process.env.CODELARK_TEST_ORIGINAL_HOME || os.homedir(),'.local/bin/agent');
  if(!fs.existsSync(executable)){t.skip('real Cursor CLI is not installed');return;}
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'clk-cursor-bootstrap-'));
  const workspace=path.join(root,'workspace');fs.mkdirSync(workspace);
  const allPrompts:string[]=[];
  const makeBackend=()=>startFakeCursorBackend({persistConversationSteps:true,call(prompt){
    allPrompts.push(prompt);
    assert.ok(['old input','new input'].includes(prompt));return{final:prompt==='old input'?'OLD_DONE':'NEW_DONE'};
  }});
  let backend=await makeBackend();
  const wrapper=path.join(root,'cursor'),tmux=path.join(root,'tmux');
  const writeWrapper=()=>fs.writeFileSync(wrapper,`#!/bin/sh\nexec ${quote(executable)} ${backend.args.map(quote).join(' ')} "$@"\n`,{mode:0o755});writeWrapper();
  fs.writeFileSync(tmux,`#!/bin/sh\nunset TMUX TMUX_PANE\nexec /usr/bin/tmux -S ${quote(path.join(root,'tmux.sock'))} "$@"\n`,{mode:0o755});
  const env:Record<string,string|undefined>={CURSOR_CONFIG_DIR:path.join(root,'config'),CURSOR_DATA_DIR:path.join(root,'data'),CURSOR_AGENT_EXECUTABLE:wrapper,CODELARK_TMUX_EXECUTABLE:tmux,CODELARK_CURSOR_TMUX_POLL_INTERVAL_MS:'100',CURSOR_API_KEY:undefined,CURSOR_AUTH_TOKEN:undefined};
  const saved=new Map(Object.keys(env).map(k=>[k,process.env[k]]));
  for(const [k,v]of Object.entries(env)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
  fs.mkdirSync(env.CURSOR_CONFIG_DIR!);fs.mkdirSync(env.CURSOR_DATA_DIR!);
  fs.writeFileSync(path.join(env.CURSOR_CONFIG_DIR!,'cli-config.json'),JSON.stringify({version:1,approvalMode:'unrestricted'}));
  _testOnlyTmuxCore.reset();
  const params={prompt:'old input',sessionId:'old-bootstrap-chat',workingDirectory:workspace,model:'regression-fake',cursorForce:true};
  const collect=async(p:typeof params & {cursorSessionId?:string})=>{
    const events:Array<{type:string,data:any}>=[];
    for await(const chunk of streamCursorTmuxTui(p))for(const line of chunk.split('\n'))if(line.startsWith('data: ')){
      const e=JSON.parse(line.slice(6));try{e.data=JSON.parse(e.data);}catch{}events.push(e);
    }
    return events;
  };
  try{
    const old=await collect(params);assert.equal(old.at(-1)?.type,'result');
    const oldId=old.find(e=>e.type==='status'&&e.data.session_id)?.data.session_id;assert.ok(oldId);
    await tmuxCore.killSession(cursorTmuxSessionName(params.sessionId));
    // Each native conversation needs its own fake server history, like production.
    assert.deepEqual(backend.errors,[]);await backend.close();backend=await makeBackend();writeWrapper();
    const fresh={...params,sessionId:'new-bootstrap-chat',prompt:''};
    const boot=await ensureCursorTmuxInputSession(fresh);
    assert.ok(boot.sessionId,'native identity is available before submitting the first prompt');
    assert.notEqual(boot.sessionId,oldId);assert.equal(boot.sessionFilePath,undefined);
    const reused=await ensureCursorTmuxInputSession(fresh);assert.equal(reused.sessionId,boot.sessionId);
    const current=await collect({...fresh,prompt:'new input',cursorSessionId:boot.sessionId});
    assert.equal(current.at(-1)?.type,'result');
    assert.ok(current.some(e=>e.type==='text_snapshot'&&e.data==='NEW_DONE'));
    assert.ok(!current.some(e=>e.type==='text_snapshot'&&e.data==='OLD_DONE'));
    assert.deepEqual(allPrompts,['old input','new input']);assert.deepEqual(backend.errors,[]);
  }finally{
    for(const id of ['old-bootstrap-chat','new-bootstrap-chat'])await tmuxCore.killSession(cursorTmuxSessionName(id),{ignoreMissing:true});
    await backend.close();for(const[k,v]of saved){if(v===undefined)delete process.env[k];else process.env[k]=v;}
    _testOnlyTmuxCore.reset();fs.rmSync(root,{recursive:true,force:true});
  }
});
