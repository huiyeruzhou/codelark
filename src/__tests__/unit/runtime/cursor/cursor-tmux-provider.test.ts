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
  ensureCursorTmuxInputSession,
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
    assert.match(firstAssistant?.content || '', /Responding with concise greeting/);
    assert.equal(finalAssistant?.content, 'Hey! What would you like to work on in this repo?');
    assert.equal(firstAssistant?.replacementKey, finalAssistant?.replacementKey);
    assert.notEqual(firstAssistant?.signature, finalAssistant?.signature);
    assert.equal(second.records.at(-1)?.type, 'task_complete');
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
      const snapshots = events.filter((event) => event.type === 'text_snapshot').map((event) => event.data);
      assert.equal(snapshots.length, 2, 'both revisions must cross the provider boundary so the UI can replace the first');
      assert.match(snapshots[0] || '', /Responding with concise greeting/);
      assert.equal(snapshots[1], 'Hey! What would you like to work on in this repo?');
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
