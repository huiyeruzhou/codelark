import {
  createCodexEventSignature,
  extractCodexMessageText,
  extractNormalizedFreeText,
  extractNormalizedStructuredText,
  extractReasoningSummary,
  formatCodexToolName,
  isSessionEventLine,
  isSessionMessageLine,
  isTurnContextLine,
  parseUpdatePlanTasks,
  renderCodexCliUpdateEvent,
  type BridgeMirrorRecord,
  type BridgeMirrorRecordDelta,
  type CodexSessionEvent,
  type CodexSessionEventDelta,
  type SessionEventLine,
  type SessionMessageLine,
  type TurnContextLine,
} from './jsonl-types.js';
import {
  renderCodexInternalTextForDisplay,
  resolveCodexJsonlDisplayText,
  TURN_ABORTED_NOTICE,
} from './internal-control-events.js';
import {
  parseContextUsageInfo,
} from '../../../shared/progress/context-usage.js';
import {
  bridgeMirrorRecordFromSessionToolEvent,
  codexSessionToolEventFromEventMessage,
  codexSessionToolEventFromResponseItem,
} from './tool-call-events.js';
import { normalizeCodexToolCall } from './tool-call-normalizer.js';

function compactInternalDisplayText(text: string): string {
  return renderCodexInternalTextForDisplay(text);
}

function resolveCodexUserMessageDisplay(
  text: string,
  options: { forceUser?: boolean } = {},
): { role: 'user' | 'system'; content: string } | null {
  const display = resolveCodexJsonlDisplayText(text);
  if (display.kind === 'hidden') return null;
  return {
    role: display.kind === 'notice' && options.forceUser !== true ? 'system' : 'user',
    content: display.content,
  };
}

function extractCodexUserPrompt(payload: { user_prompt?: unknown; userPrompt?: unknown } | undefined): string {
  return extractNormalizedStructuredText(payload?.user_prompt ?? payload?.userPrompt);
}

const IGNORED_EVENT_MSG_TYPES = new Set([
  'thread_name_updated',
  'thread_rolled_back',
  'thread_settings_applied',
]);

const CONTEXT_COMPACTED_NOTICE = '> ⚙️ 上下文已压缩，后续回复会基于压缩后的上下文继续。';

const IGNORED_RESPONSE_ITEM_TYPES = new Set([
  'web_search_call',
]);

const IGNORED_RESPONSE_MESSAGE_ROLES = new Set([
  'developer',
  'system',
  'tool',
]);

function renderThreadGoalUpdated(payload: SessionEventLine['payload']): string {
  const goal = payload && typeof payload === 'object' ? (payload as { goal?: unknown }).goal : null;
  const goalRecord = goal && typeof goal === 'object' ? goal as Record<string, unknown> : null;
  const status = extractNormalizedFreeText(goalRecord?.status).trim();
  const objective = extractNormalizedStructuredText(
    goalRecord?.objective
      ?? goalRecord?.message
      ?? goalRecord?.content
      ?? goalRecord?.text
      ?? goal,
  );
  const label = status
    ? `Goal ${status.slice(0, 1).toUpperCase()}${status.slice(1)}`
    : 'Goal';
  return objective ? `${label}\n\n${objective}` : label;
}

function isIgnoredMirrorLineKind(line: SessionMessageLine | SessionEventLine | TurnContextLine): boolean {
  if (isSessionEventLine(line)) {
    const payloadType = typeof line.payload?.type === 'string' ? line.payload.type.trim() : '';
    return IGNORED_EVENT_MSG_TYPES.has(payloadType);
  }
  if (isSessionMessageLine(line)) {
    const payloadType = typeof line.payload?.type === 'string' ? line.payload.type.trim() : '';
    if (payloadType === 'message') {
      const role = typeof line.payload?.role === 'string' ? line.payload.role.trim() : '';
      return IGNORED_RESPONSE_MESSAGE_ROLES.has(role);
    }
    return IGNORED_RESPONSE_ITEM_TYPES.has(payloadType);
  }
  return false;
}

function isGoalInternalContextText(text: string): boolean {
  const normalized = text.trim();
  return normalized.startsWith('<codex_internal_context source="goal">')
    || normalized.startsWith('<codex_internal_context source=\'goal\'>');
}

function extractThreadGoal(payload: SessionEventLine['payload']): {
  status: string;
  objective: string;
  turnId: string;
} | null {
  const goal = payload?.goal;
  if (!goal || typeof goal !== 'object') return null;
  const goalRecord = goal as Record<string, unknown>;
  const status = extractNormalizedFreeText(goalRecord.status);
  const objective = extractNormalizedStructuredText(goalRecord.objective);
  if (!status && !objective) return null;
  return {
    status: status || 'active',
    objective,
    turnId: extractNormalizedFreeText(payload?.turnId ?? payload?.turn_id),
  };
}

function hasRecentDuplicateMessageRecord(
  records: BridgeMirrorRecord[],
  role: NonNullable<BridgeMirrorRecord['role']>,
  content: string,
  timestamp: string,
  turnId: string | null,
): boolean {
  const previous = [...records].reverse().find((record) => record.type === 'message' && record.role === role);
  if (!previous || previous.content !== content) return false;
  if (turnId && previous.turnId && previous.turnId !== turnId) return false;
  if (!timestamp || !previous.timestamp) return true;
  const previousMs = Date.parse(previous.timestamp);
  const nextMs = Date.parse(timestamp);
  if (!Number.isFinite(previousMs) || !Number.isFinite(nextMs)) return true;
  return Math.abs(nextMs - previousMs) <= 2_000;
}

function describeUnhandledMirrorLineKind(
  line: SessionMessageLine | SessionEventLine | TurnContextLine,
): string | null {
  if (isIgnoredMirrorLineKind(line)) return null;
  if (isSessionEventLine(line)) {
    const payloadType = typeof line.payload?.type === 'string' ? line.payload.type.trim() : '';
    return `event_msg:${payloadType || '<unknown>'}`;
  }
  if (isSessionMessageLine(line)) {
    const payloadType = typeof line.payload?.type === 'string' ? line.payload.type.trim() : '';
    return `response_item:${payloadType || '<unknown>'}`;
  }
  return null;
}

function pushCodexSessionEvent(
  events: CodexSessionEvent[],
  parsed: SessionMessageLine | SessionEventLine,
  rawLine: string,
): void {
  if (isSessionEventLine(parsed) && parsed.payload?.type === 'context_compacted') {
    events.push({
      signature: createCodexEventSignature(rawLine),
      role: 'commentary',
      content: CONTEXT_COMPACTED_NOTICE,
      timestamp: parsed.timestamp || '',
    });
    return;
  }

  if (isSessionEventLine(parsed) && parsed.payload?.type === 'user_message') {
    const text = extractNormalizedStructuredText(parsed.payload.message);
    if (!text) return;
    const userPrompt = extractCodexUserPrompt(parsed.payload);
    if (!userPrompt && isGoalInternalContextText(text)) return;
    const display = resolveCodexUserMessageDisplay(userPrompt || text, { forceUser: Boolean(userPrompt) });
    if (!display) return;
    const { role, content } = display;
    const lastEvent = events[events.length - 1];
    if (lastEvent?.role === role && lastEvent.content === content) return;
    events.push({
      signature: createCodexEventSignature(rawLine),
      role,
      content,
      ...(role === 'user' && userPrompt ? { userPrompt } : {}),
      timestamp: parsed.timestamp || '',
    });
    return;
  }

  if (isSessionEventLine(parsed) && parsed.payload?.type === 'agent_message') {
    const text = extractNormalizedStructuredText(parsed.payload.message);
    if (!text) return;
    const role = parsed.payload.phase === 'commentary' ? 'commentary' : 'assistant';
    const lastEvent = events[events.length - 1];
    if (lastEvent?.role === role && lastEvent.content === text) return;
    events.push({
      signature: createCodexEventSignature(rawLine),
      role,
      content: text,
      timestamp: parsed.timestamp || '',
    });
    return;
  }

  if (isSessionEventLine(parsed) && parsed.payload?.type === 'task_complete') {
    const text = extractNormalizedStructuredText(parsed.payload.last_agent_message);
    if (!text) return;

    const lastEvent = events[events.length - 1];
    if (lastEvent?.role === 'assistant' && lastEvent.content === text) {
      return;
    }

    events.push({
      signature: createCodexEventSignature(rawLine),
      role: 'assistant',
      content: text,
      timestamp: parsed.timestamp || '',
    });
    return;
  }

  if (isSessionEventLine(parsed) && parsed.payload?.type === 'thread_goal_updated') {
    const text = renderThreadGoalUpdated(parsed.payload);
    if (!text) return;
    events.push({
      signature: createCodexEventSignature(rawLine),
      role: 'commentary',
      content: text,
      timestamp: parsed.timestamp || '',
    });
    return;
  }

  if (isSessionEventLine(parsed) && parsed.payload?.type === 'update_cli') {
    events.push({
      signature: createCodexEventSignature(rawLine),
      role: 'commentary',
      content: renderCodexCliUpdateEvent(parsed.payload),
      timestamp: parsed.timestamp || '',
    });
    return;
  }

  if (isSessionMessageLine(parsed) && parsed.payload?.type === 'message') {
    const text = extractCodexMessageText(parsed);
    if (!text) return;
    if (parsed.payload.role !== 'assistant' && parsed.payload.role !== 'user') return;
    const userPrompt = parsed.payload.role === 'user' ? extractCodexUserPrompt(parsed.payload) : '';
    if (parsed.payload.role === 'user' && !userPrompt && isGoalInternalContextText(text)) return;
    const userDisplay = parsed.payload.role === 'user'
      ? resolveCodexUserMessageDisplay(userPrompt || text, { forceUser: Boolean(userPrompt) })
      : null;
    const role = parsed.payload.role === 'user'
      ? userDisplay?.role
      : parsed.payload.phase === 'commentary' ? 'commentary' : 'assistant';
    const content = parsed.payload.role === 'assistant' && parsed.payload.phase === 'commentary'
      ? text.replace(/^\[commentary\]\n/, '')
      : parsed.payload.role === 'user'
        ? userDisplay?.content
        : text;
    if (!role || !content) return;
    const lastEvent = events[events.length - 1];
    if (lastEvent?.role === role && lastEvent.content === content) return;
    events.push({
      signature: createCodexEventSignature(rawLine),
      role,
      content,
      ...(role === 'user' && userPrompt ? { userPrompt } : {}),
      timestamp: parsed.timestamp || '',
    });
  }
}

function pushCodexMirrorRecord(
  records: BridgeMirrorRecord[],
  parsed: SessionMessageLine | SessionEventLine | TurnContextLine,
  rawLine: string,
  activeTurnId: string | null,
  activeSpecialCallIds: Set<string>,
): boolean {
  if (isSessionEventLine(parsed)) {
    return pushCodexMirrorEventRecord(records, parsed, rawLine, activeTurnId);
  }
  if (isSessionMessageLine(parsed)) {
    return pushCodexMirrorResponseRecord(records, parsed, rawLine, activeTurnId, activeSpecialCallIds);
  }
  return false;
}

function pushCodexMirrorEventRecord(
  records: BridgeMirrorRecord[],
  parsed: SessionEventLine,
  rawLine: string,
  activeTurnId: string | null,
): boolean {
  const signature = createCodexEventSignature(rawLine);
  const timestamp = parsed.timestamp || '';

  if (parsed.payload?.type === 'task_started') {
    records.push({
      signature,
      type: 'task_started',
      content: '',
      timestamp,
      turnId: parsed.payload.turn_id || '',
    });
    return true;
  }

  if (parsed.payload?.type === 'turn_aborted') {
    records.push({
      signature,
      type: 'task_aborted',
      content: TURN_ABORTED_NOTICE,
      timestamp,
      ...(activeTurnId ? { turnId: activeTurnId } : {}),
    });
    return true;
  }

  if (parsed.payload?.type === 'context_compacted') {
    records.push({
      signature,
      type: 'message',
      role: 'commentary',
      content: CONTEXT_COMPACTED_NOTICE,
      timestamp,
      ...(activeTurnId ? { turnId: activeTurnId } : {}),
    });
    return true;
  }

  if (parsed.payload?.type === 'token_count') {
    const contextUsage = parseContextUsageInfo((parsed.payload as Record<string, unknown>).info);
    if (contextUsage) {
      records.push({
        signature,
        type: 'context_usage',
        content: '',
        timestamp,
        ...(activeTurnId ? { turnId: activeTurnId } : {}),
        contextUsage,
      });
    }
    return true;
  }

  if (parsed.payload?.type === 'thread_goal_updated') {
    const goal = extractThreadGoal(parsed.payload);
    if (!goal) return true;
    records.push({
      signature,
      type: 'goal_status',
      content: goal.objective,
      timestamp,
      ...(goal.turnId || activeTurnId ? { turnId: goal.turnId || activeTurnId || undefined } : {}),
      goalStatus: goal.status,
      goalObjective: goal.objective,
    });
    return true;
  }

  if (parsed.payload?.type === 'update_cli') {
    records.push({
      signature,
      type: 'message',
      role: 'commentary',
      content: renderCodexCliUpdateEvent(parsed.payload),
      timestamp,
      ...(activeTurnId ? { turnId: activeTurnId } : {}),
    });
    return true;
  }

  if (isIgnoredMirrorLineKind(parsed)) {
    return true;
  }

  if (parsed.payload?.type === 'agent_message') {
    const text = extractNormalizedStructuredText(parsed.payload.message);
    if (!text) return true;
    records.push({
      signature,
      type: 'message',
      role: parsed.payload.phase === 'commentary' ? 'commentary' : 'assistant',
      content: text,
      timestamp,
      ...(activeTurnId ? { turnId: activeTurnId } : {}),
    });
    return true;
  }

  if (parsed.payload?.type === 'agent_reasoning') {
    const text = extractNormalizedStructuredText(parsed.payload.text);
    if (!text) return true;
    records.push({
      signature,
      type: 'reasoning',
      content: text,
      timestamp,
      ...(activeTurnId ? { turnId: activeTurnId } : {}),
    });
    return true;
  }

  const toolEvent = codexSessionToolEventFromEventMessage(parsed.payload, signature, activeTurnId);
  if (toolEvent) {
    records.push(bridgeMirrorRecordFromSessionToolEvent(toolEvent, { signature, timestamp }));
    return true;
  }

  if (parsed.payload?.type === 'user_message') {
    const text = extractNormalizedStructuredText(parsed.payload.message);
    if (!text) return true;
    const userPrompt = extractCodexUserPrompt(parsed.payload);
    if (!userPrompt && isGoalInternalContextText(text)) return true;
    const display = resolveCodexUserMessageDisplay(userPrompt || text, { forceUser: Boolean(userPrompt) });
    if (!display) return true;
    const { role, content } = display;
    if (hasRecentDuplicateMessageRecord(records, role, content, timestamp, activeTurnId)) return true;
    records.push({
      signature,
      type: 'message',
      role,
      content: compactInternalDisplayText(content),
      ...(role === 'user' && userPrompt ? { userPrompt } : {}),
      timestamp,
      ...(activeTurnId ? { turnId: activeTurnId } : {}),
    });
    return true;
  }

  if (parsed.payload?.type === 'task_complete') {
    const errorText = extractNormalizedStructuredText(parsed.payload.error);
    records.push({
      signature,
      type: 'task_complete',
      role: 'assistant',
      content: extractNormalizedStructuredText(parsed.payload.last_agent_message),
      timestamp,
      turnId: parsed.payload.turn_id || '',
      ...(errorText ? { isError: true, errorText } : {}),
    });
    return true;
  }

  return false;
}

function pushCodexMirrorResponseRecord(
  records: BridgeMirrorRecord[],
  parsed: SessionMessageLine,
  rawLine: string,
  activeTurnId: string | null,
  activeSpecialCallIds: Set<string>,
): boolean {
  const signature = createCodexEventSignature(rawLine);
  const timestamp = parsed.timestamp || '';

  if (isIgnoredMirrorLineKind(parsed)) {
    return true;
  }

  if (parsed.payload?.type === 'reasoning') {
    const text = extractReasoningSummary(parsed.payload);
    if (!text) return true;
    records.push({
      signature,
      type: 'reasoning',
      content: text,
      timestamp,
      ...(activeTurnId ? { turnId: activeTurnId } : {}),
    });
    return true;
  }

  if (parsed.payload?.type === 'message' && parsed.payload.role === 'user') {
    const text = extractCodexMessageText(parsed);
    if (!text) return true;
    const userPrompt = extractCodexUserPrompt(parsed.payload);
    if (!userPrompt && isGoalInternalContextText(text)) return true;
    const display = resolveCodexUserMessageDisplay(userPrompt || text, { forceUser: Boolean(userPrompt) });
    if (!display) return true;
    const { role, content } = display;
    records.push({
      signature,
      type: 'message',
      role,
      content,
      ...(role === 'user' && userPrompt ? { userPrompt } : {}),
      timestamp,
      ...(activeTurnId ? { turnId: activeTurnId } : {}),
    });
    return true;
  }

  if (parsed.payload?.type === 'message' && parsed.payload.role === 'assistant') {
    const text = extractCodexMessageText(parsed);
    if (!text) return true;
    records.push({
      signature,
      type: 'message',
      role: parsed.payload.phase === 'commentary' ? 'commentary' : 'assistant',
      content: parsed.payload.phase === 'commentary' ? text.replace(/^\[commentary\]\n/, '') : text,
      timestamp,
      ...(activeTurnId ? { turnId: activeTurnId } : {}),
    });
    return true;
  }

  if (parsed.payload?.type === 'function_call') {
    const rawToolName = formatCodexToolName(parsed.payload.namespace, parsed.payload.name);
    const toolId = extractNormalizedFreeText(parsed.payload.call_id) || signature;
    if (!rawToolName) return true;
    const normalized = normalizeCodexToolCall(rawToolName, parsed.payload.arguments);
    const toolName = normalized.name;
    if (toolName === 'update_plan') {
      const tasks = parseUpdatePlanTasks(normalized.input);
      activeSpecialCallIds.add(toolId);
      records.push({
        signature,
        type: 'plan_update',
        content: '',
        timestamp,
        ...(activeTurnId ? { turnId: activeTurnId } : {}),
        tasks,
      });
      return true;
    }
    const toolEvent = codexSessionToolEventFromResponseItem(parsed.payload, signature, activeTurnId);
    if (toolEvent) records.push(bridgeMirrorRecordFromSessionToolEvent(toolEvent, { signature, timestamp }));
    return true;
  }

  if (parsed.payload?.type === 'custom_tool_call') {
    const rawToolName = formatCodexToolName(parsed.payload.namespace, parsed.payload.name);
    const toolId = extractNormalizedFreeText(parsed.payload.call_id) || signature;
    if (!rawToolName) return true;
    const normalized = normalizeCodexToolCall(rawToolName, parsed.payload.input);
    const toolName = normalized.name;
    if (toolName === 'update_plan') {
      const tasks = parseUpdatePlanTasks(normalized.input);
      activeSpecialCallIds.add(toolId);
      records.push({
        signature,
        type: 'plan_update',
        content: '',
        timestamp,
        ...(activeTurnId ? { turnId: activeTurnId } : {}),
        tasks,
      });
      return true;
    }
    const toolEvent = codexSessionToolEventFromResponseItem(parsed.payload, signature, activeTurnId);
    if (toolEvent) records.push(bridgeMirrorRecordFromSessionToolEvent(toolEvent, { signature, timestamp }));
    return true;
  }

  if (parsed.payload?.type === 'function_call_output') {
    const toolId = extractNormalizedFreeText(parsed.payload.call_id) || signature;
    if (activeSpecialCallIds.has(toolId)) {
      activeSpecialCallIds.delete(toolId);
      return true;
    }
    const toolEvent = codexSessionToolEventFromResponseItem(parsed.payload, signature, activeTurnId);
    if (toolEvent) records.push(bridgeMirrorRecordFromSessionToolEvent(toolEvent, { signature, timestamp }));
    return true;
  }

  if (parsed.payload?.type === 'custom_tool_call_output') {
    const toolId = extractNormalizedFreeText(parsed.payload.call_id) || signature;
    if (activeSpecialCallIds.has(toolId)) {
      activeSpecialCallIds.delete(toolId);
      return true;
    }
    const toolEvent = codexSessionToolEventFromResponseItem(parsed.payload, signature, activeTurnId);
    if (toolEvent) records.push(bridgeMirrorRecordFromSessionToolEvent(toolEvent, { signature, timestamp }));
    return true;
  }

  const toolEvent = codexSessionToolEventFromResponseItem(parsed.payload, signature, activeTurnId);
  if (toolEvent) {
    records.push(bridgeMirrorRecordFromSessionToolEvent(toolEvent, { signature, timestamp }));
    return true;
  }

  return false;
}

export function parseCodexSessionEventText(
  content: string,
  leadingText = '',
  flushTrailingText = false,
): CodexSessionEventDelta {
  const combined = `${leadingText}${content}`;
  if (!combined) {
    return {
      events: [],
      nextOffset: 0,
      trailingText: '',
    };
  }

  const hasTrailingNewline = combined.endsWith('\n') || combined.endsWith('\r');
  const rawLines = combined.split(/\r?\n/);
  let trailingText = hasTrailingNewline ? '' : (rawLines.pop() || '');
  if (flushTrailingText && trailingText) {
    rawLines.push(trailingText);
    trailingText = '';
  }
  const events: CodexSessionEvent[] = [];

  for (const line of rawLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed: SessionMessageLine | SessionEventLine;
    try {
      parsed = JSON.parse(trimmed) as SessionMessageLine | SessionEventLine;
    } catch {
      continue;
    }

    pushCodexSessionEvent(events, parsed, trimmed);
  }

  return {
    events,
    nextOffset: 0,
    trailingText,
  };
}

export function parseCodexMirrorRecordText(
  content: string,
  leadingText = '',
  flushTrailingText = false,
  initialTurnId: string | null = null,
  initialSpecialCallIds: Iterable<string> = [],
): BridgeMirrorRecordDelta {
  const combined = `${leadingText}${content}`;
  if (!combined) {
    return {
      records: [],
      nextOffset: 0,
      trailingText: '',
      nextTurnId: initialTurnId,
      nextSpecialCallIds: [],
      unknownKinds: [],
    };
  }

  const hasTrailingNewline = combined.endsWith('\n') || combined.endsWith('\r');
  const rawLines = combined.split(/\r?\n/);
  let trailingText = hasTrailingNewline ? '' : (rawLines.pop() || '');
  if (flushTrailingText && trailingText) {
    rawLines.push(trailingText);
    trailingText = '';
  }
  const records: BridgeMirrorRecord[] = [];
  let activeTurnId = initialTurnId;
  const activeSpecialCallIds = new Set(initialSpecialCallIds);
  const unknownKinds = new Set<string>();

  for (const line of rawLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed: SessionMessageLine | SessionEventLine | TurnContextLine;
    try {
      parsed = JSON.parse(trimmed) as SessionMessageLine | SessionEventLine | TurnContextLine;
    } catch {
      continue;
    }

    if (isTurnContextLine(parsed)) {
      activeTurnId = parsed.payload?.turn_id || activeTurnId;
      continue;
    }

    if (isSessionEventLine(parsed) && parsed.payload?.type === 'task_started') {
      const eventPayload = parsed.payload as SessionEventLine['payload'];
      activeTurnId = eventPayload?.turn_id || activeTurnId;
    }

    const handled = pushCodexMirrorRecord(records, parsed, trimmed, activeTurnId, activeSpecialCallIds);
    if (!handled) {
      const unknownKind = describeUnhandledMirrorLineKind(parsed);
      if (unknownKind) unknownKinds.add(unknownKind);
    }

    if (
      isSessionEventLine(parsed)
      && (parsed.payload?.type === 'task_complete' || parsed.payload?.type === 'turn_aborted')
    ) {
      const eventPayload = parsed.payload as SessionEventLine['payload'];
      const completedTurnId = eventPayload?.turn_id || activeTurnId;
      if (!completedTurnId || completedTurnId === activeTurnId) {
        activeTurnId = null;
      }
      activeSpecialCallIds.clear();
    }
  }

  return {
    records,
    nextOffset: 0,
    trailingText,
    nextTurnId: activeTurnId,
    nextSpecialCallIds: Array.from(activeSpecialCallIds),
    unknownKinds: Array.from(unknownKinds),
  };
}
