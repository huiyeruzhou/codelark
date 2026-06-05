import '../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  basicDialogueStreamCardCheckpointIssues,
  collectRealE2eDump,
  streamCardCheckpointVisibleText,
} from '../../../bridge/diagnostics/real-e2e-dump.js';

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
  });
});
