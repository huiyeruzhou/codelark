import '../../../setup/test-setup.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

import {
  createCursorMirrorJsonlSource,
  cursorWorkspaceHash,
  cursorWorkspaceSlug,
  encodeCursorConversationId,
  findCursorSessionFileById,
  getCursorTranscriptCandidates,
  listCursorSessionFileSummaries,
  parseCursorTranscriptRecords,
  readCursorSessionMirrorRecordDeltaByFilePath,
} from '../../../../runtime/cursor/session-index.js';
import {
  buildCursorArgs,
  buildCursorTmuxLaunchCommand,
  cursorAuthenticationScreenError,
  cursorTmuxSessionName,
  ensureCursorTmuxInputSession,
  isCursorInputDraftScreen,
  isCursorInputReadyScreen,
  streamCursorTmuxTui,
  withCursorReasoningEffort,
} from '../../../../runtime/cursor/tmux-provider.js';
import { tmuxCore } from '../../../../bridge/tmux/core.js';
import { createMirrorSubscription } from '../../../../bridge/mirror/subscription-state.js';
import { readMirrorDeliverableRecords } from '../../../../bridge/mirror/reconcile-core.js';
import { consumeMirrorRecords } from '../../../../bridge/mirror/turns.js';

describe('Cursor tmux provider helpers', () => {
  let root: string;
  let configRoot: string;
  let dataRoot: string;
  let desktopUserRoot: string;
  let previousConfigRoot: string | undefined;
  let previousDataRoot: string | undefined;
  let previousDesktopUserRoot: string | undefined;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-cursor-'));
    configRoot = path.join(root, 'config');
    dataRoot = path.join(root, 'data');
    desktopUserRoot = path.join(root, 'desktop-user');
    previousConfigRoot = process.env.CURSOR_CONFIG_DIR;
    previousDataRoot = process.env.CURSOR_DATA_DIR;
    previousDesktopUserRoot = process.env.CURSOR_DESKTOP_USER_DIR;
    process.env.CURSOR_CONFIG_DIR = configRoot;
    process.env.CURSOR_DATA_DIR = dataRoot;
    process.env.CURSOR_DESKTOP_USER_DIR = desktopUserRoot;
  });

  afterEach(() => {
    if (previousConfigRoot === undefined) delete process.env.CURSOR_CONFIG_DIR;
    else process.env.CURSOR_CONFIG_DIR = previousConfigRoot;
    if (previousDataRoot === undefined) delete process.env.CURSOR_DATA_DIR;
    else process.env.CURSOR_DATA_DIR = previousDataRoot;
    if (previousDesktopUserRoot === undefined) delete process.env.CURSOR_DESKTOP_USER_DIR;
    else process.env.CURSOR_DESKTOP_USER_DIR = previousDesktopUserRoot;
    fs.rmSync(root, { recursive: true, force: true });
  });

  function writeCursorSession(params: {
    sessionId: string;
    cwd: string;
    title?: string;
    lines?: unknown[];
  }): string {
    const sessionDir = path.join(configRoot, 'chats', cursorWorkspaceHash(params.cwd), params.sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'store.db'), 'sqlite-placeholder');
    fs.writeFileSync(path.join(sessionDir, 'meta.json'), JSON.stringify({
      schemaVersion: 1,
      title: params.title || 'Cursor local session',
      createdAtMs: 1785020000000,
      updatedAtMs: 1785020060000,
      hasConversation: true,
      isSubagent: false,
      cwd: params.cwd,
    }));
    const transcript = getCursorTranscriptCandidates(params.sessionId, params.cwd)[0]!;
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, (params.lines || [
      { role: 'user', message: { content: [{ type: 'text', text: 'hello cursor' }] } },
      { role: 'assistant', message: { content: [{ type: 'text', text: 'hello user' }] } },
      { type: 'turn_ended', status: 'success' },
    ]).map((line) => JSON.stringify(line)).join('\n') + '\n');
    return transcript;
  }

  it('builds a stable provider-owned tmux name and shell launch command', () => {
    assert.equal(cursorTmuxSessionName('bridge-123'), 'clk-cursor-bridge-123');
    assert.equal(
      buildCursorTmuxLaunchCommand('/opt/cursor agent', ['--resume', 'chat-id', '--trust'], {
        platform: 'linux',
        env: { CURSOR_CONFIG_DIR: '/tmp/cursor config' },
      }),
      "CURSOR_CONFIG_DIR='/tmp/cursor config' '/opt/cursor agent' --resume chat-id --trust",
    );
  });

  it('merges model-specific reasoning effort into Cursor parameterized model syntax', () => {
    assert.equal(
      withCursorReasoningEffort('claude-opus-4-8[context=1m,fast=false]', 'high'),
      'claude-opus-4-8[context=1m,fast=false,effort=high]',
    );
    assert.equal(
      withCursorReasoningEffort('claude-opus-4-8[context=1m,effort=low]', 'max'),
      'claude-opus-4-8[context=1m,effort=max]',
    );
    assert.deepEqual(
      buildCursorArgs({
        model: 'gpt-5.3-codex',
        cursorReasoningEffort: 'xhigh',
      } as Parameters<typeof buildCursorArgs>[0]),
      ['--model', 'gpt-5.3-codex[effort=xhigh]', '--trust'],
    );
  });

  it('distinguishes login screens from the Cursor input editor', () => {
    assert.match(
      cursorAuthenticationScreenError('Cursor Agent\nPress any key to log in...') || '',
      /agent login/i,
    );
    assert.equal(isCursorInputReadyScreen('Cursor Agent\nPress any key to log in...'), false);
    assert.equal(isCursorInputReadyScreen('Agent\nContext 2%\n› '), true);
    assert.equal(isCursorInputReadyScreen([
      'Cursor Agent',
      'v2026.07.23-e383d2b',
      'Tip: Use /run-everything to skip all approvals.',
      '→ Plan, search, build anything',
      'Auto Balance',
      '/tmp/cursor-workspace',
    ].join('\n')), true);
    assert.equal(isCursorInputReadyScreen('loading Cursor Agent'), false);
  });

  it('distinguishes a real running Cursor pane from an unsubmitted draft', () => {
    const runningPane = [
      '  Read package.json and reply with exactly CURSOR_SUBMIT_REPRO_OK',
      '',
      ' ⠀⠘⠤ Working',
      '',
      '  → Add a follow-up                                             ctrl+c to stop',
      '',
      '  Codex 5.3 Medium',
      '  /opt/tiger/codelark · fix/cursor-running-progress',
    ].join('\n');
    assert.equal(
      isCursorInputDraftScreen(runningPane),
      false,
      'the right-aligned stop hint is not part of the Cursor input editor value',
    );
    assert.equal(
      isCursorInputDraftScreen('→ inspect src/runtime/cursor/tmux-provider.ts\n\nCodex 5.3 Medium'),
      true,
    );
  });

  it('uses the official cwd hash, workspace slug, and encoded transcript id', () => {
    const cwd = path.join(root, 'project with spaces');
    fs.mkdirSync(cwd, { recursive: true });
    const canonicalCwd = fs.realpathSync.native(cwd);
    assert.match(cursorWorkspaceHash(cwd), /^[a-f0-9]{32}$/);
    assert.equal(cursorWorkspaceSlug(cwd), canonicalCwd.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, ''));
    assert.equal(encodeCursorConversationId('chat/id'), 'chat_2Fid');
  });

  it('lists and resolves Cursor chat metadata with its transcript', () => {
    const cwd = path.join(root, 'workspace');
    fs.mkdirSync(cwd, { recursive: true });
    const sessionId = '11111111-1111-4111-8111-111111111111';
    const transcript = writeCursorSession({ sessionId, cwd });

    assert.equal(listCursorSessionFileSummaries(cwd)[0]?.filePath, transcript);
    assert.equal(findCursorSessionFileById(sessionId, cwd)?.title, 'Cursor local session');
    const source = createCursorMirrorJsonlSource();
    assert.equal(source.findByThreadId(sessionId, cwd)?.filePath, transcript);
    assert.equal(source.watchPath?.(transcript), path.dirname(transcript));
  });

  it('merges Cursor Desktop conversations with CLI chats and restores their workspaces', () => {
    const cliCwd = path.join(root, 'cli-workspace');
    const modernCwd = path.join(root, 'modern-workspace');
    const legacyCwd = path.join(root, 'legacy-workspace');
    for (const cwd of [cliCwd, modernCwd, legacyCwd]) fs.mkdirSync(cwd, { recursive: true });
    const cliId = '11111111-1111-4111-8111-111111111111';
    const modernId = '22222222-2222-4222-8222-222222222222';
    const legacyId = '33333333-3333-4333-8333-333333333333';
    const missingWorkspaceId = '44444444-4444-4444-8444-444444444444';
    writeCursorSession({ sessionId: cliId, cwd: cliCwd, title: 'CLI chat' });
    writeCursorSession({ sessionId: modernId, cwd: modernCwd, title: 'Stale CLI title' });

    const globalStorage = path.join(desktopUserRoot, 'globalStorage');
    fs.mkdirSync(globalStorage, { recursive: true });
    const state = new DatabaseSync(path.join(globalStorage, 'state.vscdb'));
    state.exec([
      'CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER,',
      'lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER, recency INTEGER, checkpointAt INTEGER,',
      'value TEXT, subagentTypeName TEXT)',
    ].join(' '));
    state.prepare([
      'INSERT INTO composerHeaders',
      '(composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, recency, value)',
      'VALUES (?, ?, ?, ?, 0, 0, ?, ?)',
    ].join(' ')).run(
      modernId,
      'modern-workspace-id',
      1785030000000,
      1785030060000,
      1785030060000,
      JSON.stringify({
        name: 'Desktop modern chat',
        workspaceIdentifier: { uri: { fsPath: modernCwd, scheme: 'file' } },
      }),
    );
    state.prepare([
      'INSERT INTO composerHeaders',
      '(composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, recency, value)',
      'VALUES (?, ?, ?, ?, 0, 0, ?, ?)',
    ].join(' ')).run(
      missingWorkspaceId,
      'missing-workspace-id',
      1785050000000,
      1785050060000,
      1785050060000,
      JSON.stringify({
        name: 'Missing workspace',
        workspaceIdentifier: { uri: { fsPath: path.join(root, 'missing-workspace'), scheme: 'file' } },
      }),
    );
    state.close();

    const workspaceDir = path.join(desktopUserRoot, 'workspaceStorage', 'legacy-workspace-id');
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, 'workspace.json'), JSON.stringify({
      folder: pathToFileURL(legacyCwd).href,
    }));
    const workspaceState = new DatabaseSync(path.join(workspaceDir, 'state.vscdb'));
    workspaceState.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
    workspaceState.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(
      'composer.composerData',
      JSON.stringify({
        allComposers: [{
          composerId: legacyId,
          name: 'Desktop legacy chat',
          createdAt: 1785040000000,
          isArchived: false,
          isDraft: false,
        }],
      }),
    );
    workspaceState.close();

    const index = new DatabaseSync(path.join(globalStorage, 'conversation-search.db'));
    index.exec([
      'CREATE TABLE conversations (source TEXT, scope TEXT, id TEXT, title TEXT, branches TEXT,',
      'updated_at INTEGER, is_archived INTEGER, root_fingerprint TEXT, cache_fingerprint TEXT)',
    ].join(' '));
    const insert = index.prepare([
      'INSERT INTO conversations',
      '(source, scope, id, title, branches, updated_at, is_archived, root_fingerprint)',
      "VALUES ('local', '', ?, ?, '', ?, 0, 'fingerprint')",
    ].join(' '));
    insert.run(modernId, 'Desktop modern chat', 1785030060000);
    insert.run(legacyId, 'Desktop legacy chat', 1785040060000);
    insert.run(missingWorkspaceId, 'Missing workspace', 1785050060000);
    index.close();

    const modernTranscript = getCursorTranscriptCandidates(modernId, modernCwd)[0]!;
    fs.mkdirSync(path.dirname(modernTranscript), { recursive: true });
    fs.writeFileSync(modernTranscript, `${JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: 'desktop' }] } })}\n`);

    const sessions = listCursorSessionFileSummaries();
    assert.deepEqual(sessions.map((session) => session.sessionId), [legacyId, modernId, cliId]);
    assert.equal(sessions.find((session) => session.sessionId === cliId)?.provider, 'tmux');
    assert.equal(sessions.find((session) => session.sessionId === modernId)?.provider, 'desktop');
    assert.equal(sessions.find((session) => session.sessionId === legacyId)?.provider, 'desktop');
    assert.equal(sessions.find((session) => session.sessionId === modernId)?.filePath, modernTranscript);
    assert.match(sessions.find((session) => session.sessionId === modernId)?.storePath || '', /store\.db$/);
    assert.equal(sessions.find((session) => session.sessionId === modernId)?.title, 'Desktop modern chat');
    assert.equal(sessions.find((session) => session.sessionId === legacyId)?.cwd, fs.realpathSync.native(legacyCwd));
    assert.equal(findCursorSessionFileById(modernId, modernCwd)?.title, 'Desktop modern chat');
    assert.equal(findCursorSessionFileById(legacyId, legacyCwd)?.title, 'Desktop legacy chat');
    assert.deepEqual(listCursorSessionFileSummaries(modernCwd).map((session) => session.sessionId), [modernId]);
    assert.deepEqual(listCursorSessionFileSummaries(undefined, 2).map((session) => session.sessionId), [legacyId, modernId]);
  });

  it('parses transcript messages, tool calls, and the terminal event incrementally', () => {
    const cwd = path.join(root, 'workspace');
    fs.mkdirSync(cwd, { recursive: true });
    const transcript = writeCursorSession({
      sessionId: '22222222-2222-4222-8222-222222222222',
      cwd,
      lines: [
        { role: 'user', message: { content: [{ type: 'text', text: 'inspect' }] } },
        { role: 'assistant', message: { content: [
          { type: 'tool_use', name: 'Read', input: { path: 'README.md' } },
          { type: 'text', text: 'done' },
        ] } },
        { role: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } },
        { role: 'tool', message: { content: [{
          type: 'text',
          text: JSON.stringify({ tool_name: 'Read', tool_result: 'file contents' }),
        }] } },
        { role: 'assistant', message: { content: [{ type: 'text', text: '<|eos|>' }] } },
        { type: 'turn_ended', status: 'success' },
      ],
    });
    const raw = fs.readFileSync(transcript, 'utf8');
    assert.deepEqual(
      parseCursorTranscriptRecords(raw).map((record) => [record.type, record.role, record.content]),
      [
        ['task_started', undefined, ''],
        ['message', 'user', 'inspect'],
        ['tool_started', undefined, ''],
        ['message', 'assistant', 'done'],
        ['tool_finished', undefined, 'file contents'],
        ['task_complete', undefined, ''],
      ],
    );
    const delta = readCursorSessionMirrorRecordDeltaByFilePath(
      transcript,
      0,
      fs.statSync(transcript).size,
      '',
      null,
      [],
    );
    assert.equal(delta.records.at(-1)?.type, 'task_complete');
    assert.equal(delta.nextOffset, fs.statSync(transcript).size);

    const splitOffset = Buffer.byteLength(`${raw.split('\n').slice(0, 2).join('\n')}\n`, 'utf8');
    const first = readCursorSessionMirrorRecordDeltaByFilePath(transcript, 0, splitOffset, '', null, []);
    const second = readCursorSessionMirrorRecordDeltaByFilePath(
      transcript,
      first.nextOffset,
      fs.statSync(transcript).size,
      first.trailingText,
      first.nextTurnId,
      first.nextSpecialCallIds,
    );
    const full = parseCursorTranscriptRecords(raw);
    const incrementalRecords = [...first.records, ...second.records];
    const uniqueIncrementalRecords = incrementalRecords.filter((record, index) => (
      incrementalRecords.findIndex((candidate) => candidate.signature === record.signature) === index
    ));
    assert.deepEqual(
      uniqueIncrementalRecords.map((record) => record.signature),
      full.map((record) => record.signature),
      'semantic duplicate signatures must let incremental consumers match full-file recovery',
    );
    assert.equal(
      first.records.find((record) => record.type === 'tool_started')?.toolId,
      second.records.find((record) => record.type === 'tool_finished')?.toolId,
      'tool identity must survive transcript chunk boundaries',
    );
    assert.equal(second.nextTurnId, null);
  });

  it('ignores timestamp-only Cursor user rows between completed turns without dropping task results', () => {
    const timestamp = '<timestamp>Friday, Oct 9, 2026, 1:44 PM (UTC+8)</timestamp>';
    const user = (text: string) => ({ role: 'user', message: { content: [{ type: 'text', text }] } });
    const assistant = (text: string) => ({ role: 'assistant', message: { content: [{ type: 'text', text }] } });
    const terminal = { type: 'turn_ended', status: 'success' };
    const meaningful = [
      user('run a background task'), assistant('task started'), terminal,
      user(`${timestamp}\n<user_query>Briefly inform the user about the task result.</user_query>`),
      assistant('Background task completed successfully.'), terminal,
    ];
    const encode = (lines: unknown[]) => lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
    const noisy = [...meaningful.slice(0, 3), ...Array.from({ length: 6 }, () => user(timestamp)), ...meaningful.slice(3)];

    assert.deepEqual(parseCursorTranscriptRecords(encode(noisy)), parseCursorTranscriptRecords(encode(meaningful)));
    assert.deepEqual(parseCursorTranscriptRecords(encode(noisy.slice(3, 9))), []);
    const subscription = { sessionId: 'metadata-flood', threadId: 'cursor-thread', pendingTurn: null };
    let started = 0;
    const turns = consumeMirrorRecords(subscription, parseCursorTranscriptRecords(encode(noisy)), {
      onTurnStarted: () => { started += 1; },
    });
    assert.equal(started, 2, 'only meaningful turns may open streaming cards');
    assert.deepEqual(turns.map((turn) => [turn.status, turn.text]), [
      ['completed', 'task started'], ['completed', 'Background task completed successfully.'],
    ]);
  });

  it('preserves an active Cursor turn, tool identity and assistant snapshot across metadata-only deltas', () => {
    const transcript = path.join(root, 'cursor-metadata-only-deltas.jsonl');
    const encode = (lines: unknown[]) => lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
    const firstText = encode([
      { role: 'user', message: { content: [{ type: 'text', text: 'inspect' }] } },
      { role: 'assistant', message: { content: [
        { type: 'tool_use', name: 'Read', input: { path: 'README.md' } },
        { type: 'text', text: 'reading' },
      ] } },
    ]);
    const metadataText = encode(Array.from({ length: 6 }, () => ({
      role: 'user', message: { content: [
        { type: 'text', text: ' \n<timestamp>Friday, Oct 9, 2026, 1:44 PM (UTC+8)</timestamp>\n ' },
        { type: 'text', text: '<|eos|>' },
      ] },
    })));
    const finalText = encode([
      { role: 'tool', message: { content: [{ type: 'text', text: JSON.stringify({ tool_name: 'Read', tool_result: 'file contents' }) }] } },
      { role: 'assistant', message: { content: [{ type: 'text', text: 'reading complete' }] } },
      { type: 'turn_ended', status: 'success' },
    ]);
    fs.writeFileSync(transcript, firstText + metadataText + finalText);
    const first = readCursorSessionMirrorRecordDeltaByFilePath(transcript, 0, Buffer.byteLength(firstText), '', null, []);
    const metadata = readCursorSessionMirrorRecordDeltaByFilePath(
      transcript, first.nextOffset, Buffer.byteLength(firstText + metadataText),
      first.trailingText, first.nextTurnId, first.nextSpecialCallIds,
    );
    assert.deepEqual(metadata.records, []);
    assert.equal(metadata.nextTurnId, first.nextTurnId);
    assert.deepEqual(metadata.nextSpecialCallIds, first.nextSpecialCallIds);
    const final = readCursorSessionMirrorRecordDeltaByFilePath(
      transcript, metadata.nextOffset, fs.statSync(transcript).size,
      metadata.trailingText, metadata.nextTurnId, metadata.nextSpecialCallIds,
    );
    assert.equal(first.records.find((record) => record.type === 'tool_started')?.toolId,
      final.records.find((record) => record.type === 'tool_finished')?.toolId);
    assert.ok(final.records.every((record) => record.turnId === first.nextTurnId));
    assert.equal(final.nextTurnId, null);
    assert.deepEqual(parseCursorTranscriptRecords(firstText + metadataText + finalText),
      parseCursorTranscriptRecords(firstText + finalText));
  });

  it('keeps mixed timestamp text and image-only user input as real Cursor turn boundaries', () => {
    const timestamp = '<timestamp>Friday, Oct 9, 2026, 1:44 PM (UTC+8)</timestamp>';
    const rows = [
      [{ type: 'text', text: `${timestamp}\nExplain this result` }],
      [{ type: 'text', text: timestamp }, { type: 'text', text: '<user_query>retry</user_query>' }],
      [{ type: 'text', text: timestamp }, { type: 'image', source: { type: 'base64', data: 'fixture' } }],
      [{ type: 'image', source: { type: 'base64', data: 'fixture' } }],
    ];
    const raw = rows.map((content) => JSON.stringify({ role: 'user', message: { content } })).join('\n') + '\n';
    assert.equal(parseCursorTranscriptRecords(raw).filter((record) => record.type === 'task_started').length, rows.length);
  });

  it('keeps identical assistant text from separate user turns without intermediate terminals', () => {
    const raw = [
      { role: 'user', message: { content: [{ type: 'text', text: 'first' }] } },
      { role: 'assistant', message: { content: [{ type: 'text', text: 'same answer' }] } },
      { role: 'user', message: { content: [{ type: 'text', text: 'second' }] } },
      { role: 'assistant', message: { content: [{ type: 'text', text: 'same answer' }] } },
      { type: 'turn_ended', status: 'success' },
    ].map((line) => JSON.stringify(line)).join('\n') + '\n';

    const records = parseCursorTranscriptRecords(raw);
    const assistantRecords = records.filter((record) => record.type === 'message' && record.role === 'assistant');
    assert.equal(assistantRecords.length, 2);
    assert.notEqual(assistantRecords[0]?.turnId, assistantRecords[1]?.turnId);
    assert.notEqual(assistantRecords[0]?.signature, assistantRecords[1]?.signature);
  });

  it('keeps semantic signatures stable when a Cursor snapshot rewrite shifts byte offsets', () => {
    const targetTurn = [
      { role: 'user', message: { content: [{
        type: 'text',
        text: '<timestamp>Thursday, Oct 8, 2026, 9:44 PM (UTC+8)</timestamp>\n<user_query>ship it</user_query>',
      }] } },
      { role: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } },
      { type: 'turn_ended', status: 'success' },
    ];
    const encode = (lines: unknown[]) => lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
    const original = parseCursorTranscriptRecords(encode(targetTurn));
    const shifted = parseCursorTranscriptRecords(encode([
      { role: 'user', message: { content: [{ type: 'text', text: 'historical prompt' }] } },
      { role: 'assistant', message: { content: [{ type: 'text', text: 'historical answer' }] } },
      ...targetTurn,
    ])).slice(-original.length);

    assert.deepEqual(shifted.map((record) => record.signature), original.map((record) => record.signature));
    assert.deepEqual(shifted.map((record) => record.turnId), original.map((record) => record.turnId));
    assert.ok(original.every((record) => record.timestamp === '2026-10-08T13:44:00.000Z'));
  });

  it('distinguishes repeated identical user rows while keeping their identities stable across rewrites', () => {
    const repeatedUser = { role: 'user', message: { content: [{
      type: 'text',
      text: '<timestamp>Thursday, Oct 8, 2026, 8:04 PM (UTC+8)</timestamp>\n<user_query>retry</user_query>',
    }] } };
    const lines = [
      repeatedUser,
      { role: 'assistant', message: { content: [{ type: 'text', text: 'first attempt' }] } },
      repeatedUser,
      { role: 'assistant', message: { content: [{ type: 'text', text: 'second attempt' }] } },
      { type: 'turn_ended', status: 'success' },
    ];
    const encode = (items: unknown[]) => items.map((line) => JSON.stringify(line)).join('\n') + '\n';
    const original = parseCursorTranscriptRecords(encode(lines));
    const shifted = parseCursorTranscriptRecords(encode([
      { role: 'user', message: { content: [{ type: 'text', text: 'unrelated older prompt' }] } },
      { role: 'assistant', message: { content: [{ type: 'text', text: 'unrelated older answer' }] } },
      ...lines,
    ])).slice(-original.length);
    const starts = original.filter((record) => record.type === 'task_started');

    assert.equal(starts.length, 2);
    assert.notEqual(starts[0]?.turnId, starts[1]?.turnId);
    assert.notEqual(starts[0]?.signature, starts[1]?.signature);
    assert.deepEqual(shifted.map((record) => record.signature), original.map((record) => record.signature));
    assert.deepEqual(shifted.map((record) => record.turnId), original.map((record) => record.turnId));
  });

  it('baselines an old offset cursor without replaying history, then emits only a future Cursor turn', () => {
    const transcript = path.join(root, 'cursor-snapshot-replay-regression.jsonl');
    const encode = (lines: unknown[]) => lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
    const user = (timestamp: string, prompt: string) => ({
      role: 'user',
      message: { content: [{ type: 'text', text: `<timestamp>${timestamp}</timestamp>\n<user_query>${prompt}</user_query>` }] },
    });
    const assistant = (answer: string) => ({
      role: 'assistant',
      message: { content: [{ type: 'text', text: answer }] },
    });
    const terminal = { type: 'turn_ended', status: 'success' };
    const existing = [
      user('Thursday, Oct 8, 2026, 8:01 PM (UTC+8)', 'old one'), assistant('old answer one'),
      user('Thursday, Oct 8, 2026, 8:50 PM (UTC+8)', 'old two'), assistant('old answer two'), terminal,
    ];
    fs.writeFileSync(transcript, encode(existing));
    const source = createCursorMirrorJsonlSource();
    const subscription = createMirrorSubscription({
      bindingId: 'cursor-binding',
      sessionId: 'cursor-session',
      channelType: 'feishu-default',
      chatId: 'cursor-chat',
      threadId: 'cursor-thread',
      filePath: transcript,
      lastDeliveredAt: '2026-10-08T13:00:00.000Z',
      readPosition: {
        threadId: 'cursor-thread',
        lastEventSignature: 'cursor:123648:legacy-offset-signature:turn-ended',
        lastEventTimestamp: '',
        lastEventCount: 42,
      },
    });
    const initial = readMirrorDeliverableRecords(subscription, {
      size: fs.statSync(transcript).size,
      mtimeMs: 1,
      identity: 'snapshot:1',
    }, source);
    assert.deepEqual(initial.records, []);

    const future = [
      ...existing,
      user('Thursday, Oct 8, 2026, 9:55 PM (UTC+8)', 'future prompt'),
      assistant('future answer'),
      terminal,
    ];
    fs.writeFileSync(transcript, encode(future));
    const next = readMirrorDeliverableRecords(subscription, {
      size: fs.statSync(transcript).size,
      mtimeMs: 2,
      identity: 'snapshot:2',
    }, source);

    assert.deepEqual(
      next.records.filter((record) => record.type === 'message').map((record) => record.content),
      [
        '<timestamp>Thursday, Oct 8, 2026, 9:55 PM (UTC+8)</timestamp>\n<user_query>future prompt</user_query>',
        'future answer',
      ],
    );
    assert.equal(next.records.filter((record) => record.type === 'task_started').length, 1);
    assert.equal(next.records.filter((record) => record.type === 'task_complete').length, 1);
  });

  it('supersedes an earlier same-turn assistant snapshot with the captured Cursor final revision', () => {
    const fixture = fs.readFileSync(path.join(
      process.cwd(),
      'src/__tests__/fixtures/runtime/cursor/assistant-snapshot-supersession.jsonl',
    ), 'utf8');
    const lines = fixture.split('\n');
    const firstSnapshotEnd = Buffer.byteLength(`${lines.slice(0, 2).join('\n')}\n`, 'utf8');
    const transcript = path.join(root, 'assistant-snapshot-supersession.jsonl');
    fs.writeFileSync(transcript, fixture);

    const fullAssistantRecords = parseCursorTranscriptRecords(fixture)
      .filter((record) => record.type === 'message' && record.role === 'assistant');
    assert.deepEqual(fullAssistantRecords.map((record) => record.content), [
      'Hey! What would you like to work on in this repo?',
    ]);
    const fullSummaryRecords = parseCursorTranscriptRecords(fixture)
      .filter((record) => record.type === 'reasoning' && record.reasoningKind === 'summary');
    assert.deepEqual(fullSummaryRecords.map((record) => record.content), [
      'Responding with concise greeting',
    ]);

    const first = readCursorSessionMirrorRecordDeltaByFilePath(
      transcript,
      0,
      firstSnapshotEnd,
      '',
      null,
      [],
    );
    const second = readCursorSessionMirrorRecordDeltaByFilePath(
      transcript,
      first.nextOffset,
      fs.statSync(transcript).size,
      first.trailingText,
      first.nextTurnId,
      first.nextSpecialCallIds,
    );
    const firstAssistant = first.records.find((record) => record.type === 'message' && record.role === 'assistant');
    const finalAssistant = second.records.find((record) => record.type === 'message' && record.role === 'assistant');
    const thinkingSummary = second.records.find((record) => (
      record.type === 'reasoning' && record.reasoningKind === 'summary'
    ));
    assert.match(firstAssistant?.content || '', /Responding with concise greeting/);
    assert.equal(finalAssistant?.content, 'Hey! What would you like to work on in this repo?');
    assert.equal(thinkingSummary?.content, 'Responding with concise greeting');
    assert.equal(firstAssistant?.replacementKey, finalAssistant?.replacementKey);
    assert.notEqual(firstAssistant?.signature, finalAssistant?.signature);
    assert.equal(second.records.at(-1)?.type, 'task_complete');
  });

  it('keeps the latest thinking summary when Cursor revises reasoning without a text-only row', () => {
    const fixture = fs.readFileSync(path.join(
      process.cwd(),
      'src/__tests__/fixtures/runtime/cursor/assistant-reasoning-revisions.jsonl',
    ), 'utf8');
    const records = parseCursorTranscriptRecords(fixture);
    assert.deepEqual(
      records
        .filter((record) => record.type === 'reasoning' && record.reasoningKind === 'summary')
        .map((record) => record.content),
      ['Confirming concise completion'],
    );
    assert.deepEqual(
      records
        .filter((record) => record.type === 'message' && record.role === 'assistant')
        .map((record) => record.content),
      ['Cursor summary revision is complete.'],
    );
    assert.deepEqual(
      records.filter((record) => record.reasoningKind === 'summary' || record.role === 'assistant').map((record) => record.type),
      ['reasoning', 'message'],
    );
    assert.equal(records.at(-1)?.type, 'task_complete');
  });

  it('keeps the latest thinking summary when Cursor revises the answer and summary together', () => {
    const records = parseCursorTranscriptRecords([
      JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: 'Confirm the result.' }] } }),
      JSON.stringify({ role: 'assistant', message: { content: [{
        type: 'text',
        text: 'The implementation is complete and no regression was found.\n\n**Providing concise status update**',
      }] } }),
      JSON.stringify({ role: 'assistant', message: { content: [{
        type: 'text',
        text: 'The implementation is complete and verified.\n\n**Providing concise confirmation**',
      }] } }),
      JSON.stringify({ type: 'turn_ended', status: 'success' }),
      '',
    ].join('\n'));

    assert.deepEqual(
      records
        .filter((record) => record.type === 'reasoning' && record.reasoningKind === 'summary')
        .map((record) => record.content),
      ['Providing concise confirmation'],
    );
    assert.deepEqual(
      records
        .filter((record) => record.type === 'message' && record.role === 'assistant')
        .map((record) => record.content),
      ['The implementation is complete and verified.'],
    );
  });

  it('recovers a single-snapshot thinking summary from the structured Cursor store', () => {
    const storePath = path.join(root, 'store.db');
    const database = new DatabaseSync(storePath);
    database.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)');
    database.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)').run(
      'assistant-message',
      JSON.stringify({
        role: 'assistant',
        content: [
          { type: 'reasoning', text: '**Preparing concise comparative analysis**' },
          { type: 'text', text: 'Structured final answer.' },
        ],
        providerOptions: { cursor: { openaiPhase: 'final_answer' } },
      }),
    );
    database.close();

    const records = parseCursorTranscriptRecords([
      JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: 'Compare the algorithms.' }] } }),
      JSON.stringify({ role: 'assistant', message: { content: [{
        type: 'text',
        text: 'Structured final answer.\n\n**Preparing concise comparative analysis**',
      }] } }),
      JSON.stringify({ type: 'turn_ended', status: 'success' }),
      '',
    ].join('\n'), storePath);

    assert.deepEqual(
      records
        .filter((record) => record.type === 'reasoning' && record.reasoningKind === 'summary')
        .map((record) => record.content),
      ['Preparing concise comparative analysis'],
    );
    assert.deepEqual(
      records
        .filter((record) => record.type === 'message' && record.role === 'assistant')
        .map((record) => record.content),
      ['Structured final answer.'],
    );
    assert.equal(records.at(-1)?.type, 'task_complete');
  });

  it('preserves a store-backed summary when Cursor rewrites the answer before turn_ended', () => {
    const storePath = path.join(root, 'rewritten-store.db');
    const database = new DatabaseSync(storePath);
    database.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)');
    database.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)').run(
      'assistant-message',
      JSON.stringify({
        role: 'assistant',
        content: [
          { type: 'reasoning', text: '**Providing concise confirmation**' },
          { type: 'text', text: 'The first concise answer.' },
        ],
        providerOptions: { cursor: { openaiPhase: 'final_answer' } },
      }),
    );
    database.close();

    const records = parseCursorTranscriptRecords([
      JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: 'Confirm the result.' }] } }),
      JSON.stringify({ role: 'assistant', message: { content: [{
        type: 'text',
        text: 'The first concise answer.\n\n**Providing concise confirmation**',
      }] } }),
      JSON.stringify({ role: 'assistant', message: { content: [{
        type: 'text',
        text: 'The final answer was reworded.',
      }] } }),
      JSON.stringify({ type: 'turn_ended', status: 'success' }),
      '',
    ].join('\n'), storePath);

    assert.deepEqual(
      records
        .filter((record) => record.type === 'reasoning' && record.reasoningKind === 'summary')
        .map((record) => record.content),
      ['Providing concise confirmation'],
    );
    assert.deepEqual(
      records
        .filter((record) => record.type === 'message' && record.role === 'assistant')
        .map((record) => record.content),
      ['The final answer was reworded.'],
    );
  });

  it('does not guess that a single-snapshot bold answer suffix is a thinking summary', () => {
    const records = parseCursorTranscriptRecords([
      JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: 'Answer with emphasis.' }] } }),
      JSON.stringify({ role: 'assistant', message: { content: [{
        type: 'text',
        text: 'This is part of the answer.\n\n**Important conclusion**',
      }] } }),
      JSON.stringify({ type: 'turn_ended', status: 'success' }),
      '',
    ].join('\n'));

    assert.equal(records.some((record) => record.reasoningKind === 'summary'), false);
    assert.deepEqual(
      records
        .filter((record) => record.type === 'message' && record.role === 'assistant')
        .map((record) => record.content),
      ['This is part of the answer.\n\n**Important conclusion**'],
    );
  });

  it('does not turn an ordinary revised answer paragraph into a thinking summary', () => {
    const records = parseCursorTranscriptRecords([
      JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: 'Revise the answer.' }] } }),
      JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: 'Stable introduction.\n\nFirst answer paragraph.' }] } }),
      JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: 'Stable introduction.\n\nRevised answer paragraph.' }] } }),
      JSON.stringify({ type: 'turn_ended', status: 'success' }),
      '',
    ].join('\n'));

    assert.equal(records.some((record) => record.reasoningKind === 'summary'), false);
    assert.deepEqual(
      records
        .filter((record) => record.type === 'message' && record.role === 'assistant')
        .map((record) => record.content),
      ['Stable introduction.\n\nRevised answer paragraph.'],
    );
  });

  it('recovers an assistant row when a rewritten transcript moves the old offset into the next user row', () => {
    const transcript = path.join(root, 'rewritten-cursor-transcript.jsonl');
    const firstUser = { role: 'user', message: { content: [{ type: 'text', text: 'first prompt' }] } };
    const firstAssistant = { role: 'assistant', message: { content: [{ type: 'text', text: 'first answer' }] } };
    const terminal = { type: 'turn_ended', status: 'success' };
    const encode = (lines: unknown[]) => lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
    fs.writeFileSync(transcript, encode([firstUser, firstAssistant, terminal]));
    const oldOffset = fs.statSync(transcript).size;

    const secondUser = { role: 'user', message: { content: [{
      type: 'text',
      text: `second prompt ${'padding '.repeat(30)}`,
    }] } };
    const secondAssistant = { role: 'assistant', message: { content: [{
      type: 'text',
      text: 'second answer after transcript rewrite',
    }] } };
    const rewritten = encode([firstUser, firstAssistant, secondUser, secondAssistant, terminal]);
    fs.writeFileSync(transcript, rewritten);
    const prefixBeforeSecondUser = Buffer.byteLength(encode([firstUser, firstAssistant]), 'utf8');
    const prefixAfterSecondUser = Buffer.byteLength(encode([firstUser, firstAssistant, secondUser]), 'utf8');
    assert.ok(oldOffset > prefixBeforeSecondUser && oldOffset < prefixAfterSecondUser);

    const delta = readCursorSessionMirrorRecordDeltaByFilePath(
      transcript,
      oldOffset,
      fs.statSync(transcript).size,
      '',
      null,
      [],
    );
    const assistant = delta.records.find((record) => record.type === 'message' && record.role === 'assistant');
    assert.equal(assistant?.content, 'second answer after transcript rewrite');
    assert.match(assistant?.replacementKey || '', /assistant-text$/);
    assert.equal(delta.records.at(-1)?.type, 'task_complete');
  });

  it('keeps a live Cursor tmux when cold workspace initialization exceeds the readiness window', { timeout: 5_000 }, async () => {
    const cwd = path.join(root, 'slow-workspace');
    fs.mkdirSync(cwd, { recursive: true });
    const core = tmuxCore as unknown as Record<string, unknown>;
    const originals = {
      hasSession: core.hasSession,
      killSession: core.killSession,
      ensureDetachedSession: core.ensureDetachedSession,
      capturePane: core.capturePane,
      ensureExtendedKeys: core.ensureExtendedKeys,
    };
    const previousTimeout = process.env.CODELARK_CURSOR_TMUX_INPUT_READY_TIMEOUT_MS;
    const previousPoll = process.env.CODELARK_CURSOR_TMUX_POLL_INTERVAL_MS;
    const previousDebug = process.env.CODELARK_DEBUG;
    let killCalls = 0;
    let launchCalls = 0;
    let sessionExists = false;
    let ready = false;
    core.hasSession = async () => ({ exists: sessionExists, command: 'tmux has-session' });
    core.ensureDetachedSession = async () => {
      launchCalls += 1;
      sessionExists = true;
      return {
        existed: false,
        command: 'tmux new-session',
        commands: ['tmux new-session'],
      };
    };
    core.capturePane = async () => ({
      screen: ready ? '→ Plan, search, build anything' : '',
      command: 'tmux capture-pane',
    });
    core.ensureExtendedKeys = async () => 'tmux set-option extended-keys on';
    core.killSession = async () => {
      killCalls += 1;
      return 'tmux kill-session';
    };
    process.env.CODELARK_CURSOR_TMUX_INPUT_READY_TIMEOUT_MS = '1000';
    process.env.CODELARK_CURSOR_TMUX_POLL_INTERVAL_MS = '50';
    delete process.env.CODELARK_DEBUG;

    try {
      const reader = streamCursorTmuxTui({
        prompt: 'hello after cold initialization',
        sessionId: 'bridge-cursor-slow-start',
        runtime: 'cursor',
        workingDirectory: cwd,
      }).getReader();
      let wire = '';
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        wire += item.value;
      }
      const events = wire.trim().split('\n').map((line) => JSON.parse(line.slice(6)) as {
        type: string;
        data: string;
      });
      assert.equal(events.at(-1)?.type, 'error');
      assert.match(events.at(-1)?.data || '', /1s 内尚未进入输入界面/);
      assert.match(events.at(-1)?.data || '', /首次打开工作区时可能仍在建立索引/);
      assert.match(events.at(-1)?.data || '', /tmux session 已保留/);
      assert.equal(killCalls, 0, 'a live cold-starting Cursor process must remain available for takeover');
      assert.equal(launchCalls, 1);

      ready = true;
      const recovered = await ensureCursorTmuxInputSession({
        prompt: 'retry after cold initialization',
        sessionId: 'bridge-cursor-slow-start',
        runtime: 'cursor',
        workingDirectory: cwd,
      });
      assert.equal(recovered.existed, true);
      assert.equal(launchCalls, 1, 'the retry must reuse the preserved Cursor process instead of restarting it');
    } finally {
      Object.assign(core, originals);
      if (previousTimeout === undefined) delete process.env.CODELARK_CURSOR_TMUX_INPUT_READY_TIMEOUT_MS;
      else process.env.CODELARK_CURSOR_TMUX_INPUT_READY_TIMEOUT_MS = previousTimeout;
      if (previousPoll === undefined) delete process.env.CODELARK_CURSOR_TMUX_POLL_INTERVAL_MS;
      else process.env.CODELARK_CURSOR_TMUX_POLL_INTERVAL_MS = previousPoll;
      if (previousDebug === undefined) delete process.env.CODELARK_DEBUG;
      else process.env.CODELARK_DEBUG = previousDebug;
    }
  });

  it('retries Enter when Cursor leaves the injected prompt in its input editor', async () => {
    const cwd = path.join(root, 'submit-retry-workspace');
    fs.mkdirSync(cwd, { recursive: true });
    const sessionId = '44444444-4444-4444-8444-444444444444';
    const core = tmuxCore as unknown as Record<string, unknown>;
    const originals = {
      hasSession: core.hasSession,
      killSession: core.killSession,
      ensureDetachedSession: core.ensureDetachedSession,
      capturePane: core.capturePane,
      injectPromptIntoPane: core.injectPromptIntoPane,
      sendActions: core.sendActions,
      ensureExtendedKeys: core.ensureExtendedKeys,
    };
    let prompt = '';
    let submitted = false;
    let retryEnterCalls = 0;
    core.hasSession = async () => ({ exists: true, command: 'tmux has-session' });
    core.killSession = async () => 'tmux kill-session';
    core.ensureDetachedSession = async () => ({ existed: false, commands: ['tmux new-session'] });
    core.capturePane = async () => ({
      screen: submitted || !prompt
        ? '→ Plan, search, build anything\n\nCodex 5.3 Medium'
        : `→ ${prompt}\n\nCodex 5.3 Medium`,
      command: 'tmux capture-pane',
    });
    core.ensureExtendedKeys = async () => 'tmux set-option extended-keys on';
    core.injectPromptIntoPane = async (_target: string, value: string) => {
      prompt = value;
      return { commands: ['tmux paste-buffer', 'tmux send-keys Enter'] };
    };
    core.sendActions = async () => {
      retryEnterCalls += 1;
      submitted = true;
      writeCursorSession({
        sessionId,
        cwd,
        lines: [
          { role: 'user', message: { content: [{ type: 'text', text: prompt }] } },
          { role: 'assistant', message: { content: [{ type: 'text', text: 'submitted after retry' }] } },
          { type: 'turn_ended', status: 'success' },
        ],
      });
      return { commands: ['tmux send-keys Enter'] };
    };

    try {
      const reader = streamCursorTmuxTui({
        prompt: 'prompt whose first Enter was swallowed',
        sessionId: 'bridge-cursor-submit-retry',
        runtime: 'cursor',
        workingDirectory: cwd,
      }).getReader();
      let wire = '';
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        wire += item.value;
      }
      const events = wire.trim().split('\n').map((line) => JSON.parse(line.slice(6)) as {
        type: string;
        data: string;
      });
      assert.equal(retryEnterCalls, 1);
      assert.ok(events.some((event) => event.type === 'text_snapshot' && event.data === 'submitted after retry'));
      assert.equal(events.at(-1)?.type, 'result');
    } finally {
      Object.assign(core, originals);
    }
  });

  it('emits a later Cursor assistant revision as a replacing snapshot across poll cycles', async () => {
    const cwd = path.join(root, 'snapshot-revision-workspace');
    fs.mkdirSync(cwd, { recursive: true });
    const sessionId = '55555555-5555-4555-8555-555555555555';
    const transcript = writeCursorSession({ sessionId, cwd });
    const core = tmuxCore as unknown as Record<string, unknown>;
    const originals = {
      hasSession: core.hasSession,
      capturePane: core.capturePane,
      injectPromptIntoPane: core.injectPromptIntoPane,
      ensureExtendedKeys: core.ensureExtendedKeys,
    };
    const previousPoll = process.env.CODELARK_CURSOR_TMUX_POLL_INTERVAL_MS;
    core.hasSession = async () => ({ exists: true, command: 'tmux has-session' });
    core.capturePane = async () => ({ screen: 'Agent\nContext 0%\n› ', command: 'tmux capture-pane' });
    core.ensureExtendedKeys = async () => 'tmux set-option extended-keys on';
    core.injectPromptIntoPane = async (_target: string, prompt: string) => {
      fs.appendFileSync(transcript, [
        { role: 'user', message: { content: [{ type: 'text', text: prompt }] } },
        { role: 'assistant', message: { content: [{
          type: 'text',
          text: 'Hey! What would you like to work on in this repo?\n\n**Responding with concise greeting**',
        }] } },
      ].map((line) => JSON.stringify(line)).join('\n') + '\n');
      setTimeout(() => {
        fs.appendFileSync(transcript, [
          { role: 'assistant', message: { content: [{
            type: 'text',
            text: 'Hey! What would you like to work on in this repo?',
          }] } },
          { type: 'turn_ended', status: 'success' },
        ].map((line) => JSON.stringify(line)).join('\n') + '\n');
      }, 500);
      return { commands: ['tmux load-buffer', 'tmux paste-buffer', 'tmux send-keys Enter'] };
    };
    process.env.CODELARK_CURSOR_TMUX_POLL_INTERVAL_MS = '50';

    try {
      const reader = streamCursorTmuxTui({
        prompt: 'hi',
        sessionId: 'bridge-cursor-snapshot-revision',
        cursorSessionId: sessionId,
        runtime: 'cursor',
        workingDirectory: cwd,
      }).getReader();
      let wire = '';
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        wire += item.value;
      }
      const events = wire.trim().split('\n').map((line) => JSON.parse(line.slice(6)) as {
        type: string;
        data: string;
      });
      const runningStatusIndex = events.findIndex((event) => {
        if (event.type !== 'status') return false;
        const status = JSON.parse(event.data) as { reasoning?: string };
        return status.reasoning === 'Cursor Agent 已接收消息，正在运行。';
      });
      const firstAssistantIndex = events.findIndex((event) => event.type === 'text_snapshot');
      assert.ok(runningStatusIndex >= 0, '输入已提交后必须从启动确认转为 Cursor 运行状态');
      assert.ok(
        firstAssistantIndex < 0 || runningStatusIndex < firstAssistantIndex,
        '运行状态必须在首个 transcript 输出前对用户可见',
      );
      const snapshots = events.filter((event) => event.type === 'text_snapshot').map((event) => event.data);
      const thinkingSummaries = events
        .filter((event) => event.type === 'history_item')
        .map((event) => JSON.parse(event.data) as { variant?: string; content?: string })
        .filter((item) => item.variant === 'thinking_summary');
      assert.equal(snapshots.length, 2, 'both revisions must cross the provider boundary so the UI can replace the first');
      assert.match(snapshots[0] || '', /Responding with concise greeting/);
      assert.equal(snapshots[1], 'Hey! What would you like to work on in this repo?');
      assert.deepEqual(thinkingSummaries, [{
        type: 'markdown',
        role: 'thinking',
        variant: 'thinking_summary',
        content: 'Responding with concise greeting',
      }]);
      assert.equal(events.at(-1)?.type, 'result');
    } finally {
      Object.assign(core, originals);
      if (previousPoll === undefined) delete process.env.CODELARK_CURSOR_TMUX_POLL_INTERVAL_MS;
      else process.env.CODELARK_CURSOR_TMUX_POLL_INTERVAL_MS = previousPoll;
    }
  });

  it('launches one managed TUI, discovers one fixed chat, and reuses both across turns', async () => {
    const cwd = path.join(root, 'workspace');
    fs.mkdirSync(cwd, { recursive: true });
    const sessionId = '33333333-3333-4333-8333-333333333333';
    const core = tmuxCore as unknown as Record<string, unknown>;
    const originals = {
      hasSession: core.hasSession,
      killSession: core.killSession,
      ensureDetachedSession: core.ensureDetachedSession,
      capturePane: core.capturePane,
      injectPromptIntoPane: core.injectPromptIntoPane,
      ensureExtendedKeys: core.ensureExtendedKeys,
    };
    let launched = 0;
    const injected: string[] = [];
    let hasSessionCalls = 0;
    core.hasSession = async () => ({ exists: hasSessionCalls++ > 0, command: 'tmux has-session' });
    core.killSession = async () => 'tmux kill-session';
    core.ensureDetachedSession = async () => {
      launched += 1;
      return { existed: false, command: 'tmux new-session', commands: ['tmux new-session'] };
    };
    core.capturePane = async () => ({ screen: 'Agent\nContext 0%\n› ', command: 'tmux capture-pane' });
    core.ensureExtendedKeys = async () => 'tmux set-option extended-keys on';
    core.injectPromptIntoPane = async (_target: string, prompt: string) => {
      injected.push(prompt);
      const lines = [
        { role: 'user', message: { content: [{ type: 'text', text: prompt }] } },
        { role: 'assistant', message: { content: [{ type: 'text', text: `Cursor answer ${injected.length}` }] } },
        { type: 'turn_ended', status: 'success' },
      ];
      if (injected.length === 1) {
        writeCursorSession({ sessionId, cwd, lines });
      } else {
        const transcript = getCursorTranscriptCandidates(sessionId, cwd)[0]!;
        fs.appendFileSync(transcript, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
      }
      return { commands: ['tmux load-buffer', 'tmux paste-buffer', 'tmux send-keys Enter'] };
    };

    try {
      async function readTurn(prompt: string, cursorSessionId?: string): Promise<Array<{ type: string; data: string }>> {
        const reader = streamCursorTmuxTui({
          prompt,
          sessionId: 'bridge-cursor-test',
          runtime: 'cursor',
          workingDirectory: cwd,
          ...(cursorSessionId ? { cursorSessionId } : {}),
        }).getReader();
        let wire = '';
        while (true) {
          const item = await reader.read();
          if (item.done) break;
          wire += item.value;
        }
        return wire.trim().split('\n').map((line) => JSON.parse(line.slice(6)) as { type: string; data: string });
      }

      const firstEvents = await readTurn('hello from bridge');
      const secondEvents = await readTurn('continue in the same chat', sessionId);
      assert.equal(launched, 1);
      assert.deepEqual(injected, ['hello from bridge', 'continue in the same chat']);
      assert.ok(firstEvents.some((event) => event.type === 'status' && event.data.includes(sessionId)));
      assert.ok(secondEvents.some((event) => event.type === 'status' && event.data.includes(sessionId)));
      assert.deepEqual(firstEvents.filter((event) => event.type === 'text_snapshot').map((event) => event.data), ['Cursor answer 1']);
      assert.deepEqual(secondEvents.filter((event) => event.type === 'text_snapshot').map((event) => event.data), ['Cursor answer 2']);
      assert.equal(firstEvents.at(-1)?.type, 'result');
      assert.equal(secondEvents.at(-1)?.type, 'result');
    } finally {
      Object.assign(core, originals);
    }
  });
});
