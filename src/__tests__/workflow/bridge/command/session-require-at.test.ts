import '../../../setup/test-setup.js';
import { beforeEach, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CODELARK_HOME } from '../../../../configuration/paths.js';
import { createConfigService } from '../../../../configuration/service.js';
import { runConfigMigrations } from '../../../../configuration/migrations/index.js';
import { sessionRequireMentionMigration } from '../../../../configuration/migrations/session-require-mention.js';
import { resolveConfigPaths, sessionTomlPath } from '../../../../configuration/sources.js';
import { FeishuAdapter } from '../../../../channels/feishu/adapter.js';
import { _testOnlyWaitForDeliveryQueuesForTests } from '../../../../channels/delivery/deliver.js';
import { handleBridgeCommand } from '../../../../bridge/command/dispatch.js';
import { isKnownBridgeCommand, resolveCommandAlias } from '../../../../bridge/command/aliases.js';
import { handleSetCommand, buildSetCommandRichCard } from '../../../../bridge/command/global-settings.js';
import { sessionRequiresMention } from '../../../../bridge/session/require-mention.js';
import * as router from '../../../../bridge/session/channel-router.js';
import { parseUiChannelPayload } from '../../../../operator-ui/application/channel.js';
import { initBridgeTestContext, resetBridgeTestState, RecordingAdapter, inboundMessage } from '../../../helpers/bridge/test-bridge-utils.js';

beforeEach(() => resetBridgeTestState());
const address = (chatId: string) => ({ channelType: 'feishu', chatId, chatKind: 'group' as const, userId: 'user-1' });
const deps = { getActiveTask: () => undefined, diagnoseSessionHealth: async () => null, diagnoseAllActiveSessions: async () => [] };
let commandSequence = 0;
async function command(adapter: RecordingAdapter, chatId: string, text: string, form?: Record<string, string>) {
  const msg = inboundMessage(address(chatId), text, `require-at-${++commandSequence}`);
  if (form) msg.raw = { event: { action: { form_value: form } } };
  await handleBridgeCommand(adapter, msg, text, deps);
  await _testOnlyWaitForDeliveryQueuesForTests(adapter);
  return adapter.sent.at(-1)!;
}
function incoming(chatId: string, id: string, mentions?: Array<{ id: { open_id: string }; key: string }>, chat_type = 'group') {
  return { sender: { sender_type: 'user', sender_id: { open_id: 'user-1' } }, message: {
    message_id: id, chat_id: chatId, chat_type, message_type: 'text', content: JSON.stringify({ text: 'hello' }),
    create_time: String(Date.now()), ...(mentions ? { mentions } : {}),
  } };
}

it('both require_at spellings save only the current session and survive reload without touching channel config', async () => {
  const store = initBridgeTestContext();
  const a = router.createBinding(address('a'), CODELARK_HOME);
  const b = router.createBinding(address('b'), CODELARK_HOME);
  const config = createConfigService({ migrate: false });
  config.set({ kind: 'home' }, { channels: [{ id: 'feishu', provider: 'feishu', config: { requireMention: true } }] });
  const before = fs.readFileSync(path.join(CODELARK_HOME, 'config.toml'), 'utf8');
  const adapter = new RecordingAdapter();
  assert.equal(isKnownBridgeCommand('/require_at'), true);
  assert.equal(resolveCommandAlias('/require_at', 'on'), '/require-at');
  assert.match((await command(adapter, 'a', '/require_at on')).text, /当前会话/);
  assert.equal(sessionRequiresMention(store, address('a')), true);
  assert.equal(sessionRequiresMention(store, address('b')), false);
  assert.match((await command(adapter, 'b', '/require-at show')).text, /当前值.*off/);
  assert.match((await command(adapter, 'a', '/require_at status')).text, /当前值.*on/);
  assert.match((await command(adapter, 'a', '/require_at maybe')).text, /未更新/);
  assert.equal(sessionRequiresMention(store, address('a')), true);
  assert.match((await command(adapter, 'a', '/require-at off')).text, /off/);
  const reloaded = initBridgeTestContext();
  assert.equal(sessionRequiresMention(reloaded, address('a')), false);
  assert.equal(config.resolve('session.requireMention', { kind: 'session', sessionId: a.bridgeSessionId }).source, 'session');
  assert.equal(config.resolve('session.requireMention', { kind: 'session', sessionId: b.bridgeSessionId }).source, 'defaults');
  assert.equal(fs.readFileSync(path.join(CODELARK_HOME, 'config.toml'), 'utf8'), before);
});

it('adapter entry follows live binding/session changes, matching bot mentions, and leaves private/unbound chats unaffected', async () => {
  const store = initBridgeTestContext();
  const a = router.createBinding(address('a'), CODELARK_HOME);
  const b = router.createBinding(address('b'), CODELARK_HOME);
  const adapter = new FeishuAdapter({ id: 'feishu', provider: 'feishu', enabled: true, alias: 'test', config: { requireMention: true } });
  (adapter as any).botIds = new Set(['bot-1']);
  const entry = async (chat: string, id: string, mentions?: Array<{ id: { open_id: string }; key: string }>, kind?: string) => {
    await (adapter as any).processIncomingEvent(incoming(chat, id, mentions, kind));
    return adapter.consumeOne();
  };
  const commands = new RecordingAdapter();
  await command(commands, 'a', '/require_at on');
  assert.equal(await entry('a', 'blocked'), null);
  assert.ok(await entry('b', 'other-session'));
  assert.equal(await entry('a', 'other-bot', [{ id: { open_id: 'other-bot' }, key: '@_user_1' }]), null);
  assert.ok(await entry('a', 'own-bot', [{ id: { open_id: 'bot-1' }, key: '@_user_1' }]));
  assert.ok(await entry('a', 'private', undefined, 'p2p'));
  assert.ok(await entry('unbound', 'new-chat'));
  assert.equal(store.getChannelChat('feishu', 'unbound'), null);
  await command(commands, 'a', '/require-at off');
  assert.ok(await entry('a', 'now-open'));
  await command(commands, 'a', '/require-at on');
  const unbound = store.createSession('unbound target', '', undefined, CODELARK_HOME);
  store.updateChannelChat(a.id, { bridgeSessionId: unbound.id });
  assert.ok(await entry('a', 'after-rebind'));
});

it('current common form and command share the session field; global/channel editors no longer offer writes', async () => {
  const store = initBridgeTestContext();
  router.createBinding(address('a'), CODELARK_HOME);
  const adapter = new RecordingAdapter();
  const current = await command(adapter, 'a', '/current common');
  assert.ok(current.richCard?.form?.selects?.some((select) => select.elementId === 'requireMention'));
  await command(adapter, 'a', '/current-config common', { req_mention: 'on' });
  assert.equal(sessionRequiresMention(store, address('a')), true);
  assert.match((await command(adapter, 'a', '/require-at')).text, /on/);
  await command(adapter, 'a', '/current-config common', { req_mention: 'off' });
  assert.equal(sessionRequiresMention(store, address('a')), false);
  assert.match(handleSetCommand({ args: 'requireMention on', markdown: true }), /属于会话配置/);
  assert.doesNotMatch(JSON.stringify(buildSetCommandRichCard('channels.feishu')), /req_mention|requireMention/);
  assert.throws(() => parseUiChannelPayload({ provider: 'feishu', requireMention: true }));
  assert.throws(() => createConfigService({ migrate: false }).set({ kind: 'home' }, { session: { requireMention: true } }), /不能|不允许/);
});

for (const action of ['clear', 'new'] as const) for (const value of [true, false]) {
  it(`${action} inherits session require-at=${value} independently of legacy channel value and reload`, async () => {
    initBridgeTestContext();
    router.createBinding(address('source'), CODELARK_HOME);
    createConfigService({ migrate: false }).set({ kind: 'home' }, {
      channels: [{ id: 'feishu', provider: 'feishu', config: { requireMention: !value } }],
    });
    const adapter = new RecordingAdapter();
    await command(adapter, 'source', `/require_at ${value ? 'on' : 'off'}`);
    await command(adapter, 'source', `/${action} child`);
    const chat = action === 'clear' ? 'source' : adapter.createdGroups[0]?.chatId;
    assert.ok(chat);
    const reloaded = initBridgeTestContext();
    const target = reloaded.getChannelChat('feishu', chat)!;
    const config = createConfigService({ migrate: false }).resolve('session.requireMention', { kind: 'session', sessionId: target.bridgeSessionId });
    assert.equal(config.value, value);
    assert.equal(config.source, 'session');
    assert.equal(sessionRequiresMention(reloaded, address(chat)), value);
  });
}

it('legacy channel migration preserves explicit false, resolves shared-session conflicts deterministically, and runs once', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codelark-require-at-migration-'));
  try {
    const config = createConfigService({ codelarkHome: home, migrate: false, env: {} });
    config.set({ kind: 'home' }, { channels: [
      { id: 'a', provider: 'feishu', config: { requireMention: false } },
      { id: 'b', provider: 'feishu', config: { requireMention: true } },
    ] });
    config.set({ kind: 'session', sessionId: 'explicit' }, { session: { requireMention: false, tmuxCaptureLines: 123 } });
    config.set({ kind: 'session', sessionId: 'offOnly' }, { session: { tmuxCaptureLines: 222 } });
    fs.mkdirSync(path.join(home, 'data'), { recursive: true });
    fs.writeFileSync(path.join(home, 'data/sessions.json'), JSON.stringify({ shared: {}, explicit: {}, savedRuntime: {}, offOnly: {}, unbound: {} }));
    const bindings = { off: { channelType: 'a', bridgeSessionId: 'offOnly' }, one: { channelType: 'a', bridgeSessionId: 'shared' },
      two: { channelType: 'b', bridgeSessionId: 'shared', runtimeBridgeSessionIds: { claude: 'savedRuntime', codex: 'explicit' } } };
    fs.writeFileSync(path.join(home, 'data/channel-chats.json'), JSON.stringify(bindings));
    const first = runConfigMigrations({ codelarkHome: home, migrations: [sessionRequireMentionMigration] });
    assert.equal(first.applied.length, 1);
    assert.equal(first.warnings.length, 1);
    assert.match(first.warnings[0], /shared.*冲突.*on/);
    const value = (id: string) => config.get('session.requireMention', { kind: 'session', sessionId: id });
    assert.equal(value('shared'), true);
    assert.equal(value('explicit'), false);
    assert.equal(value('savedRuntime'), true);
    assert.equal(value('offOnly'), false);
    assert.equal(config.resolve('session.requireMention', { kind: 'session', sessionId: 'offOnly' }).source, 'session');
    assert.equal(config.get('session.tmuxCaptureLines', { kind: 'session', sessionId: 'offOnly' }), 222);
    assert.equal(value('unbound'), false);
    assert.equal(config.get('session.tmuxCaptureLines', { kind: 'session', sessionId: 'explicit' }), 123);
    const migrated = fs.readFileSync(sessionTomlPath(resolveConfigPaths({ codelarkHome: home }), 'shared'), 'utf8');
    config.set({ kind: 'home' }, { channels: [{ id: 'b', config: { requireMention: false } }] });
    const second = runConfigMigrations({ codelarkHome: home, migrations: [sessionRequireMentionMigration] });
    assert.equal(second.applied.length, 0);
    assert.equal(value('shared'), true);
    assert.equal(fs.readFileSync(sessionTomlPath(resolveConfigPaths({ codelarkHome: home }), 'shared'), 'utf8'), migrated);
    assert.ok(fs.existsSync(path.join(home, 'backups/config-migrations/v2/config.toml')));
    const backedUpSession = fs.readFileSync(path.join(home, 'backups/config-migrations/v2/config/sessions/offOnly.toml'), 'utf8');
    assert.match(backedUpSession, /tmux_capture_lines = 222/);
    assert.doesNotMatch(backedUpSession, /require_mention/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});


it('migration stamps an empty installation before later bindings exist, so old channel defaults never leak into future sessions', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codelark-require-at-fresh-'));
  try {
    const first = runConfigMigrations({ codelarkHome: home, migrations: [sessionRequireMentionMigration] });
    assert.equal(first.applied.length, 1);
    const config = createConfigService({ codelarkHome: home, migrate: false, env: {} });
    config.set({ kind: 'home' }, { channels: [{ id: 'a', provider: 'feishu', config: { requireMention: true } }] });
    fs.mkdirSync(path.join(home, 'data'), { recursive: true });
    fs.writeFileSync(path.join(home, 'data/sessions.json'), JSON.stringify({ future: {} }));
    fs.writeFileSync(path.join(home, 'data/channel-chats.json'), JSON.stringify({ a: { channelType: 'a', bridgeSessionId: 'future' } }));
    assert.equal(runConfigMigrations({ codelarkHome: home, migrations: [sessionRequireMentionMigration] }).applied.length, 0);
    assert.equal(config.get('session.requireMention', { kind: 'session', sessionId: 'future' }), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
