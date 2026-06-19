import type { BridgeSession, OutboundCardActionButton, OutboundRichCard } from '../../../domain/index.js';
import type { EveryTask } from '../../automation/every-tasks.js';
import {
  EVERY_TASK_FORM_COMMAND,
  EVERY_TASK_SELECT_CALLBACK_PREFIX,
  buildCommandCallbackData,
  buildEveryTaskActionCallbackData,
  buildThreadCardUpdateKey,
} from '../callbacks.js';
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

const EVERY_TASK_CARD_MAX_ITEMS = 20;
const EVERY_TASK_ACTIONS_PER_ROW = 3;
export const EVERY_FORM_INTERVAL_ELEMENT_ID = 'clk_every_interval';
export const EVERY_FORM_PROMPT_ELEMENT_ID = 'clk_every_prompt';
export const EVERY_FORM_INTERVAL_FORM_NAME = 'every_interval';
export const EVERY_FORM_PROMPT_FORM_NAME = 'every_prompt';

interface EveryTaskCommandRow {
  index: string;
  sessionTitle: string;
  interval: string;
  prompt: string;
  createdAt: string;
  triggeredCount: string;
  lastTriggeredAt: string;
  status: string;
  runtimeId: string;
  command: string;
}

type EveryTaskCommandColumnKey = keyof EveryTaskCommandRow;

interface EveryTaskCommandColumn {
  key: EveryTaskCommandColumnKey;
  name: string;
  displayName: string;
  width: string;
  dataType?: 'text' | 'lark_md' | 'markdown' | 'number';
  horizontalAlign?: 'left' | 'center' | 'right';
}

const EVERY_TASK_COLUMNS: EveryTaskCommandColumn[] = [
  { key: 'index', name: 'index', displayName: '#', width: '80px', dataType: 'lark_md', horizontalAlign: 'center' },
  { key: 'sessionTitle', name: 'session_title', displayName: 'Session', width: '220px', dataType: 'lark_md' },
  { key: 'interval', name: 'interval', displayName: '间隔', width: '120px', dataType: 'lark_md', horizontalAlign: 'center' },
  { key: 'prompt', name: 'prompt', displayName: 'Prompt', width: '420px', dataType: 'lark_md' },
  { key: 'createdAt', name: 'created_at', displayName: '创建时间', width: '180px', dataType: 'lark_md' },
  { key: 'triggeredCount', name: 'triggered_count', displayName: '已触发', width: '100px', dataType: 'lark_md', horizontalAlign: 'center' },
  { key: 'lastTriggeredAt', name: 'last_triggered_at', displayName: '上一次触发', width: '180px', dataType: 'lark_md' },
  { key: 'status', name: 'status', displayName: '状态', width: '100px', dataType: 'lark_md', horizontalAlign: 'center' },
  { key: 'runtimeId', name: 'runtime_id', displayName: 'session runtime-id', width: '260px', dataType: 'lark_md' },
  { key: 'command', name: 'command', displayName: '取消命令', width: '160px', dataType: 'lark_md' },
];

export function buildEveryTaskCommandRows(
  tasks: EveryTask[],
  sessionsById: Map<string, BridgeSession>,
): EveryTaskCommandRow[] {
  return tasks.map((task, index) => ({
    index: `${index + 1}`,
    sessionTitle: formatEveryTaskSessionTitle(task, sessionsById.get(task.bridgeSessionId)),
    interval: formatInterval(task.intervalSeconds),
    prompt: task.prompt || '-',
    createdAt: formatCommandDateTime(task.createdAt),
    triggeredCount: `${task.triggeredCount}`,
    lastTriggeredAt: formatCommandDateTime(task.lastTriggeredAt),
    status: task.status === 'running' ? '运行中' : '失败',
    runtimeId: getEveryTaskRuntimeId(sessionsById.get(task.bridgeSessionId)),
    command: `/every no ${index + 1}`,
  }));
}

export function buildEveryTasksCommandResponse(
  tasks: EveryTask[],
  sessionsById: Map<string, BridgeSession>,
  markdown: boolean,
): string {
  if (tasks.length === 0) {
    return [
      '当前聊天没有 /every 定时输入。',
      '',
      '`/every <数字><s|m|h|d> <prompt>` 创建定时输入；也可以点卡片里的“新建”打开表单。',
      '`/every no <序号>` 取消定时输入；序号按创建时间排序，来自 `/every` 列表。',
    ].join('\n');
  }

  const title = `当前聊天 /every 定时输入（${tasks.length}）`;
  const rows = buildEveryTaskCommandRows(tasks, sessionsById);
  const table = buildEveryTaskCommandTableText(rows);
  const footer = [
    '`/every <数字><s|m|h|d> <prompt>` 创建定时输入；每次触发都会复用创建时绑定的当前会话。',
    '`/every no <序号>` 取消定时输入；序号按创建时间排序，来自当前列表。',
  ];

  if (markdown) {
    return [
      `**${title}**`,
      '',
      buildFencedCodeBlock(table, 'text'),
      '',
      ...footer.map((line) => `- ${line}`),
    ].join('\n').trim();
  }

  return [title, '', table, '', ...footer].join('\n').trim();
}

export function buildEveryTasksCommandCard(
  tasks: EveryTask[],
  sessionsById: Map<string, BridgeSession>,
  options: {
    selectedTaskId?: string | null;
    channelType?: string;
    chatId?: string;
  } = {},
): OutboundRichCard | null {
  if (tasks.length > EVERY_TASK_CARD_MAX_ITEMS) return null;
  const selectedCallbackData = options.selectedTaskId
    ? `${EVERY_TASK_SELECT_CALLBACK_PREFIX}${encodeURIComponent(options.selectedTaskId)}`
    : undefined;

  const card: OutboundRichCard = {
    title: `当前聊天 /every 定时输入（${tasks.length}）`,
    subtitle: '这张表显示当前聊天可见的 /every；每个任务会复用创建时绑定的 bridge session。',
    template: 'green',
    table: {
      pageSize: 10,
      rowHeight: 'low',
      freezeFirstColumn: false,
      columns: EVERY_TASK_COLUMNS.map((column) => ({
        name: column.name,
        displayName: column.displayName,
        width: column.width,
        ...(column.dataType ? { dataType: column.dataType } : {}),
        ...(column.horizontalAlign ? { horizontalAlign: column.horizontalAlign } : {}),
      })),
      rows: buildEveryTaskCommandTableCardRows(buildEveryTaskCommandRows(tasks, sessionsById)),
    },
    sections: [],
    ...(tasks.length > 0
      ? {
          selects: [{
            id: 'every_task_select',
            placeholder: '选择 /every',
            selectedCallbackData,
            options: tasks.map((task, index) => ({
              text: `${index + 1}. ${formatEveryTaskSelectText(task)}`,
              callbackData: `${EVERY_TASK_SELECT_CALLBACK_PREFIX}${encodeURIComponent(task.id)}`,
            })),
          }],
        }
      : {}),
    actions: buildEveryTaskActionRows(tasks.length > 0
      ? [
          {
            text: '新建',
            callbackData: buildCommandCallbackData(EVERY_TASK_FORM_COMMAND),
            type: 'primary',
          },
          {
            text: '取消',
            callbackData: buildEveryTaskActionCallbackData('no'),
            type: 'danger',
          },
          {
            text: '刷新',
            callbackData: buildCommandCallbackData('/every'),
            type: 'default',
          },
        ]
      : [
          {
            text: '新建',
            callbackData: buildCommandCallbackData(EVERY_TASK_FORM_COMMAND),
            type: 'primary',
          },
          {
            text: '刷新',
            callbackData: buildCommandCallbackData('/every'),
            type: 'default',
          },
        ]),
    footer: [
      '布局：上方表格按创建时间排序；下拉框用于选择要取消的任务；按钮区可新建、取消或刷新。',
      '纯文本命令：`/every 10m 检查进度` 新建；`/every no 1` 取消第 1 个定时输入。',
      `超过 ${EVERY_TASK_CARD_MAX_ITEMS} 条时只发送文本列表，避免卡片过长。`,
    ],
  };
  if (options.channelType && options.chatId) {
    card.updateKey = buildThreadCardUpdateKey('every', options.channelType, options.chatId);
    card.updateTtlMs = null;
  }
  return card;
}

export function buildEveryTaskFormCard(defaultPrompt = ''): OutboundRichCard {
  return {
    title: '新建 /every 定时输入',
    subtitle: '输入间隔和 prompt 后创建一个复用当前会话的定时输入。',
    template: 'green',
    sections: [],
    form: {
      optionElementId: 'clk_every_option',
      inputElementId: EVERY_FORM_INTERVAL_ELEMENT_ID,
      inputFormName: EVERY_FORM_INTERVAL_FORM_NAME,
      inputLabel: '间隔',
      inputPlaceholder: '例如 10m、30s、2h、1d',
      extraInputs: [{
        elementId: EVERY_FORM_PROMPT_ELEMENT_ID,
        formName: EVERY_FORM_PROMPT_FORM_NAME,
        label: 'Prompt',
        placeholder: '例如 检查实验进度',
        defaultValue: defaultPrompt,
      }],
      submitText: '创建',
      submitCallbackData: buildCommandCallbackData('/every'),
      options: [],
    },
    footer: [
      '提交后等同发送 `/every <数字><s|m|h|d> <prompt>`。',
      '创建后的列表序号按创建时间排序，可用 `/every no <序号>` 取消。',
    ],
  };
}

function formatEveryTaskSessionTitle(task: EveryTask, session: BridgeSession | undefined): string {
  if (!session) return task.bridgeSessionId.slice(0, 8);
  return getSessionDisplayName(session, getSessionWorkingDirectory(session));
}

function getEveryTaskRuntimeId(session: BridgeSession | undefined): string {
  if (!session) return '-';
  if (getSessionActiveRuntime(session) === 'claude') {
    return getSessionClaudeSessionId(session) || '-';
  }
  return getSessionCodexThreadId(session) || '-';
}

function formatEveryTaskSelectText(task: EveryTask): string {
  return `${formatInterval(task.intervalSeconds)} ${task.prompt || '定时输入'}`;
}

function formatInterval(intervalSeconds: number): string {
  if (intervalSeconds % 86400 === 0) return `${intervalSeconds / 86400} d`;
  if (intervalSeconds % 3600 === 0) return `${intervalSeconds / 3600} h`;
  if (intervalSeconds % 60 === 0) return `${intervalSeconds / 60} m`;
  return `${intervalSeconds} s`;
}

function buildEveryTaskCommandTableText(rows: EveryTaskCommandRow[]): string {
  const tableRows = [
    EVERY_TASK_COLUMNS.map((column) => column.displayName),
    ...rows.map((row) => EVERY_TASK_COLUMNS.map((column) => normalizeCell(row[column.key]))),
  ];
  const widths = EVERY_TASK_COLUMNS.map((_, columnIndex) => (
    Math.max(...tableRows.map((row) => row[columnIndex].length))
  ));
  return tableRows
    .map((row) => row.map((cell, columnIndex) => cell.padEnd(widths[columnIndex])).join('  '))
    .join('\n');
}

function buildEveryTaskCommandTableCardRows(rows: EveryTaskCommandRow[]): Array<Record<string, string>> {
  return rows.map((row) => Object.fromEntries(EVERY_TASK_COLUMNS.map((column) => {
    const value = normalizeCell(row[column.key]);
    return [
      column.name,
      column.key === 'index'
        ? `<number_tag background_color='green-350' font_color='white'>${value}</number_tag>`
        : value,
    ];
  })));
}

function buildEveryTaskActionRows(buttons: OutboundCardActionButton[]): OutboundCardActionButton[][] {
  const rows: OutboundCardActionButton[][] = [];
  for (let index = 0; index < buttons.length; index += EVERY_TASK_ACTIONS_PER_ROW) {
    rows.push(buttons.slice(index, index + EVERY_TASK_ACTIONS_PER_ROW));
  }
  return rows;
}

function normalizeCell(value: string): string {
  return value.replace(/\s+/g, ' ').trim() || '-';
}
