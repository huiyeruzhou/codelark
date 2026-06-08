import '../../setup/test-setup.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { CONFIG_JSON_PATH, CODELARK_HOME, DEFAULT_WORKSPACE_ROOT } from '../../../configuration/index.js';
import { JsonFileStore } from '../../../storage/json-store.js';
import { initBridgeContext } from '../../../bridge/host/context.js';
import { resolve } from '../../../bridge/host/channel-router.js';
import { resetDraftSession } from '../../../bridge/session/internal-sessions.js';
import { getSessionActiveRuntime, getSessionWorkingDirectory } from '../../../domain/session-runtime.js';
import { writeCodexSessionJsonlFixture } from '../../helpers/bridge/test-bridge-utils.js';

const DATA_DIR = path.join(CODELARK_HOME, 'data');

function makeSettings(): Map<string, string> {
  return new Map([
    ['remote_bridge_enabled', 'true'],
    ['bridge_default_model', 'test-model'],
    ['bridge_default_mode', 'code'],
  ]);
}

function makeClaudeSettings(): Map<string, string> {
  const settings = makeSettings();
  settings.set('bridge_default_runtime', 'claude');
  return settings;
}

const noopLlm = {
  streamChat(): ReadableStream<string> {
    return new ReadableStream({
      start(controller) {
        controller.close();
      },
    });
  },
};

describe('channel-router default targets', () => {
  let configBackup: string | null = null;

  beforeEach(() => {
    configBackup = fs.existsSync(CONFIG_JSON_PATH) ? fs.readFileSync(CONFIG_JSON_PATH, 'utf-8') : null;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    if (process.env.CODEX_HOME) {
      fs.rmSync(path.join(process.env.CODEX_HOME, 'sessions'), { recursive: true, force: true });
      fs.rmSync(path.join(process.env.CODEX_HOME, 'archived_sessions'), { recursive: true, force: true });
      fs.rmSync(path.join(process.env.CODEX_HOME, 'session_index.jsonl'), { force: true });
    }
    fs.rmSync(CONFIG_JSON_PATH, { force: true });
    fs.mkdirSync(path.dirname(CONFIG_JSON_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_JSON_PATH, JSON.stringify({
      schemaVersion: 1,
      runtime: {
        provider: 'codex',
        codex: {
          defaultMode: 'code',
        },
      },
      channels: [
        {
          id: 'feishu-default',
          alias: '飞书',
          provider: 'feishu',
          enabled: true,
          createdAt: '2026-03-01T00:00:00.000Z',
          updatedAt: '2026-03-01T00:00:00.000Z',
          config: {},
        },
      ],
    }, null, 2));
  });

  afterEach(() => {
    fs.rmSync(CONFIG_JSON_PATH, { force: true });
    if (configBackup !== null) {
      fs.writeFileSync(CONFIG_JSON_PATH, configBackup);
    }
  });

  it('routes the next new chat to the configured default session target', () => {
    const store = new JsonFileStore(makeSettings());
    initBridgeContext({
      store,
      llm: noopLlm,
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const session = store.createSession('prebound', 'test-model', undefined, '/tmp/prebound');
    store.upsertChannelDefaultTarget({
      channelType: 'feishu-default',
      channelProvider: 'feishu',
      channelAlias: '飞书',
      bridgeSessionId: session.id,
    });

    const binding = resolve({
      channelType: 'feishu-default',
      chatId: 'oc_prebound',
      userId: 'ou_123',
      displayName: '张乐',
    });

    assert.equal(binding.bridgeSessionId, session.id);
    assert.equal(store.getSession(session.id)?.name, 'prebound');
    assert.equal(store.getChannelDefaultTarget('feishu-default'), null);
  });

  it('routes the next new chat to a materialized Codex default target', () => {
    const store = new JsonFileStore(makeSettings());
    initBridgeContext({
      store,
      llm: noopLlm,
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    writeCodexSessionJsonlFixture({
      threadId: 'codex-default-thread',
      workDir: '/tmp/codex-default',
      lines: [
        {
          timestamp: '2026-05-28T00:00:00.000Z',
          type: 'session_meta',
          payload: {
            id: 'codex-default-thread',
            timestamp: '2026-05-28T00:00:00.000Z',
            cwd: '/tmp/codex-default',
            originator: 'Codex Desktop',
            source: 'desktop',
          },
        },
        {
          timestamp: '2026-05-28T00:00:01.000Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: 'Codex default title' },
        },
      ],
    });
    const defaultSession = store.createSession('Codex default title', 'test-model', undefined, '/tmp/codex-default');
    store.updateSessionCodexThreadId(defaultSession.id, 'codex-default-thread');
    store.upsertChannelDefaultTarget({
      channelType: 'feishu-default',
      channelProvider: 'feishu',
      channelAlias: '飞书',
      bridgeSessionId: defaultSession.id,
    });

    const binding = resolve({
      channelType: 'feishu-default',
      chatId: 'oc_codex_prebound',
      userId: 'ou_456',
      displayName: '李雷',
    });
    const session = store.getSession(binding.bridgeSessionId);

    assert.ok(session);
    assert.equal(session.runtime?.codex?.threadId, 'codex-default-thread');
    assert.equal(session.name, 'Codex default title');
    assert.equal(getSessionWorkingDirectory(session), '/tmp/codex-default');
    assert.equal(store.getChannelDefaultTarget('feishu-default'), null);
  });

  it('creates a Claude temporary session when default runtime is claude', () => {
    const store = new JsonFileStore(makeClaudeSettings());
    initBridgeContext({
      store,
      llm: noopLlm,
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const binding = resolve({
      channelType: 'feishu-default',
      chatId: 'oc_claude_draft',
      userId: 'ou_123',
      displayName: '张乐',
    });
    const session = store.getSession(binding.bridgeSessionId);

    assert.equal(getSessionActiveRuntime(session), 'claude');
    assert.equal(session?.hidden, true);
    assert.equal(session?.session_type, 'normal');
    assert.equal(session?.name, 'ou_123');
    assert.equal(getSessionWorkingDirectory(session), DEFAULT_WORKSPACE_ROOT);
  });

  it('names group draft sessions from the chat id', () => {
    const store = new JsonFileStore(makeSettings());
    initBridgeContext({
      store,
      llm: noopLlm,
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const binding = resolve({
      channelType: 'feishu-default',
      chatId: 'oc_abcdef1234567890',
      chatKind: 'group',
      userId: 'ou_1234567890',
      displayName: '迟浩瀚',
    });

    assert.equal(store.getSession(binding.bridgeSessionId)?.name, 'oc_abcdef123456');
  });

  it('does not reuse a hidden temporary session already bound to another chat', () => {
    const store = new JsonFileStore(makeSettings());
    initBridgeContext({
      store,
      llm: noopLlm,
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const firstBinding = resolve({
      channelType: 'feishu-default',
      chatId: 'oc_group_one',
      chatKind: 'group',
      userId: 'ou_same_user',
      displayName: '迟浩瀚',
    });
    const secondBinding = resolve({
      channelType: 'feishu-default',
      chatId: 'oc_group_two',
      chatKind: 'group',
      userId: 'ou_same_user',
      displayName: '迟浩瀚',
    });

    assert.notEqual(secondBinding.bridgeSessionId, firstBinding.bridgeSessionId);
    assert.equal(store.getSession(firstBinding.bridgeSessionId)?.hidden, true);
    assert.equal(store.getSession(secondBinding.bridgeSessionId)?.hidden, true);
    assert.equal(store.getSession(firstBinding.bridgeSessionId)?.name, 'oc_groupone');
    assert.equal(store.getSession(secondBinding.bridgeSessionId)?.name, 'oc_grouptwo');
  });

  it('does not reset a hidden temporary session bound to another chat', () => {
    const store = new JsonFileStore(makeSettings());
    initBridgeContext({
      store,
      llm: noopLlm,
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const firstBinding = resolve({
      channelType: 'feishu-default',
      chatId: 'oc_reset_group_one',
      chatKind: 'group',
      userId: 'ou_same_user',
      displayName: '迟浩瀚',
    });
    const resetSession = resetDraftSession(store, {
      channelType: 'feishu-default',
      chatId: 'oc_reset_group_two',
      userId: 'ou_same_user',
    });

    assert.notEqual(resetSession.id, firstBinding.bridgeSessionId);
    assert.ok(store.getSession(firstBinding.bridgeSessionId));
    assert.equal(store.getSession(firstBinding.bridgeSessionId)?.hidden, true);
    assert.equal(store.getSession(resetSession.id)?.hidden, true);
  });
});
