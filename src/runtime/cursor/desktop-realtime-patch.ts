import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parse } from 'acorn';

const PATCH_MARKER = '__CODELARK_CURSOR_DESKTOP_REALTIME_V2__';
const DEFAULT_CURSOR_APP = '/Applications/Cursor.app';

export interface CursorDesktopPatchPaths {
  appPath: string;
  mainBundlePath: string;
  rendererBundlePath: string;
  productPath: string;
}

export interface CursorDesktopPatchResult {
  action: 'installed' | 'already-installed' | 'restored' | 'not-installed';
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
    productPath: path.join(appRoot, 'product.json'),
  };
}

function readAppVersion(paths: CursorDesktopPatchPaths): string {
  try {
    const product = JSON.parse(fs.readFileSync(paths.productPath, 'utf8')) as { version?: unknown };
    if (typeof product.version === 'string' && product.version.trim()) return product.version.trim();
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

export function patchCursorMainBundle(source: string): string {
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

export function patchCursorRendererBundle(source: string): string {
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

export function installCursorDesktopRealtimePatch(appPath?: string): CursorDesktopPatchResult {
  const paths = resolveCursorDesktopPatchPaths(appPath);
  const appVersion = readAppVersion(paths);
  const originalMain = fs.readFileSync(paths.mainBundlePath, 'utf8');
  const originalRenderer = fs.readFileSync(paths.rendererBundlePath, 'utf8');
  if (originalMain.includes(PATCH_MARKER) && originalRenderer.includes(PATCH_MARKER)) {
    return { action: 'already-installed', appPath: paths.appPath, appVersion, files: [paths.mainBundlePath, paths.rendererBundlePath] };
  }
  if (originalMain.includes(PATCH_MARKER) || originalRenderer.includes(PATCH_MARKER)) {
    throw new Error('Cursor realtime patch 处于半安装状态；请先 restore，再重新安装。');
  }
  const patchedMain = patchCursorMainBundle(originalMain);
  const patchedRenderer = patchCursorRendererBundle(originalRenderer);
  assertJavaScript(patchedMain, 'main');
  assertJavaScript(patchedRenderer, 'renderer');

  const backupDirectory = path.join(backupRoot(appVersion), `${Date.now()}-${sha256(originalMain).slice(0, 12)}`);
  fs.mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
  const entries = [
    { path: paths.mainBundlePath, original: originalMain, patched: patchedMain, backup: path.join(backupDirectory, 'main.js') },
    { path: paths.rendererBundlePath, original: originalRenderer, patched: patchedRenderer, backup: path.join(backupDirectory, 'workbench.desktop.main.js') },
  ];
  for (const entry of entries) fs.copyFileSync(entry.path, entry.backup, fs.constants.COPYFILE_EXCL);
  const manifest: PatchManifest = {
    schemaVersion: 1,
    marker: PATCH_MARKER,
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
  return { action: 'installed', appPath: paths.appPath, appVersion, backupDirectory, files: entries.map((entry) => entry.path) };
}

function latestManifest(appVersion: string, appPath: string): { directory: string; manifest: PatchManifest } | null {
  const root = backupRoot(appVersion);
  if (!fs.existsSync(root)) return null;
  const directories = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name))
    .sort()
    .reverse();
  for (const directory of directories) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8')) as PatchManifest;
      if (
        manifest.marker === PATCH_MARKER
        && manifest.schemaVersion === 1
        && path.resolve(manifest.appPath) === path.resolve(appPath)
      ) return { directory, manifest };
    } catch {
      // Ignore incomplete backup directories and try the previous complete one.
    }
  }
  return null;
}

export function restoreCursorDesktopRealtimePatch(appPath?: string): CursorDesktopPatchResult {
  const paths = resolveCursorDesktopPatchPaths(appPath);
  const appVersion = readAppVersion(paths);
  const found = latestManifest(appVersion, paths.appPath);
  if (!found) return { action: 'not-installed', appPath: paths.appPath, appVersion, files: [] };
  const currentHashes = new Map(found.manifest.files.map((entry) => [entry.path, sha256(fs.readFileSync(entry.path))]));
  if (found.manifest.files.every((entry) => currentHashes.get(entry.path) === entry.sha256)) {
    return { action: 'not-installed', appPath: paths.appPath, appVersion, backupDirectory: found.directory, files: [] };
  }
  for (const entry of found.manifest.files) {
    if (currentHashes.get(entry.path) !== entry.patchedSha256) {
      throw new Error(`Cursor 文件已被其他更新替换，拒绝覆盖：${entry.path}`);
    }
  }
  for (const entry of found.manifest.files) {
    const backup = fs.readFileSync(entry.backup);
    if (sha256(backup) !== entry.sha256) throw new Error(`Cursor patch 备份校验失败：${entry.backup}`);
    const mode = fs.statSync(entry.path).mode & 0o777;
    writeAtomic(entry.path, backup.toString('utf8'), mode);
  }
  return {
    action: 'restored',
    appPath: paths.appPath,
    appVersion,
    backupDirectory: found.directory,
    files: found.manifest.files.map((entry) => entry.path),
  };
}
