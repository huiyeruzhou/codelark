import type { BridgeSession, BridgeStore, InboundMessage, OutboundRichCard } from '../../domain/index.js';
import {
  createEveryTask,
  deleteEveryTask,
  listEveryTasks,
} from '../automation/every-tasks.js';
import type { EveryTask } from '../automation/every-tasks.js';
import type { ThreadCardScope } from './callbacks.js';
import { parseListIndex } from './aliases.js';
import {
  buildCommandFields,
  formatCommandDateTime,
  getSessionDisplayName,
} from './presentation.js';
import {
  buildEveryTasksCommandCard,
  buildEveryTasksCommandResponse,
  EVERY_FORM_INTERVAL_ELEMENT_ID,
  EVERY_FORM_INTERVAL_FORM_NAME,
  EVERY_FORM_PROMPT_ELEMENT_ID,
  EVERY_FORM_PROMPT_FORM_NAME,
} from './presentation/every.js';
import {
  getSessionClaudeSessionId,
  getSessionCodexThreadId,
  getSessionActiveRuntime,
  getSessionWorkingDirectory,
} from '../../domain/session-runtime.js';

export interface EveryCommandDeps {
  startEveryTask?(taskId: string): void;
  stopEveryTask?(taskId: string): void;
  selectedEveryTaskId?: string | null;
  selectedEveryTaskAction?: 'no' | null;
}

export interface EveryCommandResult {
  response: string;
  richCard?: OutboundRichCard;
  threadTableCardScope?: ThreadCardScope;
}

export function handleEveryCommand(options: {
  msg: InboundMessage;
  args: string;
  formValue?: Record<string, unknown> | null;
  session: BridgeSession | null;
  store: BridgeStore;
  deps: EveryCommandDeps;
  markdown: boolean;
}): EveryCommandResult {
  if (options.formValue) {
    return handleEveryCreateCommand({
      ...options,
      args: buildEveryArgsFromFormValue(options.formValue),
    });
  }

  const parts = options.args.trim().split(/\s+/).filter(Boolean);
  const subcommand = (parts[0] || '').toLowerCase();

  if (!subcommand || subcommand === 'ls' || subcommand === 'list') {
    const tasks = listVisibleEveryTasks(options.msg);
    const sessionsById = buildEveryTaskSessionMap(tasks, options.store);
    const richCard = buildEveryTasksCommandCard(tasks, sessionsById, {
      selectedTaskId: options.deps.selectedEveryTaskId,
      channelType: options.msg.address.channelType,
      chatId: options.msg.address.chatId,
    }) || undefined;
    return {
      response: buildEveryTasksCommandResponse(tasks, sessionsById, options.markdown),
      richCard,
      threadTableCardScope: richCard ? 'every' : undefined,
    };
  }

  if (subcommand === 'no' || subcommand === 'rm' || subcommand === 'remove' || subcommand === 'cancel') {
    const tasks = listVisibleEveryTasks(options.msg);
    const selectedTaskId = options.deps.selectedEveryTaskId?.trim() || '';
    const selected = selectedTaskId
      ? tasks.find((task) => task.id === selectedTaskId)
      : selectEveryTaskByIndex(options.args.trim().slice(parts[0].length).trim(), tasks);
    if (!selected) {
      return {
        response: selectedTaskId
          ? '选择的 /every 已经不存在，请刷新 `/every` 后重试。'
          : buildEveryNoUsage(options.args.trim().slice(parts[0].length).trim(), tasks.length),
      };
    }
    deleteEveryTask(selected.id);
    options.deps.stopEveryTask?.(selected.id);
    return {
      response: buildCommandFields(
        '已取消 /every 定时输入',
        [
          ['间隔', `每 ${selected.intervalSeconds} s`],
          ['Prompt', selected.prompt || '-'],
          ['已触发', `${selected.triggeredCount}`],
        ],
        ['任务记录已删除；如果后台触发正在等待 runtime 响应，会尽快中止。'],
        options.markdown,
      ),
    };
  }

  return handleEveryCreateCommand(options);
}

function handleEveryCreateCommand(options: {
  msg: InboundMessage;
  args: string;
  session: BridgeSession | null;
  store: BridgeStore;
  deps: EveryCommandDeps;
  markdown: boolean;
}): EveryCommandResult {
  const session = requireCurrentSession(options.session);
  if (!session.ok) return { response: session.message };

  const parsed = parseEveryCreateArgs(options.args);
  if (!parsed.ok) return { response: parsed.message };
  const task = createEveryTask({
    bridgeSessionId: session.session.id,
    address: options.msg.address,
    prompt: parsed.prompt,
    intervalSeconds: parsed.intervalSeconds,
  });
  options.deps.startEveryTask?.(task.id);
  return {
    response: buildCommandFields(
      '已创建 /every 定时输入',
      [
        ['Session', getSessionDisplayName(session.session, getSessionWorkingDirectory(session.session))],
        ['触发时机', `每 ${task.intervalSeconds} s`],
        ['Prompt', task.prompt || '-'],
        ['创建时间', formatCommandDateTime(task.createdAt)],
        ['session runtime-id', getEveryTaskRuntimeId(session.session)],
      ],
      [
        '每次触发都会复用创建时绑定的当前 bridge session，并按普通用户输入走当前 runtime provider。',
        '发送 `/every` 查看任务，发送 `/every no <序号>` 取消任务。',
      ],
      options.markdown,
    ),
  };
}

function buildEveryArgsFromFormValue(formValue: Record<string, unknown>): string {
  const interval = normalizeFormString(
    formValue[EVERY_FORM_INTERVAL_FORM_NAME]
    ?? formValue[EVERY_FORM_INTERVAL_ELEMENT_ID]
    ?? formValue.interval,
  );
  const prompt = normalizeFormString(
    formValue[EVERY_FORM_PROMPT_FORM_NAME]
    ?? formValue[EVERY_FORM_PROMPT_ELEMENT_ID]
    ?? formValue.prompt,
  );
  return [interval, prompt].filter(Boolean).join(' ');
}

function requireCurrentSession(session: BridgeSession | null): { ok: true; session: BridgeSession } | { ok: false; message: string } {
  if (session) return { ok: true, session };
  return {
    ok: false,
    message: '当前聊天还没有 bridge session。请先用 `/t 1` 接管本地会话，或用 `/new <目录>` 创建会话。',
  };
}

function parseEveryCreateArgs(raw: string): { ok: true; intervalSeconds: number; prompt: string } | { ok: false; message: string } {
  const trimmed = raw.trim();
  const match = trimmed.match(/^(\d+)([smhd])\s+([\s\S]+)$/i);
  if (!match) {
    return { ok: false, message: '用法：/every <数字><s|m|h|d> <prompt>。例如：`/every 10m 检查实验进度`。' };
  }
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  const prompt = match[3].trim();
  const multiplier = unit === 'd' ? 86400 : unit === 'h' ? 3600 : unit === 'm' ? 60 : 1;
  const intervalSeconds = value * multiplier;
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 1) {
    return { ok: false, message: '时间必须是大于 0 的整数，单位支持 s/m/h/d。' };
  }
  if (!prompt) {
    return { ok: false, message: 'prompt 不能为空。例如：`/every 10m 检查实验进度`。' };
  }
  return { ok: true, intervalSeconds, prompt };
}

function normalizeFormString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function selectEveryTaskByIndex(raw: string, tasks: EveryTask[]): EveryTask | null {
  const index = parseListIndex(raw.trim());
  if (index === null) return null;
  return tasks[index - 1] || null;
}

function buildEveryNoUsage(raw: string, taskCount: number): string {
  const index = parseListIndex(raw.trim());
  if (index !== null) {
    return `当前聊天只有 ${taskCount} 个 /every，没有第 ${index} 个。发送 \`/every\` 查看列表。`;
  }
  return '用法：/every no <序号>。序号来自 `/every`。';
}

function listVisibleEveryTasks(msg: InboundMessage): EveryTask[] {
  return listEveryTasks({
    channelType: msg.address.channelType,
    chatId: msg.address.chatId,
  });
}

function buildEveryTaskSessionMap(tasks: EveryTask[], store: BridgeStore): Map<string, BridgeSession> {
  const sessionsById = new Map<string, BridgeSession>();
  for (const task of tasks) {
    if (sessionsById.has(task.bridgeSessionId)) continue;
    const session = store.getSession(task.bridgeSessionId);
    if (session) sessionsById.set(task.bridgeSessionId, session);
  }
  return sessionsById;
}

function getEveryTaskRuntimeId(session: BridgeSession): string {
  if (getSessionActiveRuntime(session) === 'claude') {
    return getSessionClaudeSessionId(session) || '-';
  }
  return getSessionCodexThreadId(session) || '-';
}
