import '../../../setup/test-setup.js';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { CODELARK_HOME } from '../../../../configuration/paths.js';
import { runStartupStorageMigrations } from '../../../../storage/migrations.js';

const DATA_DIR = path.join(CODELARK_HOME, 'data');
const SESSIONS_PATH = path.join(DATA_DIR, 'sessions.json');
const CHANNEL_CHATS_PATH = path.join(DATA_DIR, 'channel-chats.json');
const CHANNEL_DEFAULT_TARGETS_PATH = path.join(DATA_DIR, 'channel-default-targets.json');
const CHANNEL_ROUTING_RECOVERY_PATH = path.join(DATA_DIR, 'channel-routing-recovery.jsonl');
const AUDIT_JSONL_PATH = path.join(DATA_DIR, 'audit.jsonl');
const UI_SESSION_META_PATH = path.join(DATA_DIR, 'ui-session-meta.json');

function readJson(filePath: string): any {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function readJsonl(filePath: string): any[] {
  return fs.readFileSync(filePath, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe('runStartupStorageMigrations', () => {
  beforeEach(() => {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.mkdirSync(DATA_DIR, { recursive: true });
  });

  it('migrates retired session runtime fields to runtime.codex/general', () => {
    fs.writeFileSync(SESSIONS_PATH, JSON.stringify({
      'session-1': {
        id: 'session-1',
        working_directory: '/tmp/old',
        model: 'gpt-old',
        sdk_session_id: 'sdk-thread-1',
        desktop_thread_id: 'codex-thread-1',
        thread_origin: 'desktop',
      },
      'session-2': {
        id: 'session-2',
        working_directory: '/tmp/current',
        model: 'gpt-current',
        codex_thread_id: 'codex-current',
        sdkSessionId: 'sdk-ignored',
      },
    }, null, 2));
    const result = runStartupStorageMigrations({
      now: () => new Date('2026-05-29T00:00:00.000Z'),
      logger: false,
    });

    assert.equal(result.changed, true);
    const sessions = readJson(SESSIONS_PATH);
    assert.equal(sessions['session-1'].runtime?.codex?.threadId, 'codex-thread-1');
    assert.equal(sessions['session-1'].runtime?.codex?.model, 'gpt-old');
    assert.equal(sessions['session-1'].model, undefined);
    assert.equal(sessions['session-1'].sdk_session_id, undefined);
    assert.equal(sessions['session-1'].desktop_thread_id, undefined);
    assert.equal(sessions['session-1'].thread_origin, undefined);
    assert.equal(sessions['session-2'].runtime?.codex?.threadId, 'codex-current');
    assert.equal(sessions['session-2'].codex_thread_id, undefined);
    assert.equal(sessions['session-2'].sdkSessionId, undefined);
  });

  it('is idempotent after the first migration pass', () => {
    fs.writeFileSync(SESSIONS_PATH, JSON.stringify({
      'session-1': {
        id: 'session-1',
        working_directory: '/tmp/session',
        model: 'gpt-session',
        sdk_session_id: 'thread-1',
      },
    }, null, 2));

    assert.equal(runStartupStorageMigrations({ logger: false }).changed, true);
    assert.equal(runStartupStorageMigrations({ logger: false }).changed, false);
  });

  it('folds ui-session-meta names into sessions and removes the old file', () => {
    fs.writeFileSync(SESSIONS_PATH, JSON.stringify({
      'session-1': {
        id: 'session-1',
        working_directory: '/tmp/session',
        model: 'gpt-session',
      },
      'session-2': {
        id: 'session-2',
        working_directory: '/tmp/codex',
        model: 'gpt-codex',
        codex_thread_id: 'codex-thread-1',
      },
    }, null, 2));
    fs.writeFileSync(UI_SESSION_META_PATH, JSON.stringify({
      'session:session-1': { name: 'Session Name' },
      'desktop:codex-thread-1': { name: 'Codex Name' },
      'desktop:codex-thread-2': { name: 'Codex Only Name' },
    }, null, 2));

    const result = runStartupStorageMigrations({
      now: () => new Date('2026-05-29T00:00:00.000Z'),
      logger: false,
    });

    assert.equal(result.changed, true);
    assert.equal(result.migratedUiSessionNames, 1);
    assert.equal(result.createdSessions, 0);
    assert.equal(fs.existsSync(UI_SESSION_META_PATH), false);

    const sessions = readJson(SESSIONS_PATH);
    assert.equal(sessions['session-1'].name, 'Session Name');
    assert.equal(sessions['session-2'].name, undefined);
    const codexOnly = Object.values(sessions).find((session: any) => session.runtime?.codex?.threadId === 'codex-thread-2') as any;
    assert.equal(codexOnly, undefined);
  });

  it('retires wildcard defaults and repairs an auto-prebound duplicate binding on upgrade', () => {
    fs.writeFileSync(SESSIONS_PATH, JSON.stringify({
      'session-1': {
        id: 'session-1',
        runtime: { codex: { model: 'gpt-5.4' } },
      },
    }, null, 2));
    fs.writeFileSync(CHANNEL_CHATS_PATH, JSON.stringify({
      'binding-original': {
        id: 'binding-original',
        channelType: 'feishu-default',
        channelProvider: 'feishu',
        chatId: 'oc_original_p2p',
        chatKind: 'p2p',
        bridgeSessionId: 'session-1',
        createdAt: '2026-05-27T00:00:00.000Z',
        updatedAt: '2026-05-27T00:00:00.000Z',
      },
      'binding-polluted': {
        id: 'binding-polluted',
        channelType: 'feishu-default',
        channelProvider: 'feishu',
        chatId: 'oc_half_created_group',
        chatKind: 'group',
        bridgeSessionId: 'session-1',
        createdAt: '2026-05-28T00:00:00.000Z',
        updatedAt: '2026-05-28T00:00:00.000Z',
      },
    }, null, 2));
    fs.writeFileSync(CHANNEL_DEFAULT_TARGETS_PATH, JSON.stringify({
      'feishu-default': {
        id: 'default-1',
        channelType: 'feishu-default',
        bridgeSessionId: 'session-1',
        createdAt: '2026-05-28T00:00:00.000Z',
        updatedAt: '2026-05-28T00:00:00.000Z',
      },
    }, null, 2));
    fs.writeFileSync(AUDIT_JSONL_PATH, `${JSON.stringify({
      id: 'audit-prebound',
      channelType: 'feishu-default',
      chatId: 'oc_half_created_group',
      direction: 'inbound',
      messageId: 'binding-change:1',
      summary: 'Binding change: action=auto_create_prebound; from=[none]; to=[session=session-1]',
      createdAt: '2026-05-28T00:00:00.000Z',
    })}\n`);

    const result = runStartupStorageMigrations({
      now: () => new Date('2026-05-29T00:00:00.000Z'),
      logger: false,
    });

    assert.equal(result.changed, true);
    assert.equal(result.retiredChannelDefaultTargets, 1);
    assert.equal(result.repairedDuplicateBindings, 1);
    assert.equal(fs.existsSync(CHANNEL_DEFAULT_TARGETS_PATH), false);

    const bindings = readJson(CHANNEL_CHATS_PATH);
    assert.deepEqual(Object.keys(bindings), ['binding-original']);

    const recovery = readJsonl(CHANNEL_ROUTING_RECOVERY_PATH);
    assert.equal(recovery.length, 1);
    assert.equal(recovery[0].retiredChannelDefaultTargets[0].id, 'default-1');
    assert.equal(recovery[0].removedDuplicateBindings[0].binding.id, 'binding-polluted');
    assert.equal(recovery[0].removedDuplicateBindings[0].keptBindingId, 'binding-original');
    assert.equal(recovery[0].removedDuplicateBindings[0].reason, 'auto_create_prebound');

    const audit = readJsonl(AUDIT_JSONL_PATH);
    assert.equal(audit.some((entry) => entry.summary.includes('action=startup_retire_channel_default')), true);
    assert.equal(audit.some((entry) => entry.summary.includes('action=startup_repair_duplicate_binding')), true);

    const recoveryBeforeSecondPass = fs.readFileSync(CHANNEL_ROUTING_RECOVERY_PATH, 'utf-8');
    const auditBeforeSecondPass = fs.readFileSync(AUDIT_JSONL_PATH, 'utf-8');
    assert.equal(runStartupStorageMigrations({ logger: false }).changed, false);
    assert.equal(fs.readFileSync(CHANNEL_ROUTING_RECOVERY_PATH, 'utf-8'), recoveryBeforeSecondPass);
    assert.equal(fs.readFileSync(AUDIT_JSONL_PATH, 'utf-8'), auditBeforeSecondPass);
  });

  it('keeps the oldest duplicate binding when no auto-prebind audit evidence exists', () => {
    fs.writeFileSync(SESSIONS_PATH, JSON.stringify({
      'session-1': { id: 'session-1', runtime: { codex: {} } },
    }, null, 2));
    fs.writeFileSync(CHANNEL_CHATS_PATH, JSON.stringify({
      newer: {
        id: 'newer',
        channelType: 'feishu-default',
        chatId: 'oc_newer',
        bridgeSessionId: 'session-1',
        createdAt: '2026-05-28T00:00:00.000Z',
        updatedAt: '2026-05-28T00:00:00.000Z',
      },
      older: {
        id: 'older',
        channelType: 'feishu-default',
        chatId: 'oc_older',
        bridgeSessionId: 'session-1',
        createdAt: '2026-05-27T00:00:00.000Z',
        updatedAt: '2026-05-27T00:00:00.000Z',
      },
    }, null, 2));

    const result = runStartupStorageMigrations({
      now: () => new Date('2026-05-29T00:00:00.000Z'),
      logger: false,
    });

    assert.equal(result.repairedDuplicateBindings, 1);
    assert.deepEqual(Object.keys(readJson(CHANNEL_CHATS_PATH)), ['older']);
    const recovery = readJsonl(CHANNEL_ROUTING_RECOVERY_PATH);
    assert.equal(recovery[0].removedDuplicateBindings[0].binding.id, 'newer');
    assert.equal(recovery[0].removedDuplicateBindings[0].keptBindingId, 'older');
    assert.equal(recovery[0].removedDuplicateBindings[0].reason, 'duplicate_bridge_session');
  });

  it('backs up and removes an unreadable retired default-target file without blocking startup', () => {
    fs.writeFileSync(CHANNEL_DEFAULT_TARGETS_PATH, '{incomplete');

    const result = runStartupStorageMigrations({
      now: () => new Date('2026-05-29T00:00:00.000Z'),
      logger: false,
    });

    assert.equal(result.changed, true);
    assert.equal(result.errors.length, 0);
    assert.equal(result.retiredChannelDefaultTargets, 1);
    assert.equal(fs.existsSync(CHANNEL_DEFAULT_TARGETS_PATH), false);
    const recovery = readJsonl(CHANNEL_ROUTING_RECOVERY_PATH);
    assert.equal(recovery[0].retiredChannelDefaultTargets[0].storageKey, '__unparsed__');
    assert.equal(recovery[0].retiredChannelDefaultTargets[0].rawText, '{incomplete');
  });

  it('normalizes mixed runtime sessions and backfills per-chat runtime mappings', () => {
    fs.writeFileSync(SESSIONS_PATH, JSON.stringify({
      'codex-session': {
        id: 'codex-session',
        runtime: {
          codex: { model: 'gpt-5.4' },
          claude: { sessionId: 'should-be-removed' },
          kimi: { sessionId: 'should-be-removed' },
          general: { workingDirectory: '/tmp/codex' },
        },
      },
      'claude-session': {
        id: 'claude-session',
        model: 'claude-retired-model',
        runtime: {
          activeRuntime: 'claude',
          codex: { model: 'should-be-removed' },
          claude: { sessionId: 'claude-1' },
          kimi: { sessionId: 'should-be-removed' },
          general: { workingDirectory: '/tmp/claude' },
        },
      },
      'kimi-session': {
        id: 'kimi-session',
        model: 'kimi-retired-model',
        runtime: {
          activeRuntime: 'kimi',
          codex: { model: 'should-be-removed' },
          claude: { sessionId: 'should-be-removed' },
          kimi: { sessionId: 'session_kimi_migration', cwd: '/tmp/kimi' },
          general: { workingDirectory: '/tmp/kimi' },
        },
      },
    }, null, 2));
    fs.writeFileSync(CHANNEL_CHATS_PATH, JSON.stringify({
      chatCodex: {
        id: 'chatCodex',
        channelType: 'feishu',
        chatId: 'chat-codex',
        bridgeSessionId: 'codex-session',
        createdAt: '2026-05-28T00:00:00.000Z',
        updatedAt: '2026-05-28T00:00:00.000Z',
      },
      chatClaude: {
        id: 'chatClaude',
        channelType: 'feishu',
        chatId: 'chat-claude',
        bridgeSessionId: 'claude-session',
        createdAt: '2026-05-28T00:00:00.000Z',
        updatedAt: '2026-05-28T00:00:00.000Z',
      },
      chatKimi: {
        id: 'chatKimi',
        channelType: 'feishu',
        chatId: 'chat-kimi',
        bridgeSessionId: 'kimi-session',
        runtimeBridgeSessionIds: { codex: 'old-codex', kimi: 'kimi-session' },
        createdAt: '2026-05-28T00:00:00.000Z',
        updatedAt: '2026-05-28T00:00:00.000Z',
      },
    }, null, 2));

    const result = runStartupStorageMigrations({ logger: false });

    assert.equal(result.changed, true);
    assert.equal(result.migratedChannelRuntimeBindings, 2);
    const sessions = readJson(SESSIONS_PATH);
    assert.equal(sessions['codex-session'].runtime.claude, undefined);
    assert.equal(sessions['codex-session'].runtime.kimi, undefined);
    assert.equal(sessions['codex-session'].runtime.codex.model, 'gpt-5.4');
    assert.equal(sessions['claude-session'].runtime.codex, undefined);
    assert.equal(sessions['claude-session'].runtime.kimi, undefined);
    assert.equal(sessions['claude-session'].runtime.claude.sessionId, 'claude-1');
    assert.equal(sessions['claude-session'].runtime.claude.model, 'claude-retired-model');
    assert.equal(sessions['claude-session'].model, undefined);
    assert.equal(sessions['kimi-session'].runtime.codex, undefined);
    assert.equal(sessions['kimi-session'].runtime.claude, undefined);
    assert.equal(sessions['kimi-session'].runtime.kimi.sessionId, 'session_kimi_migration');
    assert.equal(sessions['kimi-session'].runtime.kimi.model, 'kimi-retired-model');
    assert.equal(sessions['kimi-session'].model, undefined);

    const channelChats = readJson(CHANNEL_CHATS_PATH);
    assert.equal(channelChats.chatCodex.runtimeBridgeSessionIds.codex, 'codex-session');
    assert.equal(channelChats.chatClaude.runtimeBridgeSessionIds.claude, 'claude-session');
    assert.equal(channelChats.chatKimi.runtimeBridgeSessionIds.codex, 'old-codex');
    assert.equal(channelChats.chatKimi.runtimeBridgeSessionIds.kimi, 'kimi-session');
  });
});
