import '../../../setup/test-setup.js';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import vm from 'node:vm';
import { patchCursorMainBundle, patchCursorRendererBundle, patchCursorGlassRendererBundle } from '../../../../runtime/cursor/desktop-realtime-patch.js';

// VS Code invalidates ServicesAccessor as soon as invokeFunction returns, even
// when the returned value is a Promise. A permanently valid mock misses this.
function invokeNative(action: any, get: (key: string) => unknown, args: unknown) {
  let valid = true;
  try {
    return action.run({ get: (key: string) => {
      if (!valid) throw new Error('Illegal state: service accessor is only valid during the invocation of its target method');
      return get(key);
    } }, args);
  } finally { valid = false; }
}

// A minimal v2 host exercises upgrades independently of a local Cursor install.
const rendererV2 = `/* __CODELARK_CURSOR_DESKTOP_REALTIME_V2__ */
var CL2readAction="composer.desktopBridge.readThreadEvents",unused=0;
var CL2ReadAction=class {};
We(CL2ReadAction),0;
class Agent{abortChat(){this._withLiveAgentSync("abortChat",e=>e.abortChat())}}`;

function rendererFixture(options: { running?: boolean; loaded?: boolean; authorized?: boolean; fail?: boolean } = {}) {
  const calls: string[] = [];
  const agent = {
    composerDataHandle: { data: { status: options.running === false ? 'completed' : 'generating' } },
    desktopBridgeAbortChat: async () => { calls.push('abort'); if (options.fail) throw new Error('native failure'); },
    dispose: () => calls.push('dispose'),
  };
  const repository = {
    getAgentHeader: (id: string) => id === 'target' ? { source: 'local', status: { value: options.running === false ? 'completed' : 'in_progress' } } : undefined,
    getAgent: () => options.loaded === false ? undefined : agent,
    loadAgent: async (id: string) => { assert.equal(id, 'target'); calls.push('load'); return agent; },
  };
  const context = vm.createContext({
    at: class {}, er: 'env', Rr: 'config', Cn: 'token', E_: 'repository',
    uip: () => true, dip: async () => options.authorized !== false,
    $Uo: () => true, We: () => undefined,
  });
  const patched = patchCursorRendererBundle(rendererV2);
  vm.runInContext(patched, context);
  const action = vm.runInContext('new CL3StopAction()', context);
  return { calls, patched, run: (id = 'target') => invokeNative(action, (key: string) => key === 'repository' ? repository : {}, { threadId: id }) };
}

it('upgrades v2 to a registered Stop action that calls the exact live agent without disposing it', async () => {
  const f = rendererFixture();
  assert.equal((await f.run()).outcome, 'interrupt-requested');
  assert.deepEqual(f.calls, ['abort']);
  assert.equal(patchCursorRendererBundle(f.patched), f.patched);
});

it('loads the exact agent for Stop and releases only its own handle', async () => {
  const f = rendererFixture({ loaded: false });
  assert.equal((await f.run()).outcome, 'interrupt-requested');
  assert.deepEqual(f.calls, ['load', 'abort', 'dispose']);
});

it('reports idle and never aborts another thread or an unauthenticated request', async () => {
  const idle = rendererFixture({ running: false });
  assert.equal((await idle.run()).outcome, 'idle');
  assert.equal((await idle.run('unknown')).outcome, 'not-found');
  assert.deepEqual(idle.calls, []);
  const denied = rendererFixture({ authorized: false });
  assert.equal((await denied.run()).outcome, 'error');
  assert.deepEqual(denied.calls, []);
});

it('surfaces native Stop failures without returning a successful acknowledgement', async () => {
  const f = rendererFixture({ fail: true });
  const result = await f.run();
  assert.equal(result.outcome, 'error');
  assert.match(result.message, /native failure/);
});

it('main v3 validates and routes Stop by thread and stops retrying after an uncertain native failure', async () => {
  const source = `/* __CODELARK_CURSOR_DESKTOP_REALTIME_V2__ */
var oW=2,HC=262144;
var sB,iB,aB,oB,cB,mI,lB,oFe=(()=>{"use strict";
CL2readAction="composer.desktopBridge.readThreadEvents",mI="ready";return true})();
function N5e(e){if(e.type==="readThreadEvents")return e}
class Host{dispatch(e){switch(e.type){case"readThreadEvents":return this.readThreadEvents(e);}}
async readThreadEvents(e){return e}}
`;
  assert.throws(() => vm.runInNewContext(source), /CL2readAction is not defined/);
  const patched = patchCursorMainBundle(source);
  const brokenV3 = patched.replace('var sB,iB,aB,oB,cB,CL2readAction,CL3stopAction,mI,lB,oFe=', 'var sB,iB,aB,oB,cB,mI,lB,oFe=');
  assert.equal(patchCursorMainBundle(brokenV3), patched, 'already-marked v3 must repair missing strict-mode declarations');
  const calls: unknown[] = [];
  const context = vm.createContext({ iW: (id: unknown) => typeof id === 'string' && id.length > 0, gc: String });
  vm.runInContext(patched, context);
  assert.equal(vm.runInContext('oW', context), 4);
  assert.equal(vm.runInContext('N5e({type:"stopThread",threadId:123})', context), undefined);
  const host = vm.runInContext('new Host()', context);
  host.orderedWindows = () => [{ id: 1 }, { id: 2 }];
  host.bridgeActionArgs = (windowId: number, args: unknown) => ({ windowId, ...args as object });
  host.nativeHostMainService = { runActionInWindow: async (_: unknown, request: { windowId: number; args: unknown; actionId: string }) => {
    calls.push(request);
    if (request.windowId === 1) return { outcome: 'not-found' };
    assert.equal(request.actionId, 'composer.desktopBridge.stopThread');
    assert.deepEqual(request.args, { windowId: 2, threadId: 'target' });
    return { outcome: 'interrupt-requested' };
  } };
  const result = await host.dispatch({ type: 'stopThread', threadId: 'target' });
  assert.equal(result.status, 'interrupt-requested');
  assert.equal(result.threadId, 'target');
  assert.equal(calls.length, 2);
  calls.length = 0;
  host.nativeHostMainService.runActionInWindow = async () => { calls.push('error'); throw new Error('connection lost'); };
  assert.equal((await host.dispatch({ type: 'stopThread', threadId: 'target' })).status, 'error');
  assert.equal(calls.length, 1);
  assert.equal(patchCursorMainBundle(patched), patched);
  assert.equal(vm.runInContext('N5e({type:"setThreadModel",threadId:"target",model:123})', context), undefined);
  assert.equal(vm.runInContext('N5e({type:"setThreadModel",threadId:"target",model:" "})', context), undefined);
  host.nativeHostMainService.runActionInWindow = async (_: unknown, request: any) => {
    assert.equal(request.actionId, 'composer.desktopBridge.model');
    assert.equal(request.args.type, 'setThreadModel'); assert.equal(request.args.model, 'new');
    return { outcome: 'models', threadId: 'target', models: [{ id: 'new', name: 'New' }], selectedModels: ['new'], running: true };
  };
  assert.equal((await host.dispatch({ type: 'setThreadModel', threadId: 'target', model: 'new' })).selectedModels[0], 'new');
});

it('native wrapper awaits abort completion before releasing the agent reference', async () => {
  const context = vm.createContext({ at: class {}, We: () => {} });
  vm.runInContext(patchCursorRendererBundle(rendererV2), context);
  const agent = vm.runInContext('new Agent()', context);
  let completed = false;
  agent._withLiveAgent = async (_label: string, operation: (inner: unknown) => Promise<void>) => {
    await operation({ abortChatAndWait: async () => { await Promise.resolve(); completed = true; } });
    assert.equal(completed, true);
  };
  await agent.desktopBridgeAbortChat();
  assert.equal(completed, true);
});


it('Glass registers the same steer and Stop actions using its own service identifiers', async () => {
  const original = `var SwC="composer.desktopBridge.sendMessage",unused=0;
function xwC(t){const n={};const i=En_({type:"sendMessage",threadId:t.threadId,text:t.text,force:t.force});if(i?.type==="sendMessage")return{...n,...i}}
var DwC=class extends en{constructor(){super({id:SwC,title:{value:"Send Desktop Bridge Message",original:"Send Desktop Bridge Message"}})}},xoc=class extends rt{};
Lt(MwC),Lt(DwC),0;
class Agent{abortChat(){this._withLiveAgentSync("abortChat",t=>t.abortChat())}}`;
  const calls: string[] = [];
  const queue: { id: string; delivery?: { kind: string } }[] = [];
  const agent = { composerDataHandle: { data: { status: 'generating' } },
    isQueueSteeringAvailable: () => true, getQueueItems: () => queue,
    submitMessage: async () => { queue.push({ id: 'followup' }); calls.push('submit'); },
    promoteQueueItemToSteer: async (id: string) => { calls.push(`steer:${id}`); const item = queue.find(item => item.id === id); if (item) item.delivery = { kind: 'steer' }; return true; },
    desktopBridgeAbortChat: async () => { calls.push('stop'); },
  };
  const header = { source: 'local', status: { value: 'in_progress' }, name: { value: 'Target' } };
  const repository = { getAgent: () => agent, getAgentHeader: () => header };
  const registered: string[] = [];
  const context = vm.createContext({ en: class { constructor(public options: { id: string }) {} }, rt: class {},
    MwC: class {}, Lt: (action: new () => { options?: { id: string } }) => { const id = new action().options?.id; if (id) registered.push(id); },
    Ss: 'env', gr: 'config', fi: 'token', Ha: 'repository', no: 'composer', Go: 'storage', Gb: 'events', KNv: () => true, YNv: async () => ({}), Toc: () => true,
    Eoc: () => {}, En_: (value: unknown) => value,
  });
  const patched = patchCursorGlassRendererBundle(original);
  vm.runInContext(patched, context);
  const send = vm.runInContext('new DwC()', context);
  const result = await send.sendThroughAgentRepository({ args: { threadId: 'target', text: 'change', delivery: 'steer' }, agentHeader: header, agentRepositoryService: repository });
  assert.equal(result.outcome, 'steered');
  const stop = vm.runInContext('new CL3StopAction()', context);
  assert.equal((await invokeNative(stop, (id: string) => id === 'repository' ? repository : {}, { threadId: 'target' })).outcome, 'interrupt-requested');
  assert.deepEqual(calls, ['submit', 'steer:followup', 'stop']);
  assert.ok(registered.includes('composer.desktopBridge.stopThread'));
  assert.ok(registered.includes('composer.desktopBridge.readThreadEvents'));
  const reader = vm.runInContext('new CL2ReadAction()', context);
  const empty = await invokeNative(reader, (id: string) => id === 'repository' ? { getAgent: () => undefined }
    : id === 'env' ? { isGlass: true } : {}, { threadId: 'target', after: 0, timeoutMs: 0 });
  assert.equal(empty.events.length, 0);
  queue.length = 0; calls.length = 0;
  agent.submitMessage = async () => { queue.push({ id: 'already-steered', delivery: { kind: 'steer' } }); calls.push('submit'); };
  const already = await send.sendThroughAgentRepository({ args: { threadId: 'target', text: 'change', delivery: 'steer' }, agentHeader: header, agentRepositoryService: repository });
  assert.equal(already.outcome, 'steered'); assert.deepEqual(calls, ['submit'], 'do not promote an already steered item twice');
  queue.length = 0; calls.length = 0;
  agent.submitMessage = async () => { queue.push({ id: 'in-flight', delivery: { kind: 'promoting_to_steer' } }); };
  const pending = await send.sendThroughAgentRepository({ args: { threadId: 'target', text: 'change', delivery: 'steer' }, agentHeader: header, agentRepositoryService: repository });
  assert.equal(pending.outcome, 'submitted'); assert.doesNotMatch(pending.warning, /remains queued|仍.*排队/);
  assert.deepEqual(calls, []);
  queue.length = 0;
  agent.submitMessage = async () => { queue.push({ id: 'racing' }); };
  agent.promoteQueueItemToSteer = async () => { queue[0]!.delivery = { kind: 'steer' }; return false; };
  const raced = await send.sendThroughAgentRepository({ args: { threadId: 'target', text: 'change', delivery: 'steer' }, agentHeader: header, agentRepositoryService: repository });
  assert.equal(raced.outcome, 'steered', 'observed native steer wins over a redundant promotion refusal');
  queue.length = 0;
  agent.promoteQueueItemToSteer = async () => false;
  const queued = await send.sendThroughAgentRepository({ args: { threadId: 'target', text: 'change', delivery: 'steer' }, agentHeader: header, agentRepositoryService: repository });
  assert.equal(queued.outcome, 'queued');
  queue.length = 0;
  agent.promoteQueueItemToSteer = async () => true;
  const reverted = await send.sendThroughAgentRepository({ args: { threadId: 'target', text: 'change', delivery: 'steer' }, agentHeader: header, agentRepositoryService: repository });
  assert.equal(reverted.outcome, 'queued', 'native readback wins even if dispatch previously returned true');
  assert.equal(patchCursorGlassRendererBundle(patched), patched);
});

for (const glass of [false, true]) it(`${glass ? 'Glass' : 'Desktop'} model action uses native filtered models, validates policy and reads back per-thread selection`, async () => {
  const register = glass ? 'Lt' : 'We';
  const source = `/* __CODELARK_CURSOR_DESKTOP_CONTROL_V3__ */ var CL3StopAction=class {}; ${register}(CL3StopAction),0;`;
  const calls: unknown[] = [];
  let authorized = true, blocked = false, mismatch = false;
  const handle = { data: { status: 'generating', unifiedMode: 'chat', modelConfig: { modelName: 'old' } } };
  const agent = { composerDataHandle: handle, dispose: () => calls.push('dispose') };
  const repository = { getAgentHeader: (id: string) => id === 'target' ? { source: 'local', status: { value: 'in_progress' } } : undefined,
    getAgent: () => undefined, loadAgent: async () => { calls.push('load'); return agent; } };
  const services: Record<string, unknown> = {
    repository,
    models: {
      resolveModelNameToCatalog: (name: string) => name === 'new-high' ? 'new' : name,
      getSelectedModelsForComposer: () => [{ modelId: handle.data.modelConfig.modelName }],
      setModelConfigForComposer: (...args: [unknown, { modelName: string }]) => {
        assert.equal(args[0], handle); assert.equal(args.length, 2, 'must not update global preferences');
        calls.push('set'); handle.data.modelConfig.modelName = mismatch ? 'fallback' : 'new';
      },
    },
    settings: { getAvailableModelsWithStatus: (args: unknown) => {
      assert.equal(JSON.stringify(args), JSON.stringify({ specificModelField: 'composer', filterBlockedModels: true }));
      return [{ name: 'old', clientDisplayName: 'Old' }, { name: 'new', clientDisplayName: 'New' }];
    } },
    admin: { forceRefresh: async () => { calls.push('policy'); }, isModelBlocked: (name: string) => blocked && name.startsWith('new') },
  };
  const context = vm.createContext({ at: class {}, en: class {}, We: () => {}, Lt: () => {},
    er: 'env', Ss: 'env', Rr: 'flags', gr: 'flags', Cn: 'storage', fi: 'storage', E_: 'repository', Ha: 'repository',
    wS: 'models', Gm: 'models', Z2: 'settings', OR: 'settings', ow: 'admin', q_: 'admin',
    uip: () => true, KNv: () => true, dip: async () => authorized, YNv: async () => authorized, $Uo: () => true, Toc: () => true,
  });
  vm.runInContext(glass ? patchCursorGlassRendererBundle(source) : patchCursorRendererBundle(source), context);
  const action = vm.runInContext('new CL4ModelAction()', context);
  const run = (type: string, model?: string, threadId = 'target') => invokeNative(action, (id: string) => services[id] || {}, { type, model, threadId });
  const listed = await run('getThreadModels');
  assert.equal(listed.outcome, 'models'); assert.equal(listed.selectedModels[0], 'old');
  assert.deepEqual(calls, ['policy', 'load', 'dispose']); calls.length = 0;
  const changed = await run('setThreadModel', 'new-high');
  assert.equal(changed.outcome, 'models'); assert.equal(changed.selectedModels[0], 'new'); assert.equal(changed.running, true);
  assert.deepEqual(calls, ['policy', 'load', 'set', 'dispose']); calls.length = 0;
  blocked = true;
  assert.match((await run('setThreadModel', 'new')).message, /disabled by your administrator/);
  assert.equal(calls.includes('set'), false); calls.length = 0;
  blocked = false;
  assert.equal((await run('setThreadModel', 'unlisted')).outcome, 'error');
  assert.equal(calls.includes('set'), false); calls.length = 0;
  mismatch = true;
  assert.match((await run('setThreadModel', 'new')).message, /current selection: fallback/);
  authorized = false; calls.length = 0;
  assert.equal((await run('setThreadModel', 'new')).outcome, 'error');
  assert.deepEqual(calls, []);
  authorized = true;
  assert.equal((await run('getThreadModels', undefined, 'wrong')).outcome, 'not-found'); assert.deepEqual(calls, []);
});
