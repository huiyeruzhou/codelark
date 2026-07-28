import '../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  basicDialogueStreamCardCheckpointIssues,
  collectRealE2eDump,
  cursorStreamCardUnifiedUiIssues,
  kimiThinkingStatusOnlyIssues,
  scriptedKimiToolCardIssues,
  scriptedKimiHistoryTranscriptIssues,
  scriptedKimiLifecycleAndSteerIssues,
  scriptedKimiRuntimeSlotIssues,
  scriptedKimiWireTranscriptIssues,
  streamCardCheckpointVisibleText,
} from '../../../bridge/diagnostics/real-e2e-dump.js';
import { computeKimiWorkspaceDirName } from '../../../runtime/kimi/session-index.js';
import {
  cursorWorkspaceHash,
  getCursorTranscriptCandidates,
} from '../../../runtime/cursor/session-index.js';

describe('unit::real-e2e-dump::live-log-scoping', () => {
  it('extracts stream keys only from lines related to the requested chat/session', () => {
    const codelarkHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-real-e2e-dump-'));
    try {
      const dataDir = path.join(codelarkHome, 'data');
      const logsDir = path.join(codelarkHome, 'logs');
      const messagesDir = path.join(dataDir, 'messages');
      fs.mkdirSync(messagesDir, { recursive: true });
      fs.mkdirSync(logsDir, { recursive: true });

      const chatId = 'oc_target_chat';
      const bridgeSessionId = 'session-target';
      fs.writeFileSync(path.join(dataDir, 'channel-chats.json'), JSON.stringify({
        binding: {
          id: 'binding-target',
          channelType: 'feishu-default',
          chatId,
          bridgeSessionId,
        },
      }));
      fs.writeFileSync(path.join(dataDir, 'sessions.json'), JSON.stringify({
        [bridgeSessionId]: {
          id: bridgeSessionId,
          name: 'target session',
          runtime: {
            activeRuntime: 'codex',
            codex: {
              threadId: 'thread-target',
              provider: 'sdk',
            },
          },
        },
      }));
      fs.writeFileSync(path.join(messagesDir, `${bridgeSessionId}.json`), JSON.stringify([
        { role: 'assistant', content: 'ok' },
      ]));
      fs.writeFileSync(path.join(dataDir, 'audit.json'), JSON.stringify([
        { direction: 'outbound', chatId, summary: 'target' },
      ]));
      fs.writeFileSync(path.join(logsDir, 'bridge.log'), [
        "[INFO] Streaming card create payload: { streamKey: 'mirror:old-session:old-turn', chatId: 'oc_unrelated' }",
        "[INFO] Request success: scope=oc_unrelated, target=im.message.create:interactive, message_id=om_old",
        JSON.stringify({
          level: 'INFO',
          msg: 'Streaming card create payload:',
          stream_key: `im:${bridgeSessionId}:om_target`,
          chat: chatId,
        }),
        JSON.stringify({
          level: 'INFO',
          event: 'perf.feishu.request',
          status: 'success',
          scope: chatId,
          operation: 'im.message.reply:post',
          message_id: 'om_target_reply',
          msg: 'Request success:',
        }),
      ].join('\n'));

      const report = collectRealE2eDump({
        codelarkHome,
        channelType: 'feishu-default',
        chatId,
        bridgeSessionId,
        logTailBytes: 16_000,
      });

      assert.deepEqual(report.streamKeys, [`im:${bridgeSessionId}:om_target`]);
      assert.deepEqual(report.responseMessageIds, ['om_target_reply']);
    } finally {
      fs.rmSync(codelarkHome, { recursive: true, force: true });
    }
  });

  it('parses structured stream-card checkpoint lines from relevant bridge logs', () => {
    const codelarkHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-real-e2e-dump-'));
    try {
      const dataDir = path.join(codelarkHome, 'data');
      const logsDir = path.join(codelarkHome, 'logs');
      const messagesDir = path.join(dataDir, 'messages');
      fs.mkdirSync(messagesDir, { recursive: true });
      fs.mkdirSync(logsDir, { recursive: true });

      const chatId = 'oc_checkpoint_chat';
      const bridgeSessionId = 'session-checkpoint';
      const runId = 'checkpoint-run';
      fs.writeFileSync(path.join(dataDir, 'channel-chats.json'), JSON.stringify({
        binding: {
          id: 'binding-checkpoint',
          channelType: 'feishu-default',
          chatId,
          bridgeSessionId,
        },
      }));
      fs.writeFileSync(path.join(dataDir, 'sessions.json'), JSON.stringify({
        [bridgeSessionId]: {
          id: bridgeSessionId,
          name: `target ${runId}`,
          runtime: {
            activeRuntime: 'codex',
            codex: {
              threadId: 'thread-checkpoint',
              provider: 'sdk',
            },
          },
        },
      }));
      fs.writeFileSync(path.join(messagesDir, `${bridgeSessionId}.json`), JSON.stringify([
        { role: 'assistant', content: 'ok' },
      ]));
      fs.writeFileSync(path.join(dataDir, 'audit.json'), JSON.stringify([
        { direction: 'outbound', chatId, summary: runId },
      ]));
      fs.writeFileSync(path.join(logsDir, 'bridge.log'), [
        '[real-feishu-e2e:stream-card-checkpoint] {"kind":"refresh","streamKey":"im:old:om_old","markdownTexts":["unrelated"]}',
        `[real-feishu-e2e:stream-card-checkpoint] ${JSON.stringify({
          kind: 'refresh',
          streamKey: `im:${bridgeSessionId}:om_checkpoint`,
          chatId,
          status: 'streaming',
          sequence: 2,
          names: ['Bash'],
          markdownTexts: [`${runId} provider preload complete: codex-sdk\nContext: 42%`],
        })}`,
        JSON.stringify({
          level: 'INFO',
          msg: `[real-feishu-e2e:stream-card-checkpoint] ${JSON.stringify({
            kind: 'final',
            streamKey: `im:${bridgeSessionId}:om_checkpoint`,
            chatId,
            status: 'completed',
            sequence: 3,
            markdownPreviews: [{ preview: `${runId} final preview` }],
          })}`,
        }),
      ].join('\n'));

      const report = collectRealE2eDump({
        codelarkHome,
        channelType: 'feishu-default',
        chatId,
        bridgeSessionId,
        runId,
        logTailBytes: 16_000,
      });

      assert.equal(report.streamCardCheckpoints.length, 2);
      assert.deepEqual(report.streamCardCheckpoints.map((checkpoint) => checkpoint.kind), ['refresh', 'final']);
      assert.equal(report.streamCardCheckpoints[0]?.status, 'streaming');
      assert.equal(report.streamCardCheckpoints[1]?.status, 'completed');
      assert.match(streamCardCheckpointVisibleText(report.streamCardCheckpoints[0] || {}), /Bash/);
      assert.match(streamCardCheckpointVisibleText(report.streamCardCheckpoints[1] || {}), /final preview/);
    } finally {
      fs.rmSync(codelarkHome, { recursive: true, force: true });
    }
  });

  it('requires Cursor final cards to use the shared header and streaming regions', () => {
    const marker = 'CODELARK_CURSOR_UI_MARKER';
    const checkpoint = {
      kind: 'final',
      streamKey: 'im:cursor-session:om_cursor',
      status: 'completed',
      headerTitle: 'Cursor Session',
      headerTags: ['bridge_id:cursor-session', 'tmux'],
      elementIds: ['runtime_meta_tags', 'stream_history', 'final_content', 'streaming_status'],
      markdownTexts: [
        "<text_tag color='orange'>cursor</text_tag> <text_tag color='turquoise'>model:gpt-5.3-codex</text_tag>",
        marker,
      ],
    };

    assert.deepEqual(cursorStreamCardUnifiedUiIssues([checkpoint], marker, 'gpt-5.3-codex'), []);
    assert.deepEqual(
      cursorStreamCardUnifiedUiIssues([{ ...checkpoint, headerTitle: undefined }], marker, 'gpt-5.3-codex'),
      ['Cursor final card did not use the shared session-title header.'],
    );
    assert.deepEqual(
      cursorStreamCardUnifiedUiIssues([{ ...checkpoint, elementIds: ['stream_history'] }], marker, 'gpt-5.3-codex'),
      ['Cursor final card did not use the shared runtime metadata region.'],
    );
  });

  it('reports Kimi runtime identity and wire transcript paths', () => {
    const codelarkHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-real-e2e-dump-'));
    const kimiHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-real-e2e-kimi-'));
    const previousKimiHome = process.env.KIMI_CODE_HOME;
    try {
      process.env.KIMI_CODE_HOME = kimiHome;
      const dataDir = path.join(codelarkHome, 'data');
      const messagesDir = path.join(dataDir, 'messages');
      fs.mkdirSync(messagesDir, { recursive: true });

      const chatId = 'oc_kimi_chat';
      const bridgeSessionId = 'session-kimi-dump';
      const kimiSessionId = 'session_kimi_dump';
      const marker = 'CODELARK_BASIC_DIALOGUE_UNIT_KIMI_WIRE';
      const thinkingText = `scripted Kimi thinking for ${marker}`;
      const cwd = '/tmp/kimi-dump';
      const sessionDir = path.join(kimiHome, 'sessions', computeKimiWorkspaceDirName(cwd), kimiSessionId);
      const wireDir = path.join(sessionDir, 'agents', 'main');
      fs.mkdirSync(wireDir, { recursive: true });
      const wirePath = path.join(wireDir, 'wire.jsonl');
      fs.writeFileSync(wirePath, [
        {
          type: 'context.append_loop_event',
          time: Date.parse('2026-06-26T00:00:00.000Z'),
          event: { type: 'content.part', part: { type: 'think', think: thinkingText } },
        },
        {
          type: 'context.append_loop_event',
          time: Date.parse('2026-06-26T00:00:01.000Z'),
          event: { type: 'content.part', part: { type: 'text', text: `${marker}\nkimi ok` } },
        },
        {
          type: 'context.append_loop_event',
          time: Date.parse('2026-06-26T00:00:02.000Z'),
          event: { type: 'step.end' },
        },
      ].map((row) => JSON.stringify(row)).join('\n') + '\n');
      fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
        createdAt: '2026-06-26T00:00:00.000Z',
        updatedAt: '2026-06-26T00:01:00.000Z',
        title: 'Kimi dump',
      }));
      fs.writeFileSync(path.join(kimiHome, 'session_index.jsonl'), `${JSON.stringify({
        sessionId: kimiSessionId,
        sessionDir,
        workDir: cwd,
      })}\n`);

      fs.writeFileSync(path.join(dataDir, 'channel-chats.json'), JSON.stringify({
        binding: {
          id: 'binding-kimi',
          channelType: 'feishu-default',
          chatId,
          bridgeSessionId,
          runtimeBridgeSessionIds: {
            kimi: bridgeSessionId,
          },
        },
      }));
      fs.writeFileSync(path.join(dataDir, 'sessions.json'), JSON.stringify({
        [bridgeSessionId]: {
          id: bridgeSessionId,
          name: 'kimi session',
          runtime: {
            activeRuntime: 'kimi',
            kimi: {
              sessionId: kimiSessionId,
              cwd,
              provider: 'tmux',
            },
          },
        },
      }));
      fs.writeFileSync(path.join(messagesDir, `${bridgeSessionId}.json`), JSON.stringify([
        { role: 'assistant', content: 'ok' },
      ]));

      const report = collectRealE2eDump({
        codelarkHome,
        channelType: 'feishu-default',
        chatId,
        bridgeSessionId,
      });

      assert.equal(report.runtime, 'kimi');
      assert.equal(report.runtimeThreadId, kimiSessionId);
      assert.equal(report.kimiSessionId, kimiSessionId);
      assert.equal(report.kimiWireJsonlPath, wirePath);
      assert.equal(report.runtimeSlots.length, 1);
      assert.equal(report.runtimeSlots[0]?.runtime, 'kimi');
      assert.equal(report.runtimeSlots[0]?.bridgeSessionId, bridgeSessionId);
      assert.equal(report.runtimeSlots[0]?.kimiSessionId, kimiSessionId);
      assert.equal(report.runtimeSlots[0]?.kimiCwd, cwd);
      assert.equal(report.runtimeSlots[0]?.kimiWireJsonlPath, wirePath);
      assert.equal(report.checks.find((check) => check.name === 'runtime_identity_bound')?.ok, true);
      assert.equal(report.checks.find((check) => check.name === 'kimi_wire_jsonl_found')?.ok, true);
      assert.deepEqual(scriptedKimiRuntimeSlotIssues({ report, sessionId: kimiSessionId, cwd }), []);
      assert.deepEqual(scriptedKimiWireTranscriptIssues({ report, marker, thinkingText }), []);
      assert.deepEqual(scriptedKimiHistoryTranscriptIssues({ report, marker, thinkingText }), []);
    } finally {
      if (previousKimiHome === undefined) delete process.env.KIMI_CODE_HOME;
      else process.env.KIMI_CODE_HOME = previousKimiHome;
      fs.rmSync(codelarkHome, { recursive: true, force: true });
      fs.rmSync(kimiHome, { recursive: true, force: true });
    }
  });

  it('reports Cursor identity and transcript from the explicitly isolated data roots', () => {
    const codelarkHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-real-e2e-dump-'));
    const cursorConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-real-e2e-cursor-config-'));
    const cursorDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-real-e2e-cursor-data-'));
    const previousConfigDir = process.env.CURSOR_CONFIG_DIR;
    const previousDataDir = process.env.CURSOR_DATA_DIR;
    try {
      process.env.CURSOR_CONFIG_DIR = cursorConfigDir;
      process.env.CURSOR_DATA_DIR = cursorDataDir;
      const dataDir = path.join(codelarkHome, 'data');
      fs.mkdirSync(path.join(dataDir, 'messages'), { recursive: true });
      const chatId = 'oc_cursor_chat';
      const bridgeSessionId = 'session-cursor-dump';
      const cursorSessionId = '22222222-2222-4222-8222-222222222222';
      const cwd = '/tmp/cursor-dump';
      const chatDir = path.join(cursorConfigDir, 'chats', cursorWorkspaceHash(cwd), cursorSessionId);
      fs.mkdirSync(chatDir, { recursive: true });
      fs.writeFileSync(path.join(chatDir, 'store.db'), 'cursor-store');
      fs.writeFileSync(path.join(chatDir, 'meta.json'), JSON.stringify({
        schemaVersion: 1,
        title: 'Cursor dump',
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
        hasConversation: true,
        isSubagent: false,
        cwd,
      }));
      const transcriptPath = getCursorTranscriptCandidates(cursorSessionId, cwd)[0]!;
      fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
      fs.writeFileSync(transcriptPath, [
        { role: 'user', message: { content: [{ type: 'text', text: 'cursor prompt' }] } },
        { role: 'assistant', message: { content: [{ type: 'text', text: 'cursor answer' }] } },
        { type: 'turn_ended', status: 'success' },
      ].map((row) => JSON.stringify(row)).join('\n') + '\n');
      fs.writeFileSync(path.join(dataDir, 'channel-chats.json'), JSON.stringify({
        binding: {
          id: 'binding-cursor',
          channelType: 'feishu-default',
          chatId,
          bridgeSessionId,
          runtimeBridgeSessionIds: { cursor: bridgeSessionId },
        },
      }));
      fs.writeFileSync(path.join(dataDir, 'sessions.json'), JSON.stringify({
        [bridgeSessionId]: {
          id: bridgeSessionId,
          name: 'cursor session',
          runtime: {
            activeRuntime: 'cursor',
            cursor: { sessionId: cursorSessionId, cwd, provider: 'tmux' },
          },
        },
      }));

      delete process.env.CURSOR_CONFIG_DIR;
      delete process.env.CURSOR_DATA_DIR;
      const report = collectRealE2eDump({
        codelarkHome,
        cursorConfigDir,
        cursorDataDir,
        channelType: 'feishu-default',
        chatId,
        bridgeSessionId,
      });

      assert.equal(report.runtime, 'cursor');
      assert.equal(report.cursorSessionId, cursorSessionId);
      assert.equal(report.cursorTranscriptPath, transcriptPath);
      assert.equal(report.runtimeSlots[0]?.cursorTranscriptPath, transcriptPath);
      assert.equal(report.checks.find((check) => check.name === 'cursor_transcript_found')?.ok, true);
      assert.equal(process.env.CURSOR_CONFIG_DIR, undefined);
      assert.equal(process.env.CURSOR_DATA_DIR, undefined);
    } finally {
      if (previousConfigDir === undefined) delete process.env.CURSOR_CONFIG_DIR;
      else process.env.CURSOR_CONFIG_DIR = previousConfigDir;
      if (previousDataDir === undefined) delete process.env.CURSOR_DATA_DIR;
      else process.env.CURSOR_DATA_DIR = previousDataDir;
      fs.rmSync(codelarkHome, { recursive: true, force: true });
      fs.rmSync(cursorConfigDir, { recursive: true, force: true });
      fs.rmSync(cursorDataDir, { recursive: true, force: true });
    }
  });

  it('reports missing scripted Kimi runtime slot evidence', () => {
    assert.deepEqual(
      scriptedKimiRuntimeSlotIssues({
        report: {
          binding: {
            id: 'binding-missing-kimi-slot',
            channelType: 'feishu-default',
            chatId: 'oc_missing_slot',
            bridgeSessionId: 'session-current',
            createdAt: '2026-06-26T00:00:00.000Z',
            updatedAt: '2026-06-26T00:00:00.000Z',
          },
          runtimeSlots: [],
        },
        sessionId: 'session_scripted_kimi_unit',
        cwd: '/tmp/kimi-slot',
      }),
      ['ChannelChat did not retain a kimi runtimeBridgeSessionIds slot.'],
    );

    assert.deepEqual(
      scriptedKimiRuntimeSlotIssues({
        report: {
          binding: {
            id: 'binding-wrong-kimi-slot',
            channelType: 'feishu-default',
            chatId: 'oc_wrong_slot',
            bridgeSessionId: 'session-current',
            runtimeBridgeSessionIds: { kimi: 'session-kimi-slot' },
            createdAt: '2026-06-26T00:00:00.000Z',
            updatedAt: '2026-06-26T00:00:00.000Z',
          },
          runtimeSlots: [{
            runtime: 'kimi',
            bridgeSessionId: 'session-kimi-slot',
            session: {
              id: 'session-kimi-slot',
              runtime: { activeRuntime: 'codex' },
            },
            kimiSessionId: 'session_other',
            kimiCwd: '/tmp/other',
          }],
        },
        sessionId: 'session_scripted_kimi_unit',
        cwd: '/tmp/kimi-slot',
      }),
      [
        'Kimi runtime slot session-kimi-slot does not point to an active Kimi BridgeSession.',
        'Kimi runtime slot expected session id session_scripted_kimi_unit; observed session_other.',
        'Kimi runtime slot expected cwd /tmp/kimi-slot; observed /tmp/other.',
        'Kimi runtime slot session-kimi-slot did not resolve a Kimi wire.jsonl transcript.',
      ],
    );
  });

  it('reports missing scripted Kimi wire transcript evidence', () => {
    const report = {
      binding: {
        id: 'binding-kimi-wire',
        channelType: 'feishu-default',
        chatId: 'oc_kimi_wire',
        bridgeSessionId: 'session-current',
        runtimeBridgeSessionIds: { kimi: 'session-kimi-wire' },
        createdAt: '2026-06-26T00:00:00.000Z',
        updatedAt: '2026-06-26T00:00:00.000Z',
      },
      runtimeSlots: [{
        runtime: 'kimi' as const,
        bridgeSessionId: 'session-kimi-wire',
      }],
    };
    assert.deepEqual(
      scriptedKimiWireTranscriptIssues({
        report,
        marker: 'CODELARK_BASIC_DIALOGUE_UNIT_KIMI_WIRE',
        thinkingText: 'scripted Kimi thinking for CODELARK_BASIC_DIALOGUE_UNIT_KIMI_WIRE',
      }),
      ['Kimi runtime slot session-kimi-wire did not resolve a Kimi wire.jsonl transcript.'],
    );
    assert.deepEqual(
      scriptedKimiHistoryTranscriptIssues({
        report,
        marker: 'CODELARK_BASIC_DIALOGUE_UNIT_KIMI_WIRE',
        thinkingText: 'scripted Kimi thinking for CODELARK_BASIC_DIALOGUE_UNIT_KIMI_WIRE',
      }),
      ['Kimi runtime slot session-kimi-wire did not resolve a Kimi wire.jsonl transcript.'],
    );
  });

  it('reports Kimi history transcript leaks of thinking content', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-real-e2e-kimi-history-leak-'));
    try {
      const wirePath = path.join(tempDir, 'wire.jsonl');
      const marker = 'CODELARK_BASIC_DIALOGUE_UNIT_KIMI_HISTORY';
      const thinkingText = `scripted Kimi thinking for ${marker}`;
      fs.writeFileSync(wirePath, [
        {
          type: 'context.append_loop_event',
          time: Date.parse('2026-06-26T00:00:00.000Z'),
          event: { type: 'content.part', part: { type: 'text', text: `${marker}\n当前思考：${thinkingText}` } },
        },
      ].map((row) => JSON.stringify(row)).join('\n') + '\n');
      const report = {
        binding: {
          id: 'binding-kimi-history',
          channelType: 'feishu-default',
          chatId: 'oc_kimi_history',
          bridgeSessionId: 'session-current',
          runtimeBridgeSessionIds: { kimi: 'session-kimi-history' },
          createdAt: '2026-06-26T00:00:00.000Z',
          updatedAt: '2026-06-26T00:00:00.000Z',
        },
        runtimeSlots: [{
          runtime: 'kimi' as const,
          bridgeSessionId: 'session-kimi-history',
          kimiWireJsonlPath: wirePath,
        }],
      };

      assert.deepEqual(
        scriptedKimiHistoryTranscriptIssues({ report, marker, thinkingText }),
        [
          'Kimi history transcript leaked thinking text "当前思考".',
          `Kimi history transcript leaked thinking text ${JSON.stringify(thinkingText)}.`,
        ],
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('validates basic-dialogue stream-card checkpoint content by phase', () => {
    const phases = [{
      providerKey: 'codex-sdk',
      marker: 'CODELARK_BASIC_DIALOGUE_UNIT_CODEX_SDK',
    }];
    const checkpoints = [
      {
        kind: 'refresh',
        streamKey: 'im:session:om_unit',
        status: 'streaming',
        names: ['Bash'],
        markdownTexts: [
          [
            'provider preload complete: codex-sdk',
            'codex-sdk partial text',
            'Goal Active: codex-sdk provider isolation',
            'running representative tool: codex-sdk',
            'Context: 42%',
          ].join('\n'),
        ],
      },
      {
        kind: 'final',
        streamKey: 'im:session:om_unit',
        status: 'completed',
        markdownTexts: ['CODELARK_BASIC_DIALOGUE_UNIT_CODEX_SDK'],
      },
    ];

    assert.deepEqual(basicDialogueStreamCardCheckpointIssues(checkpoints, phases), []);
    assert.deepEqual(
      basicDialogueStreamCardCheckpointIssues(checkpoints.slice(0, 1), phases),
      [
        'codex-sdk: missing stream-card checkpoint text "CODELARK_BASIC_DIALOGUE_UNIT_CODEX_SDK".',
        'codex-sdk: no completed final card checkpoint contained CODELARK_BASIC_DIALOGUE_UNIT_CODEX_SDK.',
      ],
    );
    assert.deepEqual(
      basicDialogueStreamCardCheckpointIssues([], phases),
      ['No structured stream-card checkpoints were emitted by the isolated bridge.'],
    );

    const kimiMarker = 'CODELARK_BASIC_DIALOGUE_UNIT_KIMI_TMUX';
    const kimiPhases = [{
      providerKey: 'kimi-tmux',
      marker: kimiMarker,
      requiredTexts: [
        '当前思考',
        `scripted Kimi thinking for ${kimiMarker}`,
      ],
    }];
    const kimiCheckpoints = [
      {
        kind: 'refresh',
        streamKey: 'mirror:session:kimi',
        status: 'streaming',
        names: ['Bash'],
        markdownTexts: [
          [
            '当前步骤：思考',
            `当前思考：scripted Kimi thinking for ${kimiMarker}`,
            'provider preload complete: kimi-tmux',
            'kimi-tmux partial text',
            'Goal Active: kimi-tmux provider isolation',
            'running representative tool: kimi-tmux',
            'Context: 42%',
          ].join('\n'),
        ],
      },
      {
        kind: 'final',
        streamKey: 'mirror:session:kimi',
        status: 'completed',
        markdownTexts: [kimiMarker],
        toolGroups: [
          { elementId: 'stream_tool_1', title: '工具调用 · 4', innerPanelCount: 4 },
        ],
        toolPanels: [
          { elementId: 'st_1_t_1', title: '📖 读取 `src/a.ts`', detailChars: 10, detailLines: 1, nestedPanelCount: 0, fences: [], forbiddenEnvelopeTexts: [] },
          { elementId: 'st_1_t_2', title: '🔎 搜索 `toolPanels:` · 路径 `src/__tests__` · 2 行', detailChars: 80, detailLines: 3, nestedPanelCount: 0, fences: [{ language: 'bash', chars: 63, lines: 1, closed: true }], forbiddenEnvelopeTexts: [] },
          { elementId: 'st_1_t_3', title: '🛠️ 修改 2 个文件 · `src/features/tool-card-preview/this-is-a-deliberately-long-typescript-fixture-for-title-budget.ts` 等 2 个文件', detailChars: 4000, detailLines: 166, nestedPanelCount: 0, fences: [{ language: 'typescript', chars: 2500, lines: 102, closed: true }, { language: 'python', chars: 1200, lines: 58, closed: true }], forbiddenEnvelopeTexts: [] },
          { elementId: 'st_1_t_4', title: '💻 运行 `npm test` · 200ms · 后台终端 `90`', detailChars: 20, detailLines: 3, nestedPanelCount: 0, fences: [{ language: 'bash', chars: 8, lines: 1, closed: true }], forbiddenEnvelopeTexts: [] },
        ],
      },
    ];
    assert.deepEqual(basicDialogueStreamCardCheckpointIssues(kimiCheckpoints, kimiPhases), []);
    assert.deepEqual(kimiThinkingStatusOnlyIssues(kimiCheckpoints, {
      providerKey: 'kimi-tmux',
      marker: kimiMarker,
      thinkingText: `scripted Kimi thinking for ${kimiMarker}`,
    }), []);
    assert.deepEqual(scriptedKimiToolCardIssues(kimiCheckpoints, {
      providerKey: 'kimi-tmux',
      marker: kimiMarker,
    }), []);
    assert.deepEqual(scriptedKimiToolCardIssues([
      kimiCheckpoints[0]!,
      { ...kimiCheckpoints[1]!, toolGroups: [] },
    ], {
      providerKey: 'kimi-tmux',
      marker: kimiMarker,
    }), ['kimi-tmux: expected one 工具调用 · 4 group containing four inner tool panels.']);
    assert.deepEqual(scriptedKimiToolCardIssues([
      kimiCheckpoints[0]!,
      {
        ...kimiCheckpoints[1]!,
        toolPanels: kimiCheckpoints[1]!.toolPanels!.map((panel, index) => index === 2
          ? { ...panel, title: '🛠️ 修改 2 个文件 · `src/features/tool-card-preview/this-is-a-deliberately-long-typescript-fixture-for-title-budget.ts…' }
          : panel),
      },
    ], {
      providerKey: 'kimi-tmux',
      marker: kimiMarker,
    }), ['kimi-tmux: patch title did not keep one complete filename before the multi-file fallback.']);
    assert.deepEqual(scriptedKimiToolCardIssues([
      kimiCheckpoints[0]!,
      {
        ...kimiCheckpoints[1]!,
        toolPanels: kimiCheckpoints[1]!.toolPanels!.map((panel, index) => index === 2
          ? { ...panel, nestedPanelCount: 1, fences: [{ language: 'typescript', chars: 9000, lines: 161, closed: false }, { language: 'python', chars: 1200, lines: 58, closed: true }], forbiddenEnvelopeTexts: ['Success'] }
          : panel),
      },
    ], {
      providerKey: 'kimi-tmux',
      marker: kimiMarker,
    }), [
      'kimi-tmux: st_1_t_3 contains 1 nested collapsible panels.',
      'kimi-tmux: st_1_t_3 leaked Success.',
      'kimi-tmux: st_1_t_3 contains an unclosed typescript fence.',
      'kimi-tmux: st_1_t_3 fence exceeded 8000 characters.',
      'kimi-tmux: st_1_t_3 fence exceeded 160 lines.',
      'kimi-tmux: multi-file patch fences exceeded the shared 8000-character budget.',
      'kimi-tmux: scripted multi-file patch should exercise the shared 160-line cap, got 219 lines.',
    ]);
    assert.deepEqual(kimiThinkingStatusOnlyIssues([
      ...kimiCheckpoints.slice(0, 1),
      {
        kind: 'final',
        streamKey: 'mirror:session:kimi',
        status: 'completed',
        markdownTexts: [kimiMarker, `当前思考：scripted Kimi thinking for ${kimiMarker}`],
      },
    ], {
      providerKey: 'kimi-tmux',
      marker: kimiMarker,
      thinkingText: `scripted Kimi thinking for ${kimiMarker}`,
    }), ['kimi-tmux: completed final card leaked Kimi thinking text into the final answer.']);
    assert.deepEqual(kimiThinkingStatusOnlyIssues([
      {
        kind: 'final',
        streamKey: 'mirror:session:kimi',
        status: 'completed',
        markdownTexts: [kimiMarker],
      },
    ], {
      providerKey: 'kimi-tmux',
      marker: kimiMarker,
      thinkingText: `scripted Kimi thinking for ${kimiMarker}`,
    }), ['kimi-tmux: no non-final stream-card checkpoint showed Kimi thinking in the status area.']);
    assert.deepEqual(
      basicDialogueStreamCardCheckpointIssues(
        kimiCheckpoints.map((checkpoint) => ({
          ...checkpoint,
          markdownTexts: (checkpoint.markdownTexts || []).map((text) => text.replace('当前思考：', '')),
        })),
        kimiPhases,
      ),
      ['kimi-tmux: missing stream-card checkpoint text "当前思考".'],
    );
  });

  it('validates one fresh scripted Kimi launch and Ctrl-S steer evidence', () => {
    const kimiHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-real-e2e-scripted-kimi-'));
    try {
      const sessionId = 'session_scripted_kimi_unit';
      const cwd = '/tmp/scripted-kimi-unit';
      fs.writeFileSync(path.join(kimiHome, 'scripted-kimi-launches.jsonl'), [
        JSON.stringify({ argv: ['-y'], resumed: false, cwd }),
        '',
      ].join('\n'));
      fs.writeFileSync(path.join(kimiHome, 'scripted-kimi-keys.log'), [
        Buffer.from('prompt').toString('hex') + '13',
        '',
      ].join('\n'));

      assert.deepEqual(scriptedKimiLifecycleAndSteerIssues({ kimiHome, sessionId, cwd }), []);
      assert.deepEqual(
        scriptedKimiLifecycleAndSteerIssues({ kimiHome, sessionId: 'session_wrong', cwd }),
        [],
      );
    } finally {
      fs.rmSync(kimiHome, { recursive: true, force: true });
    }
  });

  it('reports resumed scripted Kimi startup and missing steer evidence', () => {
    const kimiHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-real-e2e-scripted-kimi-missing-'));
    try {
      fs.writeFileSync(path.join(kimiHome, 'scripted-kimi-launches.jsonl'), `${JSON.stringify({
        argv: ['-r', 'session_missing', '-y'],
        resumed: true,
        cwd: '/tmp/other',
      })}\n`);
      fs.writeFileSync(path.join(kimiHome, 'scripted-kimi-keys.log'), '03\n');

      assert.deepEqual(scriptedKimiLifecycleAndSteerIssues({
        kimiHome,
        sessionId: 'session_missing',
        cwd: '/tmp/expected',
      }), [
        'Scripted Kimi expected one initial fresh "kimi -y" launch; observed 0.',
        'Scripted Kimi unexpectedly resumed 1 session(s) during fresh startup.',
        'Scripted Kimi launch cwd never matched /tmp/expected.',
        'Scripted Kimi must not terminate its initial TUI to discover a session id; observed 1 Ctrl-C byte(s).',
        'Scripted Kimi did not observe Ctrl-S steer after prompt delivery.',
      ]);
    } finally {
      fs.rmSync(kimiHome, { recursive: true, force: true });
    }
  });
});
