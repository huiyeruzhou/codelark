export const DEFAULT_PTY_SCREEN_LINES = 0;
export const MIN_PTY_SCREEN_LINES = 0;
export const MAX_PTY_SCREEN_LINES = 500;
export const MIN_PTY_SCREEN_INTERVAL_SECONDS = 3;

export interface PtyScreenArgs {
  action: 'show' | 'stop';
  lines?: number;
  intervalSeconds?: number;
}

export function normalizePtyScreenLines(value: unknown): number {
  const parsed = typeof value === 'number'
    ? value
    : Number(String(value || '').trim());
  if (!Number.isFinite(parsed)) return DEFAULT_PTY_SCREEN_LINES;
  return Math.min(MAX_PTY_SCREEN_LINES, Math.max(MIN_PTY_SCREEN_LINES, Math.floor(parsed)));
}

export function parsePtyScreenArgs(args: string): PtyScreenArgs | null {
  const trimmed = args.trim();
  if (!trimmed) return { action: 'show' };
  if (trimmed.toLowerCase() === 'stop') return { action: 'stop' };
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length > 2) return null;

  let lines: number | undefined;
  let intervalSeconds: number | undefined;
  for (const part of parts) {
    const intervalMatch = part.match(/^(\d+)s$/i);
    if (intervalMatch) {
      const parsed = Number(intervalMatch[1]);
      if (!Number.isFinite(parsed)) return null;
      intervalSeconds = Math.max(MIN_PTY_SCREEN_INTERVAL_SECONDS, Math.floor(parsed));
      continue;
    }
    if (/^\d+$/.test(part)) {
      lines = normalizePtyScreenLines(part);
      continue;
    }
    return null;
  }
  return {
    action: 'show',
    ...(lines === undefined ? {} : { lines }),
    ...(intervalSeconds === undefined ? {} : { intervalSeconds }),
  };
}
