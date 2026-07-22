import '../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  basicDialogueStreamCardCheckpointIssues,
  collectRealE2eDump,
  kimiThinkingStatusOnlyIssues,
  scriptedKimiHistoryTranscriptIssues,
  scriptedKimiResumeAndSteerIssues,
  scriptedKimiRuntimeSlotIssues,
  scriptedKimiWireTranscriptIssues,
  streamCardCheckpointVisibleText,
} from '../../../bridge/diagnostics/real-e2e-dump.js';
import { computeKimiWorkspaceDirName } from '../../../runtime/kimi/session-index.js';

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
        `[INFO] Streaming card create payload: { streamKey: 'im:${bridgeSessionId}:om_target', chatId: '${chatId}' }`,
        `[INFO] Request success: scope=${chatId}, target=im.message.reply:post, message_id=om_target_reply`,
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
        `[real-feishu-e2e:stream-card-checkpoint] ${JSON.stringify({
          kind: 'final',
          streamKey: `im:${bridgeSessionId}:om_checkpoint`,
          chatId,
          status: 'completed',
          sequence: 3,
          markdownPreviews: [{ preview: `${runId} final preview` }],
        })}`,
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
      },
    ];
    assert.deepEqual(basicDialogueStreamCardCheckpointIssues(kimiCheckpoints, kimiPhases), []);
    assert.deepEqual(kimiThinkingStatusOnlyIssues(kimiCheckpoints, {
      providerKey: 'kimi-tmux',
      marker: kimiMarker,
      thinkingText: `scripted Kimi thinking for ${kimiMarker}`,
    }), []);
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

  it('validates scripted Kimi resume-hint and Ctrl-S steer evidence', () => {
    const kimiHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-real-e2e-scripted-kimi-'));
    try {
      const sessionId = 'session_scripted_kimi_unit';
      const cwd = '/tmp/scripted-kimi-unit';
      fs.writeFileSync(path.join(kimiHome, 'scripted-kimi-launches.jsonl'), [
        JSON.stringify({ argv: [], resumed: false, cwd }),
        JSON.stringify({ argv: ['-r', sessionId], resumed: true, cwd }),
        '',
      ].join('\n'));
      fs.writeFileSync(path.join(kimiHome, 'scripted-kimi-keys.log'), [
        '03',
        '03',
        Buffer.from('prompt').toString('hex') + '13',
        '',
      ].join('\n'));

      assert.deepEqual(scriptedKimiResumeAndSteerIssues({ kimiHome, sessionId, cwd }), []);
      assert.deepEqual(
        scriptedKimiResumeAndSteerIssues({ kimiHome, sessionId: 'session_wrong', cwd }),
        ['Scripted Kimi did not resume with "kimi -r session_wrong".'],
      );
    } finally {
      fs.rmSync(kimiHome, { recursive: true, force: true });
    }
  });

  it('reports missing scripted Kimi resume-hint and steer evidence', () => {
    const kimiHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-real-e2e-scripted-kimi-missing-'));
    try {
      fs.writeFileSync(path.join(kimiHome, 'scripted-kimi-launches.jsonl'), `${JSON.stringify({
        argv: [],
        resumed: false,
        cwd: '/tmp/other',
      })}\n`);
      fs.writeFileSync(path.join(kimiHome, 'scripted-kimi-keys.log'), '03\n');

      assert.deepEqual(scriptedKimiResumeAndSteerIssues({
        kimiHome,
        sessionId: 'session_missing',
        cwd: '/tmp/expected',
      }), [
        'Scripted Kimi did not resume with "kimi -r session_missing".',
        'Scripted Kimi launch cwd never matched /tmp/expected.',
        'Scripted Kimi expected at least two Ctrl-C bytes before resume hint; observed 1.',
        'Scripted Kimi did not observe Ctrl-S steer after prompt delivery.',
      ]);
    } finally {
      fs.rmSync(kimiHome, { recursive: true, force: true });
    }
  });
});
