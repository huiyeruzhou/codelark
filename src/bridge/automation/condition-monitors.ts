import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { CODELARK_HOME } from '../../configuration/paths.js';

const CONDITION_MONITORS_PATH = path.join(CODELARK_HOME, 'data', 'condition-monitors.json');

export type ConditionMonitorStatus = 'running' | 'completed' | 'cancelled';

export interface ConditionMonitorTask {
  id: string;
  ownerInternalChatId: string;
  ownerBridgeSessionId: string;
  label: string;
  scriptPath: string;
  pythonExecutable: string;
  intervalSeconds: number;
  timeoutSeconds: number;
  status: ConditionMonitorStatus;
  createdAt: string;
  updatedAt: string;
  checkedCount: number;
  lastCheckedAt?: string;
  lastError?: string;
  completedAt?: string;
  cancelledAt?: string;
}

export interface CreateConditionMonitorTaskInput {
  ownerInternalChatId: string;
  ownerBridgeSessionId: string;
  label?: string;
  scriptPath: string;
  pythonExecutable: string;
  intervalSeconds: number;
  timeoutSeconds: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function readTaskMap(): Record<string, ConditionMonitorTask> {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONDITION_MONITORS_PATH, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, ConditionMonitorTask>;
  } catch {
    return {};
  }
}

function writeTaskMap(tasks: Record<string, ConditionMonitorTask>): void {
  fs.mkdirSync(path.dirname(CONDITION_MONITORS_PATH), { recursive: true });
  const temporary = `${CONDITION_MONITORS_PATH}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(tasks, null, 2), 'utf8');
  fs.renameSync(temporary, CONDITION_MONITORS_PATH);
}

export function listConditionMonitorTasks(options: {
  ownerInternalChatId?: string;
  statuses?: ConditionMonitorStatus[];
} = {}): ConditionMonitorTask[] {
  return Object.values(readTaskMap())
    .filter((task) => !options.ownerInternalChatId || task.ownerInternalChatId === options.ownerInternalChatId)
    .filter((task) => !options.statuses || options.statuses.includes(task.status))
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
}

export function getConditionMonitorTask(taskId: string): ConditionMonitorTask | null {
  return readTaskMap()[taskId] || null;
}

export function createConditionMonitorTask(input: CreateConditionMonitorTaskInput): ConditionMonitorTask {
  const tasks = readTaskMap();
  const timestamp = nowIso();
  const task: ConditionMonitorTask = {
    id: crypto.randomUUID(),
    ownerInternalChatId: input.ownerInternalChatId,
    ownerBridgeSessionId: input.ownerBridgeSessionId,
    label: input.label?.trim() || path.basename(input.scriptPath),
    scriptPath: input.scriptPath,
    pythonExecutable: input.pythonExecutable,
    intervalSeconds: input.intervalSeconds,
    timeoutSeconds: input.timeoutSeconds,
    status: 'running',
    createdAt: timestamp,
    updatedAt: timestamp,
    checkedCount: 0,
  };
  tasks[task.id] = task;
  writeTaskMap(tasks);
  return task;
}

export function updateConditionMonitorTask(
  taskId: string,
  updates: Partial<ConditionMonitorTask>,
): ConditionMonitorTask | null {
  const tasks = readTaskMap();
  const current = tasks[taskId];
  if (!current) return null;
  const next: ConditionMonitorTask = {
    ...current,
    ...updates,
    id: current.id,
    updatedAt: nowIso(),
  };
  tasks[taskId] = next;
  writeTaskMap(tasks);
  return next;
}

export function cancelConditionMonitorTask(taskId: string): ConditionMonitorTask | null {
  const task = getConditionMonitorTask(taskId);
  if (!task) return null;
  if (task.status !== 'running') return task;
  return updateConditionMonitorTask(taskId, {
    status: 'cancelled',
    cancelledAt: nowIso(),
  });
}

export const _testOnly = {
  path: CONDITION_MONITORS_PATH,
};
