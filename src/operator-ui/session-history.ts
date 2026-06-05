import type { TaskProgressInfo } from '../domain/progress.js';
import type { BridgeMirrorRecord } from '../runtime/contracts.js';

export interface UiHistoryEntry {
  role: string;
  content: string;
  timestamp: string;
}

function formatToolName(toolName: string | undefined, toolId: string | undefined): string {
  const normalized = toolName?.trim();
  if (normalized) return normalized;
  const fallbackId = toolId?.trim();
  return fallbackId ? `tool:${fallbackId}` : 'tool';
}

function formatToolEventTitle(toolName: string, isFinished: boolean, isError: boolean): string {
  if (!isFinished) return `工具调用开始: \`${toolName}\``;
  if (isError) return `工具调用失败: \`${toolName}\``;
  return `工具调用完成: \`${toolName}\``;
}

function formatTaskStatus(status: TaskProgressInfo['status']): string {
  if (status === 'completed') return 'x';
  if (status === 'in_progress') return '-';
  return ' ';
}

function formatPlanUpdate(tasks: TaskProgressInfo[] | undefined): string {
  if (!tasks || tasks.length === 0) return '计划已更新';
  return [
    '计划已更新',
    '',
    ...tasks.map((task) => `- [${formatTaskStatus(task.status)}] ${task.text}`),
  ].join('\n');
}

function withDetails(title: string, details: string | undefined): string {
  const normalized = details?.trim();
  return normalized ? `${title}\n\n${normalized}` : title;
}

export function buildUiHistoryEntriesFromMirrorRecords(records: BridgeMirrorRecord[]): UiHistoryEntry[] {
  const toolNameById = new Map<string, string>();

  return records.map((record) => {
    if (record.type === 'message') {
      return {
        role: record.role || 'assistant',
        content: record.content,
        timestamp: record.timestamp,
      };
    }

    if (record.type === 'reasoning') {
      return {
        role: 'commentary',
        content: withDetails('推理摘要', record.content),
        timestamp: record.timestamp,
      };
    }

    if (record.type === 'plan_update') {
      return {
        role: 'system',
        content: formatPlanUpdate(record.tasks),
        timestamp: record.timestamp,
      };
    }

    if (record.type === 'task_started') {
      return {
        role: 'system',
        content: '任务开始',
        timestamp: record.timestamp,
      };
    }

    if (record.type === 'task_complete') {
      return {
        role: 'system',
        content: withDetails('任务完成', record.content),
        timestamp: record.timestamp,
      };
    }

    if (record.type === 'task_aborted') {
      return {
        role: 'system',
        content: withDetails('任务中止', record.content),
        timestamp: record.timestamp,
      };
    }

    const resolvedToolName = formatToolName(
      record.toolName || (record.toolId ? toolNameById.get(record.toolId) : undefined),
      record.toolId,
    );

    if (record.type === 'tool_started') {
      if (record.toolId) toolNameById.set(record.toolId, resolvedToolName);
      return {
        role: 'tool',
        content: formatToolEventTitle(resolvedToolName, false, false),
        timestamp: record.timestamp,
      };
    }

    if (record.type === 'tool_finished') {
      if (record.toolId) toolNameById.delete(record.toolId);
      return {
        role: 'tool',
        content: withDetails(formatToolEventTitle(resolvedToolName, true, record.isError === true), record.content),
        timestamp: record.timestamp,
      };
    }

    return {
      role: 'system',
      content: record.content || '未分类事件',
      timestamp: record.timestamp,
    };
  });
}
