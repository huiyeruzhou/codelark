import { createHash } from 'node:crypto';
import type { BridgeMirrorRecord } from '../contracts.js';

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
  if (item.type === 'userMessage') {
    if (!completed) return;
    return make({ type: 'message', role: 'user', content: (item.content || []).map((c) => c.text || '').filter(Boolean).join('\n') });
  }
  if (item.type === 'agentMessage') {
    if (!item.text) return;
    if (item.phase === 'commentary' && !completed) return;
    return make({ type: 'message', role: item.phase === 'commentary' ? 'commentary' : 'assistant', content: item.text, replacementKey: item.id });
  }
  if (item.type === 'reasoning') {
    if (!completed) return;
    return make({ type: 'reasoning', content: (item.summary || []).join('\n'), reasoningKind: 'summary' });
  }
  if (item.type === 'plan') return make({ type: 'message', role: 'commentary', content: item.text || '' });
  if (item.type === 'contextCompaction') return completed ? make({ type: 'message', role: 'commentary', content: 'Codex 已压缩上下文。' }) : undefined;
  const name = item.type === 'commandExecution' ? 'Bash' : item.type === 'fileChange' ? 'apply_patch' : item.type;
  return make({
    type: completed ? 'tool_finished' : 'tool_started', toolId: item.id, toolName: name,
    toolInput: item.command ? { command: item.command } : item,
    content: item.aggregatedOutput || (completed ? JSON.stringify(item.result ?? item.error ?? '') : ''),
    ...(item.type === 'commandExecution' ? { toolDetail: { kind: 'exec_command' as const, command: item.command, output: item.aggregatedOutput, exitCode: item.exitCode } } : {}),
    isError: item.status === 'failed' || (typeof item.exitCode === 'number' && item.exitCode !== 0),
  });
}

export function protocolTurnRecord(threadId: string, turn: AppServerTurn): BridgeMirrorRecord {
  return protocolRecord(threadId, turn.id, turn.status, {
    type: turn.status === 'inProgress' ? 'task_started' : turn.status === 'interrupted' ? 'task_aborted' : 'task_complete',
    content: '', isError: turn.status === 'failed', errorText: turn.error?.message,
  });
}
