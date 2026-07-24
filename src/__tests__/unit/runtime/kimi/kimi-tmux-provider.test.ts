import '../../../setup/test-setup.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { listCommandLocalRuntimeSessions } from '../../../../bridge/session/command-use-cases/source.js';
import { resolveSessionTranscriptFile } from '../../../../bridge/session/transcript-source.js';
import {
  computeKimiWorkspaceDirName,
  createKimiMirrorJsonlSource,
  findKimiSessionFileById,
  listKimiSessionFileSummaries,
  parseKimiWireRecords,
  readKimiSessionMirrorRecordDeltaByFilePath,
  readKimiSessionMessagesByFilePath,
} from '../../../../runtime/kimi/session-index.js';
import { assertKimiLaunchAuthentication } from '../../../../runtime/kimi/auth.js';
import {
  parseKimiRuntimeErrorFromLog,
  parseKimiSessionIdFromScreen,
} from '../../../../runtime/kimi/tmux-provider.js';
import {
  applyToolCallEventToTools,
  toolCallEventFromMirrorRecord,
} from '../../../../shared/progress/tool-events.js';

describe('Kimi tmux provider helpers', () => {
  let previousKimiCodeHome: string | undefined;
  let kimiHome: string;

  beforeEach(() => {
    previousKimiCodeHome = process.env.KIMI_CODE_HOME;
    kimiHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-kimi-home-'));
    process.env.KIMI_CODE_HOME = kimiHome;
  });

  afterEach(() => {
    if (previousKimiCodeHome === undefined) {
      delete process.env.KIMI_CODE_HOME;
    } else {
      process.env.KIMI_CODE_HOME = previousKimiCodeHome;
    }
    fs.rmSync(kimiHome, { recursive: true, force: true });
  });

  it('extracts the actionable Kimi request failure from the session log', () => {
    assert.equal(parseKimiRuntimeErrorFromLog([
      '2026-07-24T09:27:41.997Z WARN  llm request failed  turnStep=3.1 attempt=1/10 model=k3 errorName=KimiError errorMessage="OAuth provider \\"managed:kimi-code\\" requires login before it can be used."',
      '2026-07-24T09:27:42.028Z ERROR turn failed  turnId=3',
    ].join('\n')), 'OAuth provider "managed:kimi-code" requires login before it can be used.');
  });

  it('fails before launching a managed Kimi provider with empty OAuth state', () => {
    fs.mkdirSync(path.join(kimiHome, 'credentials'), { recursive: true });
    fs.writeFileSync(path.join(kimiHome, 'config.toml'), [
      'default_model = "kimi-code/k3"',
      '',
      '[providers."managed:kimi-code"]',
      'type = "kimi"',
      'api_key = ""',
      '',
      '[providers."managed:kimi-code".oauth]',
      'storage = "file"',
      'key = "oauth/kimi-code"',
      '',
      '[models."kimi-code/k3"]',
      'provider = "managed:kimi-code"',
      'model = "k3"',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(kimiHome, 'credentials', 'kimi-code.json'), JSON.stringify({
      access_token: '',
      refresh_token: '',
      expires_at: 0,
    }), 'utf8');

    assert.throws(
      () => assertKimiLaunchAuthentication(),
      /managed:kimi-code is not logged in.*kimi.*login/i,
    );
  });

  function writeKimiSession(params: {
    sessionId: string;
    cwd: string;
    title: string;
    createdAt?: string;
    updatedAt?: string;
  }): string {
    const sessionDir = path.join(
      kimiHome,
      'sessions',
      computeKimiWorkspaceDirName(params.cwd),
      params.sessionId,
    );
    const agentDir = path.join(sessionDir, 'agents', 'main');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
      createdAt: params.createdAt || '2026-06-26T00:00:00.000Z',
      updatedAt: params.updatedAt || '2026-06-26T00:01:00.000Z',
      title: params.title,
      isCustomTitle: false,
      lastPrompt: 'hello kimi',
    }), 'utf-8');
    const wirePath = path.join(agentDir, 'wire.jsonl');
    fs.writeFileSync(wirePath, [
      JSON.stringify({
        type: 'context.append_message',
        time: 1782477000000,
        message: { role: 'user', content: [{ type: 'text', text: 'hello kimi' }] },
      }),
      JSON.stringify({
        type: 'context.append_loop_event',
        time: 1782477001000,
        event: {
          type: 'content.part',
          turnId: '0',
          part: { type: 'think', think: 'private Kimi thought' },
        },
      }),
      JSON.stringify({
        type: 'context.append_message',
        time: 1782477002000,
        message: { role: 'assistant', content: [{ type: 'text', text: 'hello user' }] },
      }),
    ].join('\n'), 'utf-8');
    fs.appendFileSync(
      path.join(kimiHome, 'session_index.jsonl'),
      `${JSON.stringify({ sessionId: params.sessionId, sessionDir, workDir: params.cwd })}\n`,
      'utf-8',
    );
    return wirePath;
  }

  it('parses session id from Kimi welcome screen and resume hint', () => {
    assert.equal(
      parseKimiSessionIdFromScreen('Session:   session_734e073e-5199-49cf-a004-d27fefb8e2d1'),
      'session_734e073e-5199-49cf-a004-d27fefb8e2d1',
    );
    assert.equal(
      parseKimiSessionIdFromScreen('To resume this session: kimi -r session_734e073e-5199-49cf-a004-d27fefb8e2d1'),
      'session_734e073e-5199-49cf-a004-d27fefb8e2d1',
    );
  });

  it('mirrors Kimi think parts as thinking reasoning records', () => {
    const records = parseKimiWireRecords([
      JSON.stringify({
        type: 'context.append_loop_event',
        time: 1782477026918,
        event: {
          type: 'content.part',
          turnId: '0',
          part: { type: 'think', think: 'Kimi thinking aloud' },
        },
      }),
      JSON.stringify({
        type: 'context.append_loop_event',
        time: 1782477027918,
        event: {
          type: 'content.part',
          turnId: '0',
          part: { type: 'text', text: 'visible answer' },
        },
      }),
    ].join('\n'), new Set());

    assert.deepEqual(records.map((record) => [record.type, record.content]), [
      ['reasoning', 'Kimi thinking aloud'],
      ['message', 'visible answer'],
    ]);
    assert.equal(records[0]?.reasoningKind, 'thinking');
    assert.equal(records[0]?.reasoningLabel, '思考');
  });

  it('lists Kimi sessions from session_index for /t parity', () => {
    const cwd = path.join(os.tmpdir(), 'kimi-project');
    writeKimiSession({
      sessionId: 'session_11111111-1111-4111-8111-111111111111',
      cwd,
      title: 'Kimi local session',
      updatedAt: '2026-06-26T01:00:00.000Z',
    });

    const summaries = listKimiSessionFileSummaries();
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0]?.cwd, cwd);
    assert.equal(summaries[0]?.title, 'Kimi local session');

    const commandSessions = listCommandLocalRuntimeSessions(10, 'kimi');
    assert.equal(commandSessions?.length, 1);
    assert.equal(commandSessions?.[0]?.runtime, 'kimi');
    assert.equal(commandSessions?.[0]?.originator, 'Kimi Code');
    assert.equal(commandSessions?.[0]?.cwd, cwd);
    assert.equal(commandSessions?.[0]?.userInputTurns, 1);
  });

  it('keeps Kimi session id fallback discovery scoped to the requested cwd', () => {
    const sessionId = 'session_55555555-5555-4555-8555-555555555555';
    const cwdA = path.join(os.tmpdir(), 'kimi-fallback-a');
    const cwdB = path.join(os.tmpdir(), 'kimi-fallback-b');
    const wireA = writeKimiSession({
      sessionId,
      cwd: cwdA,
      title: 'Kimi fallback A',
      updatedAt: '2026-06-26T03:00:00.000Z',
    });
    const wireB = writeKimiSession({
      sessionId,
      cwd: cwdB,
      title: 'Kimi fallback B',
      updatedAt: '2026-06-26T04:00:00.000Z',
    });
    fs.rmSync(path.join(kimiHome, 'session_index.jsonl'), { force: true });

    assert.equal(findKimiSessionFileById(sessionId, cwdA)?.filePath, wireA);
    assert.equal(findKimiSessionFileById(sessionId, cwdB)?.filePath, wireB);
    assert.equal(findKimiSessionFileById(sessionId, path.join(os.tmpdir(), 'kimi-fallback-missing')), null);
  });

  it('exposes Kimi wire files through the generic mirror source contract', () => {
    const cwd = path.join(os.tmpdir(), 'kimi-mirror-project');
    const sessionId = 'session_33333333-3333-4333-8333-333333333333';
    const wirePath = writeKimiSession({
      sessionId,
      cwd,
      title: 'Kimi mirror session',
      updatedAt: '2026-06-26T02:00:00.000Z',
    });

    const source = createKimiMirrorJsonlSource();
    const summary = source.findByThreadId(sessionId, cwd);
    assert.equal(source.runtime, 'kimi');
    assert.equal(summary?.threadId, sessionId);
    assert.equal(summary?.filePath, wirePath);
    assert.equal(summary?.cwd, cwd);
    assert.equal(summary?.updatedAt, '2026-06-26T02:00:00.000Z');

    const delta = source.readDelta(wirePath, 0, fs.statSync(wirePath).size, '', null, []);
    assert.deepEqual(delta.records.map((record) => [record.type, record.content]), [
      ['message', 'hello kimi'],
      ['reasoning', 'private Kimi thought'],
      ['message', 'hello user'],
    ]);
  });

  it('preserves partial Kimi wire lines across incremental mirror reads', () => {
    const cwd = path.join(os.tmpdir(), 'kimi-partial-project');
    const sessionId = 'session_44444444-4444-4444-8444-444444444444';
    const wirePath = writeKimiSession({
      sessionId,
      cwd,
      title: 'Kimi partial session',
    });

    const firstLine = JSON.stringify({
      type: 'context.append_message',
      time: 1782477100000,
      message: { role: 'assistant', content: [{ type: 'text', text: 'first complete answer' }] },
    });
    const thinkingLine = JSON.stringify({
      type: 'context.append_loop_event',
      time: 1782477101000,
      event: {
        type: 'content.part',
        turnId: 'turn-1',
        part: { type: 'think', think: 'Kimi resumed partial thought' },
      },
    });
    const finalLine = JSON.stringify({
      type: 'context.append_message',
      time: 1782477102000,
      message: { role: 'assistant', content: [{ type: 'text', text: 'final answer after partial' }] },
    });

    fs.writeFileSync(wirePath, `${firstLine}\n${thinkingLine.slice(0, 48)}`, 'utf-8');
    const firstDelta = readKimiSessionMirrorRecordDeltaByFilePath(
      wirePath,
      0,
      fs.statSync(wirePath).size,
      '',
      null,
      [],
    );

    assert.deepEqual(
      firstDelta.records.map((record) => [record.type, record.content]),
      [['message', 'first complete answer']],
    );
    assert.equal(firstDelta.trailingText, thinkingLine.slice(0, 48));

    fs.appendFileSync(wirePath, `${thinkingLine.slice(48)}\n${finalLine}`, 'utf-8');
    const secondDelta = readKimiSessionMirrorRecordDeltaByFilePath(
      wirePath,
      firstDelta.nextOffset,
      fs.statSync(wirePath).size,
      firstDelta.trailingText,
      null,
      [],
    );

    assert.deepEqual(
      secondDelta.records.map((record) => [record.type, record.content]),
      [
        ['reasoning', 'Kimi resumed partial thought'],
        ['message', 'final answer after partial'],
      ],
    );
    assert.equal(secondDelta.records[0]?.reasoningKind, 'thinking');
    assert.equal(secondDelta.trailingText, '');
  });

  it('keeps Kimi mirror delta reads bounded by the caller snapshot end offset', () => {
    const cwd = path.join(os.tmpdir(), 'kimi-end-offset-project');
    const sessionId = 'session_66666666-6666-4666-8666-666666666666';
    const wirePath = writeKimiSession({
      sessionId,
      cwd,
      title: 'Kimi end offset session',
    });

    const firstLine = JSON.stringify({
      type: 'context.append_message',
      time: 1782477200000,
      message: { role: 'assistant', content: [{ type: 'text', text: 'first snapshot answer' }] },
    });
    const secondLine = JSON.stringify({
      type: 'context.append_message',
      time: 1782477201000,
      message: { role: 'assistant', content: [{ type: 'text', text: 'post snapshot answer' }] },
    });
    const snapshotText = `${firstLine}\n`;
    fs.writeFileSync(wirePath, `${snapshotText}${secondLine}\n`, 'utf-8');

    const delta = readKimiSessionMirrorRecordDeltaByFilePath(
      wirePath,
      0,
      Buffer.byteLength(snapshotText),
      '',
      null,
      [],
    );

    assert.deepEqual(
      delta.records.map((record) => record.content),
      ['first snapshot answer'],
    );
    assert.equal(delta.nextOffset, Buffer.byteLength(snapshotText));
    assert.equal(delta.trailingText, '');
  });

  it('returns an empty Kimi mirror delta when the wire file disappears during reconcile', () => {
    const missingPath = path.join(kimiHome, 'sessions', 'missing', 'agents', 'main', 'wire.jsonl');

    const delta = readKimiSessionMirrorRecordDeltaByFilePath(
      missingPath,
      12,
      48,
      '{"partial"',
      'turn-existing',
      ['special-existing'],
    );

    assert.deepEqual(delta.records, []);
    assert.equal(delta.nextOffset, 12);
    assert.equal(delta.trailingText, '{"partial"');
    assert.equal(delta.nextTurnId, 'turn-existing');
    assert.deepEqual(delta.nextSpecialCallIds, ['special-existing']);
    assert.deepEqual(delta.unknownKinds, []);
  });

  it('carries Kimi active turn id across split mirror delta reads', () => {
    const cwd = path.join(os.tmpdir(), 'kimi-turn-project');
    const sessionId = 'session_77777777-7777-4777-8777-777777777777';
    const wirePath = writeKimiSession({
      sessionId,
      cwd,
      title: 'Kimi turn id session',
    });
    fs.writeFileSync(wirePath, '', 'utf-8');

    const stepBeginLine = JSON.stringify({
      type: 'context.append_loop_event',
      time: 1782477300000,
      event: {
        type: 'step.begin',
        turnId: 'turn-kimi-split',
        stepUuid: 'step-kimi-split',
      },
    });
    const usageLine = JSON.stringify({
      type: 'usage.record',
      time: 1782477301000,
      usage: {
        inputOther: 3,
        inputCacheCreation: 2,
        inputCacheRead: 5,
        output: 7,
      },
    });
    const stepEndLine = JSON.stringify({
      type: 'context.append_loop_event',
      time: 1782477302000,
      event: {
        type: 'step.end',
        turnId: 'turn-kimi-split',
        stepUuid: 'step-kimi-split',
      },
    });

    fs.writeFileSync(wirePath, `${stepBeginLine}\n`, 'utf-8');
    const firstDelta = readKimiSessionMirrorRecordDeltaByFilePath(
      wirePath,
      0,
      fs.statSync(wirePath).size,
      '',
      null,
      [],
    );

    assert.equal(firstDelta.records[0]?.type, 'task_started');
    assert.equal(firstDelta.nextTurnId, 'turn-kimi-split');

    fs.appendFileSync(wirePath, `${usageLine}\n`, 'utf-8');
    const secondDelta = readKimiSessionMirrorRecordDeltaByFilePath(
      wirePath,
      firstDelta.nextOffset,
      fs.statSync(wirePath).size,
      firstDelta.trailingText,
      firstDelta.nextTurnId,
      [],
    );

    assert.equal(secondDelta.records[0]?.type, 'context_usage');
    assert.equal(secondDelta.nextTurnId, 'turn-kimi-split');

    fs.appendFileSync(wirePath, `${stepEndLine}\n`, 'utf-8');
    const thirdDelta = readKimiSessionMirrorRecordDeltaByFilePath(
      wirePath,
      secondDelta.nextOffset,
      fs.statSync(wirePath).size,
      secondDelta.trailingText,
      secondDelta.nextTurnId,
      [],
    );

    assert.equal(thirdDelta.records[0]?.type, 'task_complete');
    assert.equal(thirdDelta.nextTurnId, null);
  });

  it('keeps terminal Kimi usage inside the completed turn instead of starting an orphan turn', () => {
    const records = parseKimiWireRecords([
      JSON.stringify({
        type: 'context.append_loop_event',
        time: 1782477350000,
        event: { type: 'step.begin', turnId: 'turn-terminal-usage', stepUuid: 'step-terminal-usage' },
      }),
      JSON.stringify({
        type: 'context.append_loop_event',
        time: 1782477351000,
        event: {
          type: 'content.part',
          turnId: 'turn-terminal-usage',
          part: { type: 'text', text: 'terminal usage answer' },
        },
      }),
      JSON.stringify({
        type: 'context.append_loop_event',
        time: 1782477352000,
        event: {
          type: 'step.end',
          turnId: 'turn-terminal-usage',
          stepUuid: 'step-terminal-usage',
          finishReason: 'end_turn',
        },
      }),
      JSON.stringify({
        type: 'usage.record',
        time: 1782477352001,
        usage: { inputOther: 13, inputCacheCreation: 2, inputCacheRead: 21, output: 8 },
      }),
    ].join('\n'), new Set());

    assert.deepEqual(records.map((record) => record.type), [
      'task_started',
      'message',
      'context_usage',
      'task_complete',
    ]);
    assert.equal(records[2]?.turnId, 'turn-terminal-usage');
    assert.equal(records[3]?.turnId, 'turn-terminal-usage');
  });

  it('drops terminal usage split into a later delta after the turn is already complete', () => {
    const cwd = path.join(os.tmpdir(), 'kimi-split-terminal-usage-project');
    const sessionId = 'session_73737373-7373-4737-8737-737373737373';
    const wirePath = writeKimiSession({ sessionId, cwd, title: 'Kimi split terminal usage' });
    fs.writeFileSync(wirePath, '', 'utf-8');

    const beginLine = JSON.stringify({
      type: 'context.append_loop_event',
      time: 1782477360000,
      event: { type: 'step.begin', turnId: 'turn-split-terminal-usage', stepUuid: 'step-split-terminal-usage' },
    });
    const endLine = JSON.stringify({
      type: 'context.append_loop_event',
      time: 1782477361000,
      event: {
        type: 'step.end',
        turnId: 'turn-split-terminal-usage',
        stepUuid: 'step-split-terminal-usage',
        finishReason: 'end_turn',
      },
    });
    const usageLine = JSON.stringify({
      type: 'usage.record',
      time: 1782477361001,
      usage: { inputOther: 5, inputCacheCreation: 0, inputCacheRead: 8, output: 3 },
    });

    fs.writeFileSync(wirePath, `${beginLine}\n`, 'utf-8');
    const beginDelta = readKimiSessionMirrorRecordDeltaByFilePath(
      wirePath, 0, fs.statSync(wirePath).size, '', null, [],
    );
    assert.equal(beginDelta.nextTurnId, 'turn-split-terminal-usage');

    fs.appendFileSync(wirePath, `${endLine}\n`, 'utf-8');
    const endDelta = readKimiSessionMirrorRecordDeltaByFilePath(
      wirePath,
      beginDelta.nextOffset,
      fs.statSync(wirePath).size,
      beginDelta.trailingText,
      beginDelta.nextTurnId,
      [],
    );
    assert.deepEqual(endDelta.records.map((record) => record.type), ['task_complete']);
    assert.equal(endDelta.nextTurnId, null);

    fs.appendFileSync(wirePath, `${usageLine}\n`, 'utf-8');
    const usageDelta = readKimiSessionMirrorRecordDeltaByFilePath(
      wirePath,
      endDelta.nextOffset,
      fs.statSync(wirePath).size,
      endDelta.trailingText,
      endDelta.nextTurnId,
      [],
    );
    assert.deepEqual(usageDelta.records, []);
    assert.equal(usageDelta.nextTurnId, null);
  });

  it('filters Kimi injection-origin messages from the generic mirror record stream', () => {
    const records = parseKimiWireRecords([
      JSON.stringify({
        type: 'context.append_message',
        time: 1782477370000,
        message: {
          role: 'user',
          content: [{ type: 'text', text: '<system-reminder>internal only</system-reminder>' }],
          origin: { kind: 'injection', variant: 'todo_list_reminder' },
        },
      }),
      JSON.stringify({
        type: 'context.append_message',
        time: 1782477371000,
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'visible user prompt' }],
          origin: { kind: 'user' },
        },
      }),
    ].join('\n'), new Set());

    assert.deepEqual(records.map((record) => record.content), ['visible user prompt']);
  });

  it('maps Kimi tool, usage, and goal wire records to the generic mirror contract', () => {
    const records = parseKimiWireRecords([
      JSON.stringify({
        type: 'context.append_loop_event',
        time: 1782477400000,
        event: {
          type: 'tool.call',
          turnId: 'turn-tool',
          toolCallId: 'tool-1',
          name: 'shell_command',
          description: 'run pwd',
          args: { command: 'pwd' },
        },
      }),
      JSON.stringify({
        type: 'context.append_loop_event',
        time: 1782477401000,
        event: {
          type: 'tool.result',
          turnId: 'turn-tool',
          toolCallId: 'tool-1',
          result: { output: '/tmp/project' },
        },
      }),
      JSON.stringify({
        type: 'usage.record',
        time: 1782477402000,
        usage: {
          inputOther: 11,
          inputCacheCreation: 3,
          inputCacheRead: 5,
          output: 7,
        },
      }),
      JSON.stringify({
        type: 'goal.create',
        time: 1782477403000,
        objective: 'ship Kimi parity',
      }),
      JSON.stringify({
        type: 'goal.update',
        time: 1782477404000,
        turnsUsed: 2,
      }),
      JSON.stringify({
        type: 'goal.clear',
        time: 1782477405000,
      }),
    ].join('\n'), new Set());

    assert.deepEqual(records.map((record) => record.type), [
      'tool_started',
      'tool_finished',
      'context_usage',
      'goal_status',
      'goal_status',
      'goal_status',
    ]);
    assert.equal(records[0]?.toolId, 'tool-1');
    assert.equal(records[0]?.toolName, 'shell_command');
    assert.deepEqual(records[0]?.toolInput, { command: 'pwd' });
    assert.equal(records[0]?.toolDetail?.kind, 'exec_command');
    assert.equal(records[1]?.toolId, 'tool-1');
    assert.equal(records[1]?.content, '/tmp/project');
    assert.deepEqual(records[2]?.contextUsage?.lastTokenUsage, {
      inputTokens: 14,
      outputTokens: 7,
      cachedInputTokens: 5,
    });
    assert.equal(records[3]?.goalObjective, 'ship Kimi parity');
    assert.equal(records[3]?.goalStatus, 'created');
    assert.equal(records[4]?.goalStatus, 'active');
    assert.equal(records[4]?.content, 'turns used: 2');
    assert.equal(records[5]?.goalStatus, 'cleared');
  });

  it('normalizes Kimi native Read, Grep, and Edit tools into the shared detail model', () => {
    const records = parseKimiWireRecords([
      JSON.stringify({
        type: 'context.append_loop_event',
        time: 1782477450000,
        event: {
          type: 'tool.call', turnId: 'turn-native', toolCallId: 'read-1', name: 'Read',
          args: { path: 'src/app.ts', line_offset: 9, n_lines: 20 },
        },
      }),
      JSON.stringify({
        type: 'context.append_loop_event',
        time: 1782477450001,
        event: { type: 'tool.result', toolCallId: 'read-1', result: { output: 'line 10\nline 11' } },
      }),
      JSON.stringify({
        type: 'context.append_loop_event',
        time: 1782477450002,
        event: {
          type: 'tool.call', turnId: 'turn-native', toolCallId: 'grep-1', name: 'Grep',
          args: { pattern: 'TODO', path: 'src', output_mode: 'content' },
        },
      }),
      JSON.stringify({
        type: 'context.append_loop_event',
        time: 1782477450003,
        event: { type: 'tool.result', toolCallId: 'grep-1', result: { output: 'src/app.ts:10:TODO' } },
      }),
      JSON.stringify({
        type: 'context.append_loop_event',
        time: 1782477450004,
        event: {
          type: 'tool.call', turnId: 'turn-native', toolCallId: 'edit-1', name: 'Edit',
          args: { path: 'src/app.ts', old_string: 'old', new_string: 'new' },
        },
      }),
    ].join('\n'), new Set());

    const tools = new Map();
    for (const record of records) {
      const event = toolCallEventFromMirrorRecord(record);
      if (event) applyToolCallEventToTools(tools, event);
    }

    assert.deepEqual(tools.get('read-1')?.detail, {
      kind: 'file_read',
      path: 'src/app.ts',
      lineOffset: 9,
      lineCount: 20,
      output: 'line 10\nline 11',
    });
    assert.deepEqual(tools.get('grep-1')?.detail, {
      kind: 'file_search',
      query: 'TODO',
      path: 'src',
      outputMode: 'content',
      matchCount: 1,
      output: 'src/app.ts:10:TODO',
    });
    assert.deepEqual(tools.get('edit-1')?.detail, {
      kind: 'file_change',
      operation: 'edit',
      path: 'src/app.ts',
      before: 'old',
      after: 'new',
    });
  });

  it('parses Kimi Bash result envelopes with the tool name retained from tool.call', () => {
    const records = parseKimiWireRecords([
      JSON.stringify({
        type: 'context.append_loop_event',
        time: 1782477460000,
        event: {
          type: 'tool.call', turnId: 'turn-bash', toolCallId: 'bash-1', name: 'Bash',
          args: { command: 'rg fixture && git diff --check' },
        },
      }),
      JSON.stringify({
        type: 'context.append_loop_event',
        time: 1782477460001,
        event: {
          type: 'tool.result', toolCallId: 'bash-1',
          result: { output: 'Script running with cell ID 90\nWall time 0.2 seconds\nOutput:\n' },
        },
      }),
    ].join('\n'), new Set());

    const tools = new Map();
    for (const record of records) {
      const event = toolCallEventFromMirrorRecord(record);
      if (event) applyToolCallEventToTools(tools, event);
    }

    assert.deepEqual(tools.get('bash-1')?.detail, {
      kind: 'exec_command',
      command: 'rg fixture && git diff --check',
      durationMs: 200,
      runningSessionId: '90',
      rawOutput: 'Script running with cell ID 90\nWall time 0.2 seconds\nOutput:\n',
    });
  });

  it('treats only terminal step.end records as turn completion and maps turn.cancel to abort', () => {
    const records = parseKimiWireRecords([
      JSON.stringify({
        type: 'context.append_loop_event',
        time: 1782477500000,
        event: { type: 'step.begin', turnId: 'turn-finish', stepUuid: 'step-1' },
      }),
      JSON.stringify({
        type: 'context.append_loop_event',
        time: 1782477500100,
        event: { type: 'step.end', turnId: 'turn-finish', stepUuid: 'step-1', finishReason: 'tool_use' },
      }),
      JSON.stringify({
        type: 'context.append_loop_event',
        time: 1782477500200,
        event: { type: 'step.begin', turnId: 'turn-finish', stepUuid: 'step-2' },
      }),
      JSON.stringify({
        type: 'context.append_loop_event',
        time: 1782477500300,
        event: { type: 'step.end', turnId: 'turn-finish', stepUuid: 'step-2', finishReason: 'end_turn' },
      }),
      JSON.stringify({
        type: 'context.append_loop_event',
        time: 1782477500400,
        event: { type: 'step.end', turnId: 'turn-finish', stepUuid: 'step-3', finishReason: 'cancelled' },
      }),
      JSON.stringify({
        type: 'turn.cancel',
        time: 1782477500500,
      }),
    ].join('\n'), new Set());

    // tool_use 是 agentic loop 的中间 step 结束，不能产出 task_complete，
    // 否则 mirror 会在第一次工具调用后就提前终结 turn。
    assert.deepEqual(records.map((record) => record.type), [
      'task_started',
      'task_started',
      'task_complete',
      'task_aborted',
      'task_aborted',
    ]);
  });

  it('reads Kimi transcript messages without leaking think parts', () => {
    const cwd = path.join(os.tmpdir(), 'kimi-transcript-project');
    const sessionId = 'session_22222222-2222-4222-8222-222222222222';
    const wirePath = writeKimiSession({
      sessionId,
      cwd,
      title: 'Kimi transcript session',
    });

    assert.deepEqual(readKimiSessionMessagesByFilePath(wirePath, 10), [
      { role: 'assistant', content: 'hello user' },
    ]);

    const resolved = resolveSessionTranscriptFile({
      id: 'bridge-kimi',
      name: 'Bridge Kimi',
      runtime: {
        activeRuntime: 'kimi',
        kimi: { sessionId, cwd },
        general: { workingDirectory: cwd },
      },
    } as any, {
      bridgeSessionId: 'bridge-kimi',
      runtimeBridgeSessionIds: { kimi: 'bridge-kimi' },
    } as any);

    assert.equal(resolved?.transcript.runtime, 'kimi');
    assert.equal(resolved?.transcript.threadId, sessionId);
    assert.equal(resolved?.source.readMessages(resolved.transcript, 10)[0]?.content, 'hello user');
    assert.deepEqual(
      resolved?.source.readHistory(resolved.transcript).map((entry) => entry.content),
      ['hello user'],
    );
  });
});
