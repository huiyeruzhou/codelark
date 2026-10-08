import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOOK_LOG_TAIL_BYTES = 1024 * 1024;
const MAX_LOG_SESSIONS = 4;

export interface CursorDesktopHookActivity {
  logPath: string;
  updatedAt: string;
  step?: string;
  generationId?: string;
  model?: string;
  modelId?: string;
  toolName?: string;
  command?: string;
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
