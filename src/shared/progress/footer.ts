import { resolveSystemTimeZone } from '../time-zone.js';
import { formatLocalClockTime } from '../date-time.js';

export function formatFooterDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
  return parts.join('');
}

export function formatFooterClockTime(
  timestampMs: number,
  timeZone = resolveSystemTimeZone(),
): string {
  return formatLocalClockTime(timestampMs, timeZone) || '00:00:00';
}

export function joinFooterParts(parts: Array<string | null | undefined | false>): string {
  return parts.filter((part): part is string => typeof part === 'string' && part.trim().length > 0).join(' · ');
}
