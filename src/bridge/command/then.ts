import type { BridgeSession, BridgeStore, InboundMessage, OutboundRichCard } from '../../domain/index.js';
import {
  createThenTask,
  deleteThenTask,
  listThenTasks,
  updateThenTask,
} from '../automation/then-tasks.js';
import type { ThenTask } from '../automation/then-tasks.js';
import type { ThenTaskCardAction, ThreadCardScope } from './callbacks.js';
import { parseListIndex } from './aliases.js';
import {
  buildCommandFields,
  formatCommandDateTime,
  getSessionDisplayName,
} from './presentation.js';
import {
  buildThenTaskEditFormCard,
  buildThenTaskFormCard,
  buildThenTasksCommandCard,
  buildThenTasksCommandResponse,
  THEN_FORM_PROMPT_ELEMENT_ID,
  THEN_FORM_PROMPT_FORM_NAME,
} from './presentation/then.js';
import {
  getSessionActiveRuntime,
  getSessionClaudeSessionId,
  getSessionCodexThreadId,
  getSessionKimiSessionId,
  getSessionWorkingDirectory,
} from '../../domain/session-runtime.js';

export interface ThenCommandDeps {
  startThenTask?(taskId: string): void;
  stopThenTask?(taskId: string): void;
  isSessionActive?(sessionId: string): boolean;
  selectedThenTaskId?: string | null;
  selectedThenTaskAction?: ThenTaskCardAction | null;
}

export interface ThenCommandResult {
  response: string;
  richCard?: OutboundRichCard;
  threadTableCardScope?: ThreadCardScope;
  startTaskId?: string;
}

export function handleThenCommand(options: {
  msg: InboundMessage;
  args: string;
  formValue?: Record<string, unknown> | null;
  session: BridgeSession | null;
  store: BridgeStore;
  deps: ThenCommandDeps;
  markdown: boolean;
}): ThenCommandResult {
  if (options.formValue) {
    const prompt = buildThenPromptFromFormValue(options.formValue);
    if (options.args.trim().startsWith('set-id ')) {
      return handleThenSetByIdCommand({ ...options, prompt });
    }
    return handleThenCreateCommand({ ...options, args: prompt });
  }

  const parts = options.args.trim().split(/\s+/).filter(Boolean);
  const subcommand = (parts[0] || '').toLowerCase();

  if (!subcommand || subcommand === 'ls' || subcommand === 'list') {
    const tasks = listVisibleThenTasks(options.msg);
    const sessionsById = buildThenTaskSessionMap(tasks, options.store);
    const richCard = buildThenTasksCommandCard(tasks, sessionsById, {
      selectedTaskId: options.deps.selectedThenTaskId,
      channelType: options.msg.address.channelType,
      chatId: options.msg.address.chatId,
    }) || undefined;
    return {
      response: buildThenTasksCommandResponse(tasks, sessionsById, options.markdown),
      richCard,
      threadTableCardScope: richCard ? 'then' : undefined,
    };
  }

  if (subcommand === 'set' || subcommand === 'edit' || subcommand === 'update') {
    const tasks = listVisibleThenTasks(options.msg);
    const rawRest = options.args.trim().slice(parts[0].length).trim();
    const parsed = parseThenSetArgs(rawRest, tasks);
    if (!parsed.ok) return { response: parsed.message };
    if (parsed.task.status === 'running') {
      return { response: '这个 /then 已经开始发送，不能再修改。可以用 `/then no <序号>` 中止当前发送。' };
    }
    const updated = updateThenTask(parsed.task.id, { prompt: parsed.prompt });
    return {
      response: buildCommandFields(
        '已更新 /then 后续输入',
        [
          ['序号', `${parsed.index}`],
          ['原 Prompt', parsed.task.prompt || '-'],
          ['新 Prompt', updated?.prompt || parsed.prompt],
          ['创建时间', formatCommandDateTime(parsed.task.createdAt)],
        ],
        ['触发时机会保持不变；发送 `/then` 查看最新待发送列表。'],
        options.markdown,
      ),
    };
  }

  if (subcommand === 'set-id') {
    return handleThenSetByIdCommand({
      ...options,
      prompt: options.args.trim().slice(parts[0].length).trim().split(/\s+/).slice(1).join(' '),
    });
  }

  if (subcommand === 'edit-form') {
    const tasks = listVisibleThenTasks(options.msg);
    const selectedTaskId = options.deps.selectedThenTaskId?.trim() || '';
    const selected = selectedTaskId ? tasks.find((task) => task.id === selectedTaskId) : null;
    if (!selected) {
      return {
        response: selectedTaskId
          ? '选择的 /then 已经不存在，请刷新 `/then` 后重试。'
          : '请先在 `/then` 卡片下拉列表中选择一条后续输入，再点击“修改”。',
      };
    }
    if (selected.status === 'running') {
      return { response: '这个 /then 已经开始发送，不能再修改。可以用 `/then no <序号>` 中止当前发送。' };
    }
    return {
      response: '修改 /then：如果没有看到表单，请直接发送 `/then set <序号> <prompt>`。',
      richCard: buildThenTaskEditFormCard(selected),
    };
  }

  if (subcommand === 'no' || subcommand === 'rm' || subcommand === 'remove' || subcommand === 'cancel') {
    const tasks = listVisibleThenTasks(options.msg);
    const selectedTaskId = options.deps.selectedThenTaskId?.trim() || '';
    const selected = selectedTaskId
      ? tasks.find((task) => task.id === selectedTaskId)
      : selectThenTaskByIndex(options.args.trim().slice(parts[0].length).trim(), tasks);
    if (!selected) {
      return {
        response: selectedTaskId
          ? '选择的 /then 已经不存在，请刷新 `/then` 后重试。'
          : buildThenNoUsage(options.args.trim().slice(parts[0].length).trim(), tasks.length),
      };
    }
    if (selected.status === 'running') {
      options.deps.stopThenTask?.(selected.id);
      return {
        response: buildCommandFields(
          '已中止 /then 后续输入',
          [
            ['Prompt', selected.prompt || '-'],
            ['触发时间', formatCommandDateTime(selected.triggeredAt)],
          ],
          ['已请求停止当前发送；如果 runtime 已经结束，可能只记录取消状态。'],
          options.markdown,
        ),
      };
    }
    deleteThenTask(selected.id);
    return {
      response: buildCommandFields(
        '已取消 /then 后续输入',
        [
          ['Prompt', selected.prompt || '-'],
          ['创建时间', formatCommandDateTime(selected.createdAt)],
        ],
        ['任务记录已删除；不会再发送给 agent。'],
        options.markdown,
      ),
    };
  }

  return handleThenCreateCommand(options);
}

export function buildThenFormCommandResult(defaultPrompt = ''): ThenCommandResult {
  return {
    response: '新建 /then：如果没有看到表单，请直接发送 `/then <prompt>`。',
    richCard: buildThenTaskFormCard(defaultPrompt),
  };
}

function handleThenCreateCommand(options: {
  msg: InboundMessage;
  args: string;
  session: BridgeSession | null;
  store: BridgeStore;
  deps: ThenCommandDeps;
  markdown: boolean;
}): ThenCommandResult {
  const session = requireCurrentSession(options.session);
  if (!session.ok) return { response: session.message };

  const prompt = options.args.trim();
  if (!prompt) {
    return {
      response: '用法：/then <prompt>。例如：`/then 总结刚才的执行结果`。发送 `/then` 查看待发送列表。',
    };
  }

  const task = createThenTask({
    bridgeSessionId: session.session.id,
    address: options.msg.address,
    prompt,
  });
  const active = options.deps.isSessionActive?.(session.session.id) === true;
  return {
    response: buildCommandFields(
      '已创建 /then 后续输入',
      [
        ['Session', getSessionDisplayName(session.session, getSessionWorkingDirectory(session.session))],
        ['触发时机', active ? '当前任务 completed/interrupted 后' : '当前会话空闲或已结束后尽快发送'],
        ['Prompt', task.prompt || '-'],
        ['创建时间', formatCommandDateTime(task.createdAt)],
        ['session runtime-id', getThenTaskRuntimeId(session.session)],
      ],
      [
        '触发后会复用创建时绑定的当前 bridge session，并按普通用户输入走当前 runtime provider。',
        '发送 `/then` 查看待发送列表，发送 `/then no <序号>` 取消尚未触发的后续输入。',
      ],
      options.markdown,
    ),
    startTaskId: task.id,
  };
}

function handleThenSetByIdCommand(options: {
  msg: InboundMessage;
  args: string;
  prompt: string;
  session: BridgeSession | null;
  store: BridgeStore;
  deps: ThenCommandDeps;
  markdown: boolean;
}): ThenCommandResult {
  const parts = options.args.trim().split(/\s+/).filter(Boolean);
  const taskId = parts[1]?.trim() || '';
  if (!taskId) {
    return { response: '这个修改表单缺少 /then 任务 id，请刷新 `/then` 后重试。' };
  }
  const task = listVisibleThenTasks(options.msg).find((candidate) => candidate.id === taskId);
  if (!task) {
    return { response: '这条 /then 已经不存在，请刷新 `/then` 后重试。' };
  }
  if (task.status === 'running') {
    return { response: '这个 /then 已经开始发送，不能再修改。可以用 `/then no <序号>` 中止当前发送。' };
  }
  const prompt = options.prompt.trim();
  if (!prompt) {
    return { response: 'prompt 不能为空。' };
  }
  const updated = updateThenTask(task.id, { prompt });
  return {
    response: buildCommandFields(
      '已更新 /then 后续输入',
      [
        ['原 Prompt', task.prompt || '-'],
        ['新 Prompt', updated?.prompt || prompt],
        ['创建时间', formatCommandDateTime(task.createdAt)],
      ],
      ['触发时机会保持不变；发送 `/then` 查看最新待发送列表。'],
      options.markdown,
    ),
  };
}

function buildThenPromptFromFormValue(formValue: Record<string, unknown>): string {
  return normalizeFormString(
    formValue[THEN_FORM_PROMPT_FORM_NAME]
    ?? formValue[THEN_FORM_PROMPT_ELEMENT_ID]
    ?? formValue.prompt,
  );
}

function normalizeFormString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function requireCurrentSession(session: BridgeSession | null): { ok: true; session: BridgeSession } | { ok: false; message: string } {
  if (session) return { ok: true, session };
  return {
    ok: false,
    message: '当前聊天还没有 bridge session。请先用 `/t 1` 接管本地会话，或用 `/new <目录>` 创建会话。',
  };
}

function selectThenTaskByIndex(raw: string, tasks: ThenTask[]): ThenTask | null {
  const index = parseListIndex(raw.trim());
  if (index === null) return null;
  return tasks[index - 1] || null;
}

function parseThenSetArgs(raw: string, tasks: ThenTask[]): { ok: true; index: number; task: ThenTask; prompt: string } | { ok: false; message: string } {
  const match = raw.match(/^(\d+)\s+([\s\S]+)$/);
  if (!match) {
    return { ok: false, message: '用法：/then set <序号> <prompt>。例如：`/then set 1 总结刚才的执行结果`。' };
  }
  const index = parseListIndex(match[1]);
  if (index === null) {
    return { ok: false, message: '序号必须是大于 0 的整数，来自 `/then` 列表。' };
  }
  const task = tasks[index - 1];
  if (!task) {
    return { ok: false, message: `当前聊天只有 ${tasks.length} 个待发送 /then，没有第 ${index} 个。发送 \`/then\` 查看列表。` };
  }
  const prompt = match[2].trim();
  if (!prompt) {
    return { ok: false, message: 'prompt 不能为空。例如：`/then set 1 总结刚才的执行结果`。' };
  }
  return { ok: true, index, task, prompt };
}

function buildThenNoUsage(raw: string, taskCount: number): string {
  const index = parseListIndex(raw.trim());
  if (index !== null) {
    return `当前聊天只有 ${taskCount} 个待发送 /then，没有第 ${index} 个。发送 \`/then\` 查看列表。`;
  }
  return '用法：/then no <序号>。序号来自 `/then`。';
}

function listVisibleThenTasks(msg: InboundMessage): ThenTask[] {
  return listThenTasks({
    channelType: msg.address.channelType,
    chatId: msg.address.chatId,
    statuses: ['pending', 'running'],
  });
}

function buildThenTaskSessionMap(tasks: ThenTask[], store: BridgeStore): Map<string, BridgeSession> {
  const sessionsById = new Map<string, BridgeSession>();
  for (const task of tasks) {
    if (sessionsById.has(task.bridgeSessionId)) continue;
    const session = store.getSession(task.bridgeSessionId);
    if (session) sessionsById.set(task.bridgeSessionId, session);
  }
  return sessionsById;
}

function getThenTaskRuntimeId(session: BridgeSession): string {
  if (getSessionActiveRuntime(session) === 'claude') {
    return getSessionClaudeSessionId(session) || '-';
  }
  if (getSessionActiveRuntime(session) === 'kimi') {
    return getSessionKimiSessionId(session) || '-';
  }
  return getSessionCodexThreadId(session) || '-';
}
