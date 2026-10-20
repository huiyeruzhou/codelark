import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createConfigService } from '../src/configuration/service.js';
import { AttachmentLarkClient } from '../src/testing/real-feishu/attachments.js';
import { parseClaudeLaunchSessionId } from '../src/runtime/claude/session-identity.js';
import { getSessionClaudeSessionId, getSessionTmuxSessionName } from '../src/domain/session-runtime.js';
import { listClaudeSessionJsonlFiles, summarizeClaudeSessionJsonl } from '../src/runtime/claude/session-jsonl.js';

const exec = promisify(execFile);
const value = (key: string, fallback = '') => { const i = process.argv.indexOf(key); return i < 0 ? fallback : process.argv[i + 1]!; };
if (process.argv.includes('--help')) {
  console.log('Usage: CODELARK_REAL_FEISHU_E2E=1 node --import tsx scripts/real-feishu-claude-binding.ts --test-home <dedicated CodeLark home> --profile <test app user profile> [--daemon dist/daemon.mjs] [--label fixed] [--output-dir work/report] [--upgrade-legacy]');
  console.log('Runs two real Claude/tmux processes and real Feishu groups; changes only competing JSONL mtime to expose incorrect latest-file discovery. Requires a separate configured test app, user IM authorization and native Claude/tmux. Deletes only this run’s test groups. Run against old and fixed daemon bundles; only a repeated binding plus user-read wrong output counts as the negative control.');
  process.exit(0);
}
assert.equal(process.env.CODELARK_REAL_FEISHU_E2E, '1', 'Real sends require CODELARK_REAL_FEISHU_E2E=1');
assert(process.platform !== 'win32', 'This native tmux scenario requires macOS or Linux');
assert(value('--test-home') && value('--profile'), '--test-home and --profile are required');
const testHome = path.resolve(value('--test-home'));
const profile = value('--profile');
const label = value('--label', 'fixed');
const upgradeLegacy = process.argv.includes('--upgrade-legacy');
assert(/^[a-zA-Z0-9_-]+$/.test(label), 'label must be a simple identifier');
const daemon = path.resolve(value('--daemon', 'dist/daemon.mjs'));
const runId = `${label}-${Date.now()}`;
const directory = path.resolve(value('--output-dir', path.join('work', `feishu-binding-${runId}`)));
const relativeOutput = path.relative(process.cwd(), directory);
assert(relativeOutput && !relativeOutput.startsWith('..') && !path.isAbsolute(relativeOutput), 'output must be inside this checkout for lark-cli request files');
const root = fs.mkdtempSync('/tmp/clk-bind-');
const home = path.join(root, 'bridge');
const runtimeHome = path.join(root, 'runtime');
const workspace = path.join(root, 'workspace');
const tmuxRoot = path.join(root, 'tmux');
for (const p of [directory, home, runtimeHome, workspace, tmuxRoot]) fs.mkdirSync(p, { recursive: true, mode: 0o700 });
const channel = 'feishu-binding-test';
const nonce = crypto.randomBytes(5).toString('hex');
const report: any = { runId, upgradeLegacy, daemon, directory, root, workspace, passed: false, stage: 'preflight', groups: [], requests: [], readbacks: [], cleanup: [],
  boundary: 'real user send -> Feishu WebSocket -> actual daemon -> real Claude/tmux -> automatic bot reply -> user_card_content readback',
  faultInjection: 'Only IFNAR2 JSONL mtime is held 2 seconds ahead during TNFA discovery. Contents, process identity, inputs and replies are never injected or rewritten.' };
const save = () => fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
const stage = (s: string) => { report.stage = s; save(); console.log(s); };
const lark = new AttachmentLarkClient(profile, path.join(directory, 'api'));
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
async function wait<T>(name: string, probe: () => Promise<T | undefined> | T | undefined, timeout = 80_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const r = await probe(); if (r !== undefined) return r; await pause(1200); }
  throw new Error(`Timeout: ${name}`);
}
const sessions = (): any[] => { try { return Object.values(JSON.parse(fs.readFileSync(path.join(home, 'data/sessions.json'), 'utf8'))); } catch { return []; } };
const sessionFor = (group: any) => sessions().find(s => s.id === group.sessionId);
const marker = (lane: string, round: number) => `ANSWER_${lane}_${nonce}_${round}`;
let child: ReturnType<typeof spawn> | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let lockPath = '';
let lockFd: number | undefined;
let server: http.Server | undefined;

async function main() {
  assert.equal(process.env.CODELARK_REAL_FEISHU_E2E, '1');
  const auth = await lark.cli(['auth', 'status']);
  const userId = auth.identities?.user?.openId || auth.identities?.user?.open_id;
  assert(auth.appId && userId && auth.identities.user.available, 'test profile user authorization required');
  const config = createConfigService({ codelarkHome: testHome, env: {}, migrate: false }).snapshot().config;
  const testChannel = config.channels.find(c => c.enabled && c.provider === 'feishu' && c.config.appId === auth.appId);
  assert(testChannel?.config.appSecret, 'configured test app required');
  const appId = String(testChannel.config.appId);
  const productionHome = process.env.CODELARK_HOME || path.join(os.homedir(), '.codelark');
  assert.notEqual(testHome, path.resolve(productionHome), 'test home must differ from production');
  const production = createConfigService({ codelarkHome: productionHome, env: {}, migrate: false }).snapshot().config;
  assert(!production.channels.some(c => c.config.appId === appId));
  const statusFile = path.join(testHome, 'runtime/status.json');
  const testStatus = fs.existsSync(statusFile) ? JSON.parse(fs.readFileSync(statusFile, 'utf8')) : {};
  if (testStatus.pid) { try { process.kill(testStatus.pid, 0); assert.fail('existing test Bridge PID is alive'); } catch (e: any) { if (e.code !== 'ESRCH') throw e; } }
  lockPath = path.join(os.tmpdir(), `clk-real-feishu-app-${crypto.createHash('sha256').update(`feishu:${appId}`).digest('hex').slice(0,16)}.lock`);
  if (fs.existsSync(lockPath)) { const old = JSON.parse(fs.readFileSync(lockPath,'utf8')); try { process.kill(old.pid, 0); assert.fail('test app lock is live'); } catch(e: any) { if(e.code !== 'ESRCH') throw e; fs.unlinkSync(lockPath); } }
  lockFd = fs.openSync(lockPath, 'wx', 0o600);
  fs.writeFileSync(lockFd, JSON.stringify({pid:process.pid, appId, codelarkHome:home, runId}));
  const bot = await lark.api('GET','/open-apis/bot/v3/info/', {as:'bot'});
  const botId = bot.bot?.open_id || bot.data?.bot?.open_id;
  assert(botId);
  report.userId = userId; report.appId = appId;
  report.daemonSha256 = crypto.createHash('sha256').update(fs.readFileSync(daemon)).digest('hex');
  report.nativeVersions = {
    claude: (await exec('claude', ['--version'], { env: { ...process.env, CLAUDE_CODE_SIMPLE: '1' }, timeout: 10_000 })).stdout.trim(),
    tmux: (await exec('tmux', ['-V'], { timeout: 10_000 })).stdout.trim(),
  };

  server = http.createServer((req,res) => {
    let raw=''; req.on('data', b=>raw+=b); req.on('end', () => {
      if(req.url?.includes('count_tokens')) { res.writeHead(200,{'content-type':'application/json'});res.end('{"input_tokens":1}');return; }
      if(!/\/messages(?:\?|$)/.test(req.url || '')) {res.writeHead(200,{'content-type':'application/json'});res.end('{}');return;}
      const body=JSON.parse(raw);
      const lastUser=JSON.stringify(body.messages?.filter((m:any)=>m.role==='user').at(-1)||{});
      const lane=lastUser.includes('LANE_TNFA')?'TNFA':lastUser.includes('LANE_IFNAR2')?'IFNAR2':'TITLE';
      const round=lastUser.includes('ROUND_2')?2:1;
      const text=marker(lane,round);
      report.requests.push({lane,round,model:body.model,at:Date.now()});save();
      const events=[{type:'message_start',message:{id:`msg_${crypto.randomUUID()}`,type:'message',role:'assistant',model:body.model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:1,output_tokens:0}}},
        {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
        {type:'content_block_delta',index:0,delta:{type:'text_delta',text}},
        {type:'content_block_stop',index:0},
        {type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:10}},{type:'message_stop'}];
      setTimeout(()=>{
        if(body.stream) {res.writeHead(200,{'content-type':'text/event-stream'});res.end(events.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));}
        else {res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id:'msg_fixture',type:'message',role:'assistant',model:body.model,content:[{type:'text',text}],stop_reason:'end_turn',usage:{input_tokens:1,output_tokens:10}}));}
      },lane==='IFNAR2'?3000:500);
    });
  });
  await new Promise<void>(resolve=>server!.listen(0,'127.0.0.1',resolve));
  const baseUrl=`http://127.0.0.1:${(server.address() as any).port}`;
  createConfigService({codelarkHome:home,env:{},migrate:false}).replace({kind:'home'}, {
    schemaVersion:2, bridge:{defaultWorkspace:workspace}, runtime:{agent:'claude',claude:{provider:'tmux',executable:'claude'}},
    channels:[{id:channel,provider:'feishu',alias:`Binding regression ${label}`,enabled:true,config:{...testChannel.config,requireMention:false,streamingEnabled:true,feedbackMarkdownEnabled:true,historyMessageLimit:20}}],
  });
  fs.writeFileSync(path.join(runtimeHome,'.claude.json'),JSON.stringify({numStartups:1,installMethod:'npm',theme:'light',hasCompletedOnboarding:true,lastOnboardingVersion:'2.0.0',hasIdeOnboardingBeenShown:{vscode:true}}),{mode:0o600});
  const env: NodeJS.ProcessEnv={...process.env,HOME:runtimeHome,USERPROFILE:runtimeHome,CODELARK_HOME:home,CODELARK_CLAUDE_HOME:runtimeHome,CODEX_HOME:path.join(root,'codex'),KIMI_CODE_HOME:path.join(root,'kimi'),CURSOR_CONFIG_DIR:path.join(root,'cursor'),CURSOR_DATA_DIR:path.join(root,'cursor-data'),
    TMUX_TMPDIR:tmuxRoot,ANTHROPIC_BASE_URL:baseUrl,ANTHROPIC_AUTH_TOKEN:'isolated-fixture-token',ANTHROPIC_API_KEY:'',CLAUDE_CODE_SIMPLE:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',
    CODELARK_CLAUDE_EXECUTABLE:'claude',CODELARK_CLAUDE_PROVIDER:'tmux',CODELARK_CLAUDE_TMUX_PROMPT_DELAY_MS:'0',CODELARK_DISABLE_DAILY_VERSION_CHECK:'1',CODELARK_CODEX_APP_SERVER:'0',CODELARK_CODEX_DESKTOP_REMOTE:'0',
    XDG_DATA_HOME:path.join(runtimeHome,'.local/share'),XDG_CONFIG_HOME:path.join(runtimeHome,'.config'),XDG_CACHE_HOME:path.join(runtimeHome,'.cache')};
  if (upgradeLegacy) { env.CLAUDECODE = '1'; env.CLAUDE_CODE_CHILD_SESSION = '1'; }
  for(const k of ['TMUX','TMUX_PANE','NODE_OPTIONS','LARKSUITE_CLI_CONFIG_DIR','LARK_CHANNEL','LARK_CHANNEL_HOME','LARK_CHANNEL_CONFIG','CODELARK_CODEX_APP_SERVER_URL','CODELARK_CLAUDE_CLI_PATH','CODELARK_TMUX_EXECUTABLE']) delete env[k];
  stage('create two real groups via product /new');
  for(const lane of ['IFNAR2','TNFA']) {
    const out=path.join(directory,`group-${lane}.json`);
    await exec(process.execPath,['--import','tsx','scripts/real-feishu-product-new-session.ts','--channel-type',channel,'--user-open-id',userId,'--group-name',`CodeLark 串群回归 ${label} ${lane} ${nonce}`,'--workdir',workspace,'--run-id',`${runId}-${lane}`,'--output',out],{env,timeout:120_000,maxBuffer:2*1024*1024}).catch((e:any)=>{
      fs.writeFileSync(path.join(directory,`group-${lane}-error.json`),JSON.stringify({code:e.code,signal:e.signal,killed:e.killed,stdout:e.stdout,stderr:e.stderr}));throw e;
    });
    const group={...JSON.parse(fs.readFileSync(out,'utf8')),lane};report.groups.push(group);save();
    await lark.api('GET',`/open-apis/im/v1/chats/${group.chatId}`);
  }
  stage('start isolated daemon');
  const log=fs.openSync(path.join(directory,'daemon.log'),'a');
  child=spawn(process.execPath,[daemon],{cwd:process.cwd(),env,stdio:['ignore',log,log]});fs.closeSync(log);
  report.daemonPid=child.pid;save();
  await wait('bridge ready',()=>{try{const s=JSON.parse(fs.readFileSync(path.join(home,'runtime/status.json'),'utf8'));return s.running && s.channels?.includes(channel)?true:undefined;}catch{return undefined;}});
  await pause(1800);
  const send = async (group:any,round:number) => {
    const r=await lark.api('POST','/open-apis/im/v1/messages',{params:{receive_id_type:'chat_id'},data:{receive_id:group.chatId,msg_type:'text',content:JSON.stringify({text:`<at user_id="${botId}">bot</at> LANE_${group.lane} ROUND_${round}. Reply with a short confirmation.`}),uuid:crypto.randomUUID()}});
    assert(r.data?.message_id);group.inputs??=[];group.inputs.push(r.data.message_id);save();
  };
  const readBot = async (group:any) => {
    const r=await lark.api('GET','/open-apis/im/v1/messages',{params:{container_id_type:'chat',container_id:group.chatId,page_size:50,sort_type:'ByCreateTimeDesc'}});
    const items=(r.data?.items||[]).filter((m:any)=>m.sender?.sender_type==='app' && m.sender?.id===appId);
    const actual=[];
    for(const m of items) actual.push(m.msg_type==='interactive'?await lark.read(m.message_id):m);
    fs.writeFileSync(path.join(directory,`readback-${group.lane}.json`),JSON.stringify(actual,null,2));return actual;
  };
  const answer = async (group:any,round:number) => wait(`user readback ${group.lane} round ${round}`,async()=>{
    const items=await readBot(group);const text=JSON.stringify(items);
    if(text.includes(marker(group.lane,round))) {report.readbacks.push({lane:group.lane,round,messageIds:items.map((i:any)=>i.message_id),userReadback:true});save();return items;}
    return undefined;
  });
  const [a,b]=report.groups;
  stage('IFNAR2 first input through real Feishu');await send(a,1);await answer(a,1);
  const aId=await wait('IFNAR2 bound identity',()=>getSessionClaudeSessionId(sessionFor(a)));
  const aFile=listClaudeSessionJsonlFiles(workspace,runtimeHome).find(f=>summarizeClaudeSessionJsonl(f)?.sessionId===aId);assert(aFile);
  stage('force competing IFNAR2 log newer during TNFA first input');
  const keepRecent=()=>{const d=new Date(Date.now()+2000);fs.utimesSync(aFile,d,d);};keepRecent();timer=setInterval(keepRecent,10);
  await send(b,1);
  const bId=await wait('TNFA bound identity',()=>getSessionClaudeSessionId(sessionFor(b)));
  clearInterval(timer);timer=undefined;
  report.bindings=report.groups.map((g:any)=>({lane:g.lane,bridgeSessionId:g.sessionId,claudeSessionId:getSessionClaudeSessionId(sessionFor(g)),tmuxSession:getSessionTmuxSessionName(sessionFor(g))}));save();
  assert.notEqual(report.bindings[0].tmuxSession,report.bindings[1].tmuxSession);
  if(aId===bId) {
    // Read actual wrong automatic output before failing, rather than accepting a timeout as the negative control.
    await wait('old daemon mirrored IFNAR2 into TNFA',async()=>{const items=await readBot(b);const wrong=JSON.stringify(items).includes(marker('IFNAR2',1));if(wrong){report.crossGroupOutput=true;save();return true;}return undefined;},30_000);
  }
  assert.notEqual(bId,aId,'REGRESSION: distinct tmux groups saved the same Claude identity');
  await answer(b,1);
  if (upgradeLegacy) {
    stage('restart bridge around real legacy windows with inherited child-session markers');
    child!.kill('SIGTERM');
    await wait('isolated daemon stopped', () => child!.exitCode !== null || child!.signalCode !== null ? true : undefined, 15_000);
    const socket = path.join(tmuxRoot, `tmux-${process.getuid?.()}`, 'default');
    assert(fs.statSync(socket).isSocket());
    const tmux = async (args: string[]) => (await exec('tmux', ['-S', socket, ...args], { env })).stdout;
    report.legacyWindows = [];
    for (const group of report.groups) {
      const session = sessionFor(group);
      const target = getSessionTmuxSessionName(session)!;
      const id = getSessionClaudeSessionId(session)!;
      // Resume via the CLI's own command, leaving pane_start_command in the old
      // no-ID launch shape. The real transcript and conversation are unchanged.
      await tmux(['respawn-pane', '-k', '-t', `${target}:0.0`, '-c', workspace,
        'env', '-u', 'CLAUDECODE', '-u', 'CLAUDE_CODE_CHILD_SESSION', 'claude', '--model', 'claude-sonnet-4-5']);
      await wait('legacy input ready', async () => {
        const screen = await tmux(['capture-pane', '-p', '-t', `${target}:0.0`, '-S', '-80']);
        return /❯/u.test(screen) && /for shortcuts/u.test(screen) ? true : undefined;
      }, 20_000);
      await tmux(['send-keys', '-t', `${target}:0.0`, '-l', `/resume ${id}`]);
      await tmux(['send-keys', '-t', `${target}:0.0`, 'Enter']);
      await wait('legacy original history restored', async () => {
        const screen = await tmux(['capture-pane', '-p', '-t', `${target}:0.0`, '-S', '-80']);
        fs.writeFileSync(path.join(directory, `legacy-${group.lane}.txt`), screen);
        return screen.includes(marker(group.lane, 1)) ? true : undefined;
      }, 20_000);
      const command = (await tmux(['display-message', '-p', '-t', `${target}:0.0`, '#{pane_start_command}'])).trim();
      assert(!/--(?:session-id|resume)\b/u.test(command));
      const pid = (await tmux(['display-message', '-p', '-t', `${target}:0.0`, '#{pane_pid}'])).trim();
      report.legacyWindows.push({ lane: group.lane, target, id, pid, command }); save();
    }
    const log = fs.openSync(path.join(directory, 'daemon.log'), 'a');
    child = spawn(process.execPath, [daemon], { cwd: process.cwd(), env, stdio: ['ignore', log, log] });
    fs.closeSync(log);
    await wait('restarted bridge ready', () => { try { const state = JSON.parse(fs.readFileSync(path.join(home, 'runtime/status.json'), 'utf8')); return state.running && state.channels?.includes(channel) && state.pid === child!.pid ? true : undefined; } catch { return undefined; } });
    await pause(1800);
  }
  stage('concurrent followups in both groups');
  await Promise.all(report.groups.map((g:any)=>send(g,2)));
  await Promise.all(report.groups.map((g:any)=>answer(g,2)));
  for(const g of report.groups) {
    const items=await readBot(g);const wrong=g.lane==='IFNAR2'?'TNFA':'IFNAR2';
    assert(!JSON.stringify(items).includes(`ANSWER_${wrong}_${nonce}`),'neighbor output leaked into real group');
    assert.equal(getSessionClaudeSessionId(sessionFor(g)),g.lane==='IFNAR2'?aId:bId,'followup changed process identity');
  }
  if (upgradeLegacy) {
    const log = fs.readFileSync(path.join(home, 'logs/bridge.log'), 'utf8');
    report.upgrades = log.split('\n').flatMap(line => { try { const entry = JSON.parse(line); return entry.event === 'tmux.provider.claude.existing.upgrade' ? [entry] : []; } catch { return []; } });
    assert.equal(report.upgrades.length, 2, 'each real inbound lane must upgrade exactly once');
    const socket = path.join(tmuxRoot, `tmux-${process.getuid?.()}`, 'default');
    assert(fs.statSync(socket).isSocket());
    for (const prior of report.legacyWindows) {
      const result = await exec('tmux', ['-S', socket, 'display-message', '-p', '-t', `${prior.target}:0.0`, '#{pane_pid}\t#{pane_start_command}'], { env });
      const [pid, ...command] = result.stdout.trim().split('\t');
      assert.notEqual(pid, prior.pid, 'the legacy process must be replaced');
      assert.equal(parseClaudeLaunchSessionId(command.join('\t')), prior.id);
      assert(report.upgrades.some((entry:any) => entry.tmux_session === prior.target));
    }
    for (const group of report.groups) {
      const id = getSessionClaudeSessionId(sessionFor(group))!;
      const file = listClaudeSessionJsonlFiles(workspace, runtimeHome).find(f => summarizeClaudeSessionJsonl(f)?.sessionId === id)!;
      const inputs = fs.readFileSync(file, 'utf8').split('\n').flatMap(line => { try { const r = JSON.parse(line); return r.type === 'user' ? [r] : []; } catch { return []; } });
      assert.equal(inputs.filter(r => JSON.stringify(r.message?.content).includes('ROUND_2')).length, 1, 'original real Feishu input must be sent once');
    }
  }
  report.jsonlFiles=listClaudeSessionJsonlFiles(workspace,runtimeHome).map(f=>({file:f,id:summarizeClaudeSessionJsonl(f)?.sessionId}));
  assert.equal(report.jsonlFiles.length,2);
  report.passed=true;stage('complete');
}
try {await main();} catch(e) {report.error=String(e);report.stack=e instanceof Error?e.stack:undefined;console.error(report.error);process.exitCode=1;}
finally {
  if(timer)clearInterval(timer);
  if(child && child.exitCode===null){child.kill('SIGTERM');await Promise.race([new Promise(r=>child!.once('exit',r)),pause(7000)]);if(child.exitCode===null)child.kill('SIGKILL');}
  const socket=path.join(tmuxRoot,`tmux-${process.getuid?.()}`, 'default');
  if(fs.existsSync(socket)&&fs.statSync(socket).isSocket()){
    const e={...process.env};delete e.TMUX;delete e.TMUX_PANE;
    const listed=await exec('tmux',['-S',socket,'list-sessions','-F','#{session_name}'],{env:e}).catch(()=>({stdout:''}));
    report.socketInventory=listed.stdout.trim().split('\n').filter(Boolean);
    const owned=new Set(sessions().map(getSessionTmuxSessionName).filter(Boolean));
    for(const name of report.socketInventory) if(owned.has(name)) await exec('tmux',['-S',socket,'kill-session','-t',name],{env:e}).catch(()=>{});
  }
  if(server)await new Promise<void>(r=>server!.close(()=>r()));
  // A group-create request may reach Feishu even if the helper subsequently
  // times out. Recover only this run's exact nonce/name and verified user owner.
  if (report.stage === 'create two real groups via product /new' && report.userId) {
    try {
      const found = await lark.cli(['im','+chat-search','--as','user','--query',nonce,'--is-manager','--disable-search-by-user','--page-size','100']);
      for(const c of found.data?.chats || []) {
        if(c.owner_id !== report.userId || !['IFNAR2','TNFA'].some(lane=>c.name?.endsWith(`CodeLark 串群回归 ${label} ${lane} ${nonce}`))) continue;
        if(!report.groups.some((g:any)=>g.chatId===c.chat_id)) report.groups.push({chatId:c.chat_id,recoveredAfterCreateTimeout:true});
      }
    } catch(e) { report.orphanSearchError=String(e); }
  }
  for(const g of report.groups){try{await lark.api('DELETE',`/open-apis/im/v1/chats/${g.chatId}`);report.cleanup.push({chatId:g.chatId,deleted:true});}catch(e){report.cleanup.push({chatId:g.chatId,deleted:false,error:String(e)});report.passed=false;process.exitCode=1;}}
  if(lockFd!==undefined){fs.closeSync(lockFd);fs.unlinkSync(lockPath);}
  save();console.log(JSON.stringify({report:path.join(directory,'report.json'),passed:report.passed,error:report.error,groups:report.groups.map((g:any)=>g.chatId),cleanup:report.cleanup}));
}
