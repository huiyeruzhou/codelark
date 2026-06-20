import type { BridgeSession, OutboundCardActionButton, OutboundRichCard } from '../../../domain/index.js';
import type { ThenTask } from '../../automation/then-tasks.js';
import { buildFencedCodeBlock } from '../../../shared/markdown/fence.js';
import {
  formatCommandDateTime,
  getSessionDisplayName,
} from './index.js';
import {
  getSessionActiveRuntime,
  getSessionClaudeSessionId,
  getSessionCodexThreadId,
  getSessionWorkingDirectory,
} from '../../../domain/session-runtime.js';
import {
  buildCommandCallbackData,
  buildThenTaskActionCallbackData,
  buildThreadCardUpdateKey,
  THEN_TASK_FORM_COMMAND,
  THEN_TASK_SELECT_CALLBACK_PREFIX,
} from '../callbacks.js';

const THEN_TASK_CARD_MAX_ITEMS = 30;
const THEN_TASK_ACTIONS_PER_ROW = 3;
const THEN_PROMPT_INLINE_LIMIT = 240;
const THEN_PROMPT_CARD_LIMIT = 1800;
const THEN_PROMPT_TEXT_LIMIT = 900;
export const THEN_FORM_PROMPT_ELEMENT_ID = 'clk_then_prompt';
export const THEN_FORM_PROMPT_FORM_NAME = 'then_prompt';

interface ThenTaskCommandRow {
  index: string;
  sessionTitle: string;
  status: string;
  prompt: string;
  createdAt: string;
  runtimeId: string;
  command: string;
}

type ThenTaskCommandColumnKey = keyof ThenTaskCommandRow;

interface ThenTaskCommandColumn {
  key: ThenTaskCommandColumnKey;
  name: string;
  displayName: string;
  width: string;
  dataType?: 'text' | 'lark_md' | 'markdown' | 'number';
  horizontalAlign?: 'left' | 'center' | 'right';
}

const THEN_TASK_COLUMNS: ThenTaskCommandColumn[] = [
  { key: 'index', name: 'index', displayName: '#', width: '80px', dataType: 'lark_md', horizontalAlign: 'center' },
  { key: 'sessionTitle', name: 'session_title', displayName: 'Session', width: '220px', dataType: 'lark_md' },
  { key: 'status', name: 'status', displayName: '状态', width: '100px', dataType: 'lark_md', horizontalAlign: 'center' },
  { key: 'prompt', name: 'prompt', displayName: 'Prompt', width: '520px', dataType: 'lark_md' },
  { key: 'createdAt', name: 'created_at', displayName: '创建时间', width: '180px', dataType: 'lark_md' },
  { key: 'runtimeId', name: 'runtime_id', displayName: 'session runtime-id', width: '260px', dataType: 'lark_md' },
  { key: 'command', name: 'command', displayName: '取消命令', width: '160px', dataType: 'lark_md' },
];

export function buildThenTaskCommandRows(
  tasks: ThenTask[],
  sessionsById: Map<string, BridgeSession>,
): ThenTaskCommandRow[] {
  return tasks.map((task, index) => ({
    index: `${index + 1}`,
    sessionTitle: formatThenTaskSessionTitle(task, sessionsById.get(task.bridgeSessionId)),
    status: task.status === 'running' ? '发送中' : '等待',
    prompt: formatInlinePrompt(task.prompt),
    createdAt: formatCommandDateTime(task.createdAt),
    runtimeId: getThenTaskRuntimeId(sessionsById.get(task.bridgeSessionId)),
    command: `/then no ${index + 1}`,
  }));
}

export function buildThenTasksCommandResponse(
  tasks: ThenTask[],
  sessionsById: Map<string, BridgeSession>,
  markdown: boolean,
): string {
  if (tasks.length === 0) {
    return [
      '当前聊天没有待发送的 /then 后续输入。',
      '',
      '`/then <prompt>` 会在当前会话转为 completed 或 interrupted 后，把 prompt 作为普通用户输入发送给 agent。',
      '`/then no <序号>` 取消尚未触发的后续输入；序号来自 `/then` 列表。',
    ].join('\n');
  }

  const title = `当前聊天 /then 后续输入（${tasks.length}）`;
  const rows = buildThenTaskCommandRows(tasks, sessionsById);
  const table = buildThenTaskCommandTableText(rows);
  const promptBlocks = tasks.map((task, index) => formatPromptBlock(index + 1, task.prompt, markdown));
  const footer = [
    '`/then <prompt>` 添加后续输入；当前任务 completed/interrupted 后会按创建时间发送。',
    '`/then no <序号>` 删除尚未触发的后续输入；发送中的输入会尝试中止当前发送。',
  ];

  if (markdown) {
    return [
      `**${title}**`,
      '',
      buildFencedCodeBlock(table, 'text'),
      '',
      '**即将发送的 prompt**',
      '',
      ...promptBlocks,
      '',
      ...footer.map((line) => `- ${line}`),
    ].join('\n').trim();
  }

  return [
    title,
    '',
    table,
    '',
    '即将发送的 prompt',
    '',
    ...promptBlocks,
    '',
    ...footer,
  ].join('\n').trim();
}

export function buildThenTasksCommandCard(
  tasks: ThenTask[],
  sessionsById: Map<string, BridgeSession>,
  options: {
    selectedTaskId?: string | null;
    channelType?: string;
    chatId?: string;
  } = {},
): OutboundRichCard | null {
  if (tasks.length > THEN_TASK_CARD_MAX_ITEMS) return null;
  const rows = buildThenTaskCommandRows(tasks, sessionsById);
  const selectedCallbackData = options.selectedTaskId
    ? `${THEN_TASK_SELECT_CALLBACK_PREFIX}${encodeURIComponent(options.selectedTaskId)}`
    : undefined;
  const longPromptPanels = tasks
    .map((task, index) => buildLongPromptPanel(task, index + 1))
    .filter((panel): panel is NonNullable<OutboundRichCard['panels']>[number] => Boolean(panel));

  const card: OutboundRichCard = {
    title: `当前聊天 /then 后续输入（${tasks.length}）`,
    subtitle: '这些 prompt 会在绑定会话转为 completed 或 interrupted 后，按创建时间发送给 agent。',
    template: 'blue',
    table: tasks.length > 0
      ? {
          pageSize: 10,
          rowHeight: 'low',
          freezeFirstColumn: false,
          columns: THEN_TASK_COLUMNS.map((column) => ({
            name: column.name,
            displayName: column.displayName,
            width: column.width,
            ...(column.dataType ? { dataType: column.dataType } : {}),
            ...(column.horizontalAlign ? { horizontalAlign: column.horizontalAlign } : {}),
          })),
          rows: buildThenTaskCommandTableCardRows(rows),
        }
      : undefined,
    panels: longPromptPanels,
    sections: [],
    ...(tasks.length > 0
      ? {
          selects: [{
            id: 'then_task_select',
            placeholder: '选择 /then',
            selectedCallbackData,
            options: tasks.map((task, index) => ({
              text: `${index + 1}. ${formatThenTaskSelectText(task)}`,
              callbackData: `${THEN_TASK_SELECT_CALLBACK_PREFIX}${encodeURIComponent(task.id)}`,
            })),
          }],
        }
      : {}),
    actions: buildThenTaskActionRows(tasks.length > 0
      ? [
          {
            text: '新建',
            callbackData: buildCommandCallbackData(THEN_TASK_FORM_COMMAND),
            type: 'primary',
          },
          {
            text: '修改',
            callbackData: buildThenTaskActionCallbackData('edit'),
            type: 'default',
          },
          {
            text: '取消',
            callbackData: buildThenTaskActionCallbackData('no'),
            type: 'danger',
          },
          {
            text: '刷新',
            callbackData: buildCommandCallbackData('/then'),
            type: 'default',
          },
        ]
      : [
          {
            text: '新建',
            callbackData: buildCommandCallbackData(THEN_TASK_FORM_COMMAND),
            type: 'primary',
          },
          {
            text: '刷新',
            callbackData: buildCommandCallbackData('/then'),
            type: 'default',
          },
        ]),
    footer: [
      '短 prompt 直接显示在表格中；长 prompt 会放入折叠块；超长 prompt 仅截断展示，不影响实际发送内容。',
      '下拉框选择后可点击“取消”；pending 会删除，running 会中止当前发送。',
      '纯文本命令：`/then 总结刚才的执行结果` 新建；`/then no 1` 取消第 1 个后续输入。',
    ],
  };
  if (options.channelType && options.chatId) {
    card.updateKey = buildThreadCardUpdateKey('then', options.channelType, options.chatId);
    card.updateTtlMs = null;
  }
  return card;
}

export function buildThenTaskFormCard(defaultPrompt = ''): OutboundRichCard {
  return {
    title: '新建 /then 后续输入',
    subtitle: '输入 prompt 后，会在当前会话 completed/interrupted 后发送一次。',
    template: 'blue',
    sections: [],
    form: {
      optionElementId: 'clk_then_option',
      inputElementId: THEN_FORM_PROMPT_ELEMENT_ID,
      inputFormName: THEN_FORM_PROMPT_FORM_NAME,
      inputLabel: 'Prompt',
      inputPlaceholder: '例如 总结刚才的执行结果',
      inputDefaultValue: defaultPrompt,
      submitText: '创建',
      submitCallbackData: buildCommandCallbackData('/then'),
      options: [],
    },
    footer: [
      '提交后等同发送 `/then <prompt>`。',
      '创建后的列表序号按创建时间排序，可用 `/then set <序号> <prompt>` 修改，或 `/then no <序号>` 取消。',
    ],
  };
}

export function buildThenTaskEditFormCard(task: ThenTask): OutboundRichCard {
  return {
    title: '修改 /then 后续输入',
    subtitle: '修改 pending prompt；已经开始发送的 /then 只能取消/中止。',
    template: 'blue',
    sections: [{
      fields: [
        ['当前状态', task.status === 'running' ? '发送中' : '等待'],
        ['创建时间', formatCommandDateTime(task.createdAt)],
      ],
    }],
    form: {
      optionElementId: 'clk_then_edit_option',
      inputElementId: THEN_FORM_PROMPT_ELEMENT_ID,
      inputFormName: THEN_FORM_PROMPT_FORM_NAME,
      inputLabel: 'Prompt',
      inputPlaceholder: '例如 总结刚才的执行结果',
      inputDefaultValue: task.prompt,
      submitText: '保存',
      submitCallbackData: buildCommandCallbackData(`/then set-id ${task.id}`),
      options: [],
    },
    footer: [
      '保存后等同修改这条 /then 的 prompt；触发时机保持不变。',
    ],
  };
}

function formatThenTaskSessionTitle(task: ThenTask, session: BridgeSession | undefined): string {
  if (!session) return task.bridgeSessionId.slice(0, 8);
  return getSessionDisplayName(session, getSessionWorkingDirectory(session));
}

function getThenTaskRuntimeId(session: BridgeSession | undefined): string {
  if (!session) return '-';
  if (getSessionActiveRuntime(session) === 'claude') {
    return getSessionClaudeSessionId(session) || '-';
  }
  return getSessionCodexThreadId(session) || '-';
}

function formatInlinePrompt(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, ' ').trim();
  if (normalized.length <= THEN_PROMPT_INLINE_LIMIT) return normalized || '-';
  return `${normalized.slice(0, THEN_PROMPT_INLINE_LIMIT - 1).trimEnd()}…`;
}

function formatThenTaskSelectText(task: ThenTask): string {
  return `${task.status === 'running' ? '发送中' : '等待'} ${formatInlinePrompt(task.prompt)}`;
}

function formatPromptBlock(index: number, prompt: string, markdown: boolean): string {
  const normalized = prompt.trim();
  const { text, truncated } = truncatePrompt(normalized, THEN_PROMPT_TEXT_LIMIT);
  const suffix = truncated ? '\n（展示已截断，实际发送使用完整 prompt。）' : '';
  if (!markdown) return `${index}. ${text}${suffix}`;
  if (normalized.length <= THEN_PROMPT_INLINE_LIMIT) return `${index}. ${normalized || '-'}`;
  return [
    `<details><summary>Prompt ${index}${truncated ? '（展示截断）' : ''}</summary>`,
    '',
    buildFencedCodeBlock(text || '-', 'text'),
    suffix,
    '</details>',
  ].filter(Boolean).join('\n');
}

function buildLongPromptPanel(task: ThenTask, index: number): NonNullable<OutboundRichCard['panels']>[number] | null {
  if (task.prompt.trim().length <= THEN_PROMPT_INLINE_LIMIT) return null;
  const { text, truncated } = truncatePrompt(task.prompt.trim(), THEN_PROMPT_CARD_LIMIT);
  return {
    title: `Prompt ${index}${truncated ? '（展示截断）' : ''}`,
    template: 'blue',
    expanded: false,
    sections: [{
      code: {
        text: text || '-',
        language: 'text',
      },
    }],
    footer: truncated ? ['展示已截断；实际发送使用完整 prompt。'] : undefined,
  };
}

function truncatePrompt(prompt: string, limit: number): { text: string; truncated: boolean } {
  if (prompt.length <= limit) return { text: prompt, truncated: false };
  return {
    text: `${prompt.slice(0, limit - 1).trimEnd()}…`,
    truncated: true,
  };
}

function buildThenTaskCommandTableText(rows: ThenTaskCommandRow[]): string {
  if (rows.length === 0) return '(empty)';
  const headers = ['#', 'Session', '状态', 'Prompt', '创建时间', 'session runtime-id', '取消命令'];
  const values = rows.map((row) => [
    row.index,
    row.sessionTitle,
    row.status,
    row.prompt,
    row.createdAt,
    row.runtimeId,
    row.command,
  ]);
  const widths = headers.map((header, columnIndex) => Math.max(
    header.length,
    ...values.map((row) => row[columnIndex].length),
  ));
  const formatRow = (row: string[]) => row
    .map((cell, index) => cell.padEnd(widths[index], ' '))
    .join('  ')
    .trimEnd();
  return [
    formatRow(headers),
    formatRow(widths.map((width) => '-'.repeat(width))),
    ...values.map(formatRow),
  ].join('\n');
}

function buildThenTaskCommandTableCardRows(rows: ThenTaskCommandRow[]): Array<Record<string, string>> {
  return rows.map((row) => {
    const result: Record<string, string> = {};
    for (const column of THEN_TASK_COLUMNS) {
      result[column.name] = row[column.key];
    }
    return result;
  });
}

function buildThenTaskActionRows(buttons: OutboundCardActionButton[]): OutboundCardActionButton[][] {
  const rows: OutboundCardActionButton[][] = [];
  for (let index = 0; index < buttons.length; index += THEN_TASK_ACTIONS_PER_ROW) {
    rows.push(buttons.slice(index, index + THEN_TASK_ACTIONS_PER_ROW));
  }
  return rows;
}
