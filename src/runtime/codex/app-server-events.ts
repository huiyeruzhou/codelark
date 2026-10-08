import { createHash } from 'node:crypto';
import type { BridgeMirrorRecord } from '../contracts.js';
import { buildToolCallDetailFromInput } from '../../shared/progress/tool-call-details.js';
import { CONTEXT_COMPACTED_NOTICE } from './session-index/internal-control-events.js';

// Only the common v2 fields are required. New item kinds remain visible as tools.
export interface AppServerItem {
  id: string;
  type: string;
  text?: string;
  phase?: string;
  clientId?: string;
  content?: Array<{ type: string; text?: string }>;
  status?: string;
  command?: string;
  aggregatedOutput?: string;
  exitCode?: number;
  summary?: string[];
  [key: string]: unknown;
}

export interface AppServerTurn {
  id: string;
  status: 'inProgress' | 'completed' | 'failed' | 'interrupted';
  items?: AppServerItem[];
  error?: { message?: string } | null;
}

export interface AppServerThread {
  id: string;
  cwd?: string;
  status?: { type: string; activeFlags?: string[] };
  turns?: AppServerTurn[];
}

interface AppServerFileChange {
  path: string;
  type: string;
  diff: string;
  content: string;
  movePath: string;
}

function textField(record: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string') return value;
  }
  return '';
}

function normalizeFileChange(path: string, value: unknown): AppServerFileChange | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const kind = record.kind && typeof record.kind === 'object' && !Array.isArray(record.kind)
    ? record.kind as Record<string, unknown>
    : null;
  const normalizedPath = textField(record, 'path') || path;
  if (!normalizedPath.trim()) return null;
  return {
    path: normalizedPath,
    type: (textField(kind || record, 'type') || textField(record, 'type')).toLowerCase(),
    diff: textField(record, 'diff', 'unified_diff', 'unifiedDiff'),
    content: textField(record, 'content'),
    movePath: textField(kind || record, 'move_path', 'movePath') || textField(record, 'move_path', 'movePath'),
  };
}

function appServerFileChanges(item: AppServerItem): AppServerFileChange[] {
  if (Array.isArray(item.changes)) {
    return item.changes.map((change) => normalizeFileChange('', change)).filter((change): change is AppServerFileChange => Boolean(change));
  }
  if (!item.changes || typeof item.changes !== 'object') return [];
  return Object.entries(item.changes as Record<string, unknown>)
    .map(([path, change]) => normalizeFileChange(path, change))
    .filter((change): change is AppServerFileChange => Boolean(change));
}

function contentAsDiff(content: string, prefix: '+' | '-'): string {
  if (!content) return '';
  return content.split(/\r?\n/u).map((line) => `${prefix}${line}`).join('\n');
}

export function appServerFileChangePatchText(item: AppServerItem): string {
  const changes = appServerFileChanges(item);
  if (changes.length === 0) return '';
  const lines = ['*** Begin Patch'];
  for (const change of changes) {
    const action = /^(?:add|create|new)$/u.test(change.type)
      ? 'Add File'
      : /^(?:delete|remove)$/u.test(change.type)
        ? 'Delete File'
        : 'Update File';
    lines.push(`*** ${action}: ${change.path}`);
    if (change.movePath) lines.push(`*** Move to: ${change.movePath}`);
    const body = change.diff
      || (action === 'Add File' ? contentAsDiff(change.content, '+') : '')
      || (action === 'Delete File' ? contentAsDiff(change.content, '-') : '')
      || change.content;
    if (body) lines.push(body);
  }
  lines.push('*** End Patch');
  return lines.join('\n');
}

export function protocolRecord(
  threadId: string,
  turnId: string,
  identity: string,
  fields: Omit<BridgeMirrorRecord, 'signature' | 'timestamp' | 'turnId'>,
): BridgeMirrorRecord {
  const digest = createHash('sha256').update(JSON.stringify(fields)).digest('hex').slice(0, 20);
  return { ...fields, turnId, timestamp: new Date().toISOString(), signature: `app:${threadId}:${turnId}:${identity}:${digest}` };
}

export function protocolItemRecord(threadId: string, turnId: string, item: AppServerItem, completed: boolean): BridgeMirrorRecord | undefined {
  const make = (fields: Omit<BridgeMirrorRecord, 'signature' | 'timestamp' | 'turnId'>) => protocolRecord(threadId, turnId, `${item.id}:${completed}`, fields);
  const itemType = item.type.toLowerCase();
  if (itemType === 'usermessage') {
    if (!completed) return;
    return make({ type: 'message', role: 'user', content: (item.content || []).map((c) => c.text || '').filter(Boolean).join('\n') });
  }
  if (itemType === 'agentmessage') {
    if (!item.text) return;
    if (item.phase === 'commentary' && !completed) return;
    return make({ type: 'message', role: item.phase === 'commentary' ? 'commentary' : 'assistant', content: item.text, replacementKey: item.id });
  }
  if (itemType === 'reasoning') {
    if (!completed) return;
    return make({ type: 'reasoning', content: (item.summary || []).join('\n'), reasoningKind: 'summary' });
  }
  if (itemType === 'plan') return make({ type: 'message', role: 'commentary', content: item.text || '' });
  if (itemType === 'contextcompaction') return completed ? make({ type: 'message', role: 'commentary', content: CONTEXT_COMPACTED_NOTICE }) : undefined;
  const name = itemType === 'commandexecution' ? 'Bash' : itemType === 'filechange' ? 'apply_patch' : item.type;
  const patchText = itemType === 'filechange' ? appServerFileChangePatchText(item) : '';
  return make({
    type: completed ? 'tool_finished' : 'tool_started', toolId: item.id, toolName: name,
    toolInput: patchText || (item.command ? { command: item.command } : item),
    content: item.aggregatedOutput || (completed ? JSON.stringify(item.result ?? item.error ?? '') : ''),
    ...(itemType === 'commandexecution' ? { toolDetail: { kind: 'exec_command' as const, command: item.command, output: item.aggregatedOutput, exitCode: item.exitCode } } : {}),
    ...(patchText ? { toolDetail: buildToolCallDetailFromInput('apply_patch', patchText) || undefined } : {}),
    isError: item.status === 'failed' || (typeof item.exitCode === 'number' && item.exitCode !== 0),
  });
}

export function protocolTurnRecord(threadId: string, turn: AppServerTurn): BridgeMirrorRecord {
  return protocolRecord(threadId, turn.id, turn.status, {
    type: turn.status === 'inProgress' ? 'task_started' : turn.status === 'interrupted' ? 'task_aborted' : 'task_complete',
    content: '', isError: turn.status === 'failed', errorText: turn.error?.message,
  });
}
