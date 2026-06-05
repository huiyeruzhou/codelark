import type { BridgeSession, BridgeStore } from '../../domain/index.js';
import type { InboundMessage, OutboundRichCard } from '../../domain/index.js';
import type { ThreadCardScope } from './callbacks.js';
import {
  createIntervalAutoTask,
  createAutoTask,
  deleteAutoTask,
  installAutoScriptSkill,
  listAutoTasks,
  resolveAutoScriptPath,
  setAutoTaskTimes,
  uninstallAutoScriptSkill,
  validateAutoScriptPath,
} from '../automation/auto-tasks.js';
import {
  buildAutoTasksCommandCard,
  buildAutoTasksCommandResponse,
} from './auto-presentation.js';
import { parseListIndex } from './aliases.js';
import {
  buildCommandFields,
  formatCommandDateTime,
  formatCommandPath,
  getSessionDisplayName,
} from './presentation.js';
import {
  getSessionActiveRuntime,
  getSessionClaudeSessionId,
  getSessionCodexThreadId,
  getSessionWorkingDirectory,
} from '../../domain/session-runtime.js';

export interface AutoCommandDeps {
  startAutoTask?(taskId: string): void;
  stopAutoTask?(taskId: string): void;
  selectedAutoTaskId?: string | null;
  selectedAutoTaskAction?: 'rm' | 'set1' | null;
}

export interface AutoCommandResult {
  response: string;
  richCard?: OutboundRichCard;
  threadTableCardScope?: ThreadCardScope;
}

export function handleAutoCommand(options: {
  msg: InboundMessage;
  args: string;
  session: BridgeSession | null;
  store: BridgeStore;
  deps: AutoCommandDeps;
  markdown: boolean;
  family?: 'auto' | 'auto-script';
}): AutoCommandResult {
  const family = options.family || 'auto';
  const parts = options.args.trim().split(/\s+/).filter(Boolean);
  const subcommand = (parts[0] || 'ls').toLowerCase();
  const subArgs = options.args.trim().slice((parts[0] || '').length).trim();

  if (subcommand === 'ls' || subcommand === 'list') {
    const session = requireCurrentSession(options.session);
    if (!session.ok) return { response: session.message };
    const tasks = listVisibleAutoTasks(options.msg);
    const sessionsById = buildAutoTaskSessionMap(tasks, options.store);
    const richCard = buildAutoTasksCommandCard(tasks, sessionsById, {
      selectedTaskId: options.deps.selectedAutoTaskId,
      channelType: options.msg.address.channelType,
      chatId: options.msg.address.chatId,
    }) || undefined;
    return {
      response: buildAutoTasksCommandResponse(tasks, sessionsById, options.markdown),
      richCard,
      threadTableCardScope: richCard ? 'auto' : undefined,
    };
  }

  if (family === 'auto' && !['ls', 'list', 'rm', 'remove', 'set', 'new', 'skill'].includes(subcommand)) {
    const session = requireCurrentSession(options.session);
    if (!session.ok) return { response: session.message };
    const parsed = parseIntervalAutoTaskArgs(options.args);
    if (!parsed.ok) return { response: parsed.message };
    const task = createIntervalAutoTask({
      bridgeSessionId: session.session.id,
      address: options.msg.address,
      prompt: parsed.prompt,
      intervalSeconds: parsed.intervalSeconds,
    });
    options.deps.startAutoTask?.(task.id);
    return {
      response: buildCommandFields(
        '已创建定时自动任务',
        [
          ['Session', getSessionDisplayName(session.session, getSessionWorkingDirectory(session.session))],
          ['触发时机', `每 ${task.intervalSeconds} s`],
          ['Prompt', task.prompt || '-'],
          ['创建时间', formatCommandDateTime(task.createdAt)],
        ],
        [
          '每次触发都会启动一个新的 bridge session 对话，不会复用当前聊天正在交流的 session。',
          '发送 `/auto ls` 查看任务，发送 `/auto rm <序号>` 删除任务。',
        ],
        options.markdown,
      ),
    };
  }

  if (family === 'auto' && subcommand === 'new') {
    return { response: '脚本自动化已迁移到 `/auto-script new <scriptpath> <times>`；定时 prompt 请使用 `/auto <时间> <prompt>`，例如 `/auto 10m 检查实验进度`。' };
  }

  if (family === 'auto' && subcommand === 'skill') {
    return { response: '自动脚本 skill 已迁移到 `/auto-script skill <install|uninstall>`。' };
  }

  if (subcommand === 'new') {
    const session = requireCurrentSession(options.session);
    if (!session.ok) return { response: session.message };
    const parsed = parseNewAutoTaskArgs(subArgs, getSessionWorkingDirectory(session.session) || '');
    if (!parsed.ok) return { response: parsed.message };
    const task = createAutoTask({
      bridgeSessionId: session.session.id,
      address: options.msg.address,
      scriptPath: parsed.scriptPath,
      times: parsed.times,
    });
    options.deps.startAutoTask?.(task.id);
    return {
      response: buildCommandFields(
        '已创建自动化任务',
        [
          ['Session', getSessionDisplayName(session.session, getSessionWorkingDirectory(session.session))],
          ['脚本路径', formatCommandPath(task.scriptPath || '')],
          ['创建时间', formatCommandDateTime(task.createdAt)],
          ['触发次数', `${task.times}`],
          ['session runtime-id', getAutoTaskRuntimeId(session.session)],
        ],
        [
          '任务已归属到当前 bridge session；后续即使当前聊天切换线程，也会继续恢复这个 session。',
          '发送 `/auto-script ls` 或 `/auto ls` 查看任务，发送 `/auto rm <序号>` 删除任务，发送 `/auto set <序号> <次数>` 重置触发次数。',
        ],
        options.markdown,
      ),
    };
  }

  if (subcommand === 'rm' || subcommand === 'remove') {
    const session = requireCurrentSession(options.session);
    if (!session.ok) return { response: session.message };
    const tasks = listVisibleAutoTasks(options.msg);
    const selectedTaskId = options.deps.selectedAutoTaskId?.trim() || '';
    const selected = selectedTaskId
      ? tasks.find((task) => task.id === selectedTaskId)
      : selectAutoTaskByIndex(subArgs, tasks);
    if (!selected) {
      return {
        response: selectedTaskId
          ? '选择的自动化任务已经不存在，请刷新 `/auto ls` 后重试。'
          : buildAutoRmUsage(subArgs, tasks.length),
      };
    }
    deleteAutoTask(selected.id);
    options.deps.stopAutoTask?.(selected.id);
    return {
      response: buildCommandFields(
        '已删除自动化任务',
        [
          ['任务', selected.kind === 'interval' ? selected.prompt || '-' : formatCommandPath(selected.scriptPath || '')],
          ['已触发', `${selected.triggeredCount}`],
          ['总次数', `${selected.times}`],
        ],
        ['任务记录已删除；如果后台循环正在等待脚本或 runtime 响应，会尽快中止。'],
        options.markdown,
      ),
    };
  }

  if (subcommand === 'set') {
    const session = requireCurrentSession(options.session);
    if (!session.ok) return { response: session.message };
    const tasks = listVisibleAutoTasks(options.msg);
    const selectedTaskId = options.deps.selectedAutoTaskId?.trim() || '';
    const parsed = options.deps.selectedAutoTaskAction === 'set1'
      ? { ok: true as const, indexRaw: '', times: 1 }
      : parseAutoSetArgs(subArgs);
    if (!parsed.ok) return { response: parsed.message };
    const selected = selectedTaskId
      ? tasks.find((task) => task.id === selectedTaskId)
      : selectAutoTaskByIndex(parsed.indexRaw, tasks);
    if (!selected) {
      return {
        response: selectedTaskId
          ? '选择的自动化任务已经不存在，请刷新 `/auto ls` 后重试。'
          : buildAutoSelectionUsage(parsed.indexRaw, tasks.length, 'set'),
      };
    }
    if (selected.kind === 'interval') {
      return { response: '定时 prompt 任务不支持 `/auto set`；请删除后用 `/auto <时间> <prompt>` 重新创建。' };
    }
    const updated = setAutoTaskTimes(selected.id, parsed.times);
    if (!updated) return { response: '自动化任务已经不存在，请刷新 `/auto ls` 后重试。' };
    if (parsed.times > 0) {
      options.deps.startAutoTask?.(updated.id);
    } else {
      options.deps.stopAutoTask?.(updated.id);
    }
    return {
      response: buildCommandFields(
        '已更新自动化任务次数',
        [
          ['任务', updated.kind === 'interval' ? updated.prompt || '-' : formatCommandPath(updated.scriptPath || '')],
          ['已触发', `${updated.triggeredCount}`],
          ['总次数', `${updated.times}`],
          ['状态', updated.status],
        ],
        [updated.times > 0 ? '已重置已触发次数，任务可重新触发。' : '次数为 0，任务已暂停且不会自动触发。'],
        options.markdown,
      ),
    };
  }

  if (subcommand === 'skill') {
    const action = (parts[1] || '').toLowerCase();
    if (action === 'install') {
      const result = installAutoScriptSkill();
      return {
        response: buildCommandFields(
          result.method === 'existing' ? '自动脚本 skill 已存在' : '已安装自动脚本 skill',
          [['目标目录', result.targetDir], ['处理方式', result.method]],
          [],
          options.markdown,
        ),
      };
    }
    if (action === 'uninstall') {
      const result = uninstallAutoScriptSkill();
      return {
        response: buildCommandFields(
          result.method === 'missing' ? '自动脚本 skill 未安装' : '已删除自动脚本 skill',
          [['目标目录', result.targetDir], ['处理方式', result.method]],
          [],
          options.markdown,
        ),
      };
    }
    return { response: `用法：/${family} skill <install|uninstall>。` };
  }

  return {
    response: family === 'auto-script'
      ? '用法：/auto-script ls、/auto-script new <scriptpath> <times>、/auto-script rm <序号>、/auto-script set <序号> <times>、/auto-script skill <install|uninstall>。'
      : '用法：/auto <时间> <prompt>、/auto ls、/auto rm <序号>、/auto set <序号> <times>。时间支持 s/m/h/d，默认 s。',
  };
}

function requireCurrentSession(session: BridgeSession | null): { ok: true; session: BridgeSession } | { ok: false; message: string } {
  if (session) return { ok: true, session };
  return {
    ok: false,
    message: '当前聊天还没有 bridge session。请先用 `/t 1` 接管本地会话，或用 `/new <目录>` 创建会话。',
  };
}

function getAutoTaskRuntimeId(session: BridgeSession): string {
  if (getSessionActiveRuntime(session) === 'claude') {
    return getSessionClaudeSessionId(session) || '-';
  }
  return getSessionCodexThreadId(session) || '-';
}

function parseNewAutoTaskArgs(raw: string, cwd: string): { ok: true; scriptPath: string; times: number } | { ok: false; message: string } {
  const trimmed = raw.trim();
  const match = trimmed.match(/^(.*)\s+(\d+)$/);
  if (!match) {
    return { ok: false, message: '用法：/auto-script new <scriptpath> <times>。例如：/auto-script new /abs/path/check-exp-progress.sh 5' };
  }
  const scriptPath = resolveAutoScriptPath(match[1], cwd);
  const times = Number(match[2]);
  if (!Number.isInteger(times) || times < 1) {
    return { ok: false, message: 'times 必须是大于 0 的整数。' };
  }
  const scriptValidation = validateAutoScriptPath(scriptPath);
  if (!scriptValidation.ok) return scriptValidation;
  return { ok: true, scriptPath, times };
}

function parseIntervalAutoTaskArgs(raw: string): { ok: true; intervalSeconds: number; prompt: string } | { ok: false; message: string } {
  const trimmed = raw.trim();
  const match = trimmed.match(/^(\d+)([smhd])?(?:\s+([\s\S]+))?$/i);
  if (!match) {
    return { ok: false, message: '用法：/auto <时间> <prompt>。时间支持 s/m/h/d，默认 s；例如 `/auto 10m 检查实验进度`。' };
  }
  const value = Number(match[1]);
  const unit = (match[2] || 's').toLowerCase();
  const prompt = (match[3] || '').trim();
  const multiplier = unit === 'd' ? 86400 : unit === 'h' ? 3600 : unit === 'm' ? 60 : 1;
  const intervalSeconds = value * multiplier;
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 1) {
    return { ok: false, message: '时间必须是大于 0 的整数，单位支持 s/m/h/d，默认 s。' };
  }
  if (!prompt) {
    return { ok: false, message: 'prompt 不能为空。例如：`/auto 10m 检查实验进度`。' };
  }
  return { ok: true, intervalSeconds, prompt };
}

function parseAutoSetArgs(raw: string): { ok: true; indexRaw: string; times: number } | { ok: false; message: string } {
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 2) {
    return { ok: false, message: '用法：/auto set <序号> <times>。例如：/auto set 1 3；times 为 0 表示暂停。' };
  }
  const times = Number(parts[1]);
  if (!Number.isInteger(times) || times < 0) {
    return { ok: false, message: 'times 必须是大于等于 0 的整数；0 表示暂停。' };
  }
  return { ok: true, indexRaw: parts[0], times };
}

function selectAutoTaskByIndex(raw: string, tasks: ReturnType<typeof listAutoTasks>) {
  const index = parseListIndex(raw.trim());
  if (index === null) return null;
  return tasks[index - 1] || null;
}

function buildAutoRmUsage(raw: string, taskCount: number): string {
  return buildAutoSelectionUsage(raw, taskCount, 'rm');
}

function buildAutoSelectionUsage(raw: string, taskCount: number, action: 'rm' | 'set'): string {
  const index = parseListIndex(raw.trim());
  const command = action === 'rm' ? 'rm <序号>' : 'set <序号> <times>';
  if (index !== null) {
    return `当前聊天只有 ${taskCount} 个自动化任务，没有第 ${index} 个。发送 \`/auto ls\` 查看列表。`;
  }
  return `用法：/auto ${command}。序号来自 \`/auto ls\`。`;
}

function listVisibleAutoTasks(msg: InboundMessage) {
  return listAutoTasks({
    channelType: msg.address.channelType,
    chatId: msg.address.chatId,
    includeCompleted: true,
  });
}

function buildAutoTaskSessionMap(tasks: ReturnType<typeof listAutoTasks>, store: BridgeStore): Map<string, BridgeSession> {
  const sessionsById = new Map<string, BridgeSession>();
  for (const task of tasks) {
    if (sessionsById.has(task.bridgeSessionId)) continue;
    const session = store.getSession(task.bridgeSessionId);
    if (session) sessionsById.set(task.bridgeSessionId, session);
  }
  return sessionsById;
}
