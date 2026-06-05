import test from 'node:test';
import assert from 'node:assert/strict';

import type { BridgeMirrorRecord } from '../../../runtime/contracts.js';
import { buildUiHistoryEntriesFromMirrorRecords } from '../../../operator-ui/session-history.js';

test('buildUiHistoryEntriesFromMirrorRecords keeps all major mirror events visible', () => {
  const records: BridgeMirrorRecord[] = [
    {
      signature: '1',
      type: 'message',
      role: 'user',
      content: '请帮我查资料',
      timestamp: '2026-03-25T00:00:00.000Z',
    },
    {
      signature: '2',
      type: 'task_started',
      content: '',
      timestamp: '2026-03-25T00:00:01.000Z',
      turnId: 'turn-1',
    },
    {
      signature: '3',
      type: 'reasoning',
      content: '先搜索相关上下文',
      timestamp: '2026-03-25T00:00:02.000Z',
      turnId: 'turn-1',
    },
    {
      signature: '4',
      type: 'plan_update',
      content: '',
      timestamp: '2026-03-25T00:00:03.000Z',
      turnId: 'turn-1',
      tasks: [
        { text: '收集资料', status: 'in_progress' },
        { text: '整理答案', status: 'pending' },
      ],
    },
    {
      signature: '5',
      type: 'tool_started',
      content: '',
      timestamp: '2026-03-25T00:00:04.000Z',
      turnId: 'turn-1',
      toolId: 'call-1',
      toolName: 'WebSearch',
    },
    {
      signature: '6',
      type: 'tool_finished',
      content: '共找到 5 条结果',
      timestamp: '2026-03-25T00:00:05.000Z',
      turnId: 'turn-1',
      toolId: 'call-1',
    },
    {
      signature: '7',
      type: 'message',
      role: 'assistant',
      content: '这是整理后的结论',
      timestamp: '2026-03-25T00:00:06.000Z',
      turnId: 'turn-1',
    },
    {
      signature: '8',
      type: 'task_complete',
      role: 'assistant',
      content: '这是整理后的结论',
      timestamp: '2026-03-25T00:00:07.000Z',
      turnId: 'turn-1',
    },
  ];

  const entries = buildUiHistoryEntriesFromMirrorRecords(records);

  assert.deepEqual(
    entries.map((entry) => ({ role: entry.role, content: entry.content })),
    [
      { role: 'user', content: '请帮我查资料' },
      { role: 'system', content: '任务开始' },
      { role: 'commentary', content: '推理摘要\n\n先搜索相关上下文' },
      {
        role: 'system',
        content: '计划已更新\n\n- [-] 收集资料\n- [ ] 整理答案',
      },
      { role: 'tool', content: '工具调用开始: `WebSearch`' },
      { role: 'tool', content: '工具调用完成: `WebSearch`\n\n共找到 5 条结果' },
      { role: 'assistant', content: '这是整理后的结论' },
      { role: 'system', content: '任务完成\n\n这是整理后的结论' },
    ],
  );
});

test('buildUiHistoryEntriesFromMirrorRecords marks failed tools and aborted tasks', () => {
  const records: BridgeMirrorRecord[] = [
    {
      signature: '1',
      type: 'tool_finished',
      content: 'permission denied',
      timestamp: '2026-03-25T00:10:00.000Z',
      toolId: 'call-err',
      toolName: 'Bash',
      isError: true,
    },
    {
      signature: '2',
      type: 'task_aborted',
      content: '用户取消',
      timestamp: '2026-03-25T00:10:01.000Z',
      turnId: 'turn-2',
    },
  ];

  const entries = buildUiHistoryEntriesFromMirrorRecords(records);

  assert.deepEqual(
    entries.map((entry) => ({ role: entry.role, content: entry.content })),
    [
      { role: 'tool', content: '工具调用失败: `Bash`\n\npermission denied' },
      { role: 'system', content: '任务中止\n\n用户取消' },
    ],
  );
});
