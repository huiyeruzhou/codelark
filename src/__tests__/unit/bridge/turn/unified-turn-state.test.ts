import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyUnifiedTurnContextUsage,
  applyUnifiedTurnGoalStatus,
  applyUnifiedTurnHistoryModelText,
  applyUnifiedTurnHistoryModelTextSnapshot,
  applyUnifiedTurnHistorySystemText,
  applyUnifiedTurnHistoryUserText,
  applyUnifiedTurnStatusNote,
  applyUnifiedTurnTasks,
  applyUnifiedTurnToolEvent,
  createUnifiedTurnProgressState,
  recordUnifiedTurnActivity,
  recordUnifiedTurnContentResponse,
} from '../../../../bridge/turn/unified-turn-state.js';
import { codexTurnEventFromSdkToolEvent } from '../../../../runtime/codex/turn-events.js';

describe('unified-turn-state', () => {
  it('tracks activity and content response timestamps monotonically', () => {
    const state = createUnifiedTurnProgressState(1000);

    recordUnifiedTurnActivity(state, 900);
    assert.equal(state.lastActivityAtMs, 1000);

    recordUnifiedTurnActivity(state, 1200);
    assert.equal(state.lastActivityAtMs, 1200);

    recordUnifiedTurnContentResponse(state, 1100);
    assert.equal(state.lastActivityAtMs, 1200);
    assert.equal(state.lastContentResponseAtMs, 1100);

    recordUnifiedTurnContentResponse(state, 1300);
    assert.equal(state.lastActivityAtMs, 1300);
    assert.equal(state.lastContentResponseAtMs, 1300);
  });

  it('applies status, task, context, and goal progress updates', () => {
    const state = createUnifiedTurnProgressState(1000);

    applyUnifiedTurnStatusNote(state, '  thinking  ', 1010);
    applyUnifiedTurnTasks(state, [{ text: 'inspect', status: 'in_progress' }], 1020);
    applyUnifiedTurnContextUsage(state, {
      modelContextWindow: 200_000,
      lastTokenUsage: { inputTokens: 80_000, outputTokens: 500 },
    }, 1030);
    applyUnifiedTurnGoalStatus(state, {
      status: 'active',
      objective: 'finish unified turn refactor',
    }, 1040);

    assert.equal(state.statusNote, 'thinking');
    assert.deepEqual(state.taskItems, [{ text: 'inspect', status: 'in_progress' }]);
    assert.equal(state.contextUsage?.lastTokenUsage?.inputTokens, 80_000);
    assert.deepEqual(state.goalStatus, {
      status: 'active',
      objective: 'finish unified turn refactor',
    });
    assert.equal(state.lastActivityAtMs, 1040);
  });

  it('applies shared Codex tool events to the turn tool map', () => {
    const state = createUnifiedTurnProgressState(1000);

    applyUnifiedTurnToolEvent(state, codexTurnEventFromSdkToolEvent(
      'tool-1',
      'Bash',
      'running',
      { input: { command: 'pwd' } },
    ), {
      timestampMs: 1010,
    });
    applyUnifiedTurnToolEvent(state, codexTurnEventFromSdkToolEvent(
      'tool-1',
      '',
      'complete',
      { output: '/tmp/project' },
    ), {
      timestampMs: 1020,
    });

    assert.deepEqual(Array.from(state.toolCalls.values()), [{
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
    assert.equal(state.lastActivityAtMs, 1020);
  });

  it('reduces stream events into a strict append-only interleaved history', () => {
    const state = createUnifiedTurnProgressState(1000);

    assert.equal(state.historyItems.length, 0);

    applyUnifiedTurnHistoryUserText(state, '用户输入');
    applyUnifiedTurnHistorySystemText(state, '系统事件');
    applyUnifiedTurnHistoryModelText(state, '模型输出一');
    applyUnifiedTurnToolEvent(state, codexTurnEventFromSdkToolEvent('tool-1', 'exec_command', 'running'));
    applyUnifiedTurnHistoryModelText(state, '模型输出二');
    applyUnifiedTurnHistoryModelText(state, '模型输出三');
    applyUnifiedTurnToolEvent(state, codexTurnEventFromSdkToolEvent('tool-2', 'apply_patch', 'complete'));

    assert.deepEqual(state.historyItems.map((item) => item.type), [
      'markdown',
      'markdown',
      'markdown',
      'tool_panel',
      'markdown',
      'markdown',
      'tool_panel',
    ]);
    assert.equal(state.historyItems[0]?.type === 'markdown' ? state.historyItems[0].role : '', 'user');
    assert.equal(state.historyItems[0]?.type === 'markdown' ? state.historyItems[0].content : '', '用户输入');
    assert.equal(state.historyItems[1]?.type === 'markdown' ? state.historyItems[1].role : '', 'system');
    assert.equal(state.historyItems[1]?.type === 'markdown' ? state.historyItems[1].content : '', '系统事件');
    assert.equal(state.historyItems[2]?.type === 'markdown' ? state.historyItems[2].content : '', '模型输出一');
    assert.deepEqual(
      state.historyItems[3]?.type === 'tool_panel'
        ? state.historyItems[3].tools.map((tool) => tool.id)
        : [],
      ['tool-1'],
    );
    assert.equal(state.historyItems[4]?.type === 'markdown' ? state.historyItems[4].content : '', '模型输出二');
    assert.equal(state.historyItems[5]?.type === 'markdown' ? state.historyItems[5].content : '', '模型输出三');
    assert.deepEqual(
      state.historyItems[6]?.type === 'tool_panel'
        ? state.historyItems[6].tools.map((tool) => tool.id)
        : [],
      ['tool-2'],
    );
  });

  it('extends SDK full-text snapshots until a tool starts, then appends following text after the tool panel', () => {
    const state = createUnifiedTurnProgressState(1000);

    applyUnifiedTurnHistoryModelTextSnapshot(state, '模型');
    applyUnifiedTurnHistoryModelTextSnapshot(state, '模型输出');
    applyUnifiedTurnToolEvent(state, codexTurnEventFromSdkToolEvent('tool-1', 'exec_command', 'running'));
    applyUnifiedTurnHistoryModelTextSnapshot(state, '模型输出\n\n第二段');

    assert.deepEqual(state.historyItems.map((item) => item.type), [
      'markdown',
      'tool_panel',
      'markdown',
    ]);
    assert.equal(state.historyItems[0]?.type === 'markdown' ? state.historyItems[0].content : '', '模型输出');
    assert.deepEqual(
      state.historyItems[1]?.type === 'tool_panel'
        ? state.historyItems[1].tools.map((tool) => tool.id)
        : [],
      ['tool-1'],
    );
    assert.equal(state.historyItems[2]?.type === 'markdown' ? state.historyItems[2].content : '', '第二段');
  });
});
