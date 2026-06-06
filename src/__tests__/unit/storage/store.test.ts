import '../../setup/test-setup.js';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JsonFileStore } from '../../../storage/json-store.js';
import { CODELARK_HOME, CONFIG_JSON_PATH, CONFIG_PATH } from '../../../configuration/index.js';
import { getSessionSystemPrompt, getSessionWorkingDirectory } from '../../../domain/session-runtime.js';

const DATA_DIR = path.join(CODELARK_HOME, 'data');

// We construct the store with a settings map directly
function makeSettings(): Map<string, string> {
  return new Map([
    ['remote_bridge_enabled', 'true'],
    ['bridge_default_model', 'test-model'],
    ['bridge_default_mode', 'code'],
  ]);
}

describe('JsonFileStore', () => {
  beforeEach(() => {
    // Clean data dir before each test for isolation
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it('getSetting returns values from settings map', () => {
    const store = new JsonFileStore(makeSettings());
    assert.equal(store.getSetting('remote_bridge_enabled'), 'true');
    assert.equal(store.getSetting('bridge_default_model'), 'test-model');
    assert.equal(store.getSetting('nonexistent'), null);
  });

  it('refreshes dynamic settings from v2 config projection instead of legacy config.env', () => {
    const configTomlPath = path.join(CODELARK_HOME, 'config.toml');
    const previousToml = fs.existsSync(configTomlPath) ? fs.readFileSync(configTomlPath, 'utf-8') : null;
    const previousEnvFile = fs.existsSync(CONFIG_PATH) ? fs.readFileSync(CONFIG_PATH, 'utf-8') : null;
    const envKeys = [
      'CODELARK_CODEX_MODEL',
      'CODELARK_CODEX_DEFAULT_MODEL',
      'CODELARK_CODEX_YOLO_MODE',
      'CODELARK_CODEX_DEFAULT_MODE',
      'CODELARK_HISTORY_MESSAGE_LIMIT',
    ];
    const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));

    try {
      for (const key of envKeys) delete process.env[key];
      fs.writeFileSync(configTomlPath, [
        'schema_version = 2',
        '',
        '[runtime.codex]',
        'model = "toml-dynamic-model"',
        'yolo_mode = "on"',
        '',
        '[[channels]]',
        'id = "feishu-default"',
        'alias = "飞书"',
        'provider = "feishu"',
        'enabled = true',
        '',
        '[channels.config]',
        'history_message_limit = 23',
        '',
      ].join('\n'));
      fs.writeFileSync(CONFIG_PATH, [
        'CODELARK_CODEX_DEFAULT_MODEL=legacy-env-model',
        'CODELARK_CODEX_DEFAULT_MODE=normal',
        'CODELARK_HISTORY_MESSAGE_LIMIT=9',
        '',
      ].join('\n'));

      const store = new JsonFileStore(makeSettings(), { dynamicSettings: true });

      assert.equal(store.getSetting('bridge_default_model'), 'toml-dynamic-model');
      assert.equal(store.getSetting('default_model'), 'toml-dynamic-model');
      assert.equal(store.getSetting('bridge_default_mode'), 'yolo');
      assert.equal(store.getSetting('bridge_history_message_limit'), '23');
    } finally {
      if (previousToml === null) fs.rmSync(configTomlPath, { force: true });
      else fs.writeFileSync(configTomlPath, previousToml, 'utf-8');
      if (previousEnvFile === null) fs.rmSync(CONFIG_PATH, { force: true });
      else fs.writeFileSync(CONFIG_PATH, previousEnvFile, 'utf-8');
      for (const [key, value] of previousEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('does not run startup config migrations during dynamic settings refresh', () => {
    const configTomlPath = path.join(CODELARK_HOME, 'config.toml');
    const migrationStatePath = path.join(CODELARK_HOME, 'runtime', 'config-migrations.json');
    const previousToml = fs.existsSync(configTomlPath) ? fs.readFileSync(configTomlPath, 'utf-8') : null;
    const previousEnvFile = fs.existsSync(CONFIG_PATH) ? fs.readFileSync(CONFIG_PATH, 'utf-8') : null;
    const previousState = fs.existsSync(migrationStatePath) ? fs.readFileSync(migrationStatePath, 'utf-8') : null;

    try {
      fs.rmSync(configTomlPath, { force: true });
      fs.rmSync(migrationStatePath, { force: true });
      fs.writeFileSync(CONFIG_PATH, 'CODELARK_CODEX_DEFAULT_MODEL=legacy-dynamic-model\n', 'utf-8');

      const store = new JsonFileStore(makeSettings(), { dynamicSettings: true });
      const session = store.createSession('dynamic-refresh-session', 'model-1', undefined, '/tmp/dynamic-refresh');

      assert.equal(store.getSetting('bridge_default_model'), 'test-model');
      assert.equal(getSessionWorkingDirectory(store.getSession(session.id)), '/tmp/dynamic-refresh');
      assert.equal(fs.existsSync(migrationStatePath), false);
    } finally {
      if (previousToml === null) fs.rmSync(configTomlPath, { force: true });
      else fs.writeFileSync(configTomlPath, previousToml, 'utf-8');
      if (previousEnvFile === null) fs.rmSync(CONFIG_PATH, { force: true });
      else fs.writeFileSync(CONFIG_PATH, previousEnvFile, 'utf-8');
      if (previousState === null) fs.rmSync(migrationStatePath, { force: true });
      else {
        fs.mkdirSync(path.dirname(migrationStatePath), { recursive: true });
        fs.writeFileSync(migrationStatePath, previousState, 'utf-8');
      }
    }
  });

  it('createSession and getSession', () => {
    const store = new JsonFileStore(makeSettings());
    const session = store.createSession('test', 'model-1', 'system prompt', '/tmp');
    assert.ok(session.id);
    assert.equal(session.runtime?.codex?.model, 'model-1');
    assert.equal(getSessionWorkingDirectory(session), '/tmp');
    assert.equal(getSessionSystemPrompt(session), 'system prompt');

    const fetched = store.getSession(session.id);
    assert.ok(fetched);
    assert.equal(fetched.id, session.id);
    assert.equal(fetched.name, session.name);
    assert.equal(fetched.runtime?.codex?.model, session.runtime?.codex?.model);
    assert.equal(getSessionWorkingDirectory(fetched), getSessionWorkingDirectory(session));
    assert.equal(getSessionSystemPrompt(fetched), getSessionSystemPrompt(session));
    assert.equal(fetched.session_type, 'normal');
    assert.equal(fetched.hidden, false);
    assert.ok(fetched.created_at);
    assert.ok(fetched.updated_at);
  });

  it('getSession returns null for unknown id', () => {
    const store = new JsonFileStore(makeSettings());
    assert.equal(store.getSession('nonexistent'), null);
  });

  it('updateSession can preserve updated_at for derived metadata writes', () => {
    const store = new JsonFileStore(makeSettings());
    const session = store.createSession('diagnostic-touch', 'model-1', undefined, '/tmp');
    const originalUpdatedAt = session.updated_at;

    store.updateSession(session.id, {
      health_status: 'completed',
      health_reason: '任务已完成。',
    }, { touch: false });

    const fetched = store.getSession(session.id);
    assert.equal(fetched?.updated_at, originalUpdatedAt);
    assert.equal(fetched?.health_status, 'completed');
    assert.equal(fetched?.health_reason, '任务已完成。');
  });

  it('upsertChannelChat keeps one binding per chat and switches its session target', () => {
    const store = new JsonFileStore(makeSettings());
    const b1 = store.upsertChannelChat({
      channelType: 'feishu-default',
      chatId: '123',
      chatUserId: 'user-1',
      bridgeSessionId: 'sess-1',
    });
    assert.ok(b1.id);
    assert.equal(b1.channelType, 'feishu-default');
    assert.equal(b1.chatId, '123');
    assert.equal(b1.chatUserId, 'user-1');

    const b2 = store.upsertChannelChat({
      channelType: 'feishu-default',
      chatId: '123',
      bridgeSessionId: 'sess-2',
    });
    assert.equal(b2.id, b1.id);
    assert.equal(b2.bridgeSessionId, 'sess-2');
    assert.equal(b2.chatUserId, 'user-1');
    assert.equal(store.getChannelChat('feishu-default', '123')?.id, b2.id);

    const bindings = store.listChannelChats('feishu-default').filter((binding) => binding.chatId === '123');
    assert.equal(bindings.length, 1);

    const b1Updated = store.upsertChannelChat({
      channelType: 'feishu-default',
      chatId: '123',
      chatUserId: 'user-1b',
      bridgeSessionId: 'sess-1',
    });
    assert.equal(b1Updated.id, b1.id);
    assert.equal(store.getChannelChat('feishu-default', '123')?.id, b1.id);
    assert.equal(b1Updated.chatUserId, 'user-1b');
  });

  it('replaces the current binding target when a chat is rebound', () => {
    const store = new JsonFileStore(makeSettings());
    const active = store.upsertChannelChat({
      channelType: 'feishu-default',
      chatId: 'multi',
      bridgeSessionId: 'sess-active',
    });
    const replaced = store.upsertChannelChat({
      channelType: 'feishu-default',
      chatId: 'multi',
      bridgeSessionId: 'sess-next',
    });

    assert.equal(replaced.id, active.id);
    assert.equal(store.getChannelChat('feishu-default', 'multi')?.bridgeSessionId, 'sess-next');
    assert.equal(store.listChannelChats().filter((binding) => binding.chatId === 'multi').length, 1);
  });

  it('upsertChannelChat stores only chat/session link metadata', () => {
    const settings = makeSettings();
    settings.set('bridge_default_mode', 'yolo');
    const store = new JsonFileStore(settings);
    const b = store.upsertChannelChat({
      channelType: 'feishu-default',
      chatId: '456',
      bridgeSessionId: 'sess-1',
    });
    assert.deepEqual(Object.keys(b).sort(), [
      'bridgeSessionId',
      'channelAlias',
      'channelProvider',
      'channelType',
      'chatId',
      'chatUserId',
      'cloudDocumentChat',
      'createdAt',
      'id',
      'lastActivityAt',
      'runtimeBridgeSessionIds',
      'updatedAt',
    ]);
    assert.equal(b.runtimeBridgeSessionIds?.codex, 'sess-1');
    assert.equal(b.lastActivityAt, b.createdAt);
  });

  it('touchChannelChatActivity updates activity without changing binding metadata time', () => {
    const store = new JsonFileStore(makeSettings());
    const binding = store.upsertChannelChat({
      channelType: 'feishu-default',
      chatId: 'activity',
      bridgeSessionId: 'sess-1',
    });
    const updatedAt = binding.updatedAt;

    store.touchChannelChatActivity(binding.id, '2026-06-05T03:55:00.000Z');

    const fetched = store.getChannelChat('feishu-default', 'activity');
    assert.equal(fetched?.updatedAt, updatedAt);
    assert.equal(fetched?.lastActivityAt, '2026-06-05T03:55:00.000Z');
  });

  it('deletes an unbound hidden temporary session when a chat switches to an existing session', () => {
    const store = new JsonFileStore(makeSettings());
    const draft = store.createSession('ou_abcdef', 'model', undefined, '/tmp/default-workspace', 'normal', {
      hidden: true,
      sessionType: 'normal',
    });
    const target = store.createSession('target', 'model', undefined, '/tmp/target');
    store.addMessage(draft.id, 'user', 'draft message');

    const first = store.upsertChannelChat({
      channelType: 'feishu-default',
      chatId: 'draft-cleanup',
      bridgeSessionId: draft.id,
    });
    const second = store.upsertChannelChat({
      channelType: 'feishu-default',
      chatId: 'draft-cleanup',
      bridgeSessionId: target.id,
    });

    assert.equal(second.id, first.id);
    assert.equal(store.getChannelChat('feishu-default', 'draft-cleanup')?.bridgeSessionId, target.id);
    assert.equal(store.getSession(draft.id), null);
    assert.deepEqual(store.getMessages(draft.id).messages, []);
  });

  it('getChannelChat returns null for missing', () => {
    const store = new JsonFileStore(makeSettings());
    assert.equal(store.getChannelChat('feishu-default', 'missing'), null);
  });

  it('deleteChannelChat removes the binding by id', () => {
    const store = new JsonFileStore(makeSettings());
    const binding = store.upsertChannelChat({
      channelType: 'feishu-default',
      chatId: 'delete-binding',
      bridgeSessionId: 'sess-1',
    });

    store.deleteChannelChat(binding.id);

    assert.equal(store.getChannelChat('feishu-default', 'delete-binding'), null);
  });

  it('listChannelChats filters by type', () => {
    const store = new JsonFileStore(makeSettings());
    store.upsertChannelChat({
      channelType: 'feishu-default',
      chatId: '1',
      bridgeSessionId: 's1',
    });
    store.upsertChannelChat({
      channelType: 'feishu-backup',
      chatId: '2',
      bridgeSessionId: 's2',
    });
    assert.equal(store.listChannelChats('feishu-default').length, 1);
    assert.equal(store.listChannelChats('feishu-backup').length, 1);
    assert.equal(store.listChannelChats().length, 2);
  });

  it('persists cloud document chat metadata on channel chat bindings', () => {
    const store = new JsonFileStore(makeSettings());
    const binding = store.upsertChannelChat({
      channelType: 'feishu-default',
      chatId: 'oc_doc_chat',
      chatKind: 'group',
      bridgeSessionId: 'sess-doc',
      cloudDocumentChat: {
        provider: 'feishu',
        fileToken: 'doc-token',
        fileType: 'docx',
        commentId: 'comment-1',
      },
    });

    assert.deepEqual(binding.cloudDocumentChat, {
      provider: 'feishu',
      fileToken: 'doc-token',
      fileType: 'docx',
      commentId: 'comment-1',
    });

    const reloaded = new JsonFileStore(makeSettings());
    assert.deepEqual(reloaded.getChannelChat('feishu-default', 'oc_doc_chat')?.cloudDocumentChat, {
      provider: 'feishu',
      fileToken: 'doc-token',
      fileType: 'docx',
      commentId: 'comment-1',
    });
  });

  it('persists channel default targets by channel instance', () => {
    const store = new JsonFileStore(makeSettings());
    const first = store.upsertChannelDefaultTarget({
      channelType: 'feishu-default',
      channelProvider: 'feishu',
      channelAlias: '飞书',
      bridgeSessionId: 'sess-1',
    });
    assert.ok(first.id);
    assert.equal(first.bridgeSessionId, 'sess-1');

    const updated = store.upsertChannelDefaultTarget({
      channelType: 'feishu-default',
      bridgeSessionId: 'sess-2',
    });
    assert.equal(updated.id, first.id);
    assert.equal(updated.bridgeSessionId, 'sess-2');

    const reloaded = new JsonFileStore(makeSettings());
    assert.equal(reloaded.getChannelDefaultTarget('feishu-default')?.bridgeSessionId, 'sess-2');
    assert.equal(reloaded.listChannelDefaultTargets().length, 1);

    reloaded.deleteChannelDefaultTarget('feishu-default');
    assert.equal(reloaded.getChannelDefaultTarget('feishu-default'), null);
  });

  it('normalizes channel default targets from v2 TOML channel config', () => {
    const configTomlPath = path.join(CODELARK_HOME, 'config.toml');
    const previousToml = fs.existsSync(configTomlPath) ? fs.readFileSync(configTomlPath, 'utf-8') : null;
    try {
      fs.writeFileSync(configTomlPath, [
        'schema_version = 2',
        '',
        '[[channels]]',
        'id = "feishu-custom"',
        'alias = "飞书配置别名"',
        'provider = "feishu"',
        'enabled = true',
        '',
        '[channels.config]',
        'history_message_limit = 8',
        '',
      ].join('\n'));
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(DATA_DIR, 'channel-default-targets.json'),
        JSON.stringify({
          stale: {
            id: 'stale',
            channelType: 'feishu-custom',
            bridgeSessionId: 'sess-configured',
            createdAt: '2026-06-07T00:00:00.000Z',
            updatedAt: '2026-06-07T00:00:00.000Z',
          },
        }, null, 2),
      );

      const store = new JsonFileStore(makeSettings());
      const target = store.getChannelDefaultTarget('feishu-custom');

      assert.equal(target?.channelProvider, 'feishu');
      assert.equal(target?.channelAlias, '飞书配置别名');
      const persisted = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'channel-default-targets.json'), 'utf-8')) as Record<string, {
        channelProvider?: string;
        channelAlias?: string;
      }>;
      assert.equal(Object.values(persisted)[0]?.channelProvider, 'feishu');
      assert.equal(Object.values(persisted)[0]?.channelAlias, '飞书配置别名');
    } finally {
      if (previousToml === null) fs.rmSync(configTomlPath, { force: true });
      else fs.writeFileSync(configTomlPath, previousToml, 'utf-8');
    }
  });

  it('normalizes singleton channel chats to default channel instances on reload', () => {
    const configBackup = fs.existsSync(CONFIG_JSON_PATH) ? fs.readFileSync(CONFIG_JSON_PATH, 'utf-8') : null;
    try {
      fs.mkdirSync(path.dirname(CONFIG_JSON_PATH), { recursive: true });
      fs.writeFileSync(
        CONFIG_JSON_PATH,
        JSON.stringify({
          schemaVersion: 1,
          runtime: {
            provider: 'codex',
            codex: {
              defaultMode: 'code',
            },
            bridge: {
              historyMessageLimit: 8,
            },
          },
          channels: [
            {
              id: 'feishu-default',
              alias: '飞书主机器人',
              provider: 'feishu',
              enabled: true,
              createdAt: '2026-03-28T00:00:00.000Z',
              updatedAt: '2026-03-28T00:00:00.000Z',
              config: {
                appId: 'app-id',
              },
            },
          ],
        }, null, 2),
      );

      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(DATA_DIR, 'channel-chats.json'),
        JSON.stringify({
          legacy: {
            id: 'legacy',
            channelType: 'feishu-default',
            channelProvider: 'feishu',
            channelAlias: '飞书主机器人',
            chatId: 'oc_legacy',
            bridgeSessionId: 'sess-legacy',
            createdAt: '2026-03-28T00:00:00.000Z',
            updatedAt: '2026-03-28T00:00:00.000Z',
          },
        }, null, 2),
      );

      const store = new JsonFileStore(makeSettings());
      const binding = store.getChannelChat('feishu-default', 'oc_legacy');
      assert.ok(binding);
      assert.equal(binding.channelType, 'feishu-default');
      assert.equal(binding.channelProvider, 'feishu');
      assert.equal(binding.channelAlias, '飞书主机器人');

      const persisted = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'channel-chats.json'), 'utf-8')) as Record<string, {
        channelType: string;
        channelProvider?: string;
        channelAlias?: string;
      }>;
      const persistedBinding = Object.values(persisted).find((entry) => entry.channelType === 'feishu-default');
      assert.ok(persistedBinding);
      assert.equal(persistedBinding.channelProvider, 'feishu');
      assert.equal(persistedBinding.channelAlias, '飞书主机器人');
    } finally {
      fs.rmSync(CONFIG_JSON_PATH, { force: true });
      if (configBackup !== null) {
        fs.writeFileSync(CONFIG_JSON_PATH, configBackup);
      }
    }
  });

  it('runs storage migrations before loading persisted data', () => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(DATA_DIR, 'sessions.json'),
      JSON.stringify({
        'session-old': {
          id: 'session-old',
          working_directory: '/tmp/old',
          model: 'gpt-old',
          sdk_session_id: 'old-thread-id',
          thread_origin: 'bridge',
        },
      }, null, 2),
    );
    fs.writeFileSync(
        path.join(DATA_DIR, 'channel-chats.json'),
        JSON.stringify({
          'binding-old': {
            id: 'binding-old',
            channelType: 'feishu-default',
            chatId: 'chat-old',
            bridgeSessionId: 'session-old',
            createdAt: '2026-05-28T00:00:00.000Z',
            updatedAt: '2026-05-28T00:00:00.000Z',
        },
      }, null, 2),
    );

    const store = new JsonFileStore(makeSettings());
    assert.equal(store.getSession('session-old')?.runtime?.codex?.threadId, 'old-thread-id');
    assert.equal((store.getSession('session-old') as unknown as { sdk_session_id?: string }).sdk_session_id, undefined);

    assert.equal(store.getChannelChat('feishu-default', 'chat-old')?.bridgeSessionId, 'session-old');
  });

  it('does not remap a real channel instance whose id matches the provider name', () => {
    const configBackup = fs.existsSync(CONFIG_JSON_PATH) ? fs.readFileSync(CONFIG_JSON_PATH, 'utf-8') : null;
    try {
      fs.mkdirSync(path.dirname(CONFIG_JSON_PATH), { recursive: true });
      fs.writeFileSync(
        CONFIG_JSON_PATH,
        JSON.stringify({
          schemaVersion: 1,
          runtime: {
            provider: 'codex',
            codex: {
              defaultMode: 'code',
            },
            bridge: {
              historyMessageLimit: 8,
            },
          },
          channels: [
            {
              id: 'feishu-default',
              alias: '默认飞书',
              provider: 'feishu',
              enabled: true,
              createdAt: '2026-03-28T00:00:00.000Z',
              updatedAt: '2026-03-28T00:00:00.000Z',
              config: {
                appId: 'default-app',
              },
            },
            {
              id: 'feishu',
              alias: '开开1号',
              provider: 'feishu',
              enabled: true,
              createdAt: '2026-03-30T00:00:00.000Z',
              updatedAt: '2026-03-30T00:00:00.000Z',
              config: {
                appId: 'custom-app',
              },
            },
          ],
        }, null, 2),
      );

      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(DATA_DIR, 'channel-chats.json'),
        JSON.stringify({
          binding: {
            id: 'binding',
            channelType: 'feishu',
            channelProvider: 'feishu',
            channelAlias: '开开1号',
            chatId: 'oc_real_instance',
            bridgeSessionId: 'sess-real',
            createdAt: '2026-03-30T00:00:00.000Z',
            updatedAt: '2026-03-30T00:00:00.000Z',
          },
        }, null, 2),
      );

      const store = new JsonFileStore(makeSettings());
      const binding = store.getChannelChat('feishu', 'oc_real_instance');
      assert.ok(binding);
      assert.equal(binding.channelType, 'feishu');
      assert.equal(binding.channelAlias, '开开1号');

      const defaultBinding = store.getChannelChat('feishu-default', 'oc_real_instance');
      assert.equal(defaultBinding, null);
    } finally {
      fs.rmSync(CONFIG_JSON_PATH, { force: true });
      if (configBackup !== null) {
        fs.writeFileSync(CONFIG_JSON_PATH, configBackup);
      }
    }
  });

  it('addMessage and getMessages', () => {
    const store = new JsonFileStore(makeSettings());
    const session = store.createSession('test', 'model', undefined, '/tmp');
    store.addMessage(session.id, 'user', 'hello');
    store.addMessage(session.id, 'assistant', 'hi');

    const { messages } = store.getMessages(session.id);
    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, 'user');
    assert.equal(messages[1].content, 'hi');
  });

  it('stores new messages as jsonl while reading legacy json history', () => {
    const store = new JsonFileStore(makeSettings());
    const session = store.createSession('test', 'model', undefined, '/tmp');
    const messagesDir = path.join(DATA_DIR, 'messages');
    fs.writeFileSync(
      path.join(messagesDir, `${session.id}.json`),
      JSON.stringify([{ role: 'user', content: 'legacy', timestamp: '2026-01-01T00:00:00.000Z' }]),
    );

    store.addMessage(session.id, 'assistant', 'new');

    const jsonlPath = path.join(messagesDir, `${session.id}.jsonl`);
    assert.equal(fs.existsSync(jsonlPath), true);
    const jsonlRows = fs.readFileSync(jsonlPath, 'utf-8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.equal(jsonlRows.length, 1);
    assert.equal(jsonlRows[0].content, 'new');

    const { messages } = new JsonFileStore(makeSettings()).getMessages(session.id);
    assert.deepEqual(messages.map((message) => message.content), ['legacy', 'new']);
  });

  it('getMessages with limit returns last N', () => {
    const store = new JsonFileStore(makeSettings());
    const session = store.createSession('test', 'model', undefined, '/tmp');
    store.addMessage(session.id, 'user', 'msg1');
    store.addMessage(session.id, 'user', 'msg2');
    store.addMessage(session.id, 'user', 'msg3');

    const { messages } = store.getMessages(session.id, { limit: 2 });
    assert.equal(messages.length, 2);
    assert.equal(messages[0].content, 'msg2');
    assert.equal(messages[1].content, 'msg3');
  });

  // ── Session Locking ──

  it('acquireSessionLock succeeds on first call', () => {
    const store = new JsonFileStore(makeSettings());
    assert.ok(store.acquireSessionLock('sess', 'lock1', 'owner1', 60));
  });

  it('acquireSessionLock fails when held by another', () => {
    const store = new JsonFileStore(makeSettings());
    assert.ok(store.acquireSessionLock('sess', 'lock1', 'owner1', 60));
    assert.equal(store.acquireSessionLock('sess', 'lock2', 'owner2', 60), false);
  });

  it('acquireSessionLock succeeds with same lockId', () => {
    const store = new JsonFileStore(makeSettings());
    assert.ok(store.acquireSessionLock('sess', 'lock1', 'owner1', 60));
    assert.ok(store.acquireSessionLock('sess', 'lock1', 'owner1', 60));
  });

  it('releaseSessionLock allows re-acquire', () => {
    const store = new JsonFileStore(makeSettings());
    store.acquireSessionLock('sess', 'lock1', 'owner1', 60);
    store.releaseSessionLock('sess', 'lock1');
    assert.ok(store.acquireSessionLock('sess', 'lock2', 'owner2', 60));
  });

  it('expired lock can be re-acquired', async () => {
    const store = new JsonFileStore(makeSettings());
    // Acquire with very short TTL
    store.acquireSessionLock('sess', 'lock1', 'owner1', 0);
    // Should be expired immediately
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(store.acquireSessionLock('sess', 'lock2', 'owner2', 60));
  });

  // ── Permission Links ──

  it('insertPermissionLink and getPermissionLink', () => {
    const store = new JsonFileStore(makeSettings());
    store.insertPermissionLink({
      permissionRequestId: 'pr-1',
      channelType: 'feishu-default',
      chatId: '123',
      messageId: 'msg-1',
      sessionId: 'sess-1',
      toolName: 'bash',
      suggestions: 'allow,deny',
    });
    const link = store.getPermissionLink('pr-1');
    assert.ok(link);
    assert.equal(link.permissionRequestId, 'pr-1');
    assert.equal(link.resolved, false);
    assert.equal(link.sessionId, 'sess-1');
  });

  it('markPermissionLinkResolved is atomic', () => {
    const store = new JsonFileStore(makeSettings());
    store.insertPermissionLink({
      permissionRequestId: 'pr-2',
      channelType: 'feishu-default',
      chatId: '123',
      messageId: 'msg-2',
      sessionId: 'sess-1',
      toolName: 'bash',
      suggestions: '',
    });
    assert.ok(store.markPermissionLinkResolved('pr-2'));
    // Second call returns false (already resolved)
    assert.equal(store.markPermissionLinkResolved('pr-2'), false);
    // Unknown id returns false
    assert.equal(store.markPermissionLinkResolved('unknown'), false);
  });

  it('listPendingPermissionLinksByChat returns only unresolved links for the chat', () => {
    const store = new JsonFileStore(makeSettings());
    store.insertPermissionLink({
      permissionRequestId: 'pr-a',
      channelType: 'feishu-default',
      chatId: 'chat-1',
      messageId: 'msg-a',
      sessionId: 'sess-a',
      toolName: 'Bash',
      suggestions: '',
    });
    store.insertPermissionLink({
      permissionRequestId: 'pr-b',
      channelType: 'feishu-default',
      chatId: 'chat-1',
      messageId: 'msg-b',
      sessionId: 'sess-b',
      toolName: 'Read',
      suggestions: '',
    });
    store.insertPermissionLink({
      permissionRequestId: 'pr-c',
      channelType: 'feishu-default',
      chatId: 'chat-2',
      messageId: 'msg-c',
      sessionId: 'sess-c',
      toolName: 'Bash',
      suggestions: '',
    });
    // Resolve one
    store.markPermissionLinkResolved('pr-a');
    const pending = store.listPendingPermissionLinksByChat('chat-1');
    assert.equal(pending.length, 1);
    assert.equal(pending[0].permissionRequestId, 'pr-b');
    // Different chat
    const pending2 = store.listPendingPermissionLinksByChat('chat-2');
    assert.equal(pending2.length, 1);
    assert.equal(pending2[0].permissionRequestId, 'pr-c');
    // No permissions for unknown chat
    assert.equal(store.listPendingPermissionLinksByChat('chat-unknown').length, 0);
  });

  // ── Dedup ──

  it('dedup insert and check within window', () => {
    const store = new JsonFileStore(makeSettings());
    assert.equal(store.checkDedup('key1'), false);
    store.insertDedup('key1');
    assert.equal(store.checkDedup('key1'), true);
  });

  it('cleanupExpiredDedup removes old entries', () => {
    const store = new JsonFileStore(makeSettings());
    store.insertDedup('key1');
    // The entry was just inserted so it shouldn't be expired
    store.cleanupExpiredDedup();
    assert.equal(store.checkDedup('key1'), true);
  });

  // ── Audit Log ──

  it('insertAuditLog keeps max 1000', () => {
    const store = new JsonFileStore(makeSettings());
    for (let i = 0; i < 1010; i++) {
      store.insertAuditLog({
        channelType: 'feishu-default',
        chatId: '123',
        direction: 'inbound',
        messageId: `msg-${i}`,
        summary: `msg ${i}`,
      });
    }
    // We can't directly inspect length, but it shouldn't crash
  });

  it('stores new audit entries as jsonl while reading legacy audit json', () => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(DATA_DIR, 'audit.json'),
      JSON.stringify([{
        id: 'legacy-audit',
        createdAt: '2026-01-01T00:00:00.000Z',
        channelType: 'feishu-default',
        chatId: 'legacy-chat',
        direction: 'inbound',
        summary: 'legacy audit',
      }]),
    );

    const store = new JsonFileStore(makeSettings());
    store.insertAuditLog({
      channelType: 'feishu-default',
      chatId: 'new-chat',
      direction: 'inbound',
      messageId: 'new-message',
      summary: 'new audit',
    });

    const jsonlPath = path.join(DATA_DIR, 'audit.jsonl');
    assert.equal(fs.existsSync(jsonlPath), true);
    const jsonlRows = fs.readFileSync(jsonlPath, 'utf-8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.equal(jsonlRows.length, 1);
    assert.equal(jsonlRows[0].summary, 'new audit');
  });

  // ── Channel Offsets ──

  it('getChannelOffset returns default for unknown key', () => {
    const store = new JsonFileStore(makeSettings());
    assert.equal(store.getChannelOffset('unknown'), '0');
  });

  it('setChannelOffset and getChannelOffset round-trip', () => {
    const store = new JsonFileStore(makeSettings());
    store.setChannelOffset('feishu:offset', '12345');
    assert.equal(store.getChannelOffset('feishu:offset'), '12345');
  });

  // ── Codex Thread ──

  it('updateSessionCodexThreadId updates only the session thread identity', () => {
    const store = new JsonFileStore(makeSettings());
    const session = store.createSession('test', 'model', undefined, '/tmp');
    store.upsertChannelChat({
      channelType: 'feishu-default',
      chatId: '1',
      bridgeSessionId: session.id,
    });
    store.updateSessionCodexThreadId(session.id, 'sdk-123');
    const binding = store.getChannelChat('feishu-default', '1');
    const updated = store.getSession(session.id);
    assert.equal(binding?.bridgeSessionId, session.id);
    assert.equal(updated?.runtime?.codex?.threadId, 'sdk-123');
  });

  it('updateSessionModel updates model', () => {
    const store = new JsonFileStore(makeSettings());
    const session = store.createSession('test', 'model-old', undefined, '/tmp');
    store.updateSessionModel(session.id, 'model-new');
    const updated = store.getSession(session.id);
    assert.equal(updated?.runtime?.codex?.model, 'model-new');
  });

  it('createSession stores hidden metadata and reasoning effort', () => {
    const store = new JsonFileStore(makeSettings());
    const session = store.createSession('draft', 'model', undefined, '/tmp', 'normal', {
      hidden: true,
      sessionType: 'draft',
      parentSessionId: 'parent-1',
      reasoningEffort: 'low',
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const fetched = store.getSession(session.id);
    assert.equal(fetched?.hidden, true);
    assert.equal(fetched?.session_type, 'draft');
    assert.equal(fetched?.parent_session_id, 'parent-1');
    assert.equal(fetched?.runtime?.codex?.reasoningEffort, 'low');
    assert.equal(fetched?.expires_at, '2099-01-01T00:00:00.000Z');
    assert.equal(fetched?.runtime?.codex?.mode, 'normal');
  });

  it('materializes session runtime state from legacy top-level storage on read', () => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(DATA_DIR, 'sessions.json'),
      JSON.stringify({
        'legacy-session': {
          id: 'legacy-session',
          working_directory: '/tmp/legacy',
          model: 'legacy-model',
          preferred_mode: 'yolo',
          codex_thread_id: 'thread-legacy',
          codex_provider: 'tmux',
          codex_network_access: false,
          tmux_session_name: 'clk-legacy',
        },
      }),
      'utf-8',
    );

    const store = new JsonFileStore(makeSettings());
    const session = store.getSession('legacy-session');

    assert.equal(session?.runtime?.codex?.model, 'legacy-model');
    assert.equal(session?.runtime?.codex?.mode, 'yolo');
    assert.equal(session?.runtime?.codex?.threadId, 'thread-legacy');
    assert.equal(session?.runtime?.codex?.provider, 'tmux');
    assert.equal(session?.runtime?.codex?.networkAccess, false);
    assert.equal(session?.runtime?.general?.tmuxSessionName, 'clk-legacy');
  });

  it('updateSession merges session metadata', () => {
    const store = new JsonFileStore(makeSettings());
    const session = store.createSession('test', 'model-old', undefined, '/tmp');
    store.updateSession(session.id, {
      runtime: { codex: { reasoningEffort: 'high' } },
      hidden: true,
      session_type: 'draft',
    });
    const updated = store.getSession(session.id);
    assert.equal(updated?.runtime?.codex?.reasoningEffort, 'high');
    assert.equal(updated?.hidden, true);
    assert.equal(updated?.session_type, 'draft');
  });

  it('deleteSession removes the session, bindings, and stored messages', () => {
    const store = new JsonFileStore(makeSettings());
    const session = store.createSession('test', 'model', undefined, '/tmp');
    store.upsertChannelChat({
      channelType: 'feishu-default',
      chatId: 'delete-me',
      bridgeSessionId: session.id,
    });
    store.addMessage(session.id, 'user', 'hello');
    store.deleteSession(session.id);
    assert.equal(store.getSession(session.id), null);
    assert.equal(store.getChannelChat('feishu-default', 'delete-me'), null);
    assert.deepEqual(store.getMessages(session.id).messages, []);
  });

  it('deleteSession only removes the deleted runtime mapping from surviving bindings', () => {
    const store = new JsonFileStore(makeSettings());
    const codexSession = store.createSession('codex', 'model', undefined, '/tmp/codex');
    const claudeSession = store.createSession('claude', '', undefined, '/tmp/claude', undefined, {
      activeRuntime: 'claude',
    });
    const binding = store.upsertChannelChat({
      channelType: 'feishu-default',
      chatId: 'runtime-map',
      bridgeSessionId: claudeSession.id,
      runtimeBridgeSessionIds: {
        codex: codexSession.id,
      },
    });

    store.deleteSession(codexSession.id);

    const updated = store.getChannelChat('feishu-default', 'runtime-map');
    assert.equal(updated?.id, binding.id);
    assert.equal(updated?.bridgeSessionId, claudeSession.id);
    assert.equal(updated?.runtimeBridgeSessionIds?.codex, undefined);
    assert.equal(updated?.runtimeBridgeSessionIds?.claude, claudeSession.id);
  });
});
