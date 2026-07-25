import type { BridgeSession } from '../../domain/index.js';
import type { OutboundCardActionButton, OutboundRichCard } from '../../domain/index.js';
import { buildCommandCallbackData, NEW_SESSION_FORM_COMMAND } from './callbacks.js';
import { buildFencedCodeBlock } from '../../shared/markdown/fence.js';
import type { LocalRuntimeSessionSummary } from '../session/command-use-cases/source.js';
import {
  DEFAULT_LOCAL_SESSION_LIST_LIMIT,
  type LocalSessionListRuntime,
  LOCAL_SESSION_LIST_LIMIT_OPTIONS,
  MAX_LOCAL_SESSION_LIST_LIMIT,
  parseListIndex,
} from './aliases.js';
import { formatCreatorBadge, resolveCreatorKind } from '../session/display/session-creator.js';
import { getSessionActiveRuntime } from '../../domain/session-runtime.js';
import {
  buildThreadActionCallbackData,
  buildThreadCardUpdateKey,
  THREAD_SELECT_CALLBACK_PREFIX,
} from './callbacks.js';
import { formatLocalDateTime, formatLocalMonthDayTime } from '../../shared/date-time.js';
export { formatBindingChatLabel } from '../session/display/channel-label.js';
export { getSessionDisplayName, stripLegacySessionPrefix } from '../session/display/session-title.js';
export { toUserVisibleBindingError, toUserVisibleCommandError } from './errors.js';
export {
  THREAD_SELECT_ACTION_CALLBACK_PREFIX,
  THREAD_SELECT_CALLBACK_PREFIX,
  type ThreadCardScope,
} from './callbacks.js';

const BOUND_THREADS_CARD_MAX_ITEMS = 20;
const THREAD_CARD_ACTIONS_PER_ROW = 3;

export interface ThreadCardBindingState {
  threadId: string;
  bindingId?: string;
  bridgeSessionId?: string;
  active: boolean;
  title?: string;
}

export interface BoundThreadCardItem {
  title: string;
  cwd: string;
  lastActiveAt?: string;
  threadId: string;
  bridgeSessionId?: string;
  bindingId: string;
  active: boolean;
  originator?: string;
}

export interface ThreadCommandTableRow {
  index: string;
  title: string;
  cwd: string;
  lastActiveAt: string;
  userInputTurns: string;
  bridgeId: string;
  threadId: string;
  creator: string;
  active?: boolean;
  selected?: boolean;
}

export type GlobalThreadListItem =
  | { kind: 'bridge'; bridge: BoundThreadCardItem }
  | { kind: 'local'; local: LocalRuntimeSessionSummary };

function buildThreadLimitSelect(
  limit: number | undefined,
  id = 'thread_limit_select',
  runtime?: LocalSessionListRuntime,
): NonNullable<OutboundRichCard['selects']>[number] {
  const normalizedLimit = LOCAL_SESSION_LIST_LIMIT_OPTIONS.includes(limit as typeof LOCAL_SESSION_LIST_LIMIT_OPTIONS[number])
    ? limit
    : DEFAULT_LOCAL_SESSION_LIST_LIMIT;
  const prefix = runtime ? `/t ${runtime}` : '/t';
  const optionForLimit = (value: typeof LOCAL_SESSION_LIST_LIMIT_OPTIONS[number]) => ({
    text: `显示 ${value}`,
    callbackData: buildCommandCallbackData(value === DEFAULT_LOCAL_SESSION_LIST_LIMIT ? prefix : `${prefix} n ${value}`),
  });
  return {
    id,
    placeholder: '显示数量',
    selectedCallbackData: optionForLimit(normalizedLimit as typeof LOCAL_SESSION_LIST_LIMIT_OPTIONS[number]).callbackData,
    options: LOCAL_SESSION_LIST_LIMIT_OPTIONS.map(optionForLimit),
  };
}

function buildRuntimeSelect(
  runtime: LocalSessionListRuntime,
  limit: number | undefined,
): NonNullable<OutboundRichCard['selects']>[number] {
  const suffix = limit && limit !== DEFAULT_LOCAL_SESSION_LIST_LIMIT ? ` n ${limit}` : '';
  return {
    id: 'runtime_select',
    placeholder: '运行时',
    selectedCallbackData: buildCommandCallbackData(`/t ${runtime}${suffix}`),
    options: [
      { text: 'Codex', callbackData: buildCommandCallbackData(`/t codex${suffix}`) },
      { text: 'Claude', callbackData: buildCommandCallbackData(`/t claude${suffix}`) },
      { text: 'Kimi', callbackData: buildCommandCallbackData(`/t kimi${suffix}`) },
      { text: 'Cursor', callbackData: buildCommandCallbackData(`/t cursor${suffix}`) },
    ],
  };
}

function localRuntimeOf(session: LocalRuntimeSessionSummary): LocalSessionListRuntime {
  if (session.runtime === 'claude') return 'claude';
  if (session.runtime === 'kimi') return 'kimi';
  if (session.runtime === 'cursor') return 'cursor';
  return 'codex';
}

function formatLocalRuntimeCreator(session: LocalRuntimeSessionSummary): string {
  if (localRuntimeOf(session) === 'claude') return 'Claude Code';
  if (localRuntimeOf(session) === 'kimi') return 'Kimi Code';
  if (localRuntimeOf(session) === 'cursor') return 'Cursor Agent';
  return formatCreatorBadge(resolveCreatorKind({
    source: session.source,
    originator: session.originator,
  })).label;
}

function formatLocalThreadListTitle(codexCount: number, claudeCount: number, kimiCount: number, cursorCount: number, bridgeCount: number): string {
  const parts = [`Codex${codexCount}`];
  if (claudeCount > 0) parts.push(`Claude${claudeCount}`);
  if (kimiCount > 0) parts.push(`Kimi${kimiCount}`);
  if (cursorCount > 0) parts.push(`Cursor${cursorCount}`);
  if (bridgeCount > 0) parts.push(`Bridge${bridgeCount}`);
  return `本地会话（${parts.join(' + ')}）`;
}

type ThreadCommandTableColumnKey = Exclude<keyof ThreadCommandTableRow, 'active' | 'selected'>;

interface ThreadCommandTableColumn {
  key: ThreadCommandTableColumnKey;
  name: string;
  displayName: string;
  width: string;
  dataType?: 'text' | 'lark_md' | 'markdown' | 'number';
  horizontalAlign?: 'left' | 'center' | 'right';
}

const THREAD_COMMAND_TABLE_COLUMNS: ThreadCommandTableColumn[] = [
  { key: 'index', name: 'index', displayName: '#', width: '90px', dataType: 'lark_md', horizontalAlign: 'center' },
  { key: 'title', name: 'title', displayName: '标题', width: '260px', dataType: 'lark_md' },
  { key: 'cwd', name: 'cwd', displayName: '目录', width: '340px', dataType: 'lark_md' },
  { key: 'lastActiveAt', name: 'last_active', displayName: '上一次活动', width: '180px', dataType: 'lark_md' },
  { key: 'userInputTurns', name: 'user_input_turns', displayName: '用户输入轮数', width: '140px', dataType: 'lark_md', horizontalAlign: 'center' },
  { key: 'bridgeId', name: 'bridge_id', displayName: 'bridge_id', width: '150px', dataType: 'lark_md' },
  { key: 'threadId', name: 'thread_id', displayName: 'thread_id', width: '260px', dataType: 'lark_md' },
  { key: 'creator', name: 'creator', displayName: 'Creator', width: '140px', dataType: 'lark_md' },
];

export function resolveByIndexOrPrefix<T>(
  raw: string,
  items: T[],
  getId: (item: T) => string,
): { match: T | null; ambiguous: boolean; index?: number } {
  const token = raw.trim().toLowerCase();
  if (!token) return { match: null, ambiguous: false };

  const index = parseListIndex(token);
  if (index !== null) {
    return { match: items[index - 1] ?? null, ambiguous: false, index };
  }

  const exact = items.find((item) => getId(item).toLowerCase() === token);
  if (exact) return { match: exact, ambiguous: false };

  const prefixMatches = items.filter((item) => getId(item).toLowerCase().startsWith(token));
  if (prefixMatches.length === 1) {
    return { match: prefixMatches[0], ambiguous: false };
  }
  if (prefixMatches.length > 1) {
    return { match: null, ambiguous: true };
  }

  return { match: null, ambiguous: false };
}

export function formatReasoningEffort(reasoning: string): string {
  switch (reasoning) {
    case 'minimal':
      return 'minimal (1)';
    case 'low':
      return 'low (2)';
    case 'medium':
      return 'medium (3)';
    case 'high':
      return 'high (4)';
    case 'xhigh':
      return 'xhigh (5)';
    default:
      return reasoning;
  }
}

export function minimalReasoningWebSearchWarning(reasoning: string): string | null {
  return reasoning === 'minimal'
    ? '`minimal` 思考级别会禁用 web search；需要联网搜索时请切换到 `low` 或更高。'
    : null;
}

export function buildCommandFields(
  title: string,
  fields: Array<[string, string | null | undefined]>,
  notes: string[] = [],
  markdown = false,
): string {
  const normalizedFields = fields.filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== '');
  const normalizedNotes = notes.filter((note) => note.trim().length > 0);

  if (markdown) {
    const lines = [`**${title}**`, ''];
    for (const [label, value] of normalizedFields) {
      lines.push(`- **${label}**：${value}`);
    }
    if (normalizedNotes.length > 0) {
      lines.push('', '**说明**');
      for (const note of normalizedNotes) {
        lines.push(`- ${note}`);
      }
    }
    return lines.join('\n').trim();
  }

  return [
    title,
    '',
    ...normalizedFields.map(([label, value]) => `${label}: ${value}`),
    ...(normalizedNotes.length > 0 ? ['', ...normalizedNotes] : []),
  ].join('\n').trim();
}

export function buildIndexedCommandList(
  title: string,
  items: Array<{ heading: string; details: string[] }>,
  footer: string[] = [],
  markdown = false,
): string {
  if (markdown) {
    const lines = [`**${title}**`, ''];
    items.forEach((item, index) => {
      const marker = `${index + 1}.`;
      const childIndent = ' '.repeat(marker.length + 1);
      lines.push(`${marker} **${item.heading}**`);
      item.details.filter(Boolean).forEach((detail) => lines.push(`${childIndent}- ${detail}`));
      lines.push('');
    });
    footer.filter(Boolean).forEach((line) => lines.push(`- ${line}`));
    return lines.join('\n').trim();
  }

  const lines = [title, ''];
  items.forEach((item, index) => {
    lines.push(`${index + 1}. ${item.heading}`);
    item.details.filter(Boolean).forEach((detail) => lines.push(`   ${detail}`));
    lines.push('');
  });
  footer.filter(Boolean).forEach((line) => lines.push(line));
  return lines.join('\n').trim();
}

export function formatCommandPath(cwd: string | undefined | null): string {
  return cwd?.trim() || '~';
}

function formatThreadActivityTime(value: string | null | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) return '-';

  return formatLocalMonthDayTime(trimmed) || trimmed;
}

function normalizeThreadCommandTableCell(value: string): string {
  return value.replace(/\s+/g, ' ').trim() || '-';
}

function threadCommandTableRowValue(row: ThreadCommandTableRow, key: ThreadCommandTableColumnKey): string {
  if (key === 'bridgeId') return row[key].trim();
  return normalizeThreadCommandTableCell(row[key]);
}

function formatBoundThreadIndex(index: number, active: boolean): string {
  return active ? `*${index} 当前` : `*${index}`;
}

const ACTIVE_THREAD_CARD_NUMBER_COLOR = 'green-350';
const INACTIVE_THREAD_CARD_COLOR = 'grey-500';

function formatActiveThreadCardNumberTag(index: string): string {
  return `<number_tag background_color='${ACTIVE_THREAD_CARD_NUMBER_COLOR}' font_color='white'>${index}</number_tag>`;
}

function formatSelectedThreadCardNumberTag(index: string): string {
  return `<number_tag background_color='${INACTIVE_THREAD_CARD_COLOR}' font_color='white'>${index}</number_tag>`;
}

function formatInactiveThreadCardCell(value: string): string {
  if (!value.trim()) return '';
  return `<font color='${INACTIVE_THREAD_CARD_COLOR}'>${value}</font>`;
}

function formatActiveThreadCardCellValue(value: string): string {
  return `**${value}**`;
}

function formatActiveThreadCardCell(row: ThreadCommandTableRow, key: ThreadCommandTableColumnKey): string {
  const value = threadCommandTableRowValue(row, key);
  if (key === 'index') {
    const index = value.match(/\d+/)?.[0] || value.trim() || '-';
    return formatActiveThreadCardNumberTag(index);
  }
  return value;
}

function formatSelectedThreadCardCell(row: ThreadCommandTableRow, key: ThreadCommandTableColumnKey): string {
  const value = threadCommandTableRowValue(row, key);
  if (key === 'index') {
    const index = value.match(/\d+/)?.[0] || value.trim() || '-';
    return formatSelectedThreadCardNumberTag(index);
  }
  return formatInactiveThreadCardCell(value);
}

function buildThreadCommandTableCardRows(rows: ThreadCommandTableRow[]): Array<Record<string, string>> {
  return rows.map((row) => Object.fromEntries(THREAD_COMMAND_TABLE_COLUMNS.map((column) => [
    column.name,
    row.active
      ? formatActiveThreadCardCellValue(formatActiveThreadCardCell(row, column.key))
      : row.selected
        ? formatSelectedThreadCardCell(row, column.key)
        : formatInactiveThreadCardCell(threadCommandTableRowValue(row, column.key)),
  ])));
}

export function buildThreadCommandTableText(rows: ThreadCommandTableRow[]): string {
  const tableRows = [
    THREAD_COMMAND_TABLE_COLUMNS.map((column) => column.displayName),
    ...rows.map((row) => THREAD_COMMAND_TABLE_COLUMNS.map((column) => threadCommandTableRowValue(row, column.key))),
  ];
  const widths = THREAD_COMMAND_TABLE_COLUMNS.map((_, columnIndex) => (
    Math.max(...tableRows.map((row) => row[columnIndex].length))
  ));
  return tableRows
    .map((row) => row.map((cell, columnIndex) => cell.padEnd(widths[columnIndex])).join('  '))
    .join('\n');
}

function buildThreadCommandTableResponse(
  title: string,
  rows: ThreadCommandTableRow[],
  footer: string[],
  markdown: boolean,
): string {
  const table = buildThreadCommandTableText(rows);
  if (markdown) {
    return [
      `**${title}**`,
      '',
      buildFencedCodeBlock(table, 'text'),
      ...(footer.length > 0 ? ['', ...footer.map((line) => `- ${line}`)] : []),
    ].join('\n').trim();
  }

  return [
    title,
    '',
    table,
    ...(footer.length > 0 ? ['', ...footer] : []),
  ].join('\n').trim();
}

export function buildLocalRuntimeSessionCommandTableRows(
  localSessions: LocalRuntimeSessionSummary[],
  bindingStates: ThreadCardBindingState[] = [],
  options: { startIndex?: number; globalCommandIndex?: boolean } = {},
): ThreadCommandTableRow[] {
  const bindingByThreadId = new Map(bindingStates.map((state) => [state.threadId, state]));
  const startIndex = options.startIndex ?? 1;
  return localSessions.map((session, index) => {
    const binding = bindingByThreadId.get(session.threadId);
    const displayIndex = startIndex + index;
    return {
      index: binding?.active
        ? formatBoundThreadIndex(displayIndex, true)
        : binding
          ? formatBoundThreadIndex(displayIndex, false)
          : `${displayIndex}`,
      title: binding?.title || session.title || '未命名线程',
      cwd: formatCommandPath(session.cwd),
      lastActiveAt: formatThreadActivityTime(session.lastEventAt),
      userInputTurns: String(session.userInputTurns ?? '-'),
      bridgeId: binding?.bridgeSessionId ? binding.bridgeSessionId.slice(0, 8) : '',
      threadId: session.threadId || '-',
      creator: formatLocalRuntimeCreator(session),
      active: binding?.active || false,
      selected: Boolean(binding?.bindingId),
    };
  });
}

export function buildBoundThreadCommandTableRows(
  bindings: BoundThreadCardItem[],
  options: { startIndex?: number; globalCommandIndex?: boolean } = {},
): ThreadCommandTableRow[] {
  const startIndex = options.startIndex ?? 1;
  return bindings.map((binding, index) => {
    const displayIndex = startIndex + index;
    return {
      index: formatBoundThreadIndex(displayIndex, binding.active),
      title: binding.title || '未命名线程',
      cwd: formatCommandPath(binding.cwd),
      lastActiveAt: formatThreadActivityTime(binding.lastActiveAt),
      userInputTurns: '-',
      bridgeId: binding.bridgeSessionId ? binding.bridgeSessionId.slice(0, 8) : '',
      threadId: binding.threadId || '-',
      creator: binding.originator || '当前聊天',
      active: binding.active,
      selected: true,
    };
  });
}

function threadActivityTimeMs(value: string | null | undefined): number {
  const time = Date.parse(value || '');
  return Number.isNaN(time) ? 0 : time;
}

function globalThreadListItemActivityMs(item: GlobalThreadListItem): number {
  return item.kind === 'bridge'
    ? threadActivityTimeMs(item.bridge.lastActiveAt)
    : threadActivityTimeMs(item.local.lastEventAt);
}

function compareGlobalThreadListItemsByActivityDesc(a: GlobalThreadListItem, b: GlobalThreadListItem): number {
  const timeDiff = globalThreadListItemActivityMs(b) - globalThreadListItemActivityMs(a);
  if (timeDiff !== 0) return timeDiff;
  const titleA = a.kind === 'bridge' ? a.bridge.title : a.local.title;
  const titleB = b.kind === 'bridge' ? b.bridge.title : b.local.title;
  return (titleA || '').localeCompare(titleB || '');
}

export function buildGlobalThreadList(
  localSessions: LocalRuntimeSessionSummary[],
  _bridgeBindings: BoundThreadCardItem[] = [],
): GlobalThreadListItem[] {
  return [
    ...localSessions.map((local): GlobalThreadListItem => ({ kind: 'local', local })),
  ].sort(compareGlobalThreadListItemsByActivityDesc);
}

export function buildGlobalThreadCommandTableRows(
  items: GlobalThreadListItem[],
  bindingStates: ThreadCardBindingState[] = [],
): ThreadCommandTableRow[] {
  const bindingByThreadId = new Map(bindingStates.map((state) => [state.threadId, state]));
  return items.map((item, index) => {
    const displayIndex = index + 1;
    if (item.kind === 'bridge') {
      const binding = item.bridge;
      return {
        index: formatBoundThreadIndex(displayIndex, binding.active),
        title: binding.title || '未命名线程',
        cwd: formatCommandPath(binding.cwd),
        lastActiveAt: formatThreadActivityTime(binding.lastActiveAt),
        userInputTurns: '-',
        bridgeId: binding.bridgeSessionId ? binding.bridgeSessionId.slice(0, 8) : '',
        threadId: binding.threadId || '-',
        creator: binding.originator || '当前聊天',
        active: binding.active,
        selected: true,
      };
    }

    const session = item.local;
    const binding = bindingByThreadId.get(session.threadId);
    return {
      index: binding?.active
        ? formatBoundThreadIndex(displayIndex, true)
        : binding
          ? formatBoundThreadIndex(displayIndex, false)
          : `${displayIndex}`,
      title: binding?.title || session.title || '未命名线程',
      cwd: formatCommandPath(session.cwd),
      lastActiveAt: formatThreadActivityTime(session.lastEventAt),
      userInputTurns: String(session.userInputTurns ?? '-'),
      bridgeId: binding?.bridgeSessionId ? binding.bridgeSessionId.slice(0, 8) : '',
      threadId: session.threadId || '-',
      creator: formatLocalRuntimeCreator(session),
      active: binding?.active || false,
      selected: Boolean(binding?.bindingId),
    };
  });
}

function buildThreadCommandCardTable(rows: ThreadCommandTableRow[]) {
  return {
    pageSize: 6,
    rowHeight: 'low' as const,
    freezeFirstColumn: false,
    columns: THREAD_COMMAND_TABLE_COLUMNS.map((column) => ({
      name: column.name,
      displayName: column.displayName,
      width: column.width,
      ...(column.dataType ? { dataType: column.dataType } : {}),
      ...(column.horizontalAlign ? { horizontalAlign: column.horizontalAlign } : {}),
    })),
    rows: buildThreadCommandTableCardRows(rows),
  };
}

function buildThreadCardActionRows(buttons: OutboundCardActionButton[]): OutboundCardActionButton[][] {
  const rows: OutboundCardActionButton[][] = [];
  for (let index = 0; index < buttons.length; index += THREAD_CARD_ACTIONS_PER_ROW) {
    rows.push(buttons.slice(index, index + THREAD_CARD_ACTIONS_PER_ROW));
  }
  return rows;
}

function buildRuntimeThreadSelect(
  runtime: LocalSessionListRuntime,
  items: GlobalThreadListItem[],
  selectedCallbackData: string | undefined,
): NonNullable<OutboundRichCard['selects']>[number] | null {
  const options = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.kind === 'local' && localRuntimeOf(item.local) === runtime)
    .map(({ item, index }) => {
      const local = item.kind === 'local' ? item.local : null;
      return {
        text: `${index + 1}. ${local?.title || local?.cwd || '未命名线程'}`,
        callbackData: `${THREAD_SELECT_CALLBACK_PREFIX}${encodeURIComponent(local?.threadId || '')}`,
      };
    });
  if (options.length === 0) return null;
  const runtimeLabel = runtime === 'claude' ? 'Claude Code' : runtime === 'kimi' ? 'Kimi Code' : runtime === 'cursor' ? 'Cursor Agent' : 'Codex';
  return {
    id: `${runtime}_select`,
    placeholder: `选择 ${runtimeLabel} 会话`,
    selectedCallbackData,
    options,
  };
}

function buildRuntimeThreadTableBlock(
  runtime: LocalSessionListRuntime,
  items: GlobalThreadListItem[],
  rows: ThreadCommandTableRow[],
  selectedCallbackData: string | undefined,
  showAll: boolean,
  limit: number | undefined,
): NonNullable<OutboundRichCard['tableBlocks']>[number] {
  const numberedItems = items.map((item, index) => ({ item, row: rows[index] })).filter(({ row }) => Boolean(row));
  const runtimeRows = numberedItems
    .filter(({ item }) => item.kind === 'local' && localRuntimeOf(item.local) === runtime)
    .map(({ row }) => row);
  const select = buildRuntimeThreadSelect(runtime, items, selectedCallbackData);
  const label = runtime === 'claude' ? 'Claude Code' : runtime === 'kimi' ? 'Kimi Code' : runtime === 'cursor' ? 'Cursor Agent' : 'Codex';
  const refreshCommand = showAll
    ? `/t ${runtime} n ${limit || MAX_LOCAL_SESSION_LIST_LIMIT}`
    : limit && limit !== DEFAULT_LOCAL_SESSION_LIST_LIMIT
      ? `/t ${runtime} n ${limit}`
      : `/t ${runtime}`;
  return {
    subtitle: runtimeRows.length > 0
      ? `选择一个 ${label} 会话后，可接管、归档、新建、解绑或刷新。`
      : `当前显示范围内没有 ${label} 会话。`,
    table: buildThreadCommandCardTable(runtimeRows),
    selects: [
      ...(select ? [select] : []),
      buildThreadLimitSelect(limit, `${runtime}_limit_select`, runtime),
      buildRuntimeSelect(runtime, limit),
    ],
    actions: buildThreadCardActionRows([
      {
        text: '接管',
        callbackData: buildThreadActionCallbackData('global', 'switch'),
        type: 'primary',
      },
      {
        text: '归档',
        callbackData: buildThreadActionCallbackData('global', 'archive'),
        type: 'danger',
      },
      {
        text: '新建',
        callbackData: buildCommandCallbackData(NEW_SESSION_FORM_COMMAND),
        type: 'primary',
      },
      {
        text: '解绑',
        callbackData: buildCommandCallbackData('/t unbind'),
        type: 'default',
      },
      {
        text: '刷新',
        callbackData: buildCommandCallbackData(refreshCommand),
        type: 'default',
      },
    ]),
    footer: [
      runtimeRows.length > 0
        ? '按钮会作用于下拉中选中的会话；纯文本仍可用表格序号操作。'
        : '可用卡片下拉或 `/t n 50`、`/t n 100` 调整显示数量。',
    ],
  };
}

export function buildBoundThreadsCommandResponse(
  bindings: BoundThreadCardItem[],
  markdown: boolean,
): string {
  return buildThreadCommandTableResponse(
    '当前聊天绑定',
    buildBoundThreadCommandTableRows(bindings),
    [
      '`/t <序号|bridge-id|thread/session-id|名称>` 接管到当前聊天；`/t rename <名称>` 重命名当前会话并同步群聊名称，真实群名自动带 `[botname]` 前缀。',
      '`/t` 和 `/t archive` 的序号来自全局本地会话表。',
    ],
    markdown,
  );
}

function hasReachedLocalRuntimeSessionDisplayLimit(actualCount: number, limit: number | undefined): boolean {
  return limit === MAX_LOCAL_SESSION_LIST_LIMIT && actualCount >= MAX_LOCAL_SESSION_LIST_LIMIT;
}

export function buildLocalRuntimeSessionLimitNotice(actualCount: number, limit: number | undefined): string | null {
  if (!hasReachedLocalRuntimeSessionDisplayLimit(actualCount, limit)) return null;
  return `已达到 ${MAX_LOCAL_SESSION_LIST_LIMIT} 条显示上限，可能还有更多本地会话未显示；可用名称或 thread/session id 缩小范围。`;
}

export function buildLocalRuntimeSessionsCommandResponse(
  localSessions: LocalRuntimeSessionSummary[],
  markdown: boolean,
  showAll: boolean,
  limit?: number,
  bindingStates: ThreadCardBindingState[] = [],
  bridgeBindings: BoundThreadCardItem[] = [],
  extraFooter: string[] = [],
): string {
  const actualCount = localSessions.length;
  const codexCount = localSessions.filter((session) => localRuntimeOf(session) === 'codex').length;
  const claudeCount = localSessions.filter((session) => localRuntimeOf(session) === 'claude').length;
  const kimiCount = localSessions.filter((session) => localRuntimeOf(session) === 'kimi').length;
  const cursorCount = localSessions.filter((session) => localRuntimeOf(session) === 'cursor').length;
  const title = formatLocalThreadListTitle(codexCount, claudeCount, kimiCount, cursorCount, 0);
  const limitNotice = buildLocalRuntimeSessionLimitNotice(actualCount, limit);
  const globalItems = buildGlobalThreadList(localSessions, []);
  return buildThreadCommandTableResponse(
    title,
    buildGlobalThreadCommandTableRows(globalItems, bindingStates),
    [
      ...(limitNotice ? [limitNotice] : []),
      ...extraFooter,
      ...(showAll
      ? [
          '发送 `/t 1` 可接管第 1 条本地会话。',
          `默认显示最近 ${DEFAULT_LOCAL_SESSION_LIST_LIMIT} 条；卡片下拉可切换 50/100。`,
          `发送 \`/t codex n 100\`、\`/t claude n 100\`、\`/t kimi n 100\` 或 \`/t cursor n 100\` 可只看最近 100 条本地会话。`,
        ]
      : [
          '发送 `/t 1` 可接管第 1 条本地会话。',
          '发送 `/t codex n 50`、`/t claude n 50`、`/t kimi n 50` 或 `/t cursor n 50` 可调整本地会话数量。',
        ]),
    ],
    markdown,
  );
}

export function buildLocalRuntimeSessionsCommandCard(
  localSessions: LocalRuntimeSessionSummary[],
  showAll: boolean,
  limit?: number,
  bindingStates: ThreadCardBindingState[] = [],
  _bridgeBindings: BoundThreadCardItem[] = [],
  options: {
    channelType?: string;
    chatId?: string;
    selectedThreadId?: string | null;
    activeRuntime?: LocalSessionListRuntime;
  } = {},
): OutboundRichCard | null {
  const actualCount = localSessions.length;
  const limitNotice = buildLocalRuntimeSessionLimitNotice(actualCount, limit);
  const selectedCallbackData = options.selectedThreadId
    ? `${THREAD_SELECT_CALLBACK_PREFIX}${encodeURIComponent(options.selectedThreadId)}`
    : undefined;
  const globalItems = buildGlobalThreadList(localSessions, []);
  const tableRows = buildGlobalThreadCommandTableRows(globalItems, bindingStates);
  const activeRuntime = options.activeRuntime === 'claude'
    ? 'claude'
    : options.activeRuntime === 'kimi'
      ? 'kimi'
      : options.activeRuntime === 'cursor'
        ? 'cursor'
      : 'codex';
  const card: OutboundRichCard = {
    title: '',
    subtitle: `${formatActiveThreadCardNumberTag('1')} 表示当前激活的对话，${formatSelectedThreadCardNumberTag('1')} 表示其他人激活的对话，bridge_id 存在表示曾经接入过 codelark。`,
    template: 'blue',
    tableBlocks: [
      buildRuntimeThreadTableBlock(activeRuntime, globalItems, tableRows, selectedCallbackData, showAll, limit),
    ],
    sections: [],
    footer: showAll
      ? [
          ...(limitNotice ? [limitNotice] : []),
          '纯文本命令：`/t 1` 接管第 1 条，`/t archive 1` 归档第 1 条。',
          '`/t` 和 `/t archive` 的序号来自这张全局本地会话表。',
        ]
      : [
          ...(limitNotice ? [limitNotice] : []),
          '纯文本命令：`/t 1` 接管第 1 条。',
          '`/t` 和 `/t archive` 的序号来自这张全局本地会话表。',
          '更多：使用卡片下拉或 `/t codex n 50`、`/t claude n 100`、`/t kimi n 100`、`/t cursor n 100` 调整显示数量。',
        ],
  };
  if (options.channelType && options.chatId) {
    card.updateKey = buildThreadCardUpdateKey('global', options.channelType, options.chatId);
    card.updateTtlMs = null;
  }
  return card;
}

export function buildBoundThreadsCommandCard(
  bindings: BoundThreadCardItem[],
  options: {
    channelType?: string;
    chatId?: string;
    selectedBindingId?: string | null;
  } = {},
): OutboundRichCard | null {
  if (bindings.length > BOUND_THREADS_CARD_MAX_ITEMS) return null;
  const selectedCallbackData = options.selectedBindingId
    ? `${THREAD_SELECT_CALLBACK_PREFIX}${encodeURIComponent(options.selectedBindingId)}`
    : undefined;
  const card: OutboundRichCard = {
    title: `当前聊天绑定（${bindings.length}）`,
    subtitle: '这张表只显示当前聊天绑定的线程。',
    template: 'blue',
    table: buildThreadCommandCardTable(buildBoundThreadCommandTableRows(bindings)),
    sections: [],
    ...(bindings.length > 0
      ? {
          selects: [{
            id: 'bound_select',
            placeholder: '选择绑定线程',
            selectedCallbackData,
            options: bindings.map((binding, index) => ({
              text: `${index + 1}. ${binding.title || binding.cwd || '未命名线程'}`,
              callbackData: `${THREAD_SELECT_CALLBACK_PREFIX}${encodeURIComponent(binding.bridgeSessionId || binding.bindingId)}`,
            })),
          }],
        }
      : {}),
    actions: buildThreadCardActionRows(bindings.length > 0
      ? [
          {
            text: '归档',
            callbackData: buildThreadActionCallbackData('bound', 'archive'),
            type: 'danger',
          },
          {
            text: '解绑',
            callbackData: buildCommandCallbackData('/t unbind'),
            type: 'default',
          },
          {
            text: '刷新',
            callbackData: buildCommandCallbackData('/t'),
            type: 'default',
          },
        ]
      : [
          {
            text: '新建',
            callbackData: buildCommandCallbackData(NEW_SESSION_FORM_COMMAND),
            type: 'primary',
          },
          {
            text: '刷新',
            callbackData: buildCommandCallbackData('/t'),
            type: 'default',
          },
        ]),
    footer: [
      '纯文本命令：`/t <序号|thread/session-id|bridge-session-id|名称>` 接管到当前聊天；`/t archive` 归档当前本地会话。',
    ],
  };
  if (options.channelType && options.chatId) {
    card.updateKey = buildThreadCardUpdateKey('bound', options.channelType, options.chatId);
    card.updateTtlMs = null;
  }
  return card;
}

export function buildNewSessionFormCard(defaultWorkingDirectory = ''): OutboundRichCard {
  return {
    title: '创建群聊会话',
    subtitle: '输入名称和工作目录后创建一个新的 IM 群聊会话。',
    template: 'blue',
    sections: [],
    form: {
      optionElementId: 'clk_new_session_option',
      inputElementId: 'clk_input',
      inputLabel: '群聊名称',
      inputPlaceholder: '例如 merge、docs、deploy',
      extraInputs: [{
        elementId: 'clk_path',
        label: '工作目录',
        placeholder: '例如 /data00/home/me/project',
        defaultValue: defaultWorkingDirectory,
      }],
      submitText: '创建',
      submitCallbackData: buildCommandCallbackData('/new'),
      options: [],
    },
    footer: [
      '提交后等同发送 `/new <名称> <目录>`。',
    ],
  };
}

export function formatCommandMessageId(id: string | undefined | null): string {
  if (!id) return '未共享';
  return id;
}

export function formatCommandDateTime(value: string | null | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) return '-';

  return formatLocalDateTime(trimmed) || trimmed;
}

function stripStoredAttachmentMarker(content: string): string {
  return content.replace(/\n?<!--files:[\s\S]*?-->$/u, '').trim();
}

export function formatStoredMessageContent(content: string): string {
  const stripped = stripStoredAttachmentMarker(content);
  if (!stripped) return '[empty]';

  try {
    const parsed = JSON.parse(stripped);
    if (!Array.isArray(parsed)) return stripped;

    const lines: string[] = [];
    for (const block of parsed) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        lines.push(block.text.trim());
        continue;
      }
      if (block.type === 'tool_use' && typeof block.name === 'string') {
        lines.push(`[tool] ${block.name}`);
        continue;
      }
      if (block.type === 'tool_result') {
        const suffix = block.is_error === true ? ' error' : '';
        if (typeof block.content === 'string' && block.content.trim()) {
          lines.push(`[tool_result${suffix}] ${block.content.trim()}`);
        } else {
          lines.push(`[tool_result${suffix}]`);
        }
      }
    }
    return lines.length > 0 ? lines.join('\n') : stripped;
  } catch {
    return stripped;
  }
}

export function truncateHistoryContent(content: string, maxChars = 800): string {
  const trimmed = content.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars)}...`;
}

export function formatHistoryRole(role: string, assistantLabel = 'Codex'): string {
  if (role === 'user') return 'User';
  if (role === 'assistant') return assistantLabel;
  return role || 'unknown';
}

export function formatRuntimeStatus(session: BridgeSession | null | undefined): string {
  const status = session?.runtime_status || 'idle';
  const queuedCount = session?.queued_count && session.queued_count > 0
    ? session.queued_count
    : 0;

  if (status === 'queued') {
    return queuedCount > 0 ? `排队中（${queuedCount}）` : '排队中';
  }
  if (status === 'running') {
    return '运行中';
  }
  return '空闲';
}

export function formatMirrorStatus(session: BridgeSession | null | undefined): string {
  if (session?.mirror_status === 'watching') {
    return session.mirror_last_event_at
      ? `监听中 · 最近同步 ${formatCommandDateTime(session.mirror_last_event_at)}`
      : '监听中';
  }
  if (session?.mirror_status === 'stale') {
    const runtime = getSessionActiveRuntime(session);
    if (runtime === 'claude') return '待恢复（暂时没定位到本地 Claude Code JSONL 文件）';
    if (runtime === 'kimi') return '待恢复（暂时没定位到本地 Kimi Code wire 文件）';
    return '待恢复（暂时没定位到本地 Codex thread 文件）';
  }
  return '未监听';
}
