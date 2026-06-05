import crypto from 'node:crypto';

import type { TaskProgressInfo } from '../../../domain/progress.js';
export type { BridgeMirrorRecord, BridgeMirrorRecordDelta } from '../../contracts.js';

export interface CodexSessionEvent {
  signature: string;
  role: 'user' | 'assistant' | 'commentary' | 'system';
  content: string;
  timestamp: string;
}

export interface CodexSessionEventDelta {
  events: CodexSessionEvent[];
  nextOffset: number;
  trailingText: string;
}

export interface CodexSessionJsonlHistoryEntry {
  signature: string;
  role: 'user' | 'assistant' | 'commentary' | 'system' | 'tool' | 'other';
  kind: string;
  content: string;
  timestamp: string;
  rawJsonl: string;
}

export interface SessionMetaLine {
  timestamp?: string;
  type?: string;
  payload?: {
    id?: string;
    timestamp?: string;
    cwd?: string;
    originator?: unknown;
    cli_version?: unknown;
    source?: unknown;
  };
}

export interface SessionMessageLine {
  timestamp?: string;
  type?: string;
  payload?: {
    type?: string;
    role?: string;
    phase?: string;
    user_prompt?: unknown;
    userPrompt?: unknown;
    name?: unknown;
    namespace?: unknown;
    arguments?: string;
    execution?: unknown;
    call_id?: unknown;
    output?: unknown;
    is_error?: boolean;
    status?: unknown;
    input?: unknown;
    query?: unknown;
    server?: unknown;
    tool?: unknown;
    summary?: unknown;
    aggregated_output?: unknown;
    formatted_output?: unknown;
    stdout?: unknown;
    stderr?: unknown;
    exit_code?: unknown;
    success?: unknown;
    changes?: unknown;
    tools?: unknown;
    content?: Array<{
      type?: string;
      text?: unknown;
    }>;
  };
}

export interface SessionEventLine {
  timestamp?: string;
  type?: string;
  payload?: {
    type?: string;
    message?: unknown;
    user_prompt?: unknown;
    userPrompt?: unknown;
    text?: unknown;
    phase?: unknown;
    last_agent_message?: unknown;
    turn_id?: string;
    turnId?: string;
    reason?: unknown;
    call_id?: unknown;
    callId?: unknown;
    query?: unknown;
    command?: unknown;
    aggregated_output?: unknown;
    formatted_output?: unknown;
    stdout?: unknown;
    stderr?: unknown;
    exit_code?: unknown;
    status?: unknown;
    success?: unknown;
    changes?: unknown;
    tool?: unknown;
    arguments?: unknown;
    content_items?: unknown;
    error?: unknown;
    goal?: unknown;
    invocation?: {
      server?: unknown;
      tool?: unknown;
      arguments?: unknown;
    };
  };
}

export interface TurnContextLine {
  timestamp?: string;
  type?: string;
  payload?: {
    turn_id?: string;
  };
}

export function trimTitle(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 3).trimEnd()}...`;
}

export function normalizeFreeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function normalizeStructuredText(text: string): string {
  return text.replace(/\r\n/g, '\n').trim();
}

export function collectStructuredTextParts(value: unknown, parts: string[], depth = 0): void {
  if (value == null || depth > 6) return;
  if (typeof value === 'string') {
    parts.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectStructuredTextParts(item, parts, depth + 1);
    }
    return;
  }
  if (typeof value !== 'object') return;

  const record = value as Record<string, unknown>;
  if (typeof record.text === 'string') {
    parts.push(record.text);
  }
  if (typeof record.message === 'string') {
    parts.push(record.message);
  }
  if (typeof record.summary === 'string') {
    parts.push(record.summary);
  }
  if ('content' in record) {
    collectStructuredTextParts(record.content, parts, depth + 1);
  }
  if ('items' in record) {
    collectStructuredTextParts(record.items, parts, depth + 1);
  }
}

export function extractNormalizedFreeText(value: unknown): string {
  if (typeof value === 'string') return normalizeFreeText(value);
  const parts: string[] = [];
  collectStructuredTextParts(value, parts);
  return parts.length > 0 ? normalizeFreeText(parts.join('\n')) : '';
}

export function extractNormalizedStructuredText(value: unknown): string {
  if (typeof value === 'string') return normalizeStructuredText(value);
  const parts: string[] = [];
  collectStructuredTextParts(value, parts);
  return parts.length > 0 ? normalizeStructuredText(parts.join('\n\n')) : '';
}

export function renderCodexCliUpdateEvent(payload: SessionEventLine['payload']): string {
  const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const status = extractNormalizedFreeText(
    record.status
      ?? record.state
      ?? record.phase,
  );
  const fromVersion = extractNormalizedFreeText(
    record.from_version
      ?? record.fromVersion
      ?? record.current_version
      ?? record.currentVersion
      ?? record.old_version
      ?? record.oldVersion
      ?? record.from,
  );
  const toVersion = extractNormalizedFreeText(
    record.to_version
      ?? record.toVersion
      ?? record.target_version
      ?? record.targetVersion
      ?? record.latest_version
      ?? record.latestVersion
      ?? record.new_version
      ?? record.newVersion
      ?? record.to,
  );
  const message = extractNormalizedStructuredText(
    record.message
      ?? record.summary
      ?? record.text,
  );
  const error = extractNormalizedStructuredText(record.error);

  return [
    'Codex CLI update',
    fromVersion || toVersion ? `Version: ${fromVersion || '?'} -> ${toVersion || '?'}` : '',
    status ? `Status: ${status}` : '',
    message,
    error ? `Error: ${error}` : '',
  ].filter(Boolean).join('\n');
}

export function parseJsonSafely(value: string | undefined): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function normalizeTaskStatus(value: unknown): TaskProgressInfo['status'] {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized === 'in_progress' || normalized === 'running' || normalized === 'active') {
    return 'in_progress';
  }
  if (normalized === 'completed' || normalized === 'complete' || normalized === 'done') {
    return 'completed';
  }
  return 'pending';
}

export function parseTaskProgressItems(value: unknown): TaskProgressInfo[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = item as { step?: unknown; text?: unknown; status?: unknown };
      const text = extractNormalizedStructuredText(record.text ?? record.step);
      if (!text) return null;
      return {
        text,
        status: normalizeTaskStatus(record.status),
      } satisfies TaskProgressInfo;
    })
    .filter((item): item is TaskProgressInfo => Boolean(item));
}

export function parseUpdatePlanTasks(argumentsJson: string | undefined): TaskProgressInfo[] {
  const parsed = parseJsonSafely(argumentsJson) as { plan?: unknown; tasks?: unknown } | null;
  if (!parsed || typeof parsed !== 'object') return [];
  return parseTaskProgressItems(parsed.plan ?? parsed.tasks);
}

export function extractReasoningSummary(payload: { summary?: unknown; content?: unknown; text?: unknown; message?: unknown }): string {
  for (const value of [payload.summary, payload.content, payload.text, payload.message]) {
    const text = extractNormalizedStructuredText(value);
    if (text) return text;
  }
  return '';
}

export function extractToolOutputText(value: unknown): string {
  if (typeof value !== 'string') return extractNormalizedFreeText(value);
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const parsed = parseJsonSafely(trimmed) as { output?: unknown } | null;
    if (parsed && typeof parsed === 'object') {
      const extracted = extractNormalizedFreeText(parsed.output ?? parsed);
      if (extracted) return extracted;
    }
  }
  return extractNormalizedFreeText(value);
}

export function extractCodexMessageText(line: SessionMessageLine): string {
  const parts = line.payload?.content
    ?.map((item) => (item && typeof item.text === 'string' ? item.text : ''))
    .filter(Boolean) || [];
  const text = parts.join('\n').trim();
  if (!text) return '';
  if (line.payload?.phase === 'commentary') {
    return `[commentary]\n${text}`;
  }
  return text;
}

export function summarizePatchChanges(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  return Object.entries(value as Record<string, unknown>)
    .map(([filePath, detail]) => {
      const kind = detail && typeof detail === 'object'
        ? extractNormalizedFreeText((detail as { type?: unknown; kind?: unknown }).type ?? (detail as { kind?: unknown }).kind)
        : '';
      return kind ? `${kind}: ${filePath}` : filePath;
    })
    .filter(Boolean)
    .join('\n');
}

export function summarizeToolSearchOutput(value: unknown): string {
  if (!Array.isArray(value)) return '';
  let count = 0;
  const names: string[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const namespaceName = extractNormalizedFreeText((entry as { name?: unknown }).name);
    if (namespaceName) names.push(namespaceName);
    const tools = (entry as { tools?: unknown }).tools;
    if (Array.isArray(tools)) count += tools.length;
  }
  const prefix = count > 0 ? `Found ${count} tools` : '';
  const suffix = names.length > 0 ? names.slice(0, 5).join(', ') : '';
  return [prefix, suffix].filter(Boolean).join(': ');
}

export function getDynamicToolCallId(payload: { call_id?: unknown; callId?: unknown }): string {
  return extractNormalizedFreeText(payload.call_id ?? payload.callId);
}

export function formatCodexToolName(namespaceValue: unknown, nameValue: unknown): string {
  const name = extractNormalizedFreeText(nameValue);
  if (!name) return '';
  const namespace = extractNormalizedFreeText(namespaceValue);
  if (!namespace) return name;
  if (name.startsWith(namespace)) return name;
  return namespace.endsWith('__') || namespace.endsWith('/') || namespace.endsWith('.')
    ? `${namespace}${name}`
    : `${namespace}__${name}`;
}

export function createCodexEventSignature(rawLine: string): string {
  return crypto.createHash('sha1').update(rawLine).digest('hex');
}

export function isSessionEventLine(line: SessionMessageLine | SessionEventLine | TurnContextLine): line is SessionEventLine {
  return line.type === 'event_msg';
}

export function isSessionMessageLine(line: SessionMessageLine | SessionEventLine | TurnContextLine): line is SessionMessageLine {
  return line.type === 'response_item';
}

export function isTurnContextLine(line: SessionMessageLine | SessionEventLine | TurnContextLine): line is TurnContextLine {
  return line.type === 'turn_context';
}
