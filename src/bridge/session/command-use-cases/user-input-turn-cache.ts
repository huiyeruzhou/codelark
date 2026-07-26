import fs from 'node:fs';
import path from 'node:path';

import { CODELARK_HOME } from '../../../configuration/paths.js';

export type LocalRuntimeName = 'codex' | 'claude' | 'kimi';
export type UserInputLineMatcher = (line: string) => boolean;

interface CachedTurnCount {
  runtime: LocalRuntimeName;
  filePath: string;
  size: number;
  mtimeMs: number;
  count: number;
  endsWithNewline: boolean;
  lastAccessedAt: number;
}

interface PersistedTurnCountCache {
  version: 1;
  entries: CachedTurnCount[];
}

interface CountTask {
  key: string;
  runtime: LocalRuntimeName;
  filePath: string;
  size: number;
  mtimeMs: number;
  matcher: UserInputLineMatcher;
  previous?: CachedTurnCount;
}

const CACHE_VERSION = 1;
const MAX_CACHE_ENTRIES = 1_000;
const PERSIST_DEBOUNCE_MS = 250;

function cacheKey(runtime: LocalRuntimeName, filePath: string): string {
  return `${runtime}\0${filePath}`;
}

function validEntry(value: unknown): value is CachedTurnCount {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<CachedTurnCount>;
  return (entry.runtime === 'codex' || entry.runtime === 'claude' || entry.runtime === 'kimi')
    && typeof entry.filePath === 'string'
    && Number.isFinite(entry.size)
    && Number.isFinite(entry.mtimeMs)
    && Number.isFinite(entry.count)
    && typeof entry.endsWithNewline === 'boolean'
    && Number.isFinite(entry.lastAccessedAt);
}

/**
 * Keeps expensive JSONL turn counting off the bridge event loop.
 *
 * The command hot path only stats each file and returns the last exact count.
 * Cache misses and appended ranges are scanned with an async stream, one file
 * at a time, then persisted so the first `/t` after a bridge restart stays fast.
 */
export class UserInputTurnCountCache {
  private readonly entries = new Map<string, CachedTurnCount>();
  private readonly queuedKeys = new Set<string>();
  private readonly queue: CountTask[] = [];
  private readonly idleWaiters = new Set<() => void>();
  private loaded = false;
  private running = false;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private persistChain: Promise<void> = Promise.resolve();

  constructor(private readonly cachePath: string) {}

  get(
    runtime: LocalRuntimeName,
    filePath: string,
    matcher: UserInputLineMatcher,
  ): number | undefined {
    this.load();

    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return undefined;
    }

    const key = cacheKey(runtime, filePath);
    const previous = this.entries.get(key);
    if (previous && previous.size === stat.size && previous.mtimeMs === stat.mtimeMs) {
      previous.lastAccessedAt = Date.now();
      return previous.count;
    }

    this.enqueue({
      key,
      runtime,
      filePath,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      matcher,
      previous,
    });

    // An append-only session can safely show its last exact count while the
    // new suffix is counted. Rewrites and truncations return unknown instead.
    if (previous && stat.size > previous.size && stat.mtimeMs >= previous.mtimeMs) {
      previous.lastAccessedAt = Date.now();
      return previous.count;
    }
    return undefined;
  }

  async waitForIdle(): Promise<void> {
    if (!this.running && this.queue.length === 0) {
      await this.flushPersistence();
      return;
    }
    await new Promise<void>((resolve) => this.idleWaiters.add(resolve));
    await this.flushPersistence();
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.cachePath, 'utf8')) as Partial<PersistedTurnCountCache>;
      if (parsed.version !== CACHE_VERSION || !Array.isArray(parsed.entries)) return;
      for (const entry of parsed.entries) {
        if (!validEntry(entry)) continue;
        this.entries.set(cacheKey(entry.runtime, entry.filePath), entry);
      }
    } catch {
      // A missing or stale cache is a normal cold-start condition.
    }
  }

  private enqueue(task: CountTask): void {
    if (this.queuedKeys.has(task.key)) return;
    this.queuedKeys.add(task.key);
    this.queue.push(task);
    this.runNext();
  }

  private runNext(): void {
    if (this.running) return;
    const task = this.queue.shift();
    if (!task) {
      for (const resolve of this.idleWaiters) resolve();
      this.idleWaiters.clear();
      return;
    }

    this.running = true;
    void this.countTask(task)
      .catch((error) => {
        console.warn('[command-session-source] Background user input turn count failed:', {
          runtime: task.runtime,
          filePath: task.filePath,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.queuedKeys.delete(task.key);
        this.running = false;
        this.runNext();
      });
  }

  private async countTask(task: CountTask): Promise<void> {
    const canAppend = Boolean(
      task.previous
      && task.previous.endsWithNewline
      && task.size > task.previous.size
      && task.mtimeMs >= task.previous.mtimeMs,
    );
    const start = canAppend ? task.previous!.size : 0;
    let count = canAppend ? task.previous!.count : 0;
    let pending = '';

    if (task.size > start) {
      await new Promise<void>((resolve, reject) => {
        const stream = fs.createReadStream(task.filePath, {
          encoding: 'utf8',
          start,
          end: task.size - 1,
        });
        stream.on('data', (chunk: string | Buffer) => {
          pending += chunk.toString();
          const lines = pending.split('\n');
          pending = lines.pop() || '';
          for (const rawLine of lines) {
            const line = rawLine.replace(/\r$/, '');
            if (line.trim() && task.matcher(line)) count += 1;
          }
        });
        stream.once('error', reject);
        stream.once('end', resolve);
      });
    }

    const endsWithNewline = pending.length === 0;
    if (pending.trim() && task.matcher(pending.replace(/\r$/, ''))) count += 1;

    this.entries.set(task.key, {
      runtime: task.runtime,
      filePath: task.filePath,
      size: task.size,
      mtimeMs: task.mtimeMs,
      count,
      endsWithNewline,
      lastAccessedAt: Date.now(),
    });
    this.schedulePersistence();
  }

  private schedulePersistence(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistChain = this.persistChain.then(() => this.persist());
    }, PERSIST_DEBOUNCE_MS);
    this.persistTimer.unref?.();
  }

  private async flushPersistence(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
      this.persistChain = this.persistChain.then(() => this.persist());
    }
    await this.persistChain;
  }

  private async persist(): Promise<void> {
    const entries = Array.from(this.entries.values())
      .sort((left, right) => right.lastAccessedAt - left.lastAccessedAt)
      .slice(0, MAX_CACHE_ENTRIES);
    const payload: PersistedTurnCountCache = { version: CACHE_VERSION, entries };
    const dir = path.dirname(this.cachePath);
    const tempPath = `${this.cachePath}.${process.pid}.tmp`;
    try {
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(tempPath, `${JSON.stringify(payload)}\n`, 'utf8');
      await fs.promises.rename(tempPath, this.cachePath);
    } catch (error) {
      await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
      console.warn('[command-session-source] Failed to persist user input turn cache:', {
        cachePath: this.cachePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export const userInputTurnCountCache = new UserInputTurnCountCache(
  path.join(CODELARK_HOME, 'runtime', 'session-user-input-turns.json'),
);
