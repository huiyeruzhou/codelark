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
const UI_SESSION_META_PATH = path.join(DATA_DIR, 'ui-session-meta.json');

function readJson(filePath: string): any {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
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

  it('keeps only canonical channel default targets with bridgeSessionId', () => {
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
    fs.writeFileSync(CHANNEL_DEFAULT_TARGETS_PATH, JSON.stringify({
      'feishu-default': {
        id: 'default-1',
        channelType: 'feishu-default',
        bridgeSessionId: 'session-1',
        createdAt: '2026-05-28T00:00:00.000Z',
        updatedAt: '2026-05-28T00:00:00.000Z',
      },
      'feishu-empty': {
        id: 'default-2',
        channelType: 'feishu-empty',
        createdAt: '2026-05-28T00:00:00.000Z',
        updatedAt: '2026-05-28T00:00:00.000Z',
      },
    }, null, 2));

    const result = runStartupStorageMigrations({
      now: () => new Date('2026-05-29T00:00:00.000Z'),
      logger: false,
    });

    assert.equal(result.changed, true);
    assert.equal(result.migratedChannelDefaultTargets, 1);
    assert.equal(result.createdSessions, 0);

    const targets = readJson(CHANNEL_DEFAULT_TARGETS_PATH);
    assert.equal(targets['feishu-default'].bridgeSessionId, 'session-1');
    assert.equal(targets['feishu-empty'], undefined);
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
