import '../../../setup/test-setup.js';
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { CODELARK_HOME } from '../../../../configuration/paths.js';
import { bindStoreToCodexThread, bindStoreToSession } from '../../../../bridge/session/registry/bindings.js';
import { ThreadDisplayService } from '../../../../bridge/session/thread-display-resolver.js';
import { JsonFileStore } from '../../../../storage/json-store.js';
import { writeCodexSessionJsonlFixture } from '../../../helpers/bridge/test-bridge-utils.js';

const DATA_DIR = path.join(CODELARK_HOME, 'data');
const CONFIG_TOML_PATH = path.join(CODELARK_HOME, 'config.toml');

function makeSettings(): Map<string, string> {
  return new Map([
    ['remote_bridge_enabled', 'true'],
    ['bridge_default_model', 'test-model'],
    ['bridge_default_mode', 'code'],
  ]);
}

describe('session registry bindings', () => {
  beforeEach(() => {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    if (process.env.CODEX_HOME) {
      fs.rmSync(path.join(process.env.CODEX_HOME, 'sessions'), { recursive: true, force: true });
      fs.rmSync(path.join(process.env.CODEX_HOME, 'archived_sessions'), { recursive: true, force: true });
      fs.rmSync(path.join(process.env.CODEX_HOME, 'session_index.jsonl'), { force: true });
    }
    fs.rmSync(path.join(CODELARK_HOME, 'config'), { recursive: true, force: true });
    fs.rmSync(CONFIG_TOML_PATH, { force: true });
    fs.mkdirSync(path.dirname(CONFIG_TOML_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_TOML_PATH, `
schema_version = 2

[[channels]]
id = "feishu-default"
alias = "飞书"
provider = "feishu"
enabled = true

[[channels]]
id = "feishu-backup"
alias = "飞书备份"
provider = "feishu"
enabled = true
`);
  });

  it('rejects binding the same session to a different chat', () => {
    const store = new JsonFileStore(makeSettings());
    const session = store.createSession('shared', 'test-model', undefined, '/tmp/shared');

    const first = bindStoreToSession(store, 'feishu-default', 'oc_a', session.id);
    assert.ok(first);
    store.updateSession(session.id, { name: '张乐' }, { touch: false });

    assert.throws(
      () => bindStoreToSession(store, 'feishu-default', 'oc_b', session.id),
      /飞书 聊天 oc_a。一个会话只能绑定一个聊天/,
    );
  });

  it('rejects binding the same Codex thread across channels', () => {
    const store = new JsonFileStore(makeSettings());
    const session = store.createSession('codex', 'test-model', undefined, '/tmp/shared');
    store.updateSessionCodexThreadId(session.id, 'thread-1');

    const first = bindStoreToCodexThread(store, 'feishu-default', 'oc_a', 'thread-1', {
      workingDirectory: '/tmp/shared',
      displayName: 'Codex Thread',
    });
    assert.ok(first);

    assert.throws(
      () => bindStoreToCodexThread(store, 'feishu-backup', 'oc_b', 'thread-1', {
        workingDirectory: '/tmp/shared',
        displayName: 'Codex Thread',
      }),
      /一个会话只能绑定一个聊天/,
    );
  });

  it('stores channel metadata from v2 TOML custom channel entries', () => {
    fs.appendFileSync(CONFIG_TOML_PATH, `

[[channels]]
id = "feishu-custom"
alias = "飞书自定义"
provider = "feishu"
enabled = true
`);
    const store = new JsonFileStore(makeSettings());
    const session = store.createSession('custom', 'test-model', undefined, '/tmp/custom');

    const binding = bindStoreToSession(store, 'feishu-custom', 'oc_custom', session.id);

    assert.equal(binding?.channelProvider, 'feishu');
    assert.equal(binding?.channelAlias, '飞书自定义');
  });

  it('stores chat display metadata when binding to an existing session', () => {
    const store = new JsonFileStore(makeSettings());
    const session = store.createSession('shared', 'test-model', undefined, '/tmp/shared');

    const binding = bindStoreToSession(store, 'feishu-default', 'oc_meta', session.id, {
      chatUserId: 'ou_123',
      chatDisplayName: '张乐',
    });
    assert.ok(binding);
    const updatedSession = store.getSession(session.id);
    assert.equal(binding.chatUserId, 'ou_123');
    assert.equal(updatedSession?.name, 'shared');
  });

  it('stores chat display metadata when binding to a Codex thread', () => {
    const store = new JsonFileStore(makeSettings());

    const binding = bindStoreToCodexThread(store, 'feishu-default', 'oc_meta', 'thread-meta', {
      workingDirectory: '/tmp/shared',
      displayName: 'Codex Thread',
      chatUserId: 'ou_456',
      chatDisplayName: '张乐',
    });

    const session = store.getSession(binding.bridgeSessionId);
    assert.equal(binding.chatUserId, 'ou_456');
    assert.equal(session?.runtime?.codex?.threadId, 'thread-meta');
    assert.equal(session?.name, '张乐');
    assert.equal(session?.runtime?.codex?.title, 'Codex Thread');
  });

  it('strips legacy Desktop prefixes from displayed Codex binding titles', () => {
    const store = new JsonFileStore(makeSettings());

    const binding = bindStoreToCodexThread(store, 'feishu-default', 'oc_legacy', 'thread-legacy', {
      workingDirectory: '/tmp/legacy',
      displayName: 'Legacy Thread',
    });
    store.updateSession(binding.bridgeSessionId, { name: 'Desktop: Legacy Thread' });

    const display = new ThreadDisplayService(store).binding(binding);
    assert.equal(display.title, 'Legacy Thread');
  });

  it('exposes canonical display query fields for bound Codex threads', () => {
    const store = new JsonFileStore(makeSettings());
    writeCodexSessionJsonlFixture({
      threadId: 'thread-display-source',
      workDir: '/tmp/display-source',
      lines: [
        {
          timestamp: '2026-05-28T00:00:00.000Z',
          type: 'session_meta',
          payload: {
            id: 'thread-display-source',
            timestamp: '2026-05-28T00:00:00.000Z',
            cwd: '/tmp/display-source',
            originator: 'Codex VSCode',
            source: 'vscode',
            cli_version: '1.2.3',
          },
        },
        {
          timestamp: '2026-05-28T00:00:01.000Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: 'Creator title' },
        },
      ],
    });
    const binding = bindStoreToCodexThread(store, 'feishu-default', 'oc_creator', 'thread-display-source', {
      workingDirectory: '/tmp/display-source',
      displayName: 'Display Source Thread',
    });
    const session = store.getSession(binding.bridgeSessionId);

    const display = new ThreadDisplayService(store).binding(binding);

    assert.equal(display.bridgeSessionId, session?.id);
    assert.equal(display.creatorKind, 'vscode');
    assert.deepEqual(display.codexSource, {
      originator: 'Codex VSCode',
      source: 'vscode',
      cliVersion: '1.2.3',
    });
    assert.equal(display.executionProvider, 'default');
  });

  it('keeps Codex thread ids on the session instead of the binding', () => {
    const store = new JsonFileStore(makeSettings());
    const session = store.createSession('bridge', 'test-model', undefined, '/tmp/shared');
    store.updateSessionCodexThreadId(session.id, 'bridge-thread-1');

    const binding = bindStoreToSession(store, 'feishu-default', 'oc_bridge', session.id);
    const updated = store.getSession(session.id);

    assert.ok(binding);
    assert.equal(updated?.runtime?.codex?.threadId, 'bridge-thread-1');
  });
});
