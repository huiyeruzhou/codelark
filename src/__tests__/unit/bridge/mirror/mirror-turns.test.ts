import '../../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  enqueuePendingMirrorDeliveries,
  hasPendingMirrorWork,
  removePendingMirrorDeliveries,
  selectPendingMirrorDeliveries,
  consumeMirrorRecords,
} from '../../../../bridge/mirror/turns.js';

describe('mirror-turns pending delivery queue', () => {
  it('deduplicates queued turns by signature and removes only delivered turns', () => {
    const completed = {
      streamKey: 'mirror:session-1:turn-1',
      userText: 'prompt',
      text: 'answer',
      signature: 'complete-1',
      timestamp: '2026-04-21T10:00:00.000Z',
      status: 'completed' as const,
    };
    const timedOut = {
      streamKey: 'mirror:session-1:turn-2',
      userText: null,
      text: 'stale answer',
      signature: 'timeout:thread-1:turn-2',
      timestamp: '2026-04-21T10:01:00.000Z',
      status: 'interrupted' as const,
      timedOut: true,
    };
    const subscription = {
      pendingDeliveries: [],
    };

    enqueuePendingMirrorDeliveries(subscription, [completed, timedOut, completed]);
    assert.deepEqual(subscription.pendingDeliveries, [completed, timedOut]);

    removePendingMirrorDeliveries(subscription, [timedOut]);
    assert.deepEqual(subscription.pendingDeliveries, [completed]);
  });

  it('treats queued pending deliveries as pending mirror work', () => {
    const subscription = {
      sessionId: 'session-1',
      threadId: 'thread-1',
      bufferedRecords: [],
      pendingTurn: null,
      pendingDeliveries: [
        {
          streamKey: 'mirror:session-1:turn-1',
          userText: null,
          text: 'answer',
          signature: 'complete-1',
          timestamp: '2026-04-21T10:00:00.000Z',
          status: 'completed' as const,
        },
      ],
    };

    assert.equal(hasPendingMirrorWork(subscription), true);
  });

  it('only selects timeout turns while mirror delivery is blocked', () => {
    const subscription = {
      pendingDeliveries: [
        {
          streamKey: 'mirror:session-1:turn-1',
          userText: 'prompt',
          text: 'answer',
          signature: 'complete-1',
          timestamp: '2026-04-21T10:00:00.000Z',
          status: 'completed' as const,
        },
        {
          streamKey: 'mirror:session-1:turn-2',
          userText: null,
          text: 'stale answer',
          signature: 'timeout:thread-1:turn-2',
          timestamp: '2026-04-21T10:01:00.000Z',
          status: 'interrupted' as const,
          timedOut: true,
        },
      ],
    };

    assert.deepEqual(
      selectPendingMirrorDeliveries(subscription, false).map((turn) => turn.signature),
      ['complete-1', 'timeout:thread-1:turn-2'],
    );
    assert.deepEqual(
      selectPendingMirrorDeliveries(subscription, true).map((turn) => turn.signature),
      ['timeout:thread-1:turn-2'],
    );
  });

  it('updates status note and task items through mirror progress hooks', () => {
    const statusNotes: Array<string | null> = [];
    const taskSnapshots: Array<Array<{ text: string; status: string }>> = [];
    const subscription = {
      sessionId: 'session-1',
      threadId: 'thread-1',
      pendingTurn: null,
    } as any;

    consumeMirrorRecords(subscription, [
      {
        signature: 'start-1',
        type: 'task_started',
        content: '',
        timestamp: '2026-04-21T10:00:00.000Z',
        turnId: 'turn-1',
      },
      {
        signature: 'reason-1',
        type: 'reasoning',
        content: '先检查镜像流状态',
        timestamp: '2026-04-21T10:00:01.000Z',
        turnId: 'turn-1',
      },
      {
        signature: 'plan-1',
        type: 'plan_update',
        content: '',
        timestamp: '2026-04-21T10:00:02.000Z',
        turnId: 'turn-1',
        tasks: [
          { text: '检查镜像流状态', status: 'completed' },
          { text: '补交界处测试', status: 'in_progress' },
        ],
      },
    ], {
      onStatusProgress: (_subscription, turnState) => {
        statusNotes.push(turnState.statusNote);
      },
      onTaskProgress: (_subscription, turnState) => {
        taskSnapshots.push(turnState.taskItems.map((task) => ({ ...task })));
      },
    });

    assert.deepEqual(statusNotes, ['先检查镜像流状态']);
    assert.deepEqual(taskSnapshots, [[
      { text: '检查镜像流状态', status: 'completed' },
      { text: '补交界处测试', status: 'in_progress' },
    ]]);
    assert.equal(subscription.pendingTurn?.statusNote, '先检查镜像流状态');
    assert.deepEqual(subscription.pendingTurn?.taskItems, [
      { text: '检查镜像流状态', status: 'completed' },
      { text: '补交界处测试', status: 'in_progress' },
    ]);
    assert.equal(subscription.pendingTurn?.lastActivityAt, '2026-04-21T10:00:02.000Z');
    assert.equal(subscription.pendingTurn?.lastContentResponseAt, null);
    assert.equal(subscription.pendingTurn?.lastResponseAt, null);
  });

  it('updates context usage through mirror progress hooks', () => {
    const statuses: string[] = [];
    const subscription = {
      sessionId: 'session-1',
      threadId: 'thread-1',
      pendingTurn: null,
    } as any;

    consumeMirrorRecords(subscription, [
      {
        signature: 'start-1',
        type: 'task_started',
        content: '',
        timestamp: '2026-04-21T10:00:00.000Z',
        turnId: 'turn-1',
      },
      {
        signature: 'usage-1',
        type: 'context_usage',
        content: '',
        timestamp: '2026-04-21T10:00:03.000Z',
        turnId: 'turn-1',
        contextUsage: {
          modelContextWindow: 200_000,
          lastTokenUsage: {
            inputTokens: 80_500,
            outputTokens: 2_400,
          },
        },
      },
    ], {
      onStatusProgress: (_subscription, turnState) => {
        statuses.push(`${turnState.contextUsage?.lastTokenUsage?.inputTokens || 0}`);
      },
    });

    assert.deepEqual(statuses, ['80500']);
    assert.equal(subscription.pendingTurn?.contextUsage?.modelContextWindow, 200_000);
    assert.equal(subscription.pendingTurn?.lastActivityAt, '2026-04-21T10:00:03.000Z');
  });

  it('stores goal status without starting a stream for goal-only progress', () => {
    const streamSnapshots: string[] = [];
    const subscription = {
      sessionId: 'session-1',
      threadId: 'thread-1',
      consecutiveEmptyGoalTurns: 0,
      emptyGoalLoopWarningSent: false,
      pendingTurn: null,
    } as any;

    consumeMirrorRecords(subscription, [
      {
        signature: 'goal-1',
        type: 'goal_status',
        content: '分析 mirror goal 事件',
        timestamp: '2026-06-02T11:49:51.000Z',
        turnId: 'turn-1',
        goalStatus: 'active',
        goalObjective: '分析 mirror goal 事件',
      },
    ], {
      onStreamText: (_subscription, turnState) => {
        streamSnapshots.push(`${turnState.goalStatus?.status}:${turnState.goalStatus?.objective}`);
      },
    });

    assert.deepEqual(streamSnapshots, []);
    assert.deepEqual(subscription.pendingTurn?.goalStatus, {
      status: 'active',
      objective: '分析 mirror goal 事件',
    });
    assert.equal(subscription.pendingTurn?.userText, null);
  });

  it('emits one warning after three empty active goal turns', () => {
    const subscription = {
      sessionId: 'session-1',
      threadId: 'thread-1',
      consecutiveEmptyGoalTurns: 0,
      emptyGoalLoopWarningSent: false,
      pendingTurn: null,
    } as any;

    const finalized = consumeMirrorRecords(subscription, [
      {
        signature: 'start-1',
        type: 'task_started',
        content: '',
        timestamp: '2026-06-05T09:56:01.000Z',
        turnId: 'turn-1',
      },
      {
        signature: 'goal-1',
        type: 'goal_status',
        content: '检查文档',
        timestamp: '2026-06-05T09:56:01.100Z',
        turnId: 'turn-1',
        goalStatus: 'active',
        goalObjective: '检查文档',
      },
      {
        signature: 'complete-1',
        type: 'task_complete',
        content: '',
        timestamp: '2026-06-05T09:56:01.200Z',
        turnId: 'turn-1',
      },
      {
        signature: 'start-2',
        type: 'task_started',
        content: '',
        timestamp: '2026-06-05T09:56:02.000Z',
        turnId: 'turn-2',
      },
      {
        signature: 'goal-2',
        type: 'goal_status',
        content: '检查文档',
        timestamp: '2026-06-05T09:56:02.100Z',
        turnId: 'turn-2',
        goalStatus: 'active',
        goalObjective: '检查文档',
      },
      {
        signature: 'complete-2',
        type: 'task_complete',
        content: '',
        timestamp: '2026-06-05T09:56:02.200Z',
        turnId: 'turn-2',
      },
      {
        signature: 'start-3',
        type: 'task_started',
        content: '',
        timestamp: '2026-06-05T09:56:03.000Z',
        turnId: 'turn-3',
      },
      {
        signature: 'goal-3',
        type: 'goal_status',
        content: '检查文档',
        timestamp: '2026-06-05T09:56:03.100Z',
        turnId: 'turn-3',
        goalStatus: 'active',
        goalObjective: '检查文档',
      },
      {
        signature: 'complete-3',
        type: 'task_complete',
        content: '',
        timestamp: '2026-06-05T09:56:03.200Z',
        turnId: 'turn-3',
      },
      {
        signature: 'start-4',
        type: 'task_started',
        content: '',
        timestamp: '2026-06-05T09:56:04.000Z',
        turnId: 'turn-4',
      },
      {
        signature: 'goal-4',
        type: 'goal_status',
        content: '检查文档',
        timestamp: '2026-06-05T09:56:04.100Z',
        turnId: 'turn-4',
        goalStatus: 'active',
        goalObjective: '检查文档',
      },
      {
        signature: 'complete-4',
        type: 'task_complete',
        content: '',
        timestamp: '2026-06-05T09:56:04.200Z',
        turnId: 'turn-4',
      },
    ]);

    assert.equal(finalized.length, 1);
    assert.match(finalized[0]?.signature || '', /^goal-loop-warning:/);
    assert.match(finalized[0]?.text || '', /Goal 自动重启告警/);
    assert.match(finalized[0]?.text || '', /连续 3 轮/);
    assert.equal(subscription.consecutiveEmptyGoalTurns, 4);
    assert.equal(subscription.emptyGoalLoopWarningSent, true);

    const laterFinalized = consumeMirrorRecords(subscription, [
      {
        signature: 'start-real-after-warning',
        type: 'task_started',
        content: '',
        timestamp: '2026-06-05T09:56:05.000Z',
        turnId: 'turn-real-after-warning',
      },
      {
        signature: 'assistant-real-after-warning',
        type: 'message',
        role: 'assistant',
        content: '恢复输出。',
        timestamp: '2026-06-05T09:56:05.100Z',
        turnId: 'turn-real-after-warning',
      },
      {
        signature: 'complete-real-after-warning',
        type: 'task_complete',
        content: '恢复输出。',
        timestamp: '2026-06-05T09:56:05.200Z',
        turnId: 'turn-real-after-warning',
      },
      {
        signature: 'start-5',
        type: 'task_started',
        content: '',
        timestamp: '2026-06-05T09:56:06.000Z',
        turnId: 'turn-5',
      },
      {
        signature: 'goal-5',
        type: 'goal_status',
        content: '检查文档',
        timestamp: '2026-06-05T09:56:06.100Z',
        turnId: 'turn-5',
        goalStatus: 'active',
        goalObjective: '检查文档',
      },
      {
        signature: 'complete-5',
        type: 'task_complete',
        content: '',
        timestamp: '2026-06-05T09:56:06.200Z',
        turnId: 'turn-5',
      },
      {
        signature: 'start-6',
        type: 'task_started',
        content: '',
        timestamp: '2026-06-05T09:56:07.000Z',
        turnId: 'turn-6',
      },
      {
        signature: 'goal-6',
        type: 'goal_status',
        content: '检查文档',
        timestamp: '2026-06-05T09:56:07.100Z',
        turnId: 'turn-6',
        goalStatus: 'active',
        goalObjective: '检查文档',
      },
      {
        signature: 'complete-6',
        type: 'task_complete',
        content: '',
        timestamp: '2026-06-05T09:56:07.200Z',
        turnId: 'turn-6',
      },
      {
        signature: 'start-7',
        type: 'task_started',
        content: '',
        timestamp: '2026-06-05T09:56:08.000Z',
        turnId: 'turn-7',
      },
      {
        signature: 'goal-7',
        type: 'goal_status',
        content: '检查文档',
        timestamp: '2026-06-05T09:56:08.100Z',
        turnId: 'turn-7',
        goalStatus: 'active',
        goalObjective: '检查文档',
      },
      {
        signature: 'complete-7',
        type: 'task_complete',
        content: '',
        timestamp: '2026-06-05T09:56:08.200Z',
        turnId: 'turn-7',
      },
    ]);

    assert.equal(laterFinalized.length, 1);
    assert.equal(laterFinalized[0]?.text, '恢复输出。');
    assert.doesNotMatch(laterFinalized.map((turn) => turn.text).join('\n'), /Goal 自动重启告警/);
    assert.equal(subscription.emptyGoalLoopWarningSent, true);
  });

  it('resets the empty goal loop guard when a later turn has real output', () => {
    const subscription = {
      sessionId: 'session-1',
      threadId: 'thread-1',
      consecutiveEmptyGoalTurns: 2,
      emptyGoalLoopWarningSent: false,
      pendingTurn: null,
    } as any;

    const finalized = consumeMirrorRecords(subscription, [
      {
        signature: 'start-real',
        type: 'task_started',
        content: '',
        timestamp: '2026-06-05T10:00:00.000Z',
        turnId: 'turn-real',
      },
      {
        signature: 'goal-real',
        type: 'goal_status',
        content: '检查文档',
        timestamp: '2026-06-05T10:00:00.100Z',
        turnId: 'turn-real',
        goalStatus: 'active',
        goalObjective: '检查文档',
      },
      {
        signature: 'assistant-real',
        type: 'message',
        role: 'assistant',
        content: '继续处理。',
        timestamp: '2026-06-05T10:00:01.000Z',
        turnId: 'turn-real',
      },
      {
        signature: 'complete-real',
        type: 'task_complete',
        content: '继续处理。',
        timestamp: '2026-06-05T10:00:02.000Z',
        turnId: 'turn-real',
      },
    ]);

    assert.equal(finalized.length, 1);
    assert.equal(finalized[0]?.text, '继续处理。');
    assert.equal(subscription.consecutiveEmptyGoalTurns, 0);
    assert.equal(subscription.emptyGoalLoopWarningSent, false);
  });

  it('keeps long goal objectives intact for downstream collapsed cards', () => {
    const longObjective = '开发一下：goal active的时候只打印一条提示，任务本体只打印一小段，剩下的用折叠面板展示，完成后merge回master并删除worktree。'.repeat(2);
    const subscription = {
      sessionId: 'session-1',
      threadId: 'thread-1',
      pendingTurn: null,
    } as any;

    consumeMirrorRecords(subscription, [
      {
        signature: 'goal-long',
        type: 'goal_status',
        content: longObjective,
        timestamp: '2026-06-02T11:49:51.000Z',
        turnId: 'turn-1',
        goalStatus: 'active',
        goalObjective: longObjective,
      },
    ]);

    assert.equal(subscription.pendingTurn?.goalStatus?.objective, longObjective);
    assert.ok((subscription.pendingTurn?.goalStatus?.objective || '').length > 120);
  });

  it('does not reset content response time for tool progress', () => {
    const subscription = {
      sessionId: 'session-1',
      threadId: 'thread-1',
      pendingTurn: null,
    } as any;

    consumeMirrorRecords(subscription, [
      {
        signature: 'assistant-1',
        type: 'message',
        role: 'assistant',
        content: '正文输出',
        timestamp: '2026-04-21T10:00:01.000Z',
        turnId: 'turn-1',
      },
      {
        signature: 'tool-1',
        type: 'tool_started',
        content: '',
        timestamp: '2026-04-21T10:03:00.000Z',
        turnId: 'turn-1',
        toolId: 'tool-1',
        toolName: 'shell_command',
      },
    ]);

    assert.equal(subscription.pendingTurn?.lastActivityAt, '2026-04-21T10:03:00.000Z');
    assert.equal(subscription.pendingTurn?.lastContentResponseAt, '2026-04-21T10:00:01.000Z');
    assert.equal(subscription.pendingTurn?.lastResponseAt, '2026-04-21T10:00:01.000Z');
  });

  it('uses shared Codex turn events and always keeps mirror tool details', () => {
    const records = [
      {
        signature: 'tool-start',
        type: 'tool_started' as const,
        content: '',
        timestamp: '2026-04-21T10:00:01.000Z',
        turnId: 'turn-1',
        toolId: 'tool-1',
        toolName: 'Bash',
        toolInput: { command: 'pwd' },
      },
      {
        signature: 'tool-finish',
        type: 'tool_finished' as const,
        content: '/tmp/project',
        timestamp: '2026-04-21T10:00:02.000Z',
        turnId: 'turn-1',
        toolId: 'tool-1',
      },
    ];

    const subscription = {
      sessionId: 'session-1',
      threadId: 'thread-1',
      pendingTurn: null,
    } as any;
    consumeMirrorRecords(subscription, records);
    assert.deepEqual(Array.from(subscription.pendingTurn.toolCalls.values()), [{
      id: 'tool-1',
      name: 'Bash',
      status: 'complete',
      input: 'pwd',
      output: '/tmp/project',
      detail: {
        kind: 'exec_command',
        command: 'pwd',
        output: '/tmp/project',
        rawOutput: '/tmp/project',
      },
    }]);
  });

  it('deduplicates matching agent_message and response_item mirror text', () => {
    const streamSnapshots: string[] = [];
    const subscription = {
      sessionId: 'session-1',
      threadId: 'thread-1',
      pendingTurn: null,
    } as any;

    consumeMirrorRecords(subscription, [
      {
        signature: 'commentary-event',
        type: 'message',
        role: 'commentary',
        content: '正在检查新版格式',
        timestamp: '2026-04-21T10:00:01.000Z',
        turnId: 'turn-1',
      },
      {
        signature: 'commentary-response',
        type: 'message',
        role: 'commentary',
        content: '正在检查新版格式',
        timestamp: '2026-04-21T10:00:01.001Z',
        turnId: 'turn-1',
      },
    ], {
      onStreamText: (_subscription, turnState) => {
        streamSnapshots.push(turnState.streamedText);
      },
    });

    assert.deepEqual(streamSnapshots, ['正在检查新版格式']);
    assert.equal(subscription.pendingTurn?.streamedText, '正在检查新版格式');
  });

  it('keeps repeated mirror text when it is not an immediate duplicate', () => {
    const streamSnapshots: string[] = [];
    const subscription = {
      sessionId: 'session-1',
      threadId: 'thread-1',
      pendingTurn: null,
    } as any;

    consumeMirrorRecords(subscription, [
      {
        signature: 'assistant-1',
        type: 'message',
        role: 'assistant',
        content: 'OK',
        timestamp: '2026-04-21T10:00:01.000Z',
        turnId: 'turn-1',
      },
      {
        signature: 'assistant-2',
        type: 'message',
        role: 'assistant',
        content: 'OK',
        timestamp: '2026-04-21T10:00:05.000Z',
        turnId: 'turn-1',
      },
    ], {
      onStreamText: (_subscription, turnState) => {
        streamSnapshots.push(turnState.streamedText);
      },
    });

    assert.deepEqual(streamSnapshots, ['OK', 'OK\n\nOK']);
    assert.equal(subscription.pendingTurn?.streamedText, 'OK\n\nOK');
  });

  it('keeps streamed commentary as a separate paragraph in the final turn text', () => {
    const subscription = {
      sessionId: 'session-1',
      threadId: 'thread-1',
      pendingTurn: null,
    } as any;

    const finalized = consumeMirrorRecords(subscription, [
      {
        signature: 'start-1',
        type: 'task_started',
        content: '',
        timestamp: '2026-04-21T10:00:00.000Z',
        turnId: 'turn-1',
      },
      {
        signature: 'compact-1',
        type: 'message',
        role: 'commentary',
        content: '> ⚙️ 上下文已压缩，后续回复会基于压缩后的上下文继续。',
        timestamp: '2026-04-21T10:00:01.000Z',
        turnId: 'turn-1',
      },
      {
        signature: 'complete-1',
        type: 'task_complete',
        content: '最终回答',
        timestamp: '2026-04-21T10:00:02.000Z',
        turnId: 'turn-1',
      },
    ]);

    assert.equal(finalized.length, 1);
    assert.equal(finalized[0]?.text, '> ⚙️ 上下文已压缩，后续回复会基于压缩后的上下文继续。\n\n最终回答');
  });
});
