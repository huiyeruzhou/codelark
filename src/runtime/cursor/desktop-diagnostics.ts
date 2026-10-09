import fs, { promises as fsp, type FSWatcher, type Stats } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const HOOK_LOG_TAIL_BYTES = 1024 * 1024;
const MAX_LOG_SESSIONS = 4;
const DEFAULT_RECONCILE_INTERVAL_MS = 2_000;
const WATCH_DEBOUNCE_MS = 20;
const MAX_BUFFERED_ACTIVITIES = 4_096;
const MAX_READ_BYTES = 256 * 1024;

interface CursorDesktopHookFileState {
  identity: string;
  offset: number;
  trailing: string;
  decoder: StringDecoder;
}

interface SequencedHookActivity {
  sequence: number;
  activity: CursorDesktopHookActivity;
}

interface ActivityWaiter {
  afterSequence: number;
  resolve: () => void;
  timer: NodeJS.Timeout;
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

export interface CursorDesktopHookSubscription {
  drain(): CursorDesktopHookActivity[];
  waitForActivity(timeoutMs: number): Promise<void>;
  close(): void;
}

function positiveIntEnv(name: string, fallback: number, min: number): number {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

function cursorLogsRoot(): string {
  const configured = process.env.CURSOR_LOGS_DIR?.trim();
  return configured
    ? path.resolve(configured)
    : path.join(os.homedir(), 'Library', 'Application Support', 'Cursor', 'logs');
}

async function collectHookLogs(directory: string, result: string[], depth = 0): Promise<void> {
  if (depth > 6) return;
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectHookLogs(target, result, depth + 1);
    } else if (entry.isFile() && /^cursor\.hooks.*\.log$/iu.test(entry.name)) {
      result.push(target);
    }
  }));
}

async function recentHookLogs(root = cursorLogsRoot()): Promise<string[]> {
  let sessions: string[];
  try {
    sessions = (await fsp.readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse()
      .slice(0, MAX_LOG_SESSIONS);
  } catch {
    return [];
  }
  const logs: string[] = [];
  await Promise.all(sessions.map((session) => collectHookLogs(path.join(root, session), logs)));
  const dated = await Promise.all(logs.map(async (logPath) => {
    try {
      return { logPath, mtimeMs: (await fsp.stat(logPath)).mtimeMs };
    } catch {
      return null;
    }
  }));
  return dated
    .filter((item): item is { logPath: string; mtimeMs: number } => item !== null)
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .map((item) => item.logPath);
}

async function readRange(filePath: string, start: number, end: number): Promise<Buffer> {
  const length = Math.max(0, end - start);
  if (length === 0) return Buffer.alloc(0);
  const buffer = Buffer.allocUnsafe(length);
  const handle = await fsp.open(filePath, 'r');
  try {
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function readTail(filePath: string, maxBytes: number): Promise<string> {
  const stat = await fsp.stat(filePath);
  return (await readRange(filePath, Math.max(0, stat.size - maxBytes), stat.size)).toString('utf8');
}

function fileIdentity(stat: Stats): string {
  return `${stat.dev}:${stat.ino}`;
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
  let consumedThrough = 0;
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
      consumedThrough = start + jsonEnd;
    } catch {
      if (index === matches.length - 1) trailing = text.slice(start);
    }
  }
  if (!trailing) {
    // A watch notification can arrive midway through the next header, before
    // the complete marker regex matches. Keep that unfinished line, including
    // when it follows an otherwise complete INPUT block in the same read.
    const remainder = text.slice(consumedThrough);
    const finalLine = remainder.slice(remainder.lastIndexOf('\n') + 1);
    if (finalLine.startsWith('[')) trailing = finalLine;
  }
  return { activities, trailing };
}

class CursorDesktopHookTailer {
  private readonly files = new Map<string, CursorDesktopHookFileState>();
  private readonly activities: SequencedHookActivity[] = [];
  private readonly waiters = new Set<ActivityWaiter>();
  private watcher: FSWatcher | undefined;
  private reconcileTimer: NodeJS.Timeout | undefined;
  private debounceTimer: NodeJS.Timeout | undefined;
  private reconcileChain: Promise<void> = Promise.resolve();
  private startPromise: Promise<void> | undefined;
  private sequence = 0;
  private references = 0;
  private closed = false;

  constructor(readonly root: string) {}

  async acquire(): Promise<void> {
    this.references += 1;
    try {
      if (!this.startPromise) this.startPromise = this.start();
      await this.startPromise;
    } catch (error) {
      this.release();
      throw error;
    }
  }

  release(): void {
    this.references = Math.max(0, this.references - 1);
    if (this.references > 0) return;
    this.closed = true;
    this.watcher?.close();
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    for (const waiter of [...this.waiters]) waiter.resolve();
    hookTailers.delete(this.root);
  }

  currentSequence(): number {
    return this.sequence;
  }

  drain(afterSequence: number, conversationId: string): { sequence: number; activities: CursorDesktopHookActivity[] } {
    return {
      sequence: this.sequence,
      activities: this.activities
        .filter((item) => item.sequence > afterSequence && item.activity.conversationId === conversationId)
        .map((item) => item.activity),
    };
  }

  waitAfter(afterSequence: number, timeoutMs: number): Promise<void> {
    if (this.closed || this.sequence > afterSequence || timeoutMs <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const waiter = {} as ActivityWaiter;
      waiter.afterSequence = afterSequence;
      waiter.resolve = () => {
        clearTimeout(waiter.timer);
        this.waiters.delete(waiter);
        resolve();
      };
      waiter.timer = setTimeout(waiter.resolve, timeoutMs);
      waiter.timer.unref?.();
      this.waiters.add(waiter);
      if (this.sequence > afterSequence) waiter.resolve();
    });
  }

  private async start(): Promise<void> {
    this.installWatcher();
    await this.enqueueReconcile(true);
    const intervalMs = positiveIntEnv(
      'CODELARK_CURSOR_DESKTOP_HOOK_RECONCILE_INTERVAL_MS',
      DEFAULT_RECONCILE_INTERVAL_MS,
      50,
    );
    this.reconcileTimer = setInterval(() => {
      void this.enqueueReconcile(false);
      if (!this.watcher) this.installWatcher();
    }, intervalMs);
    this.reconcileTimer.unref?.();
  }

  private installWatcher(): void {
    if (this.closed || this.watcher || process.env.CODELARK_CURSOR_DESKTOP_HOOK_DISABLE_WATCH === '1') return;
    try {
      this.watcher = fs.watch(this.root, { recursive: true }, () => this.scheduleReconcile());
      this.watcher.on('error', () => {
        this.watcher?.close();
        this.watcher = undefined;
      });
    } catch {
      this.watcher = undefined;
    }
  }

  private scheduleReconcile(): void {
    if (this.closed || this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.enqueueReconcile(false);
    }, WATCH_DEBOUNCE_MS);
    this.debounceTimer.unref?.();
  }

  private enqueueReconcile(baseline: boolean): Promise<void> {
    this.reconcileChain = this.reconcileChain
      .then(() => this.reconcile(baseline))
      .catch((error) => {
        console.warn('[cursor-desktop] Hook tailer reconcile failed:', error instanceof Error ? error.message : error);
      });
    return this.reconcileChain;
  }

  private async reconcile(baseline: boolean): Promise<void> {
    if (this.closed) return;
    const logPaths = await recentHookLogs(this.root);
    for (const logPath of logPaths.reverse()) {
      try {
        const stat = await fsp.stat(logPath);
        const identity = fileIdentity(stat);
        const previous = this.files.get(logPath);
        if (baseline && !previous) {
          this.files.set(logPath, { identity, offset: stat.size, trailing: '', decoder: new StringDecoder('utf8') });
          continue;
        }
        const reset = !previous || previous.identity !== identity || stat.size < previous.offset;
        const offset = reset ? 0 : previous.offset;
        const prefix = reset ? '' : previous.trailing;
        const decoder = reset ? new StringDecoder('utf8') : previous.decoder;
        if (stat.size === offset) continue;
        const bytes = await readRange(logPath, offset, Math.min(stat.size, offset + MAX_READ_BYTES));
        const parsed = parseHookActivityChunk(logPath, prefix + decoder.write(bytes));
        const nextOffset = offset + bytes.length;
        this.files.set(logPath, { identity, offset: nextOffset, trailing: parsed.trailing, decoder });
        for (const activity of parsed.activities) this.publish(activity);
        if (nextOffset < stat.size) this.scheduleReconcile();
      } catch {
        // A log may rotate while the shared tailer is reconciling it.
      }
    }
  }

  private publish(activity: CursorDesktopHookActivity): void {
    this.sequence += 1;
    this.activities.push({ sequence: this.sequence, activity });
    if (this.activities.length > MAX_BUFFERED_ACTIVITIES) {
      this.activities.splice(0, this.activities.length - MAX_BUFFERED_ACTIVITIES);
    }
    for (const waiter of [...this.waiters]) {
      if (this.sequence > waiter.afterSequence) waiter.resolve();
    }
  }
}

const hookTailers = new Map<string, CursorDesktopHookTailer>();

export async function subscribeCursorDesktopHookActivities(
  conversationId: string,
): Promise<CursorDesktopHookSubscription> {
  const root = cursorLogsRoot();
  let tailer = hookTailers.get(root);
  if (!tailer) {
    tailer = new CursorDesktopHookTailer(root);
    hookTailers.set(root, tailer);
  }
  await tailer.acquire();
  let sequence = tailer.currentSequence();
  let closed = false;
  return {
    drain() {
      if (closed) return [];
      const delta = tailer!.drain(sequence, conversationId);
      sequence = delta.sequence;
      return delta.activities;
    },
    waitForActivity(timeoutMs) {
      return closed ? Promise.resolve() : tailer!.waitAfter(sequence, timeoutMs);
    },
    close() {
      if (closed) return;
      closed = true;
      tailer!.release();
    },
  };
}

function lastCaptured(window: string, pattern: RegExp): string | undefined {
  const matches = [...window.matchAll(pattern)];
  const value = matches.at(-1)?.[1]?.trim();
  return value || undefined;
}

export async function inspectCursorDesktopHookActivity(
  conversationId: string,
): Promise<CursorDesktopHookActivity | null> {
  const needle = `"conversation_id": "${conversationId}"`;
  for (const logPath of await recentHookLogs()) {
    try {
      const text = await readTail(logPath, HOOK_LOG_TAIL_BYTES);
      const occurrence = text.lastIndexOf(needle);
      if (occurrence < 0) continue;
      const hookMarker = 'Hook step requested:';
      const markerStart = text.lastIndexOf(hookMarker, occurrence);
      const windowStart = markerStart >= 0 ? markerStart : Math.max(0, occurrence - 24_000);
      const nextMarker = text.indexOf(hookMarker, occurrence + needle.length);
      const windowEnd = nextMarker >= 0 ? nextMarker : Math.min(text.length, occurrence + 24_000);
      const window = text.slice(windowStart, windowEnd);
      const activity = parseHookActivityChunk(logPath, window).activities
        .filter((item) => item.conversationId === conversationId)
        .at(-1);
      if (activity) return activity;
      const stat = await fsp.stat(logPath);
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
