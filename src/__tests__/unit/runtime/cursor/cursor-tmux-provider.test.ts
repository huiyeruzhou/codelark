import '../../../setup/test-setup.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
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
  prepareCursorInputConfirmation,
  streamCursorTmuxTui,
  waitForCursorInputSubmitted,
  withCursorReasoningEffort,
} from '../../../../runtime/cursor/tmux-provider.js';
import { tmuxCore, type TmuxSendAction } from '../../../../runtime/tmux/core.js';
import { createMirrorSubscription } from '../../../../bridge/mirror/subscription-state.js';
import { readMirrorDeliverableRecords } from '../../../../bridge/mirror/reconcile-core.js';
import { consumeMirrorRecords } from '../../../../bridge/mirror/turns.js';

describe('Cursor tmux provider helpers', () => {
  let root: string;
  let configRoot: string;
  let dataRoot: string;
  let desktopUserRoot: string;
  const originalReadPaneDead = tmuxCore.readPaneDead;
  let previousConfigRoot: string | undefined;
  let previousDataRoot: string | undefined;
  let previousDesktopUserRoot: string | undefined;

  beforeEach(() => {
    tmuxCore.readPaneDead = async () => false;
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
    tmuxCore.readPaneDead = originalReadPaneDead;
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
    assert.equal(isCursorInputReadyScreen([
      'Cursor Agent',
      'Loading conversation',
      '→ Plan, search, build anything',
      'Gemini 4 Carbon High',
      '/tmp/cursor-workspace',
    ].join('\n')), false);
    assert.equal(isCursorInputReadyScreen('loading Cursor Agent'), false);
  });

  it('recognizes terminal authentication failures while the Cursor process remains alive', () => {
    const liveFailure = [
      '  → Add a follow-up                           ctrl+c to stop',
      '',
      '  Error: Authentication error',
      '  If you are logged in, try logging out and back in.',
    ].join('\n');
    assert.match(cursorAuthenticationScreenError(liveFailure) || '', /credentials are invalid or expired/i);
    assert.match(
      cursorAuthenticationScreenError([
        'Authentication failed: your Cursor credentials or API key are invalid or expired.',
        'If you set CURSOR_API_KEY, check that it is correct, or run `cursor-agent login` to re-authenticate.',
      ].join('\n')) || '',
      /agent login/i,
    );
    assert.equal(isCursorInputReadyScreen(liveFailure), false);
  });

  it('distinguishes a real running Cursor pane from an unsubmitted draft', () => {
    assert.equal(isCursorInputDraftScreen([
      '  Previous assistant answer', '', '  →',
      '    核验当前任务状态，', '    汇报结果并继续监控。', '', '',
      '  Gemini 4 Carbon High · 66.2%                  Run Everything',
      '  /tmp/workspace',
    ].join('\n')), true, 'a plain multiline draft can start below an otherwise empty arrow');
    assert.equal(isCursorInputDraftScreen('  →\n\n  Gemini 4 Carbon High\n  /tmp/workspace'), false);
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
    assert.equal(
      isCursorInputDraftScreen([
        '  Previous assistant answer',
        '',
        '<codelark_source>',
        '',
        '  Gemini 4 Carbon High · 44.9%                         Run Everything',
        '  /opt/tiger/sft-datacook',
      ].join('\n')),
      true,
      'Cursor 2026.11 collapses a multiline draft to its source tag without an input arrow',
    );
    assert.equal(
      isCursorInputDraftScreen([
        '  kasumi]sandbox"',
        '  ID："target"</codelark_source>这是横向滚动后仍未提交的输入',
        '  Gemini 4 Carbon High · 44.9%                         Run Everything',
        '  /opt/tiger/sft-datacook',
      ].join('\n')),
      true,
      'a horizontally scrolled draft still exposes its closing source tag',
    );
    assert.equal(
      isCursorInputDraftScreen([
        '  来源群聊："[kasumi]sandbox"',
        '  Gemini 4 Carbon High · 44.9%                         Run Everything',
        '  /opt/tiger/sft-datacook',
      ].join('\n')),
      true,
      'a collapsed draft may expose only one CodeLark source field',
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
    assert.equal(sessions.find((session) => session.sessionId === cliId)?.transport, 'cli');
    assert.equal(sessions.find((session) => session.sessionId === modernId)?.transport, 'desktop');
    assert.equal(sessions.find((session) => session.sessionId === legacyId)?.transport, 'desktop');
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

  it('preserves a turn and pending tools across native catalog refresh and prompt replay in separate deltas', () => {
    // Shape captured from Cursor's runtime catalog refresh during a long turn.
    const fixture = fs.readFileSync(path.resolve('src/__tests__/fixtures/runtime/cursor/context-catalog-refresh.jsonl'), 'utf8');
    const lines = fixture.trim().split('\n');
    const expected = parseCursorTranscriptRecords(lines.filter((_, i) => i !== 2 && i !== 3).join('\n') + '\n');
    assert.deepEqual(parseCursorTranscriptRecords(fixture), expected);
    const file = path.join(root, 'catalog-refresh.jsonl');
    fs.writeFileSync(file, fixture);
    let cursor = { nextOffset: 0, trailingText: '', nextTurnId: null as string | null, nextSpecialCallIds: [] as string[] };
    const records: ReturnType<typeof parseCursorTranscriptRecords> = [];
    for (const line of lines) {
      const delta = readCursorSessionMirrorRecordDeltaByFilePath(file, cursor.nextOffset,
        cursor.nextOffset + Buffer.byteLength(line + '\n'), cursor.trailingText, cursor.nextTurnId, cursor.nextSpecialCallIds);
      records.push(...delta.records);
      cursor = delta;
    }
    // Incremental delivery includes the intermediate "reading" snapshot;
    // a full parse retains only the last revision of that same message.
    assert.deepEqual(records.filter((record, i) => !record.replacementKey
      || !records.slice(i + 1).some(next => next.replacementKey === record.replacementKey)), expected);
    assert.equal(records.filter(r => r.type === 'task_started').length, 1);
    assert.equal(records.find(r => r.type === 'tool_finished')?.toolId, records.find(r => r.type === 'tool_started')?.toolId);
    // A real repeat after a refresh with intervening model output is a new input.
    const actualRepeat = [...lines.slice(0, 3), lines[5], lines[3], ...lines.slice(4)].join('\n') + '\n';
    assert.equal(parseCursorTranscriptRecords(actualRepeat).filter(r => r.type === 'task_started').length, 2);
    const changedInput = [...lines.slice(0, 3), lines[3]!.replace('inspect', 'inspect again'), ...lines.slice(4)].join('\n') + '\n';
    assert.equal(parseCursorTranscriptRecords(changedInput).filter(r => r.type === 'task_started').length, 2);
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

  it('does not replay history when Cursor rewrites a larger snapshot in place or briefly truncates it', () => {
    const transcript = path.join(root, 'rewrite.jsonl');
    const user = (time: string, text: string) => ({ role: 'user', message: { content: [{ type: 'text', text: `<timestamp>${time} (UTC)</timestamp>\n<user_query>${text}</user_query>` }] } });
    const assistant = (text: string) => ({ role: 'assistant', message: { content: [{ type: 'text', text }] } });
    const old = [user('2026-11-12T08:00:00Z', 'old'), assistant('old answer'), user('2026-11-13T09:00:00Z', 'current'), assistant('current answer')];
    const source = createCursorMirrorJsonlSource();
    const subscription = createMirrorSubscription({ bindingId: 'binding', sessionId: 'session', channelType: 'feishu', chatId: 'chat', threadId: 'thread', filePath: transcript, lastDeliveredAt: null });
    let revision = 0;
    const read = (rows: unknown[]) => {
      fs.writeFileSync(transcript, rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''));
      return readMirrorDeliverableRecords(subscription, { size: fs.statSync(transcript).size, mtimeMs: ++revision, identity: 'same-inode' }, source).records;
    };
    assert.deepEqual(read(old), []);
    const signature = subscription.cursor.lastEventSignature;
    assert.deepEqual(read([]), []);
    assert.equal(subscription.cursor.lastEventSignature, signature, 'a transient empty snapshot must not erase the checkpoint');
    const rewritten = [old[0], assistant('old answer expanded '.repeat(100)), ...old.slice(2)];
    assert.deepEqual(read(rewritten), [], 'larger history revisions must not replay old messages');
    const next = read([...rewritten, user('2026-11-13T09:10:00Z', 'new local input'), assistant('new answer')]);
    assert.deepEqual(next.filter(r => r.type === 'message').map(r => r.userPrompt || r.content), ['new local input', 'new answer']);
    assert.equal(next.filter(r => r.type === 'task_started').length, 1);
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

  for (const resume of [false, true]) {
    it(`waits for delayed ${resume ? 'resumed' : 'first'} transcript output without relying on a running footer`, { timeout: 5_000 }, async () => {
      const cwd = path.join(root, 'slow-output');
      fs.mkdirSync(cwd, { recursive: true });
      const sessionId = '66666666-6666-4666-8666-666666666666';
      const transcript = resume ? writeCursorSession({ sessionId, cwd }) : undefined;
      const originals = { ...tmuxCore };
      const envNames = ['CODELARK_CURSOR_TMUX_SESSION_FILE_TIMEOUT_MS', 'CODELARK_CURSOR_TMUX_OUTPUT_IDLE_TIMEOUT_MS', 'CODELARK_CURSOR_TMUX_POLL_INTERVAL_MS'];
      const oldEnv = envNames.map((key) => process.env[key]);
      let killCalls = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      tmuxCore.hasSession = async () => ({ exists: true, command: 'tmux has-session' });
      tmuxCore.capturePane = async () => ({
        screen: '→ Plan, search, build anything',
        command: 'tmux capture-pane',
      });
      tmuxCore.ensureExtendedKeys = async () => 'tmux set-option extended-keys on';
      tmuxCore.killSession = async () => { killCalls += 1; return 'tmux kill-session'; };
      tmuxCore.injectPromptIntoPane = async (_target, prompt) => {
        timer = setTimeout(() => {
          const lines = [
            { role: 'user', message: { content: [{ type: 'text', text: prompt }] } },
            { role: 'assistant', message: { content: [{ type: 'text', text: 'late answer' }] } },
            { type: 'turn_ended', status: 'success' },
          ];
          if (transcript) fs.appendFileSync(transcript, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
          else writeCursorSession({ sessionId, cwd, lines });
        }, 1_600);
        return { commands: ['tmux paste-buffer', 'tmux send-keys Enter'] };
      };
      process.env.CODELARK_CURSOR_TMUX_SESSION_FILE_TIMEOUT_MS = '1000';
      process.env.CODELARK_CURSOR_TMUX_OUTPUT_IDLE_TIMEOUT_MS = '1000';
      process.env.CODELARK_CURSOR_TMUX_POLL_INTERVAL_MS = '50';
      try {
        const reader = streamCursorTmuxTui({
          prompt: 'slow response', sessionId: `bridge-slow-output-${resume}`, runtime: 'cursor',
          workingDirectory: cwd, ...(resume ? { cursorSessionId: sessionId } : {}),
        }).getReader();
        let wire = '';
        while (true) {
          const item = await reader.read();
          if (item.done) break;
          wire += item.value;
        }
        const events = wire.trim().split('\n').map((line) => JSON.parse(line.slice(6)));
        assert.deepEqual(events.filter((event) => event.type === 'text_snapshot').map((event) => event.data), ['late answer']);
        assert.equal(events.filter((event) => event.type === 'result').length, 1);
        assert.equal(events.some((event) => event.type === 'error'), false);
        assert.equal(killCalls, 0);
      } finally {
        clearTimeout(timer);
        Object.assign(tmuxCore, originals);
        envNames.forEach((key, index) => {
          if (oldEnv[index] === undefined) delete process.env[key];
          else process.env[key] = oldEnv[index];
        });
      }
    });
  }

  for (const resume of [false, true]) {
    for (const cancel of [false, true]) {
      it(`${cancel ? 'cancels an active turn' : 'reports a dead pane'} while waiting for ${resume ? 'resumed output' : 'the first transcript'}`, { timeout: 5_000 }, async () => {
        const cwd = path.join(root, 'missing-output');
        fs.mkdirSync(cwd, { recursive: true });
        const sessionId = '77777777-7777-4777-8777-777777777777';
        if (resume) writeCursorSession({ sessionId, cwd });
        const originals = { ...tmuxCore };
        const envNames = ['CODELARK_CURSOR_TMUX_POLL_INTERVAL_MS', 'CODELARK_DEBUG'];
        const oldEnv = envNames.map((key) => process.env[key]);
        const abortController = new AbortController();
        let killCalls = 0;
        let dead = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        tmuxCore.hasSession = async () => ({ exists: true, command: 'tmux has-session' });
        tmuxCore.capturePane = async () => ({
          screen: dead ? 'Pane is dead (status 1)' : '→ Plan, search, build anything',
          command: 'tmux capture-pane',
        });
        tmuxCore.ensureExtendedKeys = async () => 'tmux set-option extended-keys on';
        tmuxCore.killSession = async () => { killCalls += 1; return 'tmux kill-session'; };
        tmuxCore.injectPromptIntoPane = async () => {
          timer = setTimeout(() => {
            if (cancel) abortController.abort();
            else dead = true;
          }, 600);
          return { commands: ['tmux paste-buffer', 'tmux send-keys Enter'] };
        };
        process.env.CODELARK_CURSOR_TMUX_POLL_INTERVAL_MS = '50';
        delete process.env.CODELARK_DEBUG;
        try {
          const reader = streamCursorTmuxTui({
            prompt: 'no transcript yet', sessionId: `bridge-missing-output-${resume}-${cancel}`, runtime: 'cursor',
            workingDirectory: cwd, abortController, ...(resume ? { cursorSessionId: sessionId } : {}),
          }).getReader();
          let wire = '';
          while (true) {
            const item = await reader.read();
            if (item.done) break;
            wire += item.value;
          }
          const events = wire.trim().split('\n').map((line) => JSON.parse(line.slice(6)));
          assert.equal(events.at(-1)?.type, 'error');
          assert.match(events.at(-1)?.data, cancel ? /aborted/ : /Cursor Agent exited.*exit 1/);
          assert.equal(events.some((event) => event.type === 'result'), false);
          // The stream closes before asynchronous cleanup finishes.
          await new Promise((resolve) => setTimeout(resolve, 0));
          assert.equal(killCalls, 1);
        } finally {
          clearTimeout(timer);
          Object.assign(tmuxCore, originals);
          envNames.forEach((key, index) => {
            if (oldEnv[index] === undefined) delete process.env[key];
            else process.env[key] = oldEnv[index];
          });
        }
      });
    }
  }

  it('fails an accepted Cursor turn when its live pane reports expired credentials', { timeout: 5_000 }, async () => {
    const cwd = path.join(root, 'expired-auth-output');
    fs.mkdirSync(cwd, { recursive: true });
    const sessionId = '88888888-8888-4888-8888-888888888888';
    writeCursorSession({ sessionId, cwd });
    const originals = { ...tmuxCore };
    const previousPoll = process.env.CODELARK_CURSOR_TMUX_POLL_INTERVAL_MS;
    const previousDebug = process.env.CODELARK_DEBUG;
    let killCalls = 0;
    let authFailed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    tmuxCore.hasSession = async () => ({ exists: true, command: 'tmux has-session' });
    tmuxCore.capturePane = async () => ({
      screen: authFailed
        ? 'Error: Authentication error\nIf you are logged in, try logging out and back in.'
        : '→ Plan, search, build anything',
      command: 'tmux capture-pane',
    });
    tmuxCore.ensureExtendedKeys = async () => 'tmux set-option extended-keys on';
    tmuxCore.killSession = async () => { killCalls += 1; return 'tmux kill-session'; };
    tmuxCore.injectPromptIntoPane = async () => {
      timer = setTimeout(() => { authFailed = true; }, 600);
      return { commands: ['tmux paste-buffer', 'tmux send-keys Enter'] };
    };
    process.env.CODELARK_CURSOR_TMUX_POLL_INTERVAL_MS = '50';
    delete process.env.CODELARK_DEBUG;

    try {
      let accepted = 0;
      const reader = streamCursorTmuxTui({
        onInputAccepted: () => { accepted += 1; },
        prompt: 'continue the previous task',
        sessionId: 'bridge-cursor-expired-auth',
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
      assert.equal(accepted, 1, 'the failure happens after CodeLark accepted the user message');
      assert.ok(events.some((event) => event.type === 'status'
        && JSON.parse(event.data).reasoning === 'Cursor Agent 已接收消息，正在运行。'));
      assert.equal(events.at(-1)?.type, 'error');
      assert.match(events.at(-1)?.data || '', /credentials are invalid or expired/i);
      assert.match(events.at(-1)?.data || '', /agent login/i);
      assert.equal(events.some((event) => event.type === 'result'), false);
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(killCalls, 1, 'an unrecoverable authenticated turn must not remain falsely running');
    } finally {
      clearTimeout(timer);
      Object.assign(tmuxCore, originals);
      if (previousPoll === undefined) delete process.env.CODELARK_CURSOR_TMUX_POLL_INTERVAL_MS;
      else process.env.CODELARK_CURSOR_TMUX_POLL_INTERVAL_MS = previousPoll;
      if (previousDebug === undefined) delete process.env.CODELARK_DEBUG;
      else process.env.CODELARK_DEBUG = previousDebug;
    }
  });

  for (const footer of ['enter steer · ↑ select/edit · esc cancel', '+2 more lines · enter steer · ↑ select/edit · esc cancel', 'enter interrupt and send · ↑ select/edit · esc cancel', 'steering', '']) {
    it(`only promotes a queued follow-up when Cursor offers steer: ${footer || 'idle'}`, async () => {
      const originals = { capturePane: tmuxCore.capturePane, sendActions: tmuxCore.sendActions };
      const sent: unknown[] = [];
      tmuxCore.capturePane = async () => ({ screen: footer && sent.length === 0
        ? `┌─ follow-ups ──┐\n│ change direction │\n│ ${footer} │\n└─────────┘\n→ Add a follow-up    ctrl+c to stop`
        : '→ Plan, search, build anything', command: '' });
      tmuxCore.sendActions = async (_target, actions) => { sent.push(actions); return { commands: [] }; };
      try {
        await waitForCursorInputSubmitted('isolated-pane');
        assert.deepEqual(sent, footer.includes('enter steer') ? [[{ type: 'key', key: 'Enter' }]] : []);
      } finally { Object.assign(tmuxCore, originals); }
    });
  }

  for (const delivered of [true, false]) it(`steer waits for acceptance and never interrupts a pending injection (${delivered ? 'delivered' : 'pending'})`, async (t) => {
    const prompt = 'change direction';
    let queued = false, submitted = false, pendingCaptures = 0;
    const sends: unknown[] = [];
    const timeout = process.env.CODELARK_CURSOR_TMUX_INPUT_READY_TIMEOUT_MS;
    const pollInterval = process.env.CODELARK_CURSOR_TMUX_POLL_INTERVAL_MS;
    if (!delivered) {
      process.env.CODELARK_CURSOR_TMUX_INPUT_READY_TIMEOUT_MS = '3000';
      process.env.CODELARK_CURSOR_TMUX_POLL_INTERVAL_MS = '50';
    }
    t.after(() => {
      if (timeout === undefined) delete process.env.CODELARK_CURSOR_TMUX_INPUT_READY_TIMEOUT_MS;
      else process.env.CODELARK_CURSOR_TMUX_INPUT_READY_TIMEOUT_MS = timeout;
      if (pollInterval === undefined) delete process.env.CODELARK_CURSOR_TMUX_POLL_INTERVAL_MS;
      else process.env.CODELARK_CURSOR_TMUX_POLL_INTERVAL_MS = pollInterval;
    });
    t.mock.method(tmuxCore, 'capturePane', async () => {
      if (submitted) pendingCaptures++;
      return { screen: queued && !(delivered && pendingCaptures >= 2)
        ? `┌─ follow-ups ──┐\n│ ○ ${prompt} │\n│ ${submitted ? 'steering' : 'enter steer · ↑ select/edit · esc cancel'} │\n└─────────┘\n→ Add a follow-up    ctrl+c to stop`
        : `${submitted ? prompt : ''}\n→ Add a follow-up    ctrl+c to stop`, command: '' };
    });
    t.mock.method(tmuxCore, 'sendActions', async (_target: string, actions: TmuxSendAction[]) => { sends.push(actions); submitted = true; return { commands: [] }; });
    const confirmation = await prepareCursorInputConfirmation('isolated-pane', prompt);
    queued = true;
    const abort = new AbortController();
    const timer = delivered ? undefined : setTimeout(() => abort.abort(), 3_500);
    t.after(() => clearTimeout(timer));
    const submission = waitForCursorInputSubmitted('isolated-pane', undefined, confirmation, abort.signal);
    if (delivered) await submission;
    else await assert.rejects(submission, { name: 'AbortError' });
    assert.deepEqual(sends, [[{ type: 'key', key: 'Enter' }]]);
    assert.ok(pendingCaptures > 0, 'input must not return immediately after requesting steer');
  });

  it('waits for a safe steer window instead of choosing interrupt and send', async (t) => {
    const prompt = 'change direction without interrupting the active turn';
    let queued = false;
    let interruptOnlyFrames = 0;
    let steerSent = false;
    const sends: TmuxSendAction[][] = [];
    t.mock.method(tmuxCore, 'capturePane', async () => {
      if (!queued) {
        return { screen: '→ Add a follow-up    ctrl+c to stop', command: '' };
      }
      if (steerSent) {
        return { screen: `${prompt}\n→ Add a follow-up    ctrl+c to stop`, command: '' };
      }
      interruptOnlyFrames += 1;
      const footer = interruptOnlyFrames < 3
        ? 'enter interrupt and send · ↑ select/edit · esc cancel'
        : 'enter steer · ↑ select/edit · esc cancel';
      return {
        screen: `┌─ follow-ups ──┐\n│ ○ ${prompt} │\n│ ${footer} │\n└─────────┘\n→ Add a follow-up    ctrl+c to stop`,
        command: '',
      };
    });
    t.mock.method(tmuxCore, 'sendActions', async (_target: string, actions: TmuxSendAction[]) => {
      sends.push(actions);
      steerSent = true;
      return { commands: [] };
    });

    const confirmation = await prepareCursorInputConfirmation('isolated-pane', prompt);
    assert.equal(confirmation.running, true);
    queued = true;
    await waitForCursorInputSubmitted('isolated-pane', undefined, confirmation);

    assert.ok(interruptOnlyFrames >= 3, 'the test must observe interrupt-only frames before steer becomes safe');
    assert.deepEqual(sends, [[{ type: 'key', key: 'Enter' }]], 'only the safe enter-steer action may be sent');
  });

  it('does not acknowledge an idle input from an old empty editor or an identical historical message', async (t) => {
    const prompt = 'continue with the configuration';
    const storePath = path.join(root, 'idle-confirmation.db');
    const db = new DatabaseSync(storePath);
    db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY,value TEXT); CREATE TABLE blobs (id TEXT PRIMARY KEY,data BLOB)');
    const message = Buffer.from(JSON.stringify({ role: 'user', content: [{ type: 'text', text: prompt }] }));
    const messageId = crypto.createHash('sha256').update(message).digest('hex');
    const rootBlob = Buffer.concat([Buffer.from([10, 32]), Buffer.from(messageId, 'hex')]);
    const rootId = crypto.createHash('sha256').update(rootBlob).digest('hex');
    db.prepare('INSERT INTO blobs VALUES (?,?)').run(messageId, message);
    db.prepare('INSERT INTO blobs VALUES (?,?)').run(rootId, rootBlob);
    db.prepare("INSERT INTO meta VALUES ('0',?)").run(Buffer.from(JSON.stringify({ latestRootBlobId: rootId })).toString('hex'));
    db.close();
    const keys = ['CODELARK_CURSOR_TMUX_INPUT_READY_TIMEOUT_MS', 'CODELARK_CURSOR_TMUX_POLL_INTERVAL_MS'];
    const old = keys.map(key => process.env[key]);
    process.env[keys[0]!] = '1000'; process.env[keys[1]!] = '50';
    t.after(() => keys.forEach((key, i) => { if (old[i] === undefined) delete process.env[key]; else process.env[key] = old[i]; }));
    const sends: TmuxSendAction[][] = [];
    t.mock.method(tmuxCore, 'capturePane', async () => ({ screen: '→ Add a follow-up', command: '' }));
    t.mock.method(tmuxCore, 'sendActions', async (_target: string, actions: TmuxSendAction[]) => { sends.push(actions); return { commands: [] }; });
    const confirmation = await prepareCursorInputConfirmation('isolated-pane', prompt, storePath);
    assert.equal(confirmation.nativeCount, 1);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 1_500);
    t.after(() => clearTimeout(timer));
    await assert.rejects(waitForCursorInputSubmitted('isolated-pane', undefined, confirmation, abort.signal), { name: 'AbortError' });
    assert.deepEqual(sends, [], 'an empty editor waiting for native acceptance must not cause extra Enter presses');
  });

  for (const queued of [false, true]) it(`preserves another draft while Cursor is ${queued ? 'queued' : 'running'}`, async (t) => {
    t.mock.method(tmuxCore, 'capturePane', async () => ({ screen:
      `${queued ? '┌─ follow-ups ──┐\n│ earlier input │\n└────┘\n' : ''}→ existing draft    ctrl+c to stop`, command: '' }));
    t.mock.method(tmuxCore, 'sendActions', async () => { assert.fail('preflight must neither interrupt nor submit another draft'); });
    await assert.rejects(prepareCursorInputConfirmation('isolated-pane', 'new message'), /本条消息尚未发送/);
  });

  it('never retries Enter after observing a running turn, including a later retained draft', async (t) => {
    const sends: TmuxSendAction[][] = [];
    let frames = 0;
    t.mock.method(tmuxCore, 'capturePane', async () => ({ screen: ++frames === 1
      ? 'Working …    ctrl+c to stop\nGemini 4 Carbon High'
      : '→ old submitted multiline draft\nGemini 4 Carbon High', command: '' }));
    t.mock.method(tmuxCore, 'sendActions', async (_target: string, actions: TmuxSendAction[]) => { sends.push(actions); return { commands: [] }; });
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 1_500);
    t.after(() => clearTimeout(timer));
    await assert.rejects(waitForCursorInputSubmitted('isolated-pane', undefined, {
      prompt: 'pending native checkpoint', nativeCount: 0, screenCount: 0, running: false,
    }, abort.signal), { name: 'AbortError' });
    assert.ok(frames >= 2);
    assert.deepEqual(sends, [], 'running and completed frames cannot authorize resubmission');
  });

  it('retries an initially idle submission once when Cursor hides every draft marker', async (t) => {
    const prompt = 'initial prompt hidden by the collapsed editor';
    let submitted = false;
    const sends: TmuxSendAction[][] = [];
    t.mock.method(tmuxCore, 'capturePane', async () => ({
      screen: submitted
        ? `${prompt}\n→ Plan, search, build anything`
        : 'kasumi]sandbox"\n\nGemini 4 Carbon High\n/opt/tiger/workspace',
      command: '',
    }));
    t.mock.method(tmuxCore, 'sendActions', async (_target: string, actions: TmuxSendAction[]) => {
      sends.push(actions);
      submitted = true;
      return { commands: [] };
    });

    await waitForCursorInputSubmitted('isolated-pane', undefined, {
      prompt,
      screenCount: 0,
      running: false,
    });

    assert.deepEqual(sends, [[{ type: 'key', key: 'Enter' }]]);
  });

  it('cancels input confirmation promptly even while a queued input retains a draft', async (t) => {
    const abort = new AbortController();
    let sends = 0;
    t.mock.method(tmuxCore, 'capturePane', async () => ({ screen: '┌─ follow-ups ──┐\n│ ○ change direction │\n│ enter steer · ↑ select/edit · esc cancel │\n└────┘\n→ change direction', command: '' }));
    t.mock.method(tmuxCore, 'sendActions', async () => { sends++; abort.abort(); return { commands: [] }; });
    const started = Date.now();
    await assert.rejects(waitForCursorInputSubmitted('isolated-pane', undefined, { prompt: 'change direction', screenCount: 0, running: true }, abort.signal), { name: 'AbortError' });
    assert.equal(sends, 1, 'queued input allows only one promotion, never draft resubmissions');
    assert.ok(Date.now() - started < 2_000);
  });

  it('ends receipt waiting when tmux retains the dead process last frame', async (t) => {
    t.mock.method(tmuxCore, 'capturePane', async () => ({ screen: '→ Add a follow-up    ctrl+c to stop', command: '' }));
    tmuxCore.readPaneDead = async () => true;
    t.mock.method(tmuxCore, 'sendActions', async () => { assert.fail('dead panes cannot receive retry keys'); });
    await assert.rejects(waitForCursorInputSubmitted('dead-pane:0.0', undefined, {
      prompt: 'pending input', screenCount: 0, running: true,
    }), /Cursor Agent exited before confirming input/);
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
    let accepted = 0;
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
        onInputAccepted: () => { assert.equal(submitted, true); accepted++; },
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
      assert.equal(accepted, 1);
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

  it('recovers resumed snapshot rewrites and late native results without replaying the baseline', async () => {
    const cwd = path.join(root, 'resume-rewrite');
    fs.mkdirSync(cwd, { recursive: true });
    const sessionId = '33333333-3333-4333-8333-333333333334';
    const user = { role: 'user', message: { content: [{ type: 'text', text: 'inspect' }] } };
    const args = { glob_pattern: '*.py', target_directory: cwd };
    const calls = (count: number) => ({ role: 'assistant', message: {
      content: Array.from({ length: count }, () => ({ type: 'tool_use', name: 'Glob', input: args })),
    } });
    const terminal = { type: 'turn_ended', status: 'success' };
    const old = [user, calls(1), { role: 'assistant', message: { content: [{ type: 'text', text: 'old answer' }] } }];
    const wire = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
    const transcript = writeCursorSession({ sessionId, cwd, lines: [...old, terminal] });
    const baselineSize = fs.statSync(transcript).size;
    const store = path.join(configRoot, 'chats', cursorWorkspaceHash(cwd), sessionId, 'store.db');
    fs.unlinkSync(store);
    const db = new DatabaseSync(store);
    db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY,value TEXT); CREATE TABLE blobs (id TEXT PRIMARY KEY,data BLOB)');
    const put = (bytes: Buffer) => {
      const id = crypto.createHash('sha256').update(bytes).digest('hex');
      db.prepare('INSERT OR IGNORE INTO blobs VALUES (?,?)').run(id, bytes);
      return id;
    };
    const checkpoint = (messages: unknown[]) => {
      const refs = messages.map((m) => Buffer.concat([Buffer.from([10, 32]), Buffer.from(put(Buffer.from(JSON.stringify(m))), 'hex')]));
      const id = put(Buffer.concat(refs));
      db.prepare("INSERT OR REPLACE INTO meta VALUES ('0',?)").run(Buffer.from(JSON.stringify({ latestRootBlobId: id })).toString('hex'));
    };
    const nativeUser = { role: 'user', content: user.message.content };
    const nativeCalls = (...ids: string[]) => ({ role: 'assistant', content: ids.map((id) => ({ type: 'tool-call', toolName: 'Glob', toolCallId: id, args })) });
    const result = (id: string, isError = false) => ({ role: 'tool', content: [{ type: 'tool-result', toolName: 'Glob', toolCallId: id, result: `${id}.py`, isError }] });
    checkpoint([nativeUser, nativeCalls('old')]);
    const current = [...old, user, calls(2)];
    assert.ok(Buffer.byteLength(wire(current)) > baselineSize, 'a growing rewrite still invalidates the old offset');
    const core = tmuxCore as unknown as Record<string, unknown>;
    const originals = { hasSession: core.hasSession, capturePane: core.capturePane, injectPromptIntoPane: core.injectPromptIntoPane, ensureExtendedKeys: core.ensureExtendedKeys };
    const previousPoll = process.env.CODELARK_CURSOR_TMUX_POLL_INTERVAL_MS;
    process.env.CODELARK_CURSOR_TMUX_POLL_INTERVAL_MS = '50';
    let injected = false;
    let polls = 0;
    core.hasSession = async () => ({ exists: true, command: 'tmux has-session' });
    core.ensureExtendedKeys = async () => '';
    core.injectPromptIntoPane = async () => { injected = true; return { commands: [] }; };
    core.capturePane = async () => {
      if (injected) {
        polls += 1;
        // The old terminal remains visible for the first poll after submit.
        if (polls === 2) {
          fs.writeFileSync(transcript, wire(current));
          checkpoint([nativeUser, nativeCalls('old'), nativeUser, nativeCalls('one', 'two')]);
        }
        if (polls === 3) checkpoint([nativeUser, nativeCalls('old'), result('old'), nativeUser, nativeCalls('one', 'two'), result('one'), result('two', true)]);
        // Another unchanged snapshot must not repeat tools or their results.
        if (polls === 5) fs.writeFileSync(transcript, wire([...current, terminal]));
      }
      return { screen: 'Agent\nContext 0%\n› ', command: 'tmux capture-pane' };
    };
    try {
      const events: Array<{ type: string; data: string }> = [];
      const reader = streamCursorTmuxTui({ prompt: 'inspect', sessionId: 'bridge-resume-rewrite', runtime: 'cursor', workingDirectory: cwd, cursorSessionId: sessionId }).getReader();
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        for (const line of item.value.trim().split('\n')) events.push(JSON.parse(line.slice(6)));
      }
      const starts = events.filter((e) => e.type === 'tool_use').map((e) => JSON.parse(e.data));
      const results = events.filter((e) => e.type === 'tool_result').map((e) => JSON.parse(e.data));
      assert.equal(starts.length, 2);
      assert.deepEqual(results.map((r) => [r.tool_use_id, r.content, r.is_error]), [
        [starts[0].id, 'one.py', false], [starts[1].id, 'two.py', true],
      ]);
      assert.equal(events.filter((e) => e.type === 'result').length, 1);
      assert.equal(events.at(-1)?.type, 'result');
      assert.ok(!events.some((e) => e.data.includes('old answer') || e.data.includes('old.py')));
      assert.equal(polls, 5);
    } finally {
      Object.assign(core, originals);
      db.close();
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
