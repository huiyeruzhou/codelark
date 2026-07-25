import { resolveSystemTimeZone } from '../time-zone.js';

const clockFormatters = new Map<string, Intl.DateTimeFormat>();

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
  let formatter = clockFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    clockFormatters.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(new Date(timestampMs));
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value || '00';
  return `${read('hour')}:${read('minute')}:${read('second')}`;
}

export function joinFooterParts(parts: Array<string | null | undefined | false>): string {
  return parts.filter((part): part is string => typeof part === 'string' && part.trim().length > 0).join(' · ');
}
