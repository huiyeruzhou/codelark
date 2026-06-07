import '../../setup/test-setup.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { CODELARK_HOME, DEFAULT_WORKSPACE_ROOT } from '../../../configuration/paths.js';
import { JsonFileStore } from '../../../storage/json-store.js';
import { initBridgeContext } from '../../../bridge/host/context.js';
import { createBinding, resolve } from '../../../bridge/host/channel-router.js';
import { resolveSessionRuntimeConfig } from '../../../bridge/session/support.js';
import { getSessionActiveRuntime, getSessionWorkingDirectory } from '../../../domain/session-runtime.js';
import { writeCodexSessionJsonlFixture } from '../../helpers/bridge/test-bridge-utils.js';

const DATA_DIR = path.join(CODELARK_HOME, 'data');
const CONFIG_TOML_PATH = path.join(CODELARK_HOME, 'config.toml');

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
    configBackup = fs.existsSync(CONFIG_TOML_PATH) ? fs.readFileSync(CONFIG_TOML_PATH, 'utf-8') : null;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    if (process.env.CODEX_HOME) {
      fs.rmSync(path.join(process.env.CODEX_HOME, 'sessions'), { recursive: true, force: true });
      fs.rmSync(path.join(process.env.CODEX_HOME, 'archived_sessions'), { recursive: true, force: true });
      fs.rmSync(path.join(process.env.CODEX_HOME, 'session_index.jsonl'), { force: true });
    }
    fs.rmSync(CONFIG_TOML_PATH, { force: true });
    fs.mkdirSync(path.dirname(CONFIG_TOML_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_TOML_PATH, [
      'schema_version = 2',
      '',
      '[runtime]',
      'agent = "codex"',
      '',
      '[runtime.codex]',
      'yolo_mode = "off"',
      '',
      '[[channels]]',
      'id = "feishu-default"',
      'alias = "飞书"',
      'provider = "feishu"',
      'enabled = true',
      '',
      '[channels.config]',
      'history_message_limit = 8',
      '',
    ].join('\n'), 'utf-8');
  });

  afterEach(() => {
    fs.rmSync(CONFIG_TOML_PATH, { force: true });
    if (configBackup !== null) {
      fs.writeFileSync(CONFIG_TOML_PATH, configBackup);
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
    fs.writeFileSync(CONFIG_TOML_PATH, [
      'schema_version = 2',
      '',
      '[runtime]',
      'agent = "claude"',
      '',
      '[[channels]]',
      'id = "feishu-default"',
      'alias = "飞书"',
      'provider = "feishu"',
      'enabled = true',
      '',
      '[channels.config]',
      'history_message_limit = 8',
      '',
    ].join('\n'), 'utf-8');
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

  it('creates default sessions from home TOML before legacy settings', () => {
    const workspaceRoot = path.join(CODELARK_HOME, 'toml-workspace');
    fs.mkdirSync(workspaceRoot, { recursive: true });
    const writeToml = (runtime: 'codex' | 'claude') => fs.writeFileSync(CONFIG_TOML_PATH, [
      'schema_version = 2',
      '',
      '[runtime]',
      `agent = "${runtime}"`,
      '',
      '[bridge]',
      `default_workspace = ${JSON.stringify(workspaceRoot)}`,
      '',
      '[runtime.codex]',
      'model = "toml-codex-model"',
      '',
      '[[channels]]',
      'id = "feishu-default"',
      'alias = "飞书"',
      'provider = "feishu"',
      'enabled = true',
      '',
      '[channels.config]',
      'history_message_limit = 8',
      '',
    ].join('\n'), 'utf-8');
    writeToml('claude');
    const store = new JsonFileStore(makeSettings());
    initBridgeContext({
      store,
      llm: noopLlm,
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const draftBinding = resolve({
      channelType: 'feishu-default',
      chatId: 'oc_toml_draft',
      userId: 'ou_toml',
      displayName: 'TOML 默认',
    });
    const draftSession = store.getSession(draftBinding.bridgeSessionId);
    assert.equal(getSessionActiveRuntime(draftSession), 'claude');
    assert.equal(getSessionWorkingDirectory(draftSession), workspaceRoot);

    writeToml('codex');
    const codexBinding = createBinding({
      channelType: 'feishu-default',
      chatId: 'oc_toml_codex',
      userId: 'ou_codex',
      displayName: 'TOML Codex',
    }, workspaceRoot);
    const codexSession = store.getSession(codexBinding.bridgeSessionId);
    assert.equal(getSessionActiveRuntime(codexSession), 'codex');
    assert.equal(resolveSessionRuntimeConfig(codexBinding, codexSession).model, 'toml-codex-model');
  });
});
