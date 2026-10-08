import '../../../setup/test-setup.js';
import { beforeEach, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { initBridgeTestContext, resetBridgeTestState, writeCodexSessionJsonlFixture, RecordingAdapter, inboundMessage } from '../../../helpers/bridge/test-bridge-utils.js';
import { createConfigService } from '../../../../configuration/service.js';
import { handleBridgeCommand } from '../../../../bridge/command/index.js';
import { resolveLocalCodexThreadId } from '../../../../bridge/command/runtime-settings.js';
import { codexAppServerTurnOptions } from '../../../../bridge/command/tmux.js';
import { _testOnlyWaitForDeliveryQueuesForTests } from '../../../../channels/delivery/deliver.js';

beforeEach(() => resetBridgeTestState({ cleanCodexHome: true }));

function fixture(provider: 'sdk' | 'tmux', shared: boolean) {
  const store = initBridgeTestContext();
  const config = createConfigService({ migrate: false, env: {} });
  config.set({ kind: 'home' }, { runtime: { codex: {
    model: 'gpt-5.4', reasoningEffort: 'medium', sandboxMode: 'workspace-write', networkAccess: true,
  } } });
  const session = store.createSession('settings', 'old-model');
  const scope = { kind: 'session' as const, sessionId: session.id };
  config.set(scope, { runtime: { codex: { provider, model: 'old-model', yoloMode: 'off' } } });
  const threadId = randomUUID();
  const endpoint = shared ? 'unix:///tmp/owned-command-test.sock' : undefined;
  store.updateSession(session.id, { runtime: { activeRuntime: 'codex', codex: { threadId, appServerEndpoint: endpoint },
    general: { tmuxSessionName: `codex_${threadId}-view` } }, runtime_status: 'running', health_status: 'running_active' });
  const address = { channelType: 'feishu', chatId: `settings-${threadId}` };
  const binding = store.upsertChannelChat({ ...address, bridgeSessionId: session.id });
  const local = writeCodexSessionJsonlFixture({ threadId, workDir: process.cwd() });
  // The resolver must still find this indexed thread; only the command's legacy guard may change.
  assert.equal(resolveLocalCodexThreadId(store.getSession(session.id), binding, 'settings test'), threadId);
  const abortController = new AbortController();
  const adapter = new RecordingAdapter();
  const command = async (text: string) => {
    await handleBridgeCommand(adapter, inboundMessage(address, text, `settings-${adapter.sent.length}`), text, {
      getActiveTask: () => ({ abortController }),
      diagnoseSessionHealth: async () => null,
      diagnoseAllActiveSessions: async () => [],
      forceStopSession: async () => assert.fail('设置命令不能停止活动轮次'),
      reconcileMirrorSubscriptions: async () => assert.fail('设置命令不能重建查看入口'),
    });
    await _testOnlyWaitForDeliveryQueuesForTests(adapter);
    assert.equal(abortController.signal.aborted, false);
    assert.equal(store.getChannelChat(address.channelType, address.chatId)?.bridgeSessionId, session.id);
    assert.equal(store.getSession(session.id)?.runtime?.codex?.threadId, threadId);
    assert.equal(store.getSession(session.id)?.runtime?.codex?.appServerEndpoint, endpoint);
    assert.equal(store.getSession(session.id)?.runtime_status, 'running');
    assert.equal(fs.readFileSync(local.sessionPath, 'utf8'), local.rawJsonl, '不能修改已有轮次记录');
    return adapter.sent.at(-1)?.text || '';
  };
  const turnOptions = () => codexAppServerTurnOptions(binding, store.getSession(session.id)!);
  return { config, scope, command, turnOptions };
}

function nextImTurnNotice(text: string): void {
  assert.match(text, /下一次由 IM 发起的新轮次（turn）开始生效/);
  assert.match(text, /当前活动轮次及其运行中追加保持原设置/);
  assert.doesNotMatch(text, /重启|\/stop|\/new|只支持查看/);
}

for (const provider of ['sdk', 'tmux'] as const) {
  it(`app-server ${provider} indexed thread accepts model changes and preserves the active turn`, async () => {
    const f = fixture(provider, true);
    nextImTurnNotice(await f.command('/model'));
    const activeOptions = f.turnOptions();
    assert.equal(activeOptions.model, 'old-model');
    nextImTurnNotice(await f.command('/model gpt-5.4'));
    assert.equal(f.config.get('runtime.codex.model', f.scope), 'gpt-5.4');
    assert.equal(f.turnOptions().model, 'gpt-5.4');
    assert.equal(activeOptions.model, 'old-model');
    assert.match(await f.command('/model not-an-available-model'), /模型用法/);
    assert.equal(f.config.get('runtime.codex.model', f.scope), 'gpt-5.4');
    nextImTurnNotice(await f.command('/model default'));
    assert.notEqual(f.config.resolve('runtime.codex.model', f.scope).source, 'session');
    assert.equal(f.turnOptions().model, 'gpt-5.4');
  });

  it(`app-server ${provider} settings and resets describe the next IM turn without a TUI restart`, async () => {
    const f = fixture(provider, true);
    const activeOptions = f.turnOptions();
    for (const query of ['/mode', '/sandbox', '/reasoning']) nextImTurnNotice(await f.command(query));
    nextImTurnNotice(await f.command('/mode yolo'));
    assert.equal(f.turnOptions().approvalPolicy, 'never');
    assert.deepEqual(f.turnOptions().sandboxPolicy, { type: 'dangerFullAccess' });
    nextImTurnNotice(await f.command('/mode normal'));
    assert.equal(f.turnOptions().approvalPolicy, 'on-request');
    nextImTurnNotice(await f.command('/sandbox read-only'));
    assert.deepEqual(f.turnOptions().sandboxPolicy, { type: 'readOnly' });
    nextImTurnNotice(await f.command('/reasoning high'));
    assert.equal(f.turnOptions().effort, 'high');
    nextImTurnNotice(await f.command('/network off'));
    for (const reset of ['default', 'reset']) {
      nextImTurnNotice(await f.command(`/sandbox ${reset}`));
      nextImTurnNotice(await f.command(`/reasoning ${reset}`));
    }
    nextImTurnNotice(await f.command('/network default'));
    assert.notEqual(f.config.resolve('runtime.codex.sandboxMode', f.scope).source, 'session');
    assert.notEqual(f.config.resolve('runtime.codex.reasoningEffort', f.scope).source, 'session');
    assert.deepEqual(f.turnOptions(), activeOptions);
  });

  it(`legacy ${provider} indexed thread retains its model guard`, async () => {
    const f = fixture(provider, false);
    assert.match(await f.command('/model'), /只支持查看模型/);
    for (const model of ['gpt-5.4', 'default']) {
      assert.match(await f.command(`/model ${model}`), /不支持直接切换模型/);
      assert.equal(f.config.get('runtime.codex.model', f.scope), 'old-model');
    }
    const changed = await f.command('/mode yolo');
    if (provider === 'tmux') assert.match(changed, /\/p tmux.*重启/s);
    else assert.match(changed, /下一轮 Codex 请求开始生效/);
  });
}
