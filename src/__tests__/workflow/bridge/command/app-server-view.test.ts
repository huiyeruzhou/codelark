import '../../../setup/test-setup.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { releaseLegacyCodexTmuxWriter, scheduleCodexAppServerView } from '../../../../bridge/command/tmux.js';
import type { CodexAppServerSession } from '../../../../runtime/codex/app-server-registry.js';
import type { BridgeSession, BridgeStore, ChannelChat } from '../../../../domain/index.js';
import { startCodexAppServerView } from '../../../../bridge/tmux/runtime.js';

function setup() {
  let session = { id: 'view-session', runtime: { codex: { threadId: 'thread', appServerEndpoint: 'ws://127.0.0.1:12345' } } } as BridgeSession;
  const binding = { bridgeSessionId: session.id, channelType: 'feishu', chatId: 'view-chat' } as ChannelChat;
  const store = { getSession: () => session, getChannelChat: () => binding,
    updateSession: (_id: string, changes: Partial<BridgeSession>) => { session = { ...session, runtime: {
      ...session.runtime, general: { ...session.runtime?.general, ...changes.runtime?.general },
      codex: { ...session.runtime?.codex, ...changes.runtime?.codex },
    } } as BridgeSession; } } as unknown as BridgeStore;
  const notices: string[] = [];
  const handle = { threadId: 'thread', endpoint: 'ws://127.0.0.1:12345' } as CodexAppServerSession;
  return { options: { store, binding, session, handle, notify: (text: string) => { notices.push(text); } }, notices, getSession: () => session };
}

it('shares one background view start and never restarts an existing view', async () => {
  const s = setup(); let running = false; let starts = 0; let ready!: () => void;
  const deps = {
    hasTmuxSession: async () => ({ exists: running, command: 'stub' }),
    startCodexAppServerView: async (params: { remoteEndpoint?: string; threadId?: string; sessionName: string }) => {
      starts++; assert.equal(params.remoteEndpoint, s.options.handle.endpoint); assert.equal(params.threadId, 'thread');
      await new Promise<void>((resolve) => { ready = resolve; }); running = true;
      return {} as never;
    },
  };
  const first = scheduleCodexAppServerView(s.options, deps);
  const second = scheduleCodexAppServerView(s.options, deps);
  assert.equal(first, second);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(starts, 1); assert.equal(s.notices.length, 0);
  ready(); await first;
  assert.match(s.notices[0]!, /已建立 tmux 查看入口/);
  assert.match(s.getSession().runtime?.general?.tmuxSessionName || '', /-view$/);
  await scheduleCodexAppServerView(s.options, deps);
  assert.equal(starts, 1); assert.equal(s.notices.length, 1);
});

it('reports view failure independently and ignores a stale binding after readiness', async () => {
  const s = setup();
  await scheduleCodexAppServerView(s.options, { hasTmuxSession: async () => ({ exists: false, command: 'stub' }), startCodexAppServerView: async () => { throw new Error('view unavailable'); } });
  assert.match(s.notices[0]!, /对话可继续使用/);
  await scheduleCodexAppServerView(s.options, { hasTmuxSession: async () => ({ exists: false, command: 'stub' }), startCodexAppServerView: async () => { s.options.binding.bridgeSessionId = 'new-session'; return {} as never; } });
  assert.equal(s.notices.length, 1);
  assert.equal(s.getSession().runtime?.general?.tmuxSessionName, undefined);
});

it('releases only the exact provider-owned legacy writer before protocol migration', async () => {
  const s = setup();
  delete s.options.session.runtime!.codex!.appServerEndpoint;
  s.options.session.runtime!.general = { tmuxSessionName: 'codex_thread' };
  const calls: string[] = [];
  await releaseLegacyCodexTmuxWriter(s.options.store, s.options.session, 'thread', async (options) => {
    calls.push(options.sessionName || '');
    return { sessionName: options.sessionName, commands: ['kill'], killed: true };
  });
  assert.deepEqual(calls, ['codex_thread']);
  assert.equal(s.getSession().runtime?.general?.tmuxSessionName, undefined);

  s.options.session.runtime!.general = { tmuxSessionName: 'codex_thread-view' };
  await releaseLegacyCodexTmuxWriter(s.options.store, s.options.session, 'thread', async () => {
    assert.fail('an app-server view is not a legacy writer');
  });

  const failed = setup();
  delete failed.options.session.runtime!.codex!.appServerEndpoint;
  failed.options.session.runtime!.general = { tmuxSessionName: 'codex_thread' };
  await assert.rejects(
    releaseLegacyCodexTmuxWriter(failed.options.store, failed.options.session, 'thread', async () => ({
      sessionName: 'codex_thread', commands: [], killed: false, error: 'permission denied',
    })),
    /无法结束旧 Codex tmux writer.*未恢复线程、未发送输入.*permission denied/,
  );
  assert.equal(failed.getSession().runtime?.general?.tmuxSessionName, 'codex_thread');
});

it('creates a remote view without reading screens, sending keys or killing a pane awaiting manual trust', async () => {
  const calls: string[] = [];
  const core = {
    ensureDetachedSession: async (options: { recreate: boolean; command: string }) => {
      calls.push('create'); assert.equal(options.recreate, false);
      assert.match(options.command, /--remote/); assert.match(options.command, /resume/);
      return { existed: false, commands: ['create'], command: 'create' };
    },
    hasSession: async () => { calls.push('exists'); return { exists: true, command: 'exists' }; },
    capturePane: async () => assert.fail('a view waiting for manual trust must not be screen-probed'),
    sendKeys: async () => assert.fail('a view must not inject menu selections'),
    killSession: async () => assert.fail('a view waiting for manual trust must remain attached'),
  };
  const result = await startCodexAppServerView({ sessionName: 'codex_protocol_view', bridgeSessionId: 'view-session', threadId: 'thread-view', remoteEndpoint: 'ws://127.0.0.1:12345', workingDirectory: '/tmp' }, core as never);
  assert.equal(result.ready, true);
  assert.deepEqual(calls, ['create', 'exists']);
});
