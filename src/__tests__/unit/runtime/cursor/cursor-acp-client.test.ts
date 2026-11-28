import '../../../setup/test-setup.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { CursorAcpClient, CursorAcpRpcError } from '../../../../runtime/cursor/acp-client.js';

const directories: string[]=[];
const clients: CursorAcpClient[]=[];
async function start(script: string, requestTimeoutMs=500): Promise<CursorAcpClient> {
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'codelark-acp-protocol-')); directories.push(cwd);
  const file=path.join(cwd,'fake.cjs');
  fs.writeFileSync(file,`${script}\nprocess.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'fixture/ready'})+'\\n');`);
  const client=await CursorAcpClient.start({executable:process.execPath,args:[file],cwd,requestTimeoutMs});
  clients.push(client);
  await new Promise<void>((resolve,reject)=>{
    const offMessage=client.onMessage(message=>{
      if(message.method!=='fixture/ready')return;
      offMessage();offDisconnect();resolve();
    });
    const offDisconnect=client.onDisconnect(error=>{offMessage();offDisconnect();reject(error);});
  });
  return client;
}
afterEach(async()=>{await Promise.all(clients.splice(0).map(client=>client.close()));for(const dir of directories.splice(0))fs.rmSync(dir,{recursive:true,force:true});});

describe('Cursor ACP stdio client',()=>{
  it('decodes split NDJSON, matches out-of-order responses and handles server requests',async()=>{
    const client=await start(`
      const readline=require('node:readline');const pending=[];
      const send=x=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+'\\n');
      readline.createInterface({input:process.stdin}).on('line',line=>{
        const m=JSON.parse(line);
        if(m.method==='one'||m.method==='two'){
          pending.push(m);if(pending.length===2){
            send({id:pending[1].id,result:'second'});
            const text=JSON.stringify({jsonrpc:'2.0',id:pending[0].id,result:'first'})+'\\n';
            process.stdout.write(text.slice(0,9));setTimeout(()=>process.stdout.write(text.slice(9)),5);
          }
        }else if(m.method==='server-request')send({id:'approval-1',method:'session/request_permission',params:{sessionId:'native'}});
        else if(m.id==='approval-1')send({method:'session/update',params:{accepted:m.result}});
      });`);
    assert.deepEqual(await Promise.all([client.request('one'),client.request('two')]),['first','second']);
    const update=new Promise<unknown>(resolve=>client.onMessage(message=>{
      if(message.id==='approval-1')client.respond(message.id,{outcome:'selected'});
      if(message.method==='session/update')resolve(message.params);
    }));
    client.notify('server-request');assert.deepEqual(await update,{accepted:{outcome:'selected'}});
  });

  it('rejects an active unlimited prompt on process exit without exposing stderr',async()=>{
    const client=await start(`require('node:readline').createInterface({input:process.stdin}).on('line',()=>{process.stderr.write('Authorization: secret-test-token');process.exit(7)});`);
    await assert.rejects(client.request('session/prompt',{},0),error=>{
      assert.match(String(error),/code=7/);assert.doesNotMatch(String(error),/secret-test-token/);return true;
    });
    assert.equal(client.connected,false);
  });

  it('preserves RPC rejection codes and bounds ordinary requests, not active prompts',async()=>{
    const client=await start(`
      require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='unsupported')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'Missing method'}})+'\\n')});`,500);
    await assert.rejects(client.request('unsupported'),error=>error instanceof CursorAcpRpcError&&error.code===-32601);
    await assert.rejects(client.request('never-replied', {}, 30),/请求超时/);
    const prompt=client.request('session/prompt',{},0);
    const expected=assert.rejects(prompt,/连接已关闭/);
    await client.close();await expected;
  });

  it('fails explicitly for non-protocol stdout instead of hanging',async()=>{
    const client=await start(`require('node:readline').createInterface({input:process.stdin}).on('line',()=>process.stdout.write('not json\\n'));`);
    await assert.rejects(client.request('initialize'),/不是有效的 JSON-RPC/);
    assert.equal(client.connected,false);
  });

  it('does not resolve close until its own process has exited',async()=>{
    const client=await start(`
      process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),50));
      require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
        const m=JSON.parse(line);process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:process.pid})+'\\n');
      });`);
    const pid=await client.request<number>('pid');
    await client.close();
    assert.throws(()=>process.kill(pid,0),(error:NodeJS.ErrnoException)=>error.code==='ESRCH');
  });

});
