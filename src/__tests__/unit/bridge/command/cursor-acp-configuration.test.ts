import '../../../setup/test-setup.js';
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleProviderCommand } from '../../../../bridge/command/provider-settings.js';
import { handleModeCommand, handleModelCommand, handleReasoningCommand } from '../../../../bridge/command/runtime-settings.js';
import { handleSetCommand } from '../../../../bridge/command/global-settings.js';
import { parseCommandCallbackData } from '../../../../bridge/command/callbacks.js';
import { resolveCursorRuntimeConfig, resolveEffectiveRuntimeProvider } from '../../../../bridge/session/support.js';
import { migrateCursorDesktopSessionIdentities } from '../../../../bridge/session/cursor-transport.js';
import { getSessionCursorSessionIdForProvider, getSessionRuntimeProviderIdentity, setSessionCursorIdentityUpdate } from '../../../../domain/session-runtime.js';
import { createConfigService } from '../../../../configuration/service.js';
import { tmuxCore } from '../../../../runtime/tmux/core.js';
import { cursorTmuxSessionName } from '../../../../runtime/cursor/tmux-provider.js';
import { UiSessionApplication } from '../../../../operator-ui/application/session.js';
import { JsonFileStore } from '../../../../storage/json-store.js';
import { makeBridgeSettings, resetBridgeTestState } from '../../../helpers/bridge/test-bridge-utils.js';

function fixture(options: { defaultProvider?: 'tmux' | 'acp' } = { defaultProvider: 'tmux' }) {
  const store = new JsonFileStore(makeBridgeSettings());
  const config = createConfigService({ migrate: false });
  if (options.defaultProvider) {
    config.set({ kind: 'home' }, { runtime: { cursor: { provider: options.defaultProvider } } });
  }
  const initial = store.createSession('Cursor', 'default', undefined, '/tmp/cursor-acp');
  store.updateSession(initial.id, { runtime: {
    activeRuntime: 'cursor', cursor: { provider: 'tmux', sessionId: 'legacy-tui', cwd: '/tmp/cursor-acp' },
    general: { tmuxSessionName: 'legacy-tmux' },
  }, mirror_read_position: { threadId: 'legacy-tui', lastEventCount: 3 } });
  const session = store.getSession(initial.id)!;
  const binding = store.upsertChannelChat({ channelType: 'feishu', chatId: 'acp-config-test', bridgeSessionId: session.id });
  const command = (args: string) => handleProviderCommand({
    store, currentBinding: binding, args, markdown: true, deps: {},
    msg: { address: { channelType: 'feishu', chatId: binding.chatId }, messageId: `provider-${args}`, text: `/p ${args}`, timestamp: Date.now() },
  });
  return { store, session, binding, command, config };
}

describe('Cursor ACP configuration and provider switching', () => {
  beforeEach(() => resetBridgeTestState());

  it('defaults new Cursor sessions to ACP and reports the active provider in /mode, /model, and /reasoning', () => {
    const store = new JsonFileStore(makeBridgeSettings());
    const config = createConfigService({ migrate: false });
    assert.equal(config.get('runtime.cursor.provider'), 'acp');

    const session = store.createSession('Fresh Cursor', 'default', undefined, '/tmp/cursor-default-acp');
    store.updateSession(session.id, { runtime: { activeRuntime: 'cursor' } });
    const fresh = store.getSession(session.id)!;
    const binding = store.upsertChannelChat({ channelType: 'feishu', chatId: 'cursor-default-acp-test', bridgeSessionId: fresh.id });
    assert.equal(resolveCursorRuntimeConfig(fresh, binding).provider, 'acp');
    assert.equal(resolveEffectiveRuntimeProvider(fresh, binding).identity, 'cursor:acp');

    const msg = (text: string) => ({
      address: { channelType: 'feishu' as const, chatId: binding.chatId },
      messageId: `msg-${text}`,
      text,
      timestamp: Date.now(),
    });
    const modeQuery = handleModeCommand({ msg: msg('/mode'), args: '', currentBinding: binding, store, markdown: true });
    assert.match(modeQuery, /Provider[\s\S]*acp/);
    assert.doesNotMatch(modeQuery, /tmux/);

    const modeYolo = handleModeCommand({ msg: msg('/mode yolo'), args: 'yolo', currentBinding: binding, store, markdown: true });
    assert.match(modeYolo, /模式[\s\S]*yolo/);
    assert.match(modeYolo, /Provider[\s\S]*acp/);
    assert.doesNotMatch(modeYolo, /tmux/);
    assert.equal(resolveCursorRuntimeConfig(store.getSession(fresh.id), binding).force, true);

    const modeNormal = handleModeCommand({ msg: msg('/mode normal'), args: 'normal', currentBinding: binding, store, markdown: true });
    assert.match(modeNormal, /模式[\s\S]*normal/);
    assert.match(modeNormal, /Provider[\s\S]*acp/);
    assert.match(modeNormal, /\/clear/);
    assert.doesNotMatch(modeNormal, /tmux/);

    const modelReply = handleModelCommand({ msg: msg('/model sonnet'), args: 'sonnet', currentBinding: binding, store, markdown: true });
    assert.match(modelReply, /Cursor ACP/);
    assert.doesNotMatch(modelReply, /tmux/);

    const reasoningReply = handleReasoningCommand({ args: 'high', binding, store, markdown: true });
    assert.match(reasoningReply, /Cursor ACP/);
    assert.doesNotMatch(reasoningReply, /tmux/);

    // Historical tmux overrides normalize to ACP everywhere.
    config.set({ kind: 'session', sessionId: fresh.id }, { runtime: { cursor: { provider: 'tmux' } } });
    const normalizedMode = handleModeCommand({ msg: msg('/mode yolo'), args: 'yolo', currentBinding: binding, store, markdown: true });
    assert.match(normalizedMode, /Provider[\s\S]*acp/);
  });

  it('switches an idle TUI conversation to ACP without reusing its native ID or mirror cursor', async () => {
    const f = fixture();
    const result = await f.command('acp');
    assert.match(result.response, /已切换 Cursor Provider/);
    const saved = f.store.getSession(f.session.id)!;
    assert.equal(f.config.get('runtime.cursor.provider', { kind: 'session', sessionId: saved.id }), 'acp');
    assert.equal(resolveEffectiveRuntimeProvider(saved, f.binding).identity, 'cursor:acp');
    assert.equal(getSessionRuntimeProviderIdentity(saved), 'cursor:acp');
    assert.equal(saved.runtime?.cursor?.sessionId, undefined);
    assert.equal(saved.runtime?.cursor?.sessionProvider, 'acp');
    assert.equal(saved.runtime?.general?.tmuxSessionName, undefined);
    assert.equal(saved.mirror_read_position, undefined);
    assert.deepEqual(saved.runtime?.cursor?.previousSession, {
      sessionId: 'legacy-tui', provider: 'tmux', cwd: '/tmp/cursor-acp', tmuxSessionName: 'legacy-tmux',
    });
    f.store.updateSession(saved.id, setSessionCursorIdentityUpdate('new-acp', '/tmp/cursor-acp', 'acp'));
    const resumed = f.store.getSession(saved.id)!;
    assert.equal(getSessionCursorSessionIdForProvider(resumed, 'acp'), 'new-acp');
    assert.equal(getSessionCursorSessionIdForProvider(resumed, 'tmux'), undefined);
    assert.equal(resolveCursorRuntimeConfig(resumed).transport, 'cli');
    assert.equal(migrateCursorDesktopSessionIdentities(f.store, () => { throw new Error('ACP must not search TUI index'); }), 0);
  });

  for (const status of ['running', 'queued'] as const) {
    it(`preserves the ${status} native task until an explicit ACP switch confirmation`, async () => {
      const f = fixture();
      f.store.updateSession(f.session.id, { runtime_status: status, queued_count: status === 'queued' ? 1 : 0 });
      const before = f.store.getSession(f.session.id)!;
      const result = await f.command('acp');
      assert.match(result.response, /结束并切换 ACP/);
      const action = result.richCard?.actions?.flat().find(action => action.text === '结束并切换 ACP');
      assert.match(parseCommandCallbackData(action?.callbackData || '')?.commandText || '', /^\/p acp --restart=/);
      assert.deepEqual(f.store.getSession(f.session.id), before);
      assert.equal(f.store.getSession(f.session.id)?.runtime?.cursor?.sessionProvider, undefined);
    });
  }


  for (const partial of [false, true]) it(`finishes a confirmed switch despite stale mirror state (partial config: ${partial})`, async (t) => {
    const f = fixture();
    const target = cursorTmuxSessionName(f.session.id);
    f.store.updateSession(f.session.id, { runtime_status: 'running', runtime: { general: { tmuxSessionName: target } } });
    if (partial) f.config.set({ kind: 'session', sessionId: f.session.id }, { runtime: { cursor: { provider: 'acp' } } });
    const first = await f.command('acp');
    const command = parseCommandCallbackData(first.richCard!.actions![0]![0]!.callbackData!)!.commandText;
    const calls: string[] = [];
    t.mock.method(tmuxCore, 'killSession', async (name: string) => { assert.equal(name, target); calls.push('cleanup'); return ''; });
    const confirmed = await handleProviderCommand({ store: f.store, currentBinding: f.binding,
      args: command.slice(3), markdown: true,
      msg: { address: { channelType: 'feishu', chatId: f.binding.chatId }, messageId: 'confirm-switch', text: command, timestamp: Date.now() },
      deps: { forceStopSession: async () => { calls.push('stop'); return true; } },
    });
    assert.match(confirmed.response, /已切换 Cursor Provider/);
    assert.deepEqual(calls, ['stop', 'cleanup']);
    const saved = f.store.getSession(f.session.id)!;
    assert.equal(saved.runtime_status, 'idle');
    assert.equal(saved.runtime?.cursor?.sessionProvider, 'acp');
    assert.equal(saved.runtime?.cursor?.sessionId, undefined);
    assert.equal(saved.runtime?.cursor?.previousSession?.sessionId, 'legacy-tui');
    assert.equal(resolveEffectiveRuntimeProvider(saved, f.binding).identity, 'cursor:acp');
    assert.match((await f.command(command.slice(3))).response, /已失效/);
  });

  it('does not commit ACP configuration or identity when the owned terminal cannot be stopped', async (t) => {
    const f = fixture();
    f.store.updateSession(f.session.id, { runtime_status: 'running', runtime: { general: { tmuxSessionName: cursorTmuxSessionName(f.session.id) } } });
    const before = f.store.getSession(f.session.id)!;
    const card = (await f.command('acp')).richCard!;
    const command = parseCommandCallbackData(card.actions![0]![0]!.callbackData!)!.commandText;
    t.mock.method(tmuxCore, 'killSession', async () => { throw new Error('cannot stop'); });
    await assert.rejects(f.command(command.slice(3)), /尚未切换/);
    assert.deepEqual(f.store.getSession(f.session.id), before);
    assert.equal(f.store.getSession(f.session.id)?.runtime?.cursor?.sessionProvider, undefined);
  });

  it('confirms the current ACP card by command once, preserving the old native identity', async () => {
    const f = fixture();
    assert.match((await f.command('acp --confirm')).response, /没有待确认/);
    f.store.updateSession(f.session.id, { runtime_status: 'running' });
    await f.command('acp');
    assert.match((await f.command('acp --confirm')).response, /已切换 Cursor Provider/);
    const saved = f.store.getSession(f.session.id)!;
    assert.equal(saved.runtime?.cursor?.sessionProvider, 'acp');
    assert.equal(saved.runtime?.cursor?.previousSession?.sessionId, 'legacy-tui');
    assert.match((await f.command('acp --confirm')).response, /没有待确认/);
  });

  it('does not let command confirmation stop a task started after the ACP card', async () => {
    const f = fixture();
    f.store.updateSession(f.session.id, { runtime_status: 'running' });
    await f.command('acp');
    let stopped = false;
    const task = new AbortController();
    const result = await handleProviderCommand({ store: f.store, currentBinding: f.binding, args: 'acp --confirm', markdown: true,
      msg: { address: { channelType: 'feishu', chatId: f.binding.chatId }, messageId: 'command-confirm', text: '/p acp --confirm', timestamp: Date.now() },
      deps: { getActiveTask: () => ({ abortController: task }), forceStopSession: async () => { stopped = true; return true; } },
    });
    assert.match(result.response, /已失效/);
    assert.equal(stopped, false);
    assert.equal(f.store.getSession(f.session.id)?.runtime?.cursor?.sessionProvider, undefined);
  });

  it('rejects an old switch button after a new task has started', async () => {
    const f = fixture();
    f.store.updateSession(f.session.id, { runtime_status: 'running' });
    const card = (await f.command('acp')).richCard!;
    const command = parseCommandCallbackData(card.actions![0]![0]!.callbackData!)!.commandText;
    let stopped = false;
    const result = await handleProviderCommand({ store: f.store, currentBinding: f.binding, args: command.slice(3), markdown: true,
      msg: { address: { channelType: 'feishu', chatId: f.binding.chatId }, messageId: 'stale-switch', text: command, timestamp: Date.now() },
      deps: { getActiveTask: () => ({ abortController: new AbortController() }), forceStopSession: async () => { stopped = true; return true; } },
    });
    assert.match(result.response, /已失效/);
    assert.equal(stopped, false);
    assert.equal(f.store.getSession(f.session.id)?.runtime?.cursor?.sessionProvider, undefined);
  });

  it('lets a global ACP default affect new requests without making a legacy TUI ID resumable by ACP', () => {
    const f = fixture();
    assert.match(handleSetCommand({ args: 'cursorProvider acp', markdown: true }), /acp/);
    assert.equal(f.config.get('runtime.cursor.provider'), 'acp');
    const saved = f.store.getSession(f.session.id)!;
    assert.equal(resolveEffectiveRuntimeProvider(saved).identity, 'cursor:acp');
    assert.equal(getSessionCursorSessionIdForProvider(saved, 'acp'), undefined);
    assert.equal(getSessionCursorSessionIdForProvider(saved, 'tmux'), 'legacy-tui');
    assert.equal(saved.runtime?.cursor?.sessionId, 'legacy-tui', 'changing a default must preserve original native history');
  });

  it('keeps ACP active on /p default even when global config still contains legacy tmux', async () => {
    const f = fixture();
    await f.command('acp');
    f.store.updateSession(f.session.id, setSessionCursorIdentityUpdate('native-acp', '/tmp/cursor-acp', 'acp'));
    await f.command('default');
    const saved = f.store.getSession(f.session.id)!;
    assert.equal(resolveCursorRuntimeConfig(saved).provider, 'acp');
    assert.equal(saved.runtime?.cursor?.sessionId, 'native-acp');
  });

  it('interprets /p tmux as /p acp without launching a tmux TUI', async () => {
    const f = fixture();
    await f.command('acp');
    f.store.updateSession(f.session.id, setSessionCursorIdentityUpdate('native-acp', '/tmp/cursor-acp', 'acp'));
    let launches = 0;
    const result = await handleProviderCommand({
      store: f.store, currentBinding: f.binding, args: 'tmux', markdown: true,
      msg: { address: { channelType: 'feishu', chatId: f.binding.chatId }, messageId: 'back-to-tmux', text: '/p tmux', timestamp: Date.now() },
      deps: { restartCursorTmuxSession: async () => {
        launches += 1;
        throw new Error('must not launch Cursor tmux');
      } },
    });
    assert.match(result.response, /已将 `\/p tmux` 解释为 `\/p acp`/);
    assert.equal(launches, 0);
    const saved = f.store.getSession(f.session.id)!;
    assert.equal(saved.runtime?.cursor?.sessionId, 'native-acp');
    assert.equal(saved.runtime?.cursor?.sessionProvider, 'acp');
    assert.equal(resolveEffectiveRuntimeProvider(saved).identity, 'cursor:acp');
  });

  it('keeps the UI provider selector consistent, rejects tmux writes, and prevents bypassing a running-session guard', () => {
    const f = fixture();
    const app = new UiSessionApplication(f.store);
    assert.throws(() => app.updateConfig(f.session.id, { activeRuntime: 'cursor', cursorProvider: 'tmux' }), /只支持 acp/);
    f.store.updateSession(f.session.id, { runtime_status: 'running' });
    assert.throws(() => app.updateConfig(f.session.id, { activeRuntime: 'cursor', cursorProvider: 'acp' }), /请先停止/);
    assert.equal(f.store.getSession(f.session.id)?.runtime?.cursor?.sessionProvider, undefined);
    f.store.updateSession(f.session.id, { runtime_status: 'idle' });
    const updated = app.updateConfig(f.session.id, { activeRuntime: 'cursor', cursorProvider: 'acp' });
    assert.equal(updated.cursorProvider, 'acp');
    assert.equal(f.store.getSession(f.session.id)?.runtime?.cursor?.sessionId, undefined);
  });
});
