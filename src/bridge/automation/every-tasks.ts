import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { CODELARK_HOME } from '../../configuration/paths.js';
import type { ChannelAddress } from '../../domain/channel.js';

const DATA_DIR = path.join(CODELARK_HOME, 'data');
const EVERY_TASKS_PATH = path.join(DATA_DIR, 'every-tasks.json');

export type EveryTaskStatus = 'running' | 'failed';

export interface EveryTask {
  id: string;
  bridgeSessionId: string;
  channelType: string;
  channelProvider?: string;
  channelAlias?: string;
  chatId: string;
  chatUserId?: string;
  chatDisplayName?: string;
  prompt: string;
  intervalSeconds: number;
  createdAt: string;
  updatedAt: string;
  triggeredCount: number;
  lastTriggeredAt?: string;
  status: EveryTaskStatus;
  lastError?: string;
}

export interface CreateEveryTaskInput {
  bridgeSessionId: string;
  address: ChannelAddress;
  prompt: string;
  intervalSeconds: number;
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

function readEveryTaskMap(): Record<string, EveryTask> {
  try {
    const parsed = JSON.parse(fs.readFileSync(EVERY_TASKS_PATH, 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, EveryTask>;
  } catch {
    return {};
  }
}

function writeEveryTaskMap(tasks: Record<string, EveryTask>): void {
  atomicWriteJson(EVERY_TASKS_PATH, tasks);
}

export function listEveryTasks(options: {
  bridgeSessionId?: string;
  channelType?: string;
  chatId?: string;
} = {}): EveryTask[] {
  return Object.values(readEveryTaskMap())
    .filter((task) => !options.bridgeSessionId || task.bridgeSessionId === options.bridgeSessionId)
    .filter((task) => !options.channelType || task.channelType === options.channelType)
    .filter((task) => !options.chatId || task.chatId === options.chatId)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

export function getEveryTask(taskId: string): EveryTask | null {
  return readEveryTaskMap()[taskId] || null;
}

export function createEveryTask(input: CreateEveryTaskInput): EveryTask {
  const tasks = readEveryTaskMap();
  const timestamp = nowIso();
  const task: EveryTask = {
    id: crypto.randomUUID(),
    bridgeSessionId: input.bridgeSessionId,
    channelType: input.address.channelType,
    channelProvider: input.address.channelProvider,
    channelAlias: input.address.channelAlias,
    chatId: input.address.chatId,
    chatUserId: input.address.userId,
    chatDisplayName: input.address.displayName,
    prompt: input.prompt,
    intervalSeconds: input.intervalSeconds,
    createdAt: timestamp,
    updatedAt: timestamp,
    triggeredCount: 0,
    status: 'running',
  };
  tasks[task.id] = task;
  writeEveryTaskMap(tasks);
  return task;
}

export function updateEveryTask(taskId: string, updates: Partial<EveryTask>): EveryTask | null {
  const tasks = readEveryTaskMap();
  const existing = tasks[taskId];
  if (!existing) return null;
  const next: EveryTask = {
    ...existing,
    ...updates,
    id: existing.id,
    updatedAt: nowIso(),
  };
  tasks[taskId] = next;
  writeEveryTaskMap(tasks);
  return next;
}

export function deleteEveryTask(taskId: string): EveryTask | null {
  const tasks = readEveryTaskMap();
  const existing = tasks[taskId];
  if (!existing) return null;
  delete tasks[taskId];
  writeEveryTaskMap(tasks);
  return existing;
}

export function pauseEveryTasksForSession(bridgeSessionId: string): EveryTask[] {
  const tasks = readEveryTaskMap();
  const paused: EveryTask[] = [];
  let changed = false;
  for (const [taskId, task] of Object.entries(tasks)) {
    if (task.bridgeSessionId !== bridgeSessionId) continue;
    delete tasks[taskId];
    paused.push(task);
    changed = true;
  }
  if (changed) writeEveryTaskMap(tasks);
  return paused;
}
