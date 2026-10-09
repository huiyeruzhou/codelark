import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parse, tokenizer } from 'acorn';

const MAIN_CONTROL_DECLARATIONS = 'var sB,iB,aB,oB,cB,CL2readAction,CL3stopAction,mI,lB,oFe=';
const MODEL_MARKER = '__CODELARK_CURSOR_DESKTOP_MODELS_V4__';
const CONTROL_MARKER = '__CODELARK_CURSOR_DESKTOP_CONTROL_V3__';
const PATCH_MARKER = '__CODELARK_CURSOR_DESKTOP_REALTIME_V2__';
const DEFAULT_CURSOR_APP = '/Applications/Cursor.app';

export interface CursorDesktopPatchPaths {
  appPath: string;
  mainBundlePath: string;
  rendererBundlePath: string;
  glassBundlePath: string;
  productPath: string;
}

export interface CursorDesktopPatchResult {
  action: 'installed' | 'already-installed' | 'uninstalled' | 'not-installed';
  restartRequired?: boolean;
  appPath: string;
  appVersion: string;
  backupDirectory?: string;
  files: string[];
}

interface PatchManifest {
  schemaVersion: 1;
  marker: string;
  appPath: string;
  appVersion: string;
  installedAt: string;
  files: Array<{ path: string; backup: string; sha256: string; patchedSha256: string }>;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function replaceExactly(source: string, needle: string, replacement: string, label: string): string {
  const first = source.indexOf(needle);
  if (first < 0) throw new Error(`Cursor ${label} patch anchor 不存在；当前版本不受支持，未修改任何文件。`);
  if (source.indexOf(needle, first + needle.length) >= 0) {
    throw new Error(`Cursor ${label} patch anchor 不唯一；为避免损坏安装包，未修改任何文件。`);
  }
  return `${source.slice(0, first)}${replacement}${source.slice(first + needle.length)}`;
}

function assertJavaScript(source: string, label: string): void {
  try {
    parse(source, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true });
  } catch (error) {
    throw new Error(`Cursor ${label} patch 生成了无效 JavaScript：${error instanceof Error ? error.message : String(error)}`);
  }
}

export function resolveCursorDesktopPatchPaths(appPath = process.env.CURSOR_APP_PATH?.trim() || DEFAULT_CURSOR_APP): CursorDesktopPatchPaths {
  const resolved = path.resolve(appPath);
  const appRoot = path.join(resolved, 'Contents', 'Resources', 'app');
  return {
    appPath: resolved,
    mainBundlePath: path.join(appRoot, 'out', 'main.js'),
    rendererBundlePath: path.join(appRoot, 'out', 'vs', 'workbench', 'workbench.desktop.main.js'),
    glassBundlePath: path.join(appRoot, 'out', 'vs', 'workbench', 'workbench.glass.main.js'),
    productPath: path.join(appRoot, 'product.json'),
  };
}

function readAppVersion(paths: CursorDesktopPatchPaths): string {
  try {
    const product = JSON.parse(fs.readFileSync(paths.productPath, 'utf8')) as { version?: unknown };
    if (typeof product.version === 'string' && /^[\w.-]+$/.test(product.version)) return product.version;
  } catch {
    // A missing product version is still safe because every bundle anchor is verified.
  }
  return 'unknown';
}

const MAIN_PARSER_BEFORE = 'function P5e(e){return e===void 0||typeof e=="boolean"}function M5e(e){return new TextEncoder().encode(e).byteLength}function N5e(e){if(!(!aW(e)||typeof e.type!="string")){if(e.type==="listThreads")return{type:"listThreads"};if(!(e.type!=="sendMessage"||!iW(e.threadId)||typeof e.text!="string"||M5e(e.text)>HC||!P5e(e.force)))return{type:"sendMessage",threadId:e.threadId,text:e.text,...e.force===void 0?{}:{force:e.force}}}}';
const MAIN_PARSER_AFTER = `function P5e(e){return e===void 0||typeof e==="boolean"}function M5e(e){return new TextEncoder().encode(e).byteLength}function CL2delivery(e){return e==="queue"||e==="steer"||e==="force"}function N5e(e){if(!(!aW(e)||typeof e.type!=="string")){if(e.type==="listThreads")return{type:"listThreads"};if(e.type==="sendMessage"&&iW(e.threadId)&&typeof e.text==="string"&&M5e(e.text)<=HC&&P5e(e.force)&&(e.delivery===void 0||CL2delivery(e.delivery)))return{type:"sendMessage",threadId:e.threadId,text:e.text,...e.force===void 0?{}:{force:e.force},...e.delivery===void 0?{}:{delivery:e.delivery}};if(e.type==="readThreadEvents"&&iW(e.threadId)&&Number.isInteger(e.after)&&e.after>=0&&Number.isInteger(e.timeoutMs)&&e.timeoutMs>=0&&e.timeoutMs<=3e4)return{type:"readThreadEvents",threadId:e.threadId,after:e.after,timeoutMs:e.timeoutMs}}}`;

const MAIN_CONSTANTS_BEFORE = 'sB="cursor.desktopBridge.enabled",iB="cursor/desktopBridgeUserEnabled",aB="cursor.desktopBridge.rendererInvocationToken",oB="composer.desktopBridge.listThreads",cB="composer.desktopBridge.sendMessage",mI=';
const MAIN_CONSTANTS_AFTER = `sB="cursor.desktopBridge.enabled",iB="cursor/desktopBridgeUserEnabled",aB="cursor.desktopBridge.rendererInvocationToken",oB="composer.desktopBridge.listThreads",cB="composer.desktopBridge.sendMessage",CL2readAction="composer.desktopBridge.readThreadEvents",mI=`;

const MAIN_SEND_VALIDATOR_BEFORE = 'function pFe(e){if(!dB(e)||typeof e.outcome!="string")return!1;switch(e.outcome){case"submitted":case"queued":return typeof e.threadTitle=="string";case"not-found":return!0;case"not-sendable":return typeof e.reason=="string";case"error":return typeof e.message=="string";default:return!1}}';
const MAIN_SEND_VALIDATOR_AFTER = `function pFe(e){if(!dB(e)||typeof e.outcome!=="string")return!1;switch(e.outcome){case"submitted":case"queued":case"steered":return typeof e.threadTitle==="string";case"not-found":return!0;case"not-sendable":return typeof e.reason==="string";case"error":return typeof e.message==="string";default:return!1}}function CL2eventBatch(e){return dB(e)&&Number.isInteger(e.cursor)&&Array.isArray(e.events)}`;

const MAIN_PROTOCOL_BEFORE = 'oW=1,HC=256*1024';
const MAIN_PROTOCOL_AFTER = 'oW=2,HC=256*1024';

const MAIN_DISPATCH_BEFORE = 'case"sendMessage":return this.sendMessage(e);default:return e}}';
const MAIN_DISPATCH_AFTER = 'case"sendMessage":return this.sendMessage(e);case"readThreadEvents":return this.readThreadEvents(e);default:return e}}';

const MAIN_SEND_ARGS_BEFORE = 'threadId:e.threadId,text:e.text,force:e.force}),waitForResult:!0})';
const MAIN_SEND_ARGS_AFTER = 'threadId:e.threadId,text:e.text,force:e.force,delivery:e.delivery}),waitForResult:!0})';

const MAIN_SEND_RESULT_BEFORE = 'case"submitted":case"queued":return{status:r.outcome,threadId:e.threadId,windowId:n.id,threadTitle:r.threadTitle};';
const MAIN_SEND_RESULT_AFTER = 'case"submitted":case"queued":case"steered":return{status:r.outcome,threadId:e.threadId,windowId:n.id,threadTitle:r.threadTitle,requestedDelivery:r.requestedDelivery,actualDelivery:r.actualDelivery,warning:r.warning};';

const MAIN_METHOD_ANCHOR = '}return t??{status:"unknown-thread"}}closeServer(){';
const MAIN_METHOD_REPLACEMENT = `}return t??{status:"unknown-thread"}}async readThreadEvents(e){for(const t of this.orderedWindows())try{const n=await this.nativeHostMainService.runActionInWindow(void 0,{windowId:t.id,actionId:CL2readAction,args:this.bridgeActionArgs(t.id,{threadId:e.threadId,after:e.after,timeoutMs:e.timeoutMs}),waitForResult:!0});if(n===void 0)continue;if(CL2eventBatch(n))return n}catch(n){this.logService.warn(\`[desktop bridge] Failed to read events through window \${t.id}:\`,gc(n))}return{cursor:e.after,events:[]}}closeServer(){`;

function patchCursorMainRealtimeBundle(source: string): string {
  if (source.includes(PATCH_MARKER)) return source;
  let patched = replaceExactly(source, MAIN_PARSER_BEFORE, MAIN_PARSER_AFTER, 'main parser');
  patched = replaceExactly(patched, MAIN_CONSTANTS_BEFORE, MAIN_CONSTANTS_AFTER, 'main command constants');
  patched = replaceExactly(patched, MAIN_SEND_VALIDATOR_BEFORE, MAIN_SEND_VALIDATOR_AFTER, 'main send validator');
  patched = replaceExactly(patched, MAIN_PROTOCOL_BEFORE, MAIN_PROTOCOL_AFTER, 'main protocol version');
  patched = replaceExactly(patched, MAIN_DISPATCH_BEFORE, MAIN_DISPATCH_AFTER, 'main request dispatch');
  patched = replaceExactly(patched, MAIN_SEND_ARGS_BEFORE, MAIN_SEND_ARGS_AFTER, 'main send arguments');
  patched = replaceExactly(patched, MAIN_SEND_RESULT_BEFORE, MAIN_SEND_RESULT_AFTER, 'main send result');
  patched = replaceExactly(patched, MAIN_METHOD_ANCHOR, MAIN_METHOD_REPLACEMENT, 'main event method');
  return `${patched}\n/* ${PATCH_MARKER} */\n`;
}

const RENDERER_CONSTANTS_BEFORE = 'U6b="composer.desktopBridge.listThreads",$6b="composer.desktopBridge.sendMessage",H6b=';
const RENDERER_CONSTANTS_AFTER = `U6b="composer.desktopBridge.listThreads",$6b="composer.desktopBridge.sendMessage",CL2readAction="composer.desktopBridge.readThreadEvents",H6b=`;

const RENDERER_SEND_PARSE_BEFORE = 'const i=d9m({type:"sendMessage",threadId:e.threadId,text:e.text,force:e.force});if(i?.type==="sendMessage")return{...n,...i}}';
const RENDERER_SEND_PARSE_AFTER = 'const i=d9m({type:"sendMessage",threadId:e.threadId,text:e.text,force:e.force,delivery:e.delivery});if(i?.type==="sendMessage")return{...n,...i,delivery:e.delivery==="queue"||e.delivery==="steer"||e.delivery==="force"?e.delivery:e.force===!0?"force":"queue"}}';

const RENDERER_CLASS_START = 'Q6b=class extends at{constructor(){super({id:$6b,title:{value:"Send Desktop Bridge Message",original:"Send Desktop Bridge Message"}})}';
const RENDERER_CLASS_END = ',WUo=class extends ye{';

const RENDERER_REPLACEMENT = String.raw`Q6b=class extends at{constructor(){super({id:$6b,title:{value:"Send Desktop Bridge Message",original:"Send Desktop Bridge Message"}})}async run(e,t){const n=e.get(er),i=e.get(Rr),r=e.get(Cn);if(!uip(n,i,r))return{outcome:"error",message:"Desktop bridge is disabled."};const s=e.get(E_),o=e.get(Hs),a=e.get(NR),c=e.get(Fn),l=await q6b(t,r);if(!l)return{outcome:"error",message:"Invalid desktop bridge action arguments."};const u=s.getAgentHeader(l.threadId);if(u)return await this.sendThroughAgentRepository({args:l,agentHeader:u,agentRepositoryService:s,logService:c});if(n.isGlass)return{outcome:"not-found"};const h=o.allComposersData.allComposers.find(v=>v.composerId===l.threadId);if(!h)return{outcome:"not-found"};if(h.isDraft===!0||J7t(l.threadId))return{outcome:"not-sendable",reason:"Draft threads cannot accept messages."};const g=o.getHandleIfLoaded(l.threadId)??await o.getComposerHandleById(l.threadId),f=g?.data.status==="generating";if(f&&l.delivery==="steer")return{outcome:"not-sendable",reason:"This legacy Cursor composer does not expose steering."};try{g&&await a.submitChatMaybeAbortCurrent(l.threadId,l.text,{skipFocusAfterSubmission:!0,submitEventCtx:{source:"desktop_bridge"},...l.delivery==="force"?{ignoreQueuing:!0}:{}});return{outcome:f&&l.delivery!=="force"?"queued":"submitted",threadTitle:h.name||"New Agent",requestedDelivery:l.delivery,actualDelivery:f?l.delivery==="force"?"force":"queue":"submitted"}}catch(v){return HUo(c,v),{outcome:"error",message:v instanceof Error?v.message:String(v)}}}async sendThroughAgentRepository(e){const{args:t,agentHeader:n,agentRepositoryService:i,logService:r}=e;if(n.source==="draft")return{outcome:"not-sendable",reason:"Draft threads cannot accept messages."};if(n.source==="claude-code")return{outcome:"not-sendable",reason:"Claude Code threads cannot accept messages."};let s=i.getAgent(t.threadId),o=!1;try{s||(s=await i.loadAgent(t.threadId),o=!0);const a=n.status.value==="in_progress"||s.composerDataHandle.data.status==="generating",c=n.name.value||"New Agent";if(a&&t.delivery==="steer"&&!s.isQueueSteeringAvailable())return{outcome:"not-sendable",reason:"Cursor reports that steering is unavailable for the active turn."};const l=new Set(s.getQueueItems().map(v=>v.id));await s.submitMessage(t.text,{skipFocusAfterSubmission:!0,submitEventCtx:{source:"desktop_bridge"},...t.delivery==="force"?{forceSubmit:!0}:{}});if(!a)return{outcome:"submitted",threadTitle:c,requestedDelivery:t.delivery,actualDelivery:"submitted"};if(t.delivery!=="steer")return{outcome:t.delivery==="force"?"submitted":"queued",threadTitle:c,requestedDelivery:t.delivery,actualDelivery:t.delivery==="force"?"force":"queue"};const u=s.getQueueItems().find(v=>!l.has(v.id));if(!u)return{outcome:"queued",threadTitle:c,requestedDelivery:"steer",actualDelivery:"queue",warning:"Cursor accepted the follow-up but did not expose its queue item for steering."};const h=await s.promoteQueueItemToSteer(u.id);return h?{outcome:"steered",threadTitle:c,requestedDelivery:"steer",actualDelivery:"steer"}:{outcome:"queued",threadTitle:c,requestedDelivery:"steer",actualDelivery:"queue",warning:"Cursor rejected steer promotion; the message remains queued."}}catch(a){return HUo(r,a),{outcome:"error",message:a instanceof Error?a.message:String(a)}}finally{o&&s?.dispose()}}};
var CL2eventStates=new Map;
function CL2safe(e,t=0,n=new WeakSet){if(e==null||typeof e==="boolean"||typeof e==="number")return e;if(typeof e==="string")return e.length>65536?e.slice(0,65536)+"…":e;if(typeof e==="bigint")return e.toString();if(typeof e!=="object")return String(e);if(t>=7)return"[depth-limit]";if(n.has(e))return"[circular]";n.add(e);try{if(Array.isArray(e))return e.slice(-128).map(i=>CL2safe(i,t+1,n));const i={};let r=0;for(const[s,o]of Object.entries(e)){if(++r>80){i.__truncated__=!0;break}if(typeof o!=="function")i[s]=CL2safe(o,t+1,n)}return i}finally{n.delete(e)}}
function CL2snapshot(e){const t=e.data,n=(t.fullConversationHeadersOnly??[]).slice(-80),i=t.conversationMap??{},r=n.map(s=>({id:s.bubbleId,header:CL2safe(s),body:CL2safe(i[s.bubbleId])}));return{status:t.status,generationId:t.chatGenerationUUID??t.latestChatGenerationUUID,model:t.modelConfig?.modelName,messages:r,queueItems:CL2safe(t.queueItems??[])}}
function CL2ensureState(e,t,n,i){const r=CL2eventStates.get(e);if(r&&r.handle===t)return r;r?.dispose?.();const s={handle:t,cursor:0,events:[],waiters:new Set,dispose:void 0},o=(a,c={})=>{const l={sequence:++s.cursor,type:a,threadId:e,generationId:t.data.chatGenerationUUID??t.data.latestChatGenerationUUID,status:t.data.status,model:t.data.modelConfig?.modelName,timestamp:Date.now(),...c};s.events.push(l),s.events.length>256&&s.events.splice(0,s.events.length-256);for(const u of s.waiters)u();s.waiters.clear()},a=n.onChangeEffectManuallyDisposed({deps:[()=>JSON.stringify(CL2snapshot(t))],onChange:({deps:[c]})=>{try{o("snapshot",{snapshot:JSON.parse(c)})}catch(l){o("error",{message:l instanceof Error?l.message:String(l)})}},runNowToo:!0}),c=i.onDidFinishStreamChat(l=>{l.composerId===e&&o("finished",{generationId:l.generationUUID})}),l=i.onDidComposerStopGenerating(u=>{u.composerId===e&&o("stopped")});return s.dispose=()=>{a.dispose(),c.dispose(),l.dispose()},s.read=(u,h)=>{const m=()=>({cursor:s.cursor,events:s.events.filter(g=>g.sequence>u)});if(s.cursor>u)return Promise.resolve(m());return new Promise(g=>{let f;const v=()=>{clearTimeout(f),s.waiters.delete(v),g(m())};s.waiters.add(v),f=setTimeout(v,h)})},CL2eventStates.set(e,s),s}
var CL2ReadAction=class extends at{constructor(){super({id:CL2readAction,title:{value:"Read Desktop Bridge Thread Events",original:"Read Desktop Bridge Thread Events"}})}async run(e,t){const n=e.get(er),i=e.get(Rr),r=e.get(Cn);if(!uip(n,i,r))return{cursor:t?.after??0,events:[]};const s=await dip(t,r);if(!s||!$Uo(t)||typeof t.threadId!=="string"||!Number.isInteger(t.after)||!Number.isInteger(t.timeoutMs))return{cursor:0,events:[]};const o=e.get(E_),a=e.get(Hs),c=e.get(uo),l=e.get(Ty);let u=o.getAgent(t.threadId),h=u?.composerDataHandle;if(!h&&!n.isGlass){h=a.getHandleIfLoaded(t.threadId)??await a.getComposerHandleById(t.threadId)}if(!h)return{cursor:t.after,events:[]};return CL2ensureState(t.threadId,h,c,l).read(t.after,t.timeoutMs)}}`;

function patchCursorRendererRealtimeBundle(source: string): string {
  if (source.includes(PATCH_MARKER)) return source;
  let patched = replaceExactly(source, RENDERER_CONSTANTS_BEFORE, RENDERER_CONSTANTS_AFTER, 'renderer command constants');
  patched = replaceExactly(patched, RENDERER_SEND_PARSE_BEFORE, RENDERER_SEND_PARSE_AFTER, 'renderer send parser');
  const start = patched.indexOf(RENDERER_CLASS_START);
  if (start < 0) throw new Error('Cursor renderer send class patch anchor 不存在；当前版本不受支持，未修改任何文件。');
  const end = patched.indexOf(RENDERER_CLASS_END, start);
  if (end < 0 || patched.indexOf(RENDERER_CLASS_START, start + 1) >= 0) {
    throw new Error('Cursor renderer send class patch boundary 无效；为避免损坏安装包，未修改任何文件。');
  }
  patched = `${patched.slice(0, start)}${RENDERER_REPLACEMENT}${patched.slice(end)}`;
  patched = replaceExactly(patched, 'We(Z6b),We(Q6b),Zr(', 'We(Z6b),We(Q6b),We(CL2ReadAction),Zr(', 'renderer command registration');
  return `${patched}\n/* ${PATCH_MARKER} */\n`;
}

// Layer the control protocol on top of v2 so existing patched installations can
// upgrade without discarding their original backup or silently skipping Stop.
function patchCursorMainControlBundle(source: string): string {
  if (source.includes(CONTROL_MARKER)) {
    return source.includes(MAIN_CONTROL_DECLARATIONS) ? source : replaceExactly(source,
      'var sB,iB,aB,oB,cB,mI,lB,oFe=', MAIN_CONTROL_DECLARATIONS, 'main control declarations repair');
  }
  let patched = patchCursorMainRealtimeBundle(source);
  patched = replaceExactly(patched, 'var sB,iB,aB,oB,cB,mI,lB,oFe=',
    MAIN_CONTROL_DECLARATIONS, 'main control declarations');
  patched = replaceExactly(patched, 'oW=2,HC=', 'oW=3,HC=', 'control protocol version');
  patched = replaceExactly(patched, 'if(e.type==="readThreadEvents"',
    'if(e.type==="stopThread"&&iW(e.threadId))return{type:"stopThread",threadId:e.threadId};if(e.type==="readThreadEvents"', 'stop parser');
  patched = replaceExactly(patched, 'CL2readAction="composer.desktopBridge.readThreadEvents",',
    'CL2readAction="composer.desktopBridge.readThreadEvents",CL3stopAction="composer.desktopBridge.stopThread",', 'stop action constant');
  patched = replaceExactly(patched, 'case"readThreadEvents":return this.readThreadEvents(e);',
    'case"stopThread":return this.stopThread(e);case"readThreadEvents":return this.readThreadEvents(e);', 'stop dispatch');
  patched = replaceExactly(patched, 'async readThreadEvents(e){', `async stopThread(e){for(const t of this.orderedWindows()){try{const n=await this.nativeHostMainService.runActionInWindow(void 0,{windowId:t.id,actionId:CL3stopAction,args:this.bridgeActionArgs(t.id,{threadId:e.threadId}),waitForResult:!0});if(n===void 0||n?.outcome==="not-found")continue;if(n?.outcome==="interrupt-requested"||n?.outcome==="idle")return{status:n.outcome,threadId:e.threadId,windowId:t.id};return{status:"error",message:n?.message??"Invalid stop acknowledgement"}}catch(n){return{status:"error",message:gc(n)}}}return{status:"unknown-thread"}}async readThreadEvents(e){`, 'stop method');
  return `${patched}\n/* ${CONTROL_MARKER} */\n`;
}

const RENDERER_STOP_ACTION = String.raw`var CL3StopAction=class extends at {
  constructor(){super({id:CL3stopAction,title:{value:"Stop Desktop Bridge Thread",original:"Stop Desktop Bridge Thread"}})}
  async run(e,t){
    const n=e.get(er),i=e.get(Rr),r=e.get(Cn);
    if(!uip(n,i,r))return{outcome:"error",message:"Desktop bridge is disabled."};
    if(!await dip(t,r)||!$Uo(t)||typeof t.threadId!=="string")return{outcome:"error",message:"Invalid stop arguments."};
    const repository=e.get(E_),header=repository.getAgentHeader(t.threadId);
    if(!header)return{outcome:"not-found"};
    if(header.source==="draft"||header.source==="claude-code")return{outcome:"error",message:"This thread does not support Desktop Stop."};
    let agent=repository.getAgent(t.threadId),loaded=false;
    try{
      if(!agent){agent=await repository.loadAgent(t.threadId);loaded=true}
      const data=agent.composerDataHandle.data;
      if(header.status.value!=="in_progress"&&data.status!=="generating"&&!data.chatGenerationUUID)return{outcome:"idle"};
      await agent.desktopBridgeAbortChat();
      return{outcome:"interrupt-requested"};
    }catch(error){return{outcome:"error",message:error instanceof Error?error.message:String(error)}}
    finally{if(loaded)agent?.dispose()}
  }
};`;

function patchCursorRendererControlBundle(source: string): string {
  if (source.includes(CONTROL_MARKER)) return source;
  let patched = patchCursorRendererRealtimeBundle(source);
  patched = replaceExactly(patched, 'CL2readAction="composer.desktopBridge.readThreadEvents",',
    'CL2readAction="composer.desktopBridge.readThreadEvents",CL3stopAction="composer.desktopBridge.stopThread",', 'renderer stop constant');
  patched = replaceExactly(patched, 'abortChat(){this._withLiveAgentSync("abortChat",e=>e.abortChat())}',
    'abortChat(){this._withLiveAgentSync("abortChat",e=>e.abortChat())}async desktopBridgeAbortChat(){return this._withLiveAgent("desktopBridgeAbortChat",async e=>{if(typeof e.abortChatAndWait!=="function")throw new Error("Native agent does not support awaited Stop");await e.abortChatAndWait()})}', 'renderer awaited stop');
  patched = replaceExactly(patched, 'var CL2ReadAction=', `${RENDERER_STOP_ACTION}\nvar CL2ReadAction=`, 'renderer stop handler');
  patched = replaceExactly(patched, 'We(CL2ReadAction),', 'We(CL2ReadAction),We(CL3StopAction),', 'renderer stop registration');
  return `${patched}\n/* ${CONTROL_MARKER} */\n`;
}

// Glass and Desktop ship separate bundles with different minified service IDs.
// Reuse the control implementation; translate identifier tokens, never strings.
const GLASS_IDENTIFIERS: Record<string, string> = {
  Q6b: 'DwC', at: 'en', $6b: 'SwC', er: 'Ss', Rr: 'gr', Cn: 'fi',
  uip: 'KNv', E_: 'Ha', Hs: 'no', NR: 'Mw', Fn: 'Ii', q6b: 'xwC',
  J7t: '_Re', HUo: 'Eoc', uo: 'Go', Ty: 'Gb', dip: 'YNv', $Uo: 'Toc',
  wS: 'Gm', ow: 'q_', Z2: 'OR',
};
function glassIdentifiers(source: string): string {
  const replacements: Array<{ start: number; end: number; value: string }> = [];
  for (const token of tokenizer(source, { ecmaVersion: 'latest' })) {
    const identifier = source.slice(token.start, token.end);
    if (token.type.label === 'name' && Object.hasOwn(GLASS_IDENTIFIERS, identifier)) {
      replacements.push({ start: token.start, end: token.end, value: GLASS_IDENTIFIERS[identifier] });
    }
  }
  for (const token of replacements.reverse()) source = source.slice(0, token.start) + token.value + source.slice(token.end);
  return source;
}

function patchCursorGlassControlBundle(source: string): string {
  if (source.includes(CONTROL_MARKER)) return source;
  let patched = replaceExactly(source, 'SwC="composer.desktopBridge.sendMessage",',
    'SwC="composer.desktopBridge.sendMessage",CL2readAction="composer.desktopBridge.readThreadEvents",CL3stopAction="composer.desktopBridge.stopThread",', 'glass control constants');
  patched = replaceExactly(patched,
    'const i=En_({type:"sendMessage",threadId:t.threadId,text:t.text,force:t.force});if(i?.type==="sendMessage")return{...n,...i}}',
    'const i=En_({type:"sendMessage",threadId:t.threadId,text:t.text,force:t.force});if(i?.type==="sendMessage")return{...n,...i,delivery:t.delivery==="queue"||t.delivery==="steer"||t.delivery==="force"?t.delivery:t.force===!0?"force":"steer"}}', 'glass delivery parser');
  const startAnchor = glassIdentifiers(RENDERER_CLASS_START);
  const start = patched.indexOf(startAnchor);
  const end = patched.indexOf(',xoc=class extends rt{', start);
  if (start < 0 || end < 0 || patched.indexOf(startAnchor, start + 1) >= 0) throw new Error('Cursor Glass control class anchors do not match; no files were modified.');
  patched = patched.slice(0, start) + glassIdentifiers(RENDERER_REPLACEMENT)
    + ';' + glassIdentifiers(RENDERER_STOP_ACTION).replace(/;$/, '') + patched.slice(end);
  patched = replaceExactly(patched, 'Lt(MwC),Lt(DwC),', 'Lt(MwC),Lt(DwC),Lt(CL2ReadAction),Lt(CL3StopAction),', 'glass control registration');
  patched = replaceExactly(patched, 'abortChat(){this._withLiveAgentSync("abortChat",t=>t.abortChat())}',
    'abortChat(){this._withLiveAgentSync("abortChat",t=>t.abortChat())}async desktopBridgeAbortChat(){return this._withLiveAgent("desktopBridgeAbortChat",async e=>{if(typeof e.abortChatAndWait!=="function")throw new Error("Native agent does not support awaited Stop");await e.abortChatAndWait()})}', 'glass awaited stop');
  return `${patched}\n/* ${CONTROL_MARKER} */\n`;
}


// Model control shares Cursor's own UI catalogue, policy checks and composer
// setter. No global preferences, CLI config, or prompt submission is involved.
const RENDERER_MODEL_ACTION = String.raw`var CL4ModelAction=class extends at {
  constructor(){super({id:"composer.desktopBridge.model",title:{value:"Desktop Bridge Models",original:"Desktop Bridge Models"}})}
  async run(e,t){
    const env=e.get(er),flags=e.get(Rr),storage=e.get(Cn),repository=e.get(E_),modelConfig=e.get(wS),settings=e.get(Z2),admin=e.get(ow);
    if(!uip(env,flags,storage)||!await dip(t,storage)||!$Uo(t)||typeof t.threadId!=="string"
      ||!["getThreadModels","setThreadModel"].includes(t.type)
      ||t.type==="setThreadModel"&&(typeof t.model!=="string"||!t.model.trim()||t.model.length>256))return{outcome:"error",message:"Invalid model control arguments."};
    const header=repository.getAgentHeader(t.threadId);
    if(!header)return{outcome:"not-found"};
    if(header.source==="draft"||header.source==="claude-code")return{outcome:"error",message:"This thread does not support Desktop model control."};
    let agent,owned=false;
    try{
      await admin.forceRefresh();
      agent=repository.getAgent(t.threadId);if(!agent){agent=await repository.loadAgent(t.threadId);owned=true}
      const handle=agent.composerDataHandle,surface=handle.data.unifiedMode==="background"?"background-composer":"composer";
      const available=settings.getAvailableModelsWithStatus({specificModelField:surface,filterBlockedModels:true});
      const models=available.filter(m=>typeof m.name==="string"&&!admin.isModelBlocked(m.name)).map(m=>({id:m.name,name:m.clientDisplayName||m.name}));
      const selection=()=>modelConfig.getSelectedModelsForComposer(handle).map(m=>m.modelId);
      if(t.type==="setThreadModel"){
        const canonical=modelConfig.resolveModelNameToCatalog(t.model);
        if(admin.isModelBlocked(t.model)||!models.some(m=>m.id===canonical))return{outcome:"error",message:"Model is unavailable in Cursor's model picker or disabled by your administrator: "+t.model};
        modelConfig.setModelConfigForComposer(handle,{modelName:t.model});
        const selected=selection();
        if(selected.length!==1||selected[0]!==canonical)return{outcome:"error",message:"Cursor did not confirm the requested model; current selection: "+selected.join(", ")};
      }
      return{outcome:"models",threadId:t.threadId,models,selectedModels:selection(),running:header.status.value==="in_progress"||handle.data.status==="generating"};
    }catch(error){return{outcome:"error",message:error instanceof Error?error.message:String(error)}}finally{if(owned)agent?.dispose()}
  }
};`;

export function patchCursorMainBundle(source: string): string {
  let patched = patchCursorMainControlBundle(source);
  if (patched.includes(MODEL_MARKER)) return patched;
  patched = replaceExactly(patched, 'oW=3,HC=', 'oW=4,HC=', 'model protocol version');
  patched = replaceExactly(patched, 'if(e.type==="stopThread"',
    'if(e.type==="getThreadModels"&&iW(e.threadId))return{type:e.type,threadId:e.threadId};if(e.type==="setThreadModel"&&iW(e.threadId)&&typeof e.model==="string"&&e.model.trim().length>0&&e.model.length<=256)return{type:e.type,threadId:e.threadId,model:e.model.trim()};if(e.type==="stopThread"', 'model parser');
  patched = replaceExactly(patched, 'case"stopThread":return this.stopThread(e);',
    'case"getThreadModels":case"setThreadModel":return this.threadModels(e);case"stopThread":return this.stopThread(e);', 'model dispatch');
  patched = replaceExactly(patched, 'async stopThread(e){', String.raw`async threadModels(e){for(const window of this.orderedWindows()){try{const result=await this.nativeHostMainService.runActionInWindow(void 0,{windowId:window.id,actionId:"composer.desktopBridge.model",args:this.bridgeActionArgs(window.id,e),waitForResult:!0});if(result===void 0||result?.outcome==="not-found")continue;if(result?.outcome==="models"&&result.threadId===e.threadId&&Array.isArray(result.models)&&Array.isArray(result.selectedModels))return{status:"models",threadId:e.threadId,windowId:window.id,models:result.models,selectedModels:result.selectedModels,running:result.running};return{status:"error",message:result?.message??"Invalid model acknowledgement"}}catch(error){return{status:"error",message:error instanceof Error?error.message:String(error)}}}return{status:"unknown-thread"}}async stopThread(e){`, 'model method');
  patched = replaceExactly(patched, 'catch(n){return{status:"error",message:gc(n)}}',
    'catch(n){return{status:"error",message:n instanceof Error?n.message:String(n)}}', 'native Stop error detail');
  const eventFailure = 'catch(n){this.logService.warn(`[desktop bridge] Failed to read events through window ${t.id}:`,gc(n))}';
  if (patched.includes(eventFailure)) patched = replaceExactly(patched, eventFailure,
    'catch(n){return{status:"error",message:n instanceof Error?n.message:String(n)}}', 'event error propagation');
  return `${patched}\n/* ${MODEL_MARKER} */\n`;
}

function repairRendererNativeContracts(source: string, glass = false): string {
  const changes: Array<[string, string]> = [
  [
    "const n=e.get(er),i=e.get(Rr),r=e.get(Cn);if(!uip(n,i,r))return{cursor:t?.after??0,events:[]};",
    "const n=e.get(er),i=e.get(Rr),r=e.get(Cn),o=e.get(E_),a=e.get(Hs),c=e.get(uo),l=e.get(Ty);if(!uip(n,i,r))return{cursor:t?.after??0,events:[]};"
  ],
  [
    "const o=e.get(E_),a=e.get(Hs),c=e.get(uo),l=e.get(Ty);let u=o.getAgent",
    "let u=o.getAgent"
  ],
  [
    "const n=e.get(er),i=e.get(Rr),r=e.get(Cn);\n    if(!uip(n,i,r))return{outcome:\"error\",message:\"Desktop bridge is disabled.\"};",
    "const n=e.get(er),i=e.get(Rr),r=e.get(Cn),repository=e.get(E_);\n    if(!uip(n,i,r))return{outcome:\"error\",message:\"Desktop bridge is disabled.\"};"
  ],
  [
    "const repository=e.get(E_),header=repository.getAgentHeader(t.threadId);",
    "const header=repository.getAgentHeader(t.threadId);"
  ],
  [
    "const h=await s.promoteQueueItemToSteer(u.id);return h?{outcome:\"steered\",threadTitle:c,requestedDelivery:\"steer\",actualDelivery:\"steer\"}:{outcome:\"queued\",threadTitle:c,requestedDelivery:\"steer\",actualDelivery:\"queue\",warning:\"Cursor rejected steer promotion; the message remains queued.\"}",
    "const result=(item)=>item?.delivery?.kind===\"steer\"?{outcome:\"steered\",threadTitle:c,requestedDelivery:\"steer\",actualDelivery:\"steer\"}:item?.delivery?{outcome:\"submitted\",threadTitle:c,requestedDelivery:\"steer\",actualDelivery:\"submitted\",warning:\"Cursor 已接收追加消息，正在确认原生投递状态；请勿重复发送。\"}:void 0;const existing=result(u);if(existing)return existing;const h=await s.promoteQueueItemToSteer(u.id),current=s.getQueueItems().find(v=>v.id===u.id),observed=result(current);if(observed)return observed;if(!current&&h)return{outcome:\"steered\",threadTitle:c,requestedDelivery:\"steer\",actualDelivery:\"steer\"};return current?{outcome:\"queued\",threadTitle:c,requestedDelivery:\"steer\",actualDelivery:\"queue\",warning:\"Cursor 当前仍将该消息列为普通排队消息。\"}:{outcome:\"submitted\",threadTitle:c,requestedDelivery:\"steer\",actualDelivery:\"submitted\",warning:\"Cursor 已接收消息，队列条目已消失；无法确认投递方式，请查看目标对话，勿重发。\"}"
  ],
  [
    "if(!u)return{outcome:\"queued\",threadTitle:c,requestedDelivery:\"steer\",actualDelivery:\"queue\",warning:\"Cursor accepted the follow-up but did not expose its queue item for steering.\"};",
    "if(!u)return{outcome:\"submitted\",threadTitle:c,requestedDelivery:\"steer\",actualDelivery:\"submitted\",warning:\"Cursor 已接收消息，未返回对应队列条目；无法确认投递方式，请查看目标对话，勿重发。\"};"
  ]
];
  for (const [before, after] of changes) {
    const needle = glass ? glassIdentifiers(before) : before;
    // Minimal test fixtures and future already-repaired bundles can omit old actions.
    if (source.includes(needle)) source = replaceExactly(source, needle, glass ? glassIdentifiers(after) : after, "native action contract");
  }
  return source;
}

export function patchCursorRendererBundle(source: string): string {
  let patched = repairRendererNativeContracts(patchCursorRendererControlBundle(source));
  if (patched.includes(MODEL_MARKER)) return patched;
  patched = replaceExactly(patched, 'var CL3StopAction=', `${RENDERER_MODEL_ACTION}\nvar CL3StopAction=`, 'renderer model action');
  patched = replaceExactly(patched, 'We(CL3StopAction),', 'We(CL3StopAction),We(CL4ModelAction),', 'renderer model registration');
  return `${patched}\n/* ${MODEL_MARKER} */\n`;
}

export function patchCursorGlassRendererBundle(source: string): string {
  let patched = repairRendererNativeContracts(patchCursorGlassControlBundle(source), true);
  if (patched.includes(MODEL_MARKER)) return patched;
  patched = replaceExactly(patched, 'var CL3StopAction=', `${glassIdentifiers(RENDERER_MODEL_ACTION)}\nvar CL3StopAction=`, 'glass model action');
  patched = replaceExactly(patched, 'Lt(CL3StopAction),', 'Lt(CL3StopAction),Lt(CL4ModelAction),', 'glass model registration');
  return `${patched}\n/* ${MODEL_MARKER} */\n`;
}

function backupRoot(appVersion: string): string {
  const configured = process.env.CODELARK_HOME?.trim();
  const home = configured ? path.resolve(configured) : path.join(os.homedir(), '.codelark');
  return path.join(home, 'backups', 'cursor-desktop', appVersion);
}

function writeAtomic(filePath: string, content: string, mode: number): void {
  const temp = `${filePath}.codelark-${process.pid}-${Date.now()}.tmp`;
  fs.writeFileSync(temp, content, { encoding: 'utf8', mode });
  try {
    fs.renameSync(temp, filePath);
    fs.chmodSync(filePath, mode);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch { /* best effort */ }
    throw error;
  }
}

export function installCursorDesktopRealtimePatch(
  appPath?: string,
  options: { allowAppModification?: boolean } = {},
): CursorDesktopPatchResult {
  if (!options.allowAppModification) {
    throw new Error('这是修改 Cursor.app 安装文件的实验性可选补丁。普通消息收发不依赖它；明确选择后使用 install --allow-app-modification。');
  }
  const paths = resolveCursorDesktopPatchPaths(appPath);
  const appVersion = readAppVersion(paths);
  for (const file of patchFiles(paths)) {
    if (!fs.lstatSync(file).isFile()) throw new Error(`拒绝修改非普通文件：${file}`);
  }
  const originalMain = fs.readFileSync(paths.mainBundlePath, 'utf8');
  const originalRenderer = fs.readFileSync(paths.rendererBundlePath, 'utf8');
  const originalGlass = fs.readFileSync(paths.glassBundlePath, 'utf8');
  if (originalMain.includes(MODEL_MARKER) && originalRenderer.includes(MODEL_MARKER)
    && originalMain.includes(MAIN_CONTROL_DECLARATIONS) && originalGlass.includes(MODEL_MARKER)) {
    return { action: 'already-installed', appPath: paths.appPath, appVersion, files: [paths.mainBundlePath, paths.rendererBundlePath, paths.glassBundlePath] };
  }
  if (originalMain.includes(PATCH_MARKER) !== originalRenderer.includes(PATCH_MARKER)
    || originalMain.includes(CONTROL_MARKER) !== originalRenderer.includes(CONTROL_MARKER)) {
    throw new Error('Cursor realtime patch 处于半安装状态；请先 restore，再重新安装。');
  }
  // Never stack an upgrade on an installation we cannot fully uninstall.
  restorePlan(paths, appVersion);
  const patchedMain = patchCursorMainBundle(originalMain);
  const patchedRenderer = patchCursorRendererBundle(originalRenderer);
  const patchedGlass = patchCursorGlassRendererBundle(originalGlass);
  assertJavaScript(patchedMain, 'main');
  assertJavaScript(patchedRenderer, 'renderer');
  assertJavaScript(patchedGlass, 'glass');

  const backupDirectory = path.join(backupRoot(appVersion), `${Date.now()}-${sha256(originalMain).slice(0, 12)}`);
  fs.mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
  const entries = [
    { path: paths.mainBundlePath, original: originalMain, patched: patchedMain, backup: path.join(backupDirectory, 'main.js') },
    { path: paths.rendererBundlePath, original: originalRenderer, patched: patchedRenderer, backup: path.join(backupDirectory, 'workbench.desktop.main.js') },
    { path: paths.glassBundlePath, original: originalGlass, patched: patchedGlass, backup: path.join(backupDirectory, 'workbench.glass.main.js') },
  ];
  for (const entry of entries) {
    fs.copyFileSync(entry.path, entry.backup, fs.constants.COPYFILE_EXCL);
    if (sha256(fs.readFileSync(entry.backup)) !== sha256(entry.original)) {
      throw new Error('备份期间 Cursor 文件发生变化；未修改应用，请重新检查。');
    }
  }
  const manifest: PatchManifest = {
    schemaVersion: 1,
    marker: MODEL_MARKER,
    appPath: paths.appPath,
    appVersion,
    installedAt: new Date().toISOString(),
    files: entries.map((entry) => ({
      path: entry.path,
      backup: entry.backup,
      sha256: sha256(entry.original),
      patchedSha256: sha256(entry.patched),
    })),
  };
  fs.writeFileSync(path.join(backupDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  try {
    for (const entry of entries) writeAtomic(entry.path, entry.patched, fs.statSync(entry.path).mode & 0o777);
  } catch (error) {
    for (const entry of entries) {
      try { fs.copyFileSync(entry.backup, entry.path); } catch { /* retain backups for manual recovery */ }
    }
    throw error;
  }
  return { action: 'installed', restartRequired: true, appPath: paths.appPath, appVersion, backupDirectory, files: entries.map((entry) => entry.path) };
}

interface VerifiedManifest {
  directory: string;
  manifest: PatchManifest;
}

function patchFiles(paths: CursorDesktopPatchPaths): string[] {
  return [paths.mainBundlePath, paths.rendererBundlePath, paths.glassBundlePath];
}

function hasPatch(source: string): boolean {
  return source.includes(MODEL_MARKER) || source.includes(CONTROL_MARKER) || source.includes(PATCH_MARKER);
}

function readManifests(paths: CursorDesktopPatchPaths, appVersion: string): VerifiedManifest[] {
  const root = backupRoot(appVersion);
  if (!fs.existsSync(root)) return [];
  const targets = new Set(patchFiles(paths));
  const results: VerifiedManifest[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).filter((item) => item.isDirectory())) {
    const directory = path.join(root, entry.name);
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8')) as PatchManifest;
      if (manifest.schemaVersion !== 1 || ![MODEL_MARKER, CONTROL_MARKER, PATCH_MARKER].includes(manifest.marker)
        || manifest.appPath !== paths.appPath || manifest.appVersion !== appVersion || !Array.isArray(manifest.files)) continue;
      if (!manifest.files.every((file) => targets.has(file.path) && typeof file.backup === 'string'
        && path.dirname(path.resolve(file.backup)) === path.resolve(directory)
        && /^[a-f0-9]{64}$/.test(file.sha256) && /^[a-f0-9]{64}$/.test(file.patchedSha256))) continue;
      results.push({ directory, manifest });
    } catch { /* Ignore incomplete manifests; no unverified entry can authorize a write. */ }
  }
  return results;
}

interface RestoreEntry {
  path: string;
  source: string;
  content: string;
  current: string;
  mode: number;
}

function findOriginal(target: string, currentHash: string, manifests: VerifiedManifest[]): { source: string; content: string } | undefined {
  const pending = [currentHash];
  const visited = new Set<string>();
  while (pending.length) {
    const hash = pending.shift()!;
    if (visited.has(hash)) continue;
    visited.add(hash);
    for (const { manifest } of manifests) {
      for (const file of manifest.files) {
        if (file.path !== target || file.patchedSha256 !== hash || file.sha256 === hash) continue;
        try {
          if (!fs.lstatSync(file.backup).isFile()) continue;
          const content = fs.readFileSync(file.backup, 'utf8');
          if (sha256(content) !== file.sha256) continue;
          if (!hasPatch(content)) return { source: file.backup, content };
          pending.push(file.sha256);
        } catch { /* A different verified chain may still reach the original. */ }
      }
    }
  }
  return undefined;
}

function restorePlan(paths: CursorDesktopPatchPaths, appVersion: string): RestoreEntry[] {
  const manifests = readManifests(paths, appVersion);
  const entries: RestoreEntry[] = [];
  for (const target of patchFiles(paths)) {
    if (!fs.existsSync(target)) continue;
    const current = fs.readFileSync(target, 'utf8');
    if (!hasPatch(current)) continue;
    if (!fs.lstatSync(target).isFile()) throw new Error(`拒绝修改非普通文件：${target}`);
    const original = findOriginal(target, sha256(current), manifests);
    if (!original) throw new Error(`无法校验 ${target} 到原始文件的备份链（文件可能被外部修改或备份损坏）；未修改任何文件。`);
    entries.push({ path: target, ...original, current, mode: fs.statSync(target).mode & 0o777 });
  }
  return entries;
}

export function inspectCursorDesktopPatch(appPath?: string) {
  const paths = resolveCursorDesktopPatchPaths(appPath);
  const appVersion = readAppVersion(paths);
  const files = patchFiles(paths).map((target) => {
    try {
      const content = fs.readFileSync(target, 'utf8');
      const patchVersion = content.includes(MODEL_MARKER) ? 4 : content.includes(CONTROL_MARKER) ? 3 : content.includes(PATCH_MARKER) ? 2 : 0;
      return { path: target, state: hasPatch(content) ? 'patched' as const : 'native' as const, patchVersion };
    } catch { return { path: target, state: 'missing' as const }; }
  });
  const patched = files.filter((file) => file.state === 'patched').length;
  let uninstallError: string | undefined;
  let restoreFiles: Array<{ path: string; backup: string }> = [];
  try { restoreFiles = restorePlan(paths, appVersion).map((entry) => ({ path: entry.path, backup: entry.source })); }
  catch (error) { uninstallError = error instanceof Error ? error.message : String(error); }
  return {
    action: 'status' as const, appPath: paths.appPath, appVersion, scope: 'files-on-disk' as const,
    state: patched === 0 ? 'not-installed' : patched === files.length ? 'installed' : 'partial',
    latestPatchVersion: 4, upgradeAvailable: patched > 0 && files.some((file) => file.patchVersion !== 4),
    optional: true, experimental: true, modifiesApplication: true,
    runtimeVerified: false,
    note: '仅检查磁盘文件；不代表运行中的 Cursor 已加载补丁或 steer/Stop/模型切换已验证。安装、卸载均不会自动重启 Cursor。',
    files, canUninstall: patched > 0 && !uninstallError, restoreFiles,
    ...(uninstallError ? { uninstallError } : {}),
  };
}

export function planCursorDesktopPatchInstall(appPath?: string) {
  return {
    ...inspectCursorDesktopPatch(appPath), action: 'install-plan' as const,
    warning: '实验性可选功能：直接修改 Cursor.app 的 main、Desktop、Glass JavaScript bundle，非官方扩展或公开 API。默认不安装；普通消息收发不依赖补丁。',
    requiredFlag: '--allow-app-modification',
    uninstallCommand: 'codelark cursor-desktop-patch uninstall',
  };
}

export function uninstallCursorDesktopRealtimePatch(appPath?: string, options: { dryRun?: boolean } = {}) {
  const paths = resolveCursorDesktopPatchPaths(appPath);
  const appVersion = readAppVersion(paths);
  // Validate every file and every backup before touching any application file.
  const entries = restorePlan(paths, appVersion);
  if (options.dryRun) return {
    action: 'uninstall-plan' as const, appPath: paths.appPath, appVersion,
    files: entries.map((entry) => entry.path), backups: entries.map((entry) => entry.source),
    restartRequired: entries.length > 0,
  };
  try {
    for (const entry of entries) writeAtomic(entry.path, entry.content, entry.mode);
  } catch (error) {
    for (const entry of entries) {
      try { writeAtomic(entry.path, entry.current, entry.mode); } catch { /* Keep all original backups for recovery. */ }
    }
    throw error;
  }
  return {
    action: entries.length ? 'uninstalled' as const : 'not-installed' as const,
    appPath: paths.appPath, appVersion, files: entries.map((entry) => entry.path),
    restartRequired: entries.length > 0,
  };
}

/** Legacy command alias; restore now removes all patch layers, not just the latest one. */
export const restoreCursorDesktopRealtimePatch = uninstallCursorDesktopRealtimePatch;
