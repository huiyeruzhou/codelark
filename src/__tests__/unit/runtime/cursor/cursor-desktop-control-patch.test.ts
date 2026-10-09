import '../../../setup/test-setup.js';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import vm from 'node:vm';
import { patchCursorMainBundle, patchCursorRendererBundle } from '../../../../runtime/cursor/desktop-realtime-patch.js';

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
  return { calls, patched, run: (id = 'target') => action.run({ get: (key: string) => key === 'repository' ? repository : {} }, { threadId: id }) };
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
var CL2readAction="composer.desktopBridge.readThreadEvents",unused=0;
function N5e(e){if(e.type==="readThreadEvents")return e}
class Host{dispatch(e){switch(e.type){case"readThreadEvents":return this.readThreadEvents(e);}}
async readThreadEvents(e){return e}}
`;
  const patched = patchCursorMainBundle(source);
  const calls: unknown[] = [];
  const context = vm.createContext({ iW: (id: unknown) => typeof id === 'string' && id.length > 0, gc: String });
  vm.runInContext(patched, context);
  assert.equal(vm.runInContext('oW', context), 3);
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
