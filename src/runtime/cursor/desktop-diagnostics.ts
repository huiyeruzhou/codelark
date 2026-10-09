import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOOK_LOG_TAIL_BYTES = 1024 * 1024;
const MAX_LOG_SESSIONS = 4;

interface CursorDesktopHookFileCursor {
  identity: string;
  offset: number;
  trailing: string;
}

export interface CursorDesktopHookCursor {
  files: Record<string, CursorDesktopHookFileCursor>;
}

export interface CursorDesktopHookActivity {
  logPath: string;
  updatedAt: string;
  conversationId?: string;
  step?: string;
  generationId?: string;
  model?: string;
  modelId?: string;
  toolName?: string;
  command?: string;
  toolUseId?: string;
  toolInput?: unknown;
  toolOutput?: string;
  text?: string;
  status?: string;
}

function cursorLogsRoot(): string {
  const configured = process.env.CURSOR_LOGS_DIR?.trim();
  return configured
    ? path.resolve(configured)
    : path.join(os.homedir(), 'Library', 'Application Support', 'Cursor', 'logs');
}

function collectHookLogs(directory: string, result: string[], depth = 0): void {
  if (depth > 6) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collectHookLogs(target, result, depth + 1);
      continue;
    }
    if (entry.isFile() && /^cursor\.hooks.*\.log$/iu.test(entry.name)) result.push(target);
  }
}

function recentHookLogs(): string[] {
  const root = cursorLogsRoot();
  let sessions: string[] = [];
  try {
    sessions = fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse()
      .slice(0, MAX_LOG_SESSIONS);
  } catch {
    return [];
  }
  const logs: string[] = [];
  for (const session of sessions) collectHookLogs(path.join(root, session), logs);
  return logs.sort((left, right) => {
    try {
      return fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs;
    } catch {
      return 0;
    }
  });
}

function readTail(filePath: string, maxBytes: number): string {
  const stat = fs.statSync(filePath);
  const start = Math.max(0, stat.size - maxBytes);
  const length = stat.size - start;
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(filePath, 'r');
  try {
    const bytesRead = fs.readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function fileIdentity(stat: fs.Stats): string {
  return `${stat.dev}:${stat.ino}`;
}

function readRange(filePath: string, start: number, end: number): string {
  const length = Math.max(0, end - start);
  if (length === 0) return '';
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(filePath, 'r');
  try {
    const bytesRead = fs.readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function jsonObjectEnd(text: string, start: number): number | null {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') {
      quoted = true;
      continue;
    }
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function parseHookActivity(
  logPath: string,
  timestamp: string,
  step: string,
  input: Record<string, unknown>,
): CursorDesktopHookActivity {
  return {
    logPath,
    updatedAt: timestamp,
    step,
    conversationId: optionalString(input.conversation_id),
    generationId: optionalString(input.generation_id),
    model: optionalString(input.model),
    modelId: optionalString(input.model_id),
    toolName: optionalString(input.tool_name),
    command: optionalString(input.command),
    toolUseId: optionalString(input.tool_use_id),
    ...(input.tool_input !== undefined ? { toolInput: input.tool_input } : {}),
    toolOutput: optionalString(input.tool_output) || optionalString(input.output),
    text: optionalString(input.text),
    status: optionalString(input.status),
  };
}

function parseHookActivityChunk(
  logPath: string,
  text: string,
): { activities: CursorDesktopHookActivity[]; trailing: string } {
  const marker = /^\[([^\]]+)\]\s+Hook step requested:\s*([^\r\n]+)/gmu;
  const matches = [...text.matchAll(marker)];
  const activities: CursorDesktopHookActivity[] = [];
  let trailing = '';
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]!;
    const start = match.index ?? 0;
    const end = matches[index + 1]?.index ?? text.length;
    const window = text.slice(start, end);
    const inputMarker = /(?:^|\r?\n)INPUT:\s*\r?\n/gu.exec(window);
    if (!inputMarker) {
      if (index === matches.length - 1) trailing = text.slice(start);
      continue;
    }
    const jsonStart = window.indexOf('{', inputMarker.index + inputMarker[0].length);
    const jsonEnd = jsonStart >= 0 ? jsonObjectEnd(window, jsonStart) : null;
    if (jsonStart < 0 || jsonEnd === null) {
      if (index === matches.length - 1) trailing = text.slice(start);
      continue;
    }
    try {
      const input = JSON.parse(window.slice(jsonStart, jsonEnd)) as unknown;
      if (typeof input !== 'object' || input === null || Array.isArray(input)) continue;
      activities.push(parseHookActivity(
        logPath,
        match[1]?.trim() || new Date().toISOString(),
        match[2]?.trim() || 'unknown',
        input as Record<string, unknown>,
      ));
    } catch {
      // A malformed/incomplete hook entry is retained only while it is the tail.
      if (index === matches.length - 1) trailing = text.slice(start);
    }
  }
  return { activities, trailing };
}

export function captureCursorDesktopHookCursor(): CursorDesktopHookCursor {
  const files: Record<string, CursorDesktopHookFileCursor> = {};
  for (const logPath of recentHookLogs()) {
    try {
      const stat = fs.statSync(logPath);
      files[logPath] = { identity: fileIdentity(stat), offset: stat.size, trailing: '' };
    } catch {
      // A log may rotate while the baseline is captured.
    }
  }
  return { files };
}

export function readCursorDesktopHookActivityDelta(
  conversationId: string,
  cursor: CursorDesktopHookCursor,
): { cursor: CursorDesktopHookCursor; activities: CursorDesktopHookActivity[] } {
  const files: Record<string, CursorDesktopHookFileCursor> = { ...cursor.files };
  const activities: CursorDesktopHookActivity[] = [];
  for (const logPath of recentHookLogs().reverse()) {
    try {
      const stat = fs.statSync(logPath);
      const identity = fileIdentity(stat);
      const previous = files[logPath];
      const reset = !previous || previous.identity !== identity || stat.size < previous.offset;
      const offset = reset ? 0 : previous.offset;
      const prefix = reset ? '' : previous.trailing;
      const parsed = parseHookActivityChunk(logPath, prefix + readRange(logPath, offset, stat.size));
      files[logPath] = { identity, offset: stat.size, trailing: parsed.trailing };
      activities.push(...parsed.activities.filter((activity) => activity.conversationId === conversationId));
    } catch {
      // Try other active Cursor window logs.
    }
  }
  return {
    cursor: { files },
    activities: activities.sort((left, right) => left.updatedAt.localeCompare(right.updatedAt)),
  };
}

function lastCaptured(window: string, pattern: RegExp): string | undefined {
  const matches = [...window.matchAll(pattern)];
  const value = matches.at(-1)?.[1]?.trim();
  return value || undefined;
}

export function inspectCursorDesktopHookActivity(
  conversationId: string,
): CursorDesktopHookActivity | null {
  const needle = `"conversation_id": "${conversationId}"`;
  for (const logPath of recentHookLogs()) {
    try {
      const text = readTail(logPath, HOOK_LOG_TAIL_BYTES);
      const occurrence = text.lastIndexOf(needle);
      if (occurrence < 0) continue;
      const hookMarker = 'Hook step requested:';
      const markerStart = text.lastIndexOf(hookMarker, occurrence);
      const windowStart = markerStart >= 0 ? markerStart : Math.max(0, occurrence - 24_000);
      const nextMarker = text.indexOf(hookMarker, occurrence + needle.length);
      const windowEnd = nextMarker >= 0 ? nextMarker : Math.min(text.length, occurrence + 24_000);
      const window = text.slice(windowStart, windowEnd);
      const parsed = parseHookActivityChunk(logPath, window).activities
        .filter((activity) => activity.conversationId === conversationId);
      const activity = parsed.at(-1);
      if (activity) return activity;
      const stat = fs.statSync(logPath);
      return {
        logPath,
        updatedAt: stat.mtime.toISOString(),
        step: lastCaptured(window, /Hook step requested:\s*([^\r\n]+)/gu),
        generationId: lastCaptured(window, /"generation_id":\s*"([^"]+)"/gu),
        model: lastCaptured(window, /"model":\s*"([^"]+)"/gu),
        modelId: lastCaptured(window, /"model_id":\s*"([^"]+)"/gu),
        toolName: lastCaptured(window, /"tool_name":\s*"([^"]+)"/gu),
        command: lastCaptured(window, /"command":\s*"([^"\r\n]*(?:\\.[^"\r\n]*)*)"/gu),
      };
    } catch {
      // Try the next live Cursor window/log.
    }
  }
  return null;
}
