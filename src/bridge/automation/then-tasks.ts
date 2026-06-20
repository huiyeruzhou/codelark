import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { CODELARK_HOME } from '../../configuration/paths.js';
import type { ChannelAddress } from '../../domain/channel.js';

const DATA_DIR = path.join(CODELARK_HOME, 'data');
const THEN_TASKS_PATH = path.join(DATA_DIR, 'then-tasks.json');

export type ThenTaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface ThenTask {
  id: string;
  bridgeSessionId: string;
  channelType: string;
  channelProvider?: string;
  channelAlias?: string;
  chatId: string;
  chatUserId?: string;
  chatDisplayName?: string;
  prompt: string;
  createdAt: string;
  updatedAt: string;
  status: ThenTaskStatus;
  triggeredAt?: string;
  completedAt?: string;
  lastError?: string;
}

export interface CreateThenTaskInput {
  bridgeSessionId: string;
  address: ChannelAddress;
  prompt: string;
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function nowIso(): string {
  return new Date().toISOString();
}

function atomicWriteJson(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2), 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

function readThenTaskMap(): Record<string, ThenTask> {
  try {
    const parsed = JSON.parse(fs.readFileSync(THEN_TASKS_PATH, 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, ThenTask>;
  } catch {
    return {};
  }
}

function writeThenTaskMap(tasks: Record<string, ThenTask>): void {
  atomicWriteJson(THEN_TASKS_PATH, tasks);
}

export function listThenTasks(options: {
  bridgeSessionId?: string;
  channelType?: string;
  chatId?: string;
  statuses?: ThenTaskStatus[];
} = {}): ThenTask[] {
  const statusSet = options.statuses ? new Set(options.statuses) : null;
  return Object.values(readThenTaskMap())
    .filter((task) => !options.bridgeSessionId || task.bridgeSessionId === options.bridgeSessionId)
    .filter((task) => !options.channelType || task.channelType === options.channelType)
    .filter((task) => !options.chatId || task.chatId === options.chatId)
    .filter((task) => !statusSet || statusSet.has(task.status))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

export function getThenTask(taskId: string): ThenTask | null {
  return readThenTaskMap()[taskId] || null;
}

export function createThenTask(input: CreateThenTaskInput): ThenTask {
  const tasks = readThenTaskMap();
  const timestamp = nowIso();
  const task: ThenTask = {
    id: crypto.randomUUID(),
    bridgeSessionId: input.bridgeSessionId,
    channelType: input.address.channelType,
    channelProvider: input.address.channelProvider,
    channelAlias: input.address.channelAlias,
    chatId: input.address.chatId,
    chatUserId: input.address.userId,
    chatDisplayName: input.address.displayName,
    prompt: input.prompt,
    createdAt: timestamp,
    updatedAt: timestamp,
    status: 'pending',
  };
  tasks[task.id] = task;
  writeThenTaskMap(tasks);
  return task;
}

export function updateThenTask(taskId: string, updates: Partial<ThenTask>): ThenTask | null {
  const tasks = readThenTaskMap();
  const existing = tasks[taskId];
  if (!existing) return null;
  const next: ThenTask = {
    ...existing,
    ...updates,
    id: existing.id,
    updatedAt: nowIso(),
  };
  tasks[taskId] = next;
  writeThenTaskMap(tasks);
  return next;
}

export function deleteThenTask(taskId: string): ThenTask | null {
  const tasks = readThenTaskMap();
  const existing = tasks[taskId];
  if (!existing) return null;
  delete tasks[taskId];
  writeThenTaskMap(tasks);
  return existing;
}

export function claimNextPendingThenTaskForSession(bridgeSessionId: string): ThenTask | null {
  const tasks = readThenTaskMap();
  const next = Object.values(tasks)
    .filter((task) => task.bridgeSessionId === bridgeSessionId && task.status === 'pending')
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))[0];
  if (!next) return null;
  const timestamp = nowIso();
  const claimed: ThenTask = {
    ...next,
    status: 'running',
    triggeredAt: timestamp,
    updatedAt: timestamp,
    lastError: undefined,
  };
  tasks[next.id] = claimed;
  writeThenTaskMap(tasks);
  return claimed;
}

export function pauseThenTasksForSession(bridgeSessionId: string): ThenTask[] {
  const tasks = readThenTaskMap();
  const paused: ThenTask[] = [];
  let changed = false;
  for (const [taskId, task] of Object.entries(tasks)) {
    if (task.bridgeSessionId !== bridgeSessionId) continue;
    if (task.status !== 'pending' && task.status !== 'running') continue;
    delete tasks[taskId];
    paused.push(task);
    changed = true;
  }
  if (changed) writeThenTaskMap(tasks);
  return paused;
}
