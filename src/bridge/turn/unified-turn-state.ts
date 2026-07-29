import type { ContextUsageInfo } from '../../shared/progress/context-usage.js';
import type { StreamingHistoryItem, StreamingHistoryTextRole, TaskProgressInfo, ToolCallInfo } from '../../domain/index.js';
import {
  applyToolCallEventToTools,
  type ToolCallEvent,
} from '../../shared/progress/tool-events.js';

export interface UnifiedTurnGoalStatus {
  status: string;
  objective: string;
}

export interface UnifiedTurnProgressState {
  startedAtMs: number;
  lastActivityAtMs: number;
  lastContentResponseAtMs: number | null;
  statusNote: string | null;
  thinkingNote: string | null;
  taskItems: TaskProgressInfo[];
  toolCalls: Map<string, ToolCallInfo>;
  historyItems: StreamingHistoryItem[];
  historyTextSnapshot: string;
  contextUsage: ContextUsageInfo | null;
  goalStatus?: UnifiedTurnGoalStatus | null;
}

function normalizeTimestampMs(timestampMs: number): number {
  return Number.isFinite(timestampMs) ? timestampMs : Date.now();
}

export function createUnifiedTurnProgressState(startedAtMs: number): UnifiedTurnProgressState {
  const safeStartedAtMs = normalizeTimestampMs(startedAtMs);
  return {
    startedAtMs: safeStartedAtMs,
    lastActivityAtMs: safeStartedAtMs,
    lastContentResponseAtMs: null,
    statusNote: null,
    thinkingNote: null,
    taskItems: [],
    toolCalls: new Map(),
    historyItems: createInitialStreamingHistoryItems(),
    historyTextSnapshot: '',
    contextUsage: null,
  };
}

export function createInitialStreamingHistoryItems(): StreamingHistoryItem[] {
  return [];
}

function cloneStreamingHistoryItems(items: StreamingHistoryItem[]): StreamingHistoryItem[] {
  return items.map((item) => item.type === 'tool_panel'
    ? { ...item, tools: item.tools.slice() }
    : { ...item });
}

function historyItemsForAppend(state: Pick<UnifiedTurnProgressState, 'historyItems'>): StreamingHistoryItem[] {
  const items = cloneStreamingHistoryItems(state.historyItems);
  state.historyItems = items;
  return items;
}

function appendHistoryMarkdown(
  state: Pick<UnifiedTurnProgressState, 'historyItems'>,
  role: StreamingHistoryTextRole,
  content: string,
): void {
  const normalized = content.trim();
  if (!normalized) return;
  const items = historyItemsForAppend(state);
  items.push({ type: 'markdown', role, content: normalized });
}

function currentHistoryToolPanel(items: StreamingHistoryItem[]): Extract<StreamingHistoryItem, { type: 'tool_panel' }> {
  const last = items.at(-1);
  if (last?.type === 'tool_panel') return last;
  const panel: Extract<StreamingHistoryItem, { type: 'tool_panel' }> = { type: 'tool_panel', tools: [] };
  items.push(panel);
  return panel;
}

function appendHistoryModelText(
  state: Pick<UnifiedTurnProgressState, 'historyItems'>,
  content: string,
): void {
  const normalized = content.trim();
  if (!normalized) return;
  const items = historyItemsForAppend(state);
  items.push({ type: 'markdown', role: 'assistant', content: normalized });
}

function appendOrExtendHistoryModelSnapshotText(
  state: Pick<UnifiedTurnProgressState, 'historyItems'>,
  content: string,
): void {
  const normalized = content.trim();
  if (!normalized) return;
  const items = historyItemsForAppend(state);
  const last = items.at(-1);
  if (
    last?.type === 'markdown'
    && last.role === 'assistant'
  ) {
    last.content = `${last.content}${normalized}`;
    return;
  }
  items.push({ type: 'markdown', role: 'assistant', content: normalized });
}

function mergeToolCallInfo(previous: ToolCallInfo | undefined, next: ToolCallInfo): ToolCallInfo {
  if (!previous) return next;
  return {
    ...previous,
    ...next,
    name: next.name || previous.name,
    input: next.input ?? previous.input,
    output: next.output ?? previous.output,
    detail: next.detail ?? previous.detail,
  };
}

export function applyUnifiedTurnHistoryUserText(
  state: Pick<UnifiedTurnProgressState, 'historyItems'>,
  content: string,
): void {
  appendHistoryMarkdown(state, 'user', content);
}

export function applyUnifiedTurnHistorySystemText(
  state: Pick<UnifiedTurnProgressState, 'historyItems'>,
  content: string,
): void {
  appendHistoryMarkdown(state, 'system', content);
}

export function applyUnifiedTurnHistoryModelText(
  state: Pick<UnifiedTurnProgressState, 'historyItems'>,
  content: string,
): void {
  appendHistoryModelText(state, content);
}

export function applyUnifiedTurnHistoryModelTextSnapshot(
  state: Pick<UnifiedTurnProgressState, 'historyItems' | 'historyTextSnapshot'>,
  nextText: string,
): void {
  const normalizedNext = (nextText || '').trim();
  if (!normalizedNext) return;
  const normalizedPrevious = (state.historyTextSnapshot || '').trim();
  if (normalizedPrevious && !normalizedNext.startsWith(normalizedPrevious)) {
    state.historyItems = cloneStreamingHistoryItems(state.historyItems)
      .filter((item) => item.type !== 'markdown' || item.role !== 'assistant');
    state.historyTextSnapshot = nextText;
    appendHistoryModelText(state, normalizedNext);
    return;
  }
  const delta = normalizedPrevious && normalizedNext.startsWith(normalizedPrevious)
    ? normalizedNext.slice(normalizedPrevious.length)
    : normalizedNext;
  state.historyTextSnapshot = nextText;
  if (delta.trim()) {
    appendOrExtendHistoryModelSnapshotText(state, delta);
  }
}

export function applyUnifiedTurnHistoryTools(
  state: Pick<UnifiedTurnProgressState, 'historyItems'>,
  tools: ToolCallInfo[],
): void {
  if (tools.length === 0) return;
  const items = cloneStreamingHistoryItems(state.historyItems);
  state.historyItems = items;
  const panels = items.filter((item): item is Extract<StreamingHistoryItem, { type: 'tool_panel' }> => item.type === 'tool_panel');
  const knownToolPanel = new Map<string, Extract<StreamingHistoryItem, { type: 'tool_panel' }>>();
  for (const panel of panels) {
    for (const tool of panel.tools) {
      knownToolPanel.set(tool.id, panel);
    }
  }
  const panelForNewTools = currentHistoryToolPanel(items);
  for (const tool of tools) {
    const targetPanel = knownToolPanel.get(tool.id) || panelForNewTools;
    const existingIndex = targetPanel.tools.findIndex((item) => item.id === tool.id);
    if (existingIndex >= 0) {
      targetPanel.tools[existingIndex] = mergeToolCallInfo(targetPanel.tools[existingIndex], tool);
    } else {
      targetPanel.tools.push(tool);
      knownToolPanel.set(tool.id, targetPanel);
    }
  }
}

export function recordUnifiedTurnActivity(
  state: Pick<UnifiedTurnProgressState, 'lastActivityAtMs'>,
  timestampMs: number,
): void {
  if (!Number.isFinite(timestampMs)) return;
  state.lastActivityAtMs = Math.max(state.lastActivityAtMs, timestampMs);
}

export function recordUnifiedTurnContentResponse(
  state: Pick<UnifiedTurnProgressState, 'lastActivityAtMs' | 'lastContentResponseAtMs'>,
  timestampMs: number,
): void {
  if (!Number.isFinite(timestampMs)) return;
  recordUnifiedTurnActivity(state, timestampMs);
  state.lastContentResponseAtMs = timestampMs;
}

export function applyUnifiedTurnStatusNote(
  state: Pick<UnifiedTurnProgressState, 'lastActivityAtMs' | 'statusNote'>,
  note: string | null | undefined,
  timestampMs?: number,
): void {
  state.statusNote = (note || '').trim() || null;
  if (state.statusNote && typeof timestampMs === 'number') {
    recordUnifiedTurnActivity(state, timestampMs);
  }
}

export function applyUnifiedTurnThinkingNote(
  state: Pick<UnifiedTurnProgressState, 'lastActivityAtMs' | 'thinkingNote'>,
  note: string | null | undefined,
  timestampMs?: number,
): void {
  state.thinkingNote = (note || '').trim() || null;
  if (state.thinkingNote && typeof timestampMs === 'number') {
    recordUnifiedTurnActivity(state, timestampMs);
  }
}

export function applyUnifiedTurnTasks(
  state: Pick<UnifiedTurnProgressState, 'lastActivityAtMs' | 'taskItems'>,
  tasks: TaskProgressInfo[],
  timestampMs?: number,
): void {
  state.taskItems = tasks;
  if (typeof timestampMs === 'number') {
    recordUnifiedTurnActivity(state, timestampMs);
  }
}

export function applyUnifiedTurnContextUsage(
  state: Pick<UnifiedTurnProgressState, 'lastActivityAtMs' | 'contextUsage'>,
  contextUsage: ContextUsageInfo | null | undefined,
  timestampMs?: number,
): void {
  state.contextUsage = contextUsage || null;
  if (typeof timestampMs === 'number') {
    recordUnifiedTurnActivity(state, timestampMs);
  }
}

export function applyUnifiedTurnGoalStatus(
  state: Pick<UnifiedTurnProgressState, 'lastActivityAtMs' | 'goalStatus'>,
  goalStatus: UnifiedTurnGoalStatus | null | undefined,
  timestampMs?: number,
): void {
  state.goalStatus = goalStatus || null;
  if (typeof timestampMs === 'number') {
    recordUnifiedTurnActivity(state, timestampMs);
  }
}

export function applyUnifiedTurnToolEvent(
  state: Pick<UnifiedTurnProgressState, 'lastActivityAtMs' | 'toolCalls' | 'historyItems'>,
  event: ToolCallEvent,
  options: { timestampMs?: number } = {},
): void {
  const resolvedToolId = applyToolCallEventToTools(state.toolCalls, event);
  const tool = resolvedToolId ? state.toolCalls.get(resolvedToolId) : null;
  if (tool) {
    applyUnifiedTurnHistoryTools(state, [tool]);
  }
  if (typeof options.timestampMs === 'number') {
    recordUnifiedTurnActivity(state, options.timestampMs);
  }
}
