import '../../setup/test-setup.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { CODELARK_HOME, DEFAULT_WORKSPACE_ROOT } from '../../../configuration/paths.js';
import { JsonFileStore } from '../../../storage/json-store.js';
import { initBridgeContext } from '../../../bridge/host/context.js';
import { createBinding, resolve } from '../../../bridge/host/channel-router.js';
import { resolveKimiRuntimeConfig, resolveSessionRuntimeConfig } from '../../../bridge/session/support.js';
import { getSessionActiveRuntime, getSessionWorkingDirectory } from '../../../domain/session-runtime.js';

const DATA_DIR = path.join(CODELARK_HOME, 'data');
const CONFIG_TOML_PATH = path.join(CODELARK_HOME, 'config.toml');
const SCOPED_CONFIG_DIR = path.join(CODELARK_HOME, 'config');

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

function makeKimiSettings(): Map<string, string> {
  const settings = makeSettings();
  settings.set('bridge_default_runtime', 'kimi');
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

describe('channel-router chat isolation', () => {
  let configBackup: string | null = null;

  beforeEach(() => {
    configBackup = fs.existsSync(CONFIG_TOML_PATH) ? fs.readFileSync(CONFIG_TOML_PATH, 'utf-8') : null;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    if (process.env.CODEX_HOME) {
      fs.rmSync(path.join(process.env.CODEX_HOME, 'sessions'), { recursive: true, force: true });
      fs.rmSync(path.join(process.env.CODEX_HOME, 'archived_sessions'), { recursive: true, force: true });
      fs.rmSync(path.join(process.env.CODEX_HOME, 'session_index.jsonl'), { force: true });
    }
    fs.rmSync(SCOPED_CONFIG_DIR, { recursive: true, force: true });
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

  it('never routes an unknown chat through a retired channel-wide default target', () => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(path.join(DATA_DIR, 'sessions.json'), JSON.stringify({
      'existing-session': {
        id: 'existing-session',
        name: 'existing',
        runtime: { codex: { model: 'test-model' }, general: { workingDirectory: '/tmp/existing' } },
        created_at: '2026-05-27T00:00:00.000Z',
        updated_at: '2026-05-27T00:00:00.000Z',
      },
    }, null, 2));
    fs.writeFileSync(path.join(DATA_DIR, 'channel-default-targets.json'), JSON.stringify({
      'feishu-default': {
        id: 'retired-default',
        channelType: 'feishu-default',
        bridgeSessionId: 'existing-session',
        createdAt: '2026-05-28T00:00:00.000Z',
        updatedAt: '2026-05-28T00:00:00.000Z',
      },
    }, null, 2));

    const store = new JsonFileStore(makeSettings());
    initBridgeContext({
      store,
      llm: noopLlm,
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const binding = resolve({
      channelType: 'feishu-default',
      chatId: 'oc_unknown_group',
      chatKind: 'group',
      userId: 'ou_123',
      displayName: '异常建群留下的群',
    });

    assert.notEqual(binding.bridgeSessionId, 'existing-session');
    assert.equal(store.getSession(binding.bridgeSessionId)?.hidden, true);
    assert.equal(fs.existsSync(path.join(DATA_DIR, 'channel-default-targets.json')), false);
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

  it('creates a Kimi temporary session when default runtime is kimi', () => {
    fs.writeFileSync(CONFIG_TOML_PATH, [
      'schema_version = 2',
      '',
      '[runtime]',
      'agent = "kimi"',
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
    const store = new JsonFileStore(makeKimiSettings());
    initBridgeContext({
      store,
      llm: noopLlm,
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const binding = resolve({
      channelType: 'feishu-default',
      chatId: 'oc_kimi_draft',
      userId: 'ou_kimi',
      displayName: 'Kimi 用户',
    });
    const session = store.getSession(binding.bridgeSessionId);

    assert.equal(getSessionActiveRuntime(session), 'kimi');
    assert.equal(session?.hidden, true);
    assert.equal(session?.session_type, 'normal');
    assert.equal(session?.name, 'ou_kimi');
    assert.equal(getSessionWorkingDirectory(session), DEFAULT_WORKSPACE_ROOT);
  });

  it('creates default sessions from home TOML before legacy settings', () => {
    const workspaceRoot = path.join(CODELARK_HOME, 'toml-workspace');
    fs.mkdirSync(workspaceRoot, { recursive: true });
    const writeToml = (runtime: 'codex' | 'claude' | 'kimi') => fs.writeFileSync(CONFIG_TOML_PATH, [
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

    writeToml('kimi');
    const kimiBinding = createBinding({
      channelType: 'feishu-default',
      chatId: 'oc_toml_kimi',
      userId: 'ou_kimi',
      displayName: 'TOML Kimi',
    }, workspaceRoot);
    const kimiSession = store.getSession(kimiBinding.bridgeSessionId);
    assert.equal(getSessionActiveRuntime(kimiSession), 'kimi');
    assert.equal(getSessionWorkingDirectory(kimiSession), workspaceRoot);

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

  it('creates new chat sessions from channel scoped runtime defaults', () => {
    const homeWorkspace = path.join(CODELARK_HOME, 'home-workspace');
    const channelWorkspace = path.join(CODELARK_HOME, 'channel-workspace');
    fs.mkdirSync(homeWorkspace, { recursive: true });
    fs.mkdirSync(channelWorkspace, { recursive: true });
    fs.writeFileSync(CONFIG_TOML_PATH, [
      'schema_version = 2',
      '',
      '[runtime]',
      'agent = "codex"',
      '',
      '[bridge]',
      `default_workspace = ${JSON.stringify(homeWorkspace)}`,
      '',
      '[runtime.codex]',
      'model = "home-codex-model"',
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
    const channelTomlPath = path.join(SCOPED_CONFIG_DIR, 'channels', 'feishu-default.toml');
    fs.mkdirSync(path.dirname(channelTomlPath), { recursive: true });
    fs.writeFileSync(channelTomlPath, [
      '[session]',
      `workspace = ${JSON.stringify(channelWorkspace)}`,
      '',
      '[runtime]',
      'agent = "claude"',
      '',
      '[runtime.codex]',
      'model = "channel-codex-model"',
      'yolo_mode = "on"',
      '',
    ].join('\n'), 'utf-8');
    const store = new JsonFileStore(makeSettings());
    initBridgeContext({
      store,
      llm: noopLlm,
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const draftBinding = resolve({
      channelType: 'feishu-default',
      channelProvider: 'feishu',
      chatId: 'oc_channel_defaults_draft',
      userId: 'ou_channel',
      displayName: 'Channel Defaults',
    });
    const draftSession = store.getSession(draftBinding.bridgeSessionId);
    assert.equal(getSessionActiveRuntime(draftSession), 'claude');
    assert.equal(getSessionWorkingDirectory(draftSession), channelWorkspace);
    assert.equal(resolveSessionRuntimeConfig(draftBinding, draftSession).model, 'channel-codex-model');
    assert.equal(resolveSessionRuntimeConfig(draftBinding, draftSession).mode, 'yolo');

    const explicitWorkspace = path.join(CODELARK_HOME, 'explicit-workspace');
    fs.mkdirSync(explicitWorkspace, { recursive: true });
    const visibleBinding = createBinding({
      channelType: 'feishu-default',
      channelProvider: 'feishu',
      chatId: 'oc_channel_defaults_visible',
      userId: 'ou_visible',
      displayName: 'Channel Visible',
    }, explicitWorkspace);
    const visibleSession = store.getSession(visibleBinding.bridgeSessionId);
    assert.equal(getSessionActiveRuntime(visibleSession), 'claude');
    assert.equal(getSessionWorkingDirectory(visibleSession), explicitWorkspace);
    assert.equal(resolveSessionRuntimeConfig(visibleBinding, visibleSession).model, 'channel-codex-model');

    const legacyProviderBinding = resolve({
      channelType: 'feishu',
      channelProvider: 'feishu',
      chatId: 'oc_channel_defaults_legacy_provider',
      userId: 'ou_legacy',
      displayName: 'Legacy Provider',
    });
    const legacyProviderSession = store.getSession(legacyProviderBinding.bridgeSessionId);
    assert.equal(getSessionActiveRuntime(legacyProviderSession), 'claude');
    assert.equal(getSessionWorkingDirectory(legacyProviderSession), channelWorkspace);
    assert.equal(resolveSessionRuntimeConfig(legacyProviderBinding, legacyProviderSession).model, 'channel-codex-model');
  });

  it('creates new chat sessions from channel scoped Kimi runtime defaults', () => {
    const homeWorkspace = path.join(CODELARK_HOME, 'home-kimi-workspace');
    const channelWorkspace = path.join(CODELARK_HOME, 'channel-kimi-workspace');
    fs.mkdirSync(homeWorkspace, { recursive: true });
    fs.mkdirSync(channelWorkspace, { recursive: true });
    fs.writeFileSync(CONFIG_TOML_PATH, [
      'schema_version = 2',
      '',
      '[runtime]',
      'agent = "codex"',
      '',
      '[bridge]',
      `default_workspace = ${JSON.stringify(homeWorkspace)}`,
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
    const channelTomlPath = path.join(SCOPED_CONFIG_DIR, 'channels', 'feishu-default.toml');
    fs.mkdirSync(path.dirname(channelTomlPath), { recursive: true });
    fs.writeFileSync(channelTomlPath, [
      '[session]',
      `workspace = ${JSON.stringify(channelWorkspace)}`,
      '',
      '[runtime]',
      'agent = "kimi"',
      '',
      '[runtime.kimi]',
      'model = "channel-kimi-model"',
      '',
    ].join('\n'), 'utf-8');
    const store = new JsonFileStore(makeSettings());
    initBridgeContext({
      store,
      llm: noopLlm,
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const draftBinding = resolve({
      channelType: 'feishu-default',
      channelProvider: 'feishu',
      chatId: 'oc_channel_defaults_kimi_draft',
      userId: 'ou_channel_kimi',
      displayName: 'Channel Kimi Defaults',
    });
    const draftSession = store.getSession(draftBinding.bridgeSessionId);
    assert.equal(getSessionActiveRuntime(draftSession), 'kimi');
    assert.equal(getSessionWorkingDirectory(draftSession), channelWorkspace);
    assert.equal(resolveKimiRuntimeConfig(draftSession, draftBinding).model, 'channel-kimi-model');

    const explicitWorkspace = path.join(CODELARK_HOME, 'explicit-kimi-workspace');
    fs.mkdirSync(explicitWorkspace, { recursive: true });
    const visibleBinding = createBinding({
      channelType: 'feishu-default',
      channelProvider: 'feishu',
      chatId: 'oc_channel_defaults_kimi_visible',
      userId: 'ou_visible_kimi',
      displayName: 'Channel Kimi Visible',
    }, explicitWorkspace);
    const visibleSession = store.getSession(visibleBinding.bridgeSessionId);
    assert.equal(getSessionActiveRuntime(visibleSession), 'kimi');
    assert.equal(getSessionWorkingDirectory(visibleSession), explicitWorkspace);
    assert.equal(resolveKimiRuntimeConfig(visibleSession, visibleBinding).model, 'channel-kimi-model');

    const legacyProviderBinding = resolve({
      channelType: 'feishu',
      channelProvider: 'feishu',
      chatId: 'oc_channel_defaults_kimi_legacy_provider',
      userId: 'ou_legacy_kimi',
      displayName: 'Legacy Provider Kimi',
    });
    const legacyProviderSession = store.getSession(legacyProviderBinding.bridgeSessionId);
    assert.equal(getSessionActiveRuntime(legacyProviderSession), 'kimi');
    assert.equal(getSessionWorkingDirectory(legacyProviderSession), channelWorkspace);
    assert.equal(resolveKimiRuntimeConfig(legacyProviderSession, legacyProviderBinding).model, 'channel-kimi-model');
  });
});
