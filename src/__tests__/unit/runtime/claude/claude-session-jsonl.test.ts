import '../../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  archiveClaudeSessionJsonl,
  findLatestClaudeSessionJsonl,
  createClaudeMirrorJsonlSource,
  getClaudeProjectDir,
  getClaudeSessionJsonlById,
  listClaudeSessionJsonlSummaries,
  parseClaudeSessionMirrorRecordText,
  readClaudeSessionMirrorRecordDeltaByFilePath,
  readClaudeSessionMirrorRecordStreamByFilePath,
} from '../../../../runtime/claude/session-jsonl.js';
import { buildMirrorDeliveryPlan } from '../../../../bridge/mirror/delivery-plan.js';
import { consumeMirrorRecords } from '../../../../bridge/mirror/turns.js';
import { createMirrorRuntime } from '../../../../bridge/mirror/runtime.js';
import type { BridgeMirrorRecord } from '../../../../runtime/contracts.js';
import {
  consumeBufferedMirrorTurns,
  flushTimedOutMirrorTurn,
  hasPendingMirrorWork,
} from '../../../../bridge/mirror/turns.js';

describe('claude-session-jsonl', () => {
  it('parses Claude Code user and assistant jsonl lines into mirror records', () => {
    const content = [
      JSON.stringify({
        type: 'user',
        uuid: 'user-1',
        sessionId: 'claude-session-1',
        cwd: '/tmp/claude-work',
        timestamp: '2026-06-02T00:00:00.000Z',
        message: { role: 'user', content: 'hello claude' },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-1',
        parentUuid: 'user-1',
        sessionId: 'claude-session-1',
        cwd: '/tmp/claude-work',
        timestamp: '2026-06-02T00:00:01.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'hello from jsonl' }],
        },
      }),
      JSON.stringify({
        type: 'system',
        subtype: 'turn_duration',
        sessionId: 'claude-session-1',
      }),
    ].join('\n');

    const records = parseClaudeSessionMirrorRecordText(content);
    assert.deepEqual(records.map((record) => `${record.type}:${record.role || '-'}`), [
      'task_started:-',
      'message:user',
      'message:assistant',
      'task_complete:-',
    ]);

    const subscription = {
      sessionId: 'bridge-session-1',
      threadId: 'claude-session-1',
      pendingTurn: null,
    };
    const turns = consumeMirrorRecords(subscription, records);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].userText, 'hello claude');
    assert.equal(turns[0].text, 'hello from jsonl');
    assert.equal(turns[0].status, 'completed');

    const deliverySubscription = {
      sessionId: 'bridge-session-1',
      threadId: 'claude-session-1',
      pendingTurn: null,
      bufferedRecords: [],
    };
    const deliveryPlan = buildMirrorDeliveryPlan(deliverySubscription, records, {
      blocked: false,
      filterSuppressedRecords: (_sessionId, incoming) => incoming,
      flushTimedOutTurn: () => null,
      consumeBufferedTurns: (currentSubscription) => consumeMirrorRecords(currentSubscription, currentSubscription.bufferedRecords.splice(0)),
    });
    assert.equal(deliveryPlan.syncReason, 'mirror reconcile delivered turns');
    assert.equal(deliveryPlan.finalizedTurns.length, 1);
    assert.equal(deliveryPlan.finalizedTurns[0].text, 'hello from jsonl');
  });

  it('keeps separate mirror stream keys for multiple turns in one Claude Code session', () => {
    const content = [
      JSON.stringify({
        type: 'user',
        uuid: 'user-1',
        sessionId: 'claude-session-1',
        cwd: '/tmp/claude-work',
        timestamp: '2026-06-02T00:00:00.000Z',
        message: { role: 'user', content: 'first prompt' },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-1',
        parentUuid: 'user-1',
        sessionId: 'claude-session-1',
        cwd: '/tmp/claude-work',
        timestamp: '2026-06-02T00:00:01.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'first reply' }] },
      }),
      JSON.stringify({
        type: 'user',
        uuid: 'user-2',
        sessionId: 'claude-session-1',
        cwd: '/tmp/claude-work',
        timestamp: '2026-06-02T00:00:02.000Z',
        message: { role: 'user', content: 'second prompt' },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-2',
        parentUuid: 'user-2',
        sessionId: 'claude-session-1',
        cwd: '/tmp/claude-work',
        timestamp: '2026-06-02T00:00:03.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'second reply' }] },
      }),
    ].join('\n');

    const records = parseClaudeSessionMirrorRecordText(content);
    assert.deepEqual(
      records.filter((record) => record.type === 'task_started').map((record) => record.turnId),
      ['user-1', 'user-2'],
    );

    const subscription = {
      sessionId: 'bridge-session-1',
      threadId: 'claude-session-1',
      pendingTurn: null,
    };
    const turns = consumeMirrorRecords(subscription, records);
    assert.equal(turns.length, 2);
    assert.deepEqual(turns.map((turn) => turn.userText), ['first prompt', 'second prompt']);
    assert.deepEqual(turns.map((turn) => turn.text), ['first reply', 'second reply']);
    assert.notEqual(turns[0].streamKey, turns[1].streamKey);
  });

  it('parses Claude Code tool blocks as tool progress instead of user mirror text', () => {
    const content = [
      JSON.stringify({
        type: 'user',
        uuid: 'user-1',
        sessionId: 'claude-session-tools',
        cwd: '/tmp/claude-work',
        timestamp: '2026-06-02T00:00:00.000Z',
        message: { role: 'user', content: 'inspect workspace' },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-tool',
        parentUuid: 'user-1',
        sessionId: 'claude-session-tools',
        cwd: '/tmp/claude-work',
        timestamp: '2026-06-02T00:00:01.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'pwd' } }],
        },
      }),
      JSON.stringify({
        type: 'user',
        uuid: 'tool-result-1',
        parentUuid: 'assistant-tool',
        sessionId: 'claude-session-tools',
        cwd: '/tmp/claude-work',
        timestamp: '2026-06-02T00:00:02.000Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '/tmp/claude-work' }],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-final',
        parentUuid: 'tool-result-1',
        sessionId: 'claude-session-tools',
        cwd: '/tmp/claude-work',
        timestamp: '2026-06-02T00:00:03.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'workspace inspected' }],
        },
      }),
    ].join('\n');

    const records = parseClaudeSessionMirrorRecordText(content);
    assert.deepEqual(records.map((record) => `${record.type}:${record.role || record.toolName || '-'}`), [
      'task_started:-',
      'message:user',
      'tool_started:Bash',
      'tool_finished:-',
      'message:assistant',
      'task_complete:-',
    ]);
    assert.equal(new Set(records.map((record) => record.turnId)).size, 1);
    assert.equal(records[0].turnId, 'user-1');

    const subscription = {
      sessionId: 'bridge-session-1',
      threadId: 'claude-session-tools',
      pendingTurn: null,
    };
    const turns = consumeMirrorRecords(subscription, records);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].userText, 'inspect workspace');
    assert.equal(turns[0].text, 'workspace inspected');
  });

  it('keeps Claude attachment, split tool use, tool result, and interrupt records in one root turn', () => {
    const content = [
      JSON.stringify({ type: 'mode', mode: 'normal', sessionId: 'claude-session-root' }),
      JSON.stringify({
        type: 'user',
        uuid: 'user-root',
        promptId: 'prompt-root',
        sessionId: 'claude-session-root',
        cwd: '/tmp/claude-work',
        timestamp: '2026-06-04T18:19:53.702Z',
        message: { role: 'user', content: 'upgrade current command' },
      }),
      JSON.stringify({
        type: 'attachment',
        uuid: 'attachment-1',
        parentUuid: 'user-root',
        sessionId: 'claude-session-root',
        cwd: '/tmp/claude-work',
        timestamp: '2026-06-04T18:19:53.702Z',
        attachment: { type: 'skill_listing', content: 'skills' },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-text',
        parentUuid: 'attachment-1',
        sessionId: 'claude-session-root',
        cwd: '/tmp/claude-work',
        timestamp: '2026-06-04T18:19:59.463Z',
        message: {
          role: 'assistant',
          stop_reason: 'tool_use',
          content: [{ type: 'text', text: 'I will inspect the implementation.' }],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-tool',
        parentUuid: 'assistant-text',
        sessionId: 'claude-session-root',
        cwd: '/tmp/claude-work',
        timestamp: '2026-06-04T18:19:59.903Z',
        message: {
          role: 'assistant',
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'EnterWorktree', input: { name: 'upgrade-current-cmd' } }],
        },
      }),
      JSON.stringify({
        type: 'user',
        uuid: 'tool-result-1',
        parentUuid: 'assistant-tool',
        promptId: 'prompt-root',
        sessionId: 'claude-session-root',
        cwd: '/tmp/claude-worktree',
        timestamp: '2026-06-04T18:20:00.004Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Created worktree.' }],
        },
      }),
      JSON.stringify({
        type: 'user',
        uuid: 'interrupt-1',
        parentUuid: 'tool-result-1',
        promptId: 'prompt-root',
        interruptedMessageId: 'msg_1',
        sessionId: 'claude-session-root',
        cwd: '/tmp/claude-worktree',
        timestamp: '2026-06-04T18:20:00.363Z',
        message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
      }),
    ].join('\n');

    const records = parseClaudeSessionMirrorRecordText(content);
    assert.deepEqual(records.map((record) => `${record.type}:${record.role || record.toolName || '-'}`), [
      'task_started:-',
      'message:user',
      'message:assistant',
      'tool_started:EnterWorktree',
      'tool_finished:-',
      'task_aborted:-',
    ]);
    assert.deepEqual(Array.from(new Set(records.map((record) => record.turnId))), ['prompt-root']);

    const subscription = {
      sessionId: 'bridge-session-1',
      threadId: 'claude-session-root',
      pendingTurn: null,
    };
    const turns = consumeMirrorRecords(subscription, records);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].status, 'interrupted');
    assert.equal(turns[0].userText, 'upgrade current command');
    assert.equal(turns[0].text, 'I will inspect the implementation.');
  });

  it('parses split Claude JSONL deltas with the same turn identity as a full read', () => {
    const lines = [
      JSON.stringify({
        type: 'user',
        uuid: 'user-root',
        promptId: 'prompt-root',
        sessionId: 'claude-session-root',
        cwd: '/tmp/claude-work',
        timestamp: '2026-06-04T18:19:53.702Z',
        message: { role: 'user', content: 'upgrade current command' },
      }),
      JSON.stringify({
        type: 'attachment',
        uuid: 'attachment-1',
        parentUuid: 'user-root',
        sessionId: 'claude-session-root',
        cwd: '/tmp/claude-work',
        timestamp: '2026-06-04T18:19:53.702Z',
        attachment: { type: 'skill_listing', content: 'skills' },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-text',
        parentUuid: 'attachment-1',
        sessionId: 'claude-session-root',
        cwd: '/tmp/claude-work',
        timestamp: '2026-06-04T18:19:59.463Z',
        message: {
          role: 'assistant',
          stop_reason: 'tool_use',
          content: [{ type: 'text', text: 'I will inspect the implementation.' }],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-tool',
        parentUuid: 'assistant-text',
        sessionId: 'claude-session-root',
        cwd: '/tmp/claude-work',
        timestamp: '2026-06-04T18:19:59.903Z',
        message: {
          role: 'assistant',
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'EnterWorktree', input: { name: 'upgrade-current-cmd' } }],
        },
      }),
      JSON.stringify({
        type: 'user',
        uuid: 'tool-result-1',
        parentUuid: 'assistant-tool',
        promptId: 'prompt-root',
        sessionId: 'claude-session-root',
        cwd: '/tmp/claude-worktree',
        timestamp: '2026-06-04T18:20:00.004Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Created worktree.' }],
        },
      }),
    ];
    const content = `${lines.join('\n')}\n`;
    const fullRecords = parseClaudeSessionMirrorRecordText(content);
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-claude-delta-'));
    const filePath = path.join(tempDir, 'session.jsonl');
    fs.writeFileSync(filePath, content);

    try {
      let offset = 0;
      let trailingText = '';
      let turnId: string | null = null;
      let state: string[] = [];
      const deltaRecords: BridgeMirrorRecord[] = [];
      for (const chunk of [lines.slice(0, 2), lines.slice(2, 4), lines.slice(4)]) {
        const chunkText = `${chunk.join('\n')}\n`;
        const nextOffset = offset + Buffer.byteLength(chunkText);
        const delta = readClaudeSessionMirrorRecordDeltaByFilePath(
          filePath,
          offset,
          nextOffset,
          trailingText,
          turnId,
          state,
        );
        deltaRecords.push(...delta.records);
        offset = delta.nextOffset;
        trailingText = delta.trailingText;
        turnId = delta.nextTurnId;
        state = delta.nextSpecialCallIds;
      }

      assert.deepEqual(
        deltaRecords.map((record) => [record.type, record.role || record.toolName || '', record.turnId, record.content]),
        fullRecords.map((record) => [record.type, record.role || record.toolName || '', record.turnId, record.content]),
      );
      assert.deepEqual(Array.from(new Set(deltaRecords.map((record) => record.turnId))), ['prompt-root']);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('locates the latest Claude Code jsonl file for a cwd', () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-claude-jsonl-home-'));
    const cwd = path.join(homeDir, 'workspace');
    const projectDir = getClaudeProjectDir(cwd, homeDir);
    fs.mkdirSync(projectDir, { recursive: true });
    const firstPath = path.join(projectDir, 'first.jsonl');
    const secondPath = path.join(projectDir, 'second.jsonl');
    fs.writeFileSync(firstPath, `${JSON.stringify({ type: 'user', sessionId: 'first', cwd })}\n`);
    fs.writeFileSync(secondPath, `${JSON.stringify({ type: 'user', sessionId: 'second', cwd })}\n`);
    const oldTime = new Date('2026-06-02T00:00:00.000Z');
    const newTime = new Date('2026-06-02T00:01:00.000Z');
    fs.utimesSync(firstPath, oldTime, oldTime);
    fs.utimesSync(secondPath, newTime, newTime);

    try {
      const latest = findLatestClaudeSessionJsonl(cwd, homeDir);
      assert.equal(latest?.sessionId, 'second');
      assert.equal(latest?.filePath, secondPath);
      assert.deepEqual(
        readClaudeSessionMirrorRecordStreamByFilePath(secondPath).map((record) => record.type),
        ['task_started'],
      );

      const source = createClaudeMirrorJsonlSource(homeDir);
      assert.deepEqual(source.findByThreadId('second', cwd), {
        threadId: 'second',
        filePath: secondPath,
        cwd,
        updatedAt: '2026-06-02T00:01:00.000Z',
      });
      assert.equal(listClaudeSessionJsonlSummaries(homeDir).length, 2);
      assert.equal(archiveClaudeSessionJsonl(latest!), true);
      assert.deepEqual(listClaudeSessionJsonlSummaries(homeDir).map((session) => session.sessionId), ['first']);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('locates Claude Code jsonl when cwd contains underscores', () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-claude-jsonl-home-'));
    const cwd = '/tmp/feishu-env-oc_abc123';
    try {
      const projectDir = getClaudeProjectDir(cwd, homeDir);
      assert.match(projectDir, /feishu-env-oc-abc123$/);
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(path.join(projectDir, 'claude-underscore-session.jsonl'), `${JSON.stringify({
        type: 'user',
        sessionId: 'claude-underscore-session',
        cwd,
        timestamp: '2026-06-02T09:50:45.499Z',
        message: { role: 'user', content: 'hello' },
      })}\n`, 'utf-8');

      assert.equal(
        getClaudeSessionJsonlById('claude-underscore-session', cwd, homeDir)?.sessionId,
        'claude-underscore-session',
      );
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('matches Claude Code project directories that replace dots in cwd paths', () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-claude-jsonl-home-'));
    const cwd = '/tmp/hongli.fish/feishu-env-oc_abc123';
    try {
      const projectDir = getClaudeProjectDir(cwd, homeDir);
      assert.match(projectDir, /hongli-fish-feishu-env-oc-abc123$/);
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(path.join(projectDir, 'claude-dot-session.jsonl'), `${JSON.stringify({
        type: 'user',
        sessionId: 'claude-dot-session',
        cwd,
        timestamp: '2026-06-02T09:50:45.499Z',
        message: { role: 'user', content: 'hello dot path' },
      })}\n`, 'utf-8');

      assert.equal(
        getClaudeSessionJsonlById('claude-dot-session', cwd, homeDir)?.sessionId,
        'claude-dot-session',
      );
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('locates Claude Code jsonl when cwd is a symlink and Claude writes under the realpath', () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-claude-jsonl-home-'));
    const realRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-claude-jsonl-real-'));
    const linkRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-claude-jsonl-link-'));
    const realCwd = path.join(realRoot, 'workspace');
    const linkCwd = path.join(linkRoot, 'workspace-link');
    try {
      fs.mkdirSync(realCwd, { recursive: true });
      fs.symlinkSync(realCwd, linkCwd, 'dir');
      const projectDir = getClaudeProjectDir(realCwd, homeDir);
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(path.join(projectDir, 'claude-realpath-session.jsonl'), `${JSON.stringify({
        type: 'user',
        sessionId: 'claude-realpath-session',
        cwd: realCwd,
        timestamp: '2026-06-02T09:50:45.499Z',
        message: { role: 'user', content: 'hello from realpath' },
      })}\n`, 'utf-8');

      assert.equal(
        getClaudeSessionJsonlById('claude-realpath-session', linkCwd, homeDir)?.sessionId,
        'claude-realpath-session',
      );
      assert.equal(findLatestClaudeSessionJsonl(linkCwd, homeDir)?.sessionId, 'claude-realpath-session');
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
      fs.rmSync(realRoot, { recursive: true, force: true });
      fs.rmSync(linkRoot, { recursive: true, force: true });
    }
  });

  it('delivers Claude Code jsonl through the shared mirror runtime interface', async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-claude-runtime-home-'));
    const cwd = path.join(homeDir, 'workspace');
    const projectDir = getClaudeProjectDir(cwd, homeDir);
    fs.mkdirSync(projectDir, { recursive: true });
    const claudeSessionId = 'claude-runtime-session';
    const filePath = path.join(projectDir, `${claudeSessionId}.jsonl`);
    fs.writeFileSync(filePath, '', 'utf-8');

    const bindings = [{
      id: 'binding-claude',
      channelType: 'feishu-default',
      chatId: 'chat-1',
      bridgeSessionId: 'bridge-session-1',
    }];
    const session = {
      id: 'bridge-session-1',
      runtime: {
        activeRuntime: 'claude' as const,
        claude: { sessionId: claudeSessionId, cwd },
      },
      mirror_last_event_at: null,
    };
    const state = {
      running: true,
      adapters: new Map([
        ['feishu-default', { channelType: 'feishu-default', provider: 'feishu', isRunning: () => false }],
      ]),
      mirrorSubscriptions: new Map(),
      mirrorWakeTimer: null,
      mirrorSyncInFlight: false,
      activeTasks: new Map(),
    };
    const deliveredTexts: string[] = [];
    const source = createClaudeMirrorJsonlSource(homeDir);
    const runtime = createMirrorRuntime(() => state as never, {
      watchDebounceMs: 0,
      danglingThreadRetryLimit: 3,
      failureSuspendThreshold: 3,
      failureSuspendMs: 60_000,
    }, {
      mirrorSource: source,
      runtimeLabel: 'Claude',
      nowIso: () => '2026-06-02T00:00:00.000Z',
      describeUnknownError: (error) => (error instanceof Error ? error.message : String(error)),
      listChannelChats: () => bindings,
      getSession: (sessionId) => (sessionId === session.id ? session : null),
      clearSessionCodexThreadId: () => {},
      getCodexSessionByThreadIdSafe: () => null,
      hasSessionMirrorSource: (candidate) => Boolean(candidate?.runtime?.claude?.sessionId && candidate.runtime.claude.cwd),
      getSessionMirrorThreadId: (candidate) => candidate.runtime?.claude?.sessionId,
      getSessionMirrorCwd: (candidate) => candidate.runtime?.claude?.cwd,
      getMirrorSourceSummary: (currentSource, threadId, currentCwd) => currentSource.findByThreadId(threadId, currentCwd || undefined),
      syncMirrorSessionStateSafe: () => {},
      filterSuppressedMirrorRecords: (_sessionId, records) => records,
      observeSessionHealthRecords: () => {},
      consumeMirrorRecords: (subscription, records) => consumeMirrorRecords(subscription, records),
      flushTimedOutMirrorTurn: (subscription) => flushTimedOutMirrorTurn(subscription, 10 * 60_000, Date.now()),
      hasPendingMirrorWork: (subscription) => hasPendingMirrorWork(subscription),
      consumeBufferedMirrorTurns: (subscription) => consumeBufferedMirrorTurns(subscription, 10 * 60_000, Date.now()),
      stopMirrorStreaming: () => {},
      deliverMirrorTurns: async (_subscription, turns) => {
        deliveredTexts.push(...turns.map((turn) => turn.text));
        return { deliveredCount: turns.length };
      },
    });

    try {
      await runtime.reconcileMirrorSubscriptions();
      fs.appendFileSync(filePath, [
        JSON.stringify({
          type: 'user',
          uuid: 'user-1',
          sessionId: claudeSessionId,
          cwd,
          timestamp: '2026-06-02T00:00:00.000Z',
          message: { role: 'user', content: 'hello claude' },
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'assistant-1',
          parentUuid: 'user-1',
          sessionId: claudeSessionId,
          cwd,
          timestamp: '2026-06-02T00:00:01.000Z',
          message: { role: 'assistant', content: [{ type: 'text', text: 'delivered to feishu path' }] },
        }),
      ].join('\n') + '\n', 'utf-8');

      await runtime.reconcileMirrorSubscriptions();

      assert.deepEqual(deliveredTexts, ['delivered to feishu path']);
    } finally {
      runtime.clearMirrorSubscriptions();
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
