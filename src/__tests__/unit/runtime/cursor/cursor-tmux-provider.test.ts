import '../../../setup/test-setup.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
  buildCursorTmuxLaunchCommand,
  cursorAuthenticationScreenError,
  cursorTmuxSessionName,
  isCursorInputReadyScreen,
  streamCursorTmuxTui,
} from '../../../../runtime/cursor/tmux-provider.js';
import { tmuxCore } from '../../../../bridge/tmux/core.js';

describe('Cursor tmux provider helpers', () => {
  let root: string;
  let configRoot: string;
  let dataRoot: string;
  let previousConfigRoot: string | undefined;
  let previousDataRoot: string | undefined;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-cursor-'));
    configRoot = path.join(root, 'config');
    dataRoot = path.join(root, 'data');
    previousConfigRoot = process.env.CURSOR_CONFIG_DIR;
    previousDataRoot = process.env.CURSOR_DATA_DIR;
    process.env.CURSOR_CONFIG_DIR = configRoot;
    process.env.CURSOR_DATA_DIR = dataRoot;
  });

  afterEach(() => {
    if (previousConfigRoot === undefined) delete process.env.CURSOR_CONFIG_DIR;
    else process.env.CURSOR_CONFIG_DIR = previousConfigRoot;
    if (previousDataRoot === undefined) delete process.env.CURSOR_DATA_DIR;
    else process.env.CURSOR_DATA_DIR = previousDataRoot;
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

  it('uses the official cwd hash, workspace slug, and encoded transcript id', () => {
    const cwd = path.join(root, 'project with spaces');
    fs.mkdirSync(cwd, { recursive: true });
    assert.match(cursorWorkspaceHash(cwd), /^[a-f0-9]{32}$/);
    assert.equal(cursorWorkspaceSlug(cwd), path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, ''));
    assert.equal(encodeCursorConversationId('chat/id'), 'chat_2Fid');
  });

  it('lists and resolves Cursor chat metadata with its transcript', () => {
    const cwd = path.join(root, 'workspace');
    fs.mkdirSync(cwd, { recursive: true });
    const sessionId = '11111111-1111-4111-8111-111111111111';
    const transcript = writeCursorSession({ sessionId, cwd });

    assert.equal(listCursorSessionFileSummaries(cwd)[0]?.filePath, transcript);
    assert.equal(findCursorSessionFileById(sessionId, cwd)?.title, 'Cursor local session');
    assert.equal(createCursorMirrorJsonlSource().findByThreadId(sessionId, cwd)?.filePath, transcript);
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
      assert.deepEqual(firstEvents.filter((event) => event.type === 'text').map((event) => event.data), ['Cursor answer 1']);
      assert.deepEqual(secondEvents.filter((event) => event.type === 'text').map((event) => event.data), ['Cursor answer 2']);
      assert.equal(firstEvents.at(-1)?.type, 'result');
      assert.equal(secondEvents.at(-1)?.type, 'result');
    } finally {
      Object.assign(core, originals);
    }
  });
});
