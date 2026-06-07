import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { CODELARK_HOME } from '../../configuration/paths.js';
import type { ChannelAddress } from '../../domain/channel.js';
import { getCodexHome } from '../../runtime/codex/session-index/paths.js';

const DATA_DIR = path.join(CODELARK_HOME, 'data');
const AUTO_TASKS_PATH = path.join(DATA_DIR, 'auto-tasks.json');
export const AUTO_SCRIPT_SKILL_NAME = 'codelark-auto';
const OWNED_AUTO_SCRIPT_SKILL_NAMES = new Set([AUTO_SCRIPT_SKILL_NAME]);

export type AutoTaskStatus = 'running' | 'completed' | 'failed';

export interface AutoTask {
  id: string;
  kind?: 'script' | 'interval';
  bridgeSessionId: string;
  channelType: string;
  channelProvider?: string;
  channelAlias?: string;
  chatId: string;
  chatUserId?: string;
  chatDisplayName?: string;
  scriptPath?: string;
  prompt?: string;
  intervalSeconds?: number;
  createdAt: string;
  updatedAt: string;
  triggeredCount: number;
  lastTriggeredAt?: string;
  times: number;
  status: AutoTaskStatus;
  lastError?: string;
}

export interface CreateAutoTaskInput {
  bridgeSessionId: string;
  address: ChannelAddress;
  scriptPath: string;
  times: number;
}

export interface CreateIntervalAutoTaskInput {
  bridgeSessionId: string;
  address: ChannelAddress;
  prompt: string;
  intervalSeconds: number;
}

export interface AutoSkillOperationResult {
  targetDir: string;
  method: 'copy' | 'removed' | 'missing' | 'existing';
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

function readAutoTaskMap(): Record<string, AutoTask> {
  try {
    const parsed = JSON.parse(fs.readFileSync(AUTO_TASKS_PATH, 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, AutoTask>;
  } catch {
    return {};
  }
}

function writeAutoTaskMap(tasks: Record<string, AutoTask>): void {
  atomicWriteJson(AUTO_TASKS_PATH, tasks);
}

export function listAutoTasks(options: {
  bridgeSessionId?: string;
  channelType?: string;
  chatId?: string;
  includeCompleted?: boolean;
} = {}): AutoTask[] {
  const tasks = Object.values(readAutoTaskMap())
    .filter((task) => !options.bridgeSessionId || task.bridgeSessionId === options.bridgeSessionId)
    .filter((task) => !options.channelType || task.channelType === options.channelType)
    .filter((task) => !options.chatId || task.chatId === options.chatId)
    .filter((task) => options.includeCompleted === true || task.status !== 'completed')
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  return tasks;
}

export function getAutoTask(taskId: string): AutoTask | null {
  return readAutoTaskMap()[taskId] || null;
}

export function createAutoTask(input: CreateAutoTaskInput): AutoTask {
  const tasks = readAutoTaskMap();
  const timestamp = nowIso();
  const task: AutoTask = {
    id: crypto.randomUUID(),
    kind: 'script',
    bridgeSessionId: input.bridgeSessionId,
    channelType: input.address.channelType,
    channelProvider: input.address.channelProvider,
    channelAlias: input.address.channelAlias,
    chatId: input.address.chatId,
    chatUserId: input.address.userId,
    chatDisplayName: input.address.displayName,
    scriptPath: input.scriptPath,
    createdAt: timestamp,
    updatedAt: timestamp,
    triggeredCount: 0,
    times: input.times,
    status: 'running',
  };
  tasks[task.id] = task;
  writeAutoTaskMap(tasks);
  return task;
}

export function createIntervalAutoTask(input: CreateIntervalAutoTaskInput): AutoTask {
  const tasks = readAutoTaskMap();
  const timestamp = nowIso();
  const task: AutoTask = {
    id: crypto.randomUUID(),
    kind: 'interval',
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
    times: 0,
    status: 'running',
  };
  tasks[task.id] = task;
  writeAutoTaskMap(tasks);
  return task;
}

export function updateAutoTask(taskId: string, updates: Partial<AutoTask>): AutoTask | null {
  const tasks = readAutoTaskMap();
  const existing = tasks[taskId];
  if (!existing) return null;
  const next: AutoTask = {
    ...existing,
    ...updates,
    id: existing.id,
    updatedAt: nowIso(),
  };
  tasks[taskId] = next;
  writeAutoTaskMap(tasks);
  return next;
}

export function deleteAutoTask(taskId: string): AutoTask | null {
  const tasks = readAutoTaskMap();
  const existing = tasks[taskId];
  if (!existing) return null;
  delete tasks[taskId];
  writeAutoTaskMap(tasks);
  return existing;
}

export function setAutoTaskTimes(taskId: string, times: number): AutoTask | null {
  return updateAutoTask(taskId, {
    times,
    triggeredCount: 0,
    lastTriggeredAt: undefined,
    status: times > 0 ? 'running' : 'completed',
    lastError: undefined,
  });
}

export function pauseAutoTasksForSession(bridgeSessionId: string): AutoTask[] {
  const tasks = readAutoTaskMap();
  const updated: AutoTask[] = [];
  let changed = false;
  for (const [taskId, task] of Object.entries(tasks)) {
    if (task.bridgeSessionId !== bridgeSessionId) continue;
    const next: AutoTask = {
      ...task,
      times: 0,
      triggeredCount: 0,
      status: 'completed',
      updatedAt: nowIso(),
    };
    tasks[taskId] = next;
    updated.push(next);
    changed = true;
  }
  if (changed) writeAutoTaskMap(tasks);
  return updated;
}

export function resolveAutoScriptPath(rawPath: string, cwd: string): string {
  const trimmed = stripMatchingQuotes(rawPath.trim());
  if (!trimmed) return '';
  const expanded = trimmed === '~'
    ? os.homedir()
    : trimmed.startsWith('~/') || trimmed.startsWith('~\\')
      ? path.join(os.homedir(), trimmed.slice(2))
      : trimmed;
  return path.resolve(path.isAbsolute(expanded) ? expanded : path.join(cwd || process.cwd(), expanded));
}

export function validateAutoScriptPath(scriptPath: string): { ok: true } | { ok: false; message: string } {
  if (!scriptPath) return { ok: false, message: '脚本路径不能为空。' };
  const codexHome = path.resolve(getCodexHome());
  const resolvedScriptPath = path.resolve(scriptPath);
  const relativeToCodexHome = path.relative(codexHome, resolvedScriptPath);
  if (
    relativeToCodexHome === ''
    || relativeToCodexHome.startsWith('..')
    || path.isAbsolute(relativeToCodexHome)
  ) {
    return {
      ok: false,
      message: `自动化脚本必须位于 Codex home 下：${path.join(codexHome, 'auto-scripts')}`,
    };
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolvedScriptPath);
  } catch {
    return { ok: false, message: `脚本不存在：${resolvedScriptPath}` };
  }
  if (!stat.isFile()) {
    return { ok: false, message: `脚本路径不是文件：${resolvedScriptPath}` };
  }
  return { ok: true };
}

export function installAutoScriptSkill(): AutoSkillOperationResult {
  const sourceDir = resolveAutoSkillSourceDir();
  const targetDir = path.join(getCodexHome(), 'skills', AUTO_SCRIPT_SKILL_NAME);
  if (fs.existsSync(path.join(targetDir, 'SKILL.md'))) {
    return { targetDir, method: 'existing' };
  }
  ensureDir(path.dirname(targetDir));
  fs.cpSync(sourceDir, targetDir, { recursive: true });
  return { targetDir, method: 'copy' };
}

export function uninstallAutoScriptSkill(): AutoSkillOperationResult {
  const skillsDir = path.join(getCodexHome(), 'skills');
  const targets = [AUTO_SCRIPT_SKILL_NAME]
    .map((name) => path.join(skillsDir, name))
    .filter((targetDir) => fs.existsSync(path.join(targetDir, 'SKILL.md')));
  if (targets.length === 0) {
    return { targetDir: path.join(skillsDir, AUTO_SCRIPT_SKILL_NAME), method: 'missing' };
  }
  for (const targetDir of targets) {
    const skillPath = path.join(targetDir, 'SKILL.md');
    const raw = fs.readFileSync(skillPath, 'utf-8');
    const match = raw.match(/^name:\s*(\S+)\s*$/m);
    const skillName = match?.[1] || '';
    if (!OWNED_AUTO_SCRIPT_SKILL_NAMES.has(skillName)) {
      throw new Error(`拒绝删除非 CodeLark 自动脚本 skill：${targetDir}`);
    }
  }
  for (const targetDir of targets) {
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
  return { targetDir: targets.join(', '), method: 'removed' };
}

function resolveAutoSkillSourceDir(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    ...[AUTO_SCRIPT_SKILL_NAME].flatMap((name) => [
      path.join(path.resolve(moduleDir, '..'), 'skills', name),
      path.join(path.resolve(moduleDir, '..', '..', '..'), 'skills', name),
      path.join(process.cwd(), 'skills', name),
    ]),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'SKILL.md'))) {
      return candidate;
    }
  }
  throw new Error(`找不到 ${AUTO_SCRIPT_SKILL_NAME} skill 源目录。`);
}

function stripMatchingQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
