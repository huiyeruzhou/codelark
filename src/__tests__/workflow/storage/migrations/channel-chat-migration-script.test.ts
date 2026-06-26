import '../../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT_DIR = path.resolve(import.meta.dirname, '../../../../..');
const SCRIPT_PATH = path.join(ROOT_DIR, 'scripts/migrate-bindings-to-channel-chats.js');

function readJson(filePath: string): any {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

describe('migrate-bindings-to-channel-chats.js', () => {
  it('accepts --codelark-home as the new home argument name', () => {
    const codelarkHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codelark-migrate-channel-chats-'));
    const dataDir = path.join(codelarkHome, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'sessions.json'), JSON.stringify({ session1: { id: 'session1' } }, null, 2));
    fs.writeFileSync(path.join(dataDir, 'bindings.json'), JSON.stringify({
      binding1: {
        id: 'binding1',
        channelType: 'feishu-default',
        chatId: 'chat-1',
        bridgeSessionId: 'session1',
        active: true,
        updatedAt: '2026-05-02T00:00:00.000Z',
        createdAt: '2026-05-02T00:00:00.000Z',
      },
    }, null, 2));

    const raw = execFileSync(process.execPath, [SCRIPT_PATH, '--codelark-home', codelarkHome, '--dry-run'], {
      encoding: 'utf-8',
    });
    const summary = JSON.parse(raw);

    assert.equal(summary.codelarkHome, codelarkHome);
    assert.equal(summary.outputChannelChats, 1);
    assert.equal(summary.dryRun, true);
    assert.equal(fs.existsSync(path.join(dataDir, 'bindings.json')), true);
  });

  it('keeps only active legacy bindings and migrates runtime fields to sessions', () => {
    const codelarkHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-migrate-channel-chats-'));
    const dataDir = path.join(codelarkHome, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'sessions.json'), JSON.stringify({
      'sess-active-old': {
        id: 'sess-active-old',
        working_directory: '/existing',
        model: 'existing-model',
        preferred_mode: 'normal',
      },
      'sess-active-new': {
        id: 'sess-active-new',
      },
      'sess-inactive': {
        id: 'sess-inactive',
      },
      'sess-kimi': {
        id: 'sess-kimi',
        runtime: {
          activeRuntime: 'kimi',
          kimi: { sessionId: 'session_kimi_legacy_binding', cwd: '/kimi/runtime-cwd' },
        },
      },
    }, null, 2));
    fs.writeFileSync(path.join(dataDir, 'bindings.json'), JSON.stringify({
      inactiveSameChat: {
        id: 'inactiveSameChat',
        channelType: 'feishu-default',
        chatId: 'chat-1',
        bridgeSessionId: 'sess-active-old',
        active: false,
        workingDirectory: '/old',
        model: 'old-model',
        mode: 'yolo',
        chatDisplayName: 'Old Chat',
        updatedAt: '2026-05-01T00:00:00.000Z',
        createdAt: '2026-05-01T00:00:00.000Z',
      },
      activeSameChat: {
        id: 'activeSameChat',
        channelType: 'feishu-default',
        channelProvider: 'feishu',
        channelAlias: '飞书',
        chatId: 'chat-1',
        chatKind: 'group',
        chatUserId: 'user-1',
        bridgeSessionId: 'sess-active-new',
        active: true,
        workingDirectory: '/new',
        model: 'new-model',
        mode: 'yolo',
        chatDisplayName: 'New Chat',
        updatedAt: '2026-05-02T00:00:00.000Z',
        createdAt: '2026-05-02T00:00:00.000Z',
      },
      inactiveOnly: {
        id: 'inactiveOnly',
        channelType: 'feishu-default',
        chatId: 'chat-2',
        bridgeSessionId: 'sess-inactive',
        active: false,
        updatedAt: '2026-05-03T00:00:00.000Z',
        createdAt: '2026-05-03T00:00:00.000Z',
      },
      activeKimi: {
        id: 'activeKimi',
        channelType: 'feishu-default',
        chatId: 'chat-kimi',
        bridgeSessionId: 'sess-kimi',
        active: true,
        workingDirectory: '/kimi/binding-cwd',
        model: 'kimi-binding-model',
        mode: 'yolo',
        chatDisplayName: 'Kimi Chat',
        updatedAt: '2026-05-04T00:00:00.000Z',
        createdAt: '2026-05-04T00:00:00.000Z',
      },
    }, null, 2));

    const raw = execFileSync(process.execPath, [SCRIPT_PATH, '--clk-home', codelarkHome], {
      encoding: 'utf-8',
    });
    const summary = JSON.parse(raw);
    assert.equal(summary.inputBindings, 4);
    assert.equal(summary.outputChannelChats, 2);
    assert.equal(summary.droppedBindings, 2);
    assert.equal(summary.skippedInactiveBindings, 2);
    assert.equal(summary.sessionsChanged, 2);

    const channelChats = readJson(path.join(dataDir, 'channel-chats.json'));
    assert.deepEqual(Object.keys(channelChats), ['activeSameChat', 'activeKimi']);
    assert.deepEqual(channelChats.activeSameChat, {
      id: 'activeSameChat',
      channelType: 'feishu-default',
      channelProvider: 'feishu',
      channelAlias: '飞书',
      chatId: 'chat-1',
      chatKind: 'group',
      chatUserId: 'user-1',
      bridgeSessionId: 'sess-active-new',
      createdAt: '2026-05-02T00:00:00.000Z',
      updatedAt: '2026-05-02T00:00:00.000Z',
    });
    assert.deepEqual(channelChats.activeKimi, {
      id: 'activeKimi',
      channelType: 'feishu-default',
      chatId: 'chat-kimi',
      bridgeSessionId: 'sess-kimi',
      createdAt: '2026-05-04T00:00:00.000Z',
      updatedAt: '2026-05-04T00:00:00.000Z',
    });

    const sessions = readJson(path.join(dataDir, 'sessions.json'));
    assert.equal(sessions['sess-active-new'].working_directory, '/new');
    assert.equal(sessions['sess-active-new'].runtime?.codex?.model, 'new-model');
    assert.equal(sessions['sess-active-new'].runtime?.codex?.mode, 'yolo');
    assert.equal(sessions['sess-active-new'].model, undefined);
    assert.equal(sessions['sess-active-new'].preferred_mode, undefined);
    assert.equal(sessions['sess-active-new'].name, 'New Chat');
    assert.equal(sessions['sess-inactive'].working_directory, undefined);
    assert.equal(sessions['sess-kimi'].working_directory, '/kimi/binding-cwd');
    assert.equal(sessions['sess-kimi'].runtime?.activeRuntime, 'kimi');
    assert.equal(sessions['sess-kimi'].runtime?.kimi?.sessionId, 'session_kimi_legacy_binding');
    assert.equal(sessions['sess-kimi'].runtime?.kimi?.model, 'kimi-binding-model');
    assert.equal(sessions['sess-kimi'].runtime?.codex, undefined);
    assert.equal(sessions['sess-kimi'].runtime?.kimi?.mode, undefined);
    assert.equal(sessions['sess-kimi'].name, 'Kimi Chat');
    assert.equal(fs.existsSync(path.join(dataDir, 'bindings.json')), false);
  });
});
