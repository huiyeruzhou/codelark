import '../../../setup/test-setup.js';
import { beforeEach, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CODELARK_HOME } from '../../../../configuration/paths.js';
import { createConfigService } from '../../../../configuration/service.js';
import { getSessionActiveRuntime, getSessionWorkingDirectory } from '../../../../domain/session-runtime.js';
import { initBridgeTestContext, resetBridgeTestState, RecordingAdapter, inboundMessage } from '../../../helpers/bridge/test-bridge-utils.js';
import * as router from '../../../../bridge/session/channel-router.js';
import { scopedConfigForRuntime, resolveSessionRuntimeConfig } from '../../../../bridge/session/support.js';
import { CommandThreadDisplay } from '../../../../bridge/command/thread-display.js';
import { handleRuntimeCommand } from '../../../../bridge/command/runtime-settings.js';
import { createRuntimeSessionForChat } from '../../../../bridge/command/runtime-session.js';
import { handleClearSessionCommand } from '../../../../bridge/session/command-use-cases/clear-session.js';
import { handleNewSessionCommand } from '../../../../bridge/session/command-use-cases/new-session.js';

beforeEach(() => resetBridgeTestState());

for (const command of ['clear', 'new'] as const) {
  for (const runtime of ['codex', 'claude', 'kimi', 'cursor', 'zcode'] as const) {
    it(`${command} inherits effective ${runtime} settings across storage reload, with an explicit directory override`, async () => {
      const store = initBridgeTestContext();
      const config = createConfigService({ migrate: false });
      const workDir = path.join(CODELARK_HOME, 'inherited-work');
      const nextDir = path.join(CODELARK_HOME, 'explicit-work');
      fs.mkdirSync(workDir, { recursive: true });
      fs.mkdirSync(nextDir, { recursive: true });
      config.set({ kind: 'home' }, { runtime: { agent: 'codex', codex: { model: 'default-model', provider: 'tmux' } } });
      // 部分配置来自 channel，部分来自 session；只复制 session 原始 TOML 会漏掉前者。
      config.set({ kind: 'channel', channelId: 'feishu', provider: 'feishu' }, {
        runtime: {
          codex: { model: 'channel-model', sandboxMode: 'workspace-write', reasoningEffort: 'high', networkAccess: true },
          claude: { model: 'claude-custom', reasoningEffort: 'high', idleTimeoutMinutes: 17 },
          kimi: { model: 'kimi-custom', thinkingMode: 'off' },
          cursor: { model: 'cursor-custom', reasoningEffort: 'high', force: true },
          zcode: { model: 'zcode-custom', mode: 'plan' },
        },
      });
      const address = { channelType: 'feishu', chatId: 'source-chat', userId: 'ou_test', chatKind: 'group' as const };
      const sourceBinding = router.createBinding(address, workDir, 'source');
      config.set({ kind: 'session', sessionId: sourceBinding.bridgeSessionId }, {
        session: { requireMention: true, tmuxCaptureLines: 213, tmuxAutoEnter: false, tmuxEchoInput: false },
        runtime: { agent: runtime, codex: { model: 'session-model', provider: 'sdk', yoloMode: 'off' }, claude: { provider: 'pty', yoloMode: 'yolo' } },
      });
      store.updateSession(sourceBinding.bridgeSessionId, {
        runtime: { activeRuntime: runtime, general: { systemPrompt: 'Keep this system prompt.' } },
      });
      store.updateSessionProviderId(sourceBinding.bridgeSessionId, 'configured-provider');
      const sourceSession = store.getSession(sourceBinding.bridgeSessionId)!;
      const sourceConfig = scopedConfigForRuntime(sourceBinding, sourceSession).config;
      const adapter = new RecordingAdapter();
      const options = {
        adapter, msg: inboundMessage(address, `/${command} child ${nextDir}`), args: `child ${nextDir}`,
        store, deps: { getActiveTask: () => undefined }, threadDisplay: new CommandThreadDisplay(store), markdown: true,
      };
      const result = command === 'clear'
        ? await handleClearSessionCommand({ ...options, currentBinding: sourceBinding })
        : await handleNewSessionCommand({ ...options, commandBinding: sourceBinding });
      assert.match(result.response, /已清空当前聊天上下文|已创建群聊会话/);
      const targetChatId = command === 'clear' ? address.chatId : adapter.createdGroups[0]!.chatId;
      // 重新创建 store/config service，不能依赖命令调用里的旧对象或内存缓存。
      const reloaded = initBridgeTestContext();
      const targetBinding = reloaded.getChannelChat('feishu', targetChatId)!;
      const target = reloaded.getSession(targetBinding.bridgeSessionId)!;
      const inherited = scopedConfigForRuntime(targetBinding, target).config;
      assert.notEqual(target.id, sourceSession.id);
      assert.equal(getSessionActiveRuntime(target) || 'codex', runtime);
      assert.deepEqual(inherited.runtime, sourceConfig.runtime);
      assert.deepEqual(inherited.session, { ...sourceConfig.session, workspace: nextDir });
      assert.equal(getSessionWorkingDirectory(target), nextDir);
      assert.equal(target.provider_id, 'configured-provider');
      assert.equal(target.runtime?.general?.systemPrompt, 'Keep this system prompt.');
      assert.equal(target.runtime?.general?.tmuxSessionName, undefined);
      assert.equal(target.runtime?.codex?.threadId, undefined);
      assert.notEqual(target.runtime_status, 'running');
      assert.equal(target.health_status, undefined);
      assert.deepEqual(scopedConfigForRuntime(sourceBinding, reloaded.getSession(sourceSession.id)).config, sourceConfig);
      if (runtime === 'codex') assert.equal(resolveSessionRuntimeConfig(targetBinding, target).codexProvider, 'tmux');
    });
  }
}

it('new retains the selected app-server endpoint while leaving the old thread and active task in the source chat', async () => {
  const store = initBridgeTestContext();
  const address = { channelType: 'feishu', chatId: 'shared-source', userId: 'ou_test' };
  const binding = router.createBinding(address, CODELARK_HOME);
  store.updateSession(binding.bridgeSessionId, {
    runtime: { codex: { appServerEndpoint: 'unix:///tmp/example-owned-backend.sock', threadId: 'old-thread' } },
    runtime_status: 'running', health_status: 'running_active',
  });
  const adapter = new RecordingAdapter();
  await handleNewSessionCommand({
    adapter, msg: inboundMessage(address, '/new --force child'), args: '--force child', commandBinding: binding,
    store, deps: { getActiveTask: () => undefined }, threadDisplay: new CommandThreadDisplay(store), markdown: true,
  });
  const target = store.getSession(store.getChannelChat('feishu', adapter.createdGroups[0]!.chatId)!.bridgeSessionId)!;
  assert.equal(target.runtime?.codex?.appServerEndpoint, 'unix:///tmp/example-owned-backend.sock');
  assert.equal(target.runtime?.codex?.threadId, undefined);
  assert.equal(store.getSession(binding.bridgeSessionId)?.runtime?.codex?.threadId, 'old-thread');
  assert.equal(store.getSession(binding.bridgeSessionId)?.runtime_status, 'running');
});

for (const targetRuntime of ['codex', 'claude', 'kimi', 'cursor', 'zcode'] as const) {
  it(`runtime ${targetRuntime} inherits pre-edited settings once and preserves both mapped sessions on return`, () => {
    const store = initBridgeTestContext();
    const config = createConfigService({ migrate: false });
    const address = { channelType: 'feishu', chatId: `runtime-${targetRuntime}`, userId: 'ou_test' };
    const binding = router.createBinding(address, CODELARK_HOME);
    const sourceRuntime = targetRuntime === 'codex' ? 'claude' : 'codex';
    store.updateSession(binding.bridgeSessionId, { runtime: { activeRuntime: sourceRuntime, general: { systemPrompt: 'Keep prompt' } } });
    config.set({ kind: 'home' }, { runtime: { codex: { model: 'global-model' } } });
    config.set({ kind: 'channel', channelId: 'feishu', provider: 'feishu' }, { runtime: { kimi: { thinkingMode: 'off' } } });
    config.set({ kind: 'session', sessionId: binding.bridgeSessionId }, {
      session: { requireMention: true, tmuxCaptureLines: 234, tmuxEchoInput: false },
      runtime: { agent: sourceRuntime,
        codex: { model: 'prepared-codex', sandboxMode: 'read-only', yoloMode: 'off', provider: 'sdk', reasoningEffort: 'high' },
        claude: { model: 'prepared-claude', yoloMode: 'yolo', provider: 'sdk' },
        kimi: { model: 'prepared-kimi' }, cursor: { model: 'prepared-cursor', force: true }, zcode: { model: 'prepared-zcode', mode: 'plan' },
      },
    });
    const sourceConfig = scopedConfigForRuntime(binding, store.getSession(binding.bridgeSessionId)).config;
    const changeRuntime = (runtime: string) => handleRuntimeCommand({
      msg: inboundMessage(address, `/runtime ${runtime}`), args: runtime,
      currentBinding: store.getChannelChat('feishu', address.chatId), store, markdown: true,
    });
    assert.match(changeRuntime(targetRuntime), /已创建并切换 Runtime/);
    const targetBinding = store.getChannelChat('feishu', address.chatId)!;
    const reloaded = initBridgeTestContext();
    const target = reloaded.getSession(targetBinding.bridgeSessionId)!;
    const inherited = scopedConfigForRuntime(targetBinding, target).config;
    assert.notEqual(target.id, binding.bridgeSessionId);
    assert.equal(getSessionActiveRuntime(target), targetRuntime);
    assert.deepEqual(inherited.session, sourceConfig.session);
    assert.deepEqual(inherited.runtime, { ...sourceConfig.runtime, agent: targetRuntime });
    assert.equal(target.runtime?.general?.systemPrompt, 'Keep prompt');
    config.set({ kind: 'session', sessionId: target.id }, { session: { requireMention: false, tmuxCaptureLines: 345 } });
    const ownConfig = scopedConfigForRuntime(targetBinding, target).config;
    assert.match(changeRuntime(sourceRuntime), /已切换 Runtime/);
    assert.equal(store.getChannelChat('feishu', address.chatId)?.bridgeSessionId, binding.bridgeSessionId);
    assert.deepEqual(scopedConfigForRuntime(binding, store.getSession(binding.bridgeSessionId)).config, sourceConfig);
    assert.match(changeRuntime(targetRuntime), /已切换 Runtime/);
    assert.equal(store.getChannelChat('feishu', address.chatId)?.bridgeSessionId, target.id);
    assert.deepEqual(scopedConfigForRuntime(targetBinding, store.getSession(target.id)).config, ownConfig);
  });
}

it('runtime session creation copies configuration but never endpoint, thread, health or terminal ownership', () => {
  const store = initBridgeTestContext();
  const binding = router.createBinding({ channelType: 'feishu', chatId: 'owned-runtime' }, CODELARK_HOME);
  createConfigService({ migrate: false }).set({ kind: 'session', sessionId: binding.bridgeSessionId }, { session: { requireMention: false } });
  store.updateSession(binding.bridgeSessionId, {
    runtime: { activeRuntime: 'codex', codex: { appServerEndpoint: 'unix:///tmp/old.sock', threadId: 'old-thread' },
      general: { tmuxSessionName: 'old-terminal' } }, runtime_status: 'running', health_status: 'running_active',
  });
  const before = store.getSession(binding.bridgeSessionId)!;
  assert.equal(before.runtime?.codex?.appServerEndpoint, 'unix:///tmp/old.sock');
  assert.equal(before.runtime?.codex?.threadId, 'old-thread');
  assert.equal(before.runtime?.general?.tmuxSessionName, 'old-terminal');
  const target = createRuntimeSessionForChat({ store, runtime: 'codex', baseSession: before, binding, chatId: binding.chatId });
  assert.equal(getSessionActiveRuntime(target), 'codex');
  assert.equal(target.runtime?.codex?.appServerEndpoint, undefined);
  assert.equal(target.runtime?.codex?.threadId, undefined);
  assert.equal(target.runtime?.general?.tmuxSessionName, undefined);
  assert.notEqual(target.runtime_status, 'running');
  assert.equal(target.health_status, undefined);
  assert.deepEqual(store.getSession(before.id), before);
  assert.equal(createConfigService({ migrate: false }).get('session.requireMention', { kind: 'session', sessionId: target.id }), false);
});
